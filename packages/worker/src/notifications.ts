import { unauthorized } from "./auth";
import { authenticate } from "./credentials";
import { failureDetails, isPermanentTopicFailure } from "./chat/failures";
import type { ChatResult } from "./chat/transport";
import { isSlackChatId, transportForChat, type ChatTransport } from "./chat";
import { machineSlackWorkspace, resolveWorkerTarget } from "./chat/address";
import { slackWorkspaceForTeam, teamIdOfChat } from "./chat/slack-config";
import { SLACK_MARKDOWN_MAX } from "./chat/slack-render";
import { explicitCategory } from "./chat/slack-notify";
import { errorClassOf } from "./slack";
import { resolveTopic } from "./topic-manager";
import { deleteTopicBySession } from "./topics";
import { getBindingForSession } from "./named-topics";
import { withD1, StorageError } from "./d1";
import { hasButtons, resolveMentionKeyboard } from "./mention-links";

interface SendNotificationBody {
  sessionId: string;
  /** Ignored: a machine's target is its own Slack workspace. Old daemons still send it. */
  chatId?: string | number;
  text: string;
  replyMarkup?: unknown;
  media?: Array<{ key: string; mime: string; filename: string }>;
  notificationId?: string;
  entities?: unknown[];
  title?: string;
  dir?: string;
  threaded?: boolean;
  onTopicUnavailable?: "retry" | "general";
  /**
   * Send the whole notification as one rich message; `text` is the fallback (pigeon-p909). Only
   * `dialect: "slack"` is sent rich (a Slack markdown block, pigeon-4ogz.3): a dialect-less (old
   * Telegram) body goes plain.
   */
  rich?: { markdown?: unknown; dialect?: unknown };
  /** Mention the workspace owner so this post notifies them (gated by `SLACK_NOTIFY_OWNER`). */
  notifyOwner?: boolean;
}

/**
 * Suffix on `messages.notification_id` for a notification sent as one rich message. Safe
 * because nothing looks a stop row up by its exact id: only questions are edited
 * (`/notifications/edit`) or parsed (`q:` ids), and questions are never sent rich.
 */
const RICH_ID_SUFFIX = "#rich";

/**
 * Did the provider refuse the rich message itself, such that the plain text may still go through?
 * Any 4xx except a rate limit (its own kind) and "thread not found" (a topic problem, which the
 * caller's topic recovery handles whichever mode it is in). A 5xx or an unparseable body says
 * nothing about the markdown, so it is NOT a rejection: it surfaces as a 502 and the outbox
 * retries the rich send.
 */
function isRichRejection(result: ChatResult<unknown>): boolean {
  return (
    !result.ok &&
    result.kind === "error" &&
    typeof result.errorCode === "number" &&
    result.errorCode >= 400 &&
    result.errorCode < 500
  );
}

interface SessionRow {
  session_id: string;
  machine_id: string;
  label: string | null;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  chat_id: string;
  message_id: number;
  session_id: string;
  token: string;
  notification_id: string | null;
  created_at: number;
}

/**
 * Record where a notification was meant to go and where it actually went.
 *
 * Separate from the INSERT and never allowed to throw: see the call site. A failure here
 * costs one row of forensics, while a failure in the INSERT costs a duplicate storm.
 */
async function recordThreadPlacement(
  db: D1Database,
  opts: {
    chatId: string | number;
    messageId: number;
    sessionId: string;
    intendedThreadId: number | undefined;
    actualThreadId: number | undefined;
  },
): Promise<void> {
  // Nothing to record: no topic was ever intended (topics disabled, threaded:false) and none
  // was used. The row already holds NULL/NULL, so skip the write entirely.
  if (opts.intendedThreadId === undefined && opts.actualThreadId === undefined) return;
  try {
    await db
      .prepare(
        "UPDATE messages SET intended_thread_id = ?, actual_thread_id = ? WHERE chat_id = ? AND message_id = ?",
      )
      .bind(
        opts.intendedThreadId ?? null,
        opts.actualThreadId ?? null,
        String(opts.chatId),
        opts.messageId,
      )
      .run();
  } catch (err) {
    console.warn("[worker] thread placement not recorded", {
      sessionId: opts.sessionId,
      messageId: opts.messageId,
      error: String(err),
    });
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Tells the operator, at the moment it happens, that a notification went to the workspace's
 * #alerts instead of its session channel.
 *
 * pigeon-bit4 made this *queryable* (messages.intended_thread_id / actual_thread_id) and
 * *logged* (a console.warn at each of five fallback sites). Neither is a consumer: nobody
 * runs the query, the rows are deleted as soon as the session is unregistered — which for
 * an automated session means on `/kill`, not after any TTL — and Workers Logs is a sink
 * nobody tails. This is the push.
 *
 * It is emitted at event time rather than from the hourly cron on purpose. An aggregate
 * would have to be built on the column pair, and the column pair is blind to exactly the
 * failure that matters most: the three `topic-manager.ts` paths (`create_failed`,
 * `finalize_lost_no_winner`, `poll_exhausted`) never resolve a thread id, so they record
 * NULL/NULL and are indistinguishable from a deliberately unthreaded send. Working from the
 * reason instead of the columns covers all five paths and needs no window, no watermark, and
 * no new state. Note: with `onTopicUnavailable: "retry"`, transient topic-resolution failures
 * are held for retry (returning 502) without relocating or alerting; this alert only fires when
 * a notification actually relocates (pigeon-iqpd).
 *
 * The alert goes into the same workspace's #alerts, through the transport the notification
 * itself used.
 *
 * Best-effort by construction. The notification has already been delivered by the time this
 * runs, so nothing here may change its outcome; every failure is caught and logged.
 */
export async function alertRelocation(
  chat: ChatTransport,
  opts: {
    sessionId: string;
    chatId: string | number;
    messageId: number;
    reason: string;
    label?: string | null;
  },
): Promise<boolean> {
  const alertText =
    `⚠️ Notification went to #alerts, not its channel\n` +
    `session: ${opts.sessionId}${opts.label ? ` (${opts.label})` : ""}\n` +
    `reason: ${opts.reason}\n` +
    `chat: ${opts.chatId} · message: ${opts.messageId}`;
  try {
    const res = await chat.sendMessage({ chatId: opts.chatId, text: alertText });
    if (res.ok) return true;
    console.error("[worker] relocation alert failed", { sessionId: opts.sessionId, res });
    return false;
  } catch (err) {
    console.error("[worker] relocation alert threw", { sessionId: opts.sessionId, error: String(err) });
    return false;
  }
}

/**
 * Generate a cryptographic token: 12 random bytes → base64url (~16 chars).
 */
export function generateToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let base64 = btoa(String.fromCharCode(...bytes));
  // base64url encoding
  base64 = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return base64;
}

/**
 * Look up a message by (chat_id, message_id) → session_id, token.
 */
export async function lookupMessage(
  db: D1Database,
  chatId: string,
  messageId: number,
): Promise<MessageRow | null> {
  const row = await db
    .prepare(
      "SELECT chat_id, message_id, session_id, token, notification_id, created_at FROM messages WHERE chat_id = ? AND message_id = ?",
    )
    .bind(String(chatId), messageId)
    .first<MessageRow>();
  return row ?? null;
}

/**
 * Look up a message by (token, chat_id) → session_id.
 */
export async function lookupMessageByToken(
  db: D1Database,
  token: string,
  chatId: string,
): Promise<MessageRow | null> {
  const row = await db
    .prepare(
      "SELECT chat_id, message_id, session_id, token, notification_id, created_at FROM messages WHERE token = ? AND chat_id = ?",
    )
    .bind(token, String(chatId))
    .first<MessageRow>();
  return row ?? null;
}

/**
 * Extract the daemon-generated token from inline-keyboard callback_data.
 * The daemon embeds tokens as `cmd:TOKEN:action` in button callback_data.
 * If found, the worker reuses this token so callback lookups succeed.
 */
function extractTokenFromCallbackData(replyMarkup: unknown): string | null {
  if (!replyMarkup || typeof replyMarkup !== "object") return null;
  const markup = replyMarkup as { inline_keyboard?: unknown[][] };
  if (!Array.isArray(markup.inline_keyboard)) return null;

  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) continue;
    for (const button of row) {
      if (!button || typeof button !== "object") continue;
      const btn = button as { callback_data?: string };
      if (typeof btn.callback_data !== "string") continue;
      const parts = btn.callback_data.split(":");
      if (parts[0] === "cmd" && parts.length >= 3 && parts[1]) {
        return parts[1];
      }
    }
  }
  return null;
}

/**
 * Media send outcome. The failure arm carries the provider error: collapsing it to a bare
 * `{ ok: false }` is what made a dropped attachment unexplainable (pigeon-bit4).
 */
/** Bound on posting one outbound file (pigeon-4ogz.23). */
const MEDIA_SEND_TIMEOUT_MS = 20_000;

type MediaSendResult =
  | { ok: true; result: { message_id: number } }
  | { ok: false; details: unknown };

async function sendPhotoReply(
  chat: ChatTransport,
  chatId: string | number,
  photoBlob: Blob,
  filename: string,
  replyToMessageId?: number,
  messageThreadId?: number,
  signal?: AbortSignal,
): Promise<MediaSendResult> {
  const res = await chat.sendPhoto({
    chatId,
    photo: photoBlob,
    filename,
    replyToMessageId,
    messageThreadId,
    ...(signal ? { signal } : {}),
  });
  if (res.ok) {
    return { ok: true, result: res.result };
  }
  return { ok: false, details: failureDetails(res) };
}

async function sendDocumentReply(
  chat: ChatTransport,
  chatId: string | number,
  documentBlob: Blob,
  filename: string,
  replyToMessageId?: number,
  messageThreadId?: number,
  signal?: AbortSignal,
): Promise<MediaSendResult> {
  const res = await chat.sendDocument({
    chatId,
    document: documentBlob,
    filename,
    replyToMessageId,
    messageThreadId,
    ...(signal ? { signal } : {}),
  });
  if (res.ok) {
    return { ok: true, result: res.result };
  }
  return { ok: false, details: failureDetails(res) };
}

/**
 * Handle POST /notifications/send
 */
export async function handleSendNotification(
  db: D1Database,
  env: Env,
  request: Request,
): Promise<Response> {
  try {
    const principal = await authenticate(request, env);
    if (!principal) {
      return unauthorized();
    }

    const body = (await request.json()) as SendNotificationBody;
    const { sessionId, chatId: requestedChatId, text, replyMarkup, media, entities, title, dir, threaded } = body;
    const notificationId = typeof body.notificationId === "string" ? body.notificationId : null;
    const holdForTopic = body.onTopicUnavailable === "retry";

    // Validate required fields
    // A machine has no use for a chat id (its target is its workspace), so it is not required of
    // it; the shared key (which can post nowhere) still has to send one.
    if (!sessionId || (!requestedChatId && principal.kind !== "machine") || !text) {
      return json({ error: "sessionId, chatId, and text required" }, 400);
    }

    // Verify session exists
    const session = await withD1(
      "send.sessionLookup",
      db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .bind(sessionId)
        .first<SessionRow>(),
    );
    if (!session) {
      return json({ error: "Session not found" }, 404);
    }

    // Where this notification goes. Resolved ONCE, here, and used for everything below: a
    // machine on Slack targets its workspace whatever chat id its daemon sent. A machine with no
    // workspace has nowhere to post: a configuration error, answered 503 with no `retryAfter` so
    // the daemon's outbox neither pauses nor counts it (it retries to the TTL, and worker-health
    // pages). The shared key can post nowhere either: the existing 403.
    const target = resolveWorkerTarget(env, principal);
    if (!target.ok) {
      if (principal.kind === "machine") {
        console.error("[worker] machine has no Slack workspace, notification not sent", {
          machineId: principal.machineId,
          sessionId,
        });
        return json({ error: "no_transport" }, 503);
      }
      return json({ error: "Chat ID not allowed" }, 403);
    }
    const chatId = target.chatId;
    // Failures carry their class at top level so the daemon can tell a rejected payload from an
    // outage without parsing Telegram-shaped details.
    const slackClass = (details?: unknown, fallback = "upstream") => ({
      errorClass: errorClassOf(details) ?? fallback,
    });

    // Idempotency: if notificationId was provided and we already sent this notification,
    // return the existing message data without calling the provider again.
    //
    // A rich send is recorded under `<id>#rich` (pigeon-p909), so a retry of a request whose
    // response was lost can say it was rich, and the daemon then skips the remaining plain
    // chunks instead of posting them under a message that already shows everything.
    if (notificationId) {
      const existing = await withD1(
        "send.idempotencyLookup",
        db
          .prepare("SELECT * FROM messages WHERE notification_id IN (?, ?)")
          .bind(notificationId, `${notificationId}${RICH_ID_SUFFIX}`)
          .first<MessageRow>(),
      );
      if (existing) {
        return json({
          ok: true,
          messageId: existing.message_id,
          deduplicated: true,
          ...(existing.notification_id === `${notificationId}${RICH_ID_SUFFIX}` ? { rich: "sent" } : {}),
        });
      }
    }

    // Touch session to prevent cleanup
    await withD1(
      "send.touchSession",
      db
        .prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?")
        .bind(Date.now(), sessionId)
        .run(),
    );

    // Use daemon-supplied token from callback_data if present (keeps button callbacks working),
    // otherwise generate a fresh token for reply-to-message routing.
    const token = extractTokenFromCallbackData(replyMarkup) ?? generateToken();

    let messageThreadId: number | undefined;
    // What resolveTopic asked for, kept separate from messageThreadId because that variable is
    // mutated by the recreate and relocation paths. The pair is recorded on the message row
    // (pigeon-bit4) so a relocation is queryable after the fact instead of invisible.
    let intendedThreadId: number | undefined;
    // Why this notification ended up in General, when it did. Set on all five fallback paths —
    // including the three that never produce an intendedThreadId and are therefore invisible to
    // the intended/actual column pair (pigeon-t5bd).
    let relocationReason: string | undefined;

    const bound = threaded !== false ? await getBindingForSession(db, sessionId) : null;

    if (bound && bound.chat_id !== String(chatId)) {
      // The session's named topic lives in another chat (pigeon-533h): its thread id means
      // nothing here. Post unthreaded into the requested chat rather than into a foreign thread
      // id, and do not fall through to resolveTopic -- a bound session never gets a topic of its
      // own. `bound` stays set so the T2.7 recovery below cannot run either.
      console.warn("[worker] session's named topic is in another chat, notification will go to General", {
        sessionId,
        requestedChatId: String(chatId),
        topicChatId: bound.chat_id,
        reason: "bound_topic_in_other_chat",
      });
      relocationReason = "bound_topic_in_other_chat";
    } else if (bound) {
      messageThreadId = bound.message_thread_id;
      intendedThreadId = bound.message_thread_id;
    } else if (threaded !== false) {
      // Note: resolveTopic and deleteTopicBySession perform D1 queries on topics that are
      // intentionally NOT wrapped in withD1. A D1 error here falls to boundary catch as internal_error 500,
      // which triggers daemon retry identical to 503. Total D1 outage hits send.sessionLookup first (503).
      // Wrapping resolveTopic wholesale would misclassify provider errors as storage.
      const topicRes = await resolveTopic(db, {
        sessionId,
        machineId: session.machine_id,
        chatId: String(chatId),
        dir: dir ?? "",
        title: title ?? "",
        env,
      });

      if (!topicRes.ok && topicRes.kind === "rate_limited") {
        return json({ error: "rate_limited", retryAfter: topicRes.retryAfter, ...slackClass(undefined, "rate_limited") }, 429);
      }

      // pigeon-iqpd: transient topic-resolution failures must be retried into the right topic
      // like the send path's pigeon-bit4 rule; the daemon bounds the hold by time, so the worker
      // only obeys the flag; absent flag = legacy behaviour for version skew since the worker
      // deploys centrally and daemons per-machine.
      if (topicRes.ok && topicRes.messageThreadId === null && topicRes.transient && holdForTopic) {
        const reason = topicRes.reason ?? "no_topic";
        console.warn("[worker] topic unavailable, holding notification for retry", {
          sessionId,
          reason,
          createError: topicRes.createError,
        });
        const payload: { error: string; reason: string; createError?: unknown; errorClass?: string } = {
          error: "topic_unavailable",
          reason,
        };
        if (topicRes.createError !== undefined) {
          payload.createError = topicRes.createError;
          const cls = errorClassOf(topicRes.createError);
          if (cls) payload.errorClass = cls;
        }
        return json(payload, 502);
      }

      if (topicRes.ok && topicRes.messageThreadId !== null) {
        messageThreadId = topicRes.messageThreadId;
        intendedThreadId = topicRes.messageThreadId;
      } else if (topicRes.ok) {
        relocationReason = topicRes.reason ?? "no_topic";
      }
    }

    const chat = transportForChat(chatId, { env, db });

    // Rich message (pigeon-p909): the daemon offers the whole notification as rich markdown
    // when it contains a table; `text` is then chunk 0 of the plain rendering. Rich is tried
    // first and, once the provider rejects it, latched off for the rest of this request, so
    // the topic recovery and relocation below re-send plain. `rich` in the response tells the
    // daemon whether one rich message carried the whole notification ("sent") or chunk 0 went
    // out plain ("fallback"), in which case it sends the remaining chunks.
    const richMarkdown =
      typeof body.rich?.markdown === "string" && body.rich.markdown.length > 0
        ? body.rich.markdown
        : undefined;
    // Only markdown the daemon wrote in Slack's dialect may go out as a Slack markdown block;
    // anything else (no dialect: an old daemon's Telegram markdown) goes plain, which is always
    // safe. `SLACK_MARKDOWN_BLOCKS=off` is the kill switch.
    let richEnabled =
      richMarkdown !== undefined && body.rich?.dialect === "slack" && env.SLACK_MARKDOWN_BLOCKS !== "off";
    if (richEnabled && [...richMarkdown!].length > SLACK_MARKDOWN_MAX) {
      // The daemon checks this too; a skewed or buggy daemon must not cost a round trip.
      console.warn("[worker] rich markdown over Slack's limit, sending plain", {
        sessionId,
        notificationId,
        chars: [...richMarkdown!].length,
      });
      richEnabled = false;
    }
    // Posts honour `notifyOwner`, as a category: a flagged `q:` notification is a question,
    // anything else flagged is an error. Whether that mentions anyone is `SLACK_NOTIFY_OWNER`'s
    // call, inside the transport.
    const slackOnly = {
      notifyOwner: body.notifyOwner === true,
      ...(body.notifyOwner === true ? { notifyCategory: explicitCategory(notificationId) } : {}),
    };
    let lastSendWasRich = false;
    let richError: unknown;

    // Buttons to the topics of sessions the text mentions (pigeon-ylx3), unless the caller sent
    // a keyboard of its own (a question's answer buttons). Decoration: if the provider rejects the
    // keyboard with a 400 (nothing was posted), the message is resent once without it and the
    // rest of this handler carries on as if it had never been added. Resolved lazily, and
    // separately for the rich markdown (the whole notification) and the plain text (chunk 0),
    // so each mode links exactly the sessions it shows.
    const callerHasButtons = hasButtons(replyMarkup);
    let linkMarkup: unknown;
    let linkMarkupResolved = false;
    const sendPlain = async (threadId: number | undefined): Promise<ChatResult<{ message_id: number }>> => {
      if (!linkMarkupResolved) {
        linkMarkup = callerHasButtons ? undefined : await resolveMentionKeyboard(db, text, sessionId, env);
        linkMarkupResolved = true;
      }
      const result = await chat.sendMessage({
        chatId,
        messageThreadId: threadId,
        text,
        entities: entities as unknown[] | undefined,
        replyMarkup: linkMarkup ?? replyMarkup,
        ...slackOnly,
      });
      if (linkMarkup && !result.ok && result.kind === "error" && result.errorCode === 400) {
        console.warn("[worker] mention link buttons rejected, resending without them", {
          sessionId,
          details: failureDetails(result),
        });
        linkMarkup = undefined;
        return sendPlain(threadId);
      }
      return result;
    };
    let richLinkMarkup: unknown;
    let richLinkMarkupResolved = false;
    const sendText = async (threadId: number | undefined): Promise<ChatResult<{ message_id: number }>> => {
      if (richEnabled) {
        if (!richLinkMarkupResolved) {
          richLinkMarkup = callerHasButtons
            ? undefined
            : await resolveMentionKeyboard(db, richMarkdown!, sessionId, env);
          richLinkMarkupResolved = true;
        }
        const result = await chat.sendRichMessage({
          chatId,
          messageThreadId: threadId,
          markdown: richMarkdown!,
          replyMarkup: richLinkMarkup ?? replyMarkup,
          // The notification text: the plain chunk, not the raw markdown source.
          text,
          ...slackOnly,
        });
        if (!isRichRejection(result)) {
          lastSendWasRich = true;
          return result;
        }
        if (richLinkMarkup) {
          // The mention buttons may be what the provider refused (sendPlain makes the same retry).
          // Try rich once more without them before blaming the markdown.
          console.warn("[worker] mention link buttons rejected on a rich message, resending without them", {
            sessionId,
            details: failureDetails(result),
          });
          richLinkMarkup = undefined;
          return sendText(threadId);
        }
        // Nothing was posted (a 4xx). Fall back once, and loudly: a rich rejection means the
        // daemon produced markdown the provider would not take, which is a bug to go and look at.
        richEnabled = false;
        richError = failureDetails(result);
        console.warn("[worker] rich message rejected, sending plain", {
          sessionId,
          notificationId,
          messageThreadId: threadId,
          details: richError,
        });
      }
      lastSendWasRich = false;
      return sendPlain(threadId);
    };

    // Call the chat provider
    let chatResult = await sendText(messageThreadId);

    // T2.7: Stale-thread recovery (recreate topic at most once if deleted out-of-band)
    if (
      !chatResult.ok &&
      chatResult.kind === "thread_not_found" &&
      messageThreadId !== undefined &&
      threaded !== false &&
      !bound
    ) {
      // Delete stale finalized topic row from D1. Chat-scoped: messageThreadId came from a row
      // in THIS chat (resolveTopic refuses other chats' rows), and the delete must not be able
      // to reach a row that has since moved to another chat (pigeon-533h).
      await deleteTopicBySession(db, sessionId, String(chatId), messageThreadId);

      // Recreate topic (resolve topic again)
      const retryTopicRes = await resolveTopic(db, {
        sessionId,
        machineId: session.machine_id,
        chatId: String(chatId),
        dir: dir ?? "",
        title: title ?? "",
        env,
      });

      if (!retryTopicRes.ok && retryTopicRes.kind === "rate_limited") {
        return json(
          { error: "rate_limited", retryAfter: retryTopicRes.retryAfter, ...slackClass(undefined, "rate_limited") },
          429,
        );
      }

      if (
        retryTopicRes.ok &&
        retryTopicRes.messageThreadId === null &&
        retryTopicRes.transient &&
        holdForTopic
      ) {
        const innerReason = retryTopicRes.reason;
        const reason = innerReason ? `recreate_failed:${innerReason}` : "recreate_failed";
        console.warn("[worker] topic unavailable, holding notification for retry", {
          sessionId,
          reason,
          createError: retryTopicRes.createError,
        });
        const payload: { error: string; reason: string; createError?: unknown; errorClass?: string } = {
          error: "topic_unavailable",
          reason,
        };
        if (retryTopicRes.createError !== undefined) {
          payload.createError = retryTopicRes.createError;
          const cls = errorClassOf(retryTopicRes.createError);
          if (cls) payload.errorClass = cls;
        }
        return json(payload, 502);
      }

      // Adopt the recreated thread for EVERYTHING downstream, not just this retry.
      // The media loop below reads messageThreadId; leaving it pointing at the deleted
      // thread silently dropped every attachment (sendPhoto fails, the item is skipped
      // with no retry and no log).
      const recreatedThreadId =
        retryTopicRes.ok && retryTopicRes.messageThreadId !== null
          ? retryTopicRes.messageThreadId
          : undefined;
      if (recreatedThreadId === undefined) {
        // The topic could not be recreated, so this notification is about to go to General
        // under a different code path than the relocation below (pigeon-bit4: was silent).
        console.warn("[worker] relocating notification to General", {
          sessionId,
          messageThreadId,
          reason: "recreate_failed",
        });
        // Keep the inner reason: "the topic could not be recreated" and "recreating it timed
        // out waiting for a peer" are different failures wearing the same name.
        const innerReason =
          retryTopicRes.ok && retryTopicRes.messageThreadId === null
            ? retryTopicRes.reason
            : undefined;
        relocationReason = innerReason ? `recreate_failed:${innerReason}` : "recreate_failed";
      }
      messageThreadId = recreatedThreadId;

      // Retry sendMessage exactly once
      chatResult = await sendText(messageThreadId);
    }

    // PERMANENT topic failure -> fall back to General.
    // If the topic itself is unusable (the channel is gone or the app lost its rights),
    // retrying can only fail again, so General is better than dropping the notification.
    //
    // A TRANSIENT failure (5xx, or an unclassifiable outcome) deliberately does NOT fall back:
    // it returns 502 below and the daemon's outbox retries into the correct topic. Relocating
    // on a transient error silently moved a user's answer to General, where it was never seen
    // (pigeon-bit4). 429 is handled separately and must not reach here either.
    if (
      !chatResult.ok &&
      chatResult.kind !== "rate_limited" &&
      messageThreadId !== undefined &&
      isPermanentTopicFailure(chatResult)
    ) {
      // Clear the thread for everything downstream: if the topic would not take the text
      // it will not take the attachments either, so the media loop must follow to General.
      console.warn("[worker] relocating notification to General", {
        sessionId,
        messageThreadId,
        reason: "send_failed",
        details: failureDetails(chatResult),
      });
      relocationReason = "send_failed";
      messageThreadId = undefined;
      chatResult = await sendText(messageThreadId);
    }

    // `retryAfter` is in SECONDS (the unit of Slack's Retry-After header and of the Telegram-era
    // `parameters.retry_after` the daemon contract was written against).
    // The daemon converts to ms when it pauses the outbox; don't change the unit here
    // without changing that multiplication too.
    if (!chatResult.ok && chatResult.kind === "rate_limited") {
      return json(
        { error: "rate_limited", retryAfter: chatResult.retryAfter, ...slackClass(chatResult.response, "rate_limited") },
        429,
      );
    }

    if (!chatResult.ok && chatResult.kind === "no_transport") {
      // Unreachable by construction (the target is a configured workspace's own address); a
      // config error like the missing workspace above, answered the same way.
      return json({ error: "no_transport" }, 503);
    }

    if (!chatResult.ok) {
      const details = failureDetails(chatResult);
      return json({ error: "provider_error", details, ...slackClass(details) }, 502);
    }

    const messageId = chatResult.result.message_id;

    // Store message→session mapping for reply routing
    await withD1(
      "send.insertMessage",
      db
        .prepare(
          "INSERT INTO messages (chat_id, message_id, session_id, token, notification_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          String(chatId),
          messageId,
          sessionId,
          token,
          notificationId && lastSendWasRich ? `${notificationId}${RICH_ID_SUFFIX}` : notificationId,
          Date.now(),
        )
        .run(),
    );

    // Best-effort, and deliberately NOT part of the INSERT above. The INSERT runs after
    // the provider has already accepted the message, so a missing column there would throw ->
    // withD1 -> 503 -> the daemon retries a message that WAS delivered, every 5-120s for 24h.
    // As a separate UPDATE the worst case is a null column and one warn.
    await recordThreadPlacement(db, {
      chatId,
      messageId,
      sessionId,
      intendedThreadId,
      actualThreadId: messageThreadId,
    });

    // Fires only when the caller wanted threading, so a deliberate unthreaded send (a quiet
    // session's question, pigeon-c501) is never reported.
    if (relocationReason !== undefined && messageThreadId === undefined) {
      await alertRelocation(chat, {
        sessionId,
        chatId,
        messageId,
        reason: relocationReason,
        label: session.label,
      });
    }

    // Send media as replies to the text message
    if (media && media.length > 0) {
      for (const item of media) {
        try {
          const object = await env.MEDIA.get(item.key);
          if (!object?.body) continue;

          const blob = new Blob([await object.arrayBuffer()], { type: item.mime });
          const isImage = item.mime.startsWith("image/");

          // Bounded (pigeon-4ogz.23): this loop runs before the response, and the daemon's outbox
          // is serial, so one hung upload would hold every session's notifications behind it.
          // The Slack upload honours the signal.
          const signal = AbortSignal.timeout(MEDIA_SEND_TIMEOUT_MS);
          const mediaResult = isImage
            ? await sendPhotoReply(chat, chatId, blob, item.filename, messageId, messageThreadId, signal)
            : await sendDocumentReply(chat, chatId, blob, item.filename, messageId, messageThreadId, signal);

          if (mediaResult.ok && mediaResult.result) {
            await db
              .prepare(
                "INSERT INTO messages (chat_id, message_id, session_id, token, notification_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .bind(String(chatId), mediaResult.result.message_id, sessionId, token, null, Date.now())
              .run();
            // Media follows the text's placement, so a relocated notification's attachments
            // are queryable as relocated too.
            await recordThreadPlacement(db, {
              chatId,
              messageId: mediaResult.result.message_id,
              sessionId,
              intendedThreadId,
              actualThreadId: messageThreadId,
            });
          } else if (!mediaResult.ok) {
            // Best-effort, but no longer silent (pigeon-bit4).
            console.warn("[worker] media attachment not delivered", {
              sessionId,
              messageThreadId,
              filename: item.filename,
              details: mediaResult.details,
            });
          }
        } catch (err) {
          console.warn("[worker] media attachment not delivered", {
            sessionId,
            messageThreadId,
            filename: item.filename,
            error: String(err),
          });
          continue; // Best-effort: text already sent
        }
      }
    }

    return json({
      ok: true,
      messageId,
      token,
      ...(richMarkdown !== undefined
        ? {
            rich: lastSendWasRich ? "sent" : "fallback",
            ...(richError !== undefined ? { richError } : {}),
          }
        : {}),
    });
  } catch (err) {
    if (err instanceof StorageError) {
      console.error("[worker] storage error", { op: err.op, error: err.message });
      return json(
        { error: "storage_error", store: "d1", op: err.op },
        503,
      );
    }
    throw err;
  }
}

/**
 * Handle POST /notifications/edit
 *
 * Edits an existing message identified by notificationId.
 * Looks up (chat_id, message_id) from the messages table.
 */
export async function handleEditNotification(
  db: D1Database,
  env: Env,
  request: Request,
): Promise<Response> {
  const principal = await authenticate(request, env);
  if (!principal) {
    return unauthorized();
  }

  const body = (await request.json()) as {
    notificationId?: string;
    text?: string;
    replyMarkup?: unknown;
    entities?: unknown[];
  };

  const { notificationId, text, replyMarkup, entities } = body;
  if (!notificationId || !text) {
    return json({ error: "notificationId and text are required" }, 400);
  }

  // Look up the original message
  const row = await db
    .prepare("SELECT chat_id, message_id FROM messages WHERE notification_id = ?")
    .bind(notificationId)
    .first<{ chat_id: string; message_id: number }>();

  if (!row) {
    return json({ error: "Message not found for notificationId" }, 404);
  }

  // A numeric row is a Telegram-era post: nothing can edit it, and it reads as the not-found
  // answer rather than a provider refusal.
  if (!isSlackChatId(row.chat_id)) {
    return json({ error: "Message not found for notificationId" }, 404);
  }

  // A Slack post is editable only by a machine on that post's workspace: the shared key, a
  // machine with no workspace, or another team's machine never reaches Slack. When the post's
  // team has no configured workspace (the secret was deleted) there is nothing to authorize
  // against, so the call falls through to the transport's transient SLACK_UNAVAILABLE and the
  // daemon retries.
  const rowTeam = teamIdOfChat(row.chat_id);
  if (rowTeam !== null && slackWorkspaceForTeam(env, rowTeam)) {
    const ws = machineSlackWorkspace(env, principal);
    if (!ws || ws.teamId !== rowTeam) {
      return json({ error: "chat_not_allowed" }, 403);
    }
  }

  // Routed by the STORED post's chat (spec §1).
  const chat = transportForChat(row.chat_id, { env, db });

  const chatResult = await chat.editMessage({
    chatId: row.chat_id,
    messageId: row.message_id,
    text,
    entities,
    replyMarkup,
  });

  if (!chatResult.ok) {
    const details = failureDetails(chatResult);
    return json(
      {
        error: "provider_error",
        details,
        errorClass: errorClassOf(details) ?? "upstream",
      },
      502,
    );
  }

  return json({ ok: true });
}
