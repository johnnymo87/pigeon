import { afterEach, describe, expect, it, vi } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { startSessionReaper, reapStaleSessions } from "../src/session-reaper";
import { SESSION_TTL_MS } from "../src/storage/schema";

describe("reapStaleSessions", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  it("deletes sessions older than the TTL and calls cleanup callbacks", async () => {
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
    expect(deleteSession).toHaveBeenCalledWith("stale-1");
    expect(unregisterSession).toHaveBeenCalledWith("stale-1");
    expect(storage.sessions.get("stale-1")).toBeNull();
    expect(storage.sessions.get("fresh-1")).not.toBeNull();
  });

  it("still cleans up records when deleteSession fails", async () => {
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
