import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { SwarmRepository } from "../src/storage/swarm-repo";
import { initSwarmSchema } from "../src/storage/swarm-schema";
import { NUDGE_KIND } from "../src/swarm/delivery-policy";
import { DEFAULT_EXPIRY_MS } from "../src/swarm/schedule-time";

function createStorage(): StorageDb {
  return openStorageDb(":memory:");
}

const BASE = {
  msgId: "msg_01h1",
  fromSession: "ses_a",
  toSession: "ses_b" as string | null,
  channel: null as string | null,
  kind: "chat",
  priority: "normal" as const,
  replyTo: null as string | null,
  payload: "hello",
};

describe("SwarmRepository", () => {
  it("inserts and retrieves a message", () => {
    const s = createStorage();
    s.swarm.insert(BASE, 1_000);
    const m = s.swarm.getByMsgId("msg_01h1");
    expect(m).not.toBeNull();
    expect(m!.toSession).toBe("ses_b");
    expect(m!.state).toBe("queued");
    expect(m!.attempts).toBe(0);
    expect(m!.createdAt).toBe(1_000);
    s.db.close();
  });

  it("is idempotent on duplicate msgId", () => {
    const s = createStorage();
    s.swarm.insert(BASE, 1_000);
    s.swarm.insert({ ...BASE, payload: "different" }, 2_000);
    const m = s.swarm.getByMsgId("msg_01h1");
    expect(m!.payload).toBe("hello");
    expect(m!.createdAt).toBe(1_000);
    s.db.close();
  });

  it("returns ready messages for a target in createdAt order", () => {
    const s = createStorage();
    s.swarm.insert({ ...BASE, msgId: "m1" }, 1_000);
    s.swarm.insert({ ...BASE, msgId: "m2" }, 2_000);
    s.swarm.insert({ ...BASE, msgId: "m3", toSession: "ses_other" }, 3_000);
    const ready = s.swarm.getReadyForTarget("ses_b", 5_000, 10);
    expect(ready.map((m) => m.msgId)).toEqual(["m1", "m2"]);
    s.db.close();
  });

  it("excludes already-handed-off messages from getReady", () => {
    const s = createStorage();
    s.swarm.insert(BASE, 1_000);
    s.swarm.markHandedOff("msg_01h1", 2_000);
    const ready = s.swarm.getReadyForTarget("ses_b", 5_000);
    expect(ready).toHaveLength(0);
    s.db.close();
  });

  it("respects next_retry_at for queued retries", () => {
    const s = createStorage();
    s.swarm.insert(BASE, 1_000);
    s.swarm.markRetry("msg_01h1", 1_500, 10_000); // retry at 11_500
    expect(s.swarm.getReadyForTarget("ses_b", 11_000)).toHaveLength(0);
    expect(s.swarm.getReadyForTarget("ses_b", 11_500)).toHaveLength(1);
    s.db.close();
  });

  it("getInbox includes handed-off rows that later failed, excludes pre-handoff failed rows", () => {
    const s = createStorage();
    // m1: handed off, then failed (e.g. nudge exhaustion)
    s.swarm.insert({ ...BASE, msgId: "m1" }, 1_000);
    s.swarm.markHandedOff("m1", 1_500);
    s.swarm.markFailed("m1", 2_000);

    // m2: failed BEFORE handoff (e.g. max attempts exhausted)
    s.swarm.insert({ ...BASE, msgId: "m2" }, 2_000);
    s.swarm.markFailed("m2", 2_500);

    // m3: handed off, active
    s.swarm.insert({ ...BASE, msgId: "m3" }, 3_000);
    s.swarm.markHandedOff("m3", 3_500);

    const inbox = s.swarm.getInbox("ses_b", {});
    expect(inbox.messages.map((m) => m.msgId)).toEqual(["m1", "m3"]);
    s.db.close();
  });

  it("hasQueuedNudge identifies queued nudges for a message", () => {
    const s = createStorage();
    s.swarm.insert({ ...BASE, msgId: "m1" }, 1_000);
    s.swarm.markHandedOff("m1", 1_500);

    expect(s.swarm.hasQueuedNudge("m1")).toBe(false);

    // Insert a queued nudge
    s.swarm.insert(
      {
        msgId: "nudge_1",
        fromSession: "pigeon",
        toSession: "ses_b",
        channel: null,
        kind: NUDGE_KIND,
        priority: "normal",
        replyTo: "m1",
        payload: "nudge payload",
      },
      2_000,
    );

    expect(s.swarm.hasQueuedNudge("m1")).toBe(true);

    // Once nudge is handed off, hasQueuedNudge returns false
    s.swarm.markHandedOff("nudge_1", 2_500);
    expect(s.swarm.hasQueuedNudge("m1")).toBe(false);
    s.db.close();
  });

  it("getInbox returns delivered messages for a session, ordered ascending", () => {
    const s = createStorage();
    s.swarm.insert({ ...BASE, msgId: "m1" }, 1_000);
    s.swarm.insert({ ...BASE, msgId: "m2" }, 2_000);
    s.swarm.markHandedOff("m1", 1_500);
    s.swarm.markHandedOff("m2", 2_500);
    const inbox = s.swarm.getInbox("ses_b", {});
    expect(inbox.messages.map((m) => m.msgId)).toEqual(["m1", "m2"]);
    expect(inbox.hasMore).toBe(false);
    const since = s.swarm.getInbox("ses_b", { since: "m1" });
    expect(since.messages.map((m) => m.msgId)).toEqual(["m2"]);
    expect(since.hasMore).toBe(false);
    s.db.close();
  });

  it("getInbox with a limit returns the NEWEST N messages (recent view), ascending", () => {
    const s = createStorage();
    s.swarm.insert({ ...BASE, msgId: "m1" }, 1_000);
    s.swarm.insert({ ...BASE, msgId: "m2" }, 2_000);
    s.swarm.insert({ ...BASE, msgId: "m3" }, 3_000);
    s.swarm.markHandedOff("m1", 1_500);
    s.swarm.markHandedOff("m2", 2_500);
    s.swarm.markHandedOff("m3", 3_500);

    // limit=1 must return the NEWEST message, not the oldest.
    const one = s.swarm.getInbox("ses_b", { limit: 1 });
    expect(one.messages.map((m) => m.msgId)).toEqual(["m3"]);
    expect(one.hasMore).toBe(true); // older messages exist

    // limit=2 returns the newest 2, in chronological (ascending) order.
    const two = s.swarm.getInbox("ses_b", { limit: 2 });
    expect(two.messages.map((m) => m.msgId)).toEqual(["m2", "m3"]);
    expect(two.hasMore).toBe(true);

    // limit == count: everything, ascending, nothing more.
    const three = s.swarm.getInbox("ses_b", { limit: 3 });
    expect(three.messages.map((m) => m.msgId)).toEqual(["m1", "m2", "m3"]);
    expect(three.hasMore).toBe(false);

    // limit larger than available returns everything, ascending.
    const big = s.swarm.getInbox("ses_b", { limit: 50 });
    expect(big.messages.map((m) => m.msgId)).toEqual(["m1", "m2", "m3"]);
    expect(big.hasMore).toBe(false);
  });

  it("getInbox with `since` + limit drains forward: OLDEST N after the cursor", () => {
    const s = createStorage();
    for (const [id, ts] of [
      ["m1", 1_000],
      ["m2", 2_000],
      ["m3", 3_000],
    ] as const) {
      s.swarm.insert({ ...BASE, msgId: id }, ts);
      s.swarm.markHandedOff(id, ts + 500);
    }
    // Forward replay wants the oldest-after-cursor first so a caller can
    // advance `since` without skipping the middle.
    const page1 = s.swarm.getInbox("ses_b", { since: "m1", limit: 1 });
    expect(page1.messages.map((m) => m.msgId)).toEqual(["m2"]);
    expect(page1.hasMore).toBe(true); // m3 still ahead

    const page2 = s.swarm.getInbox("ses_b", { since: "m2", limit: 1 });
    expect(page2.messages.map((m) => m.msgId)).toEqual(["m3"]);
    expect(page2.hasMore).toBe(false);

    const both = s.swarm.getInbox("ses_b", { since: "m1", limit: 2 });
    expect(both.messages.map((m) => m.msgId)).toEqual(["m2", "m3"]);
    expect(both.hasMore).toBe(false);
    s.db.close();
  });

  it("getInbox with `before` pages backward: NEWEST N older than the cursor", () => {
    const s = createStorage();
    for (const [id, ts] of [
      ["m1", 1_000],
      ["m2", 2_000],
      ["m3", 3_000],
    ] as const) {
      s.swarm.insert({ ...BASE, msgId: id }, ts);
      s.swarm.markHandedOff(id, ts + 500);
    }
    // Scrolling back from m3: the newest message older than m3 is m2.
    const back1 = s.swarm.getInbox("ses_b", { before: "m3", limit: 1 });
    expect(back1.messages.map((m) => m.msgId)).toEqual(["m2"]);
    expect(back1.hasMore).toBe(true); // m1 still older

    const back2 = s.swarm.getInbox("ses_b", { before: "m3", limit: 2 });
    expect(back2.messages.map((m) => m.msgId)).toEqual(["m1", "m2"]);
    expect(back2.hasMore).toBe(false);

    // before without limit returns all older messages, ascending.
    const allBefore = s.swarm.getInbox("ses_b", { before: "m3" });
    expect(allBefore.messages.map((m) => m.msgId)).toEqual(["m1", "m2"]);
    expect(allBefore.hasMore).toBe(false);
    s.db.close();
  });

  it("listTargetsWithReady returns distinct targets with ready work", () => {
    const s = createStorage();
    s.swarm.insert({ ...BASE, msgId: "m1", toSession: "ses_b" }, 1_000);
    s.swarm.insert({ ...BASE, msgId: "m2", toSession: "ses_b" }, 1_500);
    s.swarm.insert({ ...BASE, msgId: "m3", toSession: "ses_c" }, 2_000);
    s.swarm.insert({ ...BASE, msgId: "m4", toSession: "ses_d" }, 2_500);
    s.swarm.markHandedOff("m4", 3_000);
    const targets = s.swarm.listTargetsWithReady(5_000).sort();
    expect(targets).toEqual(["ses_b", "ses_c"]);
    s.db.close();
  });

  describe("delivery verification columns", () => {
    it("fresh DB has verified_at, requeue_count, aborted_at, nudge_count columns", () => {
      const s = createStorage();
      const cols = s.db.pragma("table_info(swarm_messages)") as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain("verified_at");
      expect(names).toContain("requeue_count");
      expect(names).toContain("aborted_at");
      expect(names).toContain("nudge_count");

      s.swarm.insert(BASE, 1_000);
      const m = s.swarm.getByMsgId("msg_01h1");
      expect(m!.verifiedAt).toBeNull();
      expect(m!.requeueCount).toBe(0);
      expect(m!.abortedAt).toBeNull();
      s.db.close();
    });

    it("markVerified sets verified_at", () => {
      const s = createStorage();
      s.swarm.insert(BASE, 1_000);
      s.swarm.markHandedOff("msg_01h1", 2_000);
      s.swarm.markVerified("msg_01h1", 3_000);
      const m = s.swarm.getByMsgId("msg_01h1");
      expect(m!.verifiedAt).toBe(3_000);
      s.db.close();
    });

    it("markVerified deliberately does not bump updated_at (cleanupOlderThan anchors retention on it)", () => {
      const s = createStorage();
      s.swarm.insert(BASE, 1_000);
      s.swarm.markHandedOff("msg_01h1", 2_000);
      const before = s.swarm.getByMsgId("msg_01h1")!.updatedAt;
      s.swarm.markVerified("msg_01h1", 99_000);
      const after = s.swarm.getByMsgId("msg_01h1")!.updatedAt;
      expect(after).toBe(before);
      s.db.close();
    });

    it("requeueForRecovery resets state to queued, sets next_retry_at, increments requeue_count", () => {
      const s = createStorage();
      s.swarm.insert(BASE, 1_000);
      s.swarm.markHandedOff("msg_01h1", 2_000);
      s.swarm.requeueForRecovery("msg_01h1", 5_000, 10_000);
      const m = s.swarm.getByMsgId("msg_01h1");
      expect(m!.state).toBe("queued");
      expect(m!.nextRetryAt).toBe(15_000);
      expect(m!.requeueCount).toBe(1);

      s.swarm.markHandedOff("msg_01h1", 16_000);
      s.swarm.requeueForRecovery("msg_01h1", 20_000, 10_000);
      const m2 = s.swarm.getByMsgId("msg_01h1");
      expect(m2!.requeueCount).toBe(2);
      s.db.close();
    });

    it("markAborted sets aborted_at", () => {
      const s = createStorage();
      s.swarm.insert(BASE, 1_000);
      s.swarm.markHandedOff("msg_01h1", 2_000);
      s.swarm.markAborted("msg_01h1", 9_000);
      const m = s.swarm.getByMsgId("msg_01h1");
      expect(m!.abortedAt).toBe(9_000);
      s.db.close();
    });

    it("markAborted deliberately does not bump updated_at (cleanupOlderThan anchors retention on it)", () => {
      const s = createStorage();
      s.swarm.insert(BASE, 1_000);
      s.swarm.markHandedOff("msg_01h1", 2_000);
      const before = s.swarm.getByMsgId("msg_01h1")!.updatedAt;
      s.swarm.markAborted("msg_01h1", 99_000);
      const after = s.swarm.getByMsgId("msg_01h1")!.updatedAt;
      expect(after).toBe(before);
      s.db.close();
    });

    it("markAborted is first-write-wins: a second call does not overwrite the original abort timestamp", () => {
      const s = createStorage();
      s.swarm.insert(BASE, 1_000);
      s.swarm.markHandedOff("msg_01h1", 2_000);
      s.swarm.markAborted("msg_01h1", 9_000);
      s.swarm.markAborted("msg_01h1", 12_000);
      const m = s.swarm.getByMsgId("msg_01h1");
      expect(m!.abortedAt).toBe(9_000);
      s.db.close();
    });

    it("listUnverifiedHandedOff returns only eligible handed-off, unverified, session-targeted, stale-enough rows", () => {
      const s = createStorage();

      // Eligible: handed off long enough ago, unverified, has a to_session.
      s.swarm.insert({ ...BASE, msgId: "eligible" }, 1_000);
      s.swarm.markHandedOff("eligible", 1_000);

      // Verified: must be excluded even though otherwise eligible.
      s.swarm.insert({ ...BASE, msgId: "verified" }, 1_000);
      s.swarm.markHandedOff("verified", 1_000);
      s.swarm.markVerified("verified", 1_500);

      // Channel message (to_session IS NULL): must be excluded.
      s.swarm.insert({ ...BASE, msgId: "channel", toSession: null, channel: "chan_a" }, 1_000);
      s.swarm.markHandedOff("channel", 1_000);

      // Too fresh: handed off recently, inside the verify window.
      s.swarm.insert({ ...BASE, msgId: "fresh" }, 1_000);
      s.swarm.markHandedOff("fresh", 9_900);

      // Not handed off at all: must be excluded.
      s.swarm.insert({ ...BASE, msgId: "queued" }, 1_000);

      const now = 10_000;
      const verifyAfterMs = 5_000; // eligible/verified/channel handed off at 1_000 -> stale enough; fresh at 9_900 -> not.
      const rows = s.swarm.listUnverifiedHandedOff(now, verifyAfterMs);
      const ids = rows.map((r) => r.msgId).sort();
      expect(ids).toEqual(["eligible"]);
      s.db.close();
    });

    it("has an index supporting listUnverifiedHandedOff's (state, verified_at, handed_off_at) lookup", () => {
      const s = createStorage();
      const indexes = s.db.prepare("PRAGMA index_list(swarm_messages)").all() as Array<{ name: string }>;
      expect(indexes.map((i) => i.name)).toContain("idx_swarm_unverified");
      s.db.close();
    });

    it("listUnverifiedHandedOff's query plan uses the index rather than a full table scan", () => {
      const s = createStorage();
      const plan = s.db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT * FROM swarm_messages
           WHERE state = 'handed_off'
             AND verified_at IS NULL
             AND to_session IS NOT NULL
             AND handed_off_at < ?`,
        )
        .all(100) as Array<{ detail: string }>;
      const detail = plan.map((p) => p.detail).join(" ");
      expect(detail).toContain("idx_swarm_unverified");
      expect(detail).not.toMatch(/SCAN swarm_messages\b/);
      s.db.close();
    });
  });

  describe("scheduled swarm messages", () => {
    it("row with FUTURE deliver_at is NOT returned by getReadyForTarget or listTargetsWithReady until now advances", () => {
      const s = createStorage();
      s.swarm.insert({ ...BASE, msgId: "m1", deliverAt: 10_000 }, 1_000);

      // At now = 5_000 (before deliverAt 10_000)
      expect(s.swarm.getReadyForTarget("ses_b", 5_000)).toHaveLength(0);
      expect(s.swarm.listTargetsWithReady(5_000)).toEqual([]);

      // At now = 10_000 (equal to deliverAt)
      const ready = s.swarm.getReadyForTarget("ses_b", 10_000);
      expect(ready).toHaveLength(1);
      expect(ready[0]!.msgId).toBe("m1");
      expect(s.swarm.listTargetsWithReady(10_000)).toEqual(["ses_b"]);

      // At now = 12_000 (past deliverAt)
      expect(s.swarm.getReadyForTarget("ses_b", 12_000)).toHaveLength(1);
      expect(s.swarm.listTargetsWithReady(12_000)).toEqual(["ses_b"]);

      s.db.close();
    });

    it("row with NULL deliver_at is returned immediately (no regression)", () => {
      const s = createStorage();
      s.swarm.insert({ ...BASE, msgId: "m1", deliverAt: null }, 1_000);

      const ready = s.swarm.getReadyForTarget("ses_b", 1_000);
      expect(ready).toHaveLength(1);
      expect(ready[0]!.msgId).toBe("m1");
      expect(s.swarm.listTargetsWithReady(1_000)).toEqual(["ses_b"]);

      s.db.close();
    });

    it("deliver_at and next_retry_at are independent", () => {
      const s = createStorage();

      // Row with future deliver_at (20_000) but elapsed next_retry_at (5_000) -> NOT ready at now=10_000
      s.swarm.insert({ ...BASE, msgId: "m_fut_deliv", deliverAt: 20_000 }, 1_000);
      s.swarm.markRetry("m_fut_deliv", 1_000, 4_000); // next_retry_at = 5_000
      expect(s.swarm.getReadyForTarget("ses_b", 10_000)).toHaveLength(0);

      // Row with elapsed deliver_at (5_000) but future next_retry_at (20_000) -> NOT ready at now=10_000
      s.swarm.insert({ ...BASE, msgId: "m_fut_retry", deliverAt: 5_000 }, 1_000);
      s.swarm.markRetry("m_fut_retry", 1_000, 19_000); // next_retry_at = 20_000
      expect(s.swarm.getReadyForTarget("ses_b", 10_000)).toHaveLength(0);

      // Once now reaches 20_000, both are ready
      const ready = s.swarm.getReadyForTarget("ses_b", 20_000, 10);
      expect(ready.map((m) => m.msgId).sort()).toEqual(["m_fut_deliv", "m_fut_retry"]);

      s.db.close();
    });

    it("C1: markRetry returns false and does not resurrect a cancelled message", () => {
      const s = createStorage();
      s.swarm.insert(BASE, 1_000);
      expect(s.swarm.markCancelled("msg_01h1", 1_500)).toBe(true);
      expect(s.swarm.getByMsgId("msg_01h1")!.state).toBe("cancelled");

      const ret = s.swarm.markRetry("msg_01h1", 2_000, 1_000);
      expect(ret).toBe(false);
      expect(s.swarm.getByMsgId("msg_01h1")!.state).toBe("cancelled");
      s.db.close();
    });

    it("C2: markFailed does not overwrite cancelled state, but permits handed_off -> failed transition for watchdog", () => {
      const s = createStorage();

      // Case 1: cancelled message cannot be marked failed
      s.swarm.insert({ ...BASE, msgId: "m_canc" }, 1_000);
      expect(s.swarm.markCancelled("m_canc", 1_500)).toBe(true);
      expect(s.swarm.markFailed("m_canc", 2_000)).toBe(false);
      expect(s.swarm.getByMsgId("m_canc")!.state).toBe("cancelled");

      // Case 2: handed_off message CAN be marked failed (watchdog path)
      s.swarm.insert({ ...BASE, msgId: "m_handoff" }, 1_000);
      expect(s.swarm.markHandedOff("m_handoff", 1_500)).toBe(true);
      expect(s.swarm.markFailed("m_handoff", 2_000)).toBe(true);
      expect(s.swarm.getByMsgId("m_handoff")!.state).toBe("failed");

      s.db.close();
    });

    it("terminal states are inescapable", () => {
      const s = createStorage();

      type TerminalState = "handed_off" | "failed" | "expired" | "cancelled";
      type TransitionName =
        | "markHandedOff"
        | "markRetry"
        | "markFailed"
        | "markCancelled"
        | "markExpired"
        | "requeueForRecovery";

      const terminalStates: TerminalState[] = ["handed_off", "failed", "expired", "cancelled"];
      const transitions: Array<{
        name: TransitionName;
        apply: (msgId: string) => boolean;
      }> = [
        { name: "markHandedOff", apply: (id) => s.swarm.markHandedOff(id, 2_000) },
        { name: "markRetry", apply: (id) => s.swarm.markRetry(id, 2_000, 1_000) },
        { name: "markFailed", apply: (id) => s.swarm.markFailed(id, 2_000) },
        { name: "markCancelled", apply: (id) => s.swarm.markCancelled(id, 2_000) },
        { name: "markExpired", apply: (id) => s.swarm.markExpired(id, 2_000) },
        { name: "requeueForRecovery", apply: (id) => s.swarm.requeueForRecovery(id, 2_000, 5_000) },
      ];

      for (const startState of terminalStates) {
        for (const t of transitions) {
          const msgId = `m_${startState}_${t.name}`;
          s.swarm.insert({ ...BASE, msgId }, 1_000);

          if (startState === "handed_off") {
            expect(s.swarm.markHandedOff(msgId, 1_500)).toBe(true);
          } else if (startState === "failed") {
            expect(s.swarm.markFailed(msgId, 1_500)).toBe(true);
          } else if (startState === "expired") {
            expect(s.swarm.markExpired(msgId, 1_500)).toBe(true);
          } else if (startState === "cancelled") {
            expect(s.swarm.markCancelled(msgId, 1_500)).toBe(true);
          }
          expect(s.swarm.getByMsgId(msgId)!.state).toBe(startState);

          const isWatchdogException =
            startState === "handed_off" &&
            (t.name === "markFailed" || t.name === "requeueForRecovery");
          const res = t.apply(msgId);

          if (isWatchdogException) {
            expect(res).toBe(true);
            const expectedState = t.name === "markFailed" ? "failed" : "queued";
            expect(s.swarm.getByMsgId(msgId)!.state).toBe(expectedState);
          } else {
            expect(res).toBe(false);
            expect(s.swarm.getByMsgId(msgId)!.state).toBe(startState);
          }
        }
      }

      s.db.close();
    });

    it("persists and reads back deliverAt, expiresAt, and cancelledAt through asRecord", () => {
      const s = createStorage();
      s.swarm.insert(
        {
          ...BASE,
          msgId: "m_sched",
          deliverAt: 10_000,
          expiresAt: 20_000,
        },
        1_000,
      );

      let m = s.swarm.getByMsgId("m_sched");
      expect(m).not.toBeNull();
      expect(m!.deliverAt).toBe(10_000);
      expect(m!.expiresAt).toBe(20_000);
      expect(m!.cancelledAt).toBeNull();

      // Mark cancelled
      const cancelled = s.swarm.markCancelled("m_sched", 15_000);
      expect(cancelled).toBe(true);

      m = s.swarm.getByMsgId("m_sched");
      expect(m!.state).toBe("cancelled");
      expect(m!.cancelledAt).toBe(15_000);

      s.db.close();
    });

    it("enforces state guards on transitions and returns boolean result", () => {
      const s = createStorage();
      s.swarm.insert({ ...BASE, msgId: "m1" }, 1_000);

      // markCancelled on queued row -> succeeds (returns true, state='cancelled', cancelledAt set)
      const cancelRes = s.swarm.markCancelled("m1", 2_000);
      expect(cancelRes).toBe(true);
      let m = s.swarm.getByMsgId("m1");
      expect(m!.state).toBe("cancelled");
      expect(m!.cancelledAt).toBe(2_000);

      // markHandedOff on already cancelled row -> fails (returns false, state remains 'cancelled')
      const handoffRes = s.swarm.markHandedOff("m1", 3_000);
      expect(handoffRes).toBe(false);
      m = s.swarm.getByMsgId("m1");
      expect(m!.state).toBe("cancelled");
      expect(m!.handedOffAt).toBeNull();

      // markExpired on already cancelled row -> fails
      const expireRes = s.swarm.markExpired("m1", 4_000);
      expect(expireRes).toBe(false);
      m = s.swarm.getByMsgId("m1");
      expect(m!.state).toBe("cancelled");

      // Fresh row for markHandedOff -> markCancelled / markExpired
      s.swarm.insert({ ...BASE, msgId: "m2" }, 1_000);
      const handoffOk = s.swarm.markHandedOff("m2", 2_000);
      expect(handoffOk).toBe(true);
      m = s.swarm.getByMsgId("m2");
      expect(m!.state).toBe("handed_off");

      // markCancelled on handed_off row -> fails
      const cancelFail = s.swarm.markCancelled("m2", 3_000);
      expect(cancelFail).toBe(false);
      m = s.swarm.getByMsgId("m2");
      expect(m!.state).toBe("handed_off");

      // markExpired on handed_off row -> fails
      const expireFail = s.swarm.markExpired("m2", 4_000);
      expect(expireFail).toBe(false);
      m = s.swarm.getByMsgId("m2");
      expect(m!.state).toBe("handed_off");

      // Fresh row for markExpired
      s.swarm.insert({ ...BASE, msgId: "m3" }, 1_000);
      const expireOk = s.swarm.markExpired("m3", 2_000);
      expect(expireOk).toBe(true);
      m = s.swarm.getByMsgId("m3");
      expect(m!.state).toBe("expired");

      s.db.close();
    });

    it("listScheduled matches on from_session or to_session, excludes non-scheduled and non-queued rows, ordered by deliver_at ASC", () => {
      const s = createStorage();
      // Scheduled row matching from_session = ses_a
      s.swarm.insert({ ...BASE, msgId: "m1", fromSession: "ses_a", toSession: "ses_b", deliverAt: 20_000 }, 1_000);
      // Scheduled row matching to_session = ses_a
      s.swarm.insert({ ...BASE, msgId: "m2", fromSession: "ses_other", toSession: "ses_a", deliverAt: 10_000 }, 1_000);
      // Scheduled row matching neither
      s.swarm.insert({ ...BASE, msgId: "m3", fromSession: "ses_x", toSession: "ses_y", deliverAt: 15_000 }, 1_000);
      // Non-scheduled row (deliverAt is null) involving ses_a
      s.swarm.insert({ ...BASE, msgId: "m4", fromSession: "ses_a", toSession: "ses_b", deliverAt: null }, 1_000);
      // Scheduled row involving ses_a but handed_off
      s.swarm.insert({ ...BASE, msgId: "m5", fromSession: "ses_a", toSession: "ses_b", deliverAt: 5_000 }, 1_000);
      s.swarm.markHandedOff("m5", 2_000);

      const scheduled = s.swarm.listScheduled("ses_a");
      expect(scheduled.map((m) => m.msgId)).toEqual(["m2", "m1"]);

      s.db.close();
    });

    it("listScheduled with includeTerminalSince includes terminal rows (expired, failed, cancelled) updated >= cutoff", () => {
      const s = createStorage();
      const now = 100_000;
      const cutoff = now - 24 * 60 * 60 * 1000; // 100_000 - 86_400_000 = -86_300_000

      // Queued scheduled row
      s.swarm.insert({ ...BASE, msgId: "m_queued", deliverAt: now + 5000 }, now - 1000);

      // Expired scheduled row updated recently
      s.swarm.insert({ ...BASE, msgId: "m_expired", deliverAt: now - 5000 }, now - 10_000);
      s.swarm.markExpired("m_expired", now - 2000); // updated_at = now - 2000 >= cutoff

      // Failed scheduled row updated recently
      s.swarm.insert({ ...BASE, msgId: "m_failed", deliverAt: now - 5000 }, now - 10_000);
      s.swarm.markFailed("m_failed", now - 3000); // updated_at = now - 3000 >= cutoff

      // Cancelled scheduled row updated recently
      s.swarm.insert({ ...BASE, msgId: "m_cancelled", deliverAt: now - 5000 }, now - 10_000);
      s.swarm.markCancelled("m_cancelled", now - 4000); // updated_at = now - 4000 >= cutoff

      // Ancient expired scheduled row (updated before cutoff)
      s.swarm.insert({ ...BASE, msgId: "m_ancient_expired", deliverAt: now - 100_000_000 }, now - 100_000_000);
      s.swarm.markExpired("m_ancient_expired", now - 90_000_000); // updated_at < cutoff

      // Non-scheduled expired row (deliverAt is null)
      s.swarm.insert({ ...BASE, msgId: "m_nonsched_expired", deliverAt: null }, now - 10_000);
      s.swarm.markExpired("m_nonsched_expired", now - 2000);

      // Handed-off scheduled row (not terminal: delivered)
      s.swarm.insert({ ...BASE, msgId: "m_handed_off", deliverAt: now - 5000 }, now - 10_000);
      s.swarm.markHandedOff("m_handed_off", now - 2000);

      const res = s.swarm.listScheduled("ses_a", { includeTerminalSince: cutoff });
      const ids = res.map((m) => m.msgId).sort();
      expect(ids).toEqual(["m_cancelled", "m_expired", "m_failed", "m_queued"]);

      s.db.close();
    });

    it("listExpired returns only queued rows past expires_at", () => {
      const s = createStorage();
      // Queued row past expires_at (10_000 <= 15_000) -> returned
      s.swarm.insert({ ...BASE, msgId: "m_exp1", expiresAt: 10_000 }, 1_000);
      // Queued row future expires_at (20_000 > 15_000) -> not returned
      s.swarm.insert({ ...BASE, msgId: "m_fut_exp", expiresAt: 20_000 }, 1_000);
      // Queued row null expires_at -> not returned
      s.swarm.insert({ ...BASE, msgId: "m_null_exp", expiresAt: null }, 1_000);
      // Handed off row past expires_at -> not returned (must be queued)
      s.swarm.insert({ ...BASE, msgId: "m_exp_handed", expiresAt: 5_000 }, 1_000);
      s.swarm.markHandedOff("m_exp_handed", 2_000);

      const expired = s.swarm.listExpired(15_000);
      expect(expired.map((m) => m.msgId)).toEqual(["m_exp1"]);

      s.db.close();
    });

    it("listOverdueQueued returns queued rows with deliver_at <= now - thresholdMs", () => {
      const s = createStorage();
      const now = 1_000_000;
      const thresholdMs = 300_000; // 5 minutes

      // Overdue queued row: deliver_at = 600_000 <= 700_000 (now - 300_000)
      s.swarm.insert({ ...BASE, msgId: "m_overdue", deliverAt: 600_000 }, 100_000);

      // Fresh queued row: deliver_at = 950_000 > 700_000
      s.swarm.insert({ ...BASE, msgId: "m_fresh", deliverAt: 950_000 }, 100_000);

      // Overdue but handed_off row: state != 'queued'
      s.swarm.insert({ ...BASE, msgId: "m_delivered", deliverAt: 600_000 }, 100_000);
      s.swarm.markHandedOff("m_delivered", 650_000);

      // Overdue but expired row: state != 'queued'
      s.swarm.insert({ ...BASE, msgId: "m_expired", deliverAt: 600_000 }, 100_000);
      s.swarm.markExpired("m_expired", 650_000);

      // Queued row with null deliver_at
      s.swarm.insert({ ...BASE, msgId: "m_nodeliver", deliverAt: null }, 100_000);

      const overdue = s.swarm.listOverdueQueued(now, thresholdMs);
      expect(overdue.map((m) => m.msgId)).toEqual(["m_overdue"]);

      s.db.close();
    });

    it("cleanupOlderThan deletes expired and cancelled rows as well as verified handed_off and failed", () => {
      const s = createStorage();
      s.swarm.insert({ ...BASE, msgId: "m_handed" }, 1_000);
      s.swarm.markHandedOff("m_handed", 1_000); // updated_at = 1_000
      s.swarm.markVerified("m_handed", 1_000);

      s.swarm.insert({ ...BASE, msgId: "m_failed" }, 1_000);
      s.swarm.markFailed("m_failed", 1_000); // updated_at = 1_000

      s.swarm.insert({ ...BASE, msgId: "m_canc" }, 1_000);
      s.swarm.markCancelled("m_canc", 1_000); // updated_at = 1_000

      s.swarm.insert({ ...BASE, msgId: "m_exp" }, 1_000);
      s.swarm.markExpired("m_exp", 1_000); // updated_at = 1_000

      s.swarm.insert({ ...BASE, msgId: "m_queued" }, 1_000); // updated_at = 1_000

      const cleaned = s.swarm.cleanupOlderThan(5_000);
      expect(cleaned).toBe(4);

      expect(s.swarm.getByMsgId("m_handed")).toBeNull();
      expect(s.swarm.getByMsgId("m_failed")).toBeNull();
      expect(s.swarm.getByMsgId("m_canc")).toBeNull();
      expect(s.swarm.getByMsgId("m_exp")).toBeNull();
      expect(s.swarm.getByMsgId("m_queued")).not.toBeNull();

      s.db.close();
    });

    it("never deletes an unverified handed_off row — recovery and swarm_read may still need it", () => {
      const s = createStorage();
      s.swarm.insert({ ...BASE, msgId: "m_unverified" }, 1_000);
      s.swarm.markHandedOff("m_unverified", 1_000);

      const cleaned = s.swarm.cleanupOlderThan(365 * 24 * 60 * 60 * 1000);
      expect(cleaned).toBe(0);
      expect(s.swarm.getByMsgId("m_unverified")).not.toBeNull();

      s.db.close();
    });

    it("deletes a verified handed_off row older than cutoff only when verified_at is also older than cutoff", () => {
      const s = createStorage();
      const cutoff = 100_000;

      // Handed off long ago (1_000), verified long ago (2_000 < cutoff)
      s.swarm.insert({ ...BASE, msgId: "m_old_verify" }, 1_000);
      s.swarm.markHandedOff("m_old_verify", 1_000);
      s.swarm.markVerified("m_old_verify", 2_000);

      // Handed off long ago (1_000), verified recently (120_000 >= cutoff)
      s.swarm.insert({ ...BASE, msgId: "m_late_verify" }, 1_000);
      s.swarm.markHandedOff("m_late_verify", 1_000);
      s.swarm.markVerified("m_late_verify", 120_000);

      const cleaned = s.swarm.cleanupOlderThan(cutoff);
      expect(cleaned).toBe(1);
      expect(s.swarm.getByMsgId("m_old_verify")).toBeNull();
      expect(s.swarm.getByMsgId("m_late_verify")).not.toBeNull();

      s.db.close();
    });

    it("deletes failed, expired, and cancelled rows older than cutoff regardless of verified_at", () => {
      const s = createStorage();
      s.swarm.insert({ ...BASE, msgId: "m_failed" }, 1_000);
      s.swarm.markFailed("m_failed", 1_000);

      s.swarm.insert({ ...BASE, msgId: "m_exp" }, 1_000);
      s.swarm.markExpired("m_exp", 1_000);

      s.swarm.insert({ ...BASE, msgId: "m_canc" }, 1_000);
      s.swarm.markCancelled("m_canc", 1_000);

      const cleaned = s.swarm.cleanupOlderThan(5_000);
      expect(cleaned).toBe(3);
      expect(s.swarm.getByMsgId("m_failed")).toBeNull();
      expect(s.swarm.getByMsgId("m_exp")).toBeNull();
      expect(s.swarm.getByMsgId("m_canc")).toBeNull();

      s.db.close();
    });

    it("never deletes a queued row even when very old", () => {
      const s = createStorage();
      s.swarm.insert({ ...BASE, msgId: "m_queued" }, 1_000);

      const cleaned = s.swarm.cleanupOlderThan(365 * 24 * 60 * 60 * 1000);
      expect(cleaned).toBe(0);
      expect(s.swarm.getByMsgId("m_queued")).not.toBeNull();

      s.db.close();
    });

    it("deletes an unverified handed_off nudge message older than cutoff", () => {
      const s = createStorage();
      s.swarm.insert({ ...BASE, msgId: "m_nudge", kind: NUDGE_KIND }, 1_000);
      s.swarm.markHandedOff("m_nudge", 1_000);

      const cleaned = s.swarm.cleanupOlderThan(5_000);
      expect(cleaned).toBe(1);
      expect(s.swarm.getByMsgId("m_nudge")).toBeNull();

      s.db.close();
    });

    it("never deletes rows newer than cutoff regardless of state", () => {
      const s = createStorage();
      const cutoff = 5_000;

      s.swarm.insert({ ...BASE, msgId: "m_verified_new" }, 8_000);
      s.swarm.markHandedOff("m_verified_new", 8_000);
      s.swarm.markVerified("m_verified_new", 8_000);

      s.swarm.insert({ ...BASE, msgId: "m_failed_new" }, 8_000);
      s.swarm.markFailed("m_failed_new", 8_000);

      s.swarm.insert({ ...BASE, msgId: "m_nudge_new", kind: NUDGE_KIND }, 8_000);
      s.swarm.markHandedOff("m_nudge_new", 8_000);

      s.swarm.insert({ ...BASE, msgId: "m_canc_new" }, 8_000);
      s.swarm.markCancelled("m_canc_new", 8_000);

      s.swarm.insert({ ...BASE, msgId: "m_exp_new" }, 8_000);
      s.swarm.markExpired("m_exp_new", 8_000);

      const cleaned = s.swarm.cleanupOlderThan(cutoff);
      expect(cleaned).toBe(0);
      expect(s.swarm.getByMsgId("m_verified_new")).not.toBeNull();
      expect(s.swarm.getByMsgId("m_failed_new")).not.toBeNull();
      expect(s.swarm.getByMsgId("m_nudge_new")).not.toBeNull();
      expect(s.swarm.getByMsgId("m_canc_new")).not.toBeNull();
      expect(s.swarm.getByMsgId("m_exp_new")).not.toBeNull();

      s.db.close();
    });

    it("has idx_swarm_scheduled index in schema", () => {
      const s = createStorage();
      const indexes = s.db.prepare("PRAGMA index_list(swarm_messages)").all() as Array<{ name: string }>;
      expect(indexes.map((i) => i.name)).toContain("idx_swarm_scheduled");
      s.db.close();
    });
  });
});

describe("swarm_messages verification column migration", () => {
  function oldSchemaDb(): BetterSqlite3.Database {
    const db = new BetterSqlite3(":memory:");
    db.exec(`
      CREATE TABLE swarm_messages (
        msg_id TEXT PRIMARY KEY,
        from_session TEXT NOT NULL,
        to_session TEXT,
        channel TEXT,
        kind TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        reply_to TEXT,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        handed_off_at INTEGER
      );
    `);
    return db;
  }

  function insertRaw(
    db: BetterSqlite3.Database,
    row: {
      msgId: string;
      state: string;
      updatedAt: number;
      handedOffAt: number | null;
    },
  ): void {
    db.prepare(
      `INSERT INTO swarm_messages
         (msg_id, from_session, to_session, channel, kind, priority, reply_to, payload,
          state, attempts, next_retry_at, created_at, updated_at, handed_off_at)
       VALUES (?, 'ses_a', 'ses_b', NULL, 'chat', 'normal', NULL, 'hello',
               ?, 0, NULL, 1, ?, ?)`,
    ).run(row.msgId, row.state, row.updatedAt, row.handedOffAt);
  }

  it("backfills verified_at = COALESCE(handed_off_at, updated_at) for handed_off rows only, on upgrade", () => {
    const db = oldSchemaDb();

    // handed_off with handed_off_at set: COALESCE should pick handed_off_at.
    insertRaw(db, { msgId: "with_handoff", state: "handed_off", updatedAt: 6_000, handedOffAt: 5_000 });
    // handed_off with handed_off_at NULL: COALESCE should fall back to updated_at.
    insertRaw(db, { msgId: "null_handoff", state: "handed_off", updatedAt: 7_000, handedOffAt: null });
    // not handed_off: must not be backfilled.
    insertRaw(db, { msgId: "still_queued", state: "queued", updatedAt: 8_000, handedOffAt: null });

    initSwarmSchema(db);

    const rows = db
      .prepare("SELECT msg_id, verified_at, requeue_count, aborted_at FROM swarm_messages ORDER BY msg_id")
      .all() as Array<{ msg_id: string; verified_at: number | null; requeue_count: number; aborted_at: number | null }>;

    const find = (msgId: string) => rows.find((r) => r.msg_id === msgId)!;
    expect(find("with_handoff").verified_at).toBe(5_000);
    expect(find("null_handoff").verified_at).toBe(7_000);
    expect(find("still_queued").verified_at).toBeNull();

    // requeue_count defaults to 0, aborted_at defaults to NULL for pre-existing rows.
    expect(find("with_handoff").requeue_count).toBe(0);
    expect(find("with_handoff").aborted_at).toBeNull();

    db.close();
  });

  it("backfills expires_at onto pre-existing queued SCHEDULED rows, and only those", () => {
    // Without this, the first night after deploy is the very bug the feature
    // exists to fix: a wake already banked with expires_at NULL is not covered
    // by the arbiter's outage exemption (gated on having a terminal clock), so
    // it burns the old ~324s budget against the restarting serve pool at 03:00.
    const db = oldSchemaDb();
    initSwarmSchema(db); // get the new columns so we can write deliver_at

    const setSchedule = (msgId: string, deliverAt: number | null, expiresAt: number | null) =>
      db
        .prepare("UPDATE swarm_messages SET deliver_at = ?, expires_at = ? WHERE msg_id = ?")
        .run(deliverAt, expiresAt, msgId);

    insertRaw(db, { msgId: "sched_no_expiry", state: "queued", updatedAt: 1, handedOffAt: null });
    setSchedule("sched_no_expiry", 100_000, null);

    // Explicit expiry must be preserved, not overwritten.
    insertRaw(db, { msgId: "sched_with_expiry", state: "queued", updatedAt: 1, handedOffAt: null });
    setSchedule("sched_with_expiry", 100_000, 123_456);

    // Ordinary /swarm/send row: must stay NULL. Giving it a clock would
    // silently opt it into unbounded uncounted retries.
    insertRaw(db, { msgId: "ordinary", state: "queued", updatedAt: 1, handedOffAt: null });
    setSchedule("ordinary", null, null);

    // Terminal row: no point resurrecting a clock on it.
    insertRaw(db, { msgId: "sched_handed_off", state: "handed_off", updatedAt: 1, handedOffAt: 1 });
    setSchedule("sched_handed_off", 100_000, null);

    initSwarmSchema(db);

    const expiryOf = (msgId: string) =>
      (
        db
          .prepare("SELECT expires_at FROM swarm_messages WHERE msg_id = ?")
          .get(msgId) as { expires_at: number | null }
      ).expires_at;

    expect(expiryOf("sched_no_expiry")).toBe(100_000 + DEFAULT_EXPIRY_MS);
    expect(expiryOf("sched_with_expiry")).toBe(123_456);
    expect(expiryOf("ordinary")).toBeNull();
    expect(expiryOf("sched_handed_off")).toBeNull();

    db.close();
  });

  it("does not re-backfill or overwrite verified_at on a second init call", () => {
    const db = oldSchemaDb();
    insertRaw(db, { msgId: "with_handoff", state: "handed_off", updatedAt: 6_000, handedOffAt: 5_000 });

    initSwarmSchema(db);

    // Simulate the watchdog having since verified this row for real, with a
    // value that would NOT match the backfill formula.
    db.prepare("UPDATE swarm_messages SET verified_at = ? WHERE msg_id = ?").run(9_999, "with_handoff");

    initSwarmSchema(db);

    const row = db
      .prepare("SELECT verified_at FROM swarm_messages WHERE msg_id = ?")
      .get("with_handoff") as { verified_at: number };
    expect(row.verified_at).toBe(9_999);

    db.close();
  });

  it("fresh DB (CREATE TABLE already includes new columns) runs no backfill", () => {
    // A brand-new DB has no pre-existing handed_off rows to backfill; this
    // just confirms initSwarmSchema is idempotent and column presence holds
    // without ever having gone through the ALTER TABLE path.
    const db = new BetterSqlite3(":memory:");
    initSwarmSchema(db);
    initSwarmSchema(db);
    const cols = db.pragma("table_info(swarm_messages)") as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("verified_at");
    expect(names).toContain("requeue_count");
    expect(names).toContain("aborted_at");
    // Present because CREATE TABLE lists it -- which is what this test's name
    // claims. It was briefly true only via the swallow-everything ALTER loop.
    expect(names).toContain("nudge_count");
    db.close();
  });

  it("still adds any still-missing columns if a prior (non-atomic) migration was interrupted after adding verified_at", () => {
    const db = oldSchemaDb();
    insertRaw(db, { msgId: "with_handoff", state: "handed_off", updatedAt: 6_000, handedOffAt: 5_000 });

    // Simulate a previously-interrupted migration: verified_at was added but
    // requeue_count/aborted_at (and the backfill) never ran.
    db.exec("ALTER TABLE swarm_messages ADD COLUMN verified_at INTEGER");

    initSwarmSchema(db);

    const cols = db.pragma("table_info(swarm_messages)") as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("requeue_count");
    expect(names).toContain("aborted_at");
    expect(names).toContain("nudge_count");
    db.close();
  });

  it("rolls back the whole migration (ALTERs + backfill) if interrupted mid-transaction", () => {
    const db = oldSchemaDb();
    insertRaw(db, { msgId: "with_handoff", state: "handed_off", updatedAt: 6_000, handedOffAt: 5_000 });

    const originalExec = db.exec.bind(db);
    const execSpy = vi.spyOn(db, "exec").mockImplementation((sql: string) => {
      if (sql.includes("UPDATE swarm_messages")) {
        throw new Error("simulated crash during backfill");
      }
      return originalExec(sql);
    });

    expect(() => initSwarmSchema(db)).toThrow("simulated crash during backfill");
    execSpy.mockRestore();

    // Because the ALTERs + backfill run inside a single transaction, a
    // failure partway through must roll back the columns added earlier in
    // the same transaction too -- otherwise a later init call would see
    // verified_at already present and would skip the backfill forever.
    const cols = (db.pragma("table_info(swarm_messages)") as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain("verified_at");
    expect(cols).not.toContain("requeue_count");
    expect(cols).not.toContain("aborted_at");

    db.close();
  });

  it("migrates a pre-existing database without ref column cleanly and reads back rows with ref === null", () => {
    const db = oldSchemaDb();
    insertRaw(db, { msgId: "pre_ref_row", state: "queued", updatedAt: 10_000, handedOffAt: null });

    initSwarmSchema(db);

    const repo = new SwarmRepository(db);
    const row = repo.getByMsgId("pre_ref_row");
    expect(row).not.toBeNull();
    expect(row!.ref).toBeNull();

    const cols = db.pragma("table_info(swarm_messages)") as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("ref");

    db.close();
  });
});
