import type BetterSqlite3 from "better-sqlite3";

export function initRouteSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS serve_instance (
      serve_id       TEXT PRIMARY KEY,
      instance_uuid  TEXT NOT NULL,
      endpoint       TEXT NOT NULL,
      binary_epoch   INTEGER NOT NULL DEFAULT 0,
      health_state   TEXT NOT NULL DEFAULT 'unknown',  -- healthy | unhealthy | unknown
      heartbeat_at   INTEGER NOT NULL,
      draining       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS session_assignment (
      session_id        TEXT PRIMARY KEY,
      directory_key     TEXT,
      desired_serve_id  TEXT NOT NULL,
      owner_generation  INTEGER NOT NULL DEFAULT 1,
      state             TEXT NOT NULL DEFAULT 'assigned', -- assigned|draining|dormant|migrating
      last_active_at    INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assignment_serve ON session_assignment(desired_serve_id, state);

    CREATE TABLE IF NOT EXISTS session_lease (
      session_id        TEXT PRIMARY KEY,
      serve_id          TEXT NOT NULL,
      instance_uuid     TEXT NOT NULL,
      owner_generation  INTEGER NOT NULL,
      lease_expires_at  INTEGER NOT NULL,
      heartbeat_at      INTEGER NOT NULL,
      binary_epoch      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_lease_serve ON session_lease(serve_id);
    CREATE INDEX IF NOT EXISTS idx_lease_expiry ON session_lease(lease_expires_at);
  `);
}
