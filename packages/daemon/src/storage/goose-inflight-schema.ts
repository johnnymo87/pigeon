import type BetterSqlite3 from "better-sqlite3";

export function initGooseInflightSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS goose_inflight_turns (
      command_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      backend_session_id TEXT NOT NULL,
      is_honk INTEGER NOT NULL,
      prompt_text TEXT NOT NULL,
      recovery_attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_alive_at INTEGER NOT NULL,
      clean_suspend INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_goose_inflight_session
      ON goose_inflight_turns(session_id);
  `);
}
