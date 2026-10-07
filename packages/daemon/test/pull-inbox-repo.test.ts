import { initPullInboxSchema } from "../src/storage/pull-inbox-schema";
import { afterEach, describe, expect, it } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { DEFAULT_PULL_TTL_MS } from "../src/storage/pull-inbox-repo";

/**
 * The bank behind the goose-pull backend.
 *
 * These cases exist because the FIRST design banked inbound as `queued` rows in
 * `swarm_messages`, and adversarial review found three independently fatal
 * consequences: a queued row has no bound once the arbiter is skipped for the
 * target, `markVerified` carries no ownership guard (`WHERE msg_id = ?` alone),
 * and `verified_at` would have acquired a second, weaker meaning table-wide.
 * Every guard asserted below is one of those three, restated as behaviour.
 */
describe("PullInboxRepository", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newDb(): StorageDb {
    storage = openStorageDb(":memory:");
    return storage;
  }

  function bank(s: StorageDb, msgId: string, sessionId = "ses_pull", now = 1_000, extra = {}) {
    return s.pullInbox.bank(
      {
        msgId,
        sessionId,
        source: "telegram-reply",
        payload: `payload ${msgId}`,
        ...extra,
      },
      now,
    );
  }

  it("banks a row and reports it pending", () => {
    const s = newDb();
    expect(bank(s, "m1")).toBe(true);
    expect(s.pullInbox.pendingCount("ses_pull", 2_000)).toBe(1);
  });

  it("is idempotent on msg_id, so a redelivered command banks once", () => {
    const s = newDb();
    expect(bank(s, "m1")).toBe(true);
    expect(bank(s, "m1")).toBe(false);
    expect(s.pullInbox.pendingCount("ses_pull", 2_000)).toBe(1);
  });

  it("claims only rows addressed to the asking session", () => {
    const s = newDb();
    bank(s, "mine", "ses_pull");
    bank(s, "theirs", "ses_other");
    const claimed = s.pullInbox.claim("ses_pull", 2_000);
    expect(claimed.map((r) => r.msgId)).toEqual(["mine"]);
    expect(s.pullInbox.pendingCount("ses_other", 2_000)).toBe(1);
  });

  it("returns rows oldest first and honours the limit", () => {
    const s = newDb();
    bank(s, "m1", "ses_pull", 1_000);
    bank(s, "m2", "ses_pull", 1_100);
    bank(s, "m3", "ses_pull", 1_200);
    expect(s.pullInbox.claim("ses_pull", 2_000, 2).map((r) => r.msgId)).toEqual(["m1", "m2"]);
  });

  // THE RECOVERY PROPERTY. The first draft claimed then alarmed, with no way back:
  // a kill between claim and ack (a real event for a time-limited client) lost the
  // message and left a row nothing could clean. Re-serving is at-least-once, which
  // is the strongest honest guarantee available across a process boundary.
  it("re-serves a claimed row that was never acked, and says it is a redelivery", () => {
    const s = newDb();
    bank(s, "m1");
    const first = s.pullInbox.claim("ses_pull", 2_000);
    expect(first[0]!.claimCount).toBe(1);
    const second = s.pullInbox.claim("ses_pull", 3_000);
    expect(second.map((r) => r.msgId)).toEqual(["m1"]);
    expect(second[0]!.claimCount).toBe(2);
    // First-claim time is preserved: it is the clock the unacked alarm measures.
    expect(second[0]!.claimedAt).toBe(2_000);
  });

  // THE SAME PROPERTY, ASSERTED WHERE IT ACTUALLY BITES. The assertion above
  // passed even with COALESCE removed from the UPDATE, because the returned
  // record is synthesised from the pre-update row -- it was testing the response
  // shape, not the stored clock. Mutation testing found that; this case is the
  // repair. A claim that refreshed `claimed_at` would let the alarm's clock be
  // reset by the very loop it is watching, so a client stuck in a
  // claim-crash-claim cycle would never be reported: quiet when healthy AND
  // quiet when broken, which is the exact fake-health twin that already silenced
  // a stall alarm elsewhere.
  it("a redelivery does not reset the unacked alarm's clock", () => {
    const s = newDb();
    bank(s, "m1", "ses_pull", 1_000);
    s.pullInbox.claim("ses_pull", 2_000);
    s.pullInbox.claim("ses_pull", 2_000 + 60 * 60_000);
    const due = s.pullInbox.listUnackedForAlert(2_000 + 60 * 60_000 + 1, 30 * 60_000);
    expect(due.map((r) => r.msgId)).toEqual(["m1"]);
  });

  it("stops serving a row once it is acked", () => {
    const s = newDb();
    bank(s, "m1");
    s.pullInbox.claim("ses_pull", 2_000);
    expect(s.pullInbox.ack("ses_pull", ["m1"], 2_500)).toEqual({ acked: ["m1"], rejected: [] });
    expect(s.pullInbox.claim("ses_pull", 3_000)).toEqual([]);
    expect(s.pullInbox.pendingCount("ses_pull", 3_000)).toBe(0);
  });

  // OWNERSHIP. This is the guard whose ABSENCE on swarm's markVerified
  // (swarm-repo.ts:296, `WHERE msg_id = ?`) killed the first design: exposed over
  // HTTP on a box where every process shares one bearer token, an ack without an
  // ownership check is a forgery primitive against another session's mail.
  it("refuses to ack a row belonging to another session, and names the rejection", () => {
    const s = newDb();
    bank(s, "theirs", "ses_other");
    s.pullInbox.claim("ses_other", 2_000);
    expect(s.pullInbox.ack("ses_pull", ["theirs"], 2_500)).toEqual({
      acked: [],
      rejected: ["theirs"],
    });
    expect(s.pullInbox.pendingCount("ses_other", 3_000)).toBe(1);
  });

  it("refuses to ack a row that was never claimed", () => {
    const s = newDb();
    bank(s, "m1");
    expect(s.pullInbox.ack("ses_pull", ["m1"], 2_500)).toEqual({ acked: [], rejected: ["m1"] });
    expect(s.pullInbox.pendingCount("ses_pull", 3_000)).toBe(1);
  });

  it("refuses to ack an unknown msg_id rather than reporting success", () => {
    const s = newDb();
    expect(s.pullInbox.ack("ses_pull", ["nope"], 2_500)).toEqual({ acked: [], rejected: ["nope"] });
  });

  it("reports a second ack of the same row as rejected, not as a fresh success", () => {
    const s = newDb();
    bank(s, "m1");
    s.pullInbox.claim("ses_pull", 2_000);
    s.pullInbox.ack("ses_pull", ["m1"], 2_500);
    expect(s.pullInbox.ack("ses_pull", ["m1"], 9_999)).toEqual({ acked: [], rejected: ["m1"] });
  });

  it("defaults expiry to the session TTL and stops serving an expired row", () => {
    const s = newDb();
    bank(s, "m1", "ses_pull", 1_000);
    const [row] = s.pullInbox.claim("ses_pull", 1_500);
    expect(row!.expiresAt).toBe(1_000 + DEFAULT_PULL_TTL_MS);
    expect(s.pullInbox.claim("ses_pull", 1_000 + DEFAULT_PULL_TTL_MS + 1)).toEqual([]);
    expect(s.pullInbox.pendingCount("ses_pull", 1_000 + DEFAULT_PULL_TTL_MS + 1)).toBe(0);
  });

  // A row that expires unread is the human's message being dropped. It must not
  // vanish quietly: notifySenderOfFailure cannot cover it (notify-sender.ts:103
  // returns early for any sender that is not ^ses_), so the sweep is the only
  // place that can say so, and it returns the rows so the caller can.
  it("sweeps expired unacked rows, returns them once, and does not return them twice", () => {
    const s = newDb();
    bank(s, "m1", "ses_pull", 1_000);
    const past = 1_000 + DEFAULT_PULL_TTL_MS + 1;
    expect(s.pullInbox.sweepExpired(past).map((r) => r.msgId)).toEqual(["m1"]);
    expect(s.pullInbox.sweepExpired(past)).toEqual([]);
  });

  it("does not sweep a row the client already acked", () => {
    const s = newDb();
    bank(s, "m1", "ses_pull", 1_000);
    s.pullInbox.claim("ses_pull", 1_100);
    s.pullInbox.ack("ses_pull", ["m1"], 1_200);
    expect(s.pullInbox.sweepExpired(1_000 + DEFAULT_PULL_TTL_MS + 1)).toEqual([]);
  });

  // The alarm is DURABLE, not an in-memory Set. Every dedupe set in
  // delivery-watchdog.ts is per-process, so a permanently stuck row re-alerts on
  // every daemon restart; a stuck row is exactly the population most likely to
  // outlive many restarts.
  it("reports a claimed-but-unacked row once, and only after the threshold", () => {
    const s = newDb();
    bank(s, "m1", "ses_pull", 1_000);
    s.pullInbox.claim("ses_pull", 2_000);
    expect(s.pullInbox.listUnackedForAlert(2_000 + 10, 30 * 60_000)).toEqual([]);
    const due = s.pullInbox.listUnackedForAlert(2_000 + 30 * 60_000 + 1, 30 * 60_000);
    expect(due.map((r) => r.msgId)).toEqual(["m1"]);
    expect(s.pullInbox.listUnackedForAlert(2_000 + 99 * 60_000, 30 * 60_000)).toEqual([]);
  });

  it("never reports an acked row as unacked", () => {
    const s = newDb();
    bank(s, "m1", "ses_pull", 1_000);
    s.pullInbox.claim("ses_pull", 2_000);
    s.pullInbox.ack("ses_pull", ["m1"], 2_100);
    expect(s.pullInbox.listUnackedForAlert(2_000 + 99 * 60_000, 30 * 60_000)).toEqual([]);
  });

  it("adds the new columns to a table left by an earlier build, keeping its rows", () => {
    const raw = openStorageDb(":memory:");
    raw.db.exec("DROP TABLE pull_inbox");
    raw.db.exec(`CREATE TABLE pull_inbox (
      msg_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source TEXT NOT NULL,
      payload TEXT NOT NULL, question_request_id TEXT, answer_kind TEXT, chat_id TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, claimed_at INTEGER,
      claim_count INTEGER NOT NULL DEFAULT 0, acked_at INTEGER, unacked_alerted_at INTEGER)`);
    raw.db.exec(`INSERT INTO pull_inbox (msg_id, session_id, source, payload, created_at, expires_at)
      VALUES ('old', 'ses_pull', 'telegram-reply', 'kept', 1000, 99999999)`);
    initPullInboxSchema(raw.db);
    expect(
      raw.pullInbox.bank(
        {
          msgId: "new",
          sessionId: "ses_pull",
          source: "telegram-reply",
          payload: "x",
          senderId: "1",
          inReplyTo: "prior",
          inReplyToQuote: "quote",
        },
        1_000,
      ),
    ).toBe(true);
    expect(raw.pullInbox.pendingCount("ses_pull", 2_000)).toBe(2);
    const claimed = raw.pullInbox.claim("ses_pull", 2_000);
    const newRow = claimed.find((r) => r.msgId === "new");
    expect(newRow?.inReplyToQuote).toBe("quote");
    raw.db.close();
  });

  it("leaves a row whose notice failed to record while deleting other expired rows", () => {
    const s = newDb();
    bank(s, "m1", "ses_pull", 1_000);
    bank(s, "m2", "ses_pull", 1_000);
    const deleted = s.pullInbox.sweepExpired(1_000 + 8 * 24 * 3_600_000, (row) => {
      if (row.msgId === "m1") throw new Error("alerts table unavailable");
    });
    expect(deleted.map((r) => r.msgId)).toEqual(["m2"]);
    const remaining = s.db.prepare("SELECT msg_id FROM pull_inbox").all() as Array<{ msg_id: string }>;
    expect(remaining.map((r) => r.msg_id)).toEqual(["m1"]);
  });

  it("carries the sender id, replied-to bot text, and partial quote", () => {
    const s = newDb();
    bank(s, "a1", "ses_pull", 1_000, {
      senderId: "1001",
      inReplyTo: "Rebase or wait?",
      inReplyToQuote: "wait?",
    });
    const [row] = s.pullInbox.claim("ses_pull", 2_000);
    expect(row!.senderId).toBe("1001");
    expect(row!.inReplyTo).toBe("Rebase or wait?");
    expect(row!.inReplyToQuote).toBe("wait?");
  });

  it("reaps acked rows after the retention window, and keeps unacked ones", () => {
    const s = newDb();
    bank(s, "acked", "ses_pull", 1_000);
    bank(s, "unacked", "ses_pull", 1_000);
    s.pullInbox.claim("ses_pull", 1_100);
    s.pullInbox.ack("ses_pull", ["acked"], 1_200);
    expect(s.pullInbox.cleanupAcked(2_000)).toBe(1);
    expect(s.pullInbox.pendingCount("ses_pull", 2_000)).toBe(1);
  });

  it("banks a swarm row with kind and replyTo", () => {
    const s = newDb();
    expect(
      s.pullInbox.bank(
        {
          msgId: "sw1",
          sessionId: "ses_pull",
          source: "swarm",
          payload: "swarm payload",
          senderId: "ses_peer",
          kind: "chat",
          replyTo: "orig_msg_1",
        },
        1_000,
      ),
    ).toBe(true);
    const claimed = s.pullInbox.claim("ses_pull", 2_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.source).toBe("swarm");
    expect(claimed[0]!.kind).toBe("chat");
    expect(claimed[0]!.replyTo).toBe("orig_msg_1");
    expect(claimed[0]!.senderId).toBe("ses_peer");
  });

  it("claims telegram-reply rows before swarm rows regardless of created_at, then created_at, msg_id", () => {
    const s = newDb();
    // Swarm message banked earlier
    s.pullInbox.bank(
      { msgId: "s1", sessionId: "ses_pull", source: "swarm", payload: "sw1" },
      1_000,
    );
    // Telegram-reply message banked later
    s.pullInbox.bank(
      { msgId: "t1", sessionId: "ses_pull", source: "telegram-reply", payload: "tg1" },
      2_000,
    );
    // Second telegram-reply banked between them
    s.pullInbox.bank(
      { msgId: "t0", sessionId: "ses_pull", source: "telegram-reply", payload: "tg0" },
      1_500,
    );
    // Second swarm banked earliest
    s.pullInbox.bank(
      { msgId: "s0", sessionId: "ses_pull", source: "swarm", payload: "sw0" },
      500,
    );

    const claimed = s.pullInbox.claim("ses_pull", 3_000, 10);
    expect(claimed.map((r) => r.msgId)).toEqual(["t0", "t1", "s0", "s1"]);

    // Limit=1 claim: telegram-reply is claimed, peer swarm chatter never crowds it out
    const s2 = newDb();
    s2.pullInbox.bank({ msgId: "s1", sessionId: "ses_pull", source: "swarm", payload: "sw" }, 1_000);
    s2.pullInbox.bank({ msgId: "t1", sessionId: "ses_pull", source: "telegram-reply", payload: "tg" }, 2_000);
    const top1 = s2.pullInbox.claim("ses_pull", 3_000, 1);
    expect(top1.map((r) => r.msgId)).toEqual(["t1"]);
  });

  it("pendingCounts reports total and counts by source, always having both keys", () => {
    const s = newDb();
    s.pullInbox.bank({ msgId: "t1", sessionId: "ses_pull", source: "telegram-reply", payload: "tg" }, 1_000);
    s.pullInbox.bank({ msgId: "s1", sessionId: "ses_pull", source: "swarm", payload: "sw1" }, 1_000);
    s.pullInbox.bank({ msgId: "s2", sessionId: "ses_pull", source: "swarm", payload: "sw2" }, 1_000);

    const counts = s.pullInbox.pendingCounts("ses_pull", 2_000);
    expect(counts.total).toBe(3);
    expect(counts.bySource).toEqual({
      "telegram-reply": 1,
      swarm: 2,
    });

    const emptyCounts = s.pullInbox.pendingCounts("ses_none", 2_000);
    expect(emptyCounts.total).toBe(0);
    expect(emptyCounts.bySource).toEqual({
      "telegram-reply": 0,
      swarm: 0,
    });
  });

  it("filters out swarm rows from claim, pendingCounts, and pendingCount when includeSwarm is false", () => {
    const s = newDb();
    s.pullInbox.bank({ msgId: "t1", sessionId: "ses_pull", source: "telegram-reply", payload: "tg" }, 1_000);
    s.pullInbox.bank({ msgId: "s1", sessionId: "ses_pull", source: "swarm", payload: "sw1" }, 1_000);
    s.pullInbox.bank({ msgId: "s2", sessionId: "ses_pull", source: "swarm", payload: "sw2" }, 1_000);

    // Default includeSwarm is true
    expect(s.pullInbox.pendingCount("ses_pull", 2_000)).toBe(3);
    expect(s.pullInbox.pendingCounts("ses_pull", 2_000).total).toBe(3);
    expect(s.pullInbox.pendingCounts("ses_pull", 2_000).bySource).toEqual({
      "telegram-reply": 1,
      swarm: 2,
    });

    // includeSwarm: false
    expect(s.pullInbox.pendingCount("ses_pull", 2_000, { includeSwarm: false })).toBe(1);
    const filteredCounts = s.pullInbox.pendingCounts("ses_pull", 2_000, { includeSwarm: false });
    expect(filteredCounts.total).toBe(1);
    expect(filteredCounts.bySource).toEqual({
      "telegram-reply": 1,
      swarm: 0,
    });

    // claim with includeSwarm: false
    const claimedWithoutSwarm = s.pullInbox.claim("ses_pull", 2_000, 50, { includeSwarm: false });
    expect(claimedWithoutSwarm.map((r) => r.msgId)).toEqual(["t1"]);

    // Ack the claimed telegram row
    s.pullInbox.ack("ses_pull", ["t1"], 2_000);

    // Subsequent claim with includeSwarm: true (or default) claims the held swarm rows
    const claimedWithSwarm = s.pullInbox.claim("ses_pull", 2_000, 50, { includeSwarm: true });
    expect(claimedWithSwarm.map((r) => r.msgId)).toEqual(["s1", "s2"]);
  });

  it("migrates existing pull_inbox table by adding kind and reply_to columns", () => {
    const raw = openStorageDb(":memory:");
    raw.db.exec("DROP TABLE pull_inbox");
    raw.db.exec(`CREATE TABLE pull_inbox (
      msg_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source TEXT NOT NULL,
      payload TEXT NOT NULL, sender_id TEXT, in_reply_to TEXT, in_reply_to_quote TEXT,
      chat_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      claimed_at INTEGER, claim_count INTEGER NOT NULL DEFAULT 0, acked_at INTEGER,
      unacked_alerted_at INTEGER)`);
    raw.db.exec(`INSERT INTO pull_inbox (msg_id, session_id, source, payload, created_at, expires_at)
      VALUES ('existing', 'ses_pull', 'telegram-reply', 'text', 1000, 99999999)`);
    initPullInboxSchema(raw.db);
    expect(
      raw.pullInbox.bank(
        {
          msgId: "migrated_swarm",
          sessionId: "ses_pull",
          source: "swarm",
          payload: "payload",
          kind: "chat",
          replyTo: "m_prev",
        },
        1_000,
      ),
    ).toBe(true);
    const claimed = raw.pullInbox.claim("ses_pull", 2_000);
    const swarmRow = claimed.find((r) => r.msgId === "migrated_swarm");
    expect(swarmRow?.kind).toBe("chat");
    expect(swarmRow?.replyTo).toBe("m_prev");
    raw.db.close();
  });
});
