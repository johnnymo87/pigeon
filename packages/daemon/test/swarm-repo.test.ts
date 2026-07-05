import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { initSwarmSchema } from "../src/storage/swarm-schema";

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
    it("fresh DB has verified_at, requeue_count, aborted_at columns", () => {
      const s = createStorage();
      const cols = s.db.pragma("table_info(swarm_messages)") as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain("verified_at");
      expect(names).toContain("requeue_count");
      expect(names).toContain("aborted_at");

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
    db.close();
  });
});
