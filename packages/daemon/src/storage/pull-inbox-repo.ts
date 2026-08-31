import type BetterSqlite3 from "better-sqlite3";

/**
 * Where a banked message came from. Deliberately NOT a free-text field: the lane
 * renders an answer differently from a plain reply (an answer is validated
 * against a still-open question id before it is believed), so the distinction is
 * load-bearing rather than decorative.
 */
export type PullInboxSource = "telegram-reply" | "question-answer";

export interface PullInboxRecord {
  msgId: string;
  sessionId: string;
  source: PullInboxSource;
  payload: string;
  questionRequestId: string | null;
  chatId: string | null;
  createdAt: number;
  expiresAt: number;
  /** First-claim time. Preserved across redeliveries: it is the unacked alarm's clock. */
  claimedAt: number | null;
  claimCount: number;
  ackedAt: number | null;
}

export interface BankPullMessageInput {
  msgId: string;
  sessionId: string;
  source: PullInboxSource;
  payload: string;
  questionRequestId?: string | null;
  chatId?: string | null;
  ttlMs?: number;
}

/**
 * How long a banked message survives unread.
 *
 * Matched to SESSION_TTL_MS (storage/schema.ts) so a message can never outlive
 * the session row that addresses it -- the reaper deleting that row is the point
 * at which nobody is coming to collect. It is also the swarm retention window, so
 * the daemon has one answer to "how long is undelivered mail kept", not two.
 *
 * It is far longer than any pigeon clock (delivery verify 5min, stuck alert
 * 15min, scheduled-wake expiry 6h) BECAUSE THE CLIENT'S CLOCK IS THE ONE THAT
 * MATTERS: the motivating lane runs Mon-Fri plus capped follow-ups, so its worst
 * gap (Friday evening to Monday) is ~68 hours. A 6h bound would declare the
 * human's Friday reply dead before the lane could possibly read it.
 */
export const DEFAULT_PULL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a claimed row may go unacked before it is reported. */
export const PULL_UNACKED_ALERT_MS = 30 * 60 * 1000;

type Row = Record<string, unknown>;

function asRecord(row: Row): PullInboxRecord {
  return {
    msgId: String(row.msg_id),
    sessionId: String(row.session_id),
    source: String(row.source) as PullInboxSource,
    payload: String(row.payload),
    questionRequestId: (row.question_request_id as string | null) ?? null,
    chatId: (row.chat_id as string | null) ?? null,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    claimedAt: (row.claimed_at as number | null) ?? null,
    claimCount: Number(row.claim_count ?? 0),
    ackedAt: (row.acked_at as number | null) ?? null,
  };
}

export class PullInboxRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  /**
   * Bank one inbound message. Returns false if this msg_id was already banked.
   *
   * Idempotent on msg_id because the caller is `command-ingest`, whose own inbox
   * explicitly re-runs unfinished commands ("retry unfinished commandId=..."). A
   * retry after a partially-completed ingest must not put a second copy of the
   * human's message in front of the agent.
   */
  bank(input: BankPullMessageInput, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO pull_inbox
           (msg_id, session_id, source, payload, question_request_id, chat_id,
            created_at, expires_at, claimed_at, claim_count, acked_at, unacked_alerted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL)
         ON CONFLICT(msg_id) DO NOTHING`,
      )
      .run(
        input.msgId,
        input.sessionId,
        input.source,
        input.payload,
        input.questionRequestId ?? null,
        input.chatId ?? null,
        now,
        now + (input.ttlMs ?? DEFAULT_PULL_TTL_MS),
      );
    return result.changes > 0;
  }

  /**
   * Hand the session its unacked, unexpired mail and record that we did.
   *
   * Re-serves rows already claimed but not acked. That is the recovery path: the
   * client can die between receiving a payload and durably recording it, and
   * without redelivery that message is lost with nothing able to notice. The
   * caller can tell the two apart -- `claimCount > 1` means "you have seen this
   * before" -- so a client that DID record it can drop the duplicate.
   *
   * `claimed_at` is only set on the first claim. Refreshing it on every claim
   * would reset the unacked alarm's clock on every episode, which is the shape
   * that already silenced a stall alarm in the consuming project (SDD §11): an
   * alarm whose clock is reset by the very loop it is watching never fires.
   */
  claim(sessionId: string, now: number, limit = 50): PullInboxRecord[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM pull_inbox
            WHERE session_id = ?
              AND acked_at IS NULL
              AND expires_at > ?
            ORDER BY created_at ASC, msg_id ASC
            LIMIT ?`,
        )
        .all(sessionId, now, limit) as Row[];

      const stamp = this.db.prepare(
        `UPDATE pull_inbox
            SET claimed_at = COALESCE(claimed_at, ?),
                claim_count = claim_count + 1
          WHERE msg_id = ? AND session_id = ? AND acked_at IS NULL`,
      );
      for (const row of rows) stamp.run(now, row.msg_id, sessionId);

      return rows.map((row) =>
        asRecord({
          ...row,
          claimed_at: (row.claimed_at as number | null) ?? now,
          claim_count: Number(row.claim_count ?? 0) + 1,
        }),
      );
    })();
  }

  /**
   * Confirm that claimed rows reached the client's real input.
   *
   * THE GUARDS ARE THE FEATURE, and they are the ones swarm's `markVerified` does
   * not have. Every id is CAS'd on `session_id` AND on having been claimed, and
   * anything that fails is RETURNED as rejected rather than silently ignored --
   * a partial ack must be visible to the caller, because "I acked 5 of 5" and "I
   * acked 3 and two vanished" are different facts about whether the human's
   * message was read.
   */
  ack(
    sessionId: string,
    msgIds: readonly string[],
    now = Date.now(),
  ): { acked: string[]; rejected: string[] } {
    return this.db.transaction(() => {
      const acked: string[] = [];
      const rejected: string[] = [];
      const stmt = this.db.prepare(
        `UPDATE pull_inbox
            SET acked_at = ?
          WHERE msg_id = ?
            AND session_id = ?
            AND claimed_at IS NOT NULL
            AND acked_at IS NULL`,
      );
      for (const msgId of msgIds) {
        if (stmt.run(now, msgId, sessionId).changes > 0) acked.push(msgId);
        else rejected.push(msgId);
      }
      return { acked, rejected };
    })();
  }

  /**
   * How much unread mail this session has.
   *
   * Powers the "is anything waiting?" probe, and -- equally -- lets a drain that
   * returns nothing be distinguished from a drain that could not reach the bank
   * at all. Zero-rows-and-healthy must not look like broken.
   */
  pendingCount(sessionId: string, now: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM pull_inbox
          WHERE session_id = ? AND acked_at IS NULL AND expires_at > ?`,
      )
      .get(sessionId, now) as { n: number };
    return Number(row.n);
  }

  /**
   * Delete unread mail that has passed its expiry, RETURNING what was deleted so
   * the caller can say so.
   *
   * The return value is not a convenience. A row expiring unread is the human's
   * message being dropped, and the usual notifier cannot cover it:
   * `notifySenderOfFailure` returns early for any sender that is not `^ses_`,
   * which a Telegram-originated message never is. Deleting inside the same
   * transaction that reports is what makes the report exactly-once -- the row is
   * the dedupe token.
   */
  sweepExpired(now: number): PullInboxRecord[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM pull_inbox WHERE acked_at IS NULL AND expires_at <= ?`,
        )
        .all(now) as Row[];
      if (rows.length > 0) {
        const del = this.db.prepare("DELETE FROM pull_inbox WHERE msg_id = ?");
        for (const row of rows) del.run(row.msg_id);
      }
      return rows.map(asRecord);
    })();
  }

  /**
   * Rows claimed longer than `thresholdMs` ago and still unacked, marked as
   * reported so each is reported exactly once for the life of the row.
   *
   * Durable rather than an in-memory Set: see the schema comment.
   */
  listUnackedForAlert(now: number, thresholdMs: number): PullInboxRecord[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM pull_inbox
            WHERE acked_at IS NULL
              AND claimed_at IS NOT NULL
              AND claimed_at <= ?
              AND unacked_alerted_at IS NULL`,
        )
        .all(now - thresholdMs) as Row[];
      if (rows.length > 0) {
        const mark = this.db.prepare(
          "UPDATE pull_inbox SET unacked_alerted_at = ? WHERE msg_id = ?",
        );
        for (const row of rows) mark.run(now, row.msg_id);
      }
      return rows.map(asRecord);
    })();
  }

  /** Reap rows the client confirmed, once they are older than the cutoff. */
  cleanupAcked(cutoff: number): number {
    return this.db
      .prepare("DELETE FROM pull_inbox WHERE acked_at IS NOT NULL AND acked_at <= ?")
      .run(cutoff).changes;
  }

  /**
   * Drop everything addressed to a session that no longer exists. Called by the
   * reaper: once the session row is gone, nothing will ever collect this mail,
   * and keeping it would leave the table growing without a reader.
   */
  deleteForSession(sessionId: string): number {
    return this.db
      .prepare("DELETE FROM pull_inbox WHERE session_id = ?")
      .run(sessionId).changes;
  }
}
