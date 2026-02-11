import type BetterSqlite3 from "better-sqlite3";
import {
  INBOX_DONE_RETENTION_MS,
  REPLY_TOKEN_TTL_MS,
  SESSION_TTL_MS,
  TOKEN_TTL_MS,
} from "./schema";
import type {
  InboxRecord,
  MintSessionTokenInput,
  PersistInboxCommandInput,
  ReplyTokenRecord,
  SessionRecord,
  SessionTokenRecord,
  UpsertSessionInput,
} from "./types";

type SqlRow = Record<string, unknown>;

function asSession(row: SqlRow): SessionRecord {
  return {
    sessionId: String(row.session_id),
    ppid: (row.ppid as number | null) ?? null,
    pid: (row.pid as number | null) ?? null,
    startTime: (row.start_time as number | null) ?? null,
    cwd: (row.cwd as string | null) ?? null,
    label: (row.label as string | null) ?? null,
    notify: Number(row.notify) === 1,
    state: String(row.state),
    transportKind: (row.transport_kind as string | null) ?? null,
    nvimSocket: (row.nvim_socket as string | null) ?? null,
    instanceName: (row.instance_name as string | null) ?? null,
    tmuxPaneId: (row.tmux_pane_id as string | null) ?? null,
    tmuxSession: (row.tmux_session as string | null) ?? null,
    paneId: (row.pane_id as string | null) ?? null,
    sessionName: (row.session_name as string | null) ?? null,
    ptyPath: (row.pty_path as string | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastSeen: Number(row.last_seen),
    expiresAt: Number(row.expires_at),
  };
}

function asSessionToken(row: SqlRow): SessionTokenRecord {
  return {
    token: String(row.token),
    sessionId: String(row.session_id),
    chatId: String(row.chat_id),
    scopes: JSON.parse(String(row.scopes_json)) as string[],
    context: JSON.parse(String(row.context_json)) as Record<string, unknown>,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  };
}

function asReplyToken(row: SqlRow): ReplyTokenRecord {
  return {
    channelId: String(row.channel_id),
    replyKey: String(row.reply_key),
    token: String(row.token),
    createdAt: Number(row.created_at),
  };
}

function asInbox(row: SqlRow): InboxRecord {
  return {
    commandId: String(row.command_id),
    receivedAt: Number(row.received_at),
    payload: String(row.payload),
    status: String(row.status),
    updatedAt: Number(row.updated_at),
  };
}

export class SessionRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  upsert(input: UpsertSessionInput, now = Date.now(), ttlMs = SESSION_TTL_MS): void {
    const expiresAt = now + ttlMs;

    this.db.prepare(
      `INSERT INTO sessions (
         session_id, ppid, pid, start_time, cwd, label, notify, state,
         transport_kind, nvim_socket, instance_name, tmux_pane_id, tmux_session,
         pane_id, session_name, pty_path, created_at, updated_at, last_seen, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         ppid = excluded.ppid,
         pid = excluded.pid,
         start_time = excluded.start_time,
         cwd = excluded.cwd,
         label = excluded.label,
         notify = excluded.notify,
         state = excluded.state,
         transport_kind = excluded.transport_kind,
         nvim_socket = excluded.nvim_socket,
         instance_name = excluded.instance_name,
         tmux_pane_id = excluded.tmux_pane_id,
         tmux_session = excluded.tmux_session,
         pane_id = excluded.pane_id,
         session_name = excluded.session_name,
         pty_path = excluded.pty_path,
         updated_at = excluded.updated_at,
         last_seen = excluded.last_seen,
         expires_at = excluded.expires_at`,
    ).run(
      input.sessionId,
      input.ppid ?? null,
      input.pid ?? null,
      input.startTime ?? null,
      input.cwd ?? null,
      input.label ?? null,
      input.notify ? 1 : 0,
      input.state ?? "running",
      input.transportKind ?? null,
      input.nvimSocket ?? null,
      input.instanceName ?? null,
      input.tmuxPaneId ?? null,
      input.tmuxSession ?? null,
      input.paneId ?? null,
      input.sessionName ?? null,
      input.ptyPath ?? null,
      now,
      now,
      now,
      expiresAt,
    );
  }

  get(sessionId: string): SessionRecord | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as SqlRow | null;
    return row ? asSession(row) : null;
  }

  list(options: { active?: boolean; notify?: boolean; now?: number } = {}): SessionRecord[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    const now = options.now ?? Date.now();

    if (options.active) {
      clauses.push("state = 'running'", "expires_at > ?");
      args.push(now);
    }

    if (options.notify) {
      clauses.push("notify = 1");
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `SELECT * FROM sessions ${where} ORDER BY last_seen DESC`;
    const rows = this.db.prepare(sql).all(...args) as SqlRow[];
    return rows.map(asSession);
  }

  touch(sessionId: string, now = Date.now(), ttlMs = SESSION_TTL_MS): boolean {
    const result = this.db
      .prepare("UPDATE sessions SET updated_at = ?, last_seen = ?, expires_at = ? WHERE session_id = ?")
      .run(now, now, now + ttlMs, sessionId);
    return result.changes > 0;
  }

  setNotify(sessionId: string, notify: boolean, now = Date.now()): boolean {
    const result = this.db
      .prepare("UPDATE sessions SET notify = ?, updated_at = ? WHERE session_id = ?")
      .run(notify ? 1 : 0, now, sessionId);
    return result.changes > 0;
  }

  delete(sessionId: string): boolean {
    const result = this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
    return result.changes > 0;
  }

  cleanupExpired(now = Date.now()): number {
    const result = this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
    return result.changes;
  }
}

export class SessionTokenRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  mint(input: MintSessionTokenInput, now = Date.now(), ttlMs = TOKEN_TTL_MS): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_tokens
         (token, session_id, chat_id, scopes_json, context_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.token,
        input.sessionId,
        input.chatId,
        JSON.stringify(input.scopes ?? ["command"]),
        JSON.stringify(input.context ?? {}),
        now,
        now + ttlMs,
      );
  }

  validate(token: string, chatId: string | null = null, now = Date.now()): SessionTokenRecord | null {
    const row = this.db.prepare("SELECT * FROM session_tokens WHERE token = ?").get(token) as SqlRow | null;
    if (!row) return null;

    const record = asSessionToken(row);
    if (record.expiresAt < now) {
      this.delete(token);
      return null;
    }

    if (chatId !== null && record.chatId !== chatId) {
      return null;
    }

    return record;
  }

  delete(token: string): boolean {
    const result = this.db.prepare("DELETE FROM session_tokens WHERE token = ?").run(token);
    return result.changes > 0;
  }

  cleanupExpired(now = Date.now()): number {
    const result = this.db.prepare("DELETE FROM session_tokens WHERE expires_at < ?").run(now);
    return result.changes;
  }
}

export class ReplyTokenRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  store(channelId: string, replyKey: string, token: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO reply_tokens (channel_id, reply_key, token, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(channelId, replyKey, token, now);
  }

  lookup(channelId: string, replyKey: string, now = Date.now(), ttlMs = REPLY_TOKEN_TTL_MS): string | null {
    const row = this.db
      .prepare("SELECT * FROM reply_tokens WHERE channel_id = ? AND reply_key = ?")
      .get(channelId, replyKey) as SqlRow | null;
    if (!row) return null;

    const record = asReplyToken(row);
    if (record.createdAt + ttlMs < now) {
      this.delete(channelId, replyKey);
      return null;
    }

    return record.token;
  }

  delete(channelId: string, replyKey: string): boolean {
    const result = this.db
      .prepare("DELETE FROM reply_tokens WHERE channel_id = ? AND reply_key = ?")
      .run(channelId, replyKey);
    return result.changes > 0;
  }

  cleanup(now = Date.now(), ttlMs = REPLY_TOKEN_TTL_MS): number {
    const result = this.db.prepare("DELETE FROM reply_tokens WHERE created_at < ?").run(now - ttlMs);
    return result.changes;
  }
}

export class InboxRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  persist(input: PersistInboxCommandInput, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO inbox (command_id, received_at, payload, status, updated_at)
         VALUES (?, ?, ?, 'received', ?)`,
      )
      .run(input.commandId, now, input.payload, now);
    return result.changes > 0;
  }

  markDone(commandId: string, now = Date.now()): boolean {
    const result = this.db
      .prepare("UPDATE inbox SET status = 'done', updated_at = ? WHERE command_id = ?")
      .run(now, commandId);
    return result.changes > 0;
  }

  listUnfinished(limit = 100): InboxRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM inbox WHERE status != 'done' ORDER BY received_at ASC LIMIT ?")
      .all(limit) as SqlRow[];
    return rows.map(asInbox);
  }

  cleanupDone(now = Date.now(), retentionMs = INBOX_DONE_RETENTION_MS): number {
    const result = this.db
      .prepare("DELETE FROM inbox WHERE status = 'done' AND updated_at < ?")
      .run(now - retentionMs);
    return result.changes;
  }
}
