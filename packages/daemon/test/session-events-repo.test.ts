import { describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { initSessionEventsSchema, SESSION_EVENTS_RETENTION_MS } from "../src/storage/session-events-schema";
import { SessionEventsRepo } from "../src/storage/session-events-repo";
import { SESSION_TTL_MS } from "../src/storage/schema";

function seeded() {
  const db = new BetterSqlite3(":memory:");
  initSessionEventsSchema(db);
  return { db, repo: new SessionEventsRepo(db) };
}

describe("session events schema", () => {
  it("creates both tables and is idempotent", () => {
    const db = new BetterSqlite3(":memory:");
    initSessionEventsSchema(db);
    initSessionEventsSchema(db); // must not throw
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toContain("session_events");
    expect(names).toContain("session_reads");
  });

  // Load-bearing. Without AUTOINCREMENT, SQLite reuses max(existing)+1, so an id
  // freed by the prune can land BELOW a stale watermark and be permanently
  // invisible -- a silent undercount, not a visible error.
  it("never reuses an id after the newest row is deleted", () => {
    const { db } = seeded();
    const ins = db.prepare(
      "INSERT INTO session_events (session_id, notification_id, kind, sent_at) VALUES (?,?,?,?)",
    );
    ins.run("s1", "n1", "stop", 1000);
    const first = db.prepare("SELECT MAX(id) AS id FROM session_events").get() as { id: number };
    db.exec("DELETE FROM session_events");
    ins.run("s1", "n2", "stop", 2000);
    const second = db.prepare("SELECT MAX(id) AS id FROM session_events").get() as { id: number };
    expect(second.id).toBeGreaterThan(first.id);
  });

  // Pins the mechanism, not just its effect: a bare INTEGER PRIMARY KEY would pass
  // the test above whenever sqlite_sequence happens to agree, so assert the DDL.
  it("declares AUTOINCREMENT, which sqlite_sequence depends on", () => {
    const { db } = seeded();
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE name='session_events'")
      .get() as { sql: string };
    expect(ddl.sql).toMatch(/AUTOINCREMENT/i);
    const seq = db.prepare("SELECT name FROM sqlite_master WHERE name='sqlite_sequence'").all();
    expect(seq.length).toBe(1);
  });

  // The retention constant is a multiple of the session TTL rather than a literal so
  // the two cannot drift apart. It is a margin, not a guarantee -- see the design doc.
  it("derives retention from SESSION_TTL_MS rather than hardcoding a span", () => {
    expect(SESSION_EVENTS_RETENTION_MS).toBe(2 * SESSION_TTL_MS);
  });
});

describe("session events repo", () => {
  it("counts only events above the watermark", () => {
    const { repo } = seeded();
    repo.append({ sessionId: "s1", notificationId: "n1", kind: "stop", sentAt: 1 });
    const second = repo.append({ sessionId: "s1", notificationId: "n2", kind: "stop", sentAt: 2 });
    repo.advanceRead("s1", second, 100);
    repo.append({ sessionId: "s1", notificationId: "n3", kind: "stop", sentAt: 3 });
    expect(repo.unreadBySession().get("s1")?.unread).toBe(1);
  });

  it("excludes the user's own mirrored prompts", () => {
    const { repo } = seeded();
    repo.append({ sessionId: "s1", notificationId: "n1", kind: "mirror", sentAt: 1 });
    repo.append({ sessionId: "s1", notificationId: "n2", kind: "swarm", sentAt: 2 });
    expect(repo.unreadBySession().get("s1")?.unread).toBe(1);
  });

  it("counts unknown kinds -- topic-visible is the safe default", () => {
    const { repo } = seeded();
    repo.append({ sessionId: "s1", notificationId: "n1", kind: "something-new", sentAt: 1 });
    expect(repo.unreadBySession().get("s1")?.unread).toBe(1);
  });

  it("advanceRead is monotonic and absorbs out-of-order and duplicate writes", () => {
    const { repo } = seeded();
    repo.append({ sessionId: "s1", notificationId: "n1", kind: "stop", sentAt: 1 });
    repo.append({ sessionId: "s1", notificationId: "n2", kind: "stop", sentAt: 2 });
    repo.advanceRead("s1", 2, 100);

    // Assert IMMEDIATELY after the stale write. An earlier version of this test
    // replayed the current value afterwards and only then asserted -- so the replay
    // repaired the regression before it was ever looked at, and a non-monotonic
    // implementation passed. Mutation testing caught it; the ordering is the test.
    repo.advanceRead("s1", 1, 101); // stale generation must NOT drag it back
    expect(repo.lastReadId("s1")).toBe(2);
    expect(repo.unreadBySession().get("s1")?.unread).toBe(0);

    repo.advanceRead("s1", 2, 102); // duplicate is a no-op, not a double-count
    expect(repo.lastReadId("s1")).toBe(2);
    expect(repo.unreadBySession().get("s1")?.unread).toBe(0);
  });

  it("a stale write cannot resurrect already-read events as unread", () => {
    const { repo } = seeded();
    repo.append({ sessionId: "s1", notificationId: "n1", kind: "stop", sentAt: 1 });
    repo.append({ sessionId: "s1", notificationId: "n2", kind: "stop", sentAt: 2 });
    repo.append({ sessionId: "s1", notificationId: "n3", kind: "stop", sentAt: 3 });
    repo.advanceRead("s1", 3, 100);
    repo.advanceRead("s1", 1, 101); // a slow jump from an older snapshot lands late
    // Regression would show 2 here -- two "new" messages the user already saw.
    expect(repo.unreadBySession().get("s1")?.unread).toBe(0);
  });

  it("advanceRead works for a session with no row yet", () => {
    const { repo } = seeded();
    repo.append({ sessionId: "s1", notificationId: "n1", kind: "stop", sentAt: 1 });
    repo.advanceRead("s1", 1, 100);
    expect(repo.unreadBySession().get("s1")?.unread).toBe(0);
  });

  it("keeps sessions independent", () => {
    const { repo } = seeded();
    repo.append({ sessionId: "s1", notificationId: "n1", kind: "stop", sentAt: 1 });
    repo.append({ sessionId: "s2", notificationId: "n2", kind: "stop", sentAt: 2 });
    repo.advanceRead("s1", 1, 100);
    const map = repo.unreadBySession();
    expect(map.get("s1")?.unread).toBe(0);
    expect(map.get("s2")?.unread).toBe(1);
  });

  it("reports the last event id and time, which the picker marks read against", () => {
    const { repo } = seeded();
    repo.append({ sessionId: "s1", notificationId: "n1", kind: "stop", sentAt: 10 });
    const last = repo.append({ sessionId: "s1", notificationId: "n2", kind: "stop", sentAt: 20 });
    const row = repo.unreadBySession().get("s1");
    expect(row?.lastEventId).toBe(last);
    expect(row?.lastEventAt).toBe(20);
  });

  // A mirror-only session must still be PRESENT (it has a ledger) while counting 0.
  // Filtering mirrors in the WHERE clause instead of the aggregate would drop the
  // row entirely and render "unknown" for a session we know perfectly well about.
  it("a mirror-only session is present with a zero count, not absent", () => {
    const { repo } = seeded();
    repo.append({ sessionId: "s1", notificationId: "n1", kind: "mirror", sentAt: 1 });
    const map = repo.unreadBySession();
    expect(map.has("s1")).toBe(true);
    expect(map.get("s1")?.unread).toBe(0);
  });

  // THE ONE THAT MATTERS MOST. A fully-pruned ledger with a surviving watermark must
  // be ABSENT from the map, so the picker renders "unknown" and not "read, nothing
  // new". Returning 0 here is how revision 1's silent zero comes back.
  it("a fully-pruned ledger with a surviving watermark is ABSENT, not zero", () => {
    const { db, repo } = seeded();
    repo.append({ sessionId: "s1", notificationId: "n1", kind: "stop", sentAt: 1 });
    repo.advanceRead("s1", 1, 100);
    db.exec("DELETE FROM session_events");
    expect(repo.unreadBySession().has("s1")).toBe(false);
    // ...and the watermark really did survive, so the test is proving absence of the
    // row rather than absence of the whole fixture.
    expect(repo.lastReadId("s1")).toBe(1);
  });
});

describe("session events retention", () => {
  it("prunes rows older than the cutoff and keeps newer ones", () => {
    const { repo } = seeded();
    repo.append({ sessionId: "s1", notificationId: "old", kind: "stop", sentAt: 1_000 });
    repo.append({ sessionId: "s1", notificationId: "new", kind: "stop", sentAt: 9_000 });
    expect(repo.pruneOlderThan(5_000)).toBe(1);
    expect(repo.unreadBySession().get("s1")?.unread).toBe(1);
  });

  // Unlike the swarm cleanup -- which spares 'queued' rows -- every ledger row is
  // prunable, so the predicate is a bare sent_at < cutoff with no state exemption.
  it("prunes regardless of read state, and a surviving watermark does not resurrect rows", () => {
    const { repo } = seeded();
    repo.append({ sessionId: "s1", notificationId: "n1", kind: "stop", sentAt: 1_000 });
    repo.advanceRead("s1", 1, 1_000);
    expect(repo.pruneOlderThan(5_000)).toBe(1);
    expect(repo.unreadBySession().has("s1")).toBe(false);
  });

  it("prunes on sent_at (delivery time), not on id order", () => {
    const { repo } = seeded();
    // Delivery can lag creation, so a LATER id may carry an EARLIER sent_at. Pruning
    // by id would take the wrong row.
    repo.append({ sessionId: "s1", notificationId: "n1", kind: "stop", sentAt: 9_000 });
    repo.append({ sessionId: "s1", notificationId: "n2", kind: "stop", sentAt: 1_000 });
    expect(repo.pruneOlderThan(5_000)).toBe(1);
    const rows = repo.unreadBySession();
    expect(rows.get("s1")?.unread).toBe(1);
    expect(rows.get("s1")?.lastEventAt).toBe(9_000);
  });
});

describe("storage wiring", () => {
  it("openStorageDb creates the tables and exposes the repo", async () => {
    const { openStorageDb } = await import("../src/storage/database");
    const storage = openStorageDb(":memory:");
    expect(storage.sessionEvents).toBeDefined();
    const id = storage.sessionEvents.append({
      sessionId: "s1",
      notificationId: "n1",
      kind: "stop",
      sentAt: 1,
    });
    expect(id).toBeGreaterThan(0);
    expect(storage.sessionEvents.unreadBySession().get("s1")?.unread).toBe(1);
  });

  // The ledger must survive the reaper deleting its session. A foreign key with
  // ON DELETE CASCADE here would silently empty the ledger for any session pigeon
  // has forgotten -- and foreign_keys is ON in openStorageDb, so this is live.
  it("a ledger row outlives deletion of its sessions row", async () => {
    const { openStorageDb } = await import("../src/storage/database");
    const storage = openStorageDb(":memory:");
    storage.db
      .prepare(
        `INSERT INTO sessions (session_id, state, created_at, updated_at, last_seen, expires_at)
         VALUES ('s1','running',1,1,1,1)`,
      )
      .run();
    storage.sessionEvents.append({ sessionId: "s1", notificationId: "n1", kind: "stop", sentAt: 1 });
    storage.db.prepare("DELETE FROM sessions WHERE session_id='s1'").run();
    expect(storage.sessionEvents.unreadBySession().get("s1")?.unread).toBe(1);
  });
});
