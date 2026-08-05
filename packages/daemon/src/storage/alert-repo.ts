import type BetterSqlite3 from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { AlertSeverity } from "../notification-service";

export type { AlertSeverity };
export type AlertState = "queued" | "sent" | "abandoned";

type Row = Record<string, unknown>;

export interface OperationalAlertRecord {
  id: string;
  source: string;
  refMsgId: string | null;
  text: string;
  severity: AlertSeverity;
  state: AlertState;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  sentAt: number | null;
}

function asRecord(row: Row): OperationalAlertRecord {
  return {
    id: String(row.id),
    source: String(row.source),
    refMsgId: (row.ref_msg_id as string | null) ?? null,
    text: String(row.text),
    severity: String(row.severity) as AlertSeverity,
    state: String(row.state) as AlertState,
    attempts: Number(row.attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    createdAt: Number(row.created_at),
    sentAt: (row.sent_at as number | null) ?? null,
  };
}

export function initAlertSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS operational_alerts (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      ref_msg_id TEXT,
      text TEXT NOT NULL,
      severity TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    );

    /*
     * Important SQLite semantics: NULL values are DISTINCT in a SQLite unique index.
     * Rows with ref_msg_id IS NULL do NOT collide with each other on ref_msg_id.
     * That is intended (alerts with no message back-pointer are not deduped).
     *
     * Structural deduplication: the unique index is on ref_msg_id ALONE, deliberately
     * stronger than per-source dedupe, so that a second alert for the same ref can
     * never appear by accident merely because two source strings differ.
     *
     * SCOPE OF THAT GUARANTEE — this comment used to claim "one alert per swarm row,
     * EVER", and that was never true. Dedupe lasts exactly as long as the ALERT ROW
     * exists: the hourly maintenance sweep DELETES sent alerts older than
     * ALERT_SENT_RETENTION_MS (1h) and abandoned ones after 7 days, and deleting a
     * row frees its slot. A queued alert is never deleted (only abandonOlderThan may
     * retire it, as a recorded state change), so a pending send cannot lose its slot.
     * Both halves are pinned by tests in test/alert-repo.test.ts. So the guarantee
     * this index gives is "at most one live alert per ref at a time", NOT "one ever",
     * and anything reasoning about collisions must use the real bound. How often a
     * given class may therefore re-alert is decided by ITS CALLER, not here: the
     * watchdog's lost-wake alert, for instance, also holds an in-memory Set that caps
     * it at one per process lifetime, so this row's expiry does not by itself produce
     * a repeat.
     *
     * THE DELIBERATE REVISIT HAPPENED (pigeon-fww). One swarm row may now legitimately
     * produce TWO durable alerts: an ADVISORY while it is still unresolved, and a
     * TERMINAL when it dies. They are kept apart not by source label but by NAMESPACING
     * the advisory's ref into a separate key space ('wake-lost:<msgId>', as the
     * watchdog's 'watchdog-stall:<ts>' alerts already do). Terminal alerts keep the
     * bare msgId. That separation is structural only because ':' is REJECTED in
     * caller-supplied msg_ids at the API boundary (see parseSwarmSendBody in app.ts) —
     * without that guard it would be a convention, and a caller minting the msg_id
     * 'wake-lost:msg_real' could take the slot belonging to real row msg_real's
     * payload-carrying alert. Any future alert class that needs to coexist with a row's
     * terminal alert MUST take a namespaced ref for the same reason: keying it on the
     * bare msgId would let the advisory silently swallow the terminal, since enqueue's
     * 'false' return is discarded at most call sites.
     */
    DROP INDEX IF EXISTS idx_op_alerts_dedupe;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_op_alerts_dedupe ON operational_alerts(ref_msg_id);
    CREATE INDEX IF NOT EXISTS idx_op_alerts_drain ON operational_alerts(state, next_attempt_at);
  `);
}

export class AlertRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  enqueue(input: {
    id?: string;
    source: string;
    refMsgId?: string | null;
    text: string;
    severity: AlertSeverity;
    now?: number;
  }): boolean {
    const now = input.now ?? Date.now();
    const id = input.id ?? randomUUID();
    const refMsgId = input.refMsgId ?? null;

    const result = this.db
      .prepare(
        `INSERT INTO operational_alerts
           (id, source, ref_msg_id, text, severity, state, attempts, next_attempt_at, created_at, sent_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, NULL)
         ON CONFLICT(ref_msg_id) DO NOTHING`,
      )
      .run(id, input.source, refMsgId, input.text, input.severity, now, now);

    return result.changes > 0;
  }

  nextDrainable(now: number): OperationalAlertRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM operational_alerts
         WHERE state = 'queued' AND next_attempt_at <= ?
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(now) as Row | undefined;

    return row ? asRecord(row) : undefined;
  }

  countDrainable(now: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM operational_alerts
         WHERE state = 'queued' AND next_attempt_at <= ?`,
      )
      .get(now) as { count: number } | undefined;

    return row ? Number(row.count) : 0;
  }

  markSent(id: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE operational_alerts
         SET state = 'sent', sent_at = ?
         WHERE id = ? AND state = 'queued'`,
      )
      .run(now, id);

    return result.changes > 0;
  }

  markRetry(id: string, nextAttemptAt: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE operational_alerts
         SET attempts = attempts + 1, next_attempt_at = ?
         WHERE id = ? AND state = 'queued'`,
      )
      .run(nextAttemptAt, id);

    return result.changes > 0;
  }

  abandonOlderThan(cutoff: number, _now: number): number {
    const result = this.db
      .prepare(
        `UPDATE operational_alerts
         SET state = 'abandoned'
         WHERE state = 'queued' AND created_at < ?`,
      )
      .run(cutoff);

    return result.changes;
  }

  // Cleans up old sent (by sent_at) and old abandoned (by created_at, i.e. age since creation) alerts.
  cleanupOlderThan(sentCutoff: number, abandonedCutoff: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM operational_alerts
         WHERE (state = 'sent' AND sent_at < ?)
            OR (state = 'abandoned' AND created_at < ?)`,
      )
      .run(sentCutoff, abandonedCutoff);

    return result.changes;
  }

  getById(id: string): OperationalAlertRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM operational_alerts WHERE id = ?")
      .get(id) as Row | undefined;

    return row ? asRecord(row) : undefined;
  }
}
