import type BetterSqlite3 from "better-sqlite3";

type Row = Record<string, unknown>;

export type Priority = "urgent" | "normal" | "low";

export interface SwarmMessageRecord {
  msgId: string;
  fromSession: string;
  toSession: string | null;
  channel: string | null;
  kind: string;
  priority: Priority;
  replyTo: string | null;
  payload: string;
  state: "queued" | "handed_off" | "failed";
  attempts: number;
  nextRetryAt: number | null;
  createdAt: number;
  updatedAt: number;
  handedOffAt: number | null;
}

/** Cursor-based paging options for {@link SwarmRepository.getInbox}. */
export interface GetInboxOptions {
  /** Return messages strictly newer than this msg_id (forward replay). */
  since?: string | null;
  /** Return messages strictly older than this msg_id (scroll-back). */
  before?: string | null;
  /** Max messages to return. Omit for "all matching rows". */
  limit?: number;
}

/** A page of inbox messages plus whether more exist beyond the window. */
export interface InboxPage {
  messages: SwarmMessageRecord[];
  hasMore: boolean;
}

export interface InsertSwarmInput {
  msgId: string;
  fromSession: string;
  toSession: string | null;
  channel: string | null;
  kind: string;
  priority: Priority;
  replyTo: string | null;
  payload: string;
}

function asRecord(row: Row): SwarmMessageRecord {
  return {
    msgId: String(row.msg_id),
    fromSession: String(row.from_session),
    toSession: (row.to_session as string | null) ?? null,
    channel: (row.channel as string | null) ?? null,
    kind: String(row.kind),
    priority: String(row.priority) as Priority,
    replyTo: (row.reply_to as string | null) ?? null,
    payload: String(row.payload),
    state: String(row.state) as SwarmMessageRecord["state"],
    attempts: Number(row.attempts),
    nextRetryAt: (row.next_retry_at as number | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    handedOffAt: (row.handed_off_at as number | null) ?? null,
  };
}

export class SwarmRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  insert(input: InsertSwarmInput, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO swarm_messages
           (msg_id, from_session, to_session, channel, kind, priority, reply_to, payload,
            state, attempts, next_retry_at, created_at, updated_at, handed_off_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, ?, ?, NULL)
         ON CONFLICT(msg_id) DO NOTHING`,
      )
      .run(
        input.msgId,
        input.fromSession,
        input.toSession,
        input.channel,
        input.kind,
        input.priority,
        input.replyTo,
        input.payload,
        now,
        now,
      );
  }

  getByMsgId(msgId: string): SwarmMessageRecord | null {
    const row = this.db
      .prepare("SELECT * FROM swarm_messages WHERE msg_id = ?")
      .get(msgId) as Row | undefined;
    return row ? asRecord(row) : null;
  }

  getReadyForTarget(
    toSession: string,
    now: number,
    limit = 1,
  ): SwarmMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM swarm_messages
         WHERE to_session = ?
           AND state = 'queued'
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(toSession, now, limit) as Row[];
    return rows.map(asRecord);
  }

  listTargetsWithReady(now: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT to_session
         FROM swarm_messages
         WHERE state = 'queued'
           AND to_session IS NOT NULL
           AND (next_retry_at IS NULL OR next_retry_at <= ?)`,
      )
      .all(now) as Array<{ to_session: string }>;
    return rows.map((r) => r.to_session);
  }

  markHandedOff(msgId: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE swarm_messages
         SET state = 'handed_off', handed_off_at = ?, updated_at = ?, next_retry_at = NULL
         WHERE msg_id = ?`,
      )
      .run(now, now, msgId);
  }

  markRetry(msgId: string, now: number, backoffMs: number): void {
    this.db
      .prepare(
        `UPDATE swarm_messages
         SET attempts = attempts + 1, next_retry_at = ?, updated_at = ?, state = 'queued'
         WHERE msg_id = ?`,
      )
      .run(now + backoffMs, now, msgId);
  }

  markFailed(msgId: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE swarm_messages
         SET state = 'failed', updated_at = ?, next_retry_at = NULL
         WHERE msg_id = ?`,
      )
      .run(now, msgId);
  }

  /**
   * Fetch delivered (handed-off) messages for a session.
   *
   * Messages are ALWAYS returned in ascending msg_id order (chronological,
   * oldest-first) regardless of paging direction, because every consumer —
   * `swarm_read`, the `since` cursor, and the delivery-check jq snippet —
   * expects chronological order.
   *
   * Paging is cursor-based and skip-safe. Which end of the window `limit`
   * truncates depends on the caller's intent:
   *
   *   - `since=<msg_id>` (forward replay / catch-up): return the OLDEST `limit`
   *     messages *newer* than the cursor. A caller drains forward by advancing
   *     `since` to the newest returned id until `hasMore` is false — never
   *     skipping the middle.
   *   - default / `before=<msg_id>` (recent view / scroll-back): return the
   *     NEWEST `limit` messages (optionally *older* than `before`). Page back
   *     through history by passing `before` = the oldest returned id.
   *
   * `hasMore` reports whether more messages exist beyond the returned window in
   * the direction of paging. Omitting `limit` returns every matching row.
   */
  getInbox(toSession: string, opts: GetInboxOptions = {}): InboxPage {
    const { since = null, before = null, limit } = opts;
    const hasLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0;

    const conds = ["to_session = ?", "state = 'handed_off'"];
    const params: Array<string | number> = [toSession];
    if (since !== null) {
      conds.push("msg_id > ?");
      params.push(since);
    }
    if (before !== null) {
      conds.push("msg_id < ?");
      params.push(before);
    }
    const where = conds.join(" AND ");

    if (!hasLimit) {
      const rows = this.db
        .prepare(`SELECT * FROM swarm_messages WHERE ${where} ORDER BY msg_id ASC`)
        .all(...params) as Row[];
      return { messages: rows.map(asRecord), hasMore: false };
    }

    const n = Math.floor(limit as number);
    // Forward mode when `since` is set (drain oldest-first after the cursor);
    // otherwise recent/scroll-back mode (take newest-first).
    const forward = since !== null;
    const order = forward ? "ASC" : "DESC";
    // Fetch one extra row to detect whether more exist beyond the window.
    const rows = this.db
      .prepare(`SELECT * FROM swarm_messages WHERE ${where} ORDER BY msg_id ${order} LIMIT ?`)
      .all(...params, n + 1) as Row[];

    const hasMore = rows.length > n;
    const windowRows = hasMore ? rows.slice(0, n) : rows;
    const records = windowRows.map(asRecord);
    // Recent/scroll-back mode fetched DESC; flip to ascending for the response.
    if (!forward) records.reverse();
    return { messages: records, hasMore };
  }

  cleanupOlderThan(cutoff: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM swarm_messages
         WHERE state IN ('handed_off', 'failed') AND updated_at < ?`,
      )
      .run(cutoff);
    return result.changes;
  }
}
