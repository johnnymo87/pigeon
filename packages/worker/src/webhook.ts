import { lookupMessage, lookupMessageByToken } from "./notifications";
import { generateCommandId, type CommandType } from "./command-queue";

/**
 * Verify the Telegram webhook secret header (constant-time).
 */
function verifyWebhookSecret(request: Request, expected: string): boolean {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!secret || !expected) return false;
  if (secret.length !== expected.length) return false;

  const encoder = new TextEncoder();
  const a = encoder.encode(secret);
  const b = encoder.encode(expected);
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i]! ^ b[i]!;
  }
  return result === 0;
}

/**
 * Check if a chat ID is in the allowed list.
 */
function isAllowedChatId(chatId: string | number, env: Env): boolean {
  const raw = env.ALLOWED_CHAT_IDS || "";
  const allowed = raw.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  if (allowed.length === 0) return false;
  return allowed.includes(String(chatId));
}

/**
 * Check if a Telegram source (chat + user) is allowed.
 */
function isAllowedTelegramSource(
  chatId: string | number,
  userId: string | number | undefined,
  env: Env,
): boolean {
  if (!isAllowedChatId(chatId, env)) return false;
  // ALLOWED_USER_IDS is optional; if not set, all users in allowed chats are permitted
  const allowedUsersRaw = (env as unknown as Record<string, unknown>).ALLOWED_USER_IDS as string | undefined;
  if (!allowedUsersRaw) return true;
  const allowedUsers = allowedUsersRaw.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  if (allowedUsers.length === 0) return true;
  return allowedUsers.includes(String(userId));
}

/**
 * Deduplicate a Telegram update by update_id.
 * Returns true if this is a new (non-duplicate) update.
 */
function deduplicateUpdate(sql: SqlStorage, updateId: number): boolean {
  const result = sql.exec(
    "INSERT OR IGNORE INTO seen_updates (update_id, created_at) VALUES (?, ?)",
    updateId,
    Date.now(),
  );
  return result.rowsWritten > 0;
}

// Telegram update types (minimal, just what we need)
interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number };
  text?: string;
  reply_to_message?: { message_id: number };
}

interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  message?: { chat: { id: number } };
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

const MAX_COMMAND_LENGTH = 10_000;
const OK = () => new Response("ok", { status: 200 });

/**
 * Send a message via the Telegram Bot API.
 */
async function sendTelegramMessage(
  env: Env,
  chatId: number | string,
  text: string,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

/**
 * Answer a callback query.
 */
async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text: string,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

/**
 * Resolve a session from an incoming Telegram message.
 * Tries: (1) reply-to-message lookup, (2) /cmd TOKEN format.
 * Returns { sessionId, command } or null if no session found.
 */
function resolveMessageSession(
  sql: SqlStorage,
  message: TelegramMessage,
): { sessionId: string; command: string } | null {
  const chatId = String(message.chat.id);
  const text = message.text || "";

  // Try 1: reply-to-message lookup
  if (message.reply_to_message) {
    const mapping = lookupMessage(sql, chatId, message.reply_to_message.message_id);
    if (mapping) {
      return { sessionId: mapping.session_id, command: text };
    }
  }

  // Try 2: /cmd TOKEN command format
  const cmdMatch = text.match(/^\/cmd\s+(\S+)\s+(.+)$/s);
  if (cmdMatch) {
    const token = cmdMatch[1]!;
    const mapping = lookupMessageByToken(sql, token, chatId);
    if (mapping) {
      const command = text.replace(/^\/cmd\s+\S+\s+/, "");
      return { sessionId: mapping.session_id, command };
    }
  }

  return null;
}

/**
 * Resolve a session from a callback query.
 * Expects data format: cmd:TOKEN:ACTION
 * Returns { sessionId, command } or null.
 */
function resolveCallbackSession(
  sql: SqlStorage,
  callbackQuery: TelegramCallbackQuery,
): { sessionId: string; command: string } | null {
  const chatId = callbackQuery.message?.chat?.id;
  if (!chatId) return null;

  const data = callbackQuery.data;
  if (typeof data !== "string") return null;

  const parts = data.split(":");
  if (parts[0] !== "cmd" || parts.length < 3) return null;

  const token = parts[1]!;
  const action = parts.slice(2).join(":");

  const mapping = lookupMessageByToken(sql, token, String(chatId));
  if (!mapping) return null;

  const command = action;

  return { sessionId: mapping.session_id, command };
}

/**
 * Look up the machine for a session and validate the command.
 * Returns machine info or sends an error to Telegram and returns null.
 */
async function resolveSessionMachine(
  sql: SqlStorage,
  env: Env,
  sessionId: string,
  command: string,
  chatId: number | string,
): Promise<{ machineId: string; label: string | null } | null> {
  // Validate command length
  if (command.length > MAX_COMMAND_LENGTH) {
    await sendTelegramMessage(env, chatId,
      `Command too long (${command.length} chars, max ${MAX_COMMAND_LENGTH})`);
    return null;
  }

  // Look up session
  const rows = sql.exec(
    "SELECT machine_id, label FROM sessions WHERE session_id = ?",
    sessionId,
  ).toArray() as Array<{ machine_id: string; label: string | null; [key: string]: SqlStorageValue }>;

  const session = rows[0];
  if (!session) {
    await sendTelegramMessage(env, chatId, "Session not found");
    return null;
  }

  // Touch session to prevent cleanup
  sql.exec("UPDATE sessions SET updated_at = ? WHERE session_id = ?", Date.now(), sessionId);

  return { machineId: session.machine_id, label: session.label };
}

const MAX_QUEUE_PER_MACHINE = 100;

/**
 * Queue a command for delivery to a machine.
 * Returns the command_id, or null if the queue is full.
 */
async function queueCommand(
  sql: SqlStorage,
  env: Env,
  machineId: string,
  sessionId: string | null,
  command: string,
  chatId: string,
  label: string | null,
  commandType: CommandType = "execute",
  directory: string | null = null,
): Promise<string | null> {
  // Check queue size
  const countRows = sql.exec(
    "SELECT COUNT(*) as count FROM command_queue WHERE machine_id = ? AND status != 'acked'",
    machineId,
  ).toArray() as Array<{ count: number; [key: string]: SqlStorageValue }>;
  const queueSize = countRows[0]?.count ?? 0;

  if (queueSize >= MAX_QUEUE_PER_MACHINE) {
    await sendTelegramMessage(env, chatId,
      `Queue full for ${label || machineId} (${queueSize} commands pending).`);
    return null;
  }

  const commandId = generateCommandId();
  const now = Date.now();

  sql.exec(
    `INSERT INTO command_queue (command_id, machine_id, session_id, command, chat_id, status, created_at, next_retry_at, command_type, directory)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    commandId, machineId, sessionId, command, chatId, now, now, commandType, directory,
  );

  return commandId;
}

/**
 * Handle an incoming Telegram webhook request.
 */
export async function handleTelegramWebhook(
  sql: SqlStorage,
  env: Env,
  request: Request,
  deliverNow?: (machineId: string) => void,
  isMachineConnected?: (machineId: string) => boolean,
): Promise<Response> {
  // Auth: verify webhook secret
  if (!verifyWebhookSecret(request, env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const update = (await request.json()) as TelegramUpdate;

  // Dedup by update_id
  if (update.update_id) {
    if (!deduplicateUpdate(sql, update.update_id)) {
      return OK();
    }
  }

  // Extract chat/user IDs for allowlist check
  const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  const userId = update.message?.from?.id ?? update.callback_query?.from?.id;

  if (chatId && !isAllowedTelegramSource(chatId, userId, env)) {
    return OK(); // silent drop
  }

  // Handle /launch command
  if (update.message?.text) {
    const launchMatch = update.message.text.match(/^\/launch\s+(\S+)\s+(\S+)\s+(.+)$/s);
    if (launchMatch) {
      const machineId = launchMatch[1]!;
      const directory = launchMatch[2]!;
      const prompt = launchMatch[3]!;
      const launchChatId = update.message.chat.id;

      // NOTE: No per-user machine authorization — assumes single-tenant deployment.
      // If multi-tenant is needed, validate machineId against an allowlist.
      // Check if machine has an active WebSocket connection
      const isConnected = isMachineConnected ? isMachineConnected(machineId) : false;

      if (!isConnected) {
        await sendTelegramMessage(env, launchChatId, `${machineId} is not connected.`);
        return OK();
      }

      const commandId = await queueCommand(sql, env, machineId, null, prompt, String(launchChatId), null, "launch", directory);
      if (!commandId) return OK();

      await sendTelegramMessage(env, launchChatId, `Launching on ${machineId} in ${directory}...`);
      deliverNow?.(machineId);
      return OK();
    }

    // Handle /kill command
    const killMatch = update.message.text.match(/^\/kill\s+(\S+)$/);
    if (killMatch) {
      const sessionId = killMatch[1]!;
      const killChatId = update.message.chat.id;

      // Look up session to find its machine
      const sessionRows = sql.exec(
        "SELECT machine_id, label FROM sessions WHERE session_id = ?",
        sessionId,
      ).toArray() as Array<{ machine_id: string; label: string | null; [key: string]: SqlStorageValue }>;

      const session = sessionRows[0];
      if (!session) {
        await sendTelegramMessage(env, killChatId, `Session \`${sessionId}\` not found.`);
        return OK();
      }

      const isConnected = isMachineConnected ? isMachineConnected(session.machine_id) : false;
      if (!isConnected) {
        await sendTelegramMessage(env, killChatId, `${session.machine_id} is not connected.`);
        return OK();
      }

      const commandId = await queueCommand(sql, env, session.machine_id, sessionId, "", String(killChatId), session.label, "kill");
      if (!commandId) return OK();

      await sendTelegramMessage(env, killChatId, `Killing session \`${sessionId}\` on ${session.machine_id}...`);
      deliverNow?.(session.machine_id);
      return OK();
    }
  }

  // Handle message (text, reply)
  if (update.message) {
    const resolved = resolveMessageSession(sql, update.message);
    if (!resolved) {
      if (chatId) {
        await sendTelegramMessage(env, chatId,
          "Could not find session for this message. Please reply to a recent notification or use /cmd TOKEN command format.");
      }
      return OK();
    }

    const machine = await resolveSessionMachine(sql, env, resolved.sessionId, resolved.command, chatId!);
    if (!machine) return OK();

    const commandId = await queueCommand(sql, env, machine.machineId, resolved.sessionId, resolved.command, String(chatId!), machine.label);
    if (!commandId) return OK();

    deliverNow?.(machine.machineId);
    return OK();
  }

  // Handle callback query (button press)
  if (update.callback_query) {
    // Only process cmd:TOKEN:ACTION format; silently drop everything else
    const data = update.callback_query.data;
    if (typeof data !== "string" || !data.startsWith("cmd:")) {
      return OK();
    }

    const resolved = resolveCallbackSession(sql, update.callback_query);
    if (!resolved) {
      await answerCallbackQuery(env, update.callback_query.id, "Session expired");
      return OK();
    }

    const cbChatId = update.callback_query.message?.chat?.id;
    if (!cbChatId) return OK();

    const machine = await resolveSessionMachine(sql, env, resolved.sessionId, resolved.command, cbChatId);
    if (!machine) return OK();

    const commandId = await queueCommand(sql, env, machine.machineId, resolved.sessionId, resolved.command, String(cbChatId), machine.label);
    if (!commandId) return OK();

    await answerCallbackQuery(env, update.callback_query.id, "Command sent");
    deliverNow?.(machine.machineId);
    return OK();
  }

  // Other update types: acknowledge silently
  return OK();
}

// Exports for testing
export { verifyWebhookSecret, deduplicateUpdate, resolveMessageSession, resolveCallbackSession, isAllowedChatId, isAllowedTelegramSource, generateCommandId, MAX_COMMAND_LENGTH, MAX_QUEUE_PER_MACHINE };
