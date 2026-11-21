import { randomBytes } from "node:crypto";
import type { QuestionInfoData } from "./storage/types";
import { splitTelegramMessage } from "./split-message";
import { TgMessageBuilder, type TgEntity, type TgMessage } from "./telegram-message";
import type { SendNotificationInput, WorkerResult } from "./worker/poller";

/**
 * Upper bound on a plain-alert request. Deliberately short: the
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

/**
 * A session bound to a named topic (a stall-watch coordinator, `📋 <tag>`) was
 * named on purpose by whoever bound it, so its label outranks the title the
 * agent generated.
 */
export function displayName(input: {
  title?: string | null;
  label?: string | null;
  boundTopicKey?: string | null;
  sessionId: string;
}): string {
  const title = input.title?.trim();
  const label = input.label?.trim();
  if (label && input.boundTopicKey) return label;
  if (title) return title;
  if (label) return label;
  return input.sessionId.slice(0, 8);
}

export type AlertSeverity = "info" | "warning" | "error";

export interface StopNotifier {
  /**
   * Optional: send a free-form text alert (no inline_keyboard, no token,
   * no session binding). Used by external services (e.g. lgtm) that want
   * to surface a one-shot operational message in the chat. Implementations may omit this method; callers must check for
   * its presence and degrade gracefully.
   */
  sendPlainAlert?(
    text: string,
    severity: AlertSeverity,
    options?: PlainAlertOptions,
  ): Promise<void>;
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
  /**
   * The chat `messageThreadId` belongs to, when the worker named it (`/topics/named` returns
   * `chatId`, pigeon-4ogz.5): a `slack:<team>` address for a Slack channel. Absent means the
   * machine's own `#alerts`.
   */
  chatId?: string;
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
    /**
     * The worker's `errorClass` for a Slack rejection (`conversation_gone`, `rejected_format`,
     * ...; pigeon-4ogz.5). Absent for Telegram.
     */
    public readonly errorClass?: string,
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
  Queued: "⏳",
  Permission: "🔐",
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
  // to preempt a backlogged swarm post within the same session, so a swarm post can arrive below a later
  // stop (not the one answering it: that waits behind this notice, pigeon-mwtg). The event time keeps
  // the order legible.
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
