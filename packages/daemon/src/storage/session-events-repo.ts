import type BetterSqlite3 from "better-sqlite3";

/**
 * Kinds excluded from the unread count.
 *
 * `mirror` is the user's own prompt echoed back into the topic. Counting it would
 * mean typing a message to yourself increments your own unread badge.
 *
 * Everything else counts, including kinds that do not exist yet. Topic-visible is
 * the safe default: a new kind that should not count produces a badge that is too
 * high and gets noticed, whereas defaulting to "don't count" produces a badge that
 * is too low and is indistinguishable from having read everything.
 */
const UNCOUNTED_KINDS = ["mirror"] as const;

export interface AppendInput {
  sessionId: string;
  notificationId: string;
  kind: string;
  sentAt: number;
}

export interface UnreadRow {
  unread: number;
  lastEventId: number;
  lastEventAt: number;
}

export class SessionEventsRepo {
  constructor(private readonly db: BetterSqlite3.Database) {}

  /** Returns the new row's id, which is the value a reader marks read against. */
  append(input: AppendInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO session_events (session_id, notification_id, kind, sent_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.sessionId, input.notificationId, input.kind, input.sentAt);
    return Number(info.lastInsertRowid);
  }

  /**
   * Unread counts for every session that HAS a ledger.
   *
   * Grouped over session_events, never over session_reads. A session whose ledger has
   * been fully pruned must be ABSENT from this map so the caller can render "unknown"
   * rather than "read, nothing new". Deriving presence from the watermark table (or
   * from `sessions`) would return 0 for such a session and reintroduce the silent zero
   * that killed revision 1 of the design. This is the single most important property
   * in this file.
   *
   * Note the exclusion is inside the aggregate, not in a WHERE clause: a session with
   * nothing but mirrored prompts is present with a count of 0, because we do know
   * about it. Filtering in WHERE would drop the row and claim we do not.
   */
  unreadBySession(): Map<string, UnreadRow> {
    const placeholders = UNCOUNTED_KINDS.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT e.session_id AS sessionId,
                COUNT(*) FILTER (WHERE e.id > COALESCE(r.last_read_id, 0)
                                   AND e.kind NOT IN (${placeholders})) AS unread,
                MAX(e.id)      AS lastEventId,
                MAX(e.sent_at) AS lastEventAt
         FROM session_events e
         LEFT JOIN session_reads r ON r.session_id = e.session_id
         GROUP BY e.session_id`,
      )
      .all(...UNCOUNTED_KINDS) as Array<{
      sessionId: string;
      unread: number;
      lastEventId: number;
      lastEventAt: number;
    }>;

    return new Map(
      rows.map((r) => [
        String(r.sessionId),
        {
          unread: Number(r.unread),
          lastEventId: Number(r.lastEventId),
          lastEventAt: Number(r.lastEventAt),
        },
      ]),
    );
  }

  /**
   * Advance a session's read watermark.
   *
   * Monotonic, and the comparison is done in SQL rather than read-modify-write, so a
   * stale or retried caller cannot drag the watermark backwards. Callers mark read
   * against the snapshot they actually displayed, so the error direction is always
   * "under-clear" -- which self-heals on the next read -- never "over-clear", which
   * would silently hide messages nobody saw.
   */
  advanceRead(sessionId: string, lastEventId: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO session_reads (session_id, last_read_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_read_id = MAX(session_reads.last_read_id, excluded.last_read_id),
           updated_at   = excluded.updated_at`,
      )
      .run(sessionId, lastEventId, now);
  }

  /** Advance to everything currently delivered for this session. No-op if none. */
  markAllRead(sessionId: string, now: number): void {
    const row = this.db
      .prepare("SELECT MAX(id) AS id FROM session_events WHERE session_id = ?")
      .get(sessionId) as { id: number | null } | undefined;
    if (!row || row.id === null) return;
    this.advanceRead(sessionId, Number(row.id), now);
  }

  lastReadId(sessionId: string): number {
    const row = this.db
      .prepare("SELECT last_read_id AS id FROM session_reads WHERE session_id = ?")
      .get(sessionId) as { id: number } | undefined;
    return row ? Number(row.id) : 0;
  }

  /**
   * Drop rows delivered before the cutoff.
   *
   * Anchored on sent_at, not on id: delivery can lag creation, so a later id may
   * carry an earlier delivery time and pruning by id would take the wrong row.
   *
   * Unlike the swarm cleanup, which deliberately spares `queued` rows, every ledger
   * row is prunable -- there is no state to protect, because a row exists only
   * because delivery already succeeded.
   */
  pruneOlderThan(cutoff: number): number {
    return this.db.prepare("DELETE FROM session_events WHERE sent_at < ?").run(cutoff).changes;
  }
}
