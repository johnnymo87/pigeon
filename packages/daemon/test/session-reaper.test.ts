import { afterEach, describe, expect, it, vi } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { startSessionReaper, reapStaleSessions } from "../src/session-reaper";
import { SESSION_TTL_MS } from "../src/storage/schema";
import { ingestWorkerCommand } from "../src/worker/command-ingest";
import type { QuestionReplyInput } from "../src/adapters/types";

describe("reapStaleSessions", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  it("cleans stale Pigeon registry entries without deleting opencode transcripts", async () => {
    storage = openStorageDb(":memory:");
    const now = SESSION_TTL_MS + 50_000;

    // Stale session (last_seen = 1000, well past TTL)
    storage.sessions.upsert({ sessionId: "stale-1", notify: true, label: "old" }, 1_000);
    // Fresh session (last_seen = now - 1000, within TTL)
    storage.sessions.upsert({ sessionId: "fresh-1", notify: true, label: "new" }, now - 1_000);

    const deleteSession = vi.fn(async () => {});
    const unregisterSession = vi.fn(async () => {});

    const result = await reapStaleSessions({
      storage,
      deleteSession,
      unregisterSession,
      nowFn: () => now,
    });

    expect(result.reaped).toBe(1);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(unregisterSession).toHaveBeenCalledWith("stale-1");
    expect(storage.sessions.get("stale-1")).toBeNull();
    expect(storage.sessions.get("fresh-1")).not.toBeNull();
  });

  it("does not require opencode deleteSession to clean stale records", async () => {
    storage = openStorageDb(":memory:");
    const now = SESSION_TTL_MS + 50_000;

    storage.sessions.upsert({ sessionId: "stale-2", notify: true }, 1_000);

    const deleteSession = vi.fn(async () => { throw new Error("serve unreachable"); });
    const unregisterSession = vi.fn(async () => {});

    const result = await reapStaleSessions({
      storage,
      deleteSession,
      unregisterSession,
      nowFn: () => now,
    });

    expect(result.reaped).toBe(1);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(storage.sessions.get("stale-2")).toBeNull();
    expect(unregisterSession).toHaveBeenCalledWith("stale-2");
  });

  it("still cleans up SQLite when unregisterSession fails", async () => {
    storage = openStorageDb(":memory:");
    const now = SESSION_TTL_MS + 50_000;

    storage.sessions.upsert({ sessionId: "stale-3", notify: true }, 1_000);

    const deleteSession = vi.fn(async () => {});
    const unregisterSession = vi.fn(async () => { throw new Error("worker down"); });

    const result = await reapStaleSessions({
      storage,
      deleteSession,
      unregisterSession,
      nowFn: () => now,
    });

    expect(result.reaped).toBe(1);
    expect(storage.sessions.get("stale-3")).toBeNull();
  });

  it("does nothing when no sessions are stale", async () => {
    storage = openStorageDb(":memory:");
    const now = 50_000;

    storage.sessions.upsert({ sessionId: "fresh-2", notify: true }, now - 1_000);

    const deleteSession = vi.fn();
    const unregisterSession = vi.fn();

    const result = await reapStaleSessions({
      storage,
      deleteSession,
      unregisterSession,
      nowFn: () => now,
    });

    expect(result.reaped).toBe(0);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(unregisterSession).not.toHaveBeenCalled();
  });

  it("also runs cleanupExpired to catch records with blown TTLs", async () => {
    storage = openStorageDb(":memory:");
    const now = SESSION_TTL_MS + 50_000;

    // Insert a session with a recent last_seen but force expires_at into the past
    storage.sessions.upsert({ sessionId: "expired-ttl", notify: true }, now - 1_000);
    // Touch with a tiny TTL so expires_at is in the past
    storage.sessions.touch("expired-ttl", 1_000, 1); // expires_at = 1001

    const deleteSession = vi.fn(async () => {});
    const unregisterSession = vi.fn(async () => {});

    await reapStaleSessions({
      storage,
      deleteSession,
      unregisterSession,
      nowFn: () => now,
    });

    expect(storage.sessions.get("expired-ttl")).toBeNull();
  });

  it("reaping a stale session deletes its routing assignment", async () => {
    storage = openStorageDb(":memory:");
    const now = SESSION_TTL_MS + 50_000;

    // Stale session (last_seen = 1000, well past TTL)
    storage.sessions.upsert({ sessionId: "ses_stale", notify: true, label: "old" }, 1_000);

    // Seed a routing assignment for it
    storage.assignments.upsert({
      sessionId: "ses_stale",
      directoryKey: null,
      desiredServeId: "serve-0",
      ownerGeneration: 1,
      state: "dormant",
      lastPlacedAt: 0,
      updatedAt: 0,
    });

    const deleteSession = vi.fn(async () => {});
    const unregisterSession = vi.fn(async () => {});

    await reapStaleSessions({
      storage,
      deleteSession,
      unregisterSession,
      nowFn: () => now,
    });

    expect(storage.sessions.get("ses_stale")).toBeNull();
    expect(storage.assignments.get("ses_stale")).toBeNull();
  });

  it("reaping a stale session preserves its session_origin row (no cleanup)", async () => {
    storage = openStorageDb(":memory:");
    const now = SESSION_TTL_MS + 50_000;

    storage.sessions.upsert({ sessionId: "stale-origin-1", notify: true }, 1_000);
    storage.sessionOrigins.record(
      { sessionId: "stale-origin-1", origin: "lgtm", notifyPolicy: "errors-only", source: "declared" },
      1_000,
    );

    const deleteSession = vi.fn(async () => {});
    const unregisterSession = vi.fn(async () => {});

    await reapStaleSessions({
      storage,
      deleteSession,
      unregisterSession,
      nowFn: () => now,
    });

    expect(storage.sessions.get("stale-origin-1")).toBeNull();
    // LOAD-BEARING: session_origin MUST outlive session reaper cleanup. lgtm re-awakens
    // the SAME session id through /swarm/send after reaping; deleting session_origin here
    // would silently reintroduce notification noise.
    expect(storage.sessionOrigins.get("stale-origin-1")?.notifyPolicy).toBe("errors-only");
  });

  it("prevents regression: expired pending questions with live sessions survive session-reaping and remain resurrectable via ingestWorkerCommand", async () => {
    storage = openStorageDb(":memory:");
    const now = Date.now();

    storage.sessions.upsert({
      sessionId: "sess-live-guard",
      notify: true,
      backendKind: "opencode-plugin-direct",
      backendProtocolVersion: 1,
      backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
      backendAuthToken: "tok",
    }, now);

    // Question expired 5 hours ago (TTL is 4h)
    storage.pendingQuestions.store({
      sessionId: "sess-live-guard",
      requestId: "req-exp-guard",
      questions: [{
        question: "Pick database",
        header: "DB",
        options: [
          { label: "PostgreSQL", description: "" },
          { label: "SQLite", description: "" },
        ],
      }],
    }, now - 5 * 3600 * 1000);

    const deleteSession = vi.fn(async () => {});
    const unregisterSession = vi.fn(async () => {});

    const reapResult = await reapStaleSessions({
      storage,
      deleteSession,
      unregisterSession,
      nowFn: () => now,
    });

    expect(reapResult.orphanedQuestions).toBe(0);
    expect(storage.pendingQuestions.getBySessionIdIncludingExpired("sess-live-guard")).not.toBeNull();

    // Verify resurrection still works through ingestWorkerCommand
    let capturedReply: QuestionReplyInput | null = null;
    await ingestWorkerCommand(
      storage,
      {
        commandId: "cmd-guard-1",
        commandType: "execute",
        sessionId: "sess-live-guard",
        command: "q1",
        chatId: "1",
        metadata: { questionRequestId: "req-exp-guard" },
      },
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
      questionRequestId: "req-exp-guard",
      answers: [["SQLite"]],
    });
  });

  it("sweeps orphaned pending question records when a session is reaped as stale", async () => {
    storage = openStorageDb(":memory:");
    const now = SESSION_TTL_MS + 50_000;

    storage.sessions.upsert({ sessionId: "stale-q-1", notify: true }, 1_000);
    storage.pendingQuestions.store({
      sessionId: "stale-q-1",
      requestId: "req-stale-1",
      questions: [{ question: "?", header: "H", options: [] }],
    }, 1_000);

    const deleteSession = vi.fn(async () => {});
    const unregisterSession = vi.fn(async () => {});

    const result = await reapStaleSessions({
      storage,
      deleteSession,
      unregisterSession,
      nowFn: () => now,
    });

    expect(result.reaped).toBe(1);
    expect(result.orphanedQuestions).toBe(1);
    expect(storage.sessions.get("stale-q-1")).toBeNull();
    expect(storage.pendingQuestions.getBySessionIdIncludingExpired("stale-q-1")).toBeNull();
  });

  it("sweeps orphaned pending question records when a session is deleted via sessions.cleanupExpired", async () => {
    storage = openStorageDb(":memory:");
    const now = SESSION_TTL_MS + 50_000;

    storage.sessions.upsert({ sessionId: "expired-sess-q", notify: true }, now - 1_000);
    storage.sessions.touch("expired-sess-q", now - 1_000, -500); // expires_at = now - 1500 (in past), last_seen = now - 1000 (recent)

    storage.pendingQuestions.store({
      sessionId: "expired-sess-q",
      requestId: "req-exp-sess-1",
      questions: [{ question: "?", header: "H", options: [] }],
    }, now - 1_000);

    const deleteSession = vi.fn(async () => {});
    const unregisterSession = vi.fn(async () => {});

    const result = await reapStaleSessions({
      storage,
      deleteSession,
      unregisterSession,
      nowFn: () => now,
    });

    expect(result.reaped).toBe(0);
    expect(result.expired).toBe(1);
    expect(result.orphanedQuestions).toBe(1);
    expect(storage.sessions.get("expired-sess-q")).toBeNull();
    expect(storage.pendingQuestions.getBySessionIdIncludingExpired("expired-sess-q")).toBeNull();
  });

  it("orphaned pending question sweep is a no-op when all pending questions belong to live sessions", async () => {
    storage = openStorageDb(":memory:");
    const now = Date.now();

    storage.sessions.upsert({ sessionId: "live-q-1", notify: true }, now - 1_000);
    storage.pendingQuestions.store({
      sessionId: "live-q-1",
      requestId: "req-live-1",
      questions: [{ question: "?", header: "H", options: [] }],
    }, now - 1_000);

    const deleteSession = vi.fn(async () => {});
    const unregisterSession = vi.fn(async () => {});

    const result = await reapStaleSessions({
      storage,
      deleteSession,
      unregisterSession,
      nowFn: () => now,
    });

    expect(result.orphanedQuestions).toBe(0);
    expect(storage.pendingQuestions.getBySessionIdIncludingExpired("live-q-1")).not.toBeNull();
  });

  it("runs orphan question sweep unconditionally every cycle even when reaped and expired are zero", async () => {
    storage = openStorageDb(":memory:");
    const now = Date.now();

    storage.sessions.upsert({ sessionId: "sess-direct-del", notify: true }, now);
    storage.pendingQuestions.store({
      sessionId: "sess-direct-del",
      requestId: "req-direct-del",
      questions: [{ question: "?", header: "H", options: [] }],
    }, now);

    // Simulate direct deletion (e.g. DELETE /sessions/:id or connection error cleanup)
    storage.sessions.delete("sess-direct-del");

    const deleteSession = vi.fn(async () => {});
    const unregisterSession = vi.fn(async () => {});

    const result = await reapStaleSessions({
      storage,
      deleteSession,
      unregisterSession,
      nowFn: () => now,
    });

    expect(result.reaped).toBe(0);
    expect(result.expired).toBe(0);
    expect(result.orphanedQuestions).toBe(1);
    expect(storage.pendingQuestions.getBySessionIdIncludingExpired("sess-direct-del")).toBeNull();
  });
});

describe("startSessionReaper", () => {
  it("returns a stop function that clears the interval", () => {
    const storage = openStorageDb(":memory:");
    const reaper = startSessionReaper({
      storage,
      deleteSession: async () => {},
      unregisterSession: async () => {},
      intervalMs: 60_000,
    });

    expect(typeof reaper.stop).toBe("function");
    reaper.stop();
    storage.db.close();
  });
});
