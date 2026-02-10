import { verifyApiKey, unauthorized } from "./auth";

interface SendNotificationBody {
  sessionId: string;
  chatId: string | number;
  text: string;
  replyMarkup?: unknown;
}

interface SessionRow {
  session_id: string;
  machine_id: string;
  label: string | null;
  created_at: number;
  updated_at: number;
  [key: string]: SqlStorageValue;
}

interface MessageRow {
  chat_id: string;
  message_id: number;
  session_id: string;
  token: string;
  created_at: number;
  [key: string]: SqlStorageValue;
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
export function lookupMessage(
  sql: SqlStorage,
  chatId: string,
  messageId: number
): MessageRow | null {
  const rows = [...sql.exec<MessageRow>(
    "SELECT chat_id, message_id, session_id, token, created_at FROM messages WHERE chat_id = ? AND message_id = ?",
    String(chatId),
    messageId
  )];
  return rows[0] ?? null;
}

/**
 * Look up a message by (token, chat_id) → session_id.
 */
export function lookupMessageByToken(
  sql: SqlStorage,
  token: string,
  chatId: string
): MessageRow | null {
  const rows = [...sql.exec<MessageRow>(
    "SELECT chat_id, message_id, session_id, token, created_at FROM messages WHERE token = ? AND chat_id = ?",
    token,
    String(chatId)
  )];
  return rows[0] ?? null;
}

/**
 * Handle POST /notifications/send
 */
export async function handleSendNotification(
  sql: SqlStorage,
  env: Env,
  request: Request
): Promise<Response> {
  if (!verifyApiKey(request, env.CCR_API_KEY)) {
    return unauthorized();
  }

  const body = (await request.json()) as SendNotificationBody;
  const { sessionId, chatId, text, replyMarkup } = body;

  // Validate required fields
  if (!sessionId || !chatId || !text) {
    return json({ error: "sessionId, chatId, and text required" }, 400);
  }

  // Verify session exists
  const sessions = [
    ...sql.exec<SessionRow>(
      "SELECT * FROM sessions WHERE session_id = ?",
      sessionId
    ),
  ];
  if (sessions.length === 0) {
    return json({ error: "Session not found" }, 404);
  }

  // Check chat ID allowlist
  if (!isAllowedChatId(chatId, env)) {
    return json({ error: "Chat ID not allowed" }, 403);
  }

  // Touch session to prevent cleanup
  sql.exec(
    "UPDATE sessions SET updated_at = ? WHERE session_id = ?",
    Date.now(),
    sessionId
  );

  // Generate reply token
  const token = generateToken();

  // Call Telegram API
  const telegramPayload: Record<string, unknown> = {
    chat_id: chatId,
    text,
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
    }
  );

  const telegramResult = (await telegramResponse.json()) as {
    ok: boolean;
    result?: { message_id: number };
    description?: string;
  };

  if (!telegramResult.ok || !telegramResult.result) {
    return json(
      { error: "Telegram API error", details: telegramResult },
      502
    );
  }

  const messageId = telegramResult.result.message_id;

  // Store message→session mapping for reply routing
  sql.exec(
    "INSERT INTO messages (chat_id, message_id, session_id, token, created_at) VALUES (?, ?, ?, ?, ?)",
    String(chatId),
    messageId,
    sessionId,
    token,
    Date.now()
  );

  return json({ ok: true, messageId, token });
}
