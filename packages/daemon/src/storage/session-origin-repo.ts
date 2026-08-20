import type BetterSqlite3 from "better-sqlite3";

/**
 * Ordered weakest-to-strongest. A write never lowers the stored source.
 *
 * WARNING: APPEND-ONLY! Rank derives from array index (`ORIGIN_SOURCES.indexOf`), so
 * reordering silently inverts authority precedence.
 *
 * Appending is also a DEPLOY-ORDERING hazard, not a free action. `get()` degrades any
 * source it does not recognise to `"inferred"` — the WEAKEST rank — so a daemon older
 * than the value reads it as the lowest authority and lets any write, even an inferred
 * guess, overwrite it permanently. Deploy the reader everywhere before any writer emits
 * a newly appended value, and expect the same trap the next time this array grows.
 *
 * - `inferred`: automated guess based on TUI title or session heuristics.
 * - `declared`: explicitly set during launch (e.g. via launcher/automation).
 */
export const ORIGIN_SOURCES = ["inferred", "declared"] as const;

export type OriginSource = (typeof ORIGIN_SOURCES)[number];

/**
 * `all`         — deliver every event (the default for anything with no row).
 * `errors-only` — suppress routine Stop and Retry, and aborted Error; still deliver genuine Error.
 * `none`        — suppress Stop, Error and Retry alike.
 *
 * An unrecognised value read back from the DB is treated as `all`: ambiguity resolves
 * toward delivering.
 */
export const NOTIFY_POLICIES = ["all", "errors-only", "none"] as const;
export type NotifyPolicy = (typeof NOTIFY_POLICIES)[number];

export function isNotifyPolicy(value: unknown): value is NotifyPolicy {
  return typeof value === "string" && (NOTIFY_POLICIES as readonly string[]).includes(value);
}

export function isOriginSource(value: unknown): value is OriginSource {
  return typeof value === "string" && (ORIGIN_SOURCES as readonly string[]).includes(value);
}

export interface SessionOriginRecord {
  sessionId: string;
  origin: string;
  notifyPolicy: NotifyPolicy;
  source: OriginSource;
  createdAt: number;
  updatedAt: number;
  declaredAt: number;
}

export interface RecordSessionOriginInput {
  sessionId: string;
  origin: string;
  notifyPolicy: NotifyPolicy;
  source: OriginSource;
}

function rank(source: OriginSource): number {
  return ORIGIN_SOURCES.indexOf(source);
}

type SqlRow = Record<string, unknown>;

export class SessionOriginRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  /**
   * Insert-or-upgrade. A write from a weaker source never overwrites a stronger one, so a
   * later inferred guess can never downgrade an explicitly declared origin. Equal-or-stronger
   * writes refresh the payload and updated_at but preserve created_at.
   */
  record(input: RecordSessionOriginInput, now = Date.now()): void {
    // tx.immediate() acquires write lock up front. Because record() reads before writing,
    // a deferred lock allows concurrent external writers to commit between SELECT and UPDATE/INSERT,
    // causing a lock-upgrade SQLITE_BUSY.
    const tx = this.db.transaction(() => {
      const existing = this.get(input.sessionId);
      if (existing && rank(input.source) < rank(existing.source)) {
        return;
      }
      if (existing) {
        this.db
          .prepare(
            `UPDATE session_origin
                SET origin = ?, notify_policy = ?, source = ?, updated_at = ?, declared_at = ?
              WHERE session_id = ?`,
          )
          .run(input.origin, input.notifyPolicy, input.source, now, now, input.sessionId);
        return;
      }
      this.db
        .prepare(
          `INSERT INTO session_origin (session_id, origin, notify_policy, source, created_at, updated_at, declared_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.sessionId, input.origin, input.notifyPolicy, input.source, now, now, now);
    });
    tx.immediate();
  }

  get(sessionId: string): SessionOriginRecord | null {
    const row = this.db
      .prepare("SELECT * FROM session_origin WHERE session_id = ?")
      .get(sessionId) as SqlRow | undefined;

    if (!row) return null;

    const notifyPolicy = isNotifyPolicy(row.notify_policy) ? row.notify_policy : "all";
    const source = isOriginSource(row.source) ? row.source : "inferred";
    const declaredAtRaw = row.declared_at != null ? row.declared_at : row.created_at;

    return {
      sessionId: String(row.session_id),
      origin: String(row.origin),
      notifyPolicy,
      source,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      declaredAt: Number(declaredAtRaw),
    };
  }

  clear(sessionId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM session_origin WHERE session_id = ?")
      .run(sessionId);
    return result.changes > 0;
  }
}
