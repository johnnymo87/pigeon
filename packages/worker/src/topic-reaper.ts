import type { D1Database } from "@cloudflare/workers-types";
import { isSlackChatId, transportForChat, type ChatTransport } from "./chat";
import {
  deleteNumericOrphans,
  listOrphaned,
  listReapable,
  deleteTopicBySession,
  markClosed,
} from "./topics";

export const REAP_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (matches daemon's SESSION_TTL_MS)
export const DEFAULT_REAP_CAP = 5;
export const DEFAULT_ORPHAN_CAP = 30;

/**
 * pigeon-4890 / pigeon-ln8z — the orphan-closer runs on exactly ONE hourly tick per day.
 *
 * Closing a Telegram forum topic made Telegram post a service message into it, which marked the
 * topic UNREAD, and running the closer on every hourly cron trickled newly-unread topics into the
 * sidebar around the clock. Gating it to a single tick turned that into a single moment of the
 * day. Slack has no such unread mark (closing archives the channel), so the gate is no longer
 * needed for its original reason; it is kept as a harmless daily batch rather than redesigned.
 *
 * It is one tick, not a multi-hour window. pigeon-4890 shipped a 4-hour window (12–15 UTC) whose
 * trailing hours were meant as a stateless catch-up that would "find zero orphans" on an ordinary
 * day. That premise was false: orphans appear continuously (sessions cross the 7-day TTL every
 * hour, and the daemon's hourly reaper defers unregisters to this closer), so every trailing tick
 * found and closed a few more — observed 12/2/4/5 closes at 12/13/14/15 UTC on 2026-09-30.
 *
 * The cost of one tick: a run cut short by a provider 429, or a backlog over DEFAULT_ORPHAN_CAP,
 * waits until tomorrow's tick. That is NOT rare: the loop is unpaced and each close posts into the
 * same group, so busy days likely hit Telegram's per-group limit around ~20 closes (2026-09-23 ran
 * 21/21/15 across the old window). Spill is still one batch per night, just a day later — harmless
 * for a dead topic. Pacing the loop is the lever if that lag ever matters.
 *
 * 04:00 UTC is midnight US Eastern during daylight time (23:00 during standard time — the cron is
 * UTC-only, so the local hour shifts with DST).
 */
export const TOPIC_CLOSE_WINDOW_START_HOUR_UTC = 4;
export const TOPIC_CLOSE_WINDOW_HOURS = 1;

/**
 * Whether a cron tick at `now` is inside the daily topic-close window.
 *
 * Takes the tick time explicitly (callers pass `ScheduledController.scheduledTime`) so the
 * decision is a pure function of the cron schedule rather than of wall-clock drift inside the
 * handler.
 */
export function shouldCloseOrphans(now: number): boolean {
  const hour = new Date(now).getUTCHours();
  return (
    hour >= TOPIC_CLOSE_WINDOW_START_HOUR_UTC &&
    hour < TOPIC_CLOSE_WINDOW_START_HOUR_UTC + TOPIC_CLOSE_WINDOW_HOURS
  );
}

export interface ReapTopicsOptions {
  now?: number;
  reapTtlMs?: number;
  orphanTtlMs?: number;
  limit?: number;
}

export interface ReapResult {
  reaped: number;
}

export interface CloseOrphanedTopicsOptions {
  now?: number;
  orphanTtlMs?: number;
  limit?: number;
  /** Replaces the transport for any Slack row's address (tests). */
  transport?: ChatTransport;
  /** The worker env, which a Slack row needs for its workspace secret. */
  env?: Env;
}

export interface CloseOrphanedResult {
  closedOrphans: number;
  rateLimited: boolean;
}

export interface RunTopicReaperOptions {
  now?: number;
  reapTtlMs?: number;
  orphanTtlMs?: number;
  reapCap?: number;
  orphanCap?: number;
  /** Replaces the transport for any Slack row's address (tests). */
  transport?: ChatTransport;
  /** The worker env, which a Slack row needs for its workspace secret. */
  env?: Env;
  /**
   * Run the orphan-closer this tick. Defaults to true so the reaper stays window-agnostic —
   * the cron handler owns the schedule decision via `shouldCloseOrphans`.
   */
  closeOrphans?: boolean;
}

export interface TopicReaperResult {
  reaped: number;
  closedOrphans: number;
  rateLimited: boolean;
}

/**
 * Job 1 — reap. Forget topics with state='closed' AND closed_at < now - 30 days.
 * Capped at limit per run (default 5). Slack has nothing to delete (a channel can only be
 * archived), so every row, NULL message_thread_id or finalized, numeric or Slack, is just dropped
 * from D1 with no provider call.
 */
export async function reapTopics(
  db: D1Database,
  opts: ReapTopicsOptions,
): Promise<ReapResult> {
  const now = opts.now ?? Date.now();
  const reapTtlMs = opts.reapTtlMs ?? REAP_TTL_MS;
  const orphanTtlMs = opts.orphanTtlMs ?? ORPHAN_TTL_MS;
  const limit = opts.limit ?? DEFAULT_REAP_CAP;
  const closedBefore = now - reapTtlMs;
  const updatedBefore = now - orphanTtlMs;

  const rows = await listReapable(db, { closedBefore, updatedBefore, limit });
  if (rows.length === 0) {
    return { reaped: 0 };
  }

  let reaped = 0;

  // The row is just forgotten: Slack has no delete and a numeric (Telegram-era) row has no
  // provider left to call.
  for (const row of rows) {
    const deleted = await deleteTopicBySession(db, row.session_id, row.chat_id, row.message_thread_id);
    if (deleted) reaped++;
  }

  return { reaped };
}

/**
 * Job 2 — close orphans. Close state='open' topics whose sessions row is absent,
 * or whose sessions.updated_at is older than session TTL (7 days).
 * Capped at limit per run (default 5).
 * NULL message_thread_id rows skip the provider entirely, and a numeric (Telegram-era) row is
 * just deleted from D1: no provider can take the call, and it is not counted as closed.
 */
export async function closeOrphanedTopics(
  db: D1Database,
  opts: CloseOrphanedTopicsOptions,
): Promise<CloseOrphanedResult> {
  const now = opts.now ?? Date.now();
  const orphanTtlMs = opts.orphanTtlMs ?? ORPHAN_TTL_MS;
  const limit = opts.limit ?? DEFAULT_ORPHAN_CAP;
  const updatedBefore = now - orphanTtlMs;

  // Numeric (Telegram-era) orphans have no provider call to make and are not counted as closed, so
  // they are dropped first in one statement. Left in `listOrphaned`'s oldest-first window they would
  // eat the cap ahead of the Slack orphans that actually need an archive.
  await deleteNumericOrphans(db, updatedBefore);

  const rows = await listOrphaned(db, { updatedBefore, limit });
  if (rows.length === 0) {
    return { closedOrphans: 0, rateLimited: false };
  }

  const tgFor = (chatId: string) => transportForChat(chatId, opts.env ? { env: opts.env, db } : undefined, opts.transport);
  let closedOrphans = 0;
  // A 429 stops the remaining provider calls of this run (rows with no call to make still go).
  let limited = false;

  for (const row of rows) {
    if (!isSlackChatId(row.chat_id)) {
      await deleteTopicBySession(db, row.session_id, row.chat_id, row.message_thread_id);
      continue;
    }

    if (row.message_thread_id === null) {
      await markClosed(db, { sessionId: row.session_id, chatId: row.chat_id, now });
      closedOrphans++;
      continue;
    }

    if (limited) continue;

    const res = await tgFor(row.chat_id).archiveConversation({
      chatId: row.chat_id,
      messageThreadId: row.message_thread_id,
    });

    if (!res.ok && res.kind === "rate_limited") {
      limited = true;
      continue;
    }

    // Everything that is not a 429 marks the row closed — including a GENERIC failure.
    //
    // This mirrors Fix A in topic-manager.ts and exists for the same reason: D1 state is what the
    // reaper reads, so a row we decline to advance is a row that can never age toward reaping.
    // Leaving a generic failure unmarked meant `listOrphaned` re-selected it on EVERY cron run
    // forever, and because that query orders by `created_at ASC` each such row permanently pinned
    // one of the DEFAULT_ORPHAN_CAP slots — five of them starve the orphan-closer completely.
    //
    // Safe because the orphan-closer only ever fires on a session that is absent or idle past the
    // liveness TTL, and `listReapable` independently refuses to reap a topic whose session is live.
    // So marking closed here cannot strand a topic a live session is still posting to.
    await markClosed(db, { sessionId: row.session_id, chatId: row.chat_id, now });
    closedOrphans++;
  }

  return { closedOrphans, rateLimited: limited };
}

/**
 * Entry point called by scheduled cron.
 * Executes reapTopics then closeOrphanedTopics. Stops early if rate_limited.
 */
export async function runTopicReaper(
  db: D1Database,
  opts: RunTopicReaperOptions = {},
): Promise<TopicReaperResult> {
  const reapRes = await reapTopics(db, {
    now: opts.now,
    reapTtlMs: opts.reapTtlMs,
    // Must be forwarded: it is the reaper's session-liveness cutoff. Omitting it silently split the
    // system's definition of "live" — the orphan-closer honouring an override while the reaper fell
    // back to the 7d default — which is exactly the drift the shared constant exists to prevent.
    orphanTtlMs: opts.orphanTtlMs,
    limit: opts.reapCap,
  });

  // Reaping stays on the hourly cadence: it only forgets D1 rows, which nothing can see.
  if (opts.closeOrphans === false) {
    return { reaped: reapRes.reaped, closedOrphans: 0, rateLimited: false };
  }

  const orphanRes = await closeOrphanedTopics(db, {
    now: opts.now,
    orphanTtlMs: opts.orphanTtlMs,
    limit: opts.orphanCap,
    transport: opts.transport,
    env: opts.env,
  });

  return {
    reaped: reapRes.reaped,
    closedOrphans: orphanRes.closedOrphans,
    rateLimited: orphanRes.rateLimited,
  };
}
