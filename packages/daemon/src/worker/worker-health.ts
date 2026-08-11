/**
 * Daemon-side alarm for a worker that has stopped accepting our writes.
 *
 * WHY THIS EXISTS (pigeon-n4v, follow-up to pigeon-dul). On 2026-07-14 22:50 the worker
 * began failing `/sessions/register` and `/notifications/send` and did not recover until
 * roughly 05:00. It self-healed with no restart, and nobody noticed for more than sixteen
 * days — by which time Workers Logs had aged out and the incident could no longer be
 * diagnosed at all. Nothing in the daemon observes the OUTCOME of its worker calls: the
 * outbox retries a failure forever without ever asking whether every send is failing.
 *
 * The shape of that outage constrains the design more than it first appears:
 *
 *  - `GET /machines/:id/next` polling stayed HEALTHY throughout. Any counter that a
 *    healthy poll resets would have stayed silent through the whole six hours.
 *  - The failure was per-route. A counter shared between register and send, cleared by
 *    either, has the same defect at smaller scale.
 *
 * Hence: one independent episode per (endpoint, failure class), cleared only by a success
 * on that same endpoint.
 *
 * DELIVERY. The alert leaves via `AlertRepository` -> `AlertDrainer` ->
 * `StopNotifier.sendPlainAlert`, which POSTs directly to api.telegram.org
 * (notification-service.ts:386) and does NOT traverse the worker. That is what makes this
 * alarm meaningful: it can still get out while the thing it is reporting on is broken.
 * Everything else the daemon sends to Telegram goes through the worker and would be stuck
 * behind the very outage being reported.
 *
 * WHAT THIS DOES NOT COVER. The counters observe CALLS, so they measure "our writes to the
 * worker are failing", not "the worker is down". An idle machine making no calls produces
 * no signal — though it is also losing nothing at the time. A traffic-independent probe
 * (consecutive `poll()` failures, which run every 5s regardless) is the natural complement
 * and is deliberately left to a follow-up.
 */

import type { WorkerResult } from "./poller";
import { getTelegramErrorCode } from "./delivery-policy";

export type WorkerEndpoint = "register" | "send";

/** What a single worker call tells us about worker health. */
export type WorkerHealthSample = "success" | "server_error" | "transport" | "neutral";

/** The two failure classes tracked as independent episodes. */
export type WorkerFailureClass = "server_error" | "transport";

export const SERVER_ERROR_THRESHOLD = 5;
export const SERVER_ERROR_MIN_SPAN_MS = 60_000;

/**
 * Transport failures get the same count but a much stiffer time floor. A 5xx is a
 * deliberate answer from a worker that is running; a thrown fetch is anything from a real
 * outage to the laptop's wifi dropping for a moment, and the latter is common enough that
 * a one-minute floor would page for it.
 */
export const TRANSPORT_THRESHOLD = 5;
export const TRANSPORT_MIN_SPAN_MS = 300_000;

const ENDPOINT_LABEL: Record<WorkerEndpoint, string> = {
  register: "/sessions/register",
  send: "/notifications/send",
};

/**
 * Ref namespaces. `AlertRepository`'s unique index is on `ref_msg_id` ALONE, so every new
 * alert class must carve out its own key space or it can silently swallow another class's
 * alert (see the header comment in storage/alert-repo.ts). ':' is rejected in
 * caller-supplied swarm msg_ids at the API boundary, which is what makes this structural
 * rather than a convention.
 */
const REF_PREFIX: Record<WorkerFailureClass, { open: string; recovered: string }> = {
  server_error: { open: "worker5xx", recovered: "worker5xxok" },
  transport: { open: "workerxport", recovered: "workerxportok" },
};

const THRESHOLD: Record<WorkerFailureClass, number> = {
  server_error: SERVER_ERROR_THRESHOLD,
  transport: TRANSPORT_THRESHOLD,
};

const MIN_SPAN_MS: Record<WorkerFailureClass, number> = {
  server_error: SERVER_ERROR_MIN_SPAN_MS,
  transport: TRANSPORT_MIN_SPAN_MS,
};

/**
 * Classifies one worker call.
 *
 * Only a genuine 2xx clears an episode, and only a 5xx (or a thrown fetch) extends one.
 * Everything else is NEUTRAL — deliberately, and the asymmetry is the point:
 *
 *  - A 4xx proves the worker is answering, but says nothing about whether the condition
 *    that produced the 5xx has cleared. Treating it as a clear would let a stream of 404s
 *    from a reaped session mask a live outage.
 *  - `app_rejection` (HTTP 2xx carrying `ok:false`) is ambiguous by construction and is
 *    not currently reachable on either route.
 *  - A 502 relaying a Telegram 400 — and ONLY 400 — is Telegram's verdict on our message,
 *    not the worker failing. This one is load-bearing rather than fastidious: a 5xx never
 *    charges an outbox entry an attempt (`isTransportFailure`), so a message Telegram
 *    keeps rejecting retries until the age cap. After `strip_entities` fires once the
 *    payload no longer has entities, so rule 6 stops matching and every subsequent
 *    rejection lands on the generic retry arm as a bare 502. Counting those would let ONE
 *    poisoned message raise an alert naming the wrong component while the worker is
 *    perfectly healthy.
 *
 * The exclusion stops at 400 deliberately. The worker relays EVERY Telegram error as a 502
 * carrying that code (`getTelegramErrorDetails` in worker/telegram.ts), so excluding the
 * whole 4xx range would also swallow 401 (bot token revoked, or a botched rotation) and
 * 403 (bot removed from the group). Those are verdicts on the DEPLOYMENT rather than on one
 * message: they fail every send until a human intervenes, which is exactly the sustained
 * total failure this alarm exists to record. The alert text will name the worker when the
 * true culprit is the token, but a misattributed alert beats six hours of silence.
 *
 * A 502 relaying a Telegram 5xx, or carrying no Telegram error code at all, still counts:
 * those are the worker's own failures, or Telegram being down, and both are worth knowing.
 */
export function classifyWorkerHealthSample(result: WorkerResult): WorkerHealthSample {
  if (result.ok) {
    return "success";
  }
  if (result.kind === "transport_error") {
    return "transport";
  }
  if (result.kind === "http_error" && result.status >= 500) {
    if (getTelegramErrorCode(result.body) === 400) {
      return "neutral";
    }
    return "server_error";
  }
  return "neutral";
}

export function formatEpisodeDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

/** The slice of `AlertRepository` this needs. Narrow on purpose, so tests need no DB. */
export interface WorkerHealthAlertSink {
  enqueue(input: {
    source: string;
    refMsgId?: string | null;
    text: string;
    severity: "info" | "warning" | "error";
    now?: number;
  }): boolean;
}

export type WorkerHealthLogger = (msg: string, fields?: Record<string, unknown>) => void;

export interface WorkerHealthMonitorOptions {
  alerts: WorkerHealthAlertSink;
  nowFn?: () => number;
  log?: WorkerHealthLogger;
}

interface Episode {
  startedAt: number;
  count: number;
  alerted: boolean;
  lastDetail: string;
}

/** What `Poller` needs to know about this. Keeps the poller free of alert-repo types. */
export interface WorkerHealthObserver {
  record(endpoint: WorkerEndpoint, result: WorkerResult): void;
}

export class WorkerHealthMonitor implements WorkerHealthObserver {
  private readonly alerts: WorkerHealthAlertSink;
  private readonly nowFn: () => number;
  private readonly log?: WorkerHealthLogger;

  /**
   * Episode state is IN-MEMORY, and that is a considered choice rather than a shortcut.
   * A daemon restart mid-outage costs one thing only: the counter restarts, and since the
   * outbox rows are durable and retry within seconds of boot, the alarm re-trips a couple
   * of minutes later under a new episode key. The failure mode a durable table would
   * protect against — a crash loop faster than the time floor — is one where polling,
   * swarm and delivery are all dead too, which is a supervisor's problem and not this
   * alarm's. `AlertDrainer.sentIds` makes the same trade for the same reason.
   *
   * Bounded by construction: at most one entry per (endpoint, class), so four.
   */
  private readonly episodes = new Map<string, Episode>();

  constructor(opts: WorkerHealthMonitorOptions) {
    this.alerts = opts.alerts;
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.log = opts.log;
  }

  record(endpoint: WorkerEndpoint, result: WorkerResult): void {
    // This sits on the daemon's delivery path. An alarm that can break the thing it
    // watches is worse than no alarm, so nothing in here may escape to the caller.
    try {
      const sample = classifyWorkerHealthSample(result);
      const now = this.nowFn();

      if (sample === "success") {
        this.clear("server_error", endpoint, now);
        this.clear("transport", endpoint, now);
        return;
      }
      if (sample === "neutral") {
        // A 5xx we decline to count is the one case where the alarm stays deliberately
        // quiet, so it is also the one case that would otherwise leave no trace at all.
        // Leave a journal line: "no durable record" is what made the outage that motivated
        // this alarm undiagnosable. Plain 4xx are ordinary traffic and stay silent.
        if (result.kind === "http_error" && result.status >= 500) {
          this.log?.("worker 5xx not counted toward the alarm", {
            endpoint,
            status: result.status,
            telegramErrorCode: getTelegramErrorCode(result.body),
          });
        }
        return;
      }
      this.extend(sample, endpoint, result, now);
    } catch (err) {
      this.log?.("worker health monitor error", {
        endpoint,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private key(cls: WorkerFailureClass, endpoint: WorkerEndpoint): string {
    return `${cls}:${endpoint}`;
  }

  private extend(
    cls: WorkerFailureClass,
    endpoint: WorkerEndpoint,
    result: WorkerResult,
    now: number,
  ): void {
    const key = this.key(cls, endpoint);
    const existing = this.episodes.get(key);
    const episode: Episode = existing ?? {
      startedAt: now,
      count: 0,
      alerted: false,
      lastDetail: "",
    };
    episode.count += 1;
    episode.lastDetail = describeFailure(result);
    this.episodes.set(key, episode);

    if (episode.alerted) return;
    if (episode.count < THRESHOLD[cls]) return;
    if (now - episode.startedAt < MIN_SPAN_MS[cls]) return;

    episode.alerted = true;

    const label = ENDPOINT_LABEL[endpoint];
    const span = formatEpisodeDuration(now - episode.startedAt);
    // The consequence differs by route, and saying the wrong one sends an operator looking
    // in the wrong place: a register-only episode leaves delivery working for existing
    // sessions while new ones silently fail to route.
    const consequence =
      endpoint === "send"
        ? "Telegram delivery through the worker is down; the daemon outbox is holding and retrying."
        : "New sessions cannot register with the worker, so their notifications will 404 until this clears.";
    const text =
      cls === "server_error"
        ? `Worker ${label} is failing: ${episode.count} consecutive 5xx over ${span} ` +
          `(latest ${episode.lastDetail}). ${consequence}`
        : `Worker ${label} is unreachable: ${episode.count} consecutive transport failures over ${span} ` +
          `(latest ${episode.lastDetail}). ${consequence}`;

    // Logged unconditionally, and BEFORE the enqueue. On a host with no plain-alert
    // notifier the alert row is never delivered, and the journal is then the only record
    // that this happened at all — which is precisely the gap that left the 2026-07-14
    // outage undiagnosable.
    this.log?.("worker health alarm tripped", {
      endpoint,
      class: cls,
      count: episode.count,
      spanMs: now - episode.startedAt,
      detail: episode.lastDetail,
    });

    this.alerts.enqueue({
      source: "worker-health",
      refMsgId: `${REF_PREFIX[cls].open}:${endpoint}:${episode.startedAt}`,
      text,
      severity: "error",
      now,
    });
  }

  private clear(cls: WorkerFailureClass, endpoint: WorkerEndpoint, now: number): void {
    const key = this.key(cls, endpoint);
    const episode = this.episodes.get(key);
    if (!episode) return;
    this.episodes.delete(key);
    if (!episode.alerted) return;

    const label = ENDPOINT_LABEL[endpoint];
    const span = formatEpisodeDuration(now - episode.startedAt);
    const what = cls === "server_error" ? "5xx" : "transport";

    this.log?.("worker health alarm recovered", {
      endpoint,
      class: cls,
      count: episode.count,
      spanMs: now - episode.startedAt,
    });

    // "recovered by", not "recovered at": this fires on the first SUCCESSFUL call after
    // the episode, and calls are traffic-driven. If the machine went quiet the worker may
    // have healed long before we noticed, so the timestamp bounds the recovery rather than
    // dating it.
    this.alerts.enqueue({
      source: "worker-health",
      refMsgId: `${REF_PREFIX[cls].recovered}:${endpoint}:${episode.startedAt}`,
      text:
        `Worker ${label} recovered — ${what} episode ran at least ${span} across ` +
        `${episode.count} consecutive failures. Detected on the first successful call, so ` +
        `it may have healed earlier if the machine was quiet.`,
      severity: "info",
      now,
    });
  }
}

function describeFailure(result: WorkerResult): string {
  if (result.kind === "transport_error") {
    return result.error;
  }
  if (result.kind === "http_error" || result.kind === "app_rejection") {
    const code = getTelegramErrorCode(result.body);
    return code !== undefined
      ? `status=${result.status} telegram_error_code=${code}`
      : `status=${result.status}`;
  }
  return "unknown";
}
