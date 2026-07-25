import { randomBytes } from "node:crypto";
import type { StorageDb } from "./storage/database";
import type { QuestionInfoData } from "./storage/types";
import { splitTelegramMessage } from "./split-message";
import { TgMessageBuilder, type TgEntity, type TgMessage } from "./telegram-message";
import type { Activity } from "./current-state-enrich";

interface NotificationInput {
  event: string;
  label: string;
  summary: string;
  cwd: string | null;
  token: string;
  machineId?: string;
  sessionId: string;
}

export interface SessionLike {
  title?: string | null;
  sessionId: string;
  label: string | null;
  cwd: string | null;
}

export function displayName(input: {
  title?: string | null;
  label?: string | null;
  sessionId: string;
}): string {
  const title = input.title?.trim();
  if (title) return title;
  const label = input.label?.trim();
  if (label) return label;
  return input.sessionId.slice(0, 8);
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

export type AlertSeverity = "info" | "warning" | "error";

/**
 * Error thrown when a notification attempt is rate-limited by the worker / Telegram API.
 */
export class RateLimitError extends Error {
  /**
   * @param message Human-readable error description.
   * @param retryAfter Duration to wait before retrying, in **seconds** (direct from Telegram API `parameters.retry_after`).
   */
  constructor(
    message: string,
    public readonly retryAfter: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

export interface StopNotifier {
  sendStopNotification(input: StopNotificationInput): Promise<NotificationResult>;
  /**
   * Optional: send a free-form text alert (no inline_keyboard, no token,
   * no session binding). Used by external services (e.g. lgtm) that want
   * to surface a one-shot operational message via the existing Telegram
   * bot. Implementations may omit this method; callers must check for
   * its presence and degrade gracefully.
   */
  sendPlainAlert?(text: string, severity: AlertSeverity): Promise<void>;
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
    notificationId?: string,
    entities?: TgEntity[],
  ): Promise<{ ok: boolean; retryAfter?: number }>;

  uploadMedia?(
    key: string,
    data: ArrayBuffer,
    mime: string,
    filename: string,
  ): Promise<{ ok: boolean; key: string }>;
}

const EVENT_EMOJIS: Record<string, string> = {
  Stop: "✅",
  Error: "❌",
  Retry: "🔁",
  SubagentStop: "🔧",
  Question: "❓",
  Notification: "🔔",
};

function eventEmoji(event: string): string {
  return EVENT_EMOJIS[event] ?? "🤖";
}

export function formatTelegramNotification(input: NotificationInput): {
  header: TgMessage;
  body: TgMessage;
  footer: TgMessage;
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
} {
  const cwdShort = input.cwd ? input.cwd.split("/").slice(-2).join("/") : "unknown";

  const headerBuilder = new TgMessageBuilder()
    .append(`${eventEmoji(input.event)} `)
    .append(input.label);

  const bodyBuilder = new TgMessageBuilder().append(input.summary);

  const footerBuilder = new TgMessageBuilder()
    .append("📂 ")
    .appendCode(cwdShort);
  if (input.machineId) {
    footerBuilder.append(` · 🖥 ${input.machineId}`);
  }
  footerBuilder
    .newline()
    .append("🆔 ")
    .appendCode(input.sessionId)
    .newline(2)
    .append("↩️ ")
    .appendItalic("Swipe-reply to respond");

  return {
    header: headerBuilder.build(),
    body: bodyBuilder.build(),
    footer: footerBuilder.build(),
    replyMarkup: { inline_keyboard: [] },
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
  message: TgMessage;
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
} {
  const cwdShort = input.cwd ? input.cwd.split("/").slice(-2).join("/") : "unknown";
  const firstQuestion = input.questions[0];
  const isMulti = input.questions.length > 1;

  const b = new TgMessageBuilder()
    .append("❓ ")
    .appendBold("Question")
    .append(`: ${input.label}`)
    .newline(2);

  input.questions.forEach((q, idx) => {
    if (idx > 0) b.newline(2);
    if (q.header) {
      if (isMulti) {
        b.append(`(${idx + 1}/${input.questions.length}) `).appendBold(q.header);
      } else {
        b.appendBold(q.header);
      }
      b.newline();
    } else if (isMulti) {
      b.append(`(${idx + 1}/${input.questions.length})`).newline();
    }
    b.append(q.question);
    if (q.options.length > 0) {
      b.newline(2);
      q.options.forEach((opt, i) => {
        if (i > 0) b.newline();
        const desc = opt.description ? ` — ${opt.description}` : "";
        b.append(`${i + 1}. ${opt.label}${desc}`);
      });
    }
  });

  if (isMulti) {
    b.newline(2).appendItalic("answer in app or wait for wizard buttons");
  }

  b.newline(2).append("📂 ").appendCode(cwdShort);
  if (input.machineId) {
    b.append(` · 🖥 ${input.machineId}`);
  }
  b.newline().append("🆔 ").appendCode(input.sessionId);

  const hasCustom = input.questions.some(q => q.custom !== false);
  if (hasCustom) {
    b.newline(2).append("↩️ ").appendItalic("Swipe-reply for custom answer");
  }

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  if (input.questions.length === 1 && firstQuestion && firstQuestion.options.length > 0) {
    const options = firstQuestion.options;
    for (let i = 0; i < options.length; i += 3) {
      rows.push(
        options.slice(i, i + 3).map((opt, j) => ({
          text: opt.label,
          callback_data: `cmd:${input.token}:q${i + j}`,
        })),
      );
    }
  }

  return { message: b.build(), replyMarkup: { inline_keyboard: rows } };
}

export function formatQuestionWizardStep(input: {
  label: string;
  questions: QuestionInfoData[];
  currentStep: number;
  cwd: string | null;
  token: string;
  version: number;
  sessionId: string;
  machineId?: string;
}): {
  message: TgMessage;
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
} {
  const totalSteps = input.questions.length;
  const currentQuestion = input.questions[input.currentStep]!;
  const cwdShort = input.cwd ? input.cwd.split("/").slice(-2).join("/") : "unknown";

  const b = new TgMessageBuilder()
    .append("❓ ")
    .appendBold(`Question ${input.currentStep + 1} of ${totalSteps}`)
    .append(`: ${input.label}`)
    .newline(2);

  if (currentQuestion.header) {
    b.appendBold(currentQuestion.header).newline();
  }
  b.append(currentQuestion.question);

  if (currentQuestion.options.length > 0) {
    b.newline(2);
    currentQuestion.options.forEach((opt, i) => {
      if (i > 0) b.newline();
      const desc = opt.description ? ` — ${opt.description}` : "";
      b.append(`${i + 1}. ${opt.label}${desc}`);
    });
  }

  b.newline(2).append("📂 ").appendCode(cwdShort);
  if (input.machineId) {
    b.append(` · 🖥 ${input.machineId}`);
  }
  b.newline().append("🆔 ").appendCode(input.sessionId);

  const hasCustom = currentQuestion.custom !== false;
  if (hasCustom) {
    b.newline(2).append("↩️ ").appendItalic("Swipe-reply for custom answer");
  }

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  const options = currentQuestion.options;
  for (let i = 0; i < options.length; i += 3) {
    rows.push(
      options.slice(i, i + 3).map((opt, j) => ({
        text: opt.label,
        callback_data: `cmd:${input.token}:v${input.version}:q${i + j}`,
      })),
    );
  }

  return { message: b.build(), replyMarkup: { inline_keyboard: rows } };
}

export function generateToken(): string {
  return randomBytes(16).toString("base64url");
}

export function relativeTime(ms: number, now: number): string {
  const diff = now - ms;
  if (diff < 0 || diff < 60_000) {
    return "just now";
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m ago`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}h ago`;
  }
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function formatStateCard(
  input: {
    title: string;
    status: Activity;
    dir: string | null;
    sid: string;
    snippet: string;
    lastActivity: number | null;
    machineId: string;
  },
  now?: number,
): TgMessage {
  const currentTime = now ?? Date.now();
  const dirShort = input.dir ? input.dir.split("/").slice(-2).join("/") : "unknown";

  const builder = new TgMessageBuilder()
    .append(input.status === "active" ? "🟢" : "⚪")
    .append(" ")
    .appendBold(input.title);

  if (input.snippet) {
    builder.newline().append(input.snippet);
  }

  builder
    .newline(2)
    .append("📂 ")
    .appendCode(dirShort)
    .append(` · 🖥 ${input.machineId}`)
    .newline()
    .append("🆔 ")
    .appendCode(input.sid)
    .newline()
    .append("↩️ ")
    .appendItalic("Swipe-reply to respond");

  if (input.lastActivity !== null) {
    builder.append(` · ${relativeTime(input.lastActivity, currentTime)}`);
  }

  return builder.build();
}

export function formatCurrentStateIndex(
  input: {
    machineId: string;
    sessions: Array<{ title: string; status: Activity }>;
    unreadable?: number;
    homeScreen?: number;
  },
): TgMessage {
  const builder = new TgMessageBuilder()
    .append("📋 ")
    .appendBold("Current state")
    .append(` — ${input.machineId}`)
    .newline();

  let active = 0;
  let idle = 0;
  for (const s of input.sessions) {
    if (s.status === "active") {
      active++;
    } else if (s.status === "idle") {
      idle++;
    }
  }

  builder.append(`${input.sessions.length} main session(s) · ${active} 🟢 active · ${idle} ⚪ idle`);
  if (input.unreadable && input.unreadable > 0) {
    builder.append(` · ${input.unreadable} unreadable`);
  }
  if (input.homeScreen && input.homeScreen > 0) {
    builder.append(` · ${input.homeScreen} on home screen`);
  }

  if (input.sessions.length > 0) {
    builder.newline(2);
    input.sessions.forEach((s, idx) => {
      if (idx > 0) {
        builder.newline();
      }
      const emoji = s.status === "active" ? "🟢" : "⚪";
      builder.append(`${idx + 1}. ${s.title} ${emoji}`);
    });
  }

  return builder.build();
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
    entities?: TgEntity[],
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      chat_id: this.chatId,
      text,
      reply_markup: replyMarkup,
    };
    if (entities && entities.length > 0) {
      payload.entities = entities;
    }
    const response = await this.fetchFn(`${this.apiBase}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.json() as { result?: { message_id?: number } };
    const messageId = result?.result?.message_id;

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
        summary: input.summary.slice(0, 200),
      },
    }, now);

    const notification = formatTelegramNotification({
      event: input.event,
      label: displayName({ title: input.session.title, label: input.label || input.session.label, sessionId: input.session.sessionId }),
      summary: input.summary,
      cwd: input.session.cwd,
      token,
      machineId: this.machineId,
      sessionId: input.session.sessionId,
    });

    const { header, body, footer, replyMarkup } = notification;
    const chunks = splitTelegramMessage(header, body, footer);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await this.sendTelegramMessage(
        input.session.sessionId,
        chunks[i]!.text,
        isLast ? replyMarkup : { inline_keyboard: [] },
        token,
        chunks[i]!.entities,
      );
    }

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
      label: displayName({ title: input.session.title, label: input.label || input.session.label, sessionId: input.session.sessionId }),
      questions: input.questions,
      cwd: input.session.cwd,
      token,
      machineId: this.machineId,
      sessionId: input.session.sessionId,
    });

    await this.sendTelegramMessage(
      input.session.sessionId,
      notification.message.text,
      notification.replyMarkup,
      token,
      notification.message.entities,
    );

    return { token };
  }

  async sendPlainAlert(text: string, severity: AlertSeverity): Promise<void> {
    const prefix =
      severity === "error" ? "❌ " : severity === "warning" ? "⚠️ " : "";
    const response = await this.fetchFn(`${this.apiBase}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: `${prefix}${text}`,
      }),
    });
    if (!response.ok) {
      throw new Error(`Telegram sendMessage returned ${response.status}`);
    }
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
    entities?: TgEntity[],
  ): Promise<void> {
    const result = await this.workerSender.sendNotification(
      sessionId,
      this.chatId,
      text,
      replyMarkup,
      media,
      undefined,
      entities,
    );

    if (!result.ok) {
      if (result.retryAfter !== undefined) {
        throw new RateLimitError("Worker notification send rate limited", result.retryAfter);
      }
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
        summary: input.summary.slice(0, 200),
      },
    }, now);

    const notification = formatTelegramNotification({
      event: input.event,
      label: displayName({ title: input.session.title, label: input.label || input.session.label, sessionId: input.session.sessionId }),
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

    const { header, body, footer, replyMarkup } = notification;
    const chunks = splitTelegramMessage(header, body, footer);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await this.sendViaWorker(
        input.session.sessionId,
        chunks[i]!.text,
        isLast ? replyMarkup : { inline_keyboard: [] },
        isLast && mediaKeys && mediaKeys.length > 0 ? mediaKeys : undefined,
        chunks[i]!.entities,
      );
    }

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
      label: displayName({ title: input.session.title, label: input.label || input.session.label, sessionId: input.session.sessionId }),
      questions: input.questions,
      cwd: input.session.cwd,
      token,
      machineId: this.machineId,
      sessionId: input.session.sessionId,
    });

    await this.sendViaWorker(
      input.session.sessionId,
      notification.message.text,
      notification.replyMarkup,
      undefined,
      notification.message.entities,
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
    } catch (err) {
      if (err instanceof RateLimitError) {
        throw err;
      }
      return this.fallback.sendStopNotification(input);
    }
  }

  async sendQuestionNotification(input: QuestionNotificationInput): Promise<NotificationResult> {
    try {
      return await this.primary.sendQuestionNotification(input);
    } catch (err) {
      if (err instanceof RateLimitError) {
        throw err;
      }
      return this.fallback.sendQuestionNotification(input);
    }
  }

  async sendPlainAlert(text: string, severity: AlertSeverity): Promise<void> {
    if (this.primary.sendPlainAlert) {
      try {
        await this.primary.sendPlainAlert(text, severity);
        return;
      } catch (err) {
        if (err instanceof RateLimitError) {
          throw err;
        }
        // fall through to fallback
      }
    }
    if (this.fallback.sendPlainAlert) {
      await this.fallback.sendPlainAlert(text, severity);
    }
  }
}

/** @deprecated Use FallbackNotifier instead */
export const FallbackStopNotifier = FallbackNotifier;
