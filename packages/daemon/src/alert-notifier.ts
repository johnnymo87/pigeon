/**
 * Operational-alert delivery: worker first, direct fallback (chat-transport phase 1,
 * pigeon-lenr; design docs/plans/2026-11-20-telegram-single-egress-design.md, "Daemon PR").
 *
 * WHY NOT JUST THE WORKER. These alerts include the alarms that report a broken worker
 * (worker-health.ts, pigeon-n4v: the 2026-07-14 outage went unnoticed for sixteen days).
 * Routing them only through the worker would silence the alarm built to report it. So the
 * worker leg goes first, and when the WORKER fails (not when Telegram says no) the alert is
 * re-sent through `DirectTelegramAlarm`, the daemon's one remaining direct Bot API caller.
 *
 * THE FALLBACK IS VISIBLE, twice over: the alert itself carries
 * `· sent direct; worker: <reason>`, and a throttled health alert ("alerts are bypassing the
 * worker") is recorded, so a broken worker is reported even while every alert still lands.
 *
 * Three behaviours per worker answer (`WorkerSendOutcome`): sent -> done; Telegram said no
 * (400/429 relayed in a 200) -> throw `TelegramSendError`, NO fallback, because the direct
 * path would get the same verdict and the `/alert` ladder (app.ts) keys on the 400; worker
 * failed -> fall back.
 *
 * DUPLICATES, accepted on purpose. A worker leg that times out AFTER the worker posted, then
 * a direct post, gives two copies; and `AlertDrainer` retries a thrown error, so a failure
 * after a successful post can compound that. For an operational alert a duplicate beats
 * silence. The worker leg's 5s cap sits above the worker's own ~4s Telegram abort precisely
 * to make that race rare: a slow Telegram yields a definite 502 before our timer fires.
 */

import {
  PLAIN_ALERT_TIMEOUT_MS,
  TelegramSendError,
  type AlertSeverity,
  type PlainAlertOptions,
  type StopNotifier,
} from "./notification-service";
import { severityPrefix, type DirectTelegramAlarm } from "./direct-telegram-alarm";
import type { WorkerMessageClient, WorkerSendOutcome } from "./worker/worker-message-client";
import type { WorkerHealthAlertSink } from "./worker/worker-health";

/** Worker-leg cap when a direct path exists. Above the worker's ~4s Telegram abort. */
export const WORKER_LEG_MS = 5_000;
/** Below this much budget, a host with a direct path skips the worker. */
export const DIRECT_ONLY_BELOW_MS = 2_000;
/** Time always kept back for the direct leg when the worker leg runs first. */
export const DIRECT_RESERVE_MS = 1_000;
/** One fallback health alert per failure kind per this window. */
export const FALLBACK_ALERT_THROTTLE_MS = 60 * 60 * 1000;
/** Telegram's sendMessage text limit. Counted in UTF-16 units, which never undercounts. */
export const TELEGRAM_MAX_TEXT = 4096;
const MAX_REASON_CHARS = 200;

export type AlertDeliveryMode = "worker+direct-fallback" | "worker-only" | "direct-only" | "UNAVAILABLE";

export function describeAlertDelivery(has: { worker: boolean; direct: boolean }): AlertDeliveryMode {
  if (has.worker && has.direct) return "worker+direct-fallback";
  if (has.worker) return "worker-only";
  if (has.direct) return "direct-only";
  return "UNAVAILABLE";
}

export interface AlertNotifierDeps {
  chatId: string;
  worker?: Pick<WorkerMessageClient, "sendMessage" | "unpinTopic">;
  direct?: Pick<DirectTelegramAlarm, "sendPlainAlert">;
  /** Where the throttled "alerts are bypassing the worker" alert is recorded. */
  alerts?: WorkerHealthAlertSink;
  machineId?: string;
  /** Wall clock, for both budgets and the throttle. */
  nowFn?: () => number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/** Undefined when the host has neither path, so callers keep their "no notifier" branch. */
export function createAlertNotifier(deps: AlertNotifierDeps): StopNotifier | undefined {
  if (!deps.worker && !deps.direct) return undefined;
  const n = new AlertNotifier(deps);
  const out: StopNotifier = {
    sendPlainAlert: (text, severity, options) => n.sendPlainAlert(text, severity, options),
  };
  // Worker only, best-effort, no fallback: a missed unpin is cosmetic.
  if (deps.worker) out.unpinTopic = (threadId) => n.unpinTopic(threadId);
  return out;
}

class AlertNotifier {
  private readonly nowFn: () => number;
  /**
   * Fallback-alert throttle, checked BEFORE enqueueing. In memory on purpose: it must hold
   * when the alert being sent is itself the fallback alert (otherwise draining it through
   * the same broken worker would enqueue another, forever), and on worker-only hosts. The
   * ref is also hour-bucketed, so a restart inside the window is deduped by the alert table
   * as long as the row is still there.
   */
  private readonly lastFallbackAlertAt = new Map<string, number>();
  /**
   * Worker-only hosts: the health alert can only be delivered by the very worker that is
   * failing, so an hourly re-alert would just pile up undeliverable rows that drain as a
   * stale burst on recovery. One per outage instead, re-armed by the next successful send.
   */
  private workerOnlyOutageReported = false;

  constructor(private readonly deps: AlertNotifierDeps) {
    this.nowFn = deps.nowFn ?? (() => Date.now());
  }

  async sendPlainAlert(text: string, severity: AlertSeverity, options?: PlainAlertOptions): Promise<void> {
    const { worker, direct } = this.deps;
    const total = options?.timeoutMs ?? PLAIN_ALERT_TIMEOUT_MS;
    const startedAt = this.nowFn();

    if (!worker) {
      // Direct-only host (no worker URL): nothing is broken, so no suffix.
      return direct!.sendPlainAlert(text, severity, options);
    }

    if (direct && total < DIRECT_ONLY_BELOW_MS) {
      return this.sendDirect(text, severity, options, total, `not tried (${total}ms budget)`);
    }

    const workerBudget = direct ? Math.min(WORKER_LEG_MS, total - DIRECT_RESERVE_MS) : total;
    const outcome = await worker.sendMessage(
      {
        chatId: this.deps.chatId,
        text: `${severityPrefix(severity)}${text}`,
        ...(options?.messageThreadId !== undefined ? { messageThreadId: options.messageThreadId } : {}),
        ...(options?.replyMarkup ? { urlButtons: options.replyMarkup.inline_keyboard } : {}),
        // Keep the worker's Telegram abort under our own cap, so a slow Telegram is a
        // definite 502 rather than our timer racing an in-flight post. At the full cap the
        // worker's default (~4s) already is.
        ...(workerBudget < WORKER_LEG_MS ? { timeoutMs: Math.max(500, workerBudget - 1_000) } : {}),
      },
      { timeoutMs: workerBudget },
    );

    if (outcome.kind === "sent") {
      this.workerOnlyOutageReported = false;
      return;
    }
    if (outcome.kind === "telegram_rejected") {
      throw new TelegramSendError(
        outcome.status,
        `Telegram sendMessage returned ${outcome.status} (via worker)`,
        outcome.description,
      );
    }

    this.deps.log?.("worker /messages/send failed for an alert", {
      reason: outcome.reason,
      fallback: direct ? "direct" : "none",
    });
    // A timeout under a starved budget (an /alert ladder rung late in its 10s) proves
    // nothing about the worker: it may simply not have had time. A definite answer still
    // counts, however short the budget.
    const starved = workerBudget < WORKER_LEG_MS;
    const indefinite = outcome.key === "timeout" || outcome.cause === "telegram_unreachable";
    if (!(starved && indefinite)) this.noteWorkerFailure(outcome, Boolean(direct));
    if (!direct) {
      throw new Error(`worker /messages/send failed: ${outcome.reason}`);
    }
    const left = Math.max(DIRECT_RESERVE_MS, total - (this.nowFn() - startedAt));
    return this.sendDirect(text, severity, options, left, outcome.reason);
  }

  async unpinTopic(messageThreadId: number): Promise<void> {
    await this.deps.worker!.unpinTopic(
      { chatId: this.deps.chatId, messageThreadId },
      { timeoutMs: PLAIN_ALERT_TIMEOUT_MS },
    );
  }

  private sendDirect(
    text: string,
    severity: AlertSeverity,
    options: PlainAlertOptions | undefined,
    timeoutMs: number,
    reason: string,
  ): Promise<void> {
    const r = reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS - 1)}…` : reason;
    const suffix = ` · sent direct; worker: ${r}`;
    const room = TELEGRAM_MAX_TEXT - severityPrefix(severity).length - suffix.length;
    return this.deps.direct!.sendPlainAlert(`${truncate(text, room)}${suffix}`, severity, {
      ...options,
      timeoutMs,
    });
  }

  private noteWorkerFailure(outcome: Extract<WorkerSendOutcome, { kind: "worker_failed" }>, hasDirect: boolean): void {
    try {
      const now = this.nowFn();
      if (!hasDirect) {
        if (this.workerOnlyOutageReported) return;
        this.workerOnlyOutageReported = true;
      }
      const last = this.lastFallbackAlertAt.get(outcome.key);
      if (last !== undefined && now - last < FALLBACK_ALERT_THROTTLE_MS) return;
      this.lastFallbackAlertAt.set(outcome.key, now);
      if (!this.deps.alerts) return;
      const where = this.deps.machineId ? ` on ${this.deps.machineId}` : "";
      const text = !hasDirect
        ? `Worker POST /messages/send failed${where} (${outcome.reason}) and this host has no direct ` +
          `Telegram path, so operational alerts and slash-command replies were not getting out. ` +
          `Reported once per outage.`
        : outcome.cause === "telegram_unreachable"
          ? `The worker could not get a reply from Telegram in time for an alert${where} ` +
            `(${outcome.reason}), so it was re-sent direct and may appear twice. The worker itself ` +
            `is probably fine; slash-command replies wait longer and are probably landing. ` +
            `Reported at most once an hour per kind of failure.`
          : `Alerts${where} are bypassing the worker: POST /messages/send failed (${outcome.reason}), ` +
            `so operational alerts are being sent direct to Telegram. Slash-command replies have no ` +
            `fallback and are probably being lost. Reported at most once an hour per kind of failure.`;
      this.deps.alerts.enqueue({
        source: "worker-health-fallback",
        refMsgId: `workerdirect:${outcome.key}:${Math.floor(now / FALLBACK_ALERT_THROTTLE_MS)}`,
        text,
        severity: "error",
        now,
      });
    } catch (err) {
      // A monitor must not break the send it is watching.
      this.deps.log?.("fallback alert enqueue failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Cuts to at most `max` UTF-16 units including the ellipsis, never splitting a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}
