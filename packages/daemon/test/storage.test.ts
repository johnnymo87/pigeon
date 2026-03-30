import { afterEach, describe, expect, it } from "vitest";
import { openStorageDb } from "../src/storage/database";

function createStorage() {
  return openStorageDb(":memory:");
}

describe("storage schema and repositories", () => {
  afterEach(() => {
    // in-memory databases are dropped when closed.
  });

  it("upserts, reads, touches, and cleans up sessions", () => {
    const storage = createStorage();

    storage.sessions.upsert({
      sessionId: "sess-1",
      pid: 123,
      ppid: 100,
      cwd: "/tmp",
      label: "demo",
      notify: true,
      state: "running",
    }, 1_000);

    const session = storage.sessions.get("sess-1");
    expect(session).not.toBeNull();
    expect(session?.notify).toBe(true);
    expect(session?.pid).toBe(123);

    expect(storage.sessions.touch("sess-1", 2_000)).toBe(true);
    const touched = storage.sessions.get("sess-1");
    expect(touched?.updatedAt).toBe(2_000);
    expect(touched?.lastSeen).toBe(2_000);

    expect(storage.sessions.cleanupExpired(2_000)).toBe(0);
    expect(storage.sessions.cleanupExpired(2_000 + 24 * 60 * 60 * 1000 + 1)).toBe(0);
    expect(storage.sessions.cleanupExpired(2_000 + 7 * 24 * 60 * 60 * 1000 + 1)).toBe(1);
    expect(storage.sessions.get("sess-1")).toBeNull();

    storage.db.close();
  });

  it("mints, validates, and expires session tokens", () => {
    const storage = createStorage();
    storage.sessions.upsert({ sessionId: "sess-token", notify: true }, 10_000);

    storage.sessionTokens.mint(
      {
        token: "token-1",
        sessionId: "sess-token",
        chatId: "42",
        scopes: ["command"],
        context: { source: "test" },
      },
      10_000,
      5_000,
    );

    const valid = storage.sessionTokens.validate("token-1", "42", 12_000);
    expect(valid?.sessionId).toBe("sess-token");
    expect(valid?.context).toEqual({ source: "test" });

    expect(storage.sessionTokens.validate("token-1", "43", 12_000)).toBeNull();
    expect(storage.sessionTokens.validate("token-1", "42", 16_000)).toBeNull();

    storage.db.close();
  });

  it("stores and expires reply tokens", () => {
    const storage = createStorage();

    storage.replyTokens.store("chat-1", "msg-1", "rtok-1", 1_000);
    expect(storage.replyTokens.lookup("chat-1", "msg-1", 2_000, 5_000)).toBe("rtok-1");

    expect(storage.replyTokens.lookup("chat-1", "msg-1", 7_000, 5_000)).toBeNull();
    expect(storage.replyTokens.lookup("chat-1", "msg-1", 8_000, 5_000)).toBeNull();

    storage.replyTokens.store("chat-1", "msg-2", "rtok-2", 10_000);
    storage.replyTokens.store("chat-1", "msg-3", "rtok-3", 20_000);
    expect(storage.replyTokens.cleanup(40_000, 15_000)).toBe(2);

    storage.db.close();
  });

  it("persists, replays, marks done, and cleans inbox commands", () => {
    const storage = createStorage();

    expect(storage.inbox.persist({ commandId: "cmd-1", payload: '{"a":1}' }, 1_000)).toBe(true);
    expect(storage.inbox.persist({ commandId: "cmd-1", payload: '{"a":1}' }, 1_100)).toBe(false);

    expect(storage.inbox.persist({ commandId: "cmd-2", payload: '{"a":2}' }, 1_200)).toBe(true);
    const unfinished = storage.inbox.listUnfinished(10);
    expect(unfinished.map((row) => row.commandId)).toEqual(["cmd-1", "cmd-2"]);

    expect(storage.inbox.markDone("cmd-1", 5_000)).toBe(true);
    expect(storage.inbox.cleanupDone(5_000 + 60 * 60 * 1000 + 1)).toBe(1);

    const remaining = storage.inbox.listUnfinished(10);
    expect(remaining.map((row) => row.commandId)).toEqual(["cmd-2"]);

    storage.db.close();
  });

  it("stores, retrieves, deletes, and expires pending questions", () => {
    const storage = createStorage();

    storage.pendingQuestions.store({
      sessionId: "sess-pq",
      requestId: "question_abc",
      questions: [{
        question: "Which DB?",
        header: "DB",
        options: [
          { label: "PostgreSQL", description: "Relational" },
          { label: "SQLite", description: "File-based" },
        ],
      }],
      token: "tok-pq",
    }, 1_000);

    const record = storage.pendingQuestions.getBySessionId("sess-pq", 1_001);
    expect(record).not.toBeNull();
    expect(record!.requestId).toBe("question_abc");
    expect(record!.questions).toHaveLength(1);
    expect(record!.questions[0]!.options).toHaveLength(2);
    expect(record!.token).toBe("tok-pq");

    // Not expired yet
    expect(storage.pendingQuestions.getBySessionId("sess-pq", 1_000 + 2 * 60 * 60 * 1000)).not.toBeNull();

    // Expired (4h TTL)
    expect(storage.pendingQuestions.getBySessionId("sess-pq", 1_000 + 5 * 60 * 60 * 1000)).toBeNull();

    // Delete
    expect(storage.pendingQuestions.delete("sess-pq")).toBe(true);
    expect(storage.pendingQuestions.getBySessionId("sess-pq", 1_001)).toBeNull();

    // Cleanup expired
    storage.pendingQuestions.store({
      sessionId: "sess-pq2",
      requestId: "q2",
      questions: [{ question: "?", header: "H", options: [] }],
    }, 1_000);
    expect(storage.pendingQuestions.cleanupExpired(1_000 + 5 * 60 * 60 * 1000)).toBe(1);

    storage.db.close();
  });

  it("lists stale sessions by last_seen cutoff", () => {
    const storage = createStorage();

    storage.sessions.upsert({ sessionId: "fresh", notify: true }, 10_000);
    storage.sessions.upsert({ sessionId: "stale", notify: true }, 1_000);

    const stale = storage.sessions.listStale(5_000);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.sessionId).toBe("stale");

    const none = storage.sessions.listStale(500);
    expect(none).toHaveLength(0);

    storage.db.close();
  });

  it("replaces pending question for same session on re-store", () => {
    const storage = createStorage();

    storage.pendingQuestions.store({
      sessionId: "sess-replace",
      requestId: "q-old",
      questions: [{ question: "Old?", header: "H", options: [] }],
    }, 1_000);

    storage.pendingQuestions.store({
      sessionId: "sess-replace",
      requestId: "q-new",
      questions: [{ question: "New?", header: "H", options: [] }],
    }, 2_000);

    const record = storage.pendingQuestions.getBySessionId("sess-replace", 2_001);
    expect(record!.requestId).toBe("q-new");
    expect(record!.questions[0]!.question).toBe("New?");

    storage.db.close();
  });

  describe("SessionRepository model override", () => {
    it("setModelOverride stores a model override for a session", () => {
      const storage = createStorage();
      storage.sessions.upsert({ sessionId: "sess-model", notify: false }, 1_000);

      storage.sessions.setModelOverride("sess-model", "anthropic/claude-opus-4-6");

      const model = storage.sessions.getModelOverride("sess-model");
      expect(model).toBe("anthropic/claude-opus-4-6");

      storage.db.close();
    });

    it("getModelOverride returns null when no override is set", () => {
      const storage = createStorage();
      storage.sessions.upsert({ sessionId: "sess-no-model", notify: false }, 1_000);

      const model = storage.sessions.getModelOverride("sess-no-model");
      expect(model).toBeNull();

      storage.db.close();
    });

    it("getModelOverride returns null for non-existent session", () => {
      const storage = createStorage();

      const model = storage.sessions.getModelOverride("nonexistent-session");
      expect(model).toBeNull();

      storage.db.close();
    });

    it("setModelOverride can update an existing model override", () => {
      const storage = createStorage();
      storage.sessions.upsert({ sessionId: "sess-update-model", notify: false }, 1_000);

      storage.sessions.setModelOverride("sess-update-model", "anthropic/claude-sonnet-4-5");
      storage.sessions.setModelOverride("sess-update-model", "openai/gpt-4o");

      expect(storage.sessions.getModelOverride("sess-update-model")).toBe("openai/gpt-4o");

      storage.db.close();
    });
  });

  describe("PendingQuestionRepository wizard state", () => {
    const q1 = { question: "Which DB?", header: "DB", options: [{ label: "PostgreSQL", description: "Relational" }] };
    const q2 = { question: "Which ORM?", header: "ORM", options: [{ label: "Prisma", description: "TypeScript ORM" }] };

    it("stores with default wizard state (step=0, answers=[], version=0)", () => {
      const storage = createStorage();
      storage.pendingQuestions.store({ sessionId: "s1", requestId: "r1", questions: [q1, q2], token: "t1" });
      const record = storage.pendingQuestions.getBySessionId("s1")!;
      expect(record.currentStep).toBe(0);
      expect(record.answers).toEqual([]);
      expect(record.version).toBe(0);
      storage.db.close();
    });

    it("advanceStep records answer and bumps version", () => {
      const storage = createStorage();
      storage.pendingQuestions.store({ sessionId: "s1", requestId: "r1", questions: [q1, q2], token: "t1" });
      const updated = storage.pendingQuestions.advanceStep("s1", ["PostgreSQL"]);
      expect(updated).not.toBeNull();
      expect(updated!.currentStep).toBe(1);
      expect(updated!.answers).toEqual([["PostgreSQL"]]);
      expect(updated!.version).toBe(1);
      storage.db.close();
    });

    it("advanceStep returns null for missing session", () => {
      const storage = createStorage();
      expect(storage.pendingQuestions.advanceStep("missing", ["x"])).toBeNull();
      storage.db.close();
    });

    it("advanceStep returns null for expired session", () => {
      const storage = createStorage();
      storage.pendingQuestions.store({ sessionId: "s1", requestId: "r1", questions: [q1, q2], token: "t1" }, 1000, 100);
      expect(storage.pendingQuestions.advanceStep("s1", ["x"], 2000)).toBeNull();
      storage.db.close();
    });
  });
});
