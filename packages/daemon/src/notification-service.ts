import { randomBytes } from "node:crypto";
import type { StorageDb } from "./storage/database";
import type { QuestionInfoData } from "./storage/types";
import { splitTelegramMessage } from "./split-message";
import { TgMessageBuilder, type TgEntity, type TgMessage } from "./telegram-message";
import type { Activity } from "./current-state-enrich";
import type { SendNotificationInput, WorkerResult } from "./worker/poller";

/**
 * Upper bound on a plain-alert Telegram request. Deliberately short: the
 * callers await this on their critical paths (see `sendPlainAlert`), so the
 * cost of waiting is a stalled delivery loop, while the cost of giving up is
 * one lost operational alert that is already best-effort.
 */
const PLAIN_ALERT_TIMEOUT_MS = 10_000;

interface NotificationInput {
  event: string;
  label: string;
  summary: string;
  cwd: string | null;
  token: string;
  machineId?: string;
  sessionId: string;
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
  sendPlainAlert?(text: string, severity: AlertSeverity): Promise<void>;
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
  async sendPlainAlert(text: string, severity: AlertSeverity): Promise<void> {
    const prefix =
      severity === "error" ? "❌ " : severity === "warning" ? "⚠️ " : "";
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
            `Telegram sendMessage timed out after ${PLAIN_ALERT_TIMEOUT_MS}ms`,
          ),
        );
      }, PLAIN_ALERT_TIMEOUT_MS);
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
        }),
        signal: controller.signal,
      });
      inFlight.catch(() => {});
      response = await Promise.race([inFlight, deadline]);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(
          `Telegram sendMessage timed out after ${PLAIN_ALERT_TIMEOUT_MS}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`Telegram sendMessage returned ${response.status}`);
    }
  }
}
