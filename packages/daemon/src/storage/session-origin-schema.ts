import type BetterSqlite3 from "better-sqlite3";

/**
 * Declared provenance for a session, recorded by whoever spawned it.
 *
 * Deliberately NOT part of `initSchema`'s sessions DDL and deliberately WITHOUT a
 * foreign key to sessions(session_id).
 *
 * Two independent reasons, both load-bearing:
 *
 *  1. The `sessions` row is rewritten wholesale on every plugin registration, and the
 *     plugin hardcodes notify: true (see `registerSession` in opencode-plugin/src/daemon-client.ts). A verdict
 *     stored there is clobbered on the next outbox recovery.
 *
 *  2. The row must OUTLIVE the session. The session reaper (session-reaper.ts) and
 *     dead-session cleanup (in worker/command-ingest.ts) both delete the sessions
 *     row, and lgtm then re-awakens the same session id through /swarm/send. If the
 *     provenance went with it, every re-review would go loud again.
 */
export function initSessionOriginSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_origin (
      session_id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      notify_policy TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Serves ad-hoc ops/debugging queries (e.g. SELECT count(*) FROM session_origin GROUP BY origin)
    CREATE INDEX IF NOT EXISTS idx_session_origin_origin ON session_origin(origin);
  `);
}
