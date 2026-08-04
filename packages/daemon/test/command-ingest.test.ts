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

    // Marked done: the Poller acks this permanent failure, so leaving the row
    // unfinished would strand it forever (W2 / pigeon-2k1).
    const unfinished = storage.inbox.listUnfinished();
    expect(unfinished).toHaveLength(0);
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

    // Marked done: permanent failure, Poller acks, row must not leak (W2 / pigeon-2k1).
    expect(storage.inbox.listUnfinished()).toHaveLength(0);
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

    // Marked done: permanent failure, Poller acks, row must not leak (W2 / pigeon-2k1).
    expect(storage.inbox.listUnfinished()).toHaveLength(0);
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
      storage.assignments.upsert({ sessionId: "sess-gone", directoryKey: null, desiredServeId: "serve-0", ownerGeneration: 1, state: "dormant", lastPlacedAt: 1_000, updatedAt: 1_000 });

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
      expect(storage.assignments.get("sess-gone")).toBeNull();

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
      storage.assignments.upsert({ sessionId: "sess-no-client", directoryKey: null, desiredServeId: "serve-0", ownerGeneration: 1, state: "dormant", lastPlacedAt: 1_000, updatedAt: 1_000 });

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
      expect(storage.assignments.get("sess-no-client")).toBeNull();
      storage.db.close();
    });

    it("unregisters worker-side when session is gone in opencode-serve (sessionGone)", async () => {
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-gone-unreg",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);
      storage.assignments.upsert({ sessionId: "sess-gone-unreg", directoryKey: null, desiredServeId: "serve-0", ownerGeneration: 1, state: "dormant", lastPlacedAt: 1_000, updatedAt: 1_000 });

      const unregistered: string[] = [];

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-gone-unreg", sessionId: "sess-gone-unreg", command: "hello", chatId: "9" }),
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
          unregisterSession: async (sessionId) => {
            unregistered.push(sessionId);
          },
          spawn: mockSpawn,
        },
      );

      // Verify unregistered worker-side
      expect(unregistered).toEqual(["sess-gone-unreg"]);
      // Verify local row and assignment deleted
      expect(storage.sessions.get("sess-gone-unreg")).toBeNull();
      expect(storage.assignments.get("sess-gone-unreg")).toBeNull();
      // Command acked
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("handles unregisterSession rejection gracefully on sessionGone (best-effort)", async () => {
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-gone-reject",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);
      storage.assignments.upsert({ sessionId: "sess-gone-reject", directoryKey: null, desiredServeId: "serve-0", ownerGeneration: 1, state: "dormant", lastPlacedAt: 1_000, updatedAt: 1_000 });

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-gone-reject", sessionId: "sess-gone-reject", command: "hello", chatId: "9" }),
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
          unregisterSession: async () => {
            throw new Error("Worker network error");
          },
          spawn: mockSpawn,
        },
      );

      // Verify local row and assignment still deleted despite worker unregister error
      expect(storage.sessions.get("sess-gone-reject")).toBeNull();
      expect(storage.assignments.get("sess-gone-reject")).toBeNull();
      // Command still acked
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("unregisters worker-side when removing dead session (no opencodeClient fallback)", async () => {
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-no-client-unreg",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);
      storage.assignments.upsert({ sessionId: "sess-no-client-unreg", directoryKey: null, desiredServeId: "serve-0", ownerGeneration: 1, state: "dormant", lastPlacedAt: 1_000, updatedAt: 1_000 });

      const unregistered: string[] = [];

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-no-client-unreg", sessionId: "sess-no-client-unreg", command: "hi", chatId: "12" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              return { ok: false, error: "fetch failed: ECONNREFUSED" };
            },
          }),
          unregisterSession: async (sessionId) => {
            unregistered.push(sessionId);
          },
        },
      );

      // Verify unregistered worker-side
      expect(unregistered).toEqual(["sess-no-client-unreg"]);
      // Local row and assignment deleted
      expect(storage.sessions.get("sess-no-client-unreg")).toBeNull();
      expect(storage.assignments.get("sess-no-client-unreg")).toBeNull();

      storage.db.close();
    });

    it("handles unregisterSession rejection gracefully on no opencodeClient fallback (best-effort)", async () => {
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-no-client-reject",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);
      storage.assignments.upsert({ sessionId: "sess-no-client-reject", directoryKey: null, desiredServeId: "serve-0", ownerGeneration: 1, state: "dormant", lastPlacedAt: 1_000, updatedAt: 1_000 });

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-no-client-reject", sessionId: "sess-no-client-reject", command: "hi", chatId: "12" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              return { ok: false, error: "fetch failed: ECONNREFUSED" };
            },
          }),
          unregisterSession: async () => {
            throw new Error("Worker network error");
          },
        },
      );

      // Verify local row and assignment still deleted
      expect(storage.sessions.get("sess-no-client-reject")).toBeNull();
      expect(storage.assignments.get("sess-no-client-reject")).toBeNull();

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
          // Budget 0 = no plugin retries: exercise the "budget exhausted → revive"
          // last-resort path directly (the retry path is covered separately below).
          deliveryBudgetMs: 0,
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
          deliveryBudgetMs: 0,
        },
      );

      expect(sendPromptCalls).toEqual([{ sid: "sess-internal", dir: "/tmp/proj", prompt: "fix the bug" }]);
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("retries an ambiguous failure through the plugin within budget, then succeeds (no revive)", async () => {
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-retry-ok",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);

      const sendPromptCalls: Array<{ sid: string; dir: string; prompt: string }> = [];
      let calls = 0;

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-retry-ok", sessionId: "sess-retry-ok", command: "fix the bug", chatId: "7" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              calls++;
              // Busy first (ambiguous timeout), then the plugin frees up and the
              // idempotent retry returns success.
              if (calls === 1) return { ok: false, error: "Request timed out after 15000ms" };
              return { ok: true };
            },
          }),
          opencodeClient: {
            async getSession() { return { id: "sess-retry-ok", directory: "/tmp/proj" }; },
            async sendPrompt(sid, dir, prompt) { sendPromptCalls.push({ sid, dir, prompt }); },
          },
          spawn: mockSpawn,
          deliveryBudgetMs: 40_000,
          sleep: async () => {},
        },
      );

      // Retried through the plugin and succeeded — no revive (no duplicate).
      expect(calls).toBe(2);
      expect(sendPromptCalls).toHaveLength(0);
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("retries within budget then revives when the plugin stays busy (never drops)", async () => {
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-retry-revive",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, 1_000);

      const sendPromptCalls: Array<{ sid: string; dir: string; prompt: string }> = [];
      let calls = 0;
      // Deterministic clock: each read advances 30ms; with a 100ms budget the
      // loop runs a couple of retries before the budget is exhausted.
      let clock = 0;
      const now = () => { clock += 30; return clock; };

      await ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-retry-revive", sessionId: "sess-retry-revive", command: "fix the bug", chatId: "7" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() {
              calls++;
              return { ok: false, error: "Request timed out after 15000ms" };
            },
          }),
          opencodeClient: {
            async getSession() { return { id: "sess-retry-revive", directory: "/tmp/proj" }; },
            async sendPrompt(sid, dir, prompt) { sendPromptCalls.push({ sid, dir, prompt }); },
          },
          spawn: mockSpawn,
          deliveryBudgetMs: 100,
          now,
          sleep: async () => {},
        },
      );

      // Retried through the plugin more than once, then revived as a last resort.
      expect(calls).toBeGreaterThan(1);
      expect(sendPromptCalls).toEqual([{ sid: "sess-retry-revive", dir: "/tmp/proj", prompt: "fix the bug" }]);
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

    it("rejects answer when live pending question exists but metadata requestId is mismatched (pigeon-wzk)", async () => {
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
      let sentTelegramText: string | null = null;

      await ingestWorkerCommand(
        storage,
        makeMsg({
          commandId: "cmd-meta-2",
          sessionId: "sess-meta-2",
          command: "Use MongoDB",
          chatId: "1",
          // metadata has a mismatched requestId — question was superseded
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
          sendTelegramReply: async (_chatId, text) => {
            sentTelegramText = text;
          },
        },
      );

      // Must NOT deliver question reply to the live row
      expect(capturedReply).toBeNull();
      // Must drop command and reply to user explaining question was superseded and echoing text
      expect(sentTelegramText).not.toBeNull();
      expect(sentTelegramText!).toContain("replaced by a newer one");
      // Typed text is echoed back so the user does not have to retype it.
      expect(sentTelegramText!).toContain("Use MongoDB");
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("does not echo the raw option token when a superseded answer was a button press", async () => {
      const now = Date.now();
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-meta-2b",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, now);

      storage.pendingQuestions.store({
        sessionId: "sess-meta-2b",
        requestId: "req-pending",
        questions: [{
          question: "Which DB?",
          header: "DB",
          options: [{ label: "PostgreSQL", description: "" }],
        }],
      }, now);

      let capturedReply: QuestionReplyInput | null = null;
      let sentTelegramText: string | null = null;

      await ingestWorkerCommand(
        storage,
        makeMsg({
          commandId: "cmd-meta-2b",
          sessionId: "sess-meta-2b",
          command: "q0",
          chatId: "1",
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
          sendTelegramReply: async (_chatId, text) => {
            sentTelegramText = text;
          },
        },
      );

      expect(capturedReply).toBeNull();
      expect(sentTelegramText).not.toBeNull();
      expect(sentTelegramText!).toContain("replaced by a newer one");
      // The user pressed a button; "q0" is an internal wire token they never
      // typed, so quoting it back would be gibberish.
      expect(sentTelegramText!).not.toContain("q0");
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("resurrects an expired question when metadata questionRequestId matches", async () => {
      const now = Date.now();
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-res-1",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, now);

      // Store a question that expired 5 hours ago
      storage.pendingQuestions.store({
        sessionId: "sess-res-1",
        requestId: "req-exp-1",
        questions: [{
          question: "Pick database",
          header: "DB",
          options: [
            { label: "PostgreSQL", description: "" },
            { label: "SQLite", description: "" },
          ],
        }],
      }, now - 5 * 3600 * 1000);

      let capturedReply: QuestionReplyInput | null = null;

      await ingestWorkerCommand(
        storage,
        makeMsg({
          commandId: "cmd-res-1",
          sessionId: "sess-res-1",
          command: "q1",
          chatId: "1",
          metadata: { questionRequestId: "req-exp-1" },
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
        questionRequestId: "req-exp-1",
        answers: [["SQLite"]],
      });
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("deletes a resurrected row when opencode says the question is gone, so later replies are not trapped", async () => {
      const now = Date.now();
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-res-gone",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, now);

      storage.pendingQuestions.store({
        sessionId: "sess-res-gone",
        requestId: "req-gone-1",
        questions: [{
          question: "Pick database",
          header: "DB",
          options: [{ label: "PostgreSQL", description: "" }],
        }],
      }, now - 5 * 3600 * 1000);

      let sentTelegramText: string | null = null;

      // opencode no longer knows this question: a terminal (non-transient) failure.
      await ingestWorkerCommand(
        storage,
        makeMsg({
          commandId: "cmd-res-gone",
          sessionId: "sess-res-gone",
          command: "q0",
          chatId: "1",
          metadata: { questionRequestId: "req-gone-1" },
        }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() { return { ok: false, error: "should not be called" }; },
            async deliverQuestionReply() {
              return { ok: false as const, error: "OpenCode question reply failed: 404 question not found" };
            },
          }),
          sendTelegramReply: async (_chatId, text) => {
            sentTelegramText = text;
          },
        },
      );

      // The row must be gone. Keeping it would re-resurrect on every retry —
      // resurrection ignores expires_at, so the row would never age out — and
      // trap every future swipe-reply to this card against a dead question.
      expect(storage.pendingQuestions.getBySessionIdIncludingExpired("sess-res-gone")).toBeNull();
      expect(sentTelegramText).not.toBeNull();
      // Must not repeat the live-row advice, which cannot work here.
      expect(sentTelegramText!).not.toContain("Tap the option again, or reply with text, to retry");
      expect(sentTelegramText!).toContain("no longer open");
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("keeps a LIVE row on terminal failure so the on-screen keyboard stays retryable", async () => {
      const now = Date.now();
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-live-keep",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, now);

      storage.pendingQuestions.store({
        sessionId: "sess-live-keep",
        requestId: "req-live-keep",
        questions: [{
          question: "Pick database",
          header: "DB",
          options: [{ label: "PostgreSQL", description: "" }],
        }],
      }, now);

      let sentTelegramText: string | null = null;

      await ingestWorkerCommand(
        storage,
        makeMsg({
          commandId: "cmd-live-keep",
          sessionId: "sess-live-keep",
          command: "q0",
          chatId: "1",
        }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() { return { ok: false, error: "should not be called" }; },
            async deliverQuestionReply() {
              return { ok: false as const, error: "OpenCode question reply failed: 500 boom" };
            },
          }),
          sendTelegramReply: async (_chatId, text) => {
            sentTelegramText = text;
          },
        },
      );

      // Unchanged pre-existing behavior: the row survives so a second tap retries.
      expect(storage.pendingQuestions.getBySessionId("sess-live-keep")).not.toBeNull();
      expect(sentTelegramText!).toContain("Tap the option again");

      storage.db.close();
    });

    it("advances a resurrected wizard mid-step rather than soft-locking", async () => {
      const now = Date.now();
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-res-wiz",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, now);

      // Store expired wizard at step 0
      storage.pendingQuestions.store({
        sessionId: "sess-res-wiz",
        requestId: "req-exp-wiz",
        questions: [
          { question: "Q1?", header: "H1", options: [{ label: "Opt1A", description: "" }, { label: "Opt1B", description: "" }] },
          { question: "Q2?", header: "H2", options: [{ label: "Opt2A", description: "" }] },
        ],
      }, now - 5 * 3600 * 1000);

      let deliverQuestionReplyCalled = false;

      await ingestWorkerCommand(
        storage,
        makeMsg({
          commandId: "cmd-res-wiz",
          sessionId: "sess-res-wiz",
          command: "v0:q1",
          chatId: "1",
          metadata: { questionRequestId: "req-exp-wiz" },
        }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() { return { ok: false, error: "should not be called" }; },
            async deliverQuestionReply() {
              deliverQuestionReplyCalled = true;
              return { ok: true as const };
            },
          }),
        },
      );

      // Final deliverQuestionReply not called yet because wizard is at step 1 now
      expect(deliverQuestionReplyCalled).toBe(false);

      // Verify row in storage advanced to step 1
      const updated = storage.pendingQuestions.getBySessionIdIncludingExpired("sess-res-wiz");
      expect(updated).not.toBeNull();
      expect(updated!.currentStep).toBe(1);
      expect(updated!.answers).toEqual([["Opt1B"]]);
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("does not resurrect expired row if metadata requestId is mismatched and drops command", async () => {
      const now = Date.now();
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-res-mismatch",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, now);

      // Store expired row with req-old
      storage.pendingQuestions.store({
        sessionId: "sess-res-mismatch",
        requestId: "req-old",
        questions: [{ question: "Old?", header: "H", options: [{ label: "A", description: "" }] }],
      }, now - 5 * 3600 * 1000);

      let deliverQuestionReplyCalled = false;
      let sentTelegramText: string | null = null;

      await ingestWorkerCommand(
        storage,
        makeMsg({
          commandId: "cmd-res-mismatch",
          sessionId: "sess-res-mismatch",
          command: "q0",
          chatId: "1",
          metadata: { questionRequestId: "req-different" },
        }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() { return { ok: false, error: "should not be called" }; },
            async deliverQuestionReply() {
              deliverQuestionReplyCalled = true;
              return { ok: true as const };
            },
          }),
          sendTelegramReply: async (_chatId, text) => {
            sentTelegramText = text;
          },
        },
      );

      expect(deliverQuestionReplyCalled).toBe(false);
      expect(sentTelegramText).not.toBeNull();
      expect(sentTelegramText!).toContain("no longer answerable");
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

      storage.db.close();
    });

    it("drops double button press (no pending question row) before metadata fallback and never injects raw token", async () => {
      const now = Date.now();
      const storage = openStorageDb(":memory:");
      storage.sessions.upsert({
        sessionId: "sess-double-press",
        notify: true,
        backendKind: "opencode-plugin-direct",
        backendProtocolVersion: 1,
        backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        backendAuthToken: "tok",
      }, now);

      // No pending question in storage (deleted after first successful press)
      let deliverCommandCalled = false;
      let deliverQuestionReplyCalled = false;
      let sentTelegramText: string | null = null;

      await ingestWorkerCommand(
        storage,
        makeMsg({
          commandId: "cmd-double-press",
          sessionId: "sess-double-press",
          command: "q0",
          chatId: "1",
          metadata: { questionRequestId: "req-already-deleted" },
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
          sendTelegramReply: async (_chatId, text) => {
            sentTelegramText = text;
          },
        },
      );

      expect(deliverQuestionReplyCalled).toBe(false);
      expect(deliverCommandCalled).toBe(false);
      expect(sentTelegramText).not.toBeNull();
      expect(sentTelegramText!).toContain("no longer answerable");
      expect(storage.inbox.listUnfinished()).toHaveLength(0);

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
      const wiz2Record = storage.pendingQuestions.getBySessionId("sess-wiz-2")!;
      storage.pendingQuestions.advanceStep(wiz2Record, ["A"]);

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
      const wiz3Record = storage.pendingQuestions.getBySessionId("sess-wiz-3")!;
      storage.pendingQuestions.advanceStep(wiz3Record, ["A"]);

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

/**
 * W2 (pigeon-2k1): the inbound command path used to drop messages silently.
 *
 * Four sites returned bare, which makes the Poller ack the command: the user was
 * told nothing and the local inbox row was never marked done. The revive branches
 * already replied + marked done, so these were the inconsistent minority.
 *
 * Each test below asserts BOTH halves (a reply AND markDone), because either one
 * alone still loses information.
 */
describe("ingestWorkerCommand — silent drop sites (W2)", () => {
  const liveSession = (storage: ReturnType<typeof openStorageDb>, sessionId: string) =>
    storage.sessions.upsert({
      sessionId,
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);

  it("replies and marks done when the plugin terminally rejects the command", async () => {
    const storage = openStorageDb(":memory:");
    liveSession(storage, "sess-reject");
    const tgCalls: Array<{ chatId: string; text: string }> = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-reject", sessionId: "sess-reject", command: "hi", chatId: "42" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() {
            return { ok: false, error: "INVALID_PAYLOAD" };
          },
        }),
        sendTelegramReply: async (chatId, text) => { tgCalls.push({ chatId, text }); },
      },
    );

    expect(tgCalls).toHaveLength(1);
    expect(tgCalls[0]!.chatId).toBe("42");
    // Minimum-scope wording: surface the machine-readable reject reason verbatim.
    expect(tgCalls[0]!.text).toContain("INVALID_PAYLOAD");
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("still replies and marks done when a terminal rejection carries no error string", async () => {
    // classifyDeliveryFailure(undefined) === "terminal", so this path is reachable
    // and must not produce an "undefined" reply or a leaked row.
    const storage = openStorageDb(":memory:");
    liveSession(storage, "sess-noerr");
    const tgCalls: Array<{ chatId: string; text: string }> = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-noerr", sessionId: "sess-noerr", command: "hi", chatId: "43" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() {
            return { ok: false };
          },
        }),
        sendTelegramReply: async (chatId, text) => { tgCalls.push({ chatId, text }); },
      },
    );

    expect(tgCalls).toHaveLength(1);
    expect(tgCalls[0]!.text).not.toContain("undefined");
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("replies and marks done when the session is not in local storage", async () => {
    // The user-visible case: replying to a notification whose session the daemon
    // has since reaped. Was silent, despite the revive path (:508) replying for
    // the very same "session is gone" condition.
    const storage = openStorageDb(":memory:");
    const tgCalls: Array<{ chatId: string; text: string }> = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-nosess", sessionId: "sess-absent", command: "hi", chatId: "44" }),
      { sendTelegramReply: async (chatId, text) => { tgCalls.push({ chatId, text }); } },
    );

    expect(tgCalls).toHaveLength(1);
    expect(tgCalls[0]!.chatId).toBe("44");
    expect(tgCalls[0]!.text).toMatch(/session/i);
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("replies and marks done when the session has no usable adapter", async () => {
    // Incomplete registration: backendKind set, endpoint/token missing.
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-noadapter",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
    }, 1_000);
    const tgCalls: Array<{ chatId: string; text: string }> = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-noadapter", sessionId: "sess-noadapter", command: "hi", chatId: "45" }),
      { sendTelegramReply: async (chatId, text) => { tgCalls.push({ chatId, text }); } },
    );

    expect(tgCalls).toHaveLength(1);
    expect(tgCalls[0]!.chatId).toBe("45");
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("replies and marks done when a dead session is removed with no opencodeClient", async () => {
    const storage = openStorageDb(":memory:");
    liveSession(storage, "sess-dead");
    const tgCalls: Array<{ chatId: string; text: string }> = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-dead", sessionId: "sess-dead", command: "hi", chatId: "46" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() {
            return { ok: false, error: "fetch failed: ECONNREFUSED" };
          },
        }),
        // no opencodeClient -> legacy "delete dead session" branch
        sendTelegramReply: async (chatId, text) => { tgCalls.push({ chatId, text }); },
      },
    );

    expect(storage.sessions.get("sess-dead")).toBeNull();
    expect(tgCalls).toHaveLength(1);
    expect(tgCalls[0]!.chatId).toBe("46");
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("does not throw when no sendTelegramReply is wired", async () => {
    // sendTelegramReply is optional; the drop path must stay best-effort.
    const storage = openStorageDb(":memory:");
    liveSession(storage, "sess-noreply");

    await expect(
      ingestWorkerCommand(
        storage,
        makeMsg({ commandId: "cmd-noreply", sessionId: "sess-noreply", command: "hi", chatId: "47" }),
        {
          createAdapter: () => ({
            name: "mock-direct",
            async deliverCommand() { return { ok: false, error: "INVALID_PAYLOAD" }; },
          }),
        },
      ),
    ).resolves.toBeUndefined();

    expect(storage.inbox.listUnfinished()).toHaveLength(0);
    storage.db.close();
  });
});

describe("ingestWorkerCommand — question-reply path silent drops (W2b)", () => {
  const twoQuestions = [
    { question: "Q1", header: "H1", options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
    { question: "Q2", header: "H2", options: [{ label: "X", description: "" }, { label: "Y", description: "" }] },
  ];

  function questionSession(sessionId: string) {
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

  // ── Terminal delivery failure: notify, but PRESERVE the row ──────────────
  // The row is deliberately kept. See the retry-ability test below for why.

  it("replies and keeps the wizard retryable when final-step delivery terminally fails", async () => {
    const { storage, now } = questionSession("sess-w2b-wizfail");
    storage.pendingQuestions.store({
      sessionId: "sess-w2b-wizfail", requestId: "req-1", questions: twoQuestions, token: "tok-1",
    }, now);
    const wizFailRecord = storage.pendingQuestions.getBySessionId("sess-w2b-wizfail")!;
    storage.pendingQuestions.advanceStep(wizFailRecord, ["A"]);

    const tgCalls: Array<{ chatId: string; text: string }> = [];
    const editCalls: unknown[] = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w2b-1", sessionId: "sess-w2b-wizfail", command: "v1:q0", chatId: "70" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: false, error: "should not be called" }; },
          async deliverQuestionReply() { return { ok: false as const, error: "QUESTION_NOT_FOUND" }; },
        }),
        editNotification: async (...args: unknown[]) => { editCalls.push(args); return { ok: true }; },
        sendTelegramReply: async (chatId, text) => { tgCalls.push({ chatId, text }); },
      },
    );

    expect(tgCalls).toHaveLength(1);
    expect(tgCalls[0]!.chatId).toBe("70");
    expect(tgCalls[0]!.text).toContain("QUESTION_NOT_FOUND");
    // Row preserved with its accumulated answers, so the user can retry.
    const row = storage.pendingQuestions.getBySessionId("sess-w2b-wizfail");
    expect(row).not.toBeNull();
    expect(row!.answers).toEqual([["A"]]);
    // The keyboard is still live and correct, so we must NOT edit it away.
    expect(editCalls).toHaveLength(0);
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("still accepts the same button press after a final-step failure (retry works)", async () => {
    // This is the evidence for preserving the row. The final step never calls
    // advanceStep (it builds allAnswers locally), so `version` is unchanged by a
    // failure and the displayed buttons still pass the stale-version guard.
    // Deleting the row would destroy this working retry path.
    const { storage, now } = questionSession("sess-w2b-retry");
    storage.pendingQuestions.store({
      sessionId: "sess-w2b-retry", requestId: "req-2", questions: twoQuestions, token: "tok-2",
    }, now);
    const wizRetryRecord = storage.pendingQuestions.getBySessionId("sess-w2b-retry")!;
    storage.pendingQuestions.advanceStep(wizRetryRecord, ["A"]);

    const delivered: string[][][] = [];
    let failFirst = true;
    const opts = () => ({
      createAdapter: () => ({
        name: "mock-direct",
        async deliverCommand() { return { ok: false, error: "should not be called" }; },
        async deliverQuestionReply(_s: unknown, input: QuestionReplyInput) {
          if (failFirst) { failFirst = false; return { ok: false as const, error: "TRANSIENT_LOOKING_TERMINAL" }; }
          delivered.push(input.answers);
          return { ok: true as const };
        },
      }),
      editNotification: async () => ({ ok: true }),
      sendTelegramReply: async () => {},
    });

    // First press fails terminally.
    await ingestWorkerCommand(storage, makeMsg({ commandId: "cmd-w2b-2a", sessionId: "sess-w2b-retry", command: "v1:q0", chatId: "71" }), opts());
    expect(delivered).toHaveLength(0);

    // Second press of the SAME button (same version) is accepted and delivers.
    await ingestWorkerCommand(storage, makeMsg({ commandId: "cmd-w2b-2b", sessionId: "sess-w2b-retry", command: "v1:q0", chatId: "71" }), opts());
    expect(delivered).toEqual([[["A"], ["X"]]]);

    storage.db.close();
  });

  it("replies and keeps the row retryable when single-question delivery terminally fails", async () => {
    const { storage, now } = questionSession("sess-w2b-single");
    storage.pendingQuestions.store({
      sessionId: "sess-w2b-single", requestId: "req-3", questions: [twoQuestions[0]!], token: "tok-3",
    }, now);

    const tgCalls: Array<{ chatId: string; text: string }> = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w2b-3", sessionId: "sess-w2b-single", command: "my typed answer", chatId: "72" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: false, error: "should not be called" }; },
          async deliverQuestionReply() { return { ok: false as const, error: "QUESTION_NOT_FOUND" }; },
        }),
        sendTelegramReply: async (chatId, text) => { tgCalls.push({ chatId, text }); },
      },
    );

    expect(tgCalls).toHaveLength(1);
    expect(tgCalls[0]!.text).toContain("QUESTION_NOT_FOUND");
    expect(storage.pendingQuestions.getBySessionId("sess-w2b-single")).not.toBeNull();
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  // ── Adapter cannot take question replies: notify AND DELETE the row ──────
  // Asymmetric with the above on purpose. The condition is permanent for this
  // session, and while the row exists it hijacks every plain-text message into
  // the question path, so preserving it would loop the failure until TTL.

  it("replies and deletes the row when the adapter cannot take a wizard reply", async () => {
    const { storage, now } = questionSession("sess-w2b-wiznoadapter");
    storage.pendingQuestions.store({
      sessionId: "sess-w2b-wiznoadapter", requestId: "req-4", questions: twoQuestions, token: "tok-4",
    }, now);
    const wizNoAdapterRecord = storage.pendingQuestions.getBySessionId("sess-w2b-wiznoadapter")!;
    storage.pendingQuestions.advanceStep(wizNoAdapterRecord, ["A"]);

    const tgCalls: Array<{ chatId: string; text: string }> = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w2b-4", sessionId: "sess-w2b-wiznoadapter", command: "v1:q0", chatId: "73" }),
      {
        createAdapter: () => ({
          name: "mock-no-qr",
          async deliverCommand() { return { ok: true as const }; },
        }),
        sendTelegramReply: async (chatId, text) => { tgCalls.push({ chatId, text }); },
      },
    );

    expect(tgCalls).toHaveLength(1);
    expect(tgCalls[0]!.chatId).toBe("73");
    expect(storage.pendingQuestions.getBySessionId("sess-w2b-wiznoadapter")).toBeNull();
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("replies and deletes the row when the adapter cannot take a single-question reply", async () => {
    const { storage, now } = questionSession("sess-w2b-singlenoadapter");
    storage.pendingQuestions.store({
      sessionId: "sess-w2b-singlenoadapter", requestId: "req-5", questions: [twoQuestions[0]!], token: "tok-5",
    }, now);

    const tgCalls: Array<{ chatId: string; text: string }> = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w2b-5", sessionId: "sess-w2b-singlenoadapter", command: "typed", chatId: "74" }),
      {
        createAdapter: () => ({
          name: "mock-no-qr",
          async deliverCommand() { return { ok: true as const }; },
        }),
        sendTelegramReply: async (chatId, text) => { tgCalls.push({ chatId, text }); },
      },
    );

    expect(tgCalls).toHaveLength(1);
    expect(storage.pendingQuestions.getBySessionId("sess-w2b-singlenoadapter")).toBeNull();
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("clears the keyboard when it deletes an un-answerable question", async () => {
    // Deleting the row without editing the message leaves live-looking buttons
    // that now resolve to nothing: the next tap finds no row, matches the
    // question-option shape, and is silently acked by the stale-option branch.
    // Note this is the opposite call from the terminal-failure sites above,
    // where the keyboard is still valid and must be left alone.
    const { storage, now } = questionSession("sess-w2b-keyboard");
    storage.pendingQuestions.store({
      sessionId: "sess-w2b-keyboard", requestId: "req-kb", questions: [twoQuestions[0]!], token: "tok-kb",
    }, now);

    const editCalls: Array<{ notificationId: string; text: string; replyMarkup: unknown }> = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w2b-kb", sessionId: "sess-w2b-keyboard", command: "typed", chatId: "77" }),
      {
        createAdapter: () => ({
          name: "mock-no-qr",
          async deliverCommand() { return { ok: true as const }; },
        }),
        editNotification: async (notificationId, text, replyMarkup) => {
          editCalls.push({ notificationId, text, replyMarkup });
          return { ok: true };
        },
        sendTelegramReply: async () => {},
      },
    );

    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]!.notificationId).toBe("q:sess-w2b-keyboard:req-kb");
    expect(editCalls[0]!.replyMarkup).toEqual({ inline_keyboard: [] });

    storage.db.close();
  });

  it("stops hijacking plain text once the un-answerable row is deleted", async () => {
    // The point of deleting: the next message reaches the session as a normal
    // prompt instead of looping the same undeliverable question reply.
    const { storage, now } = questionSession("sess-w2b-unhijack");
    storage.pendingQuestions.store({
      sessionId: "sess-w2b-unhijack", requestId: "req-6", questions: [twoQuestions[0]!], token: "tok-6",
    }, now);

    const deliveredCommands: string[] = [];
    const opts = () => ({
      createAdapter: () => ({
        name: "mock-no-qr",
        async deliverCommand(_s: unknown, text: string) { deliveredCommands.push(text); return { ok: true as const }; },
      }),
      sendTelegramReply: async () => {},
    });

    await ingestWorkerCommand(storage, makeMsg({ commandId: "cmd-w2b-6a", sessionId: "sess-w2b-unhijack", command: "first", chatId: "75" }), opts());
    expect(deliveredCommands).toEqual([]);

    await ingestWorkerCommand(storage, makeMsg({ commandId: "cmd-w2b-6b", sessionId: "sess-w2b-unhijack", command: "second", chatId: "75" }), opts());
    expect(deliveredCommands).toEqual(["second"]);

    storage.db.close();
  });

  it("does not throw when no sendTelegramReply is wired on the question path", async () => {
    const { storage, now } = questionSession("sess-w2b-nosender");
    storage.pendingQuestions.store({
      sessionId: "sess-w2b-nosender", requestId: "req-7", questions: [twoQuestions[0]!], token: "tok-7",
    }, now);

    await expect(ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w2b-7", sessionId: "sess-w2b-nosender", command: "typed", chatId: "76" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: false, error: "should not be called" }; },
          async deliverQuestionReply() { return { ok: false as const, error: "QUESTION_NOT_FOUND" }; },
        }),
      },
    )).resolves.toBeUndefined();

    expect(storage.inbox.listUnfinished()).toHaveLength(0);
    storage.db.close();
  });
});

describe("ingestWorkerCommand — revive branches guard their Telegram send (W2b part B)", () => {
  // These three branches predate dropCommand and hand-rolled it with an
  // UNGUARDED `await options.sendTelegramReply?.(...)`. That is latent rather
  // than live today only because the production sender (index.ts) catches
  // internally and never throws. If it ever did, serveUnreachable would be an
  // infinite retry loop: it does NOT delete the session, so the command would
  // come back every poll, gated only on Telegram continuing to fail.
  const mockSpawn = (() => ({ on: () => {}, unref: () => {} })) as unknown as ReviveAndDeliverDeps["spawn"];

  function deadSession(sessionId: string) {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId,
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);
    return storage;
  }

  const throwingSender = async () => { throw new Error("telegram is down"); };
  const connError = () => ({
    name: "mock-direct",
    async deliverCommand() { return { ok: false, error: "fetch failed: ECONNREFUSED" }; },
  });

  it("acks despite a throwing sender when opencode-serve is unreachable", async () => {
    const storage = deadSession("sess-b-unreach");

    await expect(ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-b-1", sessionId: "sess-b-unreach", command: "hi", chatId: "80" }),
      {
        createAdapter: connError,
        opencodeClient: {
          async getSession() { throw new Error("fetch failed: ECONNREFUSED"); },
          async sendPrompt() {},
        },
        spawn: mockSpawn,
        sendTelegramReply: throwingSender,
      },
    )).resolves.toBeUndefined();

    // The session is deliberately kept on this branch, which is exactly why an
    // escaping throw here would retry forever.
    expect(storage.sessions.get("sess-b-unreach")).not.toBeNull();
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("acks despite a throwing sender when the session is gone in opencode-serve", async () => {
    const storage = deadSession("sess-b-gone");

    await expect(ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-b-2", sessionId: "sess-b-gone", command: "hi", chatId: "81" }),
      {
        createAdapter: connError,
        opencodeClient: {
          async getSession() { return null; },
          async sendPrompt() {},
        },
        spawn: mockSpawn,
        sendTelegramReply: throwingSender,
      },
    )).resolves.toBeUndefined();

    expect(storage.sessions.get("sess-b-gone")).toBeNull();
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("acks despite a throwing sender when revival delivery fails", async () => {
    const storage = deadSession("sess-b-delivfail");

    await expect(ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-b-3", sessionId: "sess-b-delivfail", command: "hi", chatId: "82" }),
      {
        createAdapter: connError,
        opencodeClient: {
          async getSession() { return { id: "sess-b-delivfail", directory: "/tmp/proj" }; },
          async sendPrompt() { throw new Error("prompt exploded"); },
        },
        spawn: mockSpawn,
        sendTelegramReply: throwingSender,
      },
    )).resolves.toBeUndefined();

    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });
});

describe("ingestWorkerCommand — wizard edit-failure soft-lock (W2c)", () => {
  const twoQuestions = [
    {
      question: "Which database?",
      header: "H1",
      options: [
        { label: "Postgres", description: "relational" },
        { label: "MongoDB", description: "" },
      ],
    },
    {
      question: "Which region?",
      header: "H2",
      options: [
        { label: "us-east-1", description: "Virginia" },
        { label: "eu-west-1", description: "" },
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
    storage.pendingQuestions.store({
      sessionId,
      requestId: `req-${sessionId}`,
      questions: twoQuestions,
      token: `tok-${sessionId}`,
    }, now);
    return storage;
  }

  const adapter = () => ({
    name: "mock-direct",
    async deliverCommand() { return { ok: false as const, error: "should not be called" }; },
    async deliverQuestionReply() { return { ok: true as const }; },
  });

  it("tells the user the buttons are dead when the step edit reports failure", async () => {
    const storage = makeWizardStorage("sess-w2c-1");
    const replies: Array<{ chatId: string; text: string }> = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w2c-1", sessionId: "sess-w2c-1", command: "v0:q1", chatId: "77" }),
      {
        createAdapter: adapter,
        editNotification: async () => ({ ok: false }),
        sendTelegramReply: async (chatId, text) => { replies.push({ chatId, text }); },
      },
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]!.chatId).toBe("77");
    // Names the question storage is actually waiting on (step 2), not the stale one.
    expect(replies[0]!.text).toContain("Which region?");
    expect(replies[0]!.text).toContain("Question 2 of 2");
    // Lists the options as text, since typed answers are stored verbatim.
    expect(replies[0]!.text).toContain("us-east-1");
    expect(replies[0]!.text).toContain("eu-west-1");
    // Warns the on-screen buttons no longer work.
    expect(replies[0]!.text.toLowerCase()).toContain("button");

    storage.db.close();
  });

  it("treats a worker error body with no ok field as a failure", async () => {
    const storage = makeWizardStorage("sess-w2c-8");
    const replies: string[] = [];

    // The real failure shape. poller.editNotification returns the worker's JSON
    // verbatim regardless of status, and every worker failure path answers
    // {error:...} with NO ok field — a 404 for a swept messages row being the
    // most persistent. A laxer check like `ok !== false` would read undefined
    // as success and restore the soft-lock for exactly this case.
    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w2c-8", sessionId: "sess-w2c-8", command: "v0:q1", chatId: "1" }),
      {
        createAdapter: adapter,
        editNotification: async () => ({ error: "Message not found for notificationId" }) as never,
        sendTelegramReply: async (_c, text) => { replies.push(text); },
      },
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]!).toContain("Which region?");

    storage.db.close();
  });

  it("stays silent on completion when no editNotification is wired", async () => {
    const storage = makeWizardStorage("sess-w2c-9");
    const rec9 = storage.pendingQuestions.getBySessionId("sess-w2c-9")!;
    storage.pendingQuestions.advanceStep(rec9, ["Postgres"]);
    const replies: string[] = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w2c-9", sessionId: "sess-w2c-9", command: "v1:q0", chatId: "1" }),
      {
        createAdapter: adapter,
        sendTelegramReply: async (_c, text) => { replies.push(text); },
      },
    );

    expect(replies).toEqual([]);
    storage.db.close();
  });

  it("keeps storage authoritative after a failed edit", async () => {
    const storage = makeWizardStorage("sess-w2c-2");

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w2c-2", sessionId: "sess-w2c-2", command: "v0:q1", chatId: "1" }),
      {
        createAdapter: adapter,
        editNotification: async () => ({ ok: false }),
        sendTelegramReply: async () => {},
      },
    );

    // No rollback: the advance stands, and the command is acked.
    const updated = storage.pendingQuestions.getBySessionId("sess-w2c-2");
    expect(updated!.currentStep).toBe(1);
    expect(updated!.answers).toEqual([["MongoDB"]]);
    expect(updated!.version).toBe(1);
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("contains a throwing editNotification instead of letting it escape", async () => {
    const storage = makeWizardStorage("sess-w2c-3");
    const replies: string[] = [];

    // A throw would escape ingestWorkerCommand, skip the ack, and the retry
    // would die on the stale-version guard the advance just created.
    await expect(ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w2c-3", sessionId: "sess-w2c-3", command: "v0:q1", chatId: "1" }),
      {
        createAdapter: adapter,
        editNotification: async () => { throw new Error("network down"); },
        sendTelegramReply: async (_c, text) => { replies.push(text); },
      },
    )).resolves.toBeUndefined();

    expect(replies).toHaveLength(1);
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("still notifies and acks when the keyboard-clearing edit throws", async () => {
    // dropUnanswerableQuestion deletes the row and then clears the keyboard.
    // An unguarded throw there escapes before dropCommand runs: the row is
    // gone, the command is never acked, and the user is never told. On retry
    // there is no pending question, so a typed answer falls through to the
    // execute path and reaches opencode as a stray prompt.
    const storage = makeWizardStorage("sess-w2c-10");
    // The adapter-lacks branch is only reached on the final step.
    const rec10 = storage.pendingQuestions.getBySessionId("sess-w2c-10")!;
    storage.pendingQuestions.advanceStep(rec10, ["Postgres"]);
    const replies: string[] = [];

    await expect(ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w2c-10", sessionId: "sess-w2c-10", command: "v1:q0", chatId: "1" }),
      {
        createAdapter: () => ({
          name: "mock-no-question-support",
          async deliverCommand() { return { ok: false as const, error: "should not be called" }; },
        }),
        editNotification: async () => { throw new Error("network down"); },
        sendTelegramReply: async (_c, text) => { replies.push(text); },
      },
    )).resolves.toBeUndefined();

    expect(replies).toHaveLength(1);
    expect(replies[0]!).toContain("can't receive question answers");
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("stays silent when the edit succeeds", async () => {
    const storage = makeWizardStorage("sess-w2c-4");
    const replies: string[] = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w2c-4", sessionId: "sess-w2c-4", command: "v0:q1", chatId: "1" }),
      {
        createAdapter: adapter,
        editNotification: async () => ({ ok: true }),
        sendTelegramReply: async (_c, text) => { replies.push(text); },
      },
    );

    expect(replies).toEqual([]);
    storage.db.close();
  });

  it("stays silent when no editNotification is wired at all", async () => {
    const storage = makeWizardStorage("sess-w2c-5");
    const replies: string[] = [];

    // `editNotification?.()` yields undefined when unwired. A naive `!res?.ok`
    // check would treat that as a failure and warn about buttons nobody saw.
    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w2c-5", sessionId: "sess-w2c-5", command: "v0:q1", chatId: "1" }),
      {
        createAdapter: adapter,
        sendTelegramReply: async (_c, text) => { replies.push(text); },
      },
    );

    expect(replies).toEqual([]);
    storage.db.close();
  });

  it("still acks when the fallback reply itself throws", async () => {
    const storage = makeWizardStorage("sess-w2c-6");

    await expect(ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w2c-6", sessionId: "sess-w2c-6", command: "v0:q1", chatId: "1" }),
      {
        createAdapter: adapter,
        editNotification: async () => ({ ok: false }),
        sendTelegramReply: async () => { throw new Error("telegram down"); },
      },
    )).resolves.toBeUndefined();

    expect(storage.inbox.listUnfinished()).toHaveLength(0);
    storage.db.close();
  });

  it("warns the buttons are stale when the completion edit fails on the final step", async () => {
    const storage = makeWizardStorage("sess-w2c-7");
    // Move to the final step so the next press completes the wizard.
    const rec7 = storage.pendingQuestions.getBySessionId("sess-w2c-7")!;
    storage.pendingQuestions.advanceStep(rec7, ["Postgres"]);
    const replies: string[] = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w2c-7", sessionId: "sess-w2c-7", command: "v1:q0", chatId: "1" }),
      {
        createAdapter: adapter,
        editNotification: async () => ({ ok: false }),
        sendTelegramReply: async (_c, text) => { replies.push(text); },
      },
    );

    // Answers were delivered and the row is gone; only the keyboard is stale.
    expect(storage.pendingQuestions.getBySessionId("sess-w2c-7")).toBeNull();
    expect(replies).toHaveLength(1);
    expect(replies[0]!.toLowerCase()).toContain("button");
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// W3 (pigeon-tyk) + W4 (pigeon-bru): media/empty-command hygiene.
//
// These two beads share one repro — a caption-less photo replying to a pending
// question — which is why they are fixed together. That single message proves
// both defects at once: the empty string is submitted as the ANSWER (W4) and the
// file is discarded (W3), because the question path returns long before the
// media fetch at the bottom of ingestWorkerCommand.
// ─────────────────────────────────────────────────────────────────────────────
describe("ingestWorkerCommand — media + empty-command hygiene (W3/W4)", () => {
  const photo = { key: "inbound/1-a/photo.jpg", mime: "image/jpeg", filename: "photo.jpg", size: 999 };

  const twoQuestions = [
    { question: "Q1", header: "H1", options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
    { question: "Q2", header: "H2", options: [{ label: "X", description: "" }, { label: "Y", description: "" }] },
  ];
  const oneQuestion = [
    { question: "Q1", header: "H1", options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
  ];

  function questionSession(sessionId: string) {
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

  // ── W4: a file must never become a question's answer ──────────────────────

  it("refuses a caption-less media reply to a single question instead of answering with ''", async () => {
    const { storage, now } = questionSession("sess-w4-single");
    storage.pendingQuestions.store({
      sessionId: "sess-w4-single", requestId: "req-1", questions: oneQuestion, token: "tok-1",
    }, now);

    const replies: string[] = [];
    const answersSeen: unknown[] = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w4-1", sessionId: "sess-w4-single", command: "", chatId: "80", media: photo }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: true as const }; },
          async deliverQuestionReply(_s: unknown, payload: { answers: unknown }) {
            answersSeen.push(payload.answers);
            return { ok: true as const };
          },
        }),
        sendTelegramReply: async (_chatId, text) => { replies.push(text); },
      },
    );

    // The empty string must NOT have been submitted as the answer.
    expect(answersSeen).toHaveLength(0);
    // The question is still waiting, so the user can still answer it.
    expect(storage.pendingQuestions.getBySessionId("sess-w4-single")).not.toBeNull();
    // And they were told why nothing happened.
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/question/i);
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("refuses a caption-less media reply to a wizard without advancing the step", async () => {
    const { storage, now } = questionSession("sess-w4-wiz");
    storage.pendingQuestions.store({
      sessionId: "sess-w4-wiz", requestId: "req-2", questions: twoQuestions, token: "tok-2",
    }, now);
    const before = storage.pendingQuestions.getBySessionId("sess-w4-wiz")!;

    const replies: string[] = [];
    const editCalls: unknown[] = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w4-2", sessionId: "sess-w4-wiz", command: "", chatId: "81", media: photo }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: true as const }; },
          async deliverQuestionReply() { return { ok: true as const }; },
        }),
        editNotification: async (...args: unknown[]) => { editCalls.push(args); return { ok: true }; },
        sendTelegramReply: async (_chatId, text) => { replies.push(text); },
      },
    );

    const after = storage.pendingQuestions.getBySessionId("sess-w4-wiz")!;
    // No advance: step, version and accumulated answers are all untouched.
    expect(after.currentStep).toBe(before.currentStep);
    expect(after.version).toBe(before.version);
    expect(after.answers).toEqual(before.answers);
    // The on-screen keyboard is still valid, so it must not be edited away.
    expect(editCalls).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("delivers the caption as the answer but warns that the file was not delivered", async () => {
    const { storage, now } = questionSession("sess-w4-cap");
    storage.pendingQuestions.store({
      sessionId: "sess-w4-cap", requestId: "req-3", questions: oneQuestion, token: "tok-3",
    }, now);

    const replies: string[] = [];
    const answersSeen: unknown[] = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w4-3", sessionId: "sess-w4-cap", command: "my answer", chatId: "82", media: photo }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: true as const }; },
          async deliverQuestionReply(_s: unknown, payload: { answers: unknown }) {
            answersSeen.push(payload.answers);
            return { ok: true as const };
          },
        }),
        sendTelegramReply: async (_chatId, text) => { replies.push(text); },
      },
    );

    // A captioned reply carries a real answer, so it is still delivered.
    expect(answersSeen).toEqual([[["my answer"]]]);
    // But the file went nowhere, and silence about that is the defect this epic exists to kill.
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/file/i);
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("refuses an empty text-only message to a pending question (the bead's literal criterion)", async () => {
    const { storage, now } = questionSession("sess-w4-empty");
    storage.pendingQuestions.store({
      sessionId: "sess-w4-empty", requestId: "req-4", questions: oneQuestion, token: "tok-4",
    }, now);

    const answersSeen: unknown[] = [];
    const replies: string[] = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w4-4", sessionId: "sess-w4-empty", command: "   ", chatId: "83" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: true as const }; },
          async deliverQuestionReply(_s: unknown, payload: { answers: unknown }) {
            answersSeen.push(payload.answers);
            return { ok: true as const };
          },
        }),
        sendTelegramReply: async (_chatId, text) => { replies.push(text); },
      },
    );

    expect(answersSeen).toHaveLength(0);
    expect(storage.pendingQuestions.getBySessionId("sess-w4-empty")).not.toBeNull();
    expect(replies).toHaveLength(1);
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("refuses media on the metadata-fallback question path too", async () => {
    // No local pending row: this is the stale-state rescue path, which has its
    // own copy of the empty-answer bug at `[[msg.command.trim()]]`.
    const { storage } = questionSession("sess-w4-meta");

    const answersSeen: unknown[] = [];
    const replies: string[] = [];
    const delivered: unknown[] = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({
        commandId: "cmd-w4-5", sessionId: "sess-w4-meta", command: "", chatId: "84",
        media: photo, metadata: { questionRequestId: "req-5" },
      }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand(_s: unknown, cmd: unknown) { delivered.push(cmd); return { ok: true as const }; },
          async deliverQuestionReply(_s: unknown, payload: { answers: unknown }) {
            answersSeen.push(payload.answers);
            return { ok: true as const };
          },
        }),
        sendTelegramReply: async (_chatId, text) => { replies.push(text); },
      },
    );

    expect(answersSeen).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  // ── W3: a caption-less file must still reach the session ──────────────────

  it("substitutes a placeholder so caption-less media is delivered instead of rejected", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-w3-1", notify: true, backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1, backendEndpoint: "http://127.0.0.1:7777/x", backendAuthToken: "tok",
    }, Date.now());

    const bytes = Buffer.from("img");
    const fetchFn = vi.fn(async () => new Response(bytes, { status: 200 }));

    let deliveredCommand: string | null = null;
    let deliveredCtx: CommandDeliveryContext | null = null;

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w3-1", sessionId: "sess-w3-1", command: "", chatId: "85", media: photo }),
      {
        workerUrl: "https://worker.example.com",
        apiKey: "k",
        fetchFn: fetchFn as unknown as typeof fetch,
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand(_s: unknown, cmd: string, ctx: CommandDeliveryContext) {
            deliveredCommand = cmd;
            deliveredCtx = ctx;
            return { ok: true as const };
          },
        }),
      },
    );

    // The whole point: it is delivered, not rejected as an empty envelope.
    const cmd = deliveredCommand as string | null;
    expect(cmd).toBeTruthy();
    expect(cmd!.trim().length).toBeGreaterThan(0);
    // The placeholder must describe the file factually — the agent reads it verbatim.
    expect(cmd).toContain("photo.jpg");
    // And the bytes still ride along.
    expect((deliveredCtx as CommandDeliveryContext | null)?.media).toBeDefined();
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  it("leaves a captioned media command exactly as the user wrote it", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-w3-2", notify: true, backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1, backendEndpoint: "http://127.0.0.1:7777/x", backendAuthToken: "tok",
    }, Date.now());

    const fetchFn = vi.fn(async () => new Response(Buffer.from("img"), { status: 200 }));
    let deliveredCommand: string | null = null;

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w3-2", sessionId: "sess-w3-2", command: "what is this?", chatId: "86", media: photo }),
      {
        workerUrl: "https://worker.example.com",
        apiKey: "k",
        fetchFn: fetchFn as unknown as typeof fetch,
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand(_s: unknown, cmd: string) { deliveredCommand = cmd; return { ok: true as const }; },
        }),
      },
    );

    expect(deliveredCommand).toBe("what is this?");

    storage.db.close();
  });

  it("never synthesizes a placeholder for a media-less empty command", async () => {
    // The hard constraint from the bead: synthesizing here would inject a
    // garbage prompt into an agent at 3am. Empty-and-media-less must stay empty
    // and be rejected downstream, exactly as it is today.
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-w3-3", notify: true, backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1, backendEndpoint: "http://127.0.0.1:7777/x", backendAuthToken: "tok",
    }, Date.now());

    let deliveredCommand: string | null = null;

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w3-3", sessionId: "sess-w3-3", command: "", chatId: "87" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand(_s: unknown, cmd: string) { deliveredCommand = cmd; return { ok: true as const }; },
        }),
      },
    );

    expect(deliveredCommand).toBe("");

    storage.db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// W3/W4 follow-ups from adversarial review of the first cut.
//
// The "your file wasn't delivered" warning originally fired at question-path
// entry, before delivery was attempted. Two ways that misleads, both of which
// are the exact defect class this epic exists to kill:
//   1. a transient failure re-ingests the command, re-sending the warning once
//      per lease cycle, unbounded;
//   2. on the metadata-fallback branch a terminal failure falls through to
//      regular delivery, which DOES deliver the file — so the warning was a lie.
// It now fires only once the caption has actually been accepted as the answer.
// ─────────────────────────────────────────────────────────────────────────────
describe("ingestWorkerCommand — media warning fires only on a delivered answer (W3/W4)", () => {
  const photo = { key: "inbound/2-b/doc.pdf", mime: "application/pdf", filename: "doc.pdf", size: 10 };
  const oneQuestion = [
    { question: "Q1", header: "H1", options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
  ];

  function questionSession(sessionId: string) {
    const now = Date.now();
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId, notify: true, backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1, backendEndpoint: "http://127.0.0.1:7777/x", backendAuthToken: "tok",
    }, now);
    return { storage, now };
  }

  it("does not warn about the file when the answer transiently fails (no retry spam)", async () => {
    const { storage, now } = questionSession("sess-spam");
    storage.pendingQuestions.store({
      sessionId: "sess-spam", requestId: "req-s", questions: oneQuestion, token: "t",
    }, now);

    const replies: string[] = [];

    // A connection error is transient: it throws so the Poller retries the whole
    // command. Any message sent before that point is sent again on every retry.
    await expect(ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-spam", sessionId: "sess-spam", command: "my answer", chatId: "90", media: photo }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: true as const }; },
          async deliverQuestionReply() { return { ok: false as const, error: "ECONNREFUSED" }; },
        }),
        sendTelegramReply: async (_c, text) => { replies.push(text); },
      },
    )).rejects.toThrow();

    expect(replies).toHaveLength(0);

    storage.db.close();
  });

  it("does not warn about the file when the answer terminally fails", async () => {
    const { storage, now } = questionSession("sess-term");
    storage.pendingQuestions.store({
      sessionId: "sess-term", requestId: "req-t", questions: oneQuestion, token: "t",
    }, now);

    const replies: string[] = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-term", sessionId: "sess-term", command: "my answer", chatId: "91", media: photo }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: true as const }; },
          async deliverQuestionReply() { return { ok: false as const, error: "QUESTION_NOT_FOUND" }; },
        }),
        sendTelegramReply: async (_c, text) => { replies.push(text); },
      },
    );

    // Exactly one message: the delivery failure. Adding a "your file wasn't
    // delivered" note here would contradict it — nothing was delivered at all.
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("QUESTION_NOT_FOUND");
    expect(replies.some((r) => /file/i.test(r))).toBe(false);

    storage.db.close();
  });

  it("does not claim the question is still waiting on the metadata-fallback branch", async () => {
    // There is no local pending row here by definition — that is why this branch
    // exists. Telling the user to "tap an option" may be false.
    const { storage } = questionSession("sess-fb");

    const replies: string[] = [];

    await ingestWorkerCommand(
      storage,
      makeMsg({
        commandId: "cmd-fb", sessionId: "sess-fb", command: "", chatId: "92",
        media: photo, metadata: { questionRequestId: "req-f" },
      }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: true as const }; },
          async deliverQuestionReply() { return { ok: true as const }; },
        }),
        sendTelegramReply: async (_c, text) => { replies.push(text); },
      },
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toMatch(/still waiting/i);

    storage.db.close();
  });

  it("tells the user the file was lost when delivery falls back to revive", async () => {
    // The revive fallback talks to opencode-serve directly and has no file
    // channel. Without the notice the session receives the placeholder text
    // describing a file that never arrived.
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-revive-media", notify: true, backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1, backendEndpoint: "http://127.0.0.1:7777/x", backendAuthToken: "tok",
    }, Date.now());

    const prompts: string[] = [];
    const fetchFn = vi.fn(async () => new Response(Buffer.from("img"), { status: 200 }));

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-revive-media", sessionId: "sess-revive-media", command: "", chatId: "93", media: photo }),
      {
        workerUrl: "https://worker.example.com",
        apiKey: "k",
        fetchFn: fetchFn as unknown as typeof fetch,
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: false as const, error: "ECONNREFUSED" }; },
        }),
        opencodeClient: {
          async getSession() { return { id: "sess-revive-media", directory: "/tmp/proj" }; },
          async sendPrompt(_sid: string, _dir: string, prompt: string) { prompts.push(prompt); },
        } as never,
      },
    );

    expect(prompts).toHaveLength(1);
    // Both halves matter: what the file was, and that it did not arrive.
    expect(prompts[0]).toContain("doc.pdf");
    expect(prompts[0]).toMatch(/could not be delivered/i);

    storage.db.close();
  });
});

// ---------------------------------------------------------------------------
// W2e (pigeon-k4c.4): a callback payload whose SHAPE disagrees with the pending
// question's arity is provably stale/foreign and must never be resolved by
// positional index.
//
// The two renderers are a bijection:
//   - notification-service.ts:178-187 emits legacy `q{i}`, guarded on
//     `questions.length === 1`
//   - notification-service.ts:241-250 emits `v{version}:q{i}` and is the ONLY
//     producer of the v-form
// so shape disagreeing with arity proves the press came from a DIFFERENT render
// than the row now pending.
// ---------------------------------------------------------------------------
describe("W2e: option-token shape must match the pending question's arity", () => {
  function makeStorage(sessionId: string) {
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

  const singleQuestion = [{
    question: "Deploy to production?",
    header: "Deploy",
    options: [
      { label: "Yes, deploy", description: "" },
      { label: "No, abort", description: "" },
    ],
  }];

  const twoQuestions = [
    { question: "Q1", header: "H1", options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
    { question: "Q2", header: "H2", options: [{ label: "X", description: "" }, { label: "Y", description: "" }] },
  ];

  // THE CRUX. This is the case the originally-proposed fix ("apply the version
  // guard whenever wizardMatch is present") does NOT catch: every row is stored
  // with version 0 (repos.ts:385) and a wizard's first step renders v0
  // (app.ts:816), so `incomingVersion !== pendingQuestion.version` is 0 !== 0
  // = false and the stale press slips straight through.
  it("refuses a stale v0 wizard press against a fresh single question (the version guard cannot see this)", async () => {
    const { storage, now } = makeStorage("sess-w2e-1");
    storage.pendingQuestions.store({
      sessionId: "sess-w2e-1",
      requestId: "req-fresh-single",
      questions: singleQuestion,
      token: "tok-w2e-1",
    }, now);

    // sanity: the row really is at version 0, same as the incoming payload
    expect(storage.pendingQuestions.getBySessionId("sess-w2e-1")!.version).toBe(0);

    let capturedReply: QuestionReplyInput | null = null;
    let sentTelegramText: string | null = null;

    await ingestWorkerCommand(
      storage,
      // no metadata: the metadata-less routes (typed `/cmd TOKEN v0:q0`,
      // topic-routed text, and any pre-#46 daemon) are exactly where the
      // requestId identity check at :173 cannot help.
      makeMsg({ commandId: "cmd-w2e-1", sessionId: "sess-w2e-1", command: "v0:q0", chatId: "1" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: false, error: "should not be called" }; },
          async deliverQuestionReply(_s: unknown, reply: QuestionReplyInput) {
            capturedReply = reply;
            return { ok: true as const };
          },
        }),
        sendTelegramReply: async (_chatId, text) => { sentTelegramText = text; },
      },
    );

    // MUST NOT answer "Yes, deploy" to a question the user never read
    expect(capturedReply).toBeNull();
    // and MUST NOT be silent about it
    expect(sentTelegramText).not.toBeNull();
    // Exact equality, not a substring: a substring assertion cannot see a bogus
    // echo tail appended to the message (a mutant that passed `""` to the
    // formatter survived a `toContain` check).
    expect(sentTelegramText).toBe(
      "That option doesn't belong to the question that's open now, so it wasn't recorded. Use the buttons on the latest question above.",
    );
    // the raw token is not echoed back as if it were the user's words
    expect(sentTelegramText!).not.toContain("v0:q0");
    // and it must NOT claim the question was replaced -- for a shape mismatch
    // that is not necessarily true
    expect(sentTelegramText!).not.toContain("replaced by a newer one");
    // pending row survives, so the real keyboard still works
    expect(storage.pendingQuestions.getBySessionId("sess-w2e-1")).not.toBeNull();
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  // The symmetric case, which the bead did not report. A legacy payload carries
  // NO version at all, so no version-based guard could ever defend this one.
  it("refuses a stale legacy press against a pending wizard (no version exists to check)", async () => {
    const { storage, now } = makeStorage("sess-w2e-2");
    storage.pendingQuestions.store({
      sessionId: "sess-w2e-2",
      requestId: "req-wizard",
      questions: twoQuestions,
      token: "tok-w2e-2",
    }, now);

    let capturedReply: QuestionReplyInput | null = null;
    let sentTelegramText: string | null = null;
    let editCalled = false;

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-w2e-2", sessionId: "sess-w2e-2", command: "q1", chatId: "1" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: false, error: "should not be called" }; },
          async deliverQuestionReply(_s: unknown, reply: QuestionReplyInput) {
            capturedReply = reply;
            return { ok: true as const };
          },
        }),
        editNotification: async () => { editCalled = true; return { ok: true }; },
        sendTelegramReply: async (_chatId, text) => { sentTelegramText = text; },
      },
    );

    expect(capturedReply).toBeNull();
    // must not have advanced the wizard either
    expect(editCalled).toBe(false);
    const row = storage.pendingQuestions.getBySessionId("sess-w2e-2")!;
    expect(row.currentStep).toBe(0);
    expect(row.answers).toEqual([]);
    expect(row.version).toBe(0);
    expect(sentTelegramText).not.toBeNull();
    expect(sentTelegramText).toBe(
      "That option doesn't belong to the question that's open now, so it wasn't recorded. Use the buttons on the latest question above.",
    );
    expect(sentTelegramText!).not.toContain("q1");
    expect(storage.inbox.listUnfinished()).toHaveLength(0);

    storage.db.close();
  });

  // Guard against over-triggering: free text must still reach the question, and
  // it must not be mistaken for a shape mismatch just because a wizard is up.
  it("still accepts a free-text answer for a single question", async () => {
    const { storage, now } = makeStorage("sess-w2e-3a");
    storage.pendingQuestions.store({
      sessionId: "sess-w2e-3a", requestId: "r3a", questions: singleQuestion, token: "t3a",
    }, now);

    let reply: QuestionReplyInput | null = null;
    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "c3a", sessionId: "sess-w2e-3a", command: "some custom answer", chatId: "1" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: false, error: "no" }; },
          async deliverQuestionReply(_s: unknown, r: QuestionReplyInput) { reply = r; return { ok: true as const }; },
        }),
      },
    );
    expect(reply).not.toBeNull();
    expect(reply!.answers).toEqual([["some custom answer"]]);
    storage.db.close();
  });

  // Free text against a wizard advances a step rather than delivering, so the
  // guard must not mistake "no option token" for a shape mismatch.
  it("still accepts a free-text answer for a wizard step", async () => {
    const { storage, now } = makeStorage("sess-w2e-3b");
    storage.pendingQuestions.store({
      sessionId: "sess-w2e-3b", requestId: "r3b", questions: twoQuestions, token: "t3b",
    }, now);

    let sentTelegramText: string | null = null;
    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "c3b", sessionId: "sess-w2e-3b", command: "another custom answer", chatId: "1" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: false, error: "no" }; },
          async deliverQuestionReply() { return { ok: true as const }; },
        }),
        editNotification: async () => ({ ok: true }),
        sendTelegramReply: async (_c, text) => { sentTelegramText = text; },
      },
    );
    const row = storage.pendingQuestions.getBySessionId("sess-w2e-3b")!;
    expect(row.currentStep).toBe(1);
    expect(row.answers).toEqual([["another custom answer"]]);
    expect(sentTelegramText).toBeNull();
    storage.db.close();
  });

  // Matching shapes must be untouched by this guard.
  it("still accepts a legacy press for a single question and a v-press for a wizard", async () => {
    const { storage: s1, now: n1 } = makeStorage("sess-w2e-4a");
    s1.pendingQuestions.store({
      sessionId: "sess-w2e-4a", requestId: "r4a", questions: singleQuestion, token: "t4a",
    }, n1);
    let reply1: QuestionReplyInput | null = null;
    await ingestWorkerCommand(
      s1,
      makeMsg({ commandId: "c4a", sessionId: "sess-w2e-4a", command: "q0", chatId: "1" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: false, error: "no" }; },
          async deliverQuestionReply(_s: unknown, r: QuestionReplyInput) { reply1 = r; return { ok: true as const }; },
        }),
      },
    );
    expect(reply1).not.toBeNull();
    expect(reply1!.answers).toEqual([["Yes, deploy"]]);
    s1.db.close();

    const { storage: s2, now: n2 } = makeStorage("sess-w2e-4b");
    s2.pendingQuestions.store({
      sessionId: "sess-w2e-4b", requestId: "r4b", questions: twoQuestions, token: "t4b",
    }, n2);
    await ingestWorkerCommand(
      s2,
      makeMsg({ commandId: "c4b", sessionId: "sess-w2e-4b", command: "v0:q1", chatId: "1" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: false, error: "no" }; },
          async deliverQuestionReply() { return { ok: true as const }; },
        }),
        editNotification: async () => ({ ok: true }),
      },
    );
    const advanced = s2.pendingQuestions.getBySessionId("sess-w2e-4b")!;
    expect(advanced.currentStep).toBe(1);
    expect(advanced.answers).toEqual([["B"]]);
    s2.db.close();
  });

  // Ordering pin: when the worker DOES supply identity, that check must win, so
  // this guard is genuinely defense-in-depth rather than a competing path.
  it("lets the requestId identity check win when metadata is present", async () => {
    const { storage, now } = makeStorage("sess-w2e-5");
    storage.pendingQuestions.store({
      sessionId: "sess-w2e-5", requestId: "req-current", questions: singleQuestion, token: "t5",
    }, now);

    const warns: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((m: unknown) => { warns.push(String(m)); });

    let sentTelegramText: string | null = null;
    await ingestWorkerCommand(
      storage,
      makeMsg({
        commandId: "c5", sessionId: "sess-w2e-5", command: "v0:q0", chatId: "1",
        metadata: { questionRequestId: "req-stale" },
      }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() { return { ok: false, error: "no" }; },
          async deliverQuestionReply() { return { ok: true as const }; },
        }),
        sendTelegramReply: async (_c, text) => { sentTelegramText = text; },
      },
    );
    spy.mockRestore();

    expect(sentTelegramText).not.toBeNull();
    // the identity check's message, NOT the shape guard's -- proves ordering
    expect(sentTelegramText!).toContain("replaced by a newer one");
    expect(sentTelegramText!).not.toContain("doesn't belong to the question");
    // the identity check logs "metadata mismatched"; the shape guard does not
    expect(warns.some(w => w.includes("metadata mismatched"))).toBe(true);
    expect(warns.some(w => w.includes("shape does not match"))).toBe(false);
    storage.db.close();
  });
});
