import { verifyApiKey, unauthorized } from "./auth";
import { createTelegramClient, getTelegramErrorDetails, TelegramClient, TgResult } from "./telegram";
import { resolveTopic } from "./topic-manager";
import { deleteTopicBySession, topicsEnabled } from "./topics";
import { withD1, StorageError } from "./d1";

interface SendNotificationBody {
  sessionId: string;
  chatId: string | number;
  text: string;
  replyMarkup?: unknown;
  media?: Array<{ key: string; mime: string; filename: string }>;
  notificationId?: string;
  entities?: unknown[];
  title?: string;
  dir?: string;
  threaded?: boolean;
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
 * Is a failed topic send PERMANENT — i.e. is the topic itself unusable, such that retrying into
 * it can only fail again?
 *
 * Only a permanent failure justifies relocating a notification to General. A transient one
 * (5xx, or an outcome we cannot classify) must surface as a 502 so the daemon's outbox retries
 * into the RIGHT topic. Relocating on a transient error is how a user's answer ended up in
 * General and was never seen (pigeon-bit4).
 *
 * `errorCode === undefined` means a 200 whose body did not parse (telegram.ts parseTgResponse),
 * which most likely means Telegram PROCESSED the send. Treating it as transient risks a
 * duplicate in the correct topic; treating it as permanent guarantees a misfiled copy. The
 * duplicate is the better-placed risk.
 */
function isPermanentTopicFailure(result: TgResult<unknown>): boolean {
  if (result.ok) return false;
  switch (result.kind) {
    case "rate_limited":
      // Never reached (callers exclude it first), but 429 is explicitly transient.
      return false;
    case "error":
      return (
        typeof result.errorCode === "number" &&
        result.errorCode >= 400 &&
        result.errorCode < 500
      );
    default:
      // thread_not_found reaching the fallback means the recreate-and-retry above already
      // failed; topic_not_modified cannot come from sendMessage. Both are 4xx-class.
      return true;
  }
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
 * Check if a chatId is in the ALLOWED_CHAT_IDS env var.
 * If no allowlist is configured, deny all.
 */
export function isAllowedChatId(chatId: string | number, env: Env): boolean {
  const raw = env.ALLOWED_CHAT_IDS;
  if (!raw) return false;
  const allowed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return false;
  return allowed.includes(String(chatId));
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
 * Media send outcome. The failure arm carries the Telegram error: collapsing it to a bare
 * `{ ok: false }` is what made a dropped attachment unexplainable (pigeon-bit4).
 */
type MediaSendResult =
  | { ok: true; result: { message_id: number } }
  | { ok: false; details: unknown };

async function sendTelegramPhoto(
  tg: TelegramClient,
  chatId: string | number,
  photoBlob: Blob,
  filename: string,
  replyToMessageId?: number,
  messageThreadId?: number,
): Promise<MediaSendResult> {
  const res = await tg.sendPhoto({
    chatId,
    photo: photoBlob,
    filename,
    replyToMessageId,
    messageThreadId,
  });
  if (res.ok) {
    return { ok: true, result: res.result };
  }
  return { ok: false, details: getTelegramErrorDetails(res) };
}

async function sendTelegramDocument(
  tg: TelegramClient,
  chatId: string | number,
  documentBlob: Blob,
  filename: string,
  replyToMessageId?: number,
  messageThreadId?: number,
): Promise<MediaSendResult> {
  const res = await tg.sendDocument({
    chatId,
    document: documentBlob,
    filename,
    replyToMessageId,
    messageThreadId,
  });
  if (res.ok) {
    return { ok: true, result: res.result };
  }
  return { ok: false, details: getTelegramErrorDetails(res) };
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
    if (!verifyApiKey(request, env.CCR_API_KEY)) {
      return unauthorized();
    }

    const body = (await request.json()) as SendNotificationBody;
    const { sessionId, chatId, text, replyMarkup, media, entities, title, dir, threaded } = body;
    const notificationId = typeof body.notificationId === "string" ? body.notificationId : null;

    // Validate required fields
    if (!sessionId || !chatId || !text) {
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

    // Check chat ID allowlist
    if (!isAllowedChatId(chatId, env)) {
      return json({ error: "Chat ID not allowed" }, 403);
    }

    // Idempotency: if notificationId was provided and we already sent this notification,
    // return the existing message data without calling Telegram again.
    if (notificationId) {
      const existing = await withD1(
        "send.idempotencyLookup",
        db
          .prepare("SELECT * FROM messages WHERE notification_id = ?")
          .bind(notificationId)
          .first<MessageRow>(),
      );
      if (existing) {
        return json({ ok: true, messageId: existing.message_id, deduplicated: true });
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
    // Telegram auto-pins the first message posted into a freshly created forum topic. Track
    // whether THIS request created the topic so the pin can be cleared after the send that
    // caused it (pigeon-ud6s).
    let topicJustCreated = false;
    // What resolveTopic asked for, kept separate from messageThreadId because that variable is
    // mutated by the recreate and relocation paths. The pair is recorded on the message row
    // (pigeon-bit4) so a relocation is queryable after the fact instead of invisible.
    let intendedThreadId: number | undefined;

    if (topicsEnabled(env) && threaded !== false) {
      // Note: resolveTopic and deleteTopicBySession perform D1 queries on topics that are
      // intentionally NOT wrapped in withD1. A D1 error here falls to boundary catch as internal_error 500,
      // which triggers daemon retry identical to 503. Total D1 outage hits send.sessionLookup first (503).
      // Wrapping resolveTopic wholesale would misclassify Telegram API errors as storage.
      const topicRes = await resolveTopic(db, {
        sessionId,
        machineId: session.machine_id,
        chatId: String(chatId),
        dir: dir ?? "",
        title: title ?? "",
        botToken: env.TELEGRAM_BOT_TOKEN,
      });

      if (!topicRes.ok && topicRes.kind === "rate_limited") {
        return json({ error: "rate_limited", retryAfter: topicRes.retryAfter }, 429);
      }

      if (topicRes.ok && topicRes.messageThreadId !== null) {
        messageThreadId = topicRes.messageThreadId;
        intendedThreadId = topicRes.messageThreadId;
        topicJustCreated = topicRes.created === true;
      }
    }

    const tg = createTelegramClient(env.TELEGRAM_BOT_TOKEN);

    // Call Telegram API
    let telegramResult = await tg.sendMessage({
      chatId,
      messageThreadId,
      text,
      entities: entities as unknown[] | undefined,
      replyMarkup,
    });

    // T2.7: Stale-thread recovery (recreate topic at most once if deleted out-of-band in Telegram)
    if (
      !telegramResult.ok &&
      telegramResult.kind === "thread_not_found" &&
      messageThreadId !== undefined &&
      topicsEnabled(env) &&
      threaded !== false
    ) {
      // Delete stale finalized topic row from D1
      await deleteTopicBySession(db, sessionId, messageThreadId);

      // Recreate topic (resolve topic again)
      const retryTopicRes = await resolveTopic(db, {
        sessionId,
        machineId: session.machine_id,
        chatId: String(chatId),
        dir: dir ?? "",
        title: title ?? "",
        botToken: env.TELEGRAM_BOT_TOKEN,
      });

      if (!retryTopicRes.ok && retryTopicRes.kind === "rate_limited") {
        return json({ error: "rate_limited", retryAfter: retryTopicRes.retryAfter }, 429);
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
      }
      messageThreadId = recreatedThreadId;
      topicJustCreated =
        retryTopicRes.ok &&
        retryTopicRes.messageThreadId !== null &&
        retryTopicRes.created === true;

      // Retry sendMessage exactly once
      telegramResult = await tg.sendMessage({
        chatId,
        messageThreadId,
        text,
        entities: entities as unknown[] | undefined,
        replyMarkup,
      });
    }

    // PERMANENT topic failure -> fall back to General.
    // If the topic itself is unusable (rights revoked, forum mode off, chat is not a forum),
    // retrying can only fail again, so General is better than dropping the notification.
    //
    // A TRANSIENT failure (5xx, or an unclassifiable outcome) deliberately does NOT fall back:
    // it returns 502 below and the daemon's outbox retries into the correct topic. Relocating
    // on a transient error silently moved a user's answer to General, where it was never seen
    // (pigeon-bit4). 429 is handled separately and must not reach here either.
    if (
      !telegramResult.ok &&
      telegramResult.kind !== "rate_limited" &&
      messageThreadId !== undefined &&
      isPermanentTopicFailure(telegramResult)
    ) {
      // Clear the thread for everything downstream: if the topic would not take the text
      // it will not take the attachments either, so the media loop must follow to General.
      console.warn("[worker] relocating notification to General", {
        sessionId,
        messageThreadId,
        reason: "send_failed",
        details: getTelegramErrorDetails(telegramResult),
      });
      messageThreadId = undefined;
      telegramResult = await tg.sendMessage({
        chatId,
        messageThreadId,
        text,
        entities: entities as unknown[] | undefined,
        replyMarkup,
      });
    }

    // `retryAfter` is in SECONDS — Telegram's own unit for `parameters.retry_after`.
    // The daemon converts to ms when it pauses the outbox; don't change the unit here
    // without changing that multiplication too.
    if (!telegramResult.ok && telegramResult.kind === "rate_limited") {
      return json({ error: "rate_limited", retryAfter: telegramResult.retryAfter }, 429);
    }

    if (!telegramResult.ok) {
      return json(
        { error: "Telegram API error", details: getTelegramErrorDetails(telegramResult) },
        502,
      );
    }

    const messageId = telegramResult.result.message_id;

    // Telegram auto-pins the first message posted into a newly created forum topic, so every
    // new session topic would otherwise open with a pinned notification. Clear it here, on the
    // one request that created the topic, so no user-made pin can ever be caught by this
    // (the topic is seconds old and this is its first message). Best-effort: an unpin failure
    // — missing can_pin_messages, a Telegram 5xx — must not fail an already-delivered
    // notification, and must not be retried by the daemon (pigeon-ud6s).
    if (topicJustCreated && messageThreadId !== undefined) {
      try {
        const unpinRes = await tg.unpinAllForumTopicMessages({
          chatId,
          messageThreadId,
        });
        if (!unpinRes.ok) {
          console.warn("[worker] unpinAllForumTopicMessages failed", {
            sessionId,
            messageThreadId,
            details: getTelegramErrorDetails(unpinRes),
          });
        }
      } catch (err) {
        console.warn("[worker] unpinAllForumTopicMessages threw", {
          sessionId,
          messageThreadId,
          error: String(err),
        });
      }
    }

    // Store message→session mapping for reply routing
    await withD1(
      "send.insertMessage",
      db
        .prepare(
          "INSERT INTO messages (chat_id, message_id, session_id, token, notification_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(String(chatId), messageId, sessionId, token, notificationId, Date.now())
        .run(),
    );

    // Best-effort, and deliberately NOT part of the INSERT above. The INSERT runs after
    // Telegram has already accepted the message, so a missing column there would throw ->
    // withD1 -> 503 -> the daemon retries a message that WAS delivered, every 5-120s for 24h.
    // As a separate UPDATE the worst case is a null column and one warn.
    await recordThreadPlacement(db, {
      chatId,
      messageId,
      sessionId,
      intendedThreadId,
      actualThreadId: messageThreadId,
    });

    // Send media as replies to the text message
    if (media && media.length > 0) {
      for (const item of media) {
        try {
          const object = await env.MEDIA.get(item.key);
          if (!object?.body) continue;

          const blob = new Blob([await object.arrayBuffer()], { type: item.mime });
          const isImage = item.mime.startsWith("image/");

          const mediaResult = isImage
            ? await sendTelegramPhoto(tg, chatId, blob, item.filename, messageId, messageThreadId)
            : await sendTelegramDocument(tg, chatId, blob, item.filename, messageId, messageThreadId);

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

    return json({ ok: true, messageId, token });
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
 * Edits an existing Telegram message identified by notificationId.
 * Looks up (chat_id, message_id) from the messages table.
 */
export async function handleEditNotification(
  db: D1Database,
  env: Env,
  request: Request,
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) {
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

  const tg = createTelegramClient(env.TELEGRAM_BOT_TOKEN);

  const telegramResult = await tg.editMessageText({
    chatId: row.chat_id,
    messageId: row.message_id,
    text,
    entities,
    replyMarkup,
  });

  if (!telegramResult.ok) {
    return json(
      { error: "Telegram API error", details: getTelegramErrorDetails(telegramResult) },
      502,
    );
  }

  return json({ ok: true });
}
