import type { D1Database } from "@cloudflare/workers-types";
import { createTelegramClient, type TelegramClient } from "./telegram";
import {
  deleteBySession,
  deleteTopicBySession,
  finalize,
  getBySession,
  markOpen,
  reserve,
  stealReservation,
  topicName,
  MACHINE_ICON_COLORS,
  DEFAULT_ICON_COLOR,
} from "./topics";

export type ResolveTopicResult =
  | { ok: true; messageThreadId: number }
  | { ok: true; messageThreadId: null }
  | { ok: false; kind: "rate_limited"; retryAfter: number };

export interface ResolveTopicOptions {
  sessionId: string;
  machineId: string | null;
  chatId: string;
  dir: string;
  title: string;
  botToken: string;
  now?: number;
  delayFn?: (ms: number) => Promise<void>;
  ttlMs?: number;
  pollAttempts?: number;
  pollIntervalMs?: number;
  tgClient?: TelegramClient;
}

export const RESERVATION_TTL_MS = 120_000; // 120s TTL for topic reservations

/**
 * Resolves a Telegram forum topic for a session using a reservation protocol with TTL,
 * steal CAS, and CAS finalization.
 *
 * Residual failure mode note:
 * If the worker isolate dies right after Telegram topic creation (`createForumTopic`)
 * succeeds in Telegram but before `finalize()` updates D1, an orphan Telegram topic
 * exists with no D1 record. Telegram does not provide an idempotent topic creation API,
 * so this residual cannot be avoided without external distributed transactions.
 * Cleanup for this rare edge case is manual.
 */
export async function resolveTopic(
  db: D1Database,
  opts: ResolveTopicOptions,
): Promise<ResolveTopicResult> {
  // 1. Existing topic lookup
  let existing = await getBySession(db, opts.sessionId);
  if (existing && existing.message_thread_id !== null) {
    if (existing.state === "closed") {
      const tgClient = opts.tgClient ?? createTelegramClient(opts.botToken);
      // Checkpoint 2a question: Can an admin bot post into a closed Telegram forum topic without reopening?
      // Unverified against live Telegram API. Reopening here ensures the topic is uncollapsed/visible.
      const reopenRes = await tgClient.reopenForumTopic({
        chatId: opts.chatId,
        messageThreadId: existing.message_thread_id,
      });

      if (!reopenRes.ok) {
        if (reopenRes.kind === "rate_limited") {
          return {
            ok: false,
            kind: "rate_limited",
            retryAfter: reopenRes.retryAfter,
          };
        }
        if (reopenRes.kind === "thread_not_found") {
          // Closed topic was deleted out-of-band in Telegram -> delete stale D1 row and fall through to recreate
          await deleteTopicBySession(db, opts.sessionId);
        } else {
          // Non-429, non-thread_not_found error (e.g. TOPIC_NOT_MODIFIED)
          // Do not drop notification -> proceed with existing message_thread_id
          return { ok: true, messageThreadId: existing.message_thread_id };
        }
      } else {
        await markOpen(db, { sessionId: opts.sessionId, now: opts.now });
        return { ok: true, messageThreadId: existing.message_thread_id };
      }
    } else {
      return { ok: true, messageThreadId: existing.message_thread_id };
    }
  }

  const name = topicName(opts.dir, opts.title);
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? RESERVATION_TTL_MS;
  const pollAttempts = opts.pollAttempts ?? 5;
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  const delay =
    opts.delayFn ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const tg = opts.tgClient ?? createTelegramClient(opts.botToken);

  // Helper for creator flow (executed by initial reserve winner or steal winner)
  async function runCreatorFlow(): Promise<ResolveTopicResult> {
    const iconColor = opts.machineId
      ? MACHINE_ICON_COLORS[opts.machineId] ?? DEFAULT_ICON_COLOR
      : DEFAULT_ICON_COLOR;

    const createRes = await tg.createForumTopic({
      chatId: opts.chatId,
      name,
      iconColor,
    });

    if (!createRes.ok) {
      // Conditional-delete the reservation row so subsequent calls can try again
      await deleteBySession(db, opts.sessionId);

      if (createRes.kind === "rate_limited") {
        return {
          ok: false,
          kind: "rate_limited",
          retryAfter: createRes.retryAfter,
        };
      }
      // Non-429 failure -> fall back to General
      return { ok: true, messageThreadId: null };
    }

    const threadId = createRes.result.message_thread_id;

    // Finalize CAS: only updates if message_thread_id IS NULL
    const finalized = await finalize(db, {
      sessionId: opts.sessionId,
      messageThreadId: threadId,
      name,
      now: opts.now ?? Date.now(),
    });

    if (finalized) {
      return { ok: true, messageThreadId: threadId };
    }

    // Lost finalize CAS! Another caller finalized first.
    // Residual failure mode note:
    // If the isolate dies right after Telegram topic creation but before finalize(),
    // an orphan Telegram topic remains without a D1 row.
    // When we reach here, finalize returned false because a rival finalized first.
    // Fire compensating delete on the topic we created.
    try {
      await tg.deleteForumTopic({
        chatId: opts.chatId,
        messageThreadId: threadId,
      });
    } catch {
      // Best-effort compensating delete
    }

    // Re-read and use winner's row
    const winnerRow = await getBySession(db, opts.sessionId);
    if (winnerRow && winnerRow.message_thread_id !== null) {
      return { ok: true, messageThreadId: winnerRow.message_thread_id };
    }
    return { ok: true, messageThreadId: null };
  }

  // 2. Reserve
  const wonReserve = await reserve(db, {
    sessionId: opts.sessionId,
    machineId: opts.machineId,
    chatId: opts.chatId,
    name,
    now,
  });

  if (wonReserve) {
    return runCreatorFlow();
  }

  // 3. Loser path
  existing = await getBySession(db, opts.sessionId);
  if (existing && existing.message_thread_id !== null) {
    return { ok: true, messageThreadId: existing.message_thread_id };
  }

  // Bounded poll
  for (let i = 0; i < pollAttempts; i++) {
    await delay(pollIntervalMs);
    existing = await getBySession(db, opts.sessionId);
    if (existing && existing.message_thread_id !== null) {
      return { ok: true, messageThreadId: existing.message_thread_id };
    }
  }

  // Poll exhausted. Check for stale reservation (updated_at < now - TTL)
  const currentNow = opts.now ?? Date.now();
  const expiredBefore = currentNow - ttlMs;

  if (
    existing &&
    existing.message_thread_id === null &&
    existing.updated_at < expiredBefore
  ) {
    const wonSteal = await stealReservation(db, {
      sessionId: opts.sessionId,
      machineId: opts.machineId,
      expiredBefore,
      now: currentNow,
    });

    if (wonSteal) {
      return runCreatorFlow();
    }
  }

  // Fall back to General
  return { ok: true, messageThreadId: null };
}
