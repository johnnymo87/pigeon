import type BetterSqlite3 from "better-sqlite3";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const REPLY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const INBOX_DONE_RETENTION_MS = 60 * 60 * 1000;
export const PENDING_QUESTION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
export const OUTBOX_RETENTION_MS = 60 * 60 * 1000; // 1 hour

export function initSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      ppid INTEGER,
      pid INTEGER,
      start_time INTEGER,
      cwd TEXT,
      label TEXT,
      notify INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'running',
      pty_path TEXT,
      nvim_socket TEXT DEFAULT NULL,
      backend_kind TEXT,
      backend_protocol_version INTEGER,
      backend_endpoint TEXT,
      backend_auth_token TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(state, expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_notify ON sessions(notify, state, expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_ppid ON sessions(ppid);
    CREATE INDEX IF NOT EXISTS idx_sessions_backend_kind ON sessions(backend_kind);

    CREATE TABLE IF NOT EXISTS session_tokens (
      token TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      context_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tokens_chat ON session_tokens(chat_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_tokens_session ON session_tokens(session_id);
    CREATE INDEX IF NOT EXISTS idx_tokens_expiry ON session_tokens(expires_at);

    CREATE TABLE IF NOT EXISTS reply_tokens (
      channel_id TEXT NOT NULL,
      reply_key TEXT NOT NULL,
      token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (channel_id, reply_key)
    );

    CREATE INDEX IF NOT EXISTS idx_reply_tokens_created_at ON reply_tokens(created_at);

    CREATE TABLE IF NOT EXISTS inbox (
      command_id TEXT PRIMARY KEY,
      received_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'received',
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_inbox_status_updated ON inbox(status, updated_at);

    CREATE TABLE IF NOT EXISTS pending_questions (
      session_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      questions_json TEXT NOT NULL,
      token TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pending_questions_expires ON pending_questions(expires_at);

    CREATE TABLE IF NOT EXISTS outbox (
      notification_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'question',
      state TEXT NOT NULL DEFAULT 'queued',
      payload TEXT NOT NULL,
      token TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_outbox_retry
      ON outbox(state, next_retry_at);
  `);

  // Additive migrations for existing databases created before backend fields.
  const additiveColumns = [
    "ALTER TABLE sessions ADD COLUMN backend_kind TEXT",
    "ALTER TABLE sessions ADD COLUMN backend_protocol_version INTEGER",
    "ALTER TABLE sessions ADD COLUMN backend_endpoint TEXT",
    "ALTER TABLE sessions ADD COLUMN backend_auth_token TEXT",
    "ALTER TABLE sessions ADD COLUMN nvim_socket TEXT DEFAULT NULL",
    "ALTER TABLE pending_questions ADD COLUMN current_step INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE pending_questions ADD COLUMN answers_json_v2 TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE pending_questions ADD COLUMN version INTEGER NOT NULL DEFAULT 0",
  ];

  for (const statement of additiveColumns) {
    try {
      db.exec(statement);
    } catch {
      // Column already exists.
    }
  }
}
