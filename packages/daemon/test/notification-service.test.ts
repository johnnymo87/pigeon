import { describe, expect, it, vi } from "vitest";
import {
  formatTelegramNotification,
  formatQuestionNotification,
  formatQuestionWizardStep,
  TelegramNotificationService,
  FallbackNotifier,
  RateLimitError,
  relativeTime,
  formatStateCard,
  formatCurrentStateIndex,
  displayName,
} from "../src/notification-service";
import type { QuestionInfoData } from "../src/storage/types";

describe("displayName", () => {
  it("prefers title", () => {
    expect(displayName({ title: "Fix auth", label: "pigeon", sessionId: "ses_abcdef123" }))
      .toBe("Fix auth");
  });
  it("handles title present with label null", () => {
    expect(displayName({ title: "Fix auth", label: null, sessionId: "ses_abcdef123" })).toBe("Fix auth");
  });
  it("falls back to label when title is absent or blank", () => {
    expect(displayName({ title: null, label: "pigeon", sessionId: "ses_abcdef123" })).toBe("pigeon");
    expect(displayName({ title: "  ", label: "pigeon", sessionId: "ses_abcdef123" })).toBe("pigeon");
  });
  it("falls back to a session-id prefix when both are absent", () => {
    expect(displayName({ title: null, label: null, sessionId: "ses_abcdef123" })).toBe("ses_abcd");
  });
  it("falls back to a session-id prefix when title and label are both blank", () => {
    expect(displayName({ title: "  ", label: "   ", sessionId: "ses_abcdef123" })).toBe("ses_abcd");
  });
  it("handles session ids shorter than 8 characters", () => {
    expect(displayName({ title: null, label: null, sessionId: "ses_123" })).toBe("ses_123");
  });
});

describe("formatTelegramNotification", () => {
  it("formats body as TgMessage with no inline buttons", () => {
    const result = formatTelegramNotification({
      event: "Stop",
      label: "my_[label]*",
      summary: "Done",
      cwd: "/home/dev/projects/pigeon",
      token: "tok123",
      sessionId: "sess-abc123",
    });

    // Returns header, body, footer as TgMessage objects
    expect(result.header).toBeDefined();
    expect(result.body).toBeDefined();
    expect(result.footer).toBeDefined();

    // Header contains emoji and label (no event word or bold entity)
    expect(result.header.text).toBe("✅ my_[label]*");
    expect(result.header.text).not.toContain("Stop");
    // Entities should be valid utf-16 offsets
    for (const entity of result.header.entities) {
      expect(entity.offset).toBeGreaterThanOrEqual(0);
      expect(entity.offset + entity.length).toBeLessThanOrEqual(result.header.text.length);
    }

    // Body is the summary
    expect(result.body.text).toBe("Done");

    // Footer contains cwd, sessionId
    expect(result.footer.text).toContain("projects/pigeon");
    expect(result.footer.text).toContain("sess-abc123");
    // Footer should have code entities for cwd and sessionId
    const codeEntities = result.footer.entities.filter(e => e.type === "code");
    expect(codeEntities.length).toBeGreaterThanOrEqual(2);

    expect(result.replyMarkup.inline_keyboard).toHaveLength(0);
  });

  it("maps each event to its distinct emoji and omits event word from header", () => {
    const cases = [
      { event: "Stop", expectedEmoji: "✅" },
      { event: "Error", expectedEmoji: "❌" },
      { event: "Retry", expectedEmoji: "🔁" },
      { event: "SubagentStop", expectedEmoji: "🔧" },
      { event: "Question", expectedEmoji: "❓" },
      { event: "Notification", expectedEmoji: "🔔" },
      { event: "UnknownEvent", expectedEmoji: "🤖" },
    ];

    for (const { event, expectedEmoji } of cases) {
      const result = formatTelegramNotification({
        event,
        label: "test-label",
        summary: "Done",
        cwd: "/home/dev/projects/pigeon",
        token: "tok123",
        sessionId: "sess-123",
      });

      expect(result.header.text).toBe(`${expectedEmoji} test-label`);
      expect(result.header.text).not.toContain(event);

      // Verify entity integrity
      for (const entity of result.header.entities) {
        expect(entity.offset).toBeGreaterThanOrEqual(0);
        expect(entity.offset + entity.length).toBeLessThanOrEqual(result.header.text.length);
      }
    }
  });

  it("produces visibly different headers for Stop and Error events", () => {
    const stopResult = formatTelegramNotification({
      event: "Stop",
      label: "my-label",
      summary: "Done",
      cwd: "/home/dev/projects/pigeon",
      token: "tok123",
      sessionId: "sess-123",
    });

    const errorResult = formatTelegramNotification({
      event: "Error",
      label: "my-label",
      summary: "Failed",
      cwd: "/home/dev/projects/pigeon",
      token: "tok123",
      sessionId: "sess-123",
    });

    expect(stopResult.header.text).not.toEqual(errorResult.header.text);
    expect(stopResult.header.text).toContain("✅");
    expect(errorResult.header.text).toContain("❌");
  });

  it("includes machine ID in footer when provided", () => {
    const result = formatTelegramNotification({
      event: "Stop",
      label: "test",
      summary: "Done",
      cwd: "/home/dev/projects/pigeon",
      token: "tok123",
      machineId: "devbox",
      sessionId: "sess-xyz",
    });

    expect(result.footer.text).toContain("projects/pigeon");
    expect(result.footer.text).toContain("devbox");
    expect(result.footer.text).toContain("sess-xyz");
  });

  it("omits machine ID from footer when not provided", () => {
    const result = formatTelegramNotification({
      event: "Stop",
      label: "test",
      summary: "Done",
      cwd: "/home/dev/projects/pigeon",
      token: "tok123",
      sessionId: "sess-nomachine",
    });

    expect(result.footer.text).toContain("projects/pigeon");
    expect(result.footer.text).toContain("sess-nomachine");
    expect(result.footer.text).not.toContain("🖥");
  });

  it("returns separate header, body, footer for callers to split themselves", () => {
    const longSummary = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} content here.`).join("\n\n");
    const result = formatTelegramNotification({
      event: "Stop",
      label: "test",
      summary: longSummary,
      cwd: "/tmp",
      token: "tok-long",
      sessionId: "sess-long",
    });

    // Caller is responsible for splitting — formatter just returns parts
    expect(result.header).toBeDefined();
    expect(result.body.text).toBe(longSummary);
    expect(result.footer).toBeDefined();
    expect(result.replyMarkup.inline_keyboard).toHaveLength(0);
  });
});

describe("TelegramNotificationService", () => {
  it("sends plain alert with severity prefix", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const storage = {} as any;
    const service = new TelegramNotificationService(
      storage,
      "bot-token",
      "8248645256",
      () => 2_000,
      fetchMock,
    );

    await service.sendPlainAlert("Server error", "error");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(options.body)) as Record<string, unknown>;
    expect(payload.chat_id).toBe("8248645256");
    expect(payload.text).toBe("❌ Server error");
  });
});

describe("formatQuestionWizardStep", () => {
  const questions: QuestionInfoData[] = [
    { question: "Which DB?", header: "Database", options: [
      { label: "PostgreSQL", description: "Relational" },
      { label: "SQLite", description: "File-based" },
    ]},
    { question: "Which ORM?", header: "ORM", options: [
      { label: "Prisma", description: "" },
      { label: "Drizzle", description: "" },
      { label: "None", description: "" },
    ]},
  ];

  it("renders step 1 of 2 with progress header", () => {
    const result = formatQuestionWizardStep({
      label: "pigeon",
      questions,
      currentStep: 0,
      cwd: "/home/dev/projects/pigeon",
      token: "tok-wiz",
      version: 0,
      sessionId: "sess-wiz",
      machineId: "devbox",
    });

    expect(result.message.text).toContain("Question 1 of 2");
    expect(result.message.text).toContain("Database");
    expect(result.message.text).toContain("Which DB?");
    expect(result.message.text).toContain("PostgreSQL");
    expect(result.message.text).toContain("SQLite");
    expect(result.message.text).not.toContain("ORM"); // future question not shown

    // "Question 1 of 2" should be bold
    const boldEntity = result.message.entities.find(e => e.type === "bold");
    expect(boldEntity).toBeDefined();
  });

  it("includes versioned callback_data on buttons", () => {
    const result = formatQuestionWizardStep({
      label: "test", questions, currentStep: 0,
      cwd: "/tmp", token: "tok-wiz", version: 0, sessionId: "s1",
    });

    const buttons = result.replyMarkup.inline_keyboard.flat();
    expect(buttons[0]!.callback_data).toBe("cmd:tok-wiz:v0:q0");
    expect(buttons[1]!.callback_data).toBe("cmd:tok-wiz:v0:q1");
  });

  it("renders step 2 of 2", () => {
    const result = formatQuestionWizardStep({
      label: "test", questions, currentStep: 1,
      cwd: "/tmp", token: "tok-wiz", version: 1, sessionId: "s1",
    });

    expect(result.message.text).toContain("Question 2 of 2");
    expect(result.message.text).toContain("ORM");
    expect(result.message.text).toContain("Which ORM?");
    expect(result.message.text).not.toContain("Database");
  });

  it("does NOT include a Cancel button (no opencode API to reject questions)", () => {
    const result = formatQuestionWizardStep({
      label: "test", questions, currentStep: 0,
      cwd: "/tmp", token: "tok-wiz", version: 0, sessionId: "s1",
    });

    const allButtons = result.replyMarkup.inline_keyboard.flat();
    expect(allButtons.every((b: { callback_data: string }) => !b.callback_data.includes("cancel"))).toBe(true);
  });

  it("includes swipe-reply hint when custom is enabled", () => {
    const result = formatQuestionWizardStep({
      label: "test", questions, currentStep: 0,
      cwd: "/tmp", token: "tok-wiz", version: 0, sessionId: "s1",
    });
    expect(result.message.text).toContain("Swipe-reply for custom answer");
    // "Swipe-reply for custom answer" should be italic
    const italicEntity = result.message.entities.find(e => e.type === "italic");
    expect(italicEntity).toBeDefined();
  });

  it("hides swipe-reply hint when custom=false", () => {
    const qs = [{ ...questions[0]!, custom: false }, questions[1]!];
    const result = formatQuestionWizardStep({
      label: "test", questions: qs, currentStep: 0,
      cwd: "/tmp", token: "tok-wiz", version: 0, sessionId: "s1",
    });
    expect(result.message.text).not.toContain("Swipe-reply");
  });
});

describe("formatQuestionNotification", () => {
  it("formats single question with option buttons", () => {
    const result = formatQuestionNotification({
      label: "pigeon",
      questions: [{
        question: "Which database should I use?",
        header: "Database Choice",
        options: [
          { label: "PostgreSQL", description: "Battle-tested relational DB" },
          { label: "SQLite", description: "Simple file-based DB" },
        ],
      }],
      cwd: "/home/dev/projects/pigeon",
      token: "tok-q1",
      sessionId: "sess-q1",
      machineId: "devbox",
    });

    expect(result.message.text).toContain("Question");
    expect(result.message.text).toContain("pigeon");
    expect(result.message.text).toContain("Database Choice");
    expect(result.message.text).toContain("Which database should I use?");
    expect(result.message.text).toContain("PostgreSQL");
    expect(result.message.text).toContain("SQLite");
    expect(result.message.text).toContain("projects/pigeon");
    expect(result.message.text).toContain("devbox");
    expect(result.message.text).toContain("sess-q1");
    expect(result.message.text).toContain("Swipe-reply for custom answer");

    // "Question" should be bold
    const boldEntity = result.message.entities.find(e => e.type === "bold");
    expect(boldEntity).toBeDefined();

    // sessionId and cwd should be code entities
    const codeEntities = result.message.entities.filter(e => e.type === "code");
    expect(codeEntities.length).toBeGreaterThanOrEqual(2);

    // "Swipe-reply for custom answer" should be italic
    const italicEntity = result.message.entities.find(e => e.type === "italic");
    expect(italicEntity).toBeDefined();

    expect(result.replyMarkup.inline_keyboard).toHaveLength(1);
    expect(result.replyMarkup.inline_keyboard[0]).toHaveLength(2);
    expect(result.replyMarkup.inline_keyboard[0]![0]!.text).toBe("PostgreSQL");
    expect(result.replyMarkup.inline_keyboard[0]![0]!.callback_data).toBe("cmd:tok-q1:q0");
    expect(result.replyMarkup.inline_keyboard[0]![1]!.callback_data).toBe("cmd:tok-q1:q1");
  });

  it("wraps options into rows of 3", () => {
    const result = formatQuestionNotification({
      label: "test",
      questions: [{
        question: "Pick one",
        header: "Choice",
        options: [
          { label: "A", description: "" },
          { label: "B", description: "" },
          { label: "C", description: "" },
          { label: "D", description: "" },
        ],
      }],
      cwd: "/tmp",
      token: "tok-wrap",
      sessionId: "sess-wrap",
    });

    expect(result.replyMarkup.inline_keyboard).toHaveLength(2);
    expect(result.replyMarkup.inline_keyboard[0]).toHaveLength(3);
    expect(result.replyMarkup.inline_keyboard[1]).toHaveLength(1);
    expect(result.replyMarkup.inline_keyboard[1]![0]!.callback_data).toBe("cmd:tok-wrap:q3");
  });

  it("renders all questions for multi-question requests (no buttons)", () => {
    const result = formatQuestionNotification({
      label: "test",
      questions: [
        { question: "Q1 text", header: "H1", options: [{ label: "A", description: "desc A" }] },
        { question: "Q2 text", header: "H2", options: [{ label: "B", description: "desc B" }] },
      ],
      cwd: "/tmp",
      token: "tok-multi",
      sessionId: "sess-multi",
    });

    // Shows BOTH questions with (X/N) prefix
    expect(result.message.text).toContain("(1/2)");
    expect(result.message.text).toContain("H1");
    expect(result.message.text).toContain("Q1 text");
    expect(result.message.text).toContain("A");
    expect(result.message.text).toContain("(2/2)");
    expect(result.message.text).toContain("H2");
    expect(result.message.text).toContain("Q2 text");
    expect(result.message.text).toContain("B");
    // Fallback hint
    expect(result.message.text).toContain("answer in app");
    // No inline buttons for multi-question (wizard will change this later)
    expect(result.replyMarkup.inline_keyboard).toHaveLength(0);
  });

  it("emits (X/N) ordinal prefix even when multi-question has no header", () => {
    const result = formatQuestionNotification({
      label: "test",
      questions: [
        { question: "Q1 text", header: "", options: [] },
        { question: "Q2 text", header: "", options: [] },
      ],
      cwd: "/tmp",
      token: "tok-noheader",
      sessionId: "sess-noheader",
    });

    expect(result.message.text).toContain("(1/2)");
    expect(result.message.text).toContain("(2/2)");
    expect(result.message.text).toContain("Q1 text");
    expect(result.message.text).toContain("Q2 text");
  });

  it("shows swipe-reply hint when any question in multi-question allows custom", () => {
    const result = formatQuestionNotification({
      label: "test",
      questions: [
        { question: "Q1", header: "H1", options: [], custom: false },
        { question: "Q2", header: "H2", options: [] }, // custom defaults to true
      ],
      cwd: "/tmp",
      token: "tok-multicustom",
      sessionId: "sess-multicustom",
    });

    expect(result.message.text).toContain("Swipe-reply");
  });

  it("hides swipe-reply hint when custom=false", () => {
    const result = formatQuestionNotification({
      label: "test",
      questions: [{
        question: "Pick one",
        header: "Choice",
        options: [{ label: "Yes", description: "" }],
        custom: false,
      }],
      cwd: "/tmp",
      token: "tok-nocustom",
      sessionId: "sess-nocustom",
    });

    expect(result.message.text).not.toContain("Swipe-reply");
  });
});



describe("current-state formatting helpers", () => {
  describe("relativeTime", () => {
    it("handles boundary cases correctly", () => {
      const now = 10000000;
      // Future
      expect(relativeTime(now + 1, now)).toBe("just now");
      expect(relativeTime(now + 100000, now)).toBe("just now");
      // Just now (< 60_000)
      expect(relativeTime(now, now)).toBe("just now");
      expect(relativeTime(now - 1, now)).toBe("just now");
      expect(relativeTime(now - 59999, now)).toBe("just now");
      // Minutes (< 3_600_000)
      expect(relativeTime(now - 60000, now)).toBe("1m ago");
      expect(relativeTime(now - 119000, now)).toBe("1m ago");
      expect(relativeTime(now - 120000, now)).toBe("2m ago");
      expect(relativeTime(now - 3599000, now)).toBe("59m ago");
      // Hours (< 86_400_000)
      expect(relativeTime(now - 3600000, now)).toBe("1h ago");
      expect(relativeTime(now - 7199000, now)).toBe("1h ago");
      expect(relativeTime(now - 7200000, now)).toBe("2h ago");
      expect(relativeTime(now - 86399000, now)).toBe("23h ago");
      // Days (>= 86_400_000)
      expect(relativeTime(now - 86400000, now)).toBe("1d ago");
      expect(relativeTime(now - 172799000, now)).toBe("1d ago");
      expect(relativeTime(now - 172800000, now)).toBe("2d ago");
    });
  });

  describe("formatStateCard", () => {
    const now = 10000000;

    it("formats active status with snippet and lastActivity", () => {
      const card = formatStateCard({
        title: "Active Session",
        status: "active",
        dir: "/home/dev/projects/workstation",
        sid: "sess-active",
        snippet: "Working on some feature...",
        lastActivity: now - 120000, // 2m ago
        machineId: "devbox",
      }, now);

      expect(card.text).toContain("🟢 Active Session");
      expect(card.text).toContain("Working on some feature...");
      expect(card.text).toContain("📂 projects/workstation · 🖥 devbox");
      expect(card.text).toContain("🆔 sess-active");
      expect(card.text).toContain("Swipe-reply to respond · 2m ago");
      expect(card.text).toContain("🆔 sess-active\n↩️ Swipe-reply to respond · 2m ago");

      // Verify entities
      const bold = card.entities.find(e => e.type === "bold");
      expect(bold).toBeDefined();
      expect(card.text.slice(bold!.offset, bold!.offset + bold!.length)).toBe("Active Session");

      const codeEntities = card.entities.filter(e => e.type === "code");
      expect(codeEntities).toHaveLength(2);
      expect(card.text.slice(codeEntities[0]!.offset, codeEntities[0]!.offset + codeEntities[0]!.length)).toBe("projects/workstation");
      expect(card.text.slice(codeEntities[1]!.offset, codeEntities[1]!.offset + codeEntities[1]!.length)).toBe("sess-active");

      const italic = card.entities.find(e => e.type === "italic");
      expect(italic).toBeDefined();
      expect(card.text.slice(italic!.offset, italic!.offset + italic!.length)).toBe("Swipe-reply to respond");
    });

    it("formats idle status without snippet or lastActivity", () => {
      const card = formatStateCard({
        title: "Idle Session",
        status: "idle",
        dir: "/home/dev/projects/workstation",
        sid: "sess-idle",
        snippet: "",
        lastActivity: null,
        machineId: "cloudbox",
      }, now);

      expect(card.text).toContain("⚪ Idle Session");
      expect(card.text).not.toContain("Working on");
      expect(card.text).toContain("📂 projects/workstation · 🖥 cloudbox");
      expect(card.text).toContain("🆔 sess-idle");
      expect(card.text).toContain("Swipe-reply to respond");
      expect(card.text).toContain("🆔 sess-idle\n↩️ Swipe-reply to respond");
      expect(card.text).not.toContain("· just now");
      expect(card.text).not.toContain("· 2m ago");

      // Verify no stray blank lines in place of snippet
      // Expect exactly: ⚪ Idle Session\n\n📂 ...
      expect(card.text).toContain("⚪ Idle Session\n\n📂");

      const italic = card.entities.find(e => e.type === "italic");
      expect(italic).toBeDefined();
      expect(card.text.slice(italic!.offset, italic!.offset + italic!.length)).toBe("Swipe-reply to respond");
    });

    it("handles null dir gracefully by rendering 'unknown'", () => {
      const card = formatStateCard({
        title: "Null Dir Session",
        status: "idle",
        dir: null,
        sid: "sess-null-dir",
        snippet: "",
        lastActivity: null,
        machineId: "devbox",
      }, now);

      expect(card.text).toContain("📂 unknown · 🖥 devbox");
      const codeEntities = card.entities.filter(e => e.type === "code");
      expect(card.text.slice(codeEntities[0]!.offset, codeEntities[0]!.offset + codeEntities[0]!.length)).toBe("unknown");
    });
  });

  describe("formatCurrentStateIndex", () => {
    it("formats correct index details with mixed statuses and unreadable session count", () => {
      const index = formatCurrentStateIndex({
        machineId: "devbox",
        sessions: [
          { title: "Session A", status: "active" },
          { title: "Session B", status: "idle" },
          { title: "Session C", status: "active" },
        ],
        unreadable: 2,
      });

      expect(index.text).toContain("📋 Current state — devbox");
      expect(index.text).toContain("3 main session(s) · 2 🟢 active · 1 ⚪ idle · 2 unreadable");
      expect(index.text).toContain("1. Session A 🟢");
      expect(index.text).toContain("2. Session B ⚪");
      expect(index.text).toContain("3. Session C 🟢");

      // Verify bold 'Current state'
      const bold = index.entities.find(e => e.type === "bold");
      expect(bold).toBeDefined();
      expect(index.text.slice(bold!.offset, bold!.offset + bold!.length)).toBe("Current state");
    });

    it("formats state index when unreadable is 0 or undefined", () => {
      const index = formatCurrentStateIndex({
        machineId: "devbox",
        sessions: [
          { title: "Session A", status: "idle" },
        ],
      });

      expect(index.text).toContain("1 main session(s) · 0 🟢 active · 1 ⚪ idle");
      expect(index.text).not.toContain("unreadable");
    });

    it("formats empty sessions list gracefully", () => {
      const index = formatCurrentStateIndex({
        machineId: "devbox",
        sessions: [],
      });

      expect(index.text).toBe("📋 Current state — devbox\n0 main session(s) · 0 🟢 active · 0 ⚪ idle");
      expect(index.entities).toHaveLength(1);
    });

    it("formats state index with homeScreen count when homeScreen > 0", () => {
      const index = formatCurrentStateIndex({
        machineId: "devbox",
        sessions: [
          { title: "Session A", status: "active" },
        ],
        unreadable: 2,
        homeScreen: 3,
      });

      expect(index.text).toContain("1 main session(s) · 1 🟢 active · 0 ⚪ idle · 2 unreadable · 3 on home screen");
    });

    it("formats state index when homeScreen is 0 or undefined", () => {
      const index1 = formatCurrentStateIndex({
        machineId: "devbox",
        sessions: [
          { title: "Session A", status: "idle" },
        ],
        homeScreen: 0,
      });

      expect(index1.text).toContain("1 main session(s) · 0 🟢 active · 1 ⚪ idle");
      expect(index1.text).not.toContain("on home screen");

      const index2 = formatCurrentStateIndex({
        machineId: "devbox",
        sessions: [
          { title: "Session A", status: "idle" },
        ],
      });

      expect(index2.text).toContain("1 main session(s) · 0 🟢 active · 1 ⚪ idle");
      expect(index2.text).not.toContain("on home screen");
    });
  });

  describe("FallbackNotifier with RateLimitError", () => {
    it("does not fall back to direct Telegram on a rate limit", async () => {
      const primary = {
        sendPlainAlert: vi.fn().mockRejectedValue(new RateLimitError("rate limited", 30)),
      };
      const fallback = {
        sendPlainAlert: vi.fn().mockResolvedValue(undefined),
      };

      const notifier = new FallbackNotifier(primary, fallback);

      await expect(notifier.sendPlainAlert("test alert", "info")).rejects.toThrow(RateLimitError);

      expect(fallback.sendPlainAlert).not.toHaveBeenCalled();
    });

    it("falls back to secondary notifier on ordinary error", async () => {
      const primary = {
        sendPlainAlert: vi.fn().mockRejectedValue(new Error("network error")),
      };
      const fallback = {
        sendPlainAlert: vi.fn().mockResolvedValue(undefined),
      };

      const notifier = new FallbackNotifier(primary, fallback);

      await notifier.sendPlainAlert("test alert", "info");
      expect(fallback.sendPlainAlert).toHaveBeenCalledTimes(1);
    });
  });
});
