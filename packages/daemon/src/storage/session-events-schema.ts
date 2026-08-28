import type BetterSqlite3 from "better-sqlite3";
import { runAdditiveMigrations, SESSION_TTL_MS } from "./schema";

/**
 * How long a delivered-event row is kept.
 *
 * Written as a multiple of SESSION_TTL_MS rather than as a literal span so the two
 * numbers move together if the TTL changes. That is bookkeeping hygiene, and it is
 * deliberately NOT a guarantee: retention >= the TTL secures "the ledger outlives the
 * session it describes" only for a session whose last activity WAS a delivery (final
 * event at t, reaped by t + TTL). A session that stays alive while delivering nothing
 * -- `touch` refreshes the TTL on paths that send no Telegram message -- still ages
 * out and renders as unknown. No finite constant fixes that; see the design doc for
 * why the session-scoped prune that would was rejected.
 *
 * Sized by measurement (design doc, "The measured cost"): 168.6 bytes/row packed,
 * 940 entries/day at the busiest day observed, so 14 days is ~2.2 MB.
 */
export const SESSION_EVENTS_RETENTION_MS = 2 * SESSION_TTL_MS;

/**
 * The unread substrate: a durable log of what was actually delivered to a Telegram
 * topic, plus a per-session read watermark.
 *
 * Deliberately WITHOUT a foreign key to sessions(session_id), for the same reason
 * session_origin has none: the row must be able to outlive the session. The reaper
 * deletes the sessions row after SESSION_TTL_MS of inactivity, and an ON DELETE
 * CASCADE would take the ledger with it -- turning a session that is still listed in
 * the picker from "N unread" into "unknown" the moment pigeon forgets it.
 *
 * Why this is not counted from `outbox`: the outbox is a delivery QUEUE, not a message
 * store. It keeps sent rows for one hour and then deletes them, so a badge derived
 * from it decays to zero and the overnight-catch-up case -- the entire point of the
 * feature -- reports "nothing unread anywhere". That is indistinguishable from "you
 * have read everything", which is worse than showing no badge at all.
 */
export function initSessionEventsSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_events (
      -- AUTOINCREMENT is load-bearing and must NOT be "simplified" to a bare
      -- INTEGER PRIMARY KEY. A bare rowid reuses max(existing)+1, so an id freed by
      -- the retention prune can be handed out again BELOW a surviving watermark --
      -- and that event is then invisible forever, with no error anywhere.
      -- AUTOINCREMENT persists the high-water mark in sqlite_sequence instead.
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT    NOT NULL,
      notification_id TEXT    NOT NULL,
      kind            TEXT    NOT NULL,
      -- Delivery time, not creation time. The outbox governor holds bursts and
      -- markRetry never touches created_at, so an entry created before a read and
      -- delivered after it would sort below the watermark and never be counted.
      sent_at         INTEGER NOT NULL
    );

    -- Serves the per-session unread aggregate; (session_id, id) lets the group-by
    -- and the id > watermark comparison share one index.
    CREATE INDEX IF NOT EXISTS idx_session_events_session
      ON session_events(session_id, id);

    -- Serves the retention prune, which scans by delivery time.
    CREATE INDEX IF NOT EXISTS idx_session_events_sent_at
      ON session_events(sent_at);

    CREATE TABLE IF NOT EXISTS session_reads (
      session_id   TEXT PRIMARY KEY,
      last_read_id INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
  `);

  // Phase 1b of unread navigation: the scroll target and a readable excerpt,
  // copied from the outbox row at delivery time. Both nullable, no backfill --
  // NULL means "do not scroll", which is the pre-feature behaviour.
  //
  // THESE MUST NOT MOVE INTO schema.ts's shared `additiveColumns` array, however
  // tempting the consolidation looks. That array is applied by initSchema, which
  // openStorageDb calls BEFORE this function (database.ts). On a fresh database
  // `session_events` does not exist yet, and "no such table" is NOT matched by
  // isDuplicateColumnError -- it is message-matched and fails safe by rethrowing
  // -- so the daemon would crash on startup for every new database. Pinned by
  // the "initialises a completely fresh database" test.
  runAdditiveMigrations(db, [
    "ALTER TABLE session_events ADD COLUMN anchor_msg_id TEXT DEFAULT NULL",
    "ALTER TABLE session_events ADD COLUMN excerpt TEXT DEFAULT NULL",
  ]);
}
