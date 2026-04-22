import type BetterSqlite3 from "better-sqlite3";

export const SWARM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function initSwarmSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS swarm_messages (
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

    CREATE INDEX IF NOT EXISTS idx_swarm_target_state
      ON swarm_messages(to_session, state, next_retry_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_swarm_inbox
      ON swarm_messages(to_session, state, msg_id);
    CREATE INDEX IF NOT EXISTS idx_swarm_channel
      ON swarm_messages(channel, state, created_at);
  `);
}
