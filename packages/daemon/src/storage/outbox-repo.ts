import type BetterSqlite3 from "better-sqlite3";

type SqlRow = Record<string, unknown>;

export interface OutboxRecord {
  notificationId: string;
  sessionId: string;
  requestId: string;
  kind: string;
  state: string;
  payload: string;
  token: string;
  attempts: number;
  nextRetryAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertOutboxInput {
  notificationId: string;
  sessionId: string;
  requestId: string;
  kind: string;
  payload: string;
  token: string;
}

function asOutbox(row: SqlRow): OutboxRecord {
  return {
    notificationId: String(row.notification_id),
    sessionId: String(row.session_id),
    requestId: String(row.request_id),
    kind: String(row.kind),
    state: String(row.state),
    payload: String(row.payload),
    token: String(row.token),
    attempts: Number(row.attempts),
    nextRetryAt: (row.next_retry_at as number | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class OutboxRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  /**
   * Insert a new outbox row with state 'queued'.
   * - If the row already exists and is 'failed', reset it to 'queued' (attempts=0, next_retry_at=NULL).
   * - If the row already exists and is 'queued', 'sending', or 'sent', do nothing (idempotent).
   */
  upsert(input: UpsertOutboxInput, now = Date.now()): void {
    // Try to insert; on conflict, only update if the existing state is 'failed'
    this.db
      .prepare(
        `INSERT INTO outbox
           (notification_id, session_id, request_id, kind, state, payload, token,
            attempts, next_retry_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, NULL, ?, ?)
         ON CONFLICT(notification_id) DO UPDATE SET
           state = 'queued',
           attempts = 0,
           next_retry_at = NULL,
           updated_at = excluded.updated_at
         WHERE outbox.state = 'failed'`,
      )
      .run(
        input.notificationId,
        input.sessionId,
        input.requestId,
        input.kind,
        input.payload,
        input.token,
        now,
        now,
      );
  }

  getByNotificationId(id: string): OutboxRecord | null {
    const row = this.db
      .prepare("SELECT * FROM outbox WHERE notification_id = ?")
      .get(id) as SqlRow | null;
    return row ? asOutbox(row) : null;
  }

  /**
   * Returns entries ready to be delivered: state='queued' AND (next_retry_at IS NULL OR next_retry_at <= now).
   * Ordered by created_at ASC, limited to `limit` rows.
   */
  getReady(now = Date.now(), limit = 100): OutboxRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox
         WHERE state = 'queued'
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(now, limit) as SqlRow[];
    return rows.map(asOutbox);
  }

  markSent(id: string, now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE outbox SET state = 'sent', next_retry_at = NULL, updated_at = ? WHERE notification_id = ?",
      )
      .run(now, id);
  }

  markRetry(id: string, now = Date.now(), backoffMs: number): void {
    this.db
      .prepare(
        `UPDATE outbox
         SET state = 'queued',
             attempts = attempts + 1,
             next_retry_at = ?,
             updated_at = ?
         WHERE notification_id = ?`,
      )
      .run(now + backoffMs, now, id);
  }

  markFailed(id: string, now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE outbox SET state = 'failed', next_retry_at = NULL, updated_at = ? WHERE notification_id = ?",
      )
      .run(now, id);
  }

  /**
   * Delete terminal entries (state 'sent' or 'failed') older than the given cutoff timestamp.
   * Returns the number of deleted rows.
   */
  cleanupOlderThan(cutoff: number): number {
    const result = this.db
      .prepare(
        "DELETE FROM outbox WHERE state IN ('sent', 'failed') AND updated_at < ?",
      )
      .run(cutoff);
    return result.changes;
  }
}
