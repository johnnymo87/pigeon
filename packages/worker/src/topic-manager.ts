import type { D1Database } from "@cloudflare/workers-types";
import { getTelegramErrorDetails, isPermanentTopicFailure } from "./telegram";
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
  MACHINE_ICON_COLORS,
  DEFAULT_ICON_COLOR,
  type TopicRow,
} from "./topics";

export type ResolveTopicResult =
  // `created` is true only on the path that both created the Telegram topic AND won the
  // finalize CAS for it — i.e. exactly one caller per topic ever sees it. Callers use it to
  // clear Telegram's auto-pin of the first message posted into a new topic (pigeon-ud6s).
  | { ok: true; messageThreadId: number; created?: boolean }
  // `reason` names WHY no topic was resolved, so the caller can report the fallback instead of
  // only logging it. These paths write no intended_thread_id, which is exactly why the
  // messages column pair cannot see them (pigeon-t5bd).
  // `transient` indicates whether the resolution failure is transient (true) or permanent (false).
  // When the caller requests `onTopicUnavailable: "retry"`, transient failures are held for retry
  // (returning 502) rather than relocating to General (pigeon-iqpd).
  // `createError` carries the underlying Telegram error details when topic creation failed.
  | {
      ok: true;
      messageThreadId: null;
      created?: boolean;
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
  botToken: string;
  now?: number;
  delayFn?: (ms: number) => Promise<void>;
  ttlMs?: number;
  pollAttempts?: number;
  pollIntervalMs?: number;
  /** Replaces the Telegram transport (tests); a Slack address never reaches it. */
  tgClient?: ChatTransport;
  /** The worker env, which a Slack address needs for its workspace secret. */
  env?: Env;
  /**
   * The caller is the session's owning machine, so a row it left in the OTHER transport (a
   * machine that moved from Telegram to Slack or back) is replaced rather than honoured: the old
   * row is removed, its conversation closed, and a new one created in `chatId`. Without it, and
   * for a row in another chat of the SAME transport, the row stays and the notification goes
   * unthreaded (pigeon-533h). The worker cannot tell a machine's rollout from a foreign machine
   * on its own, so the handler passes this only for the owner.
   */
  supersede?: boolean;
}

/** How long a superseded conversation's close is awaited before the notification carries on. */
export const SUPERSEDE_CLOSE_BOUND_MS = 3_000;

/**
 * A row younger than this is never superseded. Worker isolates pick up a changed
 * `SLACK_WORKSPACE_*` secret one at a time, so for a while some resolve a machine to Slack and
 * others to Telegram. Without a floor, each flips the session's conversation back and forth (every
 * flip archives a channel and mints another). A row that young was almost certainly made by the
 * other side of that overlap; the loser answers `topic_in_other_chat` (unthreaded, healed at the
 * next supersede once the rollout settles and the row has aged).
 */
export const SUPERSEDE_MIN_AGE_MS = 5 * 60_000;

export const RESERVATION_TTL_MS = 120_000; // 120s TTL for topic reservations. Outbox TOPIC_HOLD_WINDOW_MS (150s in daemon/outbox-sender.ts) must exceed this.

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

    const tgClient = transportForChat(opts.chatId, opts.botToken, opts.tgClient, slackCtx);
    try {
      const res = await tgClient.editForumTopic({
        chatId: opts.chatId,
        messageThreadId,
        name,
        sessionId: opts.sessionId,
      });

      // `topic_not_modified` means Telegram already shows this name — most likely because a
      // rival isolate got there first, or because a previous attempt succeeded and only the D1
      // write was lost. Either way the desired end state holds, so clear the flag.
      if (res.ok || res.kind === "topic_not_modified") {
        await renameProvisional(db, { sessionId: opts.sessionId, name, chatId: opts.chatId, now: opts.now });
        return;
      }

      // Everything else — rate_limited, thread_not_found, revoked can_manage_topics, a 5xx —
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

  /** At most one supersede per call: a second foreign row means something is flapping. */
  let superseded = false;

  /**
   * Replaces a row that lives in the other transport, when the caller may. Returns true when a
   * supersede was attempted (so the caller re-reads the row: it is gone if the CAS won, and
   * whatever a rival wrote if it missed), false when the row is to be left alone.
   *
   * The delete is the commit point and is chat- and thread-scoped (a CAS), so two isolates
   * cannot both supersede, and a rival that moved the row meanwhile is not undone. Only the
   * winner closes the old conversation, through ITS transport, awaited because a Worker may stop
   * as soon as it responds, but bounded: a slow or dead provider (a deleted Slack secret, say)
   * must not hold the notification. Close failures are logged and never change the result.
   */
  async function maybeSupersede(row: TopicRow): Promise<boolean> {
    if (!opts.supersede || superseded) return false;
    if (isSlackChatId(row.chat_id) === isSlackChatId(opts.chatId)) return false;
    if ((opts.now ?? Date.now()) - row.created_at < SUPERSEDE_MIN_AGE_MS) return false;
    superseded = true;
    const deleted = await deleteTopicBySession(db, opts.sessionId, row.chat_id, row.message_thread_id);
    console.warn("[worker] superseding the session's conversation in the other transport", {
      sessionId: opts.sessionId,
      fromChatId: row.chat_id,
      toChatId: opts.chatId,
      messageThreadId: row.message_thread_id,
      deleted,
    });
    if (deleted && row.message_thread_id !== null) {
      const threadId = row.message_thread_id;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const old = transportForChat(row.chat_id, opts.botToken, undefined, slackCtx);
        const closing = old
          .closeForumTopic({ chatId: row.chat_id, messageThreadId: threadId })
          .then((res) => {
            if (!res.ok) {
              console.warn("[worker] closing the superseded conversation failed", {
                sessionId: opts.sessionId,
                chatId: row.chat_id,
                kind: res.kind,
              });
            }
          })
          .catch((err) => {
            console.warn("[worker] closing the superseded conversation threw", {
              sessionId: opts.sessionId,
              chatId: row.chat_id,
              error: String(err),
            });
          });
        const bound = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            console.warn("[worker] closing the superseded conversation timed out", {
              sessionId: opts.sessionId,
              chatId: row.chat_id,
            });
            resolve();
          }, SUPERSEDE_CLOSE_BOUND_MS);
        });
        await Promise.race([closing, bound]);
      } catch (err) {
        console.warn("[worker] closing the superseded conversation threw", {
          sessionId: opts.sessionId,
          chatId: row.chat_id,
          error: String(err),
        });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    return true;
  }

  // 1. Existing topic lookup
  let existing = await getBySession(db, opts.sessionId);
  if (existing && existing.chat_id !== opts.chatId && (await maybeSupersede(existing))) {
    existing = await getBySession(db, opts.sessionId);
  }
  if (existing && existing.chat_id !== opts.chatId) {
    return topicInOtherChat(existing);
  }
  if (existing && existing.message_thread_id !== null) {
    if (existing.state === "closed") {
      const tgClient = transportForChat(opts.chatId, opts.botToken, opts.tgClient, slackCtx);
      // Verified against live Telegram API (2026-07-28, bead pigeon-cev): an admin bot CAN post into a closed forum topic.
      // Reopening here is belt-and-braces rather than load-bearing (ensures the topic is uncollapsed/visible).
      // Removing this reopen call is tracked as roadmap item 6c.
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
          await deleteTopicBySession(db, opts.sessionId, opts.chatId, existing.message_thread_id);
        } else if (reopenRes.kind === "topic_not_modified") {
          // Topic is already open in Telegram -> flip D1 row to open and proceed with existing thread.
          await markOpen(db, { sessionId: opts.sessionId, chatId: opts.chatId, now: opts.now });
          await upgradeProvisionalName(existing, existing.message_thread_id);
          return { ok: true, messageThreadId: existing.message_thread_id };
        } else {
          // Genuine reopen failure (e.g. Telegram 5xx, transient network error, bot lost can_manage_topics).
          // Do not call markOpen so the D1 row remains 'closed' and the reopen is retried on subsequent notifications.
          // Delivery is unaffected because posting into a closed topic works in Telegram.
          //
          // Note on reaper/state:
          // The reaper is double-gated (listReapable requires state='closed' AND closed_at < closedBefore AND the session
          // row to be missing or stale), so a closed row does not arm the reaper while the session is actively receiving notifications.
          // Nothing breaks from posting into a row marked closed. Note that because listOrphaned only selects
          // state='open' rows, a topic stuck closed in D1 but open in Telegram is invisible to the orphan-closer,
          // so no closeForumTopic call ever fires for it. Graceful session termination still closes it explicitly;
          // on non-graceful death, the topic simply stays uncollapsed in Telegram until eventual reaping.
          //
          // Accepted residual:
          // If a reopen failure is permanent (e.g. the bot loses can_manage_topics), leaving the row closed means
          // every subsequent notification retries a reopen that always fails (~1 wasted API call per notification
          // against the ~20/min per-group budget). This is an accepted trade-off so delivery is unaffected without
          // needing a new attempt-count column. Additionally, because closed_at continues aging from the original
          // close rather than being reset to NULL by markOpen, a permanent reopen failure followed by session idleness
          // (>7d TTL) allows the reaper to delete the topic up to ~30 days earlier than if it had been re-closed on orphan cleanup.
          //
          // No provisional-name upgrade on this branch either: the reopen just failed, so
          // spending another Telegram call on a cosmetic rename is unlikely to fare better.
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
  const tg = transportForChat(opts.chatId, opts.botToken, opts.tgClient, slackCtx);

  // Helper for creator flow (executed by initial reserve winner or steal winner)
  async function runCreatorFlow(): Promise<ResolveTopicResult> {
    const iconColor = opts.machineId
      ? MACHINE_ICON_COLORS[opts.machineId] ?? DEFAULT_ICON_COLOR
      : DEFAULT_ICON_COLOR;

    const createRes = await tg.createForumTopic({
      chatId: opts.chatId,
      name,
      iconColor,
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
      const transient = !isPermanentTopicFailure(createRes);
      const createError = getTelegramErrorDetails(createRes);
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

    const threadId = createRes.result.message_thread_id;

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
      return { ok: true, messageThreadId: threadId, created: true };
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
  if (existing && existing.chat_id !== opts.chatId && (await maybeSupersede(existing))) {
    // The row that beat our reserve was the other transport's, and it is gone now: reserve again.
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
    if (existing && existing.chat_id !== opts.chatId && (await maybeSupersede(existing))) {
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
