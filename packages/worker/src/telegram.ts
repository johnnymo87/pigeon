import type {
  ChatResult,
  CloseForumTopicOptions,
  CreateForumTopicOptions,
  DeleteForumTopicOptions,
  EditForumTopicOptions,
  EditMessageTextOptions,
  ForumTopic,
  ReopenForumTopicOptions,
  SendDocumentOptions,
  SendMessageOptions,
  SendPhotoOptions,
  SendRichMessageOptions,
  UnpinAllForumTopicMessagesOptions,
} from "./chat/transport";

export interface AnswerCallbackQueryOptions {
  callbackQueryId: string;
  text?: string;
}

export interface GetFileOptions {
  fileId: string;
}

const DEFAULT_RETRY_AFTER_SECONDS = 1;

/**
 * A Telegram call at or above this many milliseconds is logged at `warn` rather than `log`.
 *
 * Not a timeout and not a behaviour change — nothing is aborted at this boundary. It exists
 * only so the slow tail is filterable by log level, which is a coarser but more dependable
 * filter than a numeric predicate over a structured field. 5s is far above any healthy call
 * and well below the 43.6s stall in the pigeon-bit4 incident.
 */
export const TELEGRAM_SLOW_CALL_MS = 5_000;

/**
 * Records how long one Telegram API call took.
 *
 * Deliberately logs EVERY call, not only slow ones. A threshold-only log records no healthy
 * baseline, and the two beads that depend on this one (pigeon-g6o9, pigeon-jw53) both need a
 * distribution to size a timeout against — a stream of outliers with nothing to compare them
 * to is what we already have.
 *
 * Volume is small. `messages` rows over the last 7 days: 2,054, a mean of 293/day, peaking at
 * 617 on 2026-09-10. (Do not size this from the all-time table: rows are deleted when their
 * session is unregistered, so older days are survivors only and the long-run mean reads far
 * too low.) Add topic, wizard-edit, callback and getFile traffic and the realistic peak is
 * roughly a thousand log lines a day at `head_sampling_rate = 1`.
 *
 * The method name is logged; the URL is not, because it carries the bot token.
 */
export function logTelegramCall(method: string, elapsedMs: number, outcome: string): void {
  const payload = { method, elapsedMs, outcome };
  if (elapsedMs >= TELEGRAM_SLOW_CALL_MS) {
    console.warn("[worker] slow telegram call", payload);
  } else {
    console.log("[worker] telegram call", payload);
  }
}

/**
 * The single place a Telegram HTTP call is made, so the timing above cannot be bypassed.
 *
 * Every exported method routes through here. That is the point: a per-method wrapper would
 * have to be remembered at each of the twelve call sites, and the thirteenth would silently
 * go unmeasured. The one Telegram fetch that is not a Bot API method, the file download, has
 * its own function below (`downloadFile`). It is timed to response headers only, because its
 * body is streamed into R2 by the caller, and it has no abort (unchanged from before it moved).
 *
 * Two things about the measurement are easy to misread:
 *
 * - **The clock is in a `finally`, so a call that THROWS is timed too.** An indefinite stall
 *   that ends in a transport error is precisely the case this exists to catch; timing only
 *   the success path would have missed the pigeon-bit4 episode's worst readings entirely.
 * - **`elapsedMs` covers reading and parsing the body, not just the headers.** A response
 *   whose headers arrive promptly and whose body then stalls is a real failure mode here
 *   (it is what opened the circuit breaker in pigeon-mavq), so the number is deliberately
 *   time-to-parsed-result rather than time-to-first-byte. Anything sizing a timeout off it
 *   is therefore sizing against the whole call, which is the correct thing to abort.
 *
 * `Date.now()` is pinned to the last I/O in Workers, so it advances across a `fetch` but not
 * across pure computation. That makes it valid here and useless for timing CPU work.
 */
async function callTelegram<T>(
  botToken: string,
  method: string,
  init: RequestInit,
): Promise<ChatResult<T>> {
  const startedAt = Date.now();
  let outcome = "threw";
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, init);
    const parsed = await parseTgResponse<T>(res, method);
    outcome = parsed.ok ? "ok" : parsed.kind;
    return parsed;
  } finally {
    logTelegramCall(method, Date.now() - startedAt, outcome);
  }
}

async function parseTgResponse<T>(res: Response, method?: string): Promise<ChatResult<T>> {
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    result?: T;
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
    retry_after?: number;
  } | null;

  if (data !== null && data.ok === true && data.result !== undefined) {
    return { ok: true, result: data.result as T };
  }

  const errorCode = data?.error_code ?? (res.status !== 200 ? res.status : undefined);
  const description = data?.description;
  const retryAfter = data?.parameters?.retry_after ?? data?.retry_after;

  if (errorCode === 429 || res.status === 429 || typeof retryAfter === "number") {
    return {
      ok: false,
      kind: "rate_limited",
      retryAfter: typeof retryAfter === "number" ? retryAfter : DEFAULT_RETRY_AFTER_SECONDS,
      response: data ?? undefined,
    };
  }

  if (description && description.includes("thread not found")) {
    return {
      ok: false,
      kind: "thread_not_found",
      response: data ?? undefined,
    };
  }

  if (description && description.includes("TOPIC_NOT_MODIFIED")) {
    return {
      ok: false,
      kind: "topic_not_modified",
      response: data ?? undefined,
    };
  }

  if (errorCode === undefined && res.status === 200) {
    // The one shape that reaches the daemon as a 502 with no Telegram code: HTTP 200, headers
    // delivered, body unparseable or truncated. Telegram has therefore already committed the
    // send, so every retry of it is a guaranteed duplicate -- but the retry is still correct,
    // because the alternative (treating it as permanent) is what misfiled a notification in
    // pigeon-bit4.
    //
    // This warn exists to MEASURE that, not to change it (pigeon-jahv). The concern was that a
    // persistent occurrence could retry ~720 times in the 24h age cap. Nothing has ever been
    // observed doing it, and a systemic body-truncation fault would hit every send rather than
    // one row. If this line ever shows the same notification twice in a row, the bead to
    // reopen is pigeon-jahv.
    console.warn("[worker] telegram unparseable 200 (send may have succeeded)", {
      method,
      hasBody: data !== null,
    });
  }

  return {
    ok: false,
    kind: "error",
    errorCode,
    description,
    response: data ?? undefined,
  };
}

export async function sendMessage(
  botToken: string,
  options: SendMessageOptions,
): Promise<ChatResult<{ message_id: number }>> {
  const payload: Record<string, unknown> = {
    chat_id: options.chatId,
    text: options.text,
  };
  if (options.entities && options.entities.length > 0) {
    payload.entities = options.entities;
  }
  if (options.replyMarkup) {
    payload.reply_markup = options.replyMarkup;
  }
  if (options.messageThreadId !== undefined) {
    payload.message_thread_id = options.messageThreadId;
  }

  return callTelegram<{ message_id: number }>(botToken, "sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * Sends one rich message (Bot API 10.1, `sendRichMessage`) from markdown (pigeon-p909).
 *
 * Same shape as `sendMessage` on purpose, so the caller's topic recovery and relocation can
 * run unchanged whichever of the two it is using. `reply_markup` accepts an inline keyboard,
 * and the result is an ordinary `Message`, whose `message_id` routes replies like any other.
 */
export async function sendRichMessage(
  botToken: string,
  options: SendRichMessageOptions,
): Promise<ChatResult<{ message_id: number }>> {
  const payload: Record<string, unknown> = {
    chat_id: options.chatId,
    rich_message: { markdown: options.markdown },
  };
  if (options.replyMarkup) {
    payload.reply_markup = options.replyMarkup;
  }
  if (options.messageThreadId !== undefined) {
    payload.message_thread_id = options.messageThreadId;
  }

  return callTelegram<{ message_id: number }>(botToken, "sendRichMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function editMessageText(
  botToken: string,
  options: EditMessageTextOptions,
): Promise<ChatResult<{ message_id?: number } | boolean>> {
  const payload: Record<string, unknown> = {
    chat_id: options.chatId,
    message_id: options.messageId,
    text: options.text,
  };
  if (options.entities && options.entities.length > 0) {
    payload.entities = options.entities;
  }
  if (options.replyMarkup) {
    payload.reply_markup = options.replyMarkup;
  }

  return callTelegram<{ message_id?: number } | boolean>(botToken, "editMessageText", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function sendPhoto(
  botToken: string,
  options: SendPhotoOptions,
): Promise<ChatResult<{ message_id: number }>> {
  const form = new FormData();
  form.append("chat_id", String(options.chatId));
  form.append("photo", options.photo, options.filename);
  if (options.messageThreadId) {
    form.append("message_thread_id", String(options.messageThreadId));
  }
  if (options.replyToMessageId) {
    form.append("reply_to_message_id", String(options.replyToMessageId));
  }

  return callTelegram<{ message_id: number }>(botToken, "sendPhoto", {
    method: "POST",
    body: form,
  });
}

export async function sendDocument(
  botToken: string,
  options: SendDocumentOptions,
): Promise<ChatResult<{ message_id: number }>> {
  const form = new FormData();
  form.append("chat_id", String(options.chatId));
  form.append("document", options.document, options.filename);
  if (options.messageThreadId) {
    form.append("message_thread_id", String(options.messageThreadId));
  }
  if (options.replyToMessageId) {
    form.append("reply_to_message_id", String(options.replyToMessageId));
  }

  return callTelegram<{ message_id: number }>(botToken, "sendDocument", {
    method: "POST",
    body: form,
  });
}

export async function answerCallbackQuery(
  botToken: string,
  options: AnswerCallbackQueryOptions,
): Promise<ChatResult<boolean>> {
  const payload: Record<string, unknown> = {
    callback_query_id: options.callbackQueryId,
  };
  if (options.text) {
    payload.text = options.text;
  }

  return callTelegram<boolean>(botToken, "answerCallbackQuery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function getFile(
  botToken: string,
  options: GetFileOptions,
): Promise<ChatResult<{ file_path: string }>> {
  return callTelegram<{ file_path: string }>(botToken, "getFile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: options.fileId }),
  });
}

export async function createForumTopic(
  botToken: string,
  options: CreateForumTopicOptions,
): Promise<ChatResult<ForumTopic>> {
  const payload: Record<string, unknown> = {
    chat_id: options.chatId,
    name: options.name,
  };
  if (options.iconColor !== undefined) {
    payload.icon_color = options.iconColor;
  }
  if (options.iconCustomEmojiId !== undefined) {
    payload.icon_custom_emoji_id = options.iconCustomEmojiId;
  }

  return callTelegram<ForumTopic>(botToken, "createForumTopic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function editForumTopic(
  botToken: string,
  options: EditForumTopicOptions,
): Promise<ChatResult<boolean>> {
  const payload: Record<string, unknown> = {
    chat_id: options.chatId,
    message_thread_id: options.messageThreadId,
  };
  if (options.name !== undefined) {
    payload.name = options.name;
  }
  if (options.iconCustomEmojiId !== undefined) {
    payload.icon_custom_emoji_id = options.iconCustomEmojiId;
  }

  return callTelegram<boolean>(botToken, "editForumTopic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function closeForumTopic(
  botToken: string,
  options: CloseForumTopicOptions,
): Promise<ChatResult<boolean>> {
  return callTelegram<boolean>(botToken, "closeForumTopic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: options.chatId,
      message_thread_id: options.messageThreadId,
    }),
  });
}

export async function reopenForumTopic(
  botToken: string,
  options: ReopenForumTopicOptions,
): Promise<ChatResult<boolean>> {
  return callTelegram<boolean>(botToken, "reopenForumTopic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: options.chatId,
      message_thread_id: options.messageThreadId,
    }),
  });
}

export async function deleteForumTopic(
  botToken: string,
  options: DeleteForumTopicOptions,
): Promise<ChatResult<boolean>> {
  return callTelegram<boolean>(botToken, "deleteForumTopic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: options.chatId,
      message_thread_id: options.messageThreadId,
    }),
  });
}

/**
 * Clears every pinned message in a forum topic.
 *
 * Telegram auto-pins the first message posted into a freshly created forum topic, which
 * leaves every new Pigeon session topic with a pinned message nobody asked for. Pigeon
 * calls this once, immediately after the first send into a topic it just created, so the
 * only pin it can possibly clear is Telegram's own (bead pigeon-ud6s).
 */
export async function unpinAllForumTopicMessages(
  botToken: string,
  options: UnpinAllForumTopicMessagesOptions,
): Promise<ChatResult<boolean>> {
  return callTelegram<boolean>(botToken, "unpinAllForumTopicMessages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: options.chatId,
      message_thread_id: options.messageThreadId,
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * Downloads a file Telegram is hosting (`file_path` from `getFile`). Not a Bot API method, so it
 * returns the raw Response rather than a ChatResult: the caller streams the body into R2.
 *
 * It lives here, not at its call site, so that this file stays the only one that knows
 * Telegram's host (the egress guard test enforces that; chat-transport, pigeon-lenr.1).
 */
export async function downloadFile(botToken: string, filePath: string): Promise<Response> {
  const startedAt = Date.now();
  let outcome = "threw";
  try {
    const res = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
    outcome = res.ok ? "ok" : `http_${res.status}`;
    return res;
  } finally {
    logTelegramCall("downloadFile", Date.now() - startedAt, outcome);
  }
}

export function createTelegramClient(botToken: string) {
  return {
    sendMessage: (options: SendMessageOptions) => sendMessage(botToken, options),
    sendRichMessage: (options: SendRichMessageOptions) => sendRichMessage(botToken, options),
    editMessageText: (options: EditMessageTextOptions) => editMessageText(botToken, options),
    sendPhoto: (options: SendPhotoOptions) => sendPhoto(botToken, options),
    sendDocument: (options: SendDocumentOptions) => sendDocument(botToken, options),
    answerCallbackQuery: (options: AnswerCallbackQueryOptions) => answerCallbackQuery(botToken, options),
    getFile: (options: GetFileOptions) => getFile(botToken, options),
    createForumTopic: (options: CreateForumTopicOptions) => createForumTopic(botToken, options),
    editForumTopic: (options: EditForumTopicOptions) => editForumTopic(botToken, options),
    closeForumTopic: (options: CloseForumTopicOptions) => closeForumTopic(botToken, options),
    reopenForumTopic: (options: ReopenForumTopicOptions) => reopenForumTopic(botToken, options),
    deleteForumTopic: (options: DeleteForumTopicOptions) => deleteForumTopic(botToken, options),
    unpinAllForumTopicMessages: (options: UnpinAllForumTopicMessagesOptions) =>
      unpinAllForumTopicMessages(botToken, options),
    downloadFile: (filePath: string) => downloadFile(botToken, filePath),
  };
}

export type TelegramClient = ReturnType<typeof createTelegramClient>;
