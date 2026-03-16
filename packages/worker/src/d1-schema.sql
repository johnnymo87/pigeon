-- Commands: the central delivery table (replaces DO command_queue)
CREATE TABLE IF NOT EXISTS commands (
  command_id    TEXT PRIMARY KEY,
  machine_id    TEXT NOT NULL,
  session_id    TEXT,
  command_type  TEXT NOT NULL DEFAULT 'execute',
  command       TEXT NOT NULL,
  chat_id       TEXT NOT NULL,
  directory     TEXT,
  media_json    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL,
  leased_at     INTEGER,
  acked_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_commands_poll
  ON commands (machine_id, status, created_at);

-- Sessions: session-to-machine registry (replaces DO sessions)
CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  machine_id    TEXT NOT NULL,
  label         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Messages: Telegram reply routing (replaces DO messages)
CREATE TABLE IF NOT EXISTS messages (
  chat_id         TEXT NOT NULL,
  message_id      INTEGER NOT NULL,
  session_id      TEXT NOT NULL,
  token           TEXT NOT NULL,
  notification_id TEXT,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_notification_id
  ON messages(notification_id) WHERE notification_id IS NOT NULL;

-- Seen updates: Telegram deduplication (replaces DO seen_updates)
CREATE TABLE IF NOT EXISTS seen_updates (
  update_id     INTEGER PRIMARY KEY,
  created_at    INTEGER NOT NULL
);

-- Machines: track daemon last-poll time for online detection
CREATE TABLE IF NOT EXISTS machines (
  machine_id    TEXT PRIMARY KEY,
  last_poll_at  INTEGER NOT NULL
);
