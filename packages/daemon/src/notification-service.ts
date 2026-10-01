import { randomBytes } from "node:crypto";
import type { StorageDb } from "./storage/database";
import type { QuestionInfoData } from "./storage/types";
import { splitTelegramMessage } from "./split-message";
import { TgMessageBuilder, type TgEntity, type TgMessage } from "./telegram-message";
import type { SendNotificationInput, WorkerResult } from "./worker/poller";

/**
 * Upper bound on a plain-alert Telegram request. Deliberately short: the
 * callers await this on their critical paths (see `sendPlainAlert`), so the
 * cost of waiting is a stalled delivery loop, while the cost of giving up is
 * one lost operational alert that is already best-effort.
 */
export const PLAIN_ALERT_TIMEOUT_MS = 10_000;

interface NotificationInput {
  event: string;
  label: string;
  summary: string;
  cwd: string | null;
  token: string;
  machineId?: string;
  sessionId: string;
  /**
   * The session's effective oc-tags tag, or null/undefined for none.
   *
   * Only a MANUAL tag reaches here. Every session always has a tag, but an
   * untagged one falls back to `auto:<dir>`, which says nothing the cwd on
   * this same line does not already say. See SessionTagResolver.
   */
  tag?: string | null;
}

/**
 * ` · 🏷 <tag>`, or nothing. Shared so the renderers cannot drift.
 *
 * Capped because oc-tags itself sets no length limit — pigeon's own `/tag`
 * validator does, but a tag written from a terminal does not go through it, and
 * a question notification is not split or truncated anywhere.
 */
const MAX_TAG_CHARS = 64;

function appendTag(b: TgMessageBuilder, tag: string | null | undefined): void {
  const t = tag?.trim();
  if (!t) return;
  b.append(` · 🏷 ${t.length > MAX_TAG_CHARS ? `${t.slice(0, MAX_TAG_CHARS - 1)}…` : t}`);
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
  /**
   * Optional: send a free-form text alert (no inline_keyboard, no token,
   * no session binding). Used by external services (e.g. lgtm) that want
   * to surface a one-shot operational message via the existing Telegram
   * bot. Implementations may omit this method; callers must check for
   * its presence and degrade gracefully.
   */
  sendPlainAlert?(
    text: string,
    severity: AlertSeverity,
    options?: PlainAlertOptions,
  ): Promise<void>;
  /**
   * Optional: clear the pin Telegram puts on the first message of a newly
   * created forum topic. Best-effort; callers must tolerate absence and failure.
   */
  unpinTopic?(messageThreadId: number): Promise<void>;
}

export interface PlainAlertOptions {
  /**
   * Inline keyboard to attach (url buttons only — see alert-links.ts). Omitted
   * entirely from the request when absent, so an alert without buttons is
   * byte-identical to one sent before this option existed.
   */
  replyMarkup?: { inline_keyboard: Array<Array<{ text: string; url: string }>> };
  /**
   * Override the request bound (default PLAIN_ALERT_TIMEOUT_MS). Lets `/alert`
   * charge time already spent on its link lookup against the same budget, so
   * the route's worst case does not grow past today's.
   */
  timeoutMs?: number;
  /**
   * Forum topic to post into. Omitted from the request when absent, so an
   * alert without a topic still lands in General exactly as before.
   */
  messageThreadId?: number;
}

/**
 * Telegram answered with a non-2xx status. Carries the status so a caller can
 * tell "Telegram rejected this payload" (400 — safe to resend a corrected
 * payload, nothing was posted) from "unknown outcome" (timeouts, 5xx).
 */
export class TelegramSendError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Telegram's `description`, when the error body carried one. */
    public readonly description?: string,
  ) {
    super(description ? `${message}: ${description}` : message);
    this.name = "TelegramSendError";
  }
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
  appendTag(footerBuilder, input.tag);
  footerBuilder
    .newline()
    .append("🆔 ")
    .appendCode(input.sessionId);

  return {
    header: headerBuilder.build(),
    body: bodyBuilder.build(),
    footer: footerBuilder.build(),
    replyMarkup: { inline_keyboard: [] },
  };
}

export function formatEventTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const nowD = new Date(now);
  const hours = d.getHours().toString().padStart(2, "0");
  const mins = d.getMinutes().toString().padStart(2, "0");
  const timeStr = `${hours}:${mins}`;

  const isToday =
    d.getFullYear() === nowD.getFullYear() &&
    d.getMonth() === nowD.getMonth() &&
    d.getDate() === nowD.getDate();

  if (isToday) {
    return timeStr;
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthStr = months[d.getMonth()]!;
  return `${monthStr} ${d.getDate()} ${timeStr}`;
}

export interface FormatSwarmNotificationInput {
  kind: string;
  priority: string;
  fromLabel: string;
  toSessionId: string;
  msgId: string;
  payload: string;
  createdAt: number;
  deliverAt?: number | null;
  now?: number;
}

export function formatSwarmNotification(input: FormatSwarmNotificationInput): {
  header: TgMessage;
  body: TgMessage;
  footer: TgMessage;
} {
  // The event time is required, not decoration. Task 1's arbitration allows a conversational row (question/stop)
  // to preempt a backlogged swarm post within the same session, so a swarm post can arrive below the stop
  // notification it caused. Always printing the event time makes that legible instead of misleading.
  const now = input.now ?? Date.now();
  const createdAtTime = formatEventTime(input.createdAt, now);
  const headerBuilder = new TgMessageBuilder()
    .append(`📨 swarm · ${input.kind} · ${input.priority}`)
    .newline()
    .append(`from ${input.fromLabel} · ${createdAtTime}`);

  if (input.deliverAt && input.deliverAt > input.createdAt) {
    const deliverAtTime = formatEventTime(input.deliverAt, now);
    headerBuilder.append(` · ⏰ scheduled ${deliverAtTime}`);
  }

  const bodyBuilder = new TgMessageBuilder().append(input.payload);

  const footerBuilder = new TgMessageBuilder()
    .append("🆔 ")
    .appendCode(input.toSessionId)
    .append(" · ")
    .appendCode(input.msgId);

  return {
    header: headerBuilder.build(),
    body: bodyBuilder.build(),
    footer: footerBuilder.build(),
  };
}

export interface FormatSwarmCancelNotificationInput {
  msgId: string;
  toSessionId: string;
}

export function formatSwarmCancelNotification(input: FormatSwarmCancelNotificationInput): {
  header: TgMessage;
  body: TgMessage;
  footer: TgMessage;
} {
  const headerBuilder = new TgMessageBuilder()
    .append("🚫 cancelled ")
    .appendCode(input.msgId);

  const bodyBuilder = new TgMessageBuilder();

  const footerBuilder = new TgMessageBuilder()
    .append("🆔 ")
    .appendCode(input.toSessionId);

  return {
    header: headerBuilder.build(),
    body: bodyBuilder.build(),
    footer: footerBuilder.build(),
  };
}

export function formatQuestionNotification(input: {
  label: string;
  questions: QuestionInfoData[];
  cwd: string | null;
  token: string;
  sessionId: string;
  machineId?: string;
  tag?: string | null;
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
  appendTag(b, input.tag);
  b.newline().append("🆔 ").appendCode(input.sessionId);

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
  tag?: string | null;
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
  appendTag(b, input.tag);
  b.newline().append("🆔 ").appendCode(input.sessionId);

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

export class TelegramNotificationService implements StopNotifier {
  private readonly apiBase: string;

  constructor(
    _storage: StorageDb,
    private readonly botToken: string,
    private readonly chatId: string,
    _nowFn: () => number = Date.now,
    private readonly fetchFn: typeof fetch = fetch,
    _machineId?: string,
  ) {
    this.apiBase = `https://api.telegram.org/bot${this.botToken}`;
  }

  /**
   * Bounds the request so a stalled socket cannot leave the promise pending
   * forever. This is the same hazard, and the same fix, as `pigeon-h21` in
   * `opencode-client.ts` — and the callers make it acute:
   *
   *  - `SwarmArbiter` awaits this while holding the target's `inflight` slot,
   *    which is released in a `.finally()`. A promise that never settles means
   *    the slot is never released, so ALL swarm delivery to that session wedges
   *    permanently. No rejection means no retry; silence reads as success.
   *  - `DeliveryWatchdog` awaits it under its `processing` guard, so the same
   *    hung connection freezes the watchdog too — including the overdue alarm
   *    whose entire job is to notice that delivery has stalled.
   *
   * One stuck socket would otherwise wedge delivery AND silence the monitor
   * meant to report it. A try/catch does not help here: the failure mode is a
   * promise that never settles, not one that rejects.
   */
  async sendPlainAlert(
    text: string,
    severity: AlertSeverity,
    options?: PlainAlertOptions,
  ): Promise<void> {
    const prefix =
      severity === "error" ? "❌ " : severity === "warning" ? "⚠️ " : "";
    const timeoutMs = options?.timeoutMs ?? PLAIN_ALERT_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The AbortSignal alone only bounds a fetch that HONOURS it. Racing an
    // explicit deadline bounds it either way -- which is the difference between
    // an alert that can hang the watchdog cycle and one that cannot (pigeon-wfj1).
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new Error(
            `Telegram sendMessage timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
    });
    deadline.catch(() => {});

    let response: Response;
    try {
      const inFlight = this.fetchFn(`${this.apiBase}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: `${prefix}${text}`,
          ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
          ...(options?.messageThreadId !== undefined ? { message_thread_id: options.messageThreadId } : {}),
        }),
        signal: controller.signal,
      });
      inFlight.catch(() => {});
      response = await Promise.race([inFlight, deadline]);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(
          `Telegram sendMessage timed out after ${timeoutMs}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new TelegramSendError(
        response.status,
        `Telegram sendMessage returned ${response.status}`,
        await readDescription(response),
      );
    }
  }

  async unpinTopic(messageThreadId: number): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PLAIN_ALERT_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(`${this.apiBase}/unpinAllForumTopicMessages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, message_thread_id: messageThreadId }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`unpinAllForumTopicMessages returned ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Telegram's error `description`, bounded: the response headers have arrived but
 * a body read can still stall, and this sits on the alert's critical path.
 */
async function readDescription(response: Response): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      response.text(),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(""), 1_000);
      }),
    ]);
    const parsed = JSON.parse(text) as { description?: unknown };
    return typeof parsed.description === "string" ? parsed.description : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
