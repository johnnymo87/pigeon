import { describe, expect, it, vi } from "vitest";
import {
  formatTelegramNotification,
  formatQuestionNotification,
  formatQuestionWizardStep,
  TelegramNotificationService,
  WorkerNotificationService,
  type WorkerNotificationSender,
} from "../src/notification-service";
import type { QuestionInfoData } from "../src/storage/types";
import { openStorageDb } from "../src/storage/database";

describe("formatTelegramNotification", () => {
  it("formats markdown body with no inline buttons", () => {
    const result = formatTelegramNotification({
      event: "Stop",
      label: "my_[label]*",
      summary: "Done",
      cwd: "/home/dev/projects/pigeon",
      token: "tok123",
      sessionId: "sess-abc123",
    });

    expect(result.texts).toHaveLength(1);
    expect(result.texts[0]).toContain("*Stop*: my\\_\\[label\\]\\*");
    expect(result.texts[0]).toContain("📂 `projects/pigeon`");
    expect(result.texts[0]).toContain("🆔 `sess-abc123`");
    expect(result.replyMarkup.inline_keyboard).toHaveLength(0);
  });

  it("includes machine ID in info line when provided", () => {
    const result = formatTelegramNotification({
      event: "Stop",
      label: "test",
      summary: "Done",
      cwd: "/home/dev/projects/pigeon",
      token: "tok123",
      machineId: "devbox",
      sessionId: "sess-xyz",
    });

    expect(result.texts[0]).toContain("📂 `projects/pigeon` · 🖥 devbox");
    expect(result.texts[0]).toContain("\n🆔 `sess-xyz`");
  });

  it("omits machine ID from info line when not provided", () => {
    const result = formatTelegramNotification({
      event: "Stop",
      label: "test",
      summary: "Done",
      cwd: "/home/dev/projects/pigeon",
      token: "tok123",
      sessionId: "sess-nomachine",
    });

    expect(result.texts[0]).toContain("📂 `projects/pigeon`");
    expect(result.texts[0]).toContain("\n🆔 `sess-nomachine`");
    expect(result.texts[0]).not.toContain("🖥");
  });

  it("splits long summary into multiple messages with header/footer on each", () => {
    // Generate a summary that exceeds 4096 chars when combined with header+footer overhead (~71 chars)
    const longSummary = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} content here.`).join("\n\n");
    const result = formatTelegramNotification({
      event: "Stop",
      label: "test",
      summary: longSummary,
      cwd: "/tmp",
      token: "tok-long",
      sessionId: "sess-long",
    });

    expect(result.texts.length).toBeGreaterThan(1);
    for (const text of result.texts) {
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text).toContain("*Stop*");
      expect(text).toContain("🆔 `sess-long`");
    }
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
    expect((payload.text as string)).toContain("🆔 `sess-1`");

    storage.db.close();
  });

  it("sends multiple Telegram messages for long summaries", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-long",
      notify: true,
      label: "Long Test",
      cwd: "/tmp",
    }, 1_000);

    let msgIdCounter = 100;
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, result: { message_id: msgIdCounter++ } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const service = new TelegramNotificationService(
      storage, "bot-token", "8248645256", () => 2_000, fetchMock,
    );

    const longSummary = Array.from({ length: 200 }, (_, i) => `Paragraph ${i}: ${"x".repeat(60)}`).join("\n\n");

    const result = await service.sendStopNotification({
      session: { sessionId: "sess-long", label: "Long Test", cwd: "/tmp" },
      event: "Stop",
      summary: longSummary,
    });

    expect(result.token).toBeTruthy();
    expect((fetchMock as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);

    // All sent messages should map to the same token via reply routing
    const mapped100 = storage.replyTokens.lookup("8248645256", "100", 2_001);
    const mapped101 = storage.replyTokens.lookup("8248645256", "101", 2_001);
    expect(mapped100).toBe(result.token);
    expect(mapped101).toBe(result.token);

    storage.db.close();
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

    expect(result.text).toContain("Question 1 of 2");
    expect(result.text).toContain("*Database*");
    expect(result.text).toContain("Which DB?");
    expect(result.text).toContain("PostgreSQL");
    expect(result.text).toContain("SQLite");
    expect(result.text).not.toContain("ORM"); // future question not shown
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

    expect(result.text).toContain("Question 2 of 2");
    expect(result.text).toContain("*ORM*");
    expect(result.text).toContain("Which ORM?");
    expect(result.text).not.toContain("Database");
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
    expect(result.text).toContain("Swipe-reply for custom answer");
  });

  it("hides swipe-reply hint when custom=false", () => {
    const qs = [{ ...questions[0]!, custom: false }, questions[1]!];
    const result = formatQuestionWizardStep({
      label: "test", questions: qs, currentStep: 0,
      cwd: "/tmp", token: "tok-wiz", version: 0, sessionId: "s1",
    });
    expect(result.text).not.toContain("Swipe-reply");
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

    expect(result.text).toContain("❓ *Question*: pigeon");
    expect(result.text).toContain("*Database Choice*");
    expect(result.text).toContain("Which database should I use?");
    expect(result.text).toContain("PostgreSQL");
    expect(result.text).toContain("SQLite");
    expect(result.text).toContain("📂 `projects/pigeon` · 🖥 devbox");
    expect(result.text).toContain("\n🆔 `sess-q1`");
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
    expect(result.text).toContain("(1/2) *H1*");
    expect(result.text).toContain("Q1 text");
    expect(result.text).toContain("A");
    expect(result.text).toContain("(2/2) *H2*");
    expect(result.text).toContain("Q2 text");
    expect(result.text).toContain("B");
    // Fallback hint
    expect(result.text).toContain("answer in app");
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

    expect(result.text).toContain("(1/2)");
    expect(result.text).toContain("(2/2)");
    expect(result.text).toContain("Q1 text");
    expect(result.text).toContain("Q2 text");
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

    expect(result.text).toContain("Swipe-reply");
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
    expect((payload.text as string)).toContain("🆔 `sess-q`");

    storage.db.close();
  });
});

describe("WorkerNotificationService.sendStopNotification with media", () => {
  it("uploads media files to R2 and passes keys to sendNotification", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-media",
      notify: true,
      label: "Media Test",
      cwd: "/tmp/media",
    }, 1_000);

    const uploadMediaMock = vi.fn(async (key: string, _data: ArrayBuffer, _mime: string, _filename: string) => {
      return { ok: true, key };
    });

    const sendNotificationMock = vi.fn(async () => ({ ok: true }));

    const workerSender: WorkerNotificationSender = {
      sendNotification: sendNotificationMock,
      uploadMedia: uploadMediaMock,
    };

    const service = new WorkerNotificationService(
      storage,
      workerSender,
      "8248645256",
      () => 2_000,
    );

    // Create a simple data URI (PNG as base64)
    const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const dataUri = `data:image/png;base64,${fakeBase64}`;

    const result = await service.sendStopNotification({
      session: {
        sessionId: "sess-media",
        label: "Media Test",
        cwd: "/tmp/media",
      },
      event: "Stop",
      summary: "Done with media",
      media: [
        { mime: "image/png", filename: "screenshot.png", url: dataUri },
      ],
    });

    expect(result.token).toBeTruthy();

    // uploadMedia should have been called once with correct params
    expect(uploadMediaMock).toHaveBeenCalledTimes(1);
    const [key, data, mime, filename] = uploadMediaMock.mock.calls[0] as [string, ArrayBuffer, string, string];
    expect(key).toMatch(/^outbound\/\d+-[a-f0-9-]+\/screenshot\.png$/);
    expect(data).toBeInstanceOf(ArrayBuffer);
    expect(mime).toBe("image/png");
    expect(filename).toBe("screenshot.png");

    // sendNotification should have been called with the media keys
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const notifCall = sendNotificationMock.mock.calls[0] as unknown as [string, string, string, unknown, Array<{ key: string; mime: string; filename: string }>];
    const mediaKeys = notifCall[4];
    expect(mediaKeys).toHaveLength(1);
    expect(mediaKeys[0]!.mime).toBe("image/png");
    expect(mediaKeys[0]!.filename).toBe("screenshot.png");
    expect(mediaKeys[0]!.key).toMatch(/^outbound\//);

    storage.db.close();
  });

  it("text notification still goes through when media upload fails", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-media-fail",
      notify: true,
      label: "Media Fail Test",
      cwd: "/tmp",
    }, 1_000);

    // uploadMedia always fails
    const uploadMediaMock = vi.fn(async () => ({ ok: false, key: "" }));
    const sendNotificationMock = vi.fn(async () => ({ ok: true }));

    const workerSender: WorkerNotificationSender = {
      sendNotification: sendNotificationMock,
      uploadMedia: uploadMediaMock,
    };

    const service = new WorkerNotificationService(
      storage,
      workerSender,
      "8248645256",
      () => 2_000,
    );

    const fakeBase64 = "aGVsbG8="; // "hello" in base64
    const dataUri = `data:image/jpeg;base64,${fakeBase64}`;

    const result = await service.sendStopNotification({
      session: {
        sessionId: "sess-media-fail",
        label: "Media Fail Test",
        cwd: "/tmp",
      },
      event: "Stop",
      summary: "Done",
      media: [
        { mime: "image/jpeg", filename: "photo.jpg", url: dataUri },
      ],
    });

    // Token should still be returned
    expect(result.token).toBeTruthy();

    // sendNotification should still be called (text goes through)
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);

    // media keys should be undefined (upload failed, resulting array is empty)
    const failNotifCall = sendNotificationMock.mock.calls[0] as unknown as [string, string, string, unknown, unknown];
    const failMediaKeys = failNotifCall[4];
    expect(failMediaKeys).toBeUndefined();

    storage.db.close();
  });

  it("sendNotification called without media when no media in input", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-no-media",
      notify: true,
      label: "No Media",
      cwd: "/tmp",
    }, 1_000);

    const uploadMediaMock = vi.fn(async () => ({ ok: true, key: "some-key" }));
    const sendNotificationMock = vi.fn(async () => ({ ok: true }));

    const workerSender: WorkerNotificationSender = {
      sendNotification: sendNotificationMock,
      uploadMedia: uploadMediaMock,
    };

    const service = new WorkerNotificationService(
      storage,
      workerSender,
      "8248645256",
      () => 2_000,
    );

    await service.sendStopNotification({
      session: {
        sessionId: "sess-no-media",
        label: "No Media",
        cwd: "/tmp",
      },
      event: "Stop",
      summary: "Done",
      // no media field
    });

    // uploadMedia should NOT have been called
    expect(uploadMediaMock).not.toHaveBeenCalled();

    // sendNotification should have been called without media
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const noMediaCall = sendNotificationMock.mock.calls[0] as unknown as [string, string, string, unknown, unknown];
    const noMediaKeys = noMediaCall[4];
    expect(noMediaKeys).toBeUndefined();

    storage.db.close();
  });

  it("attaches media to last chunk only for long summaries", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-media-long",
      notify: true,
      label: "Media Long Test",
      cwd: "/tmp/media",
    }, 1_000);

    const uploadMediaMock = vi.fn(async (key: string, _data: ArrayBuffer, _mime: string, _filename: string) => {
      return { ok: true, key };
    });

    const sendNotificationMock = vi.fn(async () => ({ ok: true }));

    const workerSender: WorkerNotificationSender = {
      sendNotification: sendNotificationMock,
      uploadMedia: uploadMediaMock,
    };

    const service = new WorkerNotificationService(
      storage,
      workerSender,
      "8248645256",
      () => 2_000,
    );

    const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const dataUri = `data:image/png;base64,${fakeBase64}`;

    const longSummary = Array.from({ length: 200 }, (_, i) => `Paragraph ${i}: ${"x".repeat(60)}`).join("\n\n");

    await service.sendStopNotification({
      session: {
        sessionId: "sess-media-long",
        label: "Media Long Test",
        cwd: "/tmp/media",
      },
      event: "Stop",
      summary: longSummary,
      media: [
        { mime: "image/png", filename: "screenshot.png", url: dataUri },
      ],
    });

    // Multiple chunks should have been sent
    const callCount = (sendNotificationMock as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callCount).toBeGreaterThan(1);

    // Only the last call should have media
    for (let i = 0; i < callCount; i++) {
      const call = (sendNotificationMock as ReturnType<typeof vi.fn>).mock.calls[i] as unknown as [string, string, string, unknown, unknown];
      const media = call[4];
      if (i < callCount - 1) {
        expect(media).toBeUndefined();
      } else {
        expect(media).toHaveLength(1);
      }
    }

    storage.db.close();
  });
});
