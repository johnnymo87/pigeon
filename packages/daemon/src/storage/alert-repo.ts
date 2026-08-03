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
     * Structural deduplication: unique index on ref_msg_id alone enforces "one alert
     * per swarm row, ever." That matches the real invariant (a row dies once) and is
     * deliberately stronger than per-source deduplication. If a future alert class
     * ever legitimately needs a second alert for the same row, that must be a
     * deliberate revisit, not something that works by accident because source strings
     * happened to differ.
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
