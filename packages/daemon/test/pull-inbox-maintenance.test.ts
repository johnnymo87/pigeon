import { afterEach, describe, expect, it } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { DEFAULT_PULL_TTL_MS, PULL_UNACKED_ALERT_MS } from "../src/storage/pull-inbox-repo";
import { runPullInboxMaintenance } from "../src/pull-inbox-maintenance";

/**
 * Maintenance is where the two silent-drop failures of this feature are caught.
 * Both are failures of SPEECH, not of storage: the message is gone either way,
 * and the only question is whether anyone is told.
 */
describe("pull inbox maintenance", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newDb(): StorageDb {
    storage = openStorageDb(":memory:");
    storage.sessions.upsert(
      { sessionId: "ses_lane", notify: true, backendKind: "goose-pull", label: "maven-renovate" },
      1_000,
    );
    return storage;
  }

  function alerts(s: StorageDb) {
    return s.db.prepare("SELECT source, ref_msg_id, severity, text FROM operational_alerts").all() as Array<{
      source: string;
      ref_msg_id: string;
      severity: string;
      text: string;
    }>;
  }

  // A row expiring unread IS the human's message being dropped.
  // notifySenderOfFailure cannot cover it -- notify-sender.ts returns early for
  // any sender that is not ^ses_, and a Telegram-originated message never is --
  // so if this sweep is quiet, nothing anywhere ever says the message died.
  it("alerts when a banked message expires unread, and names it", () => {
    const s = newDb();
    s.pullInbox.bank(
      { msgId: "m1", sessionId: "ses_lane", source: "telegram-reply", payload: "look at #4259" },
      1_000,
    );
    runPullInboxMaintenance({ storage: s, nowFn: () => 1_000 + DEFAULT_PULL_TTL_MS + 1 });

    const rows = alerts(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref_msg_id).toBe("pull-expired:m1");
    expect(rows[0]!.text).toContain("maven-renovate");
    expect(rows[0]!.text).toContain("look at #4259");
    expect(s.pullInbox.pendingCount("ses_lane", 1_000 + DEFAULT_PULL_TTL_MS + 1)).toBe(0);
  });

  it("says nothing about a message the client read in time", () => {
    const s = newDb();
    s.pullInbox.bank(
      { msgId: "m1", sessionId: "ses_lane", source: "telegram-reply", payload: "hi" },
      1_000,
    );
    s.pullInbox.claim("ses_lane", 1_100);
    s.pullInbox.ack("ses_lane", ["m1"], 1_200);
    runPullInboxMaintenance({ storage: s, nowFn: () => 1_000 + DEFAULT_PULL_TTL_MS + 1 });
    expect(alerts(s)).toEqual([]);
  });

  it("alerts on a claimed message that was never acked, once the threshold passes", () => {
    const s = newDb();
    s.pullInbox.bank(
      { msgId: "m1", sessionId: "ses_lane", source: "telegram-reply", payload: "hi" },
      1_000,
    );
    s.pullInbox.claim("ses_lane", 2_000);

    runPullInboxMaintenance({ storage: s, nowFn: () => 2_000 + 60_000 });
    expect(alerts(s)).toEqual([]);

    runPullInboxMaintenance({ storage: s, nowFn: () => 2_000 + PULL_UNACKED_ALERT_MS + 1 });
    const rows = alerts(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref_msg_id).toBe("pull-unacked:m1");
  });

  // Durability, not politeness. Every dedupe set in the delivery watchdog is
  // in-memory, so a permanently stuck row re-alerts on each daemon restart -- and
  // a permanently stuck row is exactly the population that survives restarts.
  it("does not repeat the unacked alert on every cycle", () => {
    const s = newDb();
    s.pullInbox.bank(
      { msgId: "m1", sessionId: "ses_lane", source: "telegram-reply", payload: "hi" },
      1_000,
    );
    s.pullInbox.claim("ses_lane", 2_000);
    runPullInboxMaintenance({ storage: s, nowFn: () => 2_000 + PULL_UNACKED_ALERT_MS + 1 });
    runPullInboxMaintenance({ storage: s, nowFn: () => 2_000 + PULL_UNACKED_ALERT_MS + 99_999 });
    expect(alerts(s)).toHaveLength(1);
  });

  it("reaps acked rows so the table does not grow without a reader", () => {
    const s = newDb();
    s.pullInbox.bank(
      { msgId: "m1", sessionId: "ses_lane", source: "telegram-reply", payload: "hi" },
      1_000,
    );
    s.pullInbox.claim("ses_lane", 1_100);
    s.pullInbox.ack("ses_lane", ["m1"], 1_200);
    runPullInboxMaintenance({ storage: s, nowFn: () => 1_200 + 8 * 24 * 60 * 60 * 1000 });
    const remaining = s.db.prepare("SELECT COUNT(*) AS n FROM pull_inbox").get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("survives a session row that has already been reaped", () => {
    const s = newDb();
    s.pullInbox.bank(
      { msgId: "m1", sessionId: "ses_gone", source: "telegram-reply", payload: "orphan" },
      1_000,
    );
    expect(() =>
      runPullInboxMaintenance({ storage: s, nowFn: () => 1_000 + DEFAULT_PULL_TTL_MS + 1 }),
    ).not.toThrow();
    expect(alerts(s)).toHaveLength(1);
  });
});
