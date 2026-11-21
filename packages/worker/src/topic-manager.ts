import type { D1Database } from "@cloudflare/workers-types";
import { failureDetails, isPermanentTopicFailure } from "./chat/failures";
import { isSlackChatId, transportForChat, type ChatTransport } from "./chat";
import {
  deleteBySession,
  deleteTopicBySession,
  finalize,
  getBySession,
  hasPlaceholderName,
  isPlaceholderTitle,
  markOpen,
  renameProvisional,
  reserve,
  stealReservation,
  topicName,
  type TopicRow,
} from "./topics";

export type ResolveTopicResult =
  | { ok: true; messageThreadId: number }
  // `reason` names WHY no topic was resolved, so the caller can report the fallback instead of
  // only logging it. These paths write no intended_thread_id, which is exactly why the
  // messages column pair cannot see them (pigeon-t5bd).
  // `transient` indicates whether the resolution failure is transient (true) or permanent (false).
  // When the caller requests `onTopicUnavailable: "retry"`, transient failures are held for retry
  // (returning 502) rather than relocating to General (pigeon-iqpd).
  // `createError` carries the underlying provider error details when topic creation failed.
  | {
      ok: true;
      messageThreadId: null;
      reason?: string;
      transient: boolean;
      createError?: unknown;
    }
  | { ok: false; kind: "rate_limited"; retryAfter: number };

export interface ResolveTopicOptions {
  sessionId: string;
  machineId: string | null;
  chatId: string;
  dir: string;
  title: string;
  now?: number;
  delayFn?: (ms: number) => Promise<void>;
  ttlMs?: number;
  pollAttempts?: number;
  pollIntervalMs?: number;
  /** Replaces the transport for ANY address, Slack included (tests). */
  transport?: ChatTransport;
  /** The worker env, which a Slack address needs for its workspace secret. */
  env?: Env;
}

export const RESERVATION_TTL_MS = 120_000; // 120s TTL for topic reservations. Outbox TOPIC_HOLD_WINDOW_MS (150s in daemon/outbox-sender.ts) must exceed this.

/**
 * Resolves a session's conversation (a Slack channel) using a reservation protocol with TTL,
 * steal CAS, and CAS finalization.
 *
 * A `topics` row whose chat is not a `slack:` address (a numeric Telegram-era row) is treated as
 * ABSENT: it is CAS-deleted without a provider call and the conversation is created in Slack as
 * for a new session. There is no second transport to supersede between.
 *
 * Residual failure mode note:
 * If the worker isolate dies right after conversation creation (`createConversation`) succeeds
 * but before `finalize()` updates D1, an orphan channel exists with no D1 record. The provider
 * has no idempotent creation API, so this residual cannot be avoided without external
 * distributed transactions. Cleanup for this rare edge case is manual.
 */
export async function resolveTopic(
  db: D1Database,
  opts: ResolveTopicOptions,
): Promise<ResolveTopicResult> {
  // opencode's placeholder title is not a title. Normalising it away here — rather than trusting
  // the daemon to have done it — is what stops a daemon that has not been updated yet from
  // minting another timestamp-named topic (pigeon-353p).
  const title = isPlaceholderTitle(opts.title) ? "" : opts.title.trim();
  const slackCtx = opts.env ? { env: opts.env, db } : undefined;

  /**
   * One-shot upgrade of a directory-only topic name, fired by the first notification that
   * carries a real title. Best-effort and strictly cosmetic: every failure leaves the flag set
   * (so the next titled notification retries) and never disturbs delivery of the notification
   * that triggered it.
   */
  async function upgradeProvisionalName(
    row: TopicRow,
    messageThreadId: number,
  ): Promise<void> {
    if (row.name_provisional !== 1 || title === "") return;

    // The provisional name IS the abbreviated directory (it is what `topicName(dir, "")`
    // returned), so it is a sound fallback when this particular notification carries no dir.
    // Re-abbreviating an already-abbreviated `~/...` is a no-op: topicName's regex only matches
    // an absolute /home/<user> or /Users/<user> prefix. Two names are NOT directories and must
    // never be fed back in: "session" (topicName's dir-less sentinel) and a backfilled
    // `New session - <ISO> · ~/path`, which would otherwise be baked into the upgraded name.
    const fallbackDir =
      row.name && row.name !== "session" && !hasPlaceholderName(row.name) ? row.name : "";
    const name = topicName(opts.dir || fallbackDir, title);

    const chat = transportForChat(opts.chatId, slackCtx, opts.transport);
    try {
      const res = await chat.renameConversation({
        chatId: opts.chatId,
        messageThreadId,
        name,
        sessionId: opts.sessionId,
      });

      // `topic_not_modified` means the provider already shows this name — most likely because a
      // rival isolate got there first, or because a previous attempt succeeded and only the D1
      // write was lost. Either way the desired end state holds, so clear the flag.
      if (res.ok || res.kind === "topic_not_modified") {
        await renameProvisional(db, { sessionId: opts.sessionId, name, chatId: opts.chatId, now: opts.now });
        return;
      }

      // Everything else — rate_limited, thread_not_found, revoked token rights, a 5xx —
      // leaves the flag set so a later titled notification retries. Accepted residual: a
      // PERMANENT edit failure therefore costs one wasted API call per titled notification for
      // the life of the session, the same trade already accepted for the reopen retry below.
      console.warn("[worker] provisional topic rename failed", {
        sessionId: opts.sessionId,
        messageThreadId,
        kind: res.kind,
      });
    } catch (err) {
      console.warn("[worker] provisional topic rename threw", {
        sessionId: opts.sessionId,
        messageThreadId,
        error: String(err),
      });
    }
  }

  /**
   * The session's row lives in a different chat from the one this notification targets
   * (pigeon-533h). A thread id means nothing outside its own chat, so the row can be neither used
   * nor repaired from here: posting into its thread id fails "thread not found", and treating that
   * as an out-of-band deletion is exactly how a healthy topic lost its row. Leave the row alone and
   * let the caller post unthreaded into its own chat. One row per session (`topics` is keyed by
   * session_id), and the chat that created it keeps it.
   */
  function topicInOtherChat(row: TopicRow): ResolveTopicResult {
    console.warn("[worker] session's topic is in another chat, notification will go to General", {
      sessionId: opts.sessionId,
      requestedChatId: opts.chatId,
      topicChatId: row.chat_id,
      messageThreadId: row.message_thread_id,
      reason: "topic_in_other_chat",
    });
    return { ok: true, messageThreadId: null, reason: "topic_in_other_chat", transient: false };
  }

  /**
   * A row in a chat that is not a Slack workspace is a leftover from the Telegram days: no
   * transport can reach its conversation, so it counts for nothing. Delete it (a CAS scoped to its
   * own chat and thread, so a rival that moved the row meanwhile is not undone) and let the caller
   * re-read: the row is gone if the CAS won, and whatever a rival wrote if it missed. No provider
   * call is made: there is nothing to close.
   */
  async function purgeNumericRow(row: TopicRow): Promise<boolean> {
    if (isSlackChatId(row.chat_id)) return false;
    const deleted = await deleteTopicBySession(db, opts.sessionId, row.chat_id, row.message_thread_id);
    console.warn("[worker] dropping a topic row that is not in a Slack workspace", {
      sessionId: opts.sessionId,
      fromChatId: row.chat_id,
      toChatId: opts.chatId,
      messageThreadId: row.message_thread_id,
      deleted,
    });
    return true;
  }

  // 1. Existing topic lookup
  let existing = await getBySession(db, opts.sessionId);
  if (existing && (await purgeNumericRow(existing))) {
    existing = await getBySession(db, opts.sessionId);
  }
  if (existing && existing.chat_id !== opts.chatId) {
    return topicInOtherChat(existing);
  }
  if (existing && existing.message_thread_id !== null) {
    if (existing.state === "closed") {
      const chat = transportForChat(opts.chatId, slackCtx, opts.transport);
      // Reopening (unarchiving) here is belt-and-braces rather than load-bearing: a post into an archived
      // Slack channel is recovered by the transport itself (`withChannelRecovery` unarchives on `is_archived`),
      // so this only makes the conversation visible again before the post.
      const reopenRes = await chat.unarchiveConversation({
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
          // Closed conversation was deleted out-of-band -> delete stale D1 row and fall through to recreate
          await deleteTopicBySession(db, opts.sessionId, opts.chatId, existing.message_thread_id);
        } else if (reopenRes.kind === "topic_not_modified") {
          // Conversation is already open on the provider side -> flip D1 row to open and proceed with existing thread.
          await markOpen(db, { sessionId: opts.sessionId, chatId: opts.chatId, now: opts.now });
          await upgradeProvisionalName(existing, existing.message_thread_id);
          return { ok: true, messageThreadId: existing.message_thread_id };
        } else {
          // Genuine reopen failure (e.g. a provider 5xx, a transient network error, the user token losing its rights).
          // Do not call markOpen so the D1 row remains 'closed' and the reopen is retried on subsequent notifications.
          // Delivery is unaffected because a post into an archived channel unarchives it in the transport.
          //
          // Note on reaper/state:
          // The reaper is double-gated (listReapable requires state='closed' AND closed_at < closedBefore AND the session
          // row to be missing or stale), so a closed row does not arm the reaper while the session is actively receiving notifications.
          // Nothing breaks from posting into a row marked closed. Note that because listOrphaned only selects
          // state='open' rows, a topic stuck closed in D1 but open on the provider side is invisible to the orphan-closer,
          // so no archiveConversation call ever fires for it. Graceful session termination still closes it explicitly;
          // on non-graceful death, the conversation simply stays open until eventual reaping.
          //
          // Accepted residual:
          // If a reopen failure is permanent (e.g. the user token loses its rights), leaving the row closed means
          // every subsequent notification retries a reopen that always fails (~1 wasted API call per notification). This is an accepted trade-off so delivery is unaffected without
          // needing a new attempt-count column. Additionally, because closed_at continues aging from the original
          // close rather than being reset to NULL by markOpen, a permanent reopen failure followed by session idleness
          // (>7d TTL) allows the reaper to delete the topic up to ~30 days earlier than if it had been re-closed on orphan cleanup.
          //
          // No provisional-name upgrade on this branch either: the reopen just failed, so
          // spending another provider call on a cosmetic rename is unlikely to fare better.
          // The name stays provisional and a later notification upgrades it once reopen works.
          return { ok: true, messageThreadId: existing.message_thread_id };
        }
      } else {
        await markOpen(db, { sessionId: opts.sessionId, chatId: opts.chatId, now: opts.now });
        await upgradeProvisionalName(existing, existing.message_thread_id);
        return { ok: true, messageThreadId: existing.message_thread_id };
      }
    } else {
      await upgradeProvisionalName(existing, existing.message_thread_id);
      return { ok: true, messageThreadId: existing.message_thread_id };
    }
  }

  const name = topicName(opts.dir, title);
  // A name built without a real title is only ever the abbreviated directory, so it is eligible
  // for exactly one automatic upgrade later (pigeon-353p).
  const provisional = title === "";
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? RESERVATION_TTL_MS;
  const pollAttempts = opts.pollAttempts ?? 5;
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  const delay =
    opts.delayFn ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const chat = transportForChat(opts.chatId, slackCtx, opts.transport);

  // Helper for creator flow (executed by initial reserve winner or steal winner)
  async function runCreatorFlow(): Promise<ResolveTopicResult> {
    const createRes = await chat.createConversation({
      chatId: opts.chatId,
      name,
      sessionId: opts.sessionId,
    });

    if (!createRes.ok) {
      // Conditional-delete the reservation row so subsequent calls can try again
      // Chat-scoped: the row may have moved to another chat while the create ran (topics.ts chatScope).
      await deleteBySession(db, opts.sessionId, opts.chatId);

      if (createRes.kind === "rate_limited") {
        return {
          ok: false,
          kind: "rate_limited",
          retryAfter: createRes.retryAfter,
        };
      }
      // `no_transport` (a numeric address; unreachable from the routes, which refuse it first) is
      // permanent: holding it for retry could never help.
      const transient = !isPermanentTopicFailure(createRes);
      const createError = failureDetails(createRes);
      // Non-429 failure -> topic resolution failed (pigeon-bit4: say so; this was silent)
      console.warn("[worker] topic creation failed", {
        sessionId: opts.sessionId,
        reason: "create_failed",
        transient,
        details: createError,
      });
      return {
        ok: true,
        messageThreadId: null,
        reason: "create_failed",
        transient,
        createError,
      };
    }

    const threadId = createRes.result.messageThreadId;

    // Finalize CAS: only updates if message_thread_id IS NULL, and only in THIS chat. A create
    // that finishes after the row moved to another chat must not write its thread id there.
    const finalized = await finalize(db, {
      sessionId: opts.sessionId,
      chatId: opts.chatId,
      messageThreadId: threadId,
      name,
      provisional,
      now: opts.now ?? Date.now(),
    });

    if (finalized) {
      return { ok: true, messageThreadId: threadId };
    }

    // Lost finalize CAS! Another caller finalized first.
    // Residual failure mode note:
    // If the isolate dies right after the provider created the conversation but before finalize(),
    // an orphan conversation remains without a D1 row.
    // When we reach here, finalize returned false because a rival finalized first.
    // Fire compensating delete on the topic we created.
    try {
      await chat.deleteConversation({
        chatId: opts.chatId,
        messageThreadId: threadId,
      });
    } catch {
      // Best-effort compensating delete
    }

    // Re-read and use winner's row
    const winnerRow = await getBySession(db, opts.sessionId);
    if (winnerRow && winnerRow.chat_id !== opts.chatId) {
      return topicInOtherChat(winnerRow);
    }
    if (winnerRow && winnerRow.message_thread_id !== null) {
      return { ok: true, messageThreadId: winnerRow.message_thread_id };
    }
    // Lost the CAS and the winner's row is gone or still unfinalized (pigeon-bit4: was silent).
    console.warn("[worker] no topic resolved", {
      sessionId: opts.sessionId,
      reason: "finalize_lost_no_winner",
      transient: true,
    });
    return { ok: true, messageThreadId: null, reason: "finalize_lost_no_winner", transient: true };
  }

  // 2. Reserve
  const reserveHere = () =>
    reserve(db, {
      sessionId: opts.sessionId,
      machineId: opts.machineId,
      chatId: opts.chatId,
      name,
      now,
    });
  const wonReserve = await reserveHere();

  if (wonReserve) {
    return runCreatorFlow();
  }

  // 3. Loser path. The row that beat our reserve may belong to another chat (pigeon-533h).
  existing = await getBySession(db, opts.sessionId);
  if (existing && (await purgeNumericRow(existing))) {
    // The row that beat our reserve was a numeric leftover, and it is gone now: reserve again.
    if (await reserveHere()) return runCreatorFlow();
    existing = await getBySession(db, opts.sessionId);
  }
  if (existing && existing.chat_id !== opts.chatId) {
    return topicInOtherChat(existing);
  }
  if (existing && existing.message_thread_id !== null) {
    return { ok: true, messageThreadId: existing.message_thread_id };
  }

  // Bounded poll
  for (let i = 0; i < pollAttempts; i++) {
    await delay(pollIntervalMs);
    existing = await getBySession(db, opts.sessionId);
    if (existing && (await purgeNumericRow(existing))) {
      if (await reserveHere()) return runCreatorFlow();
      existing = await getBySession(db, opts.sessionId);
    }
    if (existing && existing.chat_id !== opts.chatId) {
      return topicInOtherChat(existing);
    }
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
      chatId: opts.chatId,
      now: currentNow,
    });

    if (wonSteal) {
      return runCreatorFlow();
    }
  }

  // Bounded poll expired without the winner finalizing and the reservation is not yet stale enough to steal.
  console.warn("[worker] no topic resolved", {
    sessionId: opts.sessionId,
    reason: "poll_exhausted",
    transient: true,
  });
  return { ok: true, messageThreadId: null, reason: "poll_exhausted", transient: true };
}
