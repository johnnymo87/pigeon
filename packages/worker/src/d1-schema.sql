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
  metadata_json TEXT,
  message_thread_id INTEGER,
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

-- Topics: Telegram forum topics registry
CREATE TABLE IF NOT EXISTS topics (
  session_id        TEXT PRIMARY KEY,
  machine_id        TEXT,
  chat_id           TEXT NOT NULL,
  message_thread_id INTEGER,
  name              TEXT,
  -- 1 = name was built without a real session title (directory only) and may be upgraded once
  -- by the first notification carrying one. See pigeon-353p.
  name_provisional  INTEGER NOT NULL DEFAULT 0,
  state             TEXT NOT NULL DEFAULT 'open',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  closed_at         INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_thread
  ON topics(chat_id, message_thread_id) WHERE message_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_topics_reap ON topics(state, closed_at);

