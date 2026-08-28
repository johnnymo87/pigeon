import type BetterSqlite3 from "better-sqlite3";

type SqlRow = Record<string, unknown>;

export interface OutboxRecord {
  notificationId: string;
  sessionId: string;
  requestId: string;
  kind: string;
  /** Phase 1b: scroll anchor and drill-down excerpt, fixed at first enqueue. */
  anchorMsgId: string | null;
  excerpt: string | null;
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
  /**
   * Scroll anchor and drill-down excerpt for this notification (phase 1b of
   * unread navigation). Captured at ENQUEUE and carried to commitDelivery,
   * which copies them onto the session_events row. Optional: callers that have
   * no anchor pass nothing and the ledger stores NULL, meaning "do not scroll".
   */
  anchorMsgId?: string | null;
  excerpt?: string | null;
}

function asOutbox(row: SqlRow): OutboxRecord {
  return {
    notificationId: String(row.notification_id),
    sessionId: String(row.session_id),
    requestId: String(row.request_id),
    kind: String(row.kind),
    anchorMsgId: row.anchor_msg_id === null || row.anchor_msg_id === undefined ? null : String(row.anchor_msg_id),
    excerpt: row.excerpt === null || row.excerpt === undefined ? null : String(row.excerpt),
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
            attempts, retry_count, next_retry_at, created_at, updated_at,
            anchor_msg_id, excerpt)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, 0, NULL, ?, ?, ?, ?)
         -- The conflict arm resets DELIVERY STATE only. It does not touch
         -- payload, and for the same reason it must never touch anchor_msg_id
         -- or excerpt: a requeue re-sends the ORIGINAL content, so pairing it
         -- with a newer anchor would point the reader PAST the very thing being
         -- re-delivered.
         --
         -- The reachable path is /mirror, not swarm: /mirror builds a
         -- deterministic id (m:<session>:<message>) and has no
         -- getByNotificationId pre-check, so a re-flush of the same message
         -- after a failed first attempt lands here. Both swarm producers are
         -- gated on a fresh insert (/swarm/send by an if-inserted guard,
         -- /swarm/schedule by an if-not-inserted 409) and swarm requeue
         -- redelivers the ENVELOPE without re-enqueueing a Telegram notice, so
         -- swarm never re-upserts a w: id. An earlier version of this comment
         -- claimed it did; that was wrong.
         -- Pinned by the "never moves a stored anchor" test.
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
        input.anchorMsgId ?? null,
        input.excerpt ?? null,
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
   *
   * Session-level group ordering (subquery):
   *   question=1, stop=2, card=3, swarm=4, mirror=5, else=6
   *
   * Per-row tier ordering (secondary CASE):
   *   question/stop/card -> 1 (conversational tier)
   *   everything else (swarm, mirror, unknown) -> 2 (record tier)
   *
   * Within a session, order is created_at per tier. The conversational tier preempts the
   * record tier. Conversational rows never reorder among themselves (pigeon-81p).
   * Record rows may be preempted by conversational rows (arbitration A').
   *
   * Note on group subquery behavior: the group subquery counts `queued` rows regardless of `next_retry_at`,
   * so a question sitting in retry backoff still elevates its session's swarm rows into group 1 while itself
   * being absent from the batch. Narrow, self-healing, bounded by the batch limit.
   */
  getReady(now = Date.now(), limit = 100): OutboxRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox
         WHERE state = 'queued'
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY (SELECT MIN(CASE o2.kind WHEN 'question' THEN 1 WHEN 'stop' THEN 2 WHEN 'card' THEN 3 WHEN 'swarm' THEN 4 WHEN 'mirror' THEN 5 ELSE 6 END)
                   FROM outbox o2 WHERE o2.session_id = outbox.session_id AND o2.state = 'queued') ASC,
                  (CASE outbox.kind WHEN 'question' THEN 1 WHEN 'stop' THEN 1 WHEN 'card' THEN 1 ELSE 2 END) ASC,
                  created_at ASC,
                  rowid ASC
         LIMIT ?`,
      )
      .all(now, limit) as SqlRow[];
    return rows.map(asOutbox);
  }

  /**
   * Mark an entry delivered. Returns true only if this call performed the
   * transition, so callers can attach exactly-once side effects to it.
   *
   * The `state != 'sent'` guard is what makes that promise real. Without it the
   * statement is idempotent in the database but not in its report: a second caller
   * would be told it had just delivered something, and the unread ledger keyed off
   * that answer would double-count every message. Today there is exactly one caller,
   * inside a reentrancy-guarded loop, so the guard protects a future change rather
   * than a present bug -- which is precisely when it is cheap to add.
   *
   * Mirrors AlertRepository.markSent, which already returns boolean for this reason.
   */
  markSent(id: string, now = Date.now()): boolean {
    const info = this.db
      .prepare(
        `UPDATE outbox SET state = 'sent', next_retry_at = NULL, updated_at = ?
         WHERE notification_id = ? AND state != 'sent'`,
      )
      .run(now, id);
    return info.changes > 0;
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
