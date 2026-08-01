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
  retryCount: number;
  nextRetryAt: number | null;
  failedReason: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OutboxStats {
  states: Record<string, number>;
  failedReasons: Record<string, number>;
  oldestQueuedAgeMs: number | null;
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
    retryCount: Number(row.retry_count ?? 0),
    nextRetryAt: (row.next_retry_at as number | null) ?? null,
    failedReason: (row.failed_reason as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
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
            attempts, retry_count, next_retry_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, 0, NULL, ?, ?)
         ON CONFLICT(notification_id) DO UPDATE SET
           state = 'queued',
           attempts = 0,
           retry_count = 0,
           next_retry_at = NULL,
           failed_reason = NULL,
           last_error = NULL,
           created_at = excluded.created_at,
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
   * Ordered by message-class priority FIRST (question before stop before card), then created_at ASC, then rowid ASC.
   */
  getReady(now = Date.now(), limit = 100): OutboxRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox
         WHERE state = 'queued'
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY CASE kind WHEN 'question' THEN 1 WHEN 'stop' THEN 2 WHEN 'card' THEN 3 ELSE 4 END ASC,
                  created_at ASC,
                  rowid ASC
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

  markRetry(
    id: string,
    now = Date.now(),
    backoffMs: number,
    lastError?: string,
    countAttempt: boolean = true,
  ): void {
    this.db
      .prepare(
        `UPDATE outbox
         SET state = 'queued',
             attempts = attempts + ?,
             retry_count = retry_count + 1,
             next_retry_at = ?,
             last_error = COALESCE(?, last_error),
             updated_at = ?
         WHERE notification_id = ?`,
      )
      .run(countAttempt ? 1 : 0, now + backoffMs, lastError ?? null, now, id);
  }

  markFailed(id: string, now = Date.now(), reason?: string, lastError?: string): void {
    this.db
      .prepare(
        `UPDATE outbox
         SET state = 'failed',
             failed_reason = COALESCE(?, failed_reason),
             last_error = COALESCE(?, last_error),
             next_retry_at = NULL,
             updated_at = ?
         WHERE notification_id = ?`,
      )
      .run(reason ?? null, lastError ?? null, now, id);
  }

  updatePayload(notificationId: string, payload: string, now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE outbox SET payload = ?, updated_at = ? WHERE notification_id = ?",
      )
      .run(payload, now, notificationId);
  }

  /**
   * Delete terminal entries older than cutoffs:
   * - state 'sent' older than sentCutoff
   * - state 'failed' older than failedCutoff (defaults to sentCutoff if omitted)
   * Returns the number of deleted rows.
   */
  cleanupOlderThan(sentCutoff: number, failedCutoff: number = sentCutoff): number {
    const result = this.db
      .prepare(
        `DELETE FROM outbox
         WHERE (state = 'sent' AND updated_at < ?)
            OR (state = 'failed' AND updated_at < ?)`,
      )
      .run(sentCutoff, failedCutoff);
    return result.changes;
  }

  /**
   * Return aggregate outbox statistics:
   * - counts by outbox state
   * - breakdown of failed rows by failed_reason
   * - age in ms of the oldest currently-queued entry (null when none)
   */
  getStats(now = Date.now()): OutboxStats {
    const states: Record<string, number> = {
      queued: 0,
      sending: 0,
      sent: 0,
      failed: 0,
    };

    const stateRows = this.db
      .prepare("SELECT state, COUNT(*) as count FROM outbox GROUP BY state")
      .all() as Array<{ state: string; count: number }>;
    for (const row of stateRows) {
      states[row.state] = Number(row.count);
    }

    const failedReasons: Record<string, number> = {};
    const failedRows = this.db
      .prepare(
        "SELECT COALESCE(failed_reason, 'unknown') as reason, COUNT(*) as count FROM outbox WHERE state = 'failed' GROUP BY reason",
      )
      .all() as Array<{ reason: string; count: number }>;
    for (const row of failedRows) {
      failedReasons[row.reason] = Number(row.count);
    }

    const oldestRow = this.db
      .prepare(
        "SELECT MIN(created_at) as min_created_at FROM outbox WHERE state = 'queued'",
      )
      .get() as { min_created_at: number | null } | undefined;

    const oldestQueuedAgeMs =
      oldestRow && oldestRow.min_created_at !== null
        ? Math.max(0, now - Number(oldestRow.min_created_at))
        : null;

    return {
      states,
      failedReasons,
      oldestQueuedAgeMs,
    };
  }
}
