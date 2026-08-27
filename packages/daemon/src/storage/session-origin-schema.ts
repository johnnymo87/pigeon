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
 *
 * SECOND CONSUMER, OUTSIDE THIS REPO. workstation's nvim session-switcher picker
 * reads this table to hide automated sessions from its list
 * (assets/opencode/plugins/oc-session-list-state.ts, `buildOriginMap`). Two things
 * about that reader are worth knowing before changing anything here:
 *
 *  - Its suppression is NOT TTL-bounded. notify-policy.ts holds the invariant that
 *    "all suppression is TTL-bounded; nothing is permanently silent", and that is
 *    still true of NOTIFICATIONS. It is not true of picker visibility: the picker
 *    keys on `origin` alone, so a session with a row stays hidden indefinitely.
 *    The documented escape hatch is DELETE /session-origin, which un-hides it.
 *
 *  - It keys on `origin` against a small allowlist, NOT on the row existing and NOT
 *    on notify_policy. So adding a row with a new `origin` will not hide anything
 *    until that reader opts in -- deliberately, because it has no reveal mechanism
 *    and hiding a session a human wanted is unrecoverable from inside the picker.
 */
export function initSessionOriginSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_origin (
      session_id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      notify_policy TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      declared_at INTEGER
    );

    -- Serves ad-hoc ops/debugging queries (e.g. SELECT count(*) FROM session_origin GROUP BY origin)
    CREATE INDEX IF NOT EXISTS idx_session_origin_origin ON session_origin(origin);
  `);

  const columns = db.prepare("PRAGMA table_info(session_origin)").all() as Array<{ name: string }>;
  const hasDeclaredAt = columns.some((col) => col.name === "declared_at");
  if (!hasDeclaredAt) {
    db.exec("ALTER TABLE session_origin ADD COLUMN declared_at INTEGER");
  }

  db.exec("UPDATE session_origin SET declared_at = created_at WHERE declared_at IS NULL");
}
