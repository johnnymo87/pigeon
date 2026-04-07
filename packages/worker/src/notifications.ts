import { verifyApiKey, unauthorized } from "./auth";

interface SendNotificationBody {
  sessionId: string;
  chatId: string | number;
  text: string;
  replyMarkup?: unknown;
  media?: Array<{ key: string; mime: string; filename: string }>;
  notificationId?: string;
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

async function sendTelegramPhoto(
  env: Env,
  chatId: string | number,
  photoBlob: Blob,
  filename: string,
  replyToMessageId?: number,
): Promise<{ ok: boolean; result?: { message_id: number } }> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", photoBlob, filename);
  if (replyToMessageId) form.append("reply_to_message_id", String(replyToMessageId));

  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`,
    { method: "POST", body: form },
  );
  return res.json() as Promise<{ ok: boolean; result?: { message_id: number } }>;
}

async function sendTelegramDocument(
  env: Env,
  chatId: string | number,
  documentBlob: Blob,
  filename: string,
  replyToMessageId?: number,
): Promise<{ ok: boolean; result?: { message_id: number } }> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", documentBlob, filename);
  if (replyToMessageId) form.append("reply_to_message_id", String(replyToMessageId));

  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`,
    { method: "POST", body: form },
  );
  return res.json() as Promise<{ ok: boolean; result?: { message_id: number } }>;
}

/**
 * Handle POST /notifications/send
 */
export async function handleSendNotification(
  db: D1Database,
  env: Env,
  request: Request,
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) {
    return unauthorized();
  }

  const body = (await request.json()) as SendNotificationBody;
  const { sessionId, chatId, text, replyMarkup, media } = body;
  const notificationId = typeof body.notificationId === "string" ? body.notificationId : null;

  // Validate required fields
  if (!sessionId || !chatId || !text) {
    return json({ error: "sessionId, chatId, and text required" }, 400);
  }

  // Verify session exists
  const session = await db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<SessionRow>();
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
    const existing = await db
      .prepare("SELECT * FROM messages WHERE notification_id = ?")
      .bind(notificationId)
      .first<MessageRow>();
    if (existing) {
      return json({ ok: true, messageId: existing.message_id, deduplicated: true });
    }
  }

  // Touch session to prevent cleanup
  await db
    .prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?")
    .bind(Date.now(), sessionId)
    .run();

  // Use daemon-supplied token from callback_data if present (keeps button callbacks working),
  // otherwise generate a fresh token for reply-to-message routing.
  const token = extractTokenFromCallbackData(replyMarkup) ?? generateToken();

  // Call Telegram API
  const telegramPayload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  };
  if (replyMarkup) {
    telegramPayload.reply_markup = replyMarkup;
  }

  const telegramResponse = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramPayload),
    },
  );

  const telegramResult = (await telegramResponse.json()) as {
    ok: boolean;
    result?: { message_id: number };
    description?: string;
  };

  if (!telegramResult.ok || !telegramResult.result) {
    return json(
      { error: "Telegram API error", details: telegramResult },
      502,
    );
  }

  const messageId = telegramResult.result.message_id;

  // Store message→session mapping for reply routing
  await db
    .prepare(
      "INSERT INTO messages (chat_id, message_id, session_id, token, notification_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(String(chatId), messageId, sessionId, token, notificationId, Date.now())
    .run();

  // Send media as replies to the text message
  if (media && media.length > 0) {
    for (const item of media) {
      try {
        const object = await env.MEDIA.get(item.key);
        if (!object?.body) continue;

        const blob = new Blob([await object.arrayBuffer()], { type: item.mime });
        const isImage = item.mime.startsWith("image/");

        const mediaResult = isImage
          ? await sendTelegramPhoto(env, chatId, blob, item.filename, messageId)
          : await sendTelegramDocument(env, chatId, blob, item.filename, messageId);

        if (mediaResult.ok && mediaResult.result) {
          await db
            .prepare(
              "INSERT INTO messages (chat_id, message_id, session_id, token, notification_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(String(chatId), mediaResult.result.message_id, sessionId, token, null, Date.now())
            .run();
        }
      } catch {
        continue; // Best-effort: text already sent
      }
    }
  }

  return json({ ok: true, messageId, token });
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
    parseMode?: string;
  };

  const { notificationId, text, replyMarkup, parseMode } = body;
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

  const telegramPayload: Record<string, unknown> = {
    chat_id: row.chat_id,
    message_id: row.message_id,
    text,
  };
  if (parseMode) {
    telegramPayload.parse_mode = parseMode;
  }
  if (replyMarkup) {
    telegramPayload.reply_markup = replyMarkup;
  }

  const telegramResponse = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramPayload),
    },
  );

  const telegramResult = (await telegramResponse.json()) as {
    ok: boolean;
    description?: string;
  };

  if (!telegramResult.ok) {
    return json({ error: "Telegram API error", details: telegramResult }, 502);
  }

  return json({ ok: true });
}
