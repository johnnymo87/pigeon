import { spawn } from "child_process";
import { describe, expect, it, vi } from "vitest";
import { openStorageDb } from "../src/storage/database";
import { ingestWorkerCommand } from "../src/worker/command-ingest";
import { ResultErrorCode } from "../src/opencode-direct/contracts";
import type { CommandDeliveryAdapter, CommandDeliveryContext, QuestionReplyInput } from "../src/adapters/types";
import type { ExecuteMessage } from "../src/worker/poller";
import type { ReviveAndDeliverDeps } from "../src/worker/revive-and-deliver";

function makeMsg(overrides: Partial<ExecuteMessage> = {}): ExecuteMessage {
  return {
    commandId: "cmd-1",
    commandType: "execute",
    sessionId: "sess-1",
    command: "ls",
    chatId: "1",
    ...overrides,
  };
}

describe("ingestWorkerCommand", () => {
  it("marks command done on successful direct-channel delivery", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-1",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-1", sessionId: "sess-1", command: "ls", chatId: "1" }),
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

    const unfinished = storage.inbox.listUnfinished();
    expect(unfinished).toHaveLength(0);
    storage.db.close();
  });

  it("deduplicates commands and returns without error", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-1",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);

    const deliverCount = { n: 0 };
    const opts = {
      createAdapter: () => ({
        name: "mock",
        async deliverCommand() {
          deliverCount.n++;
          return { ok: true as const };
        },
      }),
    };

    // First call — should deliver
    await ingestWorkerCommand(storage, makeMsg({ commandId: "cmd-dedup" }), opts);
    // Second call with same commandId — should dedup
    await ingestWorkerCommand(storage, makeMsg({ commandId: "cmd-dedup" }), opts);

    expect(deliverCount.n).toBe(1);
    storage.db.close();
  });

  it("returns normally (Poller acks) when session is missing", async () => {
    const storage = openStorageDb(":memory:");

    // Should not throw — Poller will ack
    await expect(
      ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-2", sessionId: "nope", chatId: "2" }),
      ),
    ).resolves.toBeUndefined();

    // Command should be in unfinished (persisted but not marked done)
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

    let delivered = false;
    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-direct-1", sessionId: "sess-direct", command: "echo hi", chatId: "3" }),
      {
        async executeDirect() {
          delivered = true;
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

    expect(delivered).toBe(true);
    expect(storage.inbox.listUnfinished()).toHaveLength(0);
    storage.db.close();
  });

  it("returns normally (Poller acks) on direct adapter error", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-direct-fail",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);

    await expect(
      ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-direct-2", sessionId: "sess-direct-fail", command: "echo hi", chatId: "4" }),
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
      ),
    ).resolves.toBeUndefined();

    expect(storage.inbox.listUnfinished()).toHaveLength(1);
    storage.db.close();
  });

  it("returns normally (Poller acks) when session endpoint is incomplete", async () => {
    const storage = openStorageDb(":memory:");
    // Session has backendKind but NO endpoint or auth token — incomplete registration
    storage.sessions.upsert({
      sessionId: "sess-incomplete",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      // backendEndpoint and backendAuthToken intentionally omitted
    }, 1_000);

    await expect(
      ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-guard-1", sessionId: "sess-incomplete", command: "echo test", chatId: "5" }),
      ),
    ).resolves.toBeUndefined();

    expect(storage.inbox.listUnfinished()).toHaveLength(1);
    storage.db.close();
  });

  it("returns normally when session has endpoint but missing auth token", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-no-token",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:9999/pigeon/direct/execute",
      // backendAuthToken intentionally omitted
    }, 1_000);

    await expect(
      ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-guard-2", sessionId: "sess-no-token", command: "echo test", chatId: "6" }),
      ),
    ).resolves.toBeUndefined();

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

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-q1", sessionId: "sess-q1", command: "q1", chatId: "1" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: false, error: "should not be called" }; },
          async deliverQuestionReply(_session: unknown, reply: QuestionReplyInput) {
            capturedReply = reply;
            return { ok: true as const };
          },
        }),
      },
    );

    expect(capturedReply).toEqual({
      questionRequestId: "question_abc",
      answers: [["SQLite"]],
    });

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

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-q2", sessionId: "sess-q2", command: "Use MongoDB instead", chatId: "1" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: false, error: "should not be called" }; },
          async deliverQuestionReply(_session: unknown, reply: QuestionReplyInput) {
            capturedReply = reply;
            return { ok: true as const };
          },
        }),
      },
    );

    expect(capturedReply).toEqual({
      questionRequestId: "question_def",
      answers: [["Use MongoDB instead"]],
    });

    storage.db.close();
  });

  it("leaves pending question replies retryable when direct-channel delivery has a connection error", async () => {
    const now = Date.now();
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-q-retry",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, now);

    storage.pendingQuestions.store({
      sessionId: "sess-q-retry",
      requestId: "question_retry",
      questions: [{
        question: "Which DB?",
        header: "DB",
        options: [{ label: "PostgreSQL", description: "" }],
      }],
    }, now);

    let attempts = 0;
    let capturedReply: QuestionReplyInput | null = null;
    const msg = makeMsg({
      commandId: "cmd-q-retry",
      sessionId: "sess-q-retry",
      command: "option one",
      chatId: "1",
      metadata: { questionRequestId: "question_retry" },
    });
    const opts = {
      createAdapter: () => ({
        name: "mock-direct",
        async deliverCommand() { return { ok: false as const, error: "should not be called" }; },
        async deliverQuestionReply(_session: unknown, reply: QuestionReplyInput) {
          attempts++;
          if (attempts === 1) {
            return { ok: false as const, error: "fetch failed" };
          }
          capturedReply = reply;
          return { ok: true as const };
        },
      }),
    };

    await expect(ingestWorkerCommand(storage, msg, opts)).rejects.toThrow(/fetch failed/);

    expect(storage.inbox.listUnfinished().map((row) => row.commandId)).toEqual(["cmd-q-retry"]);
    expect(storage.pendingQuestions.getBySessionId("sess-q-retry")).not.toBeNull();

    await ingestWorkerCommand(storage, msg, opts);

    expect(attempts).toBe(2);
    expect(capturedReply).toEqual({
      questionRequestId: "question_retry",
      answers: [["option one"]],
    });
    expect(storage.inbox.listUnfinished()).toHaveLength(0);
    expect(storage.pendingQuestions.getBySessionId("sess-q-retry")).toBeNull();
    storage.db.close();
  });

  it("marks inbox done when question option is stale (no pending question)", async () => {
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

    await expect(
      ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-q3", sessionId: "sess-q3", command: "q0", chatId: "1" }),
      ),
    ).resolves.toBeUndefined();

    expect(storage.inbox.listUnfinished()).toHaveLength(0);
    storage.db.close();
  });

  it("marks inbox done when wizard-format question option is stale (no pending question)", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-q3w",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);

    // No pending question stored — wizard-format v0:q0 should also be caught

    await expect(
      ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-q3w", sessionId: "sess-q3w", command: "v0:q0", chatId: "1" }),
      ),
    ).resolves.toBeUndefined();

    expect(storage.inbox.listUnfinished()).toHaveLength(0);
    storage.db.close();
  });

  it("returns normally when option index is out of range", async () => {
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

    await expect(
      ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-q4", sessionId: "sess-q4", command: "q5", chatId: "1" }),
      ),
    ).resolves.toBeUndefined();

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
    await ingestWorkerCommand(
      storage,
      {
        commandId: "cmd-media-1",
        commandType: "execute",
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
      {
        workerUrl: "https://worker.example.com",
        apiKey: "test-api-key",
        fetchFn: fetchFn as unknown as typeof fetch,
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand(_session: unknown, _command: unknown, context: CommandDeliveryContext) {
            capturedContext = context;
            return { ok: true as const };
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

    storage.db.close();
  });

  it("throws on R2 media fetch failure (transient — Poller retries)", async () => {
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

    await expect(
      ingestWorkerCommand(
        storage,
        {
          commandId: "cmd-media-2",
          commandType: "execute",
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
        {
          workerUrl: "https://worker.example.com",
          apiKey: "test-api-key",
          fetchFn: fetchFn as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow();

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
    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-text-only", sessionId: "sess-text-only", command: "just text", chatId: "3" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand(_session: unknown, _command: unknown, context: CommandDeliveryContext) {
            capturedContext = context;
            return { ok: true as const };
          },
        }),
      },
    );

    const ctx2 = capturedContext as CommandDeliveryContext | null;
    expect(ctx2?.media).toBeUndefined();
    storage.db.close();
  });

  describe("connection-error fallback (revive-on-reply)", () => {
    const mockSpawn = (() => ({ on: () => {}, unref: () => {} })) as unknown as ReviveAndDeliverDeps["spawn"];
    it("revives via opencode-serve, keeps session row, clears backendEndpoint, acks", async () => {
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-revive",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);

      const sendPromptCalls: Array<{ sid: string; dir: string; prompt: string }> = [];

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-revive", sessionId: "sess-revive", command: "fix the bug", chatId: "5" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              return { ok: false, error: "fetch failed: ECONNREFUSED" };
            },
          }),
          opencodeClient: {
            async getSession() { return { id: "sess-revive", directory: "/tmp/proj" }; },
            async sendPrompt(sid, dir, prompt) { sendPromptCalls.push({ sid, dir, prompt }); },
          },
          spawn: mockSpawn,
        },
      );

      // Session kept, endpoint cleared
      const row = storage.sessions.get("sess-revive");
      expect(row).not.toBeNull();
      expect(row!.backendEndpoint).toBeNull();
      expect(row!.backendAuthToken).toBeNull();

      // Fallback delivery happened
      expect(sendPromptCalls).toEqual([{ sid: "sess-revive", dir: "/tmp/proj", prompt: "fix the bug" }]);

      // Command acked (no unfinished inbox entries)
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("deletes session and notifies user when opencode-serve says 404", async () => {
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-gone",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);

      const tgCalls: Array<{ chatId: string; text: string }> = [];

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-gone", sessionId: "sess-gone", command: "hello", chatId: "9" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              return { ok: false, error: "fetch failed: ECONNREFUSED" };
            },
          }),
          opencodeClient: {
            async getSession() { return null; },
            async sendPrompt() { throw new Error("should not be called"); },
          },
          sendTelegramReply: async (chatId, text) => { tgCalls.push({ chatId, text }); },
          spawn: mockSpawn,
        },
      );

      // Session deleted (matches old behavior for the truly-gone case)
      expect(storage.sessions.get("sess-gone")).toBeNull();

      // User notified
      expect(tgCalls).toHaveLength(1);
      expect(tgCalls[0]!.chatId).toBe("9");
      expect(tgCalls[0]!.text).toMatch(/no longer exists|gone/i);

      // Command acked
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("notifies user and keeps session when opencode-serve is unreachable", async () => {
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-unreach",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);

      const tgCalls: Array<{ chatId: string; text: string }> = [];

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-unreach", sessionId: "sess-unreach", command: "hi", chatId: "10" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              return { ok: false, error: "fetch failed: ECONNREFUSED" };
            },
          }),
          opencodeClient: {
            async getSession() { throw new Error("ECONNREFUSED"); },
            async sendPrompt() { throw new Error("should not be called"); },
          },
          sendTelegramReply: async (chatId, text) => { tgCalls.push({ chatId, text }); },
          spawn: mockSpawn,
        },
      );

      // Session kept (we don't know if it's gone or just unreachable)
      const row = storage.sessions.get("sess-unreach");
      expect(row).not.toBeNull();
      // Endpoint preserved for diagnosis
      expect(row!.backendEndpoint).toBe("http://127.0.0.1:7777/pigeon/direct/execute");

      // User notified
      expect(tgCalls).toHaveLength(1);
      expect(tgCalls[0]!.text).toMatch(/unreachable|opencode-serve/i);

      // Command acked
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("notifies user and keeps session when sendPrompt itself fails", async () => {
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-deliv-fail",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);

      const tgCalls: Array<{ chatId: string; text: string }> = [];

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-deliv-fail", sessionId: "sess-deliv-fail", command: "hi", chatId: "11" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              return { ok: false, error: "fetch failed: ECONNREFUSED" };
            },
          }),
          opencodeClient: {
            async getSession() { return { id: "sess-deliv-fail", directory: "/tmp" }; },
            async sendPrompt() { throw new Error("opencode-serve 500"); },
          },
          sendTelegramReply: async (chatId, text) => { tgCalls.push({ chatId, text }); },
          spawn: mockSpawn,
        },
      );

      // Session kept
      expect(storage.sessions.get("sess-deliv-fail")).not.toBeNull();
      // User notified with error
      expect(tgCalls).toHaveLength(1);
      expect(tgCalls[0]!.text).toMatch(/opencode-serve 500|delivery failed/i);
      // Command acked
      expect(storage.inbox.listUnfinished()).toHaveLength(0);
      storage.db.close();
    });

it("acks but does not notify when reviveAndDeliver returns sessionMissing", async () => {
      const storage = openStorageDb(":memory:");
      // Note: NOT inserting a session row, so reviveAndDeliver will return
      // { ok: false, reason: "sessionMissing" } from its first guard.
      // The worker's command-ingest path normally guarantees the session
      // exists by the time we hit this branch, so this is a defensive
      // safety net.

      // To hit the fallback branch, we must trick the top-level lookup
      // into succeeding, but fail inside the fallback.
      storage.sessions.upsert({
        sessionId: "sess-missing",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);

      const tgCalls: Array<{ chatId: string; text: string }> = [];

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-missing", sessionId: "sess-missing", command: "hi", chatId: "13" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              // Delete the session during the async gap so reviveAndDeliver doesn't find it
              storage.sessions.delete("sess-missing");
              return { ok: false, error: "fetch failed: ECONNREFUSED" };
            },
          }),
          opencodeClient: {
            async getSession() { throw new Error("should not be called"); },
            async sendPrompt() { throw new Error("should not be called"); },
          },
          sendTelegramReply: async (chatId, text) => { tgCalls.push({ chatId, text }); },
          spawn: mockSpawn,
        },
      );

      // No Telegram notification (silent defensive no-op)
      expect(tgCalls).toHaveLength(0);
      // Command acked
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("does not attempt revival when opencodeClient is not provided (graceful degradation to old behavior)", async () => {
      // If the daemon is configured without OPENCODE_URL, opencodeClient is
      // undefined. Fall back to the original behavior: delete the dead session.
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-no-client",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-no-client", sessionId: "sess-no-client", command: "hi", chatId: "12" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              return { ok: false, error: "fetch failed: ECONNREFUSED" };
            },
          }),
          // No opencodeClient — simulates daemon without OPENCODE_URL
        },
      );

      // Old behavior preserved: session deleted
      expect(storage.sessions.get("sess-no-client")).toBeNull();
      storage.db.close();
    });
  });

  describe("at-least-once delivery on ambiguous timeout (never drop)", () => {
    const mockSpawn = (() => ({ on: () => {}, unref: () => {} })) as unknown as ReviveAndDeliverDeps["spawn"];

    it("still delivers via revive on a timeout — never drops a message (at-least-once)", async () => {
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-timeout",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);

      const sendPromptCalls: Array<{ sid: string; dir: string; prompt: string }> = [];

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-timeout", sessionId: "sess-timeout", command: "fix the bug", chatId: "7" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              return { ok: false, error: "Request timed out after 15000ms" };
            },
          }),
          opencodeClient: {
            async getSession() { return { id: "sess-timeout", directory: "/tmp/proj" }; },
            async sendPrompt(sid, dir, prompt) { sendPromptCalls.push({ sid, dir, prompt }); },
          },
          spawn: mockSpawn,
        },
      );

      // A timeout is ambiguous: the plugin may not have injected. To guarantee
      // at-least-once delivery we still revive — accepting a possible duplicate
      // over a dropped message. (Exactly-once requires Phase 2 idempotency.)
      expect(sendPromptCalls).toEqual([{ sid: "sess-timeout", dir: "/tmp/proj", prompt: "fix the bug" }]);
      // Command acked (no unfinished inbox entries).
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    // The plugin's onExecute returns { success: false } (HTTP 200) when its own
    // POST to prompt_async times out / aborts internally (opencode-serve busy).
    // The adapter surfaces that as a non-retryable failure carrying the abort
    // message. This must still be treated as ambiguous → revive (never a
    // terminal drop). Regression guard for the Phase 2 review (2026-06-03).
    it.each([
      "The operation timed out",
      "This operation was aborted",
      "prompt_async failed: AbortError",
    ])("revives on an ambiguous plugin-internal failure: %s", async (errorMessage) => {
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-internal",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);

      const sendPromptCalls: Array<{ sid: string; dir: string; prompt: string }> = [];

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-internal", sessionId: "sess-internal", command: "fix the bug", chatId: "8" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              return { ok: false, error: errorMessage };
            },
          }),
          opencodeClient: {
            async getSession() { return { id: "sess-internal", directory: "/tmp/proj" }; },
            async sendPrompt(sid, dir, prompt) { sendPromptCalls.push({ sid, dir, prompt }); },
          },
          spawn: mockSpawn,
        },
      );

      expect(sendPromptCalls).toEqual([{ sid: "sess-internal", dir: "/tmp/proj", prompt: "fix the bug" }]);
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });
  });

  it("does not clean up sessions on business logic errors", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-biz-error",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-biz-error", sessionId: "sess-biz-error", command: "ls", chatId: "6" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() {
            return { ok: false, error: "Command rejected" };
          },
        }),
      },
    );

    // Session should remain in storage
    expect(storage.sessions.get("sess-biz-error")).not.toBeNull();
    storage.db.close();
  });

  describe("metadata fallback for question swipe-replies", () => {
    it("routes text as question reply using metadata fallback when no pending question in storage", async () => {
      const now = Date.now();
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-meta-1",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, now);

      // No pending question stored — metadata fallback should kick in

      let capturedReply: QuestionReplyInput | null = null;

      await ingestWorkerCommand(
        storage,
        makeMsg({
          commandId: "cmd-meta-1",
          sessionId: "sess-meta-1",
          command: "Use PostgreSQL",
          chatId: "1",
          metadata: { questionRequestId: "req-meta-abc" },
        }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() { return { ok: false, error: "should not be called" }; },
            async deliverQuestionReply(_session: unknown, reply: QuestionReplyInput) {
              capturedReply = reply;
              return { ok: true as const };
            },
          }),
        },
      );

      expect(capturedReply).toEqual({
        questionRequestId: "req-meta-abc",
        answers: [["Use PostgreSQL"]],
      });

      // inbox should be marked done
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("prefers pending question over metadata fallback (happy path unchanged)", async () => {
      const now = Date.now();
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-meta-2",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, now);

      // Pending question with a different requestId
      storage.pendingQuestions.store({
        sessionId: "sess-meta-2",
        requestId: "req-pending",
        questions: [{
          question: "Which DB?",
          header: "DB",
          options: [{ label: "PostgreSQL", description: "" }],
        }],
      }, now);

      let capturedReply: QuestionReplyInput | null = null;

      await ingestWorkerCommand(
        storage,
        makeMsg({
          commandId: "cmd-meta-2",
          sessionId: "sess-meta-2",
          command: "Use MongoDB",
          chatId: "1",
          // metadata has a stale requestId — pending question should win
          metadata: { questionRequestId: "req-stale" },
        }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() { return { ok: false, error: "should not be called" }; },
            async deliverQuestionReply(_session: unknown, reply: QuestionReplyInput) {
              capturedReply = reply;
              return { ok: true as const };
            },
          }),
        },
      );

      // Must use pending question's requestId, NOT the metadata's
      expect(capturedReply).not.toBeNull();
      expect(capturedReply!.questionRequestId).toBe("req-pending");
      expect(capturedReply!.answers).toEqual([["Use MongoDB"]]);

      storage.db.close();
    });

    it("delivers as regular command when no pending question and no metadata", async () => {
      const now = Date.now();
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-meta-3",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, now);

      // No pending question, no metadata
      let deliverCommandCalled = false;
      let deliverQuestionReplyCalled = false;

      await ingestWorkerCommand(
        storage,
        makeMsg({
          commandId: "cmd-meta-3",
          sessionId: "sess-meta-3",
          command: "just a regular command",
          chatId: "1",
          // no metadata
        }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              deliverCommandCalled = true;
              return { ok: true as const };
            },
            async deliverQuestionReply() {
              deliverQuestionReplyCalled = true;
              return { ok: true as const };
            },
          }),
        },
      );

      expect(deliverCommandCalled).toBe(true);
      expect(deliverQuestionReplyCalled).toBe(false);

      storage.db.close();
    });

    it("falls through to regular command delivery when metadata fallback question reply fails", async () => {
      const now = Date.now();
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-meta-ff",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, now);

      // No pending question stored
      let deliverCommandCalled = false;

      await ingestWorkerCommand(
        storage,
        makeMsg({
          commandId: "cmd-meta-ff",
          sessionId: "sess-meta-ff",
          command: "some text",
          chatId: "1",
          metadata: { questionRequestId: "req-gone" },
        }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              deliverCommandCalled = true;
              return { ok: true as const };
            },
            async deliverQuestionReply() {
              return { ok: false as const, error: "Question not found" };
            },
          }),
        },
      );

      expect(deliverCommandCalled).toBe(true);
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("does not fall through to regular command delivery when metadata fallback hits a connection error", async () => {
      const now = Date.now();
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-meta-retry",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, now);

      let deliverCommandCalled = false;

      await expect(ingestWorkerCommand(
        storage,
        makeMsg({
          commandId: "cmd-meta-retry",
          sessionId: "sess-meta-retry",
          command: "custom answer",
          chatId: "1",
          metadata: { questionRequestId: "req-meta-retry" },
        }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              deliverCommandCalled = true;
              return { ok: true as const };
            },
            async deliverQuestionReply() {
              return { ok: false as const, error: "fetch failed" };
            },
          }),
        },
      )).rejects.toThrow(/fetch failed/);

      expect(deliverCommandCalled).toBe(false);
      expect(storage.inbox.listUnfinished().map((row) => row.commandId)).toEqual(["cmd-meta-retry"]);

      storage.db.close();
    });
  });

  describe("multi-question wizard routing", () => {
    const twoQuestions = [
      {
        question: "Q1",
        header: "H1",
        options: [
          { label: "A", description: "" },
          { label: "B", description: "" },
        ],
      },
      {
        question: "Q2",
        header: "H2",
        options: [
          { label: "X", description: "" },
          { label: "Y", description: "" },
        ],
      },
    ];

    function makeWizardStorage(sessionId: string) {
      const now = Date.now();
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId,
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, now);
      return { storage, now };
    }

    it("routes v0:q1 to advance wizard from step 0 to step 1", async () => {
      const { storage, now } = makeWizardStorage("sess-wiz-1");

      storage.pendingQuestions.store({
        sessionId: "sess-wiz-1",
        requestId: "req-wiz-1",
        questions: twoQuestions,
        token: "tok-wiz-1",
      }, now);

      const editCalls: Array<{ notificationId: string; text: string; replyMarkup: unknown }> = [];
      let deliverQuestionReplyCalled = false;

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-wiz-1", sessionId: "sess-wiz-1", command: "v0:q1", chatId: "1" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() { return { ok: false, error: "should not be called" }; },
            async deliverQuestionReply() {
              deliverQuestionReplyCalled = true;
              return { ok: true as const };
            },
          }),
          editNotification: async (notificationId, text, replyMarkup) => {
            editCalls.push({ notificationId, text, replyMarkup });
            return { ok: true };
          },
        },
      );

      // Verify wizard advanced: currentStep=1, answers=[["B"]], version=1
      const updated = storage.pendingQuestions.getBySessionId("sess-wiz-1");
      expect(updated).not.toBeNull();
      expect(updated!.currentStep).toBe(1);
      expect(updated!.answers).toEqual([["B"]]);
      expect(updated!.version).toBe(1);

      // editNotification called with "Question 2 of 2" text
      expect(editCalls).toHaveLength(1);
      expect(editCalls[0]!.text).toContain("Question 2 of 2");

      // adapter.deliverQuestionReply NOT called yet
      expect(deliverQuestionReplyCalled).toBe(false);

      // inbox marked done
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("routes v1:q0 on final step to deliver all answers to opencode", async () => {
      const { storage, now } = makeWizardStorage("sess-wiz-2");

      storage.pendingQuestions.store({
        sessionId: "sess-wiz-2",
        requestId: "req-wiz-2",
        questions: twoQuestions,
        token: "tok-wiz-2",
      }, now);

      // Advance to step 1 manually (simulates answering Q1 with "A")
      storage.pendingQuestions.advanceStep("sess-wiz-2", ["A"]);

      const editCalls: Array<{ notificationId: string; text: string; replyMarkup: unknown }> = [];
      let capturedReply: QuestionReplyInput | null = null;

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-wiz-2", sessionId: "sess-wiz-2", command: "v1:q0", chatId: "1" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() { return { ok: false, error: "should not be called" }; },
            async deliverQuestionReply(_session: unknown, reply: QuestionReplyInput) {
              capturedReply = reply;
              return { ok: true as const };
            },
          }),
          editNotification: async (notificationId, text, replyMarkup) => {
            editCalls.push({ notificationId, text, replyMarkup });
            return { ok: true };
          },
        },
      );

      // adapter.deliverQuestionReply called with answers: [["A"], ["X"]]
      expect(capturedReply).not.toBeNull();
      expect(capturedReply!.answers).toEqual([["A"], ["X"]]);
      expect(capturedReply!.questionRequestId).toBe("req-wiz-2");

      // pendingQuestion deleted
      expect(storage.pendingQuestions.getBySessionId("sess-wiz-2")).toBeNull();

      // editNotification called with "All answers submitted" text
      expect(editCalls).toHaveLength(1);
      expect(editCalls[0]!.text).toContain("All answers submitted");

      // inbox marked done
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("ignores stale version (v0 when wizard is at v1)", async () => {
      const { storage, now } = makeWizardStorage("sess-wiz-3");

      storage.pendingQuestions.store({
        sessionId: "sess-wiz-3",
        requestId: "req-wiz-3",
        questions: twoQuestions,
        token: "tok-wiz-3",
      }, now);

      // Advance to step 1 (version=1)
      storage.pendingQuestions.advanceStep("sess-wiz-3", ["A"]);

      let adapterCalled = false;

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-wiz-3", sessionId: "sess-wiz-3", command: "v0:q0", chatId: "1" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() { return { ok: false, error: "should not be called" }; },
            async deliverQuestionReply() {
              adapterCalled = true;
              return { ok: true as const };
            },
          }),
        },
      );

      // pendingQuestion unchanged (still step 1, version 1)
      const unchanged = storage.pendingQuestions.getBySessionId("sess-wiz-3");
      expect(unchanged).not.toBeNull();
      expect(unchanged!.currentStep).toBe(1);
      expect(unchanged!.version).toBe(1);

      // adapter NOT called
      expect(adapterCalled).toBe(false);

      // inbox marked done (acked, not retried)
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("routes custom text reply as answer for current wizard step", async () => {
      const { storage, now } = makeWizardStorage("sess-wiz-4");

      storage.pendingQuestions.store({
        sessionId: "sess-wiz-4",
        requestId: "req-wiz-4",
        questions: twoQuestions,
        token: "tok-wiz-4",
      }, now);

      const editCalls: Array<{ notificationId: string; text: string; replyMarkup: unknown }> = [];

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-wiz-4", sessionId: "sess-wiz-4", command: "Use MongoDB", chatId: "1" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() { return { ok: false, error: "should not be called" }; },
            async deliverQuestionReply() { return { ok: true as const }; },
          }),
          editNotification: async (notificationId, text, replyMarkup) => {
            editCalls.push({ notificationId, text, replyMarkup });
            return { ok: true };
          },
        },
      );

      // wizard advanced: currentStep=1, answers=[["Use MongoDB"]]
      const updated = storage.pendingQuestions.getBySessionId("sess-wiz-4");
      expect(updated).not.toBeNull();
      expect(updated!.currentStep).toBe(1);
      expect(updated!.answers).toEqual([["Use MongoDB"]]);

      // editNotification called
      expect(editCalls).toHaveLength(1);
      expect(editCalls[0]!.text).toContain("Question 2 of 2");

      storage.db.close();
    });

    it("single-question still works with legacy q0 format", async () => {
      const now = Date.now();
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-wiz-legacy",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, now);

      storage.pendingQuestions.store({
        sessionId: "sess-wiz-legacy",
        requestId: "req-wiz-legacy",
        questions: [{
          question: "Q1",
          header: "H1",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        }],
      }, now);

      let capturedReply: QuestionReplyInput | null = null;

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-wiz-legacy", sessionId: "sess-wiz-legacy", command: "q0", chatId: "1" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() { return { ok: false, error: "should not be called" }; },
            async deliverQuestionReply(_session: unknown, reply: QuestionReplyInput) {
              capturedReply = reply;
              return { ok: true as const };
            },
          }),
        },
      );

      // adapter.deliverQuestionReply called with answers: [["A"]]
      expect(capturedReply).not.toBeNull();
      expect(capturedReply!.answers).toEqual([["A"]]);
      expect(capturedReply!.questionRequestId).toBe("req-wiz-legacy");

      // pendingQuestion deleted
      expect(storage.pendingQuestions.getBySessionId("sess-wiz-legacy")).toBeNull();

      storage.db.close();
    });
  });
});
