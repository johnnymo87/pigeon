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
  -- Where the notification was MEANT to go vs where it actually went (pigeon-bit4).
  -- intended IS NOT NULL AND actual IS NULL == a send that failed into its topic and was
  --   relocated to General.
  -- both non-null but DIFFERENT == the topic was recreated mid-send.
  -- NOT a complete relocation count: when resolveTopic itself fails to produce a topic
  --   (creation failed, poll exhausted, lost CAS) there is no intended id to record and the
  --   row is NULL/NULL, indistinguishable from threaded:false. The console.warn at those
  --   three sites in topic-manager.ts is the only signal for them.
  intended_thread_id INTEGER,
  actual_thread_id   INTEGER,
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


-- Named topics: caller-keyed forum topics with no session (POST /alert `topic`).
-- Separate from `topics` on purpose: the orphan-closer, reaper and inbound routing all treat a
-- `topics` row as session-owned. See named-topics.ts.
CREATE TABLE IF NOT EXISTS named_topics (
  chat_id            TEXT NOT NULL,
  topic_key          TEXT NOT NULL,
  message_thread_id  INTEGER NOT NULL,
  name               TEXT NOT NULL,
  reopen_checked_at  INTEGER,
  hint_at            INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (chat_id, topic_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_named_topics_thread
  ON named_topics(chat_id, message_thread_id);

-- A named topic (see named_topics) a pull-mode session reads. Separate table, not a column on
-- named_topics: d1-schema.sql is re-applied by hand and must stay idempotent, and SQLite has no
-- ADD COLUMN IF NOT EXISTS. One topic per session, one session per topic.
CREATE TABLE IF NOT EXISTS named_topic_bindings (
  chat_id     TEXT NOT NULL,
  topic_key   TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  bound_at    INTEGER NOT NULL,
  PRIMARY KEY (chat_id, topic_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_named_topic_bindings_session
  ON named_topic_bindings(session_id);

-- Per-machine worker credentials (pigeon-k0qn.8, runbook docs/runbooks/per-machine-credentials.md).
-- Only the SHA-256 of a key is stored. Several rows per machine are allowed so a key can be
-- rotated with overlap. Never UPDATE machine_id on a row: revoke it and mint a new key.
CREATE TABLE IF NOT EXISTS machine_credentials (
  key_sha256  TEXT PRIMARY KEY,
  machine_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_machine_credentials_machine
  ON machine_credentials(machine_id);

-- Cross-machine swarm relay (pigeon-k0qn.5, design docs/plans/2026-10-20-cross-machine-swarm-design.md
-- §3.2, decisions docs/plans/2026-10-22-worker-relay.md). One row per relayed message, plus one
-- failure item ('f:' || msg_id, to_machine = the original sender) per message that did not arrive.
-- New tables rather than columns on `commands`: see the design's "Why a separate table".
CREATE TABLE IF NOT EXISTS swarm_relay (
  from_machine    TEXT NOT NULL,
  msg_id          TEXT NOT NULL,
  item_kind       TEXT NOT NULL,              -- 'message' | 'failure'
  to_machine      TEXT NOT NULL,
  to_session      TEXT NOT NULL,
  from_session    TEXT NOT NULL,
  body_json       TEXT NOT NULL,
  payload_sha256  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued', -- queued | leased | delivered | refused | expired
  reason          TEXT,
  lease_count     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  leased_at       INTEGER,
  settled_at      INTEGER,
  expires_at      INTEGER NOT NULL,
  PRIMARY KEY (from_machine, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_swarm_relay_handout
  ON swarm_relay(to_machine, status, created_at);
CREATE INDEX IF NOT EXISTS idx_swarm_relay_expiry
  ON swarm_relay(status, expires_at);

-- Which senders a machine accepts relays from, as last advertised in its poll header
-- (X-Pigeon-Swarm-Relay). Written only when it changes. Liveness comes from machines.last_poll_at.
CREATE TABLE IF NOT EXISTS machine_relay_accept (
  machine_id  TEXT PRIMARY KEY,
  accept_csv  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
