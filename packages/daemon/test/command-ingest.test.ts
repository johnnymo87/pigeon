import { describe, expect, it, vi } from "vitest";
import { openStorageDb } from "../src/storage/database";
import { ingestWorkerCommand } from "../src/worker/command-ingest";
import { ResultErrorCode } from "../src/opencode-direct/contracts";
import type { CommandDeliveryAdapter, CommandDeliveryContext, QuestionReplyInput } from "../src/adapters/types";
import type { ExecuteMessage } from "../src/worker/poller";

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

  it("cleans up dead sessions when delivery fails with a connection error", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-dead",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, 1_000);

    await ingestWorkerCommand(
      storage,
      makeMsg({ commandId: "cmd-dead", sessionId: "sess-dead", command: "ls", chatId: "5" }),
      {
        createAdapter: () => ({
          name: "mock-direct",
          async deliverCommand() {
            return { ok: false, error: "fetch failed: unable to connect" };
          },
        }),
      },
    );

    // Session should be deleted from storage
    expect(storage.sessions.get("sess-dead")).toBeNull();
    storage.db.close();
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
