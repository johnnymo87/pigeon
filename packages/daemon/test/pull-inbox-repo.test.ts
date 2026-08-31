import { afterEach, describe, expect, it } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { DEFAULT_PULL_TTL_MS } from "../src/storage/pull-inbox-repo";

/**
 * The bank behind the goose-pull backend (bead eng-agent-platform-sdk, SDD §13.2).
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

  function bank(s: StorageDb, msgId: string, sessionId = "ses_lane", now = 1_000, extra = {}) {
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
    expect(s.pullInbox.pendingCount("ses_lane", 2_000)).toBe(1);
  });

  it("is idempotent on msg_id, so a redelivered command banks once", () => {
    const s = newDb();
    expect(bank(s, "m1")).toBe(true);
    expect(bank(s, "m1")).toBe(false);
    expect(s.pullInbox.pendingCount("ses_lane", 2_000)).toBe(1);
  });

  it("claims only rows addressed to the asking session", () => {
    const s = newDb();
    bank(s, "mine", "ses_lane");
    bank(s, "theirs", "ses_other");
    const claimed = s.pullInbox.claim("ses_lane", 2_000);
    expect(claimed.map((r) => r.msgId)).toEqual(["mine"]);
    expect(s.pullInbox.pendingCount("ses_other", 2_000)).toBe(1);
  });

  it("returns rows oldest first and honours the limit", () => {
    const s = newDb();
    bank(s, "m1", "ses_lane", 1_000);
    bank(s, "m2", "ses_lane", 1_100);
    bank(s, "m3", "ses_lane", 1_200);
    expect(s.pullInbox.claim("ses_lane", 2_000, 2).map((r) => r.msgId)).toEqual(["m1", "m2"]);
  });

  // THE RECOVERY PROPERTY. The first draft claimed then alarmed, with no way back:
  // a SIGKILL between claim and ack (a real event at TimeoutStartSec=3h) lost the
  // message and left a row nothing could clean. Re-serving is at-least-once, which
  // is the strongest honest guarantee available across a process boundary.
  it("re-serves a claimed row that was never acked, and says it is a redelivery", () => {
    const s = newDb();
    bank(s, "m1");
    const first = s.pullInbox.claim("ses_lane", 2_000);
    expect(first[0]!.claimCount).toBe(1);
    const second = s.pullInbox.claim("ses_lane", 3_000);
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
  // a stall alarm in the consuming project.
  it("a redelivery does not reset the unacked alarm's clock", () => {
    const s = newDb();
    bank(s, "m1", "ses_lane", 1_000);
    s.pullInbox.claim("ses_lane", 2_000);
    s.pullInbox.claim("ses_lane", 2_000 + 60 * 60_000);
    const due = s.pullInbox.listUnackedForAlert(2_000 + 60 * 60_000 + 1, 30 * 60_000);
    expect(due.map((r) => r.msgId)).toEqual(["m1"]);
  });

  it("stops serving a row once it is acked", () => {
    const s = newDb();
    bank(s, "m1");
    s.pullInbox.claim("ses_lane", 2_000);
    expect(s.pullInbox.ack("ses_lane", ["m1"], 2_500)).toEqual({ acked: ["m1"], rejected: [] });
    expect(s.pullInbox.claim("ses_lane", 3_000)).toEqual([]);
    expect(s.pullInbox.pendingCount("ses_lane", 3_000)).toBe(0);
  });

  // OWNERSHIP. This is the guard whose ABSENCE on swarm's markVerified
  // (swarm-repo.ts:296, `WHERE msg_id = ?`) killed the first design: exposed over
  // HTTP on a box where every process shares one bearer token, an ack without an
  // ownership check is a forgery primitive against another session's mail.
  it("refuses to ack a row belonging to another session, and names the rejection", () => {
    const s = newDb();
    bank(s, "theirs", "ses_other");
    s.pullInbox.claim("ses_other", 2_000);
    expect(s.pullInbox.ack("ses_lane", ["theirs"], 2_500)).toEqual({
      acked: [],
      rejected: ["theirs"],
    });
    expect(s.pullInbox.pendingCount("ses_other", 3_000)).toBe(1);
  });

  it("refuses to ack a row that was never claimed", () => {
    const s = newDb();
    bank(s, "m1");
    expect(s.pullInbox.ack("ses_lane", ["m1"], 2_500)).toEqual({ acked: [], rejected: ["m1"] });
    expect(s.pullInbox.pendingCount("ses_lane", 3_000)).toBe(1);
  });

  it("refuses to ack an unknown msg_id rather than reporting success", () => {
    const s = newDb();
    expect(s.pullInbox.ack("ses_lane", ["nope"], 2_500)).toEqual({ acked: [], rejected: ["nope"] });
  });

  it("reports a second ack of the same row as rejected, not as a fresh success", () => {
    const s = newDb();
    bank(s, "m1");
    s.pullInbox.claim("ses_lane", 2_000);
    s.pullInbox.ack("ses_lane", ["m1"], 2_500);
    expect(s.pullInbox.ack("ses_lane", ["m1"], 9_999)).toEqual({ acked: [], rejected: ["m1"] });
  });

  it("defaults expiry to the session TTL and stops serving an expired row", () => {
    const s = newDb();
    bank(s, "m1", "ses_lane", 1_000);
    const [row] = s.pullInbox.claim("ses_lane", 1_500);
    expect(row!.expiresAt).toBe(1_000 + DEFAULT_PULL_TTL_MS);
    expect(s.pullInbox.claim("ses_lane", 1_000 + DEFAULT_PULL_TTL_MS + 1)).toEqual([]);
    expect(s.pullInbox.pendingCount("ses_lane", 1_000 + DEFAULT_PULL_TTL_MS + 1)).toBe(0);
  });

  // A row that expires unread is the human's message being dropped. It must not
  // vanish quietly: notifySenderOfFailure cannot cover it (notify-sender.ts:103
  // returns early for any sender that is not ^ses_), so the sweep is the only
  // place that can say so, and it returns the rows so the caller can.
  it("sweeps expired unacked rows, returns them once, and does not return them twice", () => {
    const s = newDb();
    bank(s, "m1", "ses_lane", 1_000);
    const past = 1_000 + DEFAULT_PULL_TTL_MS + 1;
    expect(s.pullInbox.sweepExpired(past).map((r) => r.msgId)).toEqual(["m1"]);
    expect(s.pullInbox.sweepExpired(past)).toEqual([]);
  });

  it("does not sweep a row the lane already acked", () => {
    const s = newDb();
    bank(s, "m1", "ses_lane", 1_000);
    s.pullInbox.claim("ses_lane", 1_100);
    s.pullInbox.ack("ses_lane", ["m1"], 1_200);
    expect(s.pullInbox.sweepExpired(1_000 + DEFAULT_PULL_TTL_MS + 1)).toEqual([]);
  });

  // The alarm is DURABLE, not an in-memory Set. Every dedupe set in
  // delivery-watchdog.ts is per-process, so a permanently stuck row re-alerts on
  // every daemon restart; a stuck row is exactly the population most likely to
  // outlive many restarts.
  it("reports a claimed-but-unacked row once, and only after the threshold", () => {
    const s = newDb();
    bank(s, "m1", "ses_lane", 1_000);
    s.pullInbox.claim("ses_lane", 2_000);
    expect(s.pullInbox.listUnackedForAlert(2_000 + 10, 30 * 60_000)).toEqual([]);
    const due = s.pullInbox.listUnackedForAlert(2_000 + 30 * 60_000 + 1, 30 * 60_000);
    expect(due.map((r) => r.msgId)).toEqual(["m1"]);
    expect(s.pullInbox.listUnackedForAlert(2_000 + 99 * 60_000, 30 * 60_000)).toEqual([]);
  });

  it("never reports an acked row as unacked", () => {
    const s = newDb();
    bank(s, "m1", "ses_lane", 1_000);
    s.pullInbox.claim("ses_lane", 2_000);
    s.pullInbox.ack("ses_lane", ["m1"], 2_100);
    expect(s.pullInbox.listUnackedForAlert(2_000 + 99 * 60_000, 30 * 60_000)).toEqual([]);
  });

  it("carries the question request id so an answer can be validated at drain", () => {
    const s = newDb();
    bank(s, "a1", "ses_lane", 1_000, {
      source: "question-answer",
      questionRequestId: "req-7",
    });
    const [row] = s.pullInbox.claim("ses_lane", 2_000);
    expect(row!.source).toBe("question-answer");
    expect(row!.questionRequestId).toBe("req-7");
  });

  it("reaps acked rows after the retention window, and keeps unacked ones", () => {
    const s = newDb();
    bank(s, "acked", "ses_lane", 1_000);
    bank(s, "unacked", "ses_lane", 1_000);
    s.pullInbox.claim("ses_lane", 1_100);
    s.pullInbox.ack("ses_lane", ["acked"], 1_200);
    expect(s.pullInbox.cleanupAcked(2_000)).toBe(1);
    expect(s.pullInbox.pendingCount("ses_lane", 2_000)).toBe(1);
  });
});
