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
 * - `override`: user-issued un-quiet / policy change that automated `declared`
 *   writers must not undo.
 */
export const ORIGIN_SOURCES = ["inferred", "declared", "override"] as const;

/**
 * Placeholder `origin` for a row created by the un-quiet lever on a session nobody had
 * declared provenance for yet. `origin` means WHO SPAWNED the session, which the lever
 * does not know; writing "override" there would put a non-spawner into the spawner index.
 * A later declared writer is allowed to replace this sentinel (see `record`).
 */
export const ORIGIN_UNKNOWN = "unknown";
export type OriginSource = (typeof ORIGIN_SOURCES)[number];

/**
 * `all`         — deliver every event (the default for anything with no row).
 * `errors-only` — suppress routine Stop; still deliver Error and Retry.
 * `none`        — suppress Stop, Error and Retry alike.
 *
 * An unrecognised value read back from the DB is treated as `all`: ambiguity resolves
 * toward delivering (see `isQuietTitle` in `quiet-title.ts`).
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
   * later inferred guess or automated declared write can never downgrade what a user
   * override established. Equal-or-stronger writes refresh the payload and updated_at
   * but preserve created_at.
   */
  record(input: RecordSessionOriginInput, now = Date.now()): void {
    // tx.immediate() acquires write lock up front. Because record() reads before writing,
    // a deferred lock allows concurrent external writers to commit between SELECT and UPDATE/INSERT,
    // causing a lock-upgrade SQLITE_BUSY.
    const tx = this.db.transaction(() => {
      const existing = this.get(input.sessionId);
      if (existing && rank(input.source) < rank(existing.source)) {
        // The rank guard protects the POLICY, but `origin` and `notify_policy` answer two
        // different questions: who spawned the session, and whether to notify. Rejecting the
        // whole write conflates them, and locks the reconciliation writer out of ever naming
        // the spawner of a session the user un-quieted before any writer had run — those rows
        // are stamped with the ORIGIN_UNKNOWN sentinel and would keep it forever.
        //
        // So let a weaker write fill in a still-unknown origin, and ONLY that. notify_policy
        // and source are untouched, so this cannot resurrect suppression on an overridden
        // session — the case the guard exists for.
        if (existing.origin === ORIGIN_UNKNOWN && input.origin !== ORIGIN_UNKNOWN) {
          this.db
            .prepare("UPDATE session_origin SET origin = ?, updated_at = ? WHERE session_id = ?")
            .run(input.origin, now, input.sessionId);
        }
        return;
      }
      if (existing) {
        this.db
          .prepare(
            `UPDATE session_origin
                SET origin = ?, notify_policy = ?, source = ?, updated_at = ?
              WHERE session_id = ?`,
          )
          .run(input.origin, input.notifyPolicy, input.source, now, input.sessionId);
        return;
      }
      this.db
        .prepare(
          `INSERT INTO session_origin (session_id, origin, notify_policy, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.sessionId, input.origin, input.notifyPolicy, input.source, now, now);
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

    return {
      sessionId: String(row.session_id),
      origin: String(row.origin),
      notifyPolicy,
      source,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  clear(sessionId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM session_origin WHERE session_id = ?")
      .run(sessionId);
    return result.changes > 0;
  }
}
