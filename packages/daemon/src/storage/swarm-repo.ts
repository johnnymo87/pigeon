import type BetterSqlite3 from "better-sqlite3";
import { NUDGE_KIND } from "../swarm/delivery-policy";
import type { VerifyFamily } from "../swarm/verify-family";

type Row = Record<string, unknown>;

export type Priority = "urgent" | "normal" | "low";

export interface SwarmMessageRecord {
  msgId: string;
  fromSession: string;
  toSession: string | null;
  channel: string | null;
  kind: string;
  priority: Priority;
  replyTo: string | null;
  payload: string;
  state: "queued" | "handed_off" | "failed" | "expired" | "cancelled";
  attempts: number;
  nextRetryAt: number | null;
  createdAt: number;
  updatedAt: number;
  handedOffAt: number | null;
  verifiedAt: number | null;
  requeueCount: number;
  /** How many nudges have been sent for this row. See {@link SwarmRepository.recordNudge}. */
  nudgeCount: number;
  abortedAt: number | null;
  deliverAt: number | null;
  expiresAt: number | null;
  cancelledAt: number | null;
  ref: string | null;
  /**
   * How this row's delivery is confirmed, stamped at handoff. NULL means the
   * transcript (opencode) family. Deliberately carried on the message rather
   * than joined from the target session, whose row can be deleted and whose
   * `backend_kind` can change while this row lives on. See
   * `swarm/verify-family.ts`.
   */
  verifyFamily: string | null;
}

/** Cursor-based paging options for {@link SwarmRepository.getInbox}. */
export interface GetInboxOptions {
  /** Return messages strictly newer than this msg_id (forward replay). */
  since?: string | null;
  /** Return messages strictly older than this msg_id (scroll-back). */
  before?: string | null;
  /** Max messages to return. Omit for "all matching rows". */
  limit?: number;
}

/** A page of inbox messages plus whether more exist beyond the window. */
export interface InboxPage {
  messages: SwarmMessageRecord[];
  hasMore: boolean;
}

export interface InsertSwarmInput {
  msgId: string;
  fromSession: string;
  toSession: string | null;
  channel: string | null;
  kind: string;
  priority: Priority;
  replyTo: string | null;
  payload: string;
  deliverAt?: number | null;
  expiresAt?: number | null;
  ref?: string | null;
}

function asRecord(row: Row): SwarmMessageRecord {
  return {
    msgId: String(row.msg_id),
    fromSession: String(row.from_session),
    toSession: (row.to_session as string | null) ?? null,
    channel: (row.channel as string | null) ?? null,
    kind: String(row.kind),
    priority: String(row.priority) as Priority,
    replyTo: (row.reply_to as string | null) ?? null,
    payload: String(row.payload),
    state: String(row.state) as SwarmMessageRecord["state"],
    attempts: Number(row.attempts),
    nextRetryAt: (row.next_retry_at as number | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    handedOffAt: (row.handed_off_at as number | null) ?? null,
    verifiedAt: (row.verified_at as number | null) ?? null,
    requeueCount: Number(row.requeue_count ?? 0),
    nudgeCount: Number(row.nudge_count ?? 0),
    abortedAt: (row.aborted_at as number | null) ?? null,
    deliverAt: (row.deliver_at as number | null) ?? null,
    expiresAt: (row.expires_at as number | null) ?? null,
    cancelledAt: (row.cancelled_at as number | null) ?? null,
    ref: (row.ref as string | null) ?? null,
    verifyFamily: (row.verify_family as string | null) ?? null,
  };
}

export class SwarmRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  insert(input: InsertSwarmInput, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO swarm_messages
           (msg_id, from_session, to_session, channel, kind, priority, reply_to, payload,
            state, attempts, next_retry_at, created_at, updated_at, handed_off_at,
            deliver_at, expires_at, ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT(msg_id) DO NOTHING`,
      )
      .run(
        input.msgId,
        input.fromSession,
        input.toSession,
        input.channel,
        input.kind,
        input.priority,
        input.replyTo,
        input.payload,
        now,
        now,
        input.deliverAt ?? null,
        input.expiresAt ?? null,
        input.ref ?? null,
      );
    return result.changes > 0;
  }

  getByMsgId(msgId: string): SwarmMessageRecord | null {
    const row = this.db
      .prepare("SELECT * FROM swarm_messages WHERE msg_id = ?")
      .get(msgId) as Row | undefined;
    return row ? asRecord(row) : null;
  }

  getReadyForTarget(
    toSession: string,
    now: number,
    limit = 1,
  ): SwarmMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM swarm_messages
         WHERE to_session = ?
           AND state = 'queued'
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
           AND (deliver_at IS NULL OR deliver_at <= ?)
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(toSession, now, now, now, limit) as Row[];
    return rows.map(asRecord);
  }

  listTargetsWithReady(now: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT to_session
         FROM swarm_messages
         WHERE state = 'queued'
           AND to_session IS NOT NULL
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
           AND (deliver_at IS NULL OR deliver_at <= ?)
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .all(now, now, now) as Array<{ to_session: string }>;
    return rows.map((r) => r.to_session);
  }

  /**
   * Commits a successful handoff, stamping HOW this delivery will be confirmed.
   *
   * `family` is omitted by the opencode path, leaving NULL, which reads back as
   * `transcript` — so every existing caller and every existing row keeps its
   * current behaviour with no backfill. A receipt-family backend passes its
   * family here, at the one moment the channel that did the work is known for
   * certain. See `swarm/verify-family.ts` for why this is stamped rather than
   * joined.
   */
  markHandedOff(msgId: string, now = Date.now(), family?: VerifyFamily): boolean {
    const result = this.db
      .prepare(
        `UPDATE swarm_messages
         SET state = 'handed_off', handed_off_at = ?, updated_at = ?, next_retry_at = NULL,
             verify_family = COALESCE(?, verify_family)
         WHERE msg_id = ? AND state = 'queued'`,
      )
      .run(now, now, family ?? null, msgId);
    return result.changes > 0;
  }

  /**
   * Promotes a message to `handed_off` when delivery succeeded but a cancel
   * landed mid-flight (state was `cancelled`). Preserves `cancelled_at` as an
   * audit trail: `cancelled_at` set on a `handed_off` row means "cancel raced and lost".
   */
  markHandedOffAfterCancel(msgId: string, now = Date.now(), family?: VerifyFamily): boolean {
    const result = this.db
      .prepare(
        `UPDATE swarm_messages
         SET state = 'handed_off', handed_off_at = ?, updated_at = ?, next_retry_at = NULL,
             verify_family = COALESCE(?, verify_family)
         WHERE msg_id = ? AND state = 'cancelled'`,
      )
      .run(now, now, family ?? null, msgId);
    return result.changes > 0;
  }

  markCancelled(msgId: string, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE swarm_messages
         SET state = 'cancelled', cancelled_at = ?, updated_at = ?, next_retry_at = NULL
         WHERE msg_id = ? AND state = 'queued'`,
      )
      .run(now, now, msgId);
    return result.changes > 0;
  }

  markExpired(msgId: string, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE swarm_messages
         SET state = 'expired', updated_at = ?, next_retry_at = NULL
         WHERE msg_id = ? AND state = 'queued'`,
      )
      .run(now, msgId);
    return result.changes > 0;
  }

  listScheduled(
    sessionId: string,
    opts?: { includeTerminalSince?: number },
  ): SwarmMessageRecord[] {
    const includeTerminalSince = opts?.includeTerminalSince;
    if (typeof includeTerminalSince === "number") {
      const rows = this.db
        .prepare(
          `SELECT * FROM swarm_messages
           WHERE deliver_at IS NOT NULL
             AND (from_session = ? OR to_session = ?)
             AND (state = 'queued' OR (state IN ('expired', 'failed', 'cancelled') AND updated_at >= ?))
           ORDER BY deliver_at ASC`,
        )
        .all(sessionId, sessionId, includeTerminalSince) as Row[];
      return rows.map(asRecord);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM swarm_messages
         WHERE state = 'queued'
           AND deliver_at IS NOT NULL
           AND (from_session = ? OR to_session = ?)
         ORDER BY deliver_at ASC`,
      )
      .all(sessionId, sessionId) as Row[];
    return rows.map(asRecord);
  }

  listExpired(now: number): SwarmMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM swarm_messages
         WHERE state = 'queued'
           AND expires_at IS NOT NULL
           AND expires_at <= ?`,
      )
      .all(now) as Row[];
    return rows.map(asRecord);
  }

  /**
   * Scheduled rows whose delivery time passed over `thresholdMs` ago AND that
   * nothing has touched since. Powers the watchdog's "is the delivery loop
   * even running?" alarm.
   *
   * The `updated_at` half is what makes the alarm honest, and it is not
   * optional. Overdue-and-queued ALONE is the normal, healthy state during an
   * outage: when no serve is routable the arbiter reschedules the row without
   * charging its attempt budget, so a wake scheduled for 03:00 sits queued and
   * overdue for the whole nightly serve bounce while the system does exactly
   * what it was designed to do. Alarming on that would page at 3am to say the
   * delivery loop was stopped, which would be false — and a nightly false alarm
   * is how a real one gets ignored.
   *
   * Every retry path bumps `updated_at` (see `markRetry` / `markRetryUncounted`),
   * so a live loop keeps the timestamp fresh and this query skips the row. A
   * frozen `updated_at` means nothing is touching the row at all, which is the
   * condition actually worth waking someone for.
   */
  listOverdueQueued(now: number, thresholdMs: number): SwarmMessageRecord[] {
    const cutoff = now - thresholdMs;
    const rows = this.db
      .prepare(
        `SELECT * FROM swarm_messages
         WHERE state = 'queued'
           AND deliver_at IS NOT NULL
           AND deliver_at <= ?
           AND updated_at <= ?`,
      )
      .all(cutoff, cutoff) as Row[];
    return rows.map(asRecord);
  }

  /**
   * Confirms an assistant run actually started for a handed-off message.
   * Verified rows are never re-checked.
   *
   * Guarded on `state = 'handed_off'` and returns whether it applied. Safe today
   * with one caller, which selected the row by state anyway — added before the
   * SECOND caller (a receipt sink) exists, because without the guard that caller
   * would happily stamp `verified_at` on a cancelled or failed row, minting a
   * record the evidence does not support. A `false` return after a watchdog
   * terminal means the terminal won the race and the receipt lost; that is worth
   * logging, not ignoring.
   *
   * Deliberately does NOT bump `updated_at`: {@link cleanupOlderThan} anchors
   * retention on `updated_at`, and bumping it here would reset the retention
   * clock for messages that have already been sitting in `handed_off` for a
   * while, extending how long they linger before cleanup.
   */
  markVerified(msgId: string, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE swarm_messages
         SET verified_at = ?
         WHERE msg_id = ? AND state = 'handed_off'`,
      )
      .run(now, msgId);
    return result.changes > 0;
  }

  /** Watchdog-initiated redelivery of a message whose handoff was never verified. */
  requeueForRecovery(msgId: string, now: number, delayMs: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE swarm_messages
         SET state = 'queued', next_retry_at = ?, updated_at = ?, requeue_count = requeue_count + 1
         WHERE msg_id = ? AND state = 'handed_off'`,
      )
      .run(now + delayMs, now, msgId);
    return result.changes > 0;
  }

  /**
   * Records that a nudge has been sent for this message.
   *
   * Unlike {@link requeueForRecovery} this does NOT change `state`: the row
   * stays `handed_off`, because its payload is still sitting in the target's
   * transcript exactly once and must not be re-sent. The nudge is a separate,
   * much smaller message that asks the target to read what it already has.
   *
   * Guarded on `state = 'handed_off'` so a row that raced to verified,
   * cancelled or failed cannot have its counter bumped after the fact.
   *
   * Deliberately does NOT bump `updated_at`, for the same reason as
   * {@link markVerified} and {@link markAborted}: `cleanupOlderThan` anchors
   * retention on it, and nudging a row should not extend its retained life.
   */
  recordNudge(msgId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE swarm_messages
         SET nudge_count = nudge_count + 1
         WHERE msg_id = ? AND state = 'handed_off'`,
      )
      .run(msgId);
    return result.changes > 0;
  }

  /**
   * Returns true if there is an undelivered (`state = 'queued'`) nudge message
   * in response to `msgId`. Used by the watchdog to prevent minting new nudges
   * before a previous nudge has actually been handed off.
   */
  hasQueuedNudge(msgId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM swarm_messages
         WHERE reply_to = ? AND kind = ? AND state = 'queued'
         LIMIT 1`,
      )
      .get(msgId, NUDGE_KIND);
    return row !== undefined;
  }

  /**
   * Stamps `aborted_at`. NO PRODUCTION CALLER since R3 removed the abort path
   * (pigeon-0gxy) — the watchdog never preempts a running turn, so nothing
   * new is ever marked aborted.
   *
   * Retained on purpose, for two reasons — note the SECOND is the durable one:
   *  - it is the only writer for a column that carried PRE-R3 rows in the
   *    production DB (as of the pigeon-3m5 analysis, 2026-08: 7 of 9 requeued
   *    specimens had it set). Do not treat that as a present-tense fact —
   *    {@link cleanupOlderThan} reaps terminal/verified rows on retention, so
   *    those specimens age out and the claim goes false silently;
   *  - tests use it to construct such a legacy row, which is how
   *    "13. a historic row with aborted_at set is NOT failed on sight" and
   *    "33. a historic wake row carrying aborted_at is left alone" pin the
   *    behaviour that legacy data is not mistreated.
   *
   * First-write-wins: a second call is a no-op leaving the original stamp.
   *
   * Deliberately does NOT bump `updated_at`, for the same reason as
   * {@link markVerified}: {@link cleanupOlderThan} anchors retention on it.
   */
  markAborted(msgId: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE swarm_messages
         SET aborted_at = ?
         WHERE msg_id = ? AND aborted_at IS NULL`,
      )
      .run(now, msgId);
  }

  /**
   * Handed-off, session-targeted messages whose assistant run has not yet
   * been verified, and whose handoff is old enough to be worth checking.
   * Excludes channel messages (no single target session to verify against)
   * and messages handed off more recently than `verifyAfterMs`.
   */
  listUnverifiedHandedOff(now: number, verifyAfterMs: number): SwarmMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM swarm_messages
         WHERE state = 'handed_off'
           AND verified_at IS NULL
           AND to_session IS NOT NULL
           AND handed_off_at < ?`,
      )
      .all(now - verifyAfterMs) as Row[];
    return rows.map(asRecord);
  }

  markRetry(msgId: string, now: number, backoffMs: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE swarm_messages
         SET attempts = attempts + 1, next_retry_at = ?, updated_at = ?, state = 'queued'
         WHERE msg_id = ? AND state = 'queued'`,
      )
      .run(now + backoffMs, now, msgId);
    return result.changes > 0;
  }

  markRetryUncounted(msgId: string, now: number, backoffMs: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE swarm_messages
         SET next_retry_at = ?, updated_at = ?, state = 'queued'
         WHERE msg_id = ? AND state = 'queued'`,
      )
      .run(now + backoffMs, now, msgId);
    return result.changes > 0;
  }

  /**
   * `verified_at IS NULL` is the mirror of {@link markVerified}'s state guard.
   * The watchdog selects unverified rows and then awaits (alerts, fetches)
   * before terminating; once a receipt sink can verify concurrently, that await
   * is a window in which a row can verify and still be marked failed — telling
   * the sender a turn that ran was never observed. A no-op today for the same
   * reason the other guard is: there is only one writer, which is exactly why
   * this is the cheap moment to close it.
   */
  markFailed(msgId: string, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE swarm_messages
         SET state = 'failed', updated_at = ?, next_retry_at = NULL
         WHERE msg_id = ? AND state IN ('queued', 'handed_off') AND verified_at IS NULL`,
      )
      .run(now, msgId);
    return result.changes > 0;
  }

  /**
   * Fetch inbox messages for a session.
   *
   * Selects on the structural property "this payload provably reached your transcript":
   * includes rows currently `state = 'handed_off'` OR rows previously handed off
   * (`handed_off_at IS NOT NULL`), even if they later moved to `failed` (e.g. via nudge
   * exhaustion). This ensures an agent reading a nudge instructing it to call `swarm_read`
   * can fetch the payload even after nudge exhaustion marked the row failed. Rows that failed
   * BEFORE handoff (`handed_off_at IS NULL`) never reached the target transcript and are excluded.
   *
   * Messages are ALWAYS returned in ascending msg_id order (chronological,
   * oldest-first) regardless of paging direction, because every consumer —
   * `swarm_read`, the `since` cursor, and the delivery-check jq snippet —
   * expects chronological order.
   *
   * Paging is cursor-based and skip-safe. Which end of the window `limit`
   * truncates depends on the caller's intent:
   *
   *   - `since=<msg_id>` (forward replay / catch-up): return the OLDEST `limit`
   *     messages *newer* than the cursor. A caller drains forward by advancing
   *     `since` to the newest returned id until `hasMore` is false — never
   *     skipping the middle.
   *   - default / `before=<msg_id>` (recent view / scroll-back): return the
   *     NEWEST `limit` messages (optionally *older* than `before`). Page back
   *     through history by passing `before` = the oldest returned id.
   *
   * `hasMore` reports whether more messages exist beyond the returned window in
   * the direction of paging. Omitting `limit` returns every matching row.
   */
  getInbox(toSession: string, opts: GetInboxOptions = {}): InboxPage {
    const { since = null, before = null, limit } = opts;
    const hasLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0;

    const conds = ["to_session = ?", "(state = 'handed_off' OR handed_off_at IS NOT NULL)"];
    const params: Array<string | number> = [toSession];
    if (since !== null) {
      conds.push("msg_id > ?");
      params.push(since);
    }
    if (before !== null) {
      conds.push("msg_id < ?");
      params.push(before);
    }
    const where = conds.join(" AND ");

    if (!hasLimit) {
      const rows = this.db
        .prepare(`SELECT * FROM swarm_messages WHERE ${where} ORDER BY msg_id ASC`)
        .all(...params) as Row[];
      return { messages: rows.map(asRecord), hasMore: false };
    }

    const n = Math.floor(limit as number);
    // Forward mode when `since` is set (drain oldest-first after the cursor);
    // otherwise recent/scroll-back mode (take newest-first).
    const forward = since !== null;
    const order = forward ? "ASC" : "DESC";
    // Fetch one extra row to detect whether more exist beyond the window.
    const rows = this.db
      .prepare(`SELECT * FROM swarm_messages WHERE ${where} ORDER BY msg_id ${order} LIMIT ?`)
      .all(...params, n + 1) as Row[];

    const hasMore = rows.length > n;
    const windowRows = hasMore ? rows.slice(0, n) : rows;
    const records = windowRows.map(asRecord);
    // Recent/scroll-back mode fetched DESC; flip to ascending for the response.
    if (!forward) records.reverse();
    return { messages: records, hasMore };
  }

  /**
   * Deletes terminal and verified records older than `cutoff` (anchored on `updated_at`).
   *
   * Deletable cases (when `updated_at < cutoff`):
   * 1. Terminal records (`state IN ('failed', 'expired', 'cancelled')`).
   * 2. Handed-off records that were verified before `cutoff` (`state = 'handed_off'`,
   *    `verified_at IS NOT NULL AND verified_at < cutoff`). Requiring `verified_at < cutoff`
   *    prevents deleting records that were handed off long ago but verified recently.
   * 3. Handed-off nudge records (`state = 'handed_off'`, `kind = 'swarm.nudge'`),
   *    even if unverified.
   *
   * Protected case:
   * Unverified handed-off records (or records verified recently) with non-nudge kinds.
   *
   * Carve-out rationale for `swarm.nudge` ({@link NUDGE_KIND}):
   * A nudge is a small message pigeon itself mints to tell a session it has an
   * unread message. A nudge sent to a permanently-dead session stays `handed_off`/unverified
   * forever and is deliberately never nudged again (loop guard). Without this carve-out,
   * the verified requirement would turn pigeon's own nudges into an unbounded leak.
   * This carve-out is keyed on `kind = 'swarm.nudge'`, which is trustworthy because
   * the `swarm.` namespace is rejected at the ingress route (`parseSwarmSendBody` in `app.ts`),
   * so the only way a row can carry `swarm.nudge` is if pigeon minted it internally.
   */
  cleanupOlderThan(cutoff: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM swarm_messages
         WHERE updated_at < ?
           AND (
             state IN ('failed', 'expired', 'cancelled')
             OR (state = 'handed_off' AND ((verified_at IS NOT NULL AND verified_at < ?) OR kind = ?))
           )`,
      )
      .run(cutoff, cutoff, NUDGE_KIND);
    return result.changes;
  }
}
