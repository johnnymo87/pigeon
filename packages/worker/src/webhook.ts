import { lookupMessage, lookupMessageByToken } from "./notifications";
import { generateCommandId, queueCommand as d1QueueCommand, isMachineRecent } from "./d1-ops";
import type { MediaRef } from "./media";

type CommandType = "execute" | "launch" | "kill" | "compact" | "mcp_list" | "mcp_enable" | "mcp_disable" | "model_list" | "model_set";

// Re-export generateCommandId for tests
export { generateCommandId };

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
async function deduplicateUpdate(db: D1Database, updateId: number): Promise<boolean> {
  // Check if update already exists
  const existing = await db
    .prepare("SELECT update_id FROM seen_updates WHERE update_id = ?")
    .bind(updateId)
    .first<{ update_id: number }>();

  if (existing) {
    return false; // duplicate
  }

  // Insert new entry (INSERT OR IGNORE handles race conditions gracefully)
  await db
    .prepare("INSERT OR IGNORE INTO seen_updates (update_id, created_at) VALUES (?, ?)")
    .bind(updateId, Date.now())
    .run();

  return true;
}

// Telegram update types (minimal, just what we need)
interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudio;
  video?: TelegramVideo;
  voice?: TelegramVoice;
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

interface ExtractedMedia {
  fileId: string;
  fileUniqueId: string;
  mime: string;
  filename: string;
  size: number;
}

export const MAX_FILE_SIZE = 20 * 1024 * 1024;

/**
 * Max image dimension (px) for inbound photos. Anthropic's API limits images to
 * 2000px per side in many-image requests (21+), and auto-resizes above 1568px
 * adding latency. We pick the largest Telegram variant within this bound.
 */
export const MAX_IMAGE_DIMENSION = 1568;

export function extractMedia(message: TelegramMessage): ExtractedMedia | null {
  if (message.photo && message.photo.length > 0) {
    // Telegram sorts photo[] ascending by size. Pick the largest variant
    // where both dimensions fit within MAX_IMAGE_DIMENSION.
    let best: TelegramPhotoSize | null = null;
    for (const variant of message.photo) {
      if (variant.width <= MAX_IMAGE_DIMENSION && variant.height <= MAX_IMAGE_DIMENSION) {
        best = variant;
      }
    }
    if (!best) {
      // Every variant exceeds the limit. This shouldn't happen in practice
      // since Telegram always generates small thumbnails. Skip the media
      // rather than relay an oversized image.
      return null;
    }
    return {
      fileId: best.file_id,
      fileUniqueId: best.file_unique_id,
      mime: "image/jpeg",
      filename: `photo_${best.file_unique_id}.jpg`,
      size: best.file_size ?? 0,
    };
  }
  if (message.document) {
    return {
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id,
      mime: message.document.mime_type ?? "application/octet-stream",
      filename: message.document.file_name ?? `file_${message.document.file_unique_id}`,
      size: message.document.file_size ?? 0,
    };
  }
  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      fileUniqueId: message.audio.file_unique_id,
      mime: message.audio.mime_type ?? "audio/mpeg",
      filename: message.audio.file_name ?? `audio_${message.audio.file_unique_id}`,
      size: message.audio.file_size ?? 0,
    };
  }
  if (message.video) {
    return {
      fileId: message.video.file_id,
      fileUniqueId: message.video.file_unique_id,
      mime: message.video.mime_type ?? "video/mp4",
      filename: message.video.file_name ?? `video_${message.video.file_unique_id}`,
      size: message.video.file_size ?? 0,
    };
  }
  if (message.voice) {
    return {
      fileId: message.voice.file_id,
      fileUniqueId: message.voice.file_unique_id,
      mime: message.voice.mime_type ?? "audio/ogg",
      filename: `voice_${message.voice.file_unique_id}.ogg`,
      size: message.voice.file_size ?? 0,
    };
  }
  return null;
}

async function relayMediaToR2(
  env: Env,
  media: ExtractedMedia,
): Promise<{ key: string } | { error: string }> {
  if (media.size > MAX_FILE_SIZE) {
    return { error: `File too large (${(media.size / 1024 / 1024).toFixed(1)}MB, max 20MB)` };
  }

  const getFileRes = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: media.fileId }),
    },
  );

  const getFileResult = (await getFileRes.json()) as {
    ok: boolean;
    result?: { file_path: string };
  };

  if (!getFileResult.ok || !getFileResult.result?.file_path) {
    return { error: "Could not download file from Telegram" };
  }

  const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${getFileResult.result.file_path}`;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok || !fileRes.body) {
    return { error: "Could not download file from Telegram" };
  }

  const timestamp = Date.now();
  const key = `inbound/${timestamp}-${media.fileUniqueId}/${media.filename}`;

  try {
    await env.MEDIA.put(key, fileRes.body, {
      httpMetadata: { contentType: media.mime },
      customMetadata: { filename: media.filename },
    });
  } catch {
    return { error: "Media storage failed, please try again" };
  }

  return { key };
}

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
 * Returns { sessionId, command, questionRequestId? } or null if no session found.
 *
 * When the looked-up message has a notification_id starting with `q:`, the
 * requestId is extracted (format: `q:{sessionId}:{requestId}`) and returned as
 * questionRequestId so that swipe-replies to question notifications can be
 * identified by the daemon.
 */
async function resolveMessageSession(
  db: D1Database,
  message: TelegramMessage,
): Promise<{ sessionId: string; command: string; questionRequestId?: string } | null> {
  const chatId = String(message.chat.id);
  const text = message.text || message.caption || "";

  // Try 1: reply-to-message lookup
  if (message.reply_to_message) {
    const mapping = await lookupMessage(db, chatId, message.reply_to_message.message_id);
    if (mapping) {
      const result: { sessionId: string; command: string; questionRequestId?: string } = {
        sessionId: mapping.session_id,
        command: text,
      };
      // Detect question notification replies: notification_id format is q:{sessionId}:{requestId}
      if (mapping.notification_id && mapping.notification_id.startsWith("q:")) {
        const parts = mapping.notification_id.split(":");
        if (parts.length >= 3) {
          result.questionRequestId = parts.slice(2).join(":");
        }
      }
      return result;
    }
  }

  // Try 2: /cmd TOKEN command format
  const cmdMatch = text.match(/^\/cmd\s+(\S+)\s+(.+)$/s);
  if (cmdMatch) {
    const token = cmdMatch[1]!;
    const mapping = await lookupMessageByToken(db, token, chatId);
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
async function resolveCallbackSession(
  db: D1Database,
  callbackQuery: TelegramCallbackQuery,
): Promise<{ sessionId: string; command: string } | null> {
  const chatId = callbackQuery.message?.chat?.id;
  if (!chatId) return null;

  const data = callbackQuery.data;
  if (typeof data !== "string") return null;

  const parts = data.split(":");
  if (parts[0] !== "cmd" || parts.length < 3) return null;

  const token = parts[1]!;
  const action = parts.slice(2).join(":");

  const mapping = await lookupMessageByToken(db, token, String(chatId));
  if (!mapping) return null;

  const command = action;

  return { sessionId: mapping.session_id, command };
}

/**
 * Look up the machine for a session and validate the command.
 * Returns machine info or sends an error to Telegram and returns null.
 */
async function resolveSessionMachine(
  db: D1Database,
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
  const session = await db
    .prepare("SELECT machine_id, label FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<{ machine_id: string; label: string | null }>();

  if (!session) {
    await sendTelegramMessage(env, chatId, "Session not found");
    return null;
  }

  // Touch session to prevent cleanup
  await db
    .prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?")
    .bind(Date.now(), sessionId)
    .run();

  return { machineId: session.machine_id, label: session.label };
}

const MAX_QUEUE_PER_MACHINE = 100;

/**
 * Queue a command for delivery to a machine.
 * Returns the command_id, or null if the queue is full.
 */
async function queueCommand(
  db: D1Database,
  env: Env,
  machineId: string,
  sessionId: string | null,
  command: string,
  chatId: string,
  label: string | null,
  commandType: CommandType = "execute",
  directory: string | null = null,
  mediaRef: MediaRef | null = null,
  metadataJson: string | null = null,
): Promise<string | null> {
  const mediaJson = mediaRef ? JSON.stringify(mediaRef) : null;

  const commandId = await d1QueueCommand(db, {
    machineId,
    sessionId,
    command,
    chatId,
    commandType,
    directory,
    mediaJson,
    metadataJson,
  });

  if (commandId === null) {
    await sendTelegramMessage(env, chatId,
      `Queue full for ${label || machineId} (${MAX_QUEUE_PER_MACHINE} commands pending).`);
    return null;
  }

  return commandId;
}

/**
 * Resolve a session from a reply-to-message.
 * Used by /kill, /compact, /mcp, /model commands.
 * Returns session info or sends an error to Telegram and returns null.
 */
async function resolveReplySession(
  db: D1Database,
  env: Env,
  message: TelegramMessage,
): Promise<{ sessionId: string; machineId: string; label: string | null } | null> {
  const chatId = message.chat.id;

  if (!message.reply_to_message) {
    await sendTelegramMessage(env, chatId, "Reply to a session notification to use this command.");
    return null;
  }

  const mapping = await lookupMessage(db, String(chatId), message.reply_to_message.message_id);
  if (!mapping) {
    await sendTelegramMessage(env, chatId, "Could not find a session for that message.");
    return null;
  }

  const session = await db
    .prepare("SELECT machine_id, label FROM sessions WHERE session_id = ?")
    .bind(mapping.session_id)
    .first<{ machine_id: string; label: string | null }>();

  if (!session) {
    await sendTelegramMessage(env, chatId, `Session \`${mapping.session_id}\` not found.`);
    return null;
  }

  const isRecent = await isMachineRecent(db, session.machine_id);
  if (!isRecent) {
    await sendTelegramMessage(env, chatId, `${session.machine_id} is not recently seen.`);
    return null;
  }

  return { sessionId: mapping.session_id, machineId: session.machine_id, label: session.label };
}

/**
 * Handle an incoming Telegram webhook request.
 */
export async function handleTelegramWebhook(
  db: D1Database,
  env: Env,
  request: Request,
): Promise<Response> {
  // Auth: verify webhook secret
  if (!verifyWebhookSecret(request, env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const update = (await request.json()) as TelegramUpdate;

  // Dedup by update_id
  if (update.update_id) {
    const isNew = await deduplicateUpdate(db, update.update_id);
    if (!isNew) {
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
      // Check if machine has recently polled (replacing WebSocket "connected" check)
      const isRecent = await isMachineRecent(db, machineId);

      if (!isRecent) {
        await sendTelegramMessage(env, launchChatId, `${machineId} is not recently seen.`);
        return OK();
      }

      const commandId = await queueCommand(db, env, machineId, null, prompt, String(launchChatId), null, "launch", directory);
      if (!commandId) return OK();

      await sendTelegramMessage(env, launchChatId, `Launching on ${machineId} in ${directory}...`);
      return OK();
    }

    // Handle /kill command (reply-based)
    if (/^\/kill$/.test(update.message.text)) {
      const killChatId = update.message.chat.id;

      const resolved = await resolveReplySession(db, env, update.message as TelegramMessage);
      if (!resolved) return OK();

      const commandId = await queueCommand(db, env, resolved.machineId, resolved.sessionId, "", String(killChatId), resolved.label, "kill");
      if (!commandId) return OK();

      await sendTelegramMessage(env, killChatId, `Killing session \`${resolved.sessionId}\` on ${resolved.machineId}...`);
      return OK();
    }

    // Handle /compact command (reply-based)
    if (/^\/compact$/.test(update.message.text)) {
      const compactChatId = update.message.chat.id;

      const resolved = await resolveReplySession(db, env, update.message as TelegramMessage);
      if (!resolved) return OK();

      const commandId = await queueCommand(db, env, resolved.machineId, resolved.sessionId, "", String(compactChatId), resolved.label, "compact");
      if (!commandId) return OK();

      await sendTelegramMessage(env, compactChatId, `Compacting session \`${resolved.sessionId}\` on ${resolved.machineId}...`);
      return OK();
    }

    // Handle /mcp list (reply-based)
    if (/^\/mcp\s+list$/.test(update.message.text)) {
      const mcpChatId = update.message.chat.id;

      const resolved = await resolveReplySession(db, env, update.message as TelegramMessage);
      if (!resolved) return OK();

      const commandId = await queueCommand(db, env, resolved.machineId, resolved.sessionId, "", String(mcpChatId), resolved.label, "mcp_list");
      if (!commandId) return OK();

      await sendTelegramMessage(env, mcpChatId, `Listing MCP servers for session \`${resolved.sessionId}\` on ${resolved.machineId}...`);
      return OK();
    }

    // Handle /mcp enable <SERVER> (reply-based)
    const mcpEnableMatch = update.message.text.match(/^\/mcp\s+enable\s+(\S+)$/);
    if (mcpEnableMatch) {
      const serverName = mcpEnableMatch[1]!;
      const mcpChatId = update.message.chat.id;

      const resolved = await resolveReplySession(db, env, update.message as TelegramMessage);
      if (!resolved) return OK();

      const commandId = await queueCommand(db, env, resolved.machineId, resolved.sessionId, serverName, String(mcpChatId), resolved.label, "mcp_enable");
      if (!commandId) return OK();

      await sendTelegramMessage(env, mcpChatId, `Enabling MCP server \`${serverName}\` for session \`${resolved.sessionId}\` on ${resolved.machineId}...`);
      return OK();
    }

    // Handle /mcp disable <SERVER> (reply-based)
    const mcpDisableMatch = update.message.text.match(/^\/mcp\s+disable\s+(\S+)$/);
    if (mcpDisableMatch) {
      const serverName = mcpDisableMatch[1]!;
      const mcpChatId = update.message.chat.id;

      const resolved = await resolveReplySession(db, env, update.message as TelegramMessage);
      if (!resolved) return OK();

      const commandId = await queueCommand(db, env, resolved.machineId, resolved.sessionId, serverName, String(mcpChatId), resolved.label, "mcp_disable");
      if (!commandId) return OK();

      await sendTelegramMessage(env, mcpChatId, `Disabling MCP server \`${serverName}\` for session \`${resolved.sessionId}\` on ${resolved.machineId}...`);
      return OK();
    }

    // Handle /model (list) or /model <PROVIDER/MODEL> (set) — reply-based
    const modelMatch = update.message.text.match(/^\/model(?:\s+(\S+))?$/);
    if (modelMatch) {
      const modelChatId = update.message.chat.id;
      const firstArg = modelMatch[1];

      const resolved = await resolveReplySession(db, env, update.message as TelegramMessage);
      if (!resolved) return OK();

      let commandType: CommandType;
      let modelCode: string | undefined;

      if (firstArg && firstArg.includes("/")) {
        // /model <PROVIDER/MODEL> → model_set
        modelCode = firstArg;
        commandType = "model_set";
      } else {
        // /model → model_list
        commandType = "model_list";
      }

      const command = modelCode ?? "";
      const commandId = await queueCommand(db, env, resolved.machineId, resolved.sessionId, command, String(modelChatId), resolved.label, commandType);
      if (!commandId) return OK();

      if (commandType === "model_set") {
        await sendTelegramMessage(env, modelChatId, `Setting model to \`${modelCode}\` for session \`${resolved.sessionId}\` on ${resolved.machineId}...`);
      } else {
        await sendTelegramMessage(env, modelChatId, `Listing models for session \`${resolved.sessionId}\` on ${resolved.machineId}...`);
      }
      return OK();
    }
  }

  // Handle message (text, media, reply)
  if (update.message) {
    // Extract media if present
    const media = extractMedia(update.message);

    // Check file size before routing
    if (media && media.size > MAX_FILE_SIZE) {
      if (chatId) {
        await sendTelegramMessage(env, chatId,
          `File too large (${(media.size / 1024 / 1024).toFixed(1)}MB, max 20MB)`);
      }
      return OK();
    }

    const resolved = await resolveMessageSession(db, update.message);
    if (!resolved) {
      if (chatId) {
        await sendTelegramMessage(env, chatId,
          "Could not find session for this message. Please reply to a recent notification or use /cmd TOKEN command format.");
      }
      return OK();
    }

    const machine = await resolveSessionMachine(db, env, resolved.sessionId, resolved.command, chatId!);
    if (!machine) return OK();

    // Relay media to R2 if present
    let mediaRef: MediaRef | null = null;
    if (media) {
      const relayResult = await relayMediaToR2(env, media);
      if ("error" in relayResult) {
        if (chatId) {
          await sendTelegramMessage(env, chatId, relayResult.error);
        }
        return OK();
      }
      mediaRef = { key: relayResult.key, mime: media.mime, filename: media.filename, size: media.size };
    }

    const metadataJson = resolved.questionRequestId
      ? JSON.stringify({ questionRequestId: resolved.questionRequestId })
      : null;
    const commandId = await queueCommand(db, env, machine.machineId, resolved.sessionId, resolved.command, String(chatId!), machine.label, "execute", null, mediaRef, metadataJson);
    if (!commandId) return OK();

    return OK();
  }

  // Handle callback query (button press)
  if (update.callback_query) {
    // Only process cmd:TOKEN:ACTION format; silently drop everything else
    const data = update.callback_query.data;
    if (typeof data !== "string" || !data.startsWith("cmd:")) {
      return OK();
    }

    const resolved = await resolveCallbackSession(db, update.callback_query);
    if (!resolved) {
      await answerCallbackQuery(env, update.callback_query.id, "Session expired");
      return OK();
    }

    const cbChatId = update.callback_query.message?.chat?.id;
    if (!cbChatId) return OK();

    const machine = await resolveSessionMachine(db, env, resolved.sessionId, resolved.command, cbChatId);
    if (!machine) return OK();

    const commandId = await queueCommand(db, env, machine.machineId, resolved.sessionId, resolved.command, String(cbChatId), machine.label);
    if (!commandId) return OK();

    await answerCallbackQuery(env, update.callback_query.id, "Command sent");
    return OK();
  }

  // Other update types: acknowledge silently
  return OK();
}

// Exports for testing
export { verifyWebhookSecret, deduplicateUpdate, resolveMessageSession, resolveCallbackSession, isAllowedChatId, isAllowedTelegramSource, MAX_COMMAND_LENGTH, MAX_QUEUE_PER_MACHINE };
