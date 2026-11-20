/**
 * The daemon's ONE direct line to the Telegram Bot API (chat-transport phase 1,
 * pigeon-lenr; design docs/plans/2026-11-20-telegram-single-egress-design.md).
 *
 * Everything else the daemon sends to Telegram goes through the worker. This exists because
 * the alarms that report a broken worker (worker-health.ts, pigeon-n4v) must still get out
 * while the worker is broken, so `AlertNotifier` uses it as the FALLBACK leg of an
 * operational alert, never as the first choice. It is the only file under `daemon/src`
 * allowed to contain the Bot API host; a guard test enforces that, so replacing Telegram
 * later means rewriting the worker's client plus this file.
 *
 * The send code is the former `TelegramNotificationService.sendPlainAlert`, moved verbatim.
 */

import {
  PLAIN_ALERT_TIMEOUT_MS,
  TelegramSendError,
  type AlertSeverity,
  type PlainAlertOptions,
} from "./notification-service";

export class DirectTelegramAlarm {
  private readonly apiBase: string;

  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly fetchFn: typeof fetch = fetch,
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
    const prefix = severityPrefix(severity);
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
}

/** The severity emoji both legs put in front of an alert, so they render identically. */
export function severityPrefix(severity: AlertSeverity): string {
  return severity === "error" ? "❌ " : severity === "warning" ? "⚠️ " : "";
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
