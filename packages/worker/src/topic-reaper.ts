import type { D1Database } from "@cloudflare/workers-types";
import { createTelegramClient, type TelegramClient } from "./telegram";
import {
  listOrphaned,
  listReapable,
  deleteTopicBySession,
  markClosed,
  topicsEnabled,
} from "./topics";

export const REAP_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (matches daemon's SESSION_TTL_MS)
export const DEFAULT_REAP_CAP = 5;
export const DEFAULT_ORPHAN_CAP = 5;

export interface ReapTopicsOptions {
  botToken: string;
  now?: number;
  reapTtlMs?: number;
  orphanTtlMs?: number;
  limit?: number;
  tgClient?: TelegramClient;
}

export interface ReapResult {
  reaped: number;
  rateLimited: boolean;
}

export interface CloseOrphanedTopicsOptions {
  botToken: string;
  now?: number;
  orphanTtlMs?: number;
  limit?: number;
  tgClient?: TelegramClient;
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
  tgClient?: TelegramClient;
}

export interface TopicReaperResult {
  reaped: number;
  closedOrphans: number;
  rateLimited: boolean;
}

/**
 * Job 1 — reap. Delete topics with state='closed' AND closed_at < now - 30 days.
 * Capped at limit per run (default 5). On thread_not_found, drops the D1 row anyway.
 * NULL message_thread_id rows skip Telegram entirely.
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
    return { reaped: 0, rateLimited: false };
  }

  const tg = opts.tgClient ?? createTelegramClient(opts.botToken);
  let reaped = 0;

  for (const row of rows) {
    if (row.message_thread_id === null) {
      await deleteTopicBySession(db, row.session_id);
      reaped++;
      continue;
    }

    const res = await tg.deleteForumTopic({
      chatId: row.chat_id,
      messageThreadId: row.message_thread_id,
    });

    if (res.ok || res.kind === "thread_not_found") {
      await deleteTopicBySession(db, row.session_id);
      reaped++;
    } else if (res.kind === "rate_limited") {
      return { reaped, rateLimited: true };
    }
  }

  return { reaped, rateLimited: false };
}

/**
 * Job 2 — close orphans. Close state='open' topics whose sessions row is absent,
 * or whose sessions.updated_at is older than session TTL (7 days).
 * Capped at limit per run (default 5).
 * NULL message_thread_id rows skip Telegram entirely.
 */
export async function closeOrphanedTopics(
  db: D1Database,
  opts: CloseOrphanedTopicsOptions,
): Promise<CloseOrphanedResult> {
  const now = opts.now ?? Date.now();
  const orphanTtlMs = opts.orphanTtlMs ?? ORPHAN_TTL_MS;
  const limit = opts.limit ?? DEFAULT_ORPHAN_CAP;
  const updatedBefore = now - orphanTtlMs;

  const rows = await listOrphaned(db, { updatedBefore, limit });
  if (rows.length === 0) {
    return { closedOrphans: 0, rateLimited: false };
  }

  const tg = opts.tgClient ?? createTelegramClient(opts.botToken);
  let closedOrphans = 0;

  for (const row of rows) {
    if (row.message_thread_id === null) {
      await markClosed(db, { sessionId: row.session_id, now });
      closedOrphans++;
      continue;
    }

    const res = await tg.closeForumTopic({
      chatId: row.chat_id,
      messageThreadId: row.message_thread_id,
    });

    if (res.ok || res.kind === "thread_not_found") {
      await markClosed(db, { sessionId: row.session_id, now });
      closedOrphans++;
    } else if (res.kind === "rate_limited") {
      return { closedOrphans, rateLimited: true };
    }
  }

  return { closedOrphans, rateLimited: false };
}

/**
 * Entry point called by scheduled cron.
 * Gated on topicsEnabled(env). Flag off => returns immediately with zeros.
 * Executes reapTopics then closeOrphanedTopics. Stops early if rate_limited.
 */
export async function runTopicReaper(
  db: D1Database,
  env: { TELEGRAM_TOPICS_ENABLED?: string; TELEGRAM_BOT_TOKEN: string },
  opts: RunTopicReaperOptions = {},
): Promise<TopicReaperResult> {
  if (!topicsEnabled(env)) {
    return { reaped: 0, closedOrphans: 0, rateLimited: false };
  }

  const botToken = env.TELEGRAM_BOT_TOKEN;
  const reapRes = await reapTopics(db, {
    botToken,
    now: opts.now,
    reapTtlMs: opts.reapTtlMs,
    limit: opts.reapCap,
    tgClient: opts.tgClient,
  });

  if (reapRes.rateLimited) {
    return {
      reaped: reapRes.reaped,
      closedOrphans: 0,
      rateLimited: true,
    };
  }

  const orphanRes = await closeOrphanedTopics(db, {
    botToken,
    now: opts.now,
    orphanTtlMs: opts.orphanTtlMs,
    limit: opts.orphanCap,
    tgClient: opts.tgClient,
  });

  return {
    reaped: reapRes.reaped,
    closedOrphans: orphanRes.closedOrphans,
    rateLimited: orphanRes.rateLimited,
  };
}
