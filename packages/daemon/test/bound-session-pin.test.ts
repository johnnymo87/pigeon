import { afterEach, describe, expect, it, vi } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { SESSION_TTL_MS } from "../src/storage/schema";
import { reapStaleSessions } from "../src/session-reaper";

/**
 * A session bound to a named topic is pinned against the 7-day reaper
 * (eng-agent-platform-555.20).
 *
 * A stall-watch coordinator is woken straight through honkd, so pigeon sees
 * nothing of it for as long as Jonathan does not type in its topic -- easily a
 * week. Without the pin, the reaper deletes the row and unregisters it from the
 * worker, which deletes the binding, and the topic silently stops reaching the
 * coordinator.
 */
describe("bound-topic pin", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    storage?.db.close();
    storage = null;
  });

  function open(): StorageDb {
    storage = openStorageDb(":memory:");
    return storage;
  }

  it("records the bound key and moves it off any other session that held it", () => {
    const s = open();
    s.sessions.upsert({ sessionId: "gse_old", notify: true }, 1_000);
    s.sessions.upsert({ sessionId: "gse_new", notify: true }, 1_000);

    s.sessions.setBoundTopicKey("gse_old", "stallwatch:mono", 2_000);
    expect(s.sessions.get("gse_old")?.boundTopicKey).toBe("stallwatch:mono");

    // Rebinding the key re-points it, exactly as the worker's upsert does, so
    // the predecessor must lose its pin or it would never be reaped.
    s.sessions.setBoundTopicKey("gse_new", "stallwatch:mono", 3_000);
    expect(s.sessions.get("gse_new")?.boundTopicKey).toBe("stallwatch:mono");
    expect(s.sessions.get("gse_old")?.boundTopicKey).toBeNull();

    s.sessions.setBoundTopicKey("gse_new", null, 4_000);
    expect(s.sessions.get("gse_new")?.boundTopicKey).toBeNull();
  });

  it("is not clobbered by an upsert that does not mention it", () => {
    const s = open();
    s.sessions.upsert({ sessionId: "gse_1", notify: true }, 1_000);
    s.sessions.setBoundTopicKey("gse_1", "stallwatch:mono", 1_000);
    s.sessions.upsert({ sessionId: "gse_1", notify: true, label: "x" }, 2_000);
    expect(s.sessions.get("gse_1")?.boundTopicKey).toBe("stallwatch:mono");
  });

  it("listStale and cleanupExpired skip a bound session", () => {
    const s = open();
    s.sessions.upsert({ sessionId: "gse_bound", notify: true }, 1_000);
    s.sessions.upsert({ sessionId: "gse_free", notify: true }, 1_000);
    s.sessions.setBoundTopicKey("gse_bound", "stallwatch:mono", 1_000);

    const later = 1_000 + SESSION_TTL_MS * 3;
    expect(s.sessions.listStale(later - SESSION_TTL_MS).map((r) => r.sessionId)).toEqual(["gse_free"]);
    expect(s.sessions.cleanupExpired(later)).toBe(1);
    expect(s.sessions.get("gse_bound")).not.toBeNull();
    expect(s.sessions.get("gse_free")).toBeNull();
  });

  it("the hourly reaper neither deletes nor unregisters a bound session", async () => {
    const s = open();
    s.sessions.upsert({ sessionId: "gse_bound", notify: true }, 1_000);
    s.sessions.setBoundTopicKey("gse_bound", "stallwatch:mono", 1_000);
    s.sessions.upsert({ sessionId: "gse_free", notify: true }, 1_000);

    const unregisterSession = vi.fn().mockResolvedValue(undefined);
    const result = await reapStaleSessions({
      storage: s,
      unregisterSession,
      nowFn: () => 1_000 + SESSION_TTL_MS * 2,
      log: () => {},
    });

    expect(result.reaped).toBe(1);
    expect(unregisterSession).toHaveBeenCalledTimes(1);
    expect(unregisterSession).toHaveBeenCalledWith("gse_free");
    expect(s.sessions.get("gse_bound")).not.toBeNull();
  });

  it("pinTopicKey pins without taking the key from another holder", () => {
    const s = open();
    s.sessions.upsert({ sessionId: "gse_old", notify: true }, 1_000);
    s.sessions.upsert({ sessionId: "gse_new", notify: true }, 1_000);
    s.sessions.setBoundTopicKey("gse_old", "stallwatch:mono", 1_000);
    s.sessions.pinTopicKey("gse_new", "stallwatch:mono", 2_000);
    expect(s.sessions.get("gse_old")?.boundTopicKey).toBe("stallwatch:mono");
    expect(s.sessions.get("gse_new")?.boundTopicKey).toBe("stallwatch:mono");
    expect(s.sessions.listPinned().map((r) => r.sessionId).sort()).toEqual(["gse_new", "gse_old"]);
  });

  it("the reaper re-registers each pinned session so the worker's 14-day sweep never collects it", async () => {
    const s = open();
    s.sessions.upsert({ sessionId: "gse_bound", notify: true, label: "stall-watch mono" }, 1_000);
    s.sessions.setBoundTopicKey("gse_bound", "stallwatch:mono", 1_000);
    s.sessions.upsert({ sessionId: "ses_free", notify: true }, 1_000);

    const registerSession = vi.fn().mockResolvedValue({ ok: true });
    const result = await reapStaleSessions({
      storage: s,
      unregisterSession: vi.fn().mockResolvedValue(undefined),
      registerSession,
      nowFn: () => 2_000,
      log: () => {},
    });
    expect(registerSession).toHaveBeenCalledTimes(1);
    expect(registerSession).toHaveBeenCalledWith("gse_bound", "stall-watch mono");
    expect(result.refreshedPinned).toBe(1);
  });

  it("a failed keep-alive registration is not fatal and not counted", async () => {
    const s = open();
    s.sessions.upsert({ sessionId: "gse_a", notify: true }, 1_000);
    s.sessions.setBoundTopicKey("gse_a", "k:a", 1_000);
    s.sessions.upsert({ sessionId: "gse_b", notify: true }, 1_000);
    s.sessions.setBoundTopicKey("gse_b", "k:b", 1_000);

    const registerSession = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: false, kind: "http_error", status: 500 });
    const result = await reapStaleSessions({
      storage: s,
      unregisterSession: vi.fn(),
      registerSession,
      nowFn: () => 2_000,
      log: () => {},
    });
    expect(registerSession).toHaveBeenCalledTimes(2);
    expect(result.refreshedPinned).toBe(0);
  });

  it("an unbound session is reaped again as usual", async () => {
    const s = open();
    s.sessions.upsert({ sessionId: "gse_1", notify: true }, 1_000);
    s.sessions.setBoundTopicKey("gse_1", "stallwatch:mono", 1_000);
    s.sessions.setBoundTopicKey("gse_1", null, 1_000);

    const unregisterSession = vi.fn().mockResolvedValue(undefined);
    await reapStaleSessions({
      storage: s,
      unregisterSession,
      nowFn: () => 1_000 + SESSION_TTL_MS * 2,
      log: () => {},
    });
    expect(s.sessions.get("gse_1")).toBeNull();
    expect(unregisterSession).toHaveBeenCalledWith("gse_1");
  });
});
