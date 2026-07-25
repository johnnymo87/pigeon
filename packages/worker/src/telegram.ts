export type TgResult<T> =
  | { ok: true; result: T }
  | { ok: false; kind: "rate_limited"; retryAfter: number; response?: unknown }
  | { ok: false; kind: "thread_not_found"; response?: unknown }
  | { ok: false; kind: "error"; errorCode?: number; description?: string; response?: unknown };

export interface SendMessageOptions {
  chatId: string | number;
  text: string;
  entities?: unknown[];
  replyMarkup?: unknown;
}

export interface EditMessageTextOptions {
  chatId: string | number;
  messageId: number;
  text: string;
  entities?: unknown[];
  replyMarkup?: unknown;
}

export interface SendPhotoOptions {
  chatId: string | number;
  photo: Blob;
  filename: string;
  replyToMessageId?: number;
}

export interface SendDocumentOptions {
  chatId: string | number;
  document: Blob;
  filename: string;
  replyToMessageId?: number;
}

export interface AnswerCallbackQueryOptions {
  callbackQueryId: string;
  text?: string;
}

export interface GetFileOptions {
  fileId: string;
}

async function parseTgResponse<T>(res: Response): Promise<TgResult<T>> {
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    result?: T;
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
    retry_after?: number;
  } | null;

  if (data && data.ok === true && data.result !== undefined) {
    return { ok: true, result: data.result };
  }

  const errorCode = data?.error_code ?? (res.status !== 200 ? res.status : undefined);
  const description = data?.description;
  const retryAfter = data?.parameters?.retry_after ?? data?.retry_after;

  if (errorCode === 429 || res.status === 429 || typeof retryAfter === "number") {
    return {
      ok: false,
      kind: "rate_limited",
      retryAfter: typeof retryAfter === "number" ? retryAfter : 1,
      response: data ?? undefined,
    };
  }

  if (
    description &&
    (description.includes("message thread not found") || description.includes("thread not found"))
  ) {
    return {
      ok: false,
      kind: "thread_not_found",
      response: data ?? undefined,
    };
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
): Promise<TgResult<{ message_id: number }>> {
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

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return parseTgResponse<{ message_id: number }>(res);
}

export async function editMessageText(
  botToken: string,
  options: EditMessageTextOptions,
): Promise<TgResult<unknown>> {
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

  const res = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return parseTgResponse<unknown>(res);
}

export async function sendPhoto(
  botToken: string,
  options: SendPhotoOptions,
): Promise<TgResult<{ message_id: number }>> {
  const form = new FormData();
  form.append("chat_id", String(options.chatId));
  form.append("photo", options.photo, options.filename);
  if (options.replyToMessageId) {
    form.append("reply_to_message_id", String(options.replyToMessageId));
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: "POST",
    body: form,
  });

  return parseTgResponse<{ message_id: number }>(res);
}

export async function sendDocument(
  botToken: string,
  options: SendDocumentOptions,
): Promise<TgResult<{ message_id: number }>> {
  const form = new FormData();
  form.append("chat_id", String(options.chatId));
  form.append("document", options.document, options.filename);
  if (options.replyToMessageId) {
    form.append("reply_to_message_id", String(options.replyToMessageId));
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    body: form,
  });

  return parseTgResponse<{ message_id: number }>(res);
}

export async function answerCallbackQuery(
  botToken: string,
  options: AnswerCallbackQueryOptions,
): Promise<TgResult<boolean>> {
  const payload: Record<string, unknown> = {
    callback_query_id: options.callbackQueryId,
  };
  if (options.text) {
    payload.text = options.text;
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return parseTgResponse<boolean>(res);
}

export async function getFile(
  botToken: string,
  options: GetFileOptions,
): Promise<TgResult<{ file_path: string }>> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: options.fileId }),
  });

  return parseTgResponse<{ file_path: string }>(res);
}
