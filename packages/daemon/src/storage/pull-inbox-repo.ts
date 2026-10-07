import type BetterSqlite3 from "better-sqlite3";

/**
 * Where a banked message came from: plain Telegram replies (via goose-pull
 * adapter) and swarm messages (via bank-or-insert.ts for opted-in sessions).
 * Question cards are not offered to pull sessions (a pending question captures
 * every plain message to its session, and nothing drains a question for a pull
 * client).
 */
export type PullInboxSource = "telegram-reply" | "swarm";

export interface PullInboxRecord {
  msgId: string;
  sessionId: string;
  source: PullInboxSource;
  payload: string;
  /** Telegram user id of the sender, as checked against the adapter's allowlist. */
  senderId: string | null;
  /**
   * Up to 500 characters of the BOT message the human swipe-replied to, or null.
   * Context for a bare "yes"; never the human's own words, and never another
   * user's message (the worker forwards it only when the replied-to message is the bot's).
   */
  inReplyTo: string | null;
  inReplyToQuote: string | null;
  chatId: string | null;
  kind: string | null;
  replyTo: string | null;
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
  senderId?: string | null;
  inReplyTo?: string | null;
  inReplyToQuote?: string | null;
  chatId?: string | null;
  kind?: string | null;
  replyTo?: string | null;
  ttlMs?: number;
}

export interface PullInboxFilterOptions {
  /**
   * Whether to include `source='swarm'` rows. Defaults to true.
   *
   * When false, swarm rows are held (neither returned nor counted) for sessions
   * not currently opted into "swarm", protecting older clients from misinterpreting
   * them and preventing wake gates from spinning.
   */
  includeSwarm?: boolean;
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
 * MATTERS: a client that runs as scheduled episodes can be idle for days (a
 * weekend, say). A 6h bound would declare the human's reply dead before the
 * client could possibly read it.
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
    senderId: (row.sender_id as string | null) ?? null,
    inReplyTo: (row.in_reply_to as string | null) ?? null,
    inReplyToQuote: (row.in_reply_to_quote as string | null) ?? null,
    chatId: (row.chat_id as string | null) ?? null,
    kind: (row.kind as string | null) ?? null,
    replyTo: (row.reply_to as string | null) ?? null,
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
           (msg_id, session_id, source, payload, sender_id, in_reply_to, in_reply_to_quote, chat_id,
            kind, reply_to,
            created_at, expires_at, claimed_at, claim_count, acked_at, unacked_alerted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL)
         ON CONFLICT(msg_id) DO NOTHING`,
      )
      .run(
        input.msgId,
        input.sessionId,
        input.source,
        input.payload,
        input.senderId ?? null,
        input.inReplyTo ?? null,
        input.inReplyToQuote ?? null,
        input.chatId ?? null,
        input.kind ?? null,
        input.replyTo ?? null,
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
   * that already silenced a stall alarm: an
   * alarm whose clock is reset by the very loop it is watching never fires.
   *
   * When `options.includeSwarm` is false, `source='swarm'` rows are excluded
   * (held) so an opted-out or rolled-back client that does not understand swarm
   * rows does not receive, reject, or misreport them. Held rows remain in the bank
   * to serve on re-opt-in or expire via sweep.
   */
  claim(
    sessionId: string,
    now: number,
    limit = 50,
    options: PullInboxFilterOptions = {},
  ): PullInboxRecord[] {
    const includeSwarm = options.includeSwarm ?? true;
    const swarmFilter = includeSwarm ? "" : " AND source != 'swarm'";
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM pull_inbox
            WHERE session_id = ?
              AND acked_at IS NULL
              AND expires_at > ?${swarmFilter}
            ORDER BY CASE source WHEN 'telegram-reply' THEN 0 WHEN 'swarm' THEN 1 ELSE 2 END ASC,
                     created_at ASC,
                     msg_id ASC
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
   *
   * Ack is deliberately NOT filtered by `includeSwarm`: a client that claimed
   * rows while opted in must still be allowed to acknowledge them even after
   * an opt-out so they do not falsely alert as unconfirmed / wedged.
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
   * How much unread mail this session has, broken down by source.
   *
   * Always includes both keys ("telegram-reply" and "swarm").
   * When `options.includeSwarm` is false, `source='swarm'` rows are excluded
   * from the count (reporting 0) so wake gates do not spin on mail the client
   * cannot currently collect.
   */
  pendingCounts(
    sessionId: string,
    now: number,
    options: PullInboxFilterOptions = {},
  ): { total: number; bySource: Record<PullInboxSource, number> } {
    const includeSwarm = options.includeSwarm ?? true;
    const swarmFilter = includeSwarm ? "" : " AND source != 'swarm'";
    const rows = this.db
      .prepare(
        `SELECT source, COUNT(*) AS n FROM pull_inbox
          WHERE session_id = ? AND acked_at IS NULL AND expires_at > ?${swarmFilter}
          GROUP BY source`,
      )
      .all(sessionId, now) as Array<{ source: string; n: number }>;
    const bySource: Record<PullInboxSource, number> = {
      "telegram-reply": 0,
      swarm: 0,
    };
    let total = 0;
    for (const r of rows) {
      const count = Number(r.n);
      total += count;
      if (r.source === "telegram-reply" || r.source === "swarm") {
        bySource[r.source] = count;
      }
    }
    return { total, bySource };
  }

  /**
   * How much unread mail this session has.
   *
   * Powers the "is anything waiting?" probe, and -- equally -- lets a drain that
   * returns nothing be distinguished from a drain that could not reach the bank
   * at all. Zero-rows-and-healthy must not look like broken.
   */
  pendingCount(
    sessionId: string,
    now: number,
    options: PullInboxFilterOptions = {},
  ): number {
    return this.pendingCounts(sessionId, now, options).total;
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
   *
   * The sweep is deliberately NOT filtered by `includeSwarm`: held swarm rows
   * that expire uncollected must still be cleaned up and notify the sender
   * ("never collected ... safe to resend").
   *
   * Each row's onExpired callback and delete run inside a nested transaction
   * (savepoint). If the callback throws for a row, that row rolls back, the error
   * is logged to console.error, and it remains for the next sweep cycle, while
   * other rows still commit. Exactly-once still holds per row.
   */
  sweepExpired(now: number, onExpired?: (row: PullInboxRecord) => void): PullInboxRecord[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM pull_inbox WHERE acked_at IS NULL AND expires_at <= ?`,
        )
        .all(now) as Row[];
      const records = rows.map(asRecord);
      const deleted: PullInboxRecord[] = [];
      if (records.length > 0) {
        const del = this.db.prepare("DELETE FROM pull_inbox WHERE msg_id = ?");
        const processRow = this.db.transaction((rec: PullInboxRecord) => {
          onExpired?.(rec);
          del.run(rec.msgId);
        });
        for (const rec of records) {
          try {
            processRow(rec);
            deleted.push(rec);
          } catch (err) {
            console.error(`sweepExpired error for msg_id ${rec.msgId}:`, err);
          }
        }
      }
      return deleted;
    })();
  }

  /**
   * Rows claimed longer than `thresholdMs` ago and still unacked, marked as
   * reported so each is reported exactly once for the life of the row.
   *
   * Durable rather than an in-memory Set: see the schema comment.
   *
   * Deliberately NOT filtered by `includeSwarm`: a claimed swarm row that went
   * unconfirmed indicates a broken or crashed client regardless of whether the
   * session subsequent to the claim opted out of swarm.
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

  // Deliberately NO delete-by-session for the session reaper. Mail addressed to a
  // reaped session is still the human's words; it expires through sweepExpired,
  // which tells them so. Deleting it on reap would drop it silently.
}
