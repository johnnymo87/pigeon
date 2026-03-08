import { describe, expect, it, vi } from "vitest";
import { openStorageDb } from "../src/storage/database";
import { ingestWorkerCommand } from "../src/worker/command-ingest";
import { ResultErrorCode } from "../src/opencode-direct/contracts";
import type { CommandDeliveryAdapter, CommandDeliveryContext, QuestionReplyInput } from "../src/adapters/types";

describe("ingestWorkerCommand", () => {
  it("acks and marks command done on successful direct-channel delivery", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-1",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-1",
        sessionId: "sess-1",
        command: "ls",
        chatId: "1",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
      {
        async executeDirect() {
          return {
            ok: true,
            status: 200,
            attempts: 1,
            ack: {
              type: "pigeon.command.ack",
              version: 1,
              requestId: "cmd-1",
              commandId: "cmd-1",
              sessionId: "sess-1",
              accepted: true,
              acceptedAt: Date.now(),
            },
            result: {
              type: "pigeon.command.result",
              version: 1,
              requestId: "cmd-1",
              commandId: "cmd-1",
              sessionId: "sess-1",
              success: true,
              finishedAt: Date.now(),
              output: "queued",
            },
          };
        },
      },
    );

    expect(sent).toEqual([
      { type: "ack", commandId: "cmd-1" },
      { type: "commandResult", commandId: "cmd-1", success: true, error: null, chatId: "1" },
    ]);

    const unfinished = storage.inbox.listUnfinished();
    expect(unfinished).toHaveLength(0);
    storage.db.close();
  });

  it("returns commandResult failure when session missing", async () => {
    const storage = openStorageDb(":memory:");
    const sent: unknown[] = [];

    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-2",
        sessionId: "nope",
        command: "ls",
        chatId: "2",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
    );

    expect(sent).toEqual([
      { type: "ack", commandId: "cmd-2" },
      {
        type: "commandResult",
        commandId: "cmd-2",
        success: false,
        error: "Session not found. Wait for a new notification.",
        chatId: "2",
      },
    ]);

    const unfinished = storage.inbox.listUnfinished();
    expect(unfinished).toHaveLength(1);
    storage.db.close();
  });

  it("routes opencode-plugin-direct sessions through direct adapter", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-direct",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-direct-1",
        sessionId: "sess-direct",
        command: "echo hi",
        chatId: "3",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
      {
        async executeDirect() {
          return {
            ok: true,
            status: 200,
            attempts: 1,
            ack: {
              type: "pigeon.command.ack",
              version: 1,
              requestId: "cmd-direct-1",
              commandId: "cmd-direct-1",
              sessionId: "sess-direct",
              accepted: true,
              acceptedAt: Date.now(),
            },
            result: {
              type: "pigeon.command.result",
              version: 1,
              requestId: "cmd-direct-1",
              commandId: "cmd-direct-1",
              sessionId: "sess-direct",
              success: true,
              finishedAt: Date.now(),
              output: "queued",
            },
          };
        },
      },
    );

    expect(sent).toEqual([
      { type: "ack", commandId: "cmd-direct-1" },
      { type: "commandResult", commandId: "cmd-direct-1", success: true, error: null, chatId: "3" },
    ]);
    expect(storage.inbox.listUnfinished()).toHaveLength(0);
    storage.db.close();
  });

  it("returns direct adapter error as commandResult failure", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-direct-fail",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-direct-2",
        sessionId: "sess-direct-fail",
        command: "echo hi",
        chatId: "4",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
      {
        async executeDirect() {
          return {
            ok: false,
            status: 200,
            attempts: 1,
            ack: {
              type: "pigeon.command.ack",
              version: 1,
              requestId: "cmd-direct-2",
              commandId: "cmd-direct-2",
              sessionId: "sess-direct-fail",
              accepted: true,
              acceptedAt: Date.now(),
            },
            result: {
              type: "pigeon.command.result",
              version: 1,
              requestId: "cmd-direct-2",
              commandId: "cmd-direct-2",
              sessionId: "sess-direct-fail",
              success: false,
              finishedAt: Date.now(),
              errorCode: ResultErrorCode.ExecutionError,
              errorMessage: "plugin failed",
            },
            error: "plugin failed",
          };
        },
      },
    );

    expect(sent).toEqual([
      { type: "ack", commandId: "cmd-direct-2" },
      {
        type: "commandResult",
        commandId: "cmd-direct-2",
        success: false,
        error: "plugin failed",
        chatId: "4",
      },
    ]);
    expect(storage.inbox.listUnfinished()).toHaveLength(1);
    storage.db.close();
  });

  it("rejects opencode-plugin-direct sessions with missing endpoint", async () => {
    const storage = openStorageDb(":memory:");
    // Session has backendKind but NO endpoint or auth token — incomplete registration
    storage.sessions.upsert({
      sessionId: "sess-incomplete",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      // backendEndpoint and backendAuthToken intentionally omitted
    }, 1_000);

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-guard-1",
        sessionId: "sess-incomplete",
        command: "echo test",
        chatId: "5",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
    );

    expect(sent).toEqual([
      { type: "ack", commandId: "cmd-guard-1" },
      {
        type: "commandResult",
        commandId: "cmd-guard-1",
        success: false,
        error: "Session is not configured for command delivery. Re-register with backend endpoint and auth token.",
        chatId: "5",
      },
    ]);
    expect(storage.inbox.listUnfinished()).toHaveLength(1);
    storage.db.close();
  });

  it("rejects opencode-plugin-direct sessions with endpoint but missing auth token", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-no-token",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:9999/pigeon/direct/execute",
      // backendAuthToken intentionally omitted
    }, 1_000);

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-guard-2",
        sessionId: "sess-no-token",
        command: "echo test",
        chatId: "6",
      },
      {
        send(payload) {
          sent.push(payload);
        },
      },
    );

    expect(sent[1]).toMatchObject({
      type: "commandResult",
      commandId: "cmd-guard-2",
      success: false,
    });
    storage.db.close();
  });

  it("routes button press as question reply when pending question exists", async () => {
    const now = Date.now();
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-q1",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, now);

    storage.pendingQuestions.store({
      sessionId: "sess-q1",
      requestId: "question_abc",
      questions: [{
        question: "Which DB?",
        header: "DB",
        options: [
          { label: "PostgreSQL", description: "Relational" },
          { label: "SQLite", description: "File-based" },
        ],
      }],
    }, now);

    let capturedReply: QuestionReplyInput | null = null;

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-q1",
        sessionId: "sess-q1",
        command: "q1",
        chatId: "1",
      },
      { send(payload) { sent.push(payload); } },
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: false, error: "should not be called" }; },
          async deliverQuestionReply(_session, reply) {
            capturedReply = reply;
            return { ok: true };
          },
        }),
      },
    );

    expect(capturedReply).toEqual({
      questionRequestId: "question_abc",
      answers: [["SQLite"]],
    });

    expect(sent).toContainEqual(
      expect.objectContaining({ type: "commandResult", commandId: "cmd-q1", success: true }),
    );

    // Pending question should be cleared
    expect(storage.pendingQuestions.getBySessionId("sess-q1")).toBeNull();
    storage.db.close();
  });

  it("routes custom text as question reply when pending question exists", async () => {
    const now = Date.now();
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-q2",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, now);

    storage.pendingQuestions.store({
      sessionId: "sess-q2",
      requestId: "question_def",
      questions: [{
        question: "Which DB?",
        header: "DB",
        options: [{ label: "PostgreSQL", description: "" }],
      }],
    }, now);

    let capturedReply: QuestionReplyInput | null = null;

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-q2",
        sessionId: "sess-q2",
        command: "Use MongoDB instead",
        chatId: "1",
      },
      { send(payload) { sent.push(payload); } },
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: false, error: "should not be called" }; },
          async deliverQuestionReply(_session, reply) {
            capturedReply = reply;
            return { ok: true };
          },
        }),
      },
    );

    expect(capturedReply).toEqual({
      questionRequestId: "question_def",
      answers: [["Use MongoDB instead"]],
    });

    expect(sent).toContainEqual(
      expect.objectContaining({ type: "commandResult", commandId: "cmd-q2", success: true }),
    );
    storage.db.close();
  });

  it("rejects stale question option press when no pending question", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-q3",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);

    // No pending question stored

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-q3",
        sessionId: "sess-q3",
        command: "q0",
        chatId: "1",
      },
      { send(payload) { sent.push(payload); } },
    );

    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "commandResult",
        commandId: "cmd-q3",
        success: false,
        error: "This question has already been answered.",
      }),
    );
    storage.db.close();
  });

  it("rejects out-of-range option index", async () => {
    const now = Date.now();
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-q4",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, now);

    storage.pendingQuestions.store({
      sessionId: "sess-q4",
      requestId: "question_oob",
      questions: [{
        question: "Pick one",
        header: "Choice",
        options: [{ label: "Only Option", description: "" }],
      }],
    }, now);

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-q4",
        sessionId: "sess-q4",
        command: "q5",
        chatId: "1",
      },
      { send(payload) { sent.push(payload); } },
    );

    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "commandResult",
        success: false,
        error: expect.stringContaining("Invalid option index"),
      }),
    );
    storage.db.close();
  });

  it("fetches media from worker and passes it to adapter context", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-media-1",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);

    const fakeImageBytes = Buffer.from("fake-image-data");
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://worker.example.com/media/inbound/123-abc/photo.jpg") {
        return new Response(fakeImageBytes, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      // Plugin endpoint - return a valid ack/result
      return new Response(JSON.stringify({
        ack: {
          type: "pigeon.command.ack",
          version: 1,
          requestId: "cmd-media-1",
          commandId: "cmd-media-1",
          sessionId: "sess-media-1",
          accepted: true,
          acceptedAt: Date.now(),
        },
        result: {
          type: "pigeon.command.result",
          version: 1,
          requestId: "cmd-media-1",
          commandId: "cmd-media-1",
          sessionId: "sess-media-1",
          success: true,
          finishedAt: Date.now(),
          output: "queued",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    let capturedContext: CommandDeliveryContext | null = null;
    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-media-1",
        sessionId: "sess-media-1",
        command: "caption text",
        chatId: "1",
        media: {
          key: "inbound/123-abc/photo.jpg",
          mime: "image/jpeg",
          filename: "photo.jpg",
          size: 12345,
        },
      },
      { send(payload) { sent.push(payload); } },
      {
        workerUrl: "https://worker.example.com",
        apiKey: "test-api-key",
        fetchFn: fetchFn as unknown as typeof fetch,
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand(_session, _command, context) {
            capturedContext = context;
            return { ok: true };
          },
        }),
      },
    );

    expect(fetchFn).toHaveBeenCalledWith(
      "https://worker.example.com/media/inbound/123-abc/photo.jpg",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-api-key" }) }),
    );

    const ctx1 = capturedContext as CommandDeliveryContext | null;
    expect(ctx1?.media).toEqual({
      mime: "image/jpeg",
      filename: "photo.jpg",
      url: `data:image/jpeg;base64,${fakeImageBytes.toString("base64")}`,
    });

    expect(sent).toContainEqual(
      expect.objectContaining({ type: "commandResult", commandId: "cmd-media-1", success: true }),
    );
    storage.db.close();
  });

  it("returns commandResult failure when R2 media fetch fails", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-media-2",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);

    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response("Not Found", { status: 404 });
    });

    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-media-2",
        sessionId: "sess-media-2",
        command: "caption text",
        chatId: "2",
        media: {
          key: "inbound/123-abc/photo.jpg",
          mime: "image/jpeg",
          filename: "photo.jpg",
          size: 12345,
        },
      },
      { send(payload) { sent.push(payload); } },
      {
        workerUrl: "https://worker.example.com",
        apiKey: "test-api-key",
        fetchFn: fetchFn as unknown as typeof fetch,
      },
    );

    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "commandResult",
        commandId: "cmd-media-2",
        success: false,
        error: expect.stringContaining("Failed to fetch media"),
      }),
    );
    storage.db.close();
  });

  it("text-only command sends no media in adapter context (backward compat)", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-text-only",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);

    let capturedContext: CommandDeliveryContext | null = null;
    const sent: unknown[] = [];
    await ingestWorkerCommand(
      storage,
      {
        type: "command",
        commandId: "cmd-text-only",
        sessionId: "sess-text-only",
        command: "just text",
        chatId: "3",
      },
      { send(payload) { sent.push(payload); } },
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand(_session, _command, context) {
            capturedContext = context;
            return { ok: true };
          },
        }),
      },
    );

    const ctx2 = capturedContext as CommandDeliveryContext | null;
    expect(ctx2?.media).toBeUndefined();
    expect(sent).toContainEqual(
      expect.objectContaining({ type: "commandResult", commandId: "cmd-text-only", success: true }),
    );
    storage.db.close();
  });
});
