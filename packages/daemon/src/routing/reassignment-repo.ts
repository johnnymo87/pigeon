/**
 * Reassignment event log — the durable, DATED record of sessions moving between
 * serves (bead pigeon-f2a).
 *
 * Increment 1 of the serve-serviceability arc (epic pigeon-u1u) is deliberately
 * pure observability, shipped BEFORE the mechanism in increment 2 that will
 * create new health transitions. The June 2026 flapping regression was invisible
 * for weeks — nothing on the reassignment path logs anything
 * (`serve-health-poller.ts:75-91` and `router.ts:296-314` contain zero
 * `console.*`) and no history table exists — and it was found only by
 * root-causing killed turns. Building the detector for a mechanism before the
 * mechanism exists is the whole point: it means increment 2 lands instrumented.
 *
 * WHY NOT REUSE `session_assignment.owner_generation`: it is monotonic but
 * undateable. `updated_at` on that row is churned by `upsert` (every placement,
 * via `placeSession`) and by `setDormantFenced` (via `sweep`) for reasons unrelated
 * to reassignment, so the counter can
 * tell you a session moved twelve times but never whether that was over three
 * months (fine) or ten minutes (the incident).
 *
 * ── SCHEMA SAFETY, READ BEFORE EDITING ────────────────────────────────────────
 * The routing DB is a SHARED file: pigeon's daemon storage DB and the pool's
 * OPENCODE_ROUTING_DB are the same path. Each serve validates
 * `routing_meta.ddl_checksum` — which pigeon writes by hashing `ROUTING_DDL` —
 * against a constant compiled into opencode-patched, and throws
 * SchemaMismatchError at startup on any mismatch.
 *
 * Therefore `REASSIGNMENT_DDL` is a SEPARATE string and must stay one. Adding a
 * table here is free and needs no serve-side coordination whatsoever; moving it
 * into `ROUTING_DDL` changes the digest and crash-loops the entire pool until a
 * lockstep opencode-patched release ships. `route-schema.test.ts` enforces this.
 *
 * (Related trap, for the same reason: `ROUTING_DDL` uses CREATE TABLE IF NOT
 * EXISTS, so a column added inside it is a silent no-op on every DB that already
 * exists. Additive migrations belong out here too.)
 */
import type BetterSqlite3 from "better-sqlite3";

/**
 * Deliberately NOT part of `ROUTING_DDL`. See the schema-safety note above.
 *
 * `at` is indexed because every read is a window query. The composite
 * (session_id, at) index serves the per-session ranking that separates a
 * legitimate pool restart from one session thrashing.
 */
export const REASSIGNMENT_DDL = `
  CREATE TABLE IF NOT EXISTS reassignment_event (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id        TEXT NOT NULL,
    from_serve_id     TEXT,
    to_serve_id       TEXT NOT NULL,
    owner_generation  INTEGER NOT NULL,
    at                INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reassign_at ON reassignment_event(at);
  CREATE INDEX IF NOT EXISTS idx_reassign_session_at ON reassignment_event(session_id, at);
`;

export function initReassignmentSchema(db: BetterSqlite3.Database): void {
  db.exec(REASSIGNMENT_DDL);
}

export interface ReassignmentEvent {
  sessionId: string;
  /** Null for a session's first ever placement — nothing to move it away from. */
  fromServeId: string | null;
  toServeId: string;
  ownerGeneration: number;
  at: number;
}

export interface SessionMoveCount {
  sessionId: string;
  moves: number;
}

export class ReassignmentEventRepo {
  constructor(private readonly db: BetterSqlite3.Database) {}

  record(ev: ReassignmentEvent): void {
    this.db
      .prepare(
        `INSERT INTO reassignment_event
           (session_id, from_serve_id, to_serve_id, owner_generation, at)
         VALUES (@sessionId, @fromServeId, @toServeId, @ownerGeneration, @at)`,
      )
      .run(ev);
  }

  /** Total moves at or after `since`. The numerator of the rate alert. */
  countSince(since: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM reassignment_event WHERE at >= ?`)
      .get(since) as { n: number };
    return Number(row.n);
  }

  /** Distinct sessions moved at or after `since`. */
  distinctSessionsSince(since: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT session_id) AS n FROM reassignment_event WHERE at >= ?`,
      )
      .get(since) as { n: number };
    return Number(row.n);
  }

  /**
   * Sessions ranked by how often they moved in the window.
   *
   * This is what separates the two shapes that produce identical totals: a pool
   * restart moves N sessions once each (benign, expected on every deploy), while
   * the June pathology was ONE session moving repeatedly. `limit` keeps the alert
   * body bounded when an incident is wide.
   */
  topSessionsSince(since: number, limit: number): SessionMoveCount[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, COUNT(*) AS moves
           FROM reassignment_event
          WHERE at >= ?
          GROUP BY session_id
          ORDER BY moves DESC, session_id ASC
          LIMIT ?`,
      )
      .all(since, limit) as Array<{ session_id: string; moves: number }>;
    return rows.map((r) => ({ sessionId: r.session_id, moves: Number(r.moves) }));
  }

  /**
   * How many distinct sessions moved at least `minMoves` times in the window.
   *
   * The breadth arm's primitive. A serve oscillating in and out of the healthy
   * pool evacuates its whole population on every cycle, so each session picks up
   * 2-4 moves and NONE of them trips the per-session burst threshold — while the
   * fleet racks up hundreds of moves. Counting sessions that clear a low floor
   * catches that, and stays restart-invariant: a restart gives every session
   * exactly one move, so any floor above 1 yields zero.
   */
  countSessionsWithAtLeastSince(since: number, minMoves: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT session_id
             FROM reassignment_event
            WHERE at >= ?
            GROUP BY session_id
           HAVING COUNT(*) >= ?
         )`,
      )
      .get(since, minMoves) as { n: number };
    return Number(row.n);
  }

  /** Retention. An append-only log on the hot path must have a reaper. */
  pruneBefore(cutoff: number): number {
    return this.db
      .prepare(`DELETE FROM reassignment_event WHERE at < ?`)
      .run(cutoff).changes;
  }
}
