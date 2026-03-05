import { describe, expect, it, vi } from "vitest";
import {
  formatTelegramNotification,
  formatQuestionNotification,
  TelegramNotificationService,
} from "../src/notification-service";
import { openStorageDb } from "../src/storage/database";

describe("formatTelegramNotification", () => {
  it("formats markdown body and callback buttons", () => {
    const result = formatTelegramNotification({
      event: "Stop",
      label: "my_[label]*",
      summary: "Done",
      cwd: "/home/dev/projects/pigeon",
      token: "tok123",
      buttons: [
        { text: "A", action: "continue" },
        { text: "B", action: "y" },
        { text: "C", action: "n" },
        { text: "D", action: "exit" },
      ],
    });

    expect(result.text).toContain("*Stop*: my\\_\\[label\\]\\*");
    expect(result.text).toContain("📂 `projects/pigeon`");
    expect(result.replyMarkup.inline_keyboard[0]?.[0]?.callback_data).toBe("cmd:tok123:continue");
    expect(result.replyMarkup.inline_keyboard[1]?.[0]?.callback_data).toBe("cmd:tok123:exit");
  });

  it("includes machine ID in info line when provided", () => {
    const result = formatTelegramNotification({
      event: "Stop",
      label: "test",
      summary: "Done",
      cwd: "/home/dev/projects/pigeon",
      token: "tok123",
      buttons: [],
      machineId: "devbox",
    });

    expect(result.text).toContain("📂 `projects/pigeon` · 🖥 devbox");
  });

  it("omits machine ID from info line when not provided", () => {
    const result = formatTelegramNotification({
      event: "Stop",
      label: "test",
      summary: "Done",
      cwd: "/home/dev/projects/pigeon",
      token: "tok123",
      buttons: [],
    });

    expect(result.text).toContain("📂 `projects/pigeon`");
    expect(result.text).not.toContain("🖥");
  });
});

describe("TelegramNotificationService", () => {
  it("mints session token, sends telegram message, and stores reply mapping", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-1",
      notify: true,
      label: "Test Session",
      cwd: "/tmp/demo",
    }, 1_000);

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1234 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const service = new TelegramNotificationService(
      storage,
      "bot-token",
      "8248645256",
      () => 2_000,
      fetchMock,
    );

    const result = await service.sendStopNotification({
      session: {
        sessionId: "sess-1",
        label: "Test Session",
        cwd: "/tmp/demo",
      },
      event: "Stop",
      summary: "All done",
    });

    expect(result.token).toBeTruthy();

    const tokenRecord = storage.sessionTokens.validate(result.token, "8248645256", 2_001);
    expect(tokenRecord?.sessionId).toBe("sess-1");

    const replyMapped = storage.replyTokens.lookup("8248645256", "1234", 2_001);
    expect(replyMapped).toBe(result.token);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(options.body)) as Record<string, unknown>;
    expect(payload.parse_mode).toBe("Markdown");
    expect(payload.chat_id).toBe("8248645256");

    storage.db.close();
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
    });

    expect(result.text).toContain("❓ *Question*: pigeon");
    expect(result.text).toContain("*Database Choice*");
    expect(result.text).toContain("Which database should I use?");
    expect(result.text).toContain("PostgreSQL");
    expect(result.text).toContain("SQLite");
    expect(result.text).toContain("📂 `projects/pigeon`");
    expect(result.text).toContain("Swipe-reply for custom answer");

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
    });

    expect(result.replyMarkup.inline_keyboard).toHaveLength(2);
    expect(result.replyMarkup.inline_keyboard[0]).toHaveLength(3);
    expect(result.replyMarkup.inline_keyboard[1]).toHaveLength(1);
    expect(result.replyMarkup.inline_keyboard[1]![0]!.callback_data).toBe("cmd:tok-wrap:q3");
  });

  it("hides buttons for multi-question requests", () => {
    const result = formatQuestionNotification({
      label: "test",
      questions: [
        { question: "Q1", header: "H1", options: [{ label: "A", description: "" }] },
        { question: "Q2", header: "H2", options: [{ label: "B", description: "" }] },
      ],
      cwd: "/tmp",
      token: "tok-multi",
    });

    // Shows only first question
    expect(result.text).toContain("Q1");
    expect(result.text).toContain("+1 more question");
    // No inline buttons for multi-question
    expect(result.replyMarkup.inline_keyboard).toHaveLength(0);
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
    });

    expect(result.text).not.toContain("Swipe-reply");
  });
});

describe("TelegramNotificationService.sendQuestionNotification", () => {
  it("stores pending question, mints token, and sends telegram message", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-q",
      notify: true,
      label: "Test",
      cwd: "/tmp",
    }, 1_000);

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const service = new TelegramNotificationService(
      storage, "bot-token", "8248645256", () => 2_000, fetchMock,
    );

    const result = await service.sendQuestionNotification({
      session: { sessionId: "sess-q", label: "Test", cwd: "/tmp" },
      questionRequestId: "question_xyz",
      questions: [{
        question: "Which DB?",
        header: "DB",
        options: [
          { label: "PG", description: "PostgreSQL" },
          { label: "SQLite", description: "File DB" },
        ],
      }],
    });

    expect(result.token).toBeTruthy();

    // Verify pending question stored
    const pending = storage.pendingQuestions.getBySessionId("sess-q", 2_001);
    expect(pending).toBeTruthy();
    expect(pending!.requestId).toBe("question_xyz");
    expect(pending!.questions).toHaveLength(1);
    expect(pending!.token).toBe(result.token);

    // Verify session token minted with question context
    const tokenRecord = storage.sessionTokens.validate(result.token, "8248645256", 2_001);
    expect(tokenRecord?.sessionId).toBe("sess-q");
    expect(tokenRecord?.context).toMatchObject({
      type: "question",
      questionRequestId: "question_xyz",
    });

    // Verify reply token stored
    const replyMapped = storage.replyTokens.lookup("8248645256", "999", 2_001);
    expect(replyMapped).toBe(result.token);

    // Verify Telegram API called
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(options.body)) as Record<string, unknown>;
    expect(payload.parse_mode).toBe("Markdown");
    expect((payload.text as string)).toContain("Question");
    expect((payload.text as string)).toContain("Which DB?");

    storage.db.close();
  });
});
