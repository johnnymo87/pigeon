import { randomBytes } from "node:crypto";
import type { StorageDb } from "./storage/database";
import type { QuestionInfoData } from "./storage/types";

interface NotificationInput {
  event: string;
  label: string;
  summary: string;
  cwd: string | null;
  token: string;
  machineId?: string;
  sessionId: string;
}

interface SessionLike {
  sessionId: string;
  label: string | null;
  cwd: string | null;
}

interface StopNotificationInput {
  session: SessionLike;
  event: string;
  summary: string;
  label?: string;
  media?: Array<{ mime: string; filename: string; url: string }>;
}

export interface QuestionNotificationInput {
  session: SessionLike;
  questionRequestId: string;
  questions: QuestionInfoData[];
  label?: string;
}

interface NotificationResult {
  token: string;
}

export interface StopNotifier {
  sendStopNotification(input: StopNotificationInput): Promise<NotificationResult>;
}

export interface QuestionNotifier {
  sendQuestionNotification(input: QuestionNotificationInput): Promise<NotificationResult>;
}

export interface WorkerNotificationSender {
  sendNotification(
    sessionId: string,
    chatId: string,
    text: string,
    replyMarkup: { inline_keyboard?: unknown[] },
    media?: Array<{ key: string; mime: string; filename: string }>,
  ): Promise<{ ok: boolean }>;

  uploadMedia?(
    key: string,
    data: ArrayBuffer,
    mime: string,
    filename: string,
  ): Promise<{ ok: boolean; key: string }>;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]]/g, "\\$&");
}

function eventEmoji(event: string): string {
  if (event === "SubagentStop") return "🔧";
  if (event === "Question") return "❓";
  if (event === "Notification") return "❓";
  return "🤖";
}

export function formatTelegramNotification(input: NotificationInput): {
  text: string;
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
} {
  const cwdShort = input.cwd ? input.cwd.split("/").slice(-2).join("/") : "unknown";
  let infoLine = `📂 \`${cwdShort}\``;
  if (input.machineId) {
    infoLine += ` · 🖥 ${escapeMarkdown(input.machineId)}`;
  }
  infoLine += ` · 🆔 \`${input.sessionId}\``;

  const text = [
    `${eventEmoji(input.event)} *${input.event}*: ${escapeMarkdown(input.label)}`,
    "",
    input.summary,
    "",
    infoLine,
    "",
    "↩️ _Swipe-reply to respond_",
  ].join("\n");

  return {
    text,
    replyMarkup: {
      inline_keyboard: [],
    },
  };
}

export function formatQuestionNotification(input: {
  label: string;
  questions: QuestionInfoData[];
  cwd: string | null;
  token: string;
  sessionId: string;
  machineId?: string;
}): {
  text: string;
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
} {
  const cwdShort = input.cwd ? input.cwd.split("/").slice(-2).join("/") : "unknown";
  const firstQuestion = input.questions[0];

  const lines = [
    `❓ *Question*: ${escapeMarkdown(input.label)}`,
    "",
  ];

  if (firstQuestion) {
    if (firstQuestion.header) {
      lines.push(`*${escapeMarkdown(firstQuestion.header)}*`);
    }
    lines.push(escapeMarkdown(firstQuestion.question));

    if (firstQuestion.options.length > 0) {
      lines.push("");
      firstQuestion.options.forEach((opt, i) => {
        const desc = opt.description ? ` — ${escapeMarkdown(opt.description)}` : "";
        lines.push(`${i + 1}\\. ${escapeMarkdown(opt.label)}${desc}`);
      });
    }
  }

  if (input.questions.length > 1) {
    lines.push("");
    lines.push(`_\\+${input.questions.length - 1} more question(s) — answer in app_`);
  }

  let questionInfoLine = `📂 \`${cwdShort}\``;
  if (input.machineId) {
    questionInfoLine += ` · 🖥 ${escapeMarkdown(input.machineId)}`;
  }
  questionInfoLine += ` · 🆔 \`${input.sessionId}\``;
  lines.push("");
  lines.push(questionInfoLine);

  const hasCustom = firstQuestion?.custom !== false;
  if (hasCustom) {
    lines.push("");
    lines.push("↩️ _Swipe-reply for custom answer_");
  }

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  // Only provide buttons for single-question requests
  if (input.questions.length === 1 && firstQuestion && firstQuestion.options.length > 0) {
    const options = firstQuestion.options;
    // Put up to 3 per row
    for (let i = 0; i < options.length; i += 3) {
      rows.push(
        options.slice(i, i + 3).map((opt, j) => ({
          text: opt.label,
          callback_data: `cmd:${input.token}:q${i + j}`,
        })),
      );
    }
  }

  return {
    text: lines.join("\n"),
    replyMarkup: { inline_keyboard: rows },
  };
}

function generateToken(): string {
  return randomBytes(16).toString("base64url");
}

export class TelegramNotificationService implements StopNotifier, QuestionNotifier {
  private readonly apiBase: string;

  constructor(
    private readonly storage: StorageDb,
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly nowFn: () => number = Date.now,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly machineId?: string,
  ) {
    this.apiBase = `https://api.telegram.org/bot${this.botToken}`;
  }

  private async sendTelegramMessage(
    sessionId: string,
    text: string,
    replyMarkup: { inline_keyboard: unknown[] },
    token: string,
  ): Promise<void> {
    const response = await this.fetchFn(`${this.apiBase}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: "Markdown",
        reply_markup: replyMarkup,
      }),
    });

    const payload = await response.json() as { result?: { message_id?: number } };
    const messageId = payload?.result?.message_id;

    if (messageId) {
      this.storage.replyTokens.store(this.chatId, String(messageId), token, this.nowFn());
    }
  }

  async sendStopNotification(input: StopNotificationInput): Promise<NotificationResult> {
    const now = this.nowFn();
    const token = generateToken();

    this.storage.sessionTokens.mint({
      token,
      sessionId: input.session.sessionId,
      chatId: this.chatId,
      context: {
        event: input.event,
        summary: input.summary,
      },
    }, now);

    const notification = formatTelegramNotification({
      event: input.event,
      label: input.label || input.session.label || input.session.sessionId.slice(0, 8),
      summary: input.summary,
      cwd: input.session.cwd,
      token,
      machineId: this.machineId,
      sessionId: input.session.sessionId,
    });

    await this.sendTelegramMessage(
      input.session.sessionId,
      notification.text,
      notification.replyMarkup,
      token,
    );

    return { token };
  }

  async sendQuestionNotification(input: QuestionNotificationInput): Promise<NotificationResult> {
    const now = this.nowFn();
    const token = generateToken();

    this.storage.sessionTokens.mint({
      token,
      sessionId: input.session.sessionId,
      chatId: this.chatId,
      context: {
        type: "question",
        questionRequestId: input.questionRequestId,
      },
    }, now);

    this.storage.pendingQuestions.store({
      sessionId: input.session.sessionId,
      requestId: input.questionRequestId,
      questions: input.questions,
      token,
    }, now);

    const notification = formatQuestionNotification({
      label: input.label || input.session.label || input.session.sessionId.slice(0, 8),
      questions: input.questions,
      cwd: input.session.cwd,
      token,
      machineId: this.machineId,
      sessionId: input.session.sessionId,
    });

    await this.sendTelegramMessage(
      input.session.sessionId,
      notification.text,
      notification.replyMarkup,
      token,
    );

    return { token };
  }
}

export class WorkerNotificationService implements StopNotifier, QuestionNotifier {
  constructor(
    private readonly storage: StorageDb,
    private readonly workerSender: WorkerNotificationSender,
    private readonly chatId: string,
    private readonly nowFn: () => number = Date.now,
    private readonly machineId?: string,
  ) {}

  private async sendViaWorker(
    sessionId: string,
    text: string,
    replyMarkup: { inline_keyboard: unknown[] },
    media?: Array<{ key: string; mime: string; filename: string }>,
  ): Promise<void> {
    const result = await this.workerSender.sendNotification(
      sessionId,
      this.chatId,
      text,
      replyMarkup,
      media,
    );

    if (!result.ok) {
      throw new Error("Worker notification send failed");
    }
  }

  async sendStopNotification(input: StopNotificationInput): Promise<NotificationResult> {
    const now = this.nowFn();
    const token = generateToken();

    this.storage.sessionTokens.mint({
      token,
      sessionId: input.session.sessionId,
      chatId: this.chatId,
      context: {
        event: input.event,
        summary: input.summary,
      },
    }, now);

    const notification = formatTelegramNotification({
      event: input.event,
      label: input.label || input.session.label || input.session.sessionId.slice(0, 8),
      summary: input.summary,
      cwd: input.session.cwd,
      token,
      machineId: this.machineId,
      sessionId: input.session.sessionId,
    });

    let mediaKeys: Array<{ key: string; mime: string; filename: string }> | undefined;
    if (input.media && input.media.length > 0 && this.workerSender.uploadMedia) {
      mediaKeys = [];
      for (const file of input.media) {
        try {
          const base64Match = file.url.match(/^data:[^;]+;base64,(.+)$/);
          const base64Data = base64Match?.[1];
          if (!base64Data) continue;
          const buffer = Buffer.from(base64Data, "base64");
          const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
          const timestamp = Date.now();
          const key = `outbound/${timestamp}-${crypto.randomUUID()}/${file.filename}`;
          const result = await this.workerSender.uploadMedia(key, arrayBuffer, file.mime, file.filename);
          if (result.ok) {
            mediaKeys.push({ key: result.key, mime: file.mime, filename: file.filename });
          }
        } catch {
          // Skip failed uploads — text notification still goes through
          continue;
        }
      }
    }

    await this.sendViaWorker(
      input.session.sessionId,
      notification.text,
      notification.replyMarkup,
      mediaKeys && mediaKeys.length > 0 ? mediaKeys : undefined,
    );

    return { token };
  }

  async sendQuestionNotification(input: QuestionNotificationInput): Promise<NotificationResult> {
    const now = this.nowFn();
    const token = generateToken();

    this.storage.sessionTokens.mint({
      token,
      sessionId: input.session.sessionId,
      chatId: this.chatId,
      context: {
        type: "question",
        questionRequestId: input.questionRequestId,
      },
    }, now);

    this.storage.pendingQuestions.store({
      sessionId: input.session.sessionId,
      requestId: input.questionRequestId,
      questions: input.questions,
      token,
    }, now);

    const notification = formatQuestionNotification({
      label: input.label || input.session.label || input.session.sessionId.slice(0, 8),
      questions: input.questions,
      cwd: input.session.cwd,
      token,
      machineId: this.machineId,
      sessionId: input.session.sessionId,
    });

    await this.sendViaWorker(
      input.session.sessionId,
      notification.text,
      notification.replyMarkup,
    );

    return { token };
  }
}

export class FallbackNotifier implements StopNotifier, QuestionNotifier {
  constructor(
    private readonly primary: StopNotifier & QuestionNotifier,
    private readonly fallback: StopNotifier & QuestionNotifier,
  ) {}

  async sendStopNotification(input: StopNotificationInput): Promise<NotificationResult> {
    try {
      return await this.primary.sendStopNotification(input);
    } catch {
      return this.fallback.sendStopNotification(input);
    }
  }

  async sendQuestionNotification(input: QuestionNotificationInput): Promise<NotificationResult> {
    try {
      return await this.primary.sendQuestionNotification(input);
    } catch {
      return this.fallback.sendQuestionNotification(input);
    }
  }
}

/** @deprecated Use FallbackNotifier instead */
export const FallbackStopNotifier = FallbackNotifier;
