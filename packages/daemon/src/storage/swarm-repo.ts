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

  getInbox(
    toSession: string,
    sinceMsgId: string | null,
  ): SwarmMessageRecord[] {
    if (sinceMsgId === null) {
      const rows = this.db
        .prepare(
          `SELECT * FROM swarm_messages
           WHERE to_session = ? AND state = 'handed_off'
           ORDER BY msg_id ASC`,
        )
        .all(toSession) as Row[];
      return rows.map(asRecord);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM swarm_messages
         WHERE to_session = ? AND state = 'handed_off' AND msg_id > ?
         ORDER BY msg_id ASC`,
      )
      .all(toSession, sinceMsgId) as Row[];
    return rows.map(asRecord);
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
