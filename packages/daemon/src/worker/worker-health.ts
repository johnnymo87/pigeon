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
 *
 * Nor does it cover a PARTIAL failure, and that limit is easy to overestimate away. An
 * episode counts CONSECUTIVE failures and ANY success on that endpoint clears it, so a
 * fault that rejects only some payloads never accumulates the threshold as long as other
 * traffic keeps succeeding — while the affected subset is failing 100% of the time. Two
 * concrete shapes: worker field validation that fires only on entries carrying media or
 * entities, and a session cap that flaps as the reaper frees slots. Every notification kind
 * shares the one `send` counter (stop, question, swarm mirror, TUI mirror), so on an active
 * machine successes interleave constantly and a partial fault can stay invisible here
 * indefinitely. Catching that needs a failure RATE over a window, which is a genuinely
 * different alarm and is not attempted here. Tracked as pigeon-b6h4.
 */

import type { WorkerResult } from "./poller";
import { getTelegramErrorCode } from "./delivery-policy";

export type WorkerEndpoint = "register" | "send";

/** What a single worker call tells us about worker health. */
export type WorkerHealthSample =
  | "success"
  | "server_error"
  | "transport"
  | "client_error"
  | "neutral";

/** The failure classes tracked as independent episodes. */
export type WorkerFailureClass = "server_error" | "transport" | "client_error";

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

/**
 * Sustained 4xx (pigeon-5typ). Same count as the other classes, but the 5xx class's
 * 60s floor would be wrong here.
 *
 * The floor is doing different work for 4xx than for 5xx: it is not smoothing a flaky
 * signal, it is separating two SHAPES. A legitimately reaped session produces at most a
 * re-registration and one retry before delivery-policy drops the entry as terminal, so a
 * cleanup cluster drains within a tick or two of the 5s outbox loop. Sustaining 4xx across
 * five minutes requires doomed entries to keep ARRIVING, which cleanup does not do. And the
 * outage this exists to catch ran for six hours, so a stiff floor costs essentially nothing
 * in detection latency.
 *
 * Known gap, deliberately accepted rather than fixed: an entry whose 4xx is RETRIED
 * (a 403, or an exotic 4xx reaching delivery-policy's generic arm) is charged an attempt
 * each time, so one entry alone can emit up to MAX_ATTEMPTS=10 failures and trip this by
 * itself. Ten failures span NINE backoff gaps (5+10+30+60+120×5), so ~705s, and the trip
 * lands around 345s in. For a 403 that is correct — it is a worker-config verdict that
 * fails every send alike. For a hypothetical per-entry 4xx it would be a misattributed
 * alert, which this file already prefers over silence. If that ever bites, the structural
 * fix is a threshold above MAX_ATTEMPTS, which no single entry could reach; it is not used
 * today because it couples this constant to the outbox's.
 *
 * A sustained send-429 is slower to detect than the floor suggests, because rule 5 pauses
 * the whole outbox for up to MAX_PAUSE_MS (300s), so samples arrive about one per pause and
 * five of them can take ~20 minutes. That is acceptable on both counts: the pause suppresses
 * SUCCESS samples too, so the episode is never spuriously cleared mid-outage, and the
 * register-cap 429 that motivated this class carries no retryAfter (worker sessions.ts), so
 * it never takes the pause path and trips at full speed.
 */
export const CLIENT_ERROR_THRESHOLD = 5;
export const CLIENT_ERROR_MIN_SPAN_MS = 300_000;

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
  client_error: { open: "worker4xx", recovered: "worker4xxok" },
};

const THRESHOLD: Record<WorkerFailureClass, number> = {
  server_error: SERVER_ERROR_THRESHOLD,
  transport: TRANSPORT_THRESHOLD,
  client_error: CLIENT_ERROR_THRESHOLD,
};

/** Verb phrase describing what the worker is doing wrong, per class. */
const SYMPTOM: Record<WorkerFailureClass, string> = {
  server_error: "is failing",
  transport: "is unreachable",
  client_error: "is rejecting our writes",
};

/** What the episode counted, per class — reads after "N consecutive ...". */
const FAILURE_UNIT: Record<WorkerFailureClass, string> = {
  server_error: "5xx",
  transport: "transport failures",
  client_error: "4xx",
};

/**
 * Short noun for the recovery text — reads before "... episode ran at least". Kept separate
 * from FAILURE_UNIT because the grammatical slot differs: "5 consecutive transport
 * failures" but "transport episode".
 */
const EPISODE_NOUN: Record<WorkerFailureClass, string> = {
  server_error: "5xx",
  transport: "transport",
  client_error: "4xx",
};

/**
 * What an operator loses while this episode runs.
 *
 * The consequence differs by route, and saying the wrong one sends an operator looking in
 * the wrong place: a register-only episode leaves delivery working for existing sessions
 * while new ones silently fail to route.
 *
 * It also differs by CLASS, and getting that wrong is worse than vague. The 5xx wording
 * promises the outbox "is holding and retrying", which is true because a 5xx is never
 * charged an attempt. Telling an operator their messages are safely queued while they are
 * being discarded would be worse than telling them nothing.
 *
 * The 4xx wording deliberately refuses to make one blanket promise, because the 4xx range
 * does not behave uniformly and an early draft of this string got it wrong: it said "a 4xx
 * is charged to the outbox entry", which is false for a 429 — `isTransportFailure` counts
 * 429 as transient alongside the 5xx range, so it is never charged and pauses the outbox
 * instead of dropping anything. Rendering a real 429 alert is what exposed it. Per
 * delivery-policy: 400 terminal (rule 4), 404 terminal once re-registration is spent
 * (rule 2), 403 retried forever (rule 3), 429 pause (rule 5).
 */
function describeConsequence(endpoint: WorkerEndpoint, cls: WorkerFailureClass): string {
  if (endpoint === "register") {
    return "New sessions cannot register with the worker, so their notifications will 404 until this clears.";
  }
  if (cls === "client_error") {
    return (
      "Telegram delivery through the worker is failing. What happens to the queued entries " +
      "depends on the exact status, so read the one above before assuming anything is still " +
      "held: 400 is terminal at once and 404 is terminal once re-registration is spent, and " +
      "those entries are DROPPED rather than retried; 403 retries indefinitely; 429 pauses " +
      "the outbox."
    );
  }
  return "Telegram delivery through the worker is down; the daemon outbox is holding and retrying.";
}

const MIN_SPAN_MS: Record<WorkerFailureClass, number> = {
  server_error: SERVER_ERROR_MIN_SPAN_MS,
  transport: TRANSPORT_MIN_SPAN_MS,
  client_error: CLIENT_ERROR_MIN_SPAN_MS,
};

/**
 * Classifies one worker call.
 *
 * Only a genuine 2xx clears an episode. Three things extend one, each in its own class: a
 * 5xx, a thrown fetch, and — since pigeon-5typ — any 4xx.
 *
 * WHY 4xx COUNTS (this reverses the original design, so the original reasoning is kept).
 * A 4xx was called neutral on the grounds that it proves the worker is answering. That is
 * true and it is beside the point: a SUSTAINED 4xx on a write route is a total outage for
 * the affected function while the worker stays perfectly healthy. A 429 from the session
 * cap means no session can register; a 403 from `ALLOWED_CHAT_IDS` means every send is
 * refused and, per delivery-policy rule 3, retried forever. The 2026-07-14 outage in this
 * file's header was most likely exactly that shape, so the alarm written in response to it
 * would have stayed silent through it.
 *
 * The original insight survives intact, because it was really about CLEARING, not counting:
 * a 4xx still must not clear a 5xx episode, or a stream of 404s from a reaped session could
 * mask a live outage. Per-class episodes give that for free — a 4xx only ever extends the
 * 4xx episode, and only a success clears anything.
 *
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
 *
 * TWO DIFFERENT 400s, and only one is excluded. A Telegram 400 is excluded (above); a
 * WORKER 400 is counted. That is not an inconsistency, because the two arrive by different
 * routes and behave differently once they do:
 *
 *  - Telegram's 400 never reaches us as an HTTP 400 — it comes back as a 502 carrying
 *    `details.error_code`. Being a 5xx, `isTransportFailure` calls it transient, so it is
 *    never charged an outbox attempt and ONE poisoned message can retry until the age cap.
 *    That single entry could trip an alarm by itself, which is why it is carved out.
 *  - A worker 400 is field validation only, and delivery-policy rule 4 makes it TERMINAL:
 *    the entry dies after one attempt. Five consecutive 400s therefore mean five DISTINCT
 *    rejected entries, which is daemon/worker version skew — the worker now requires a
 *    field this daemon does not send. Deploys are per-machine for the daemon and central
 *    for the worker, so that skew is a designed-in condition of this system, and its
 *    symptom is every notification being dropped in silence. Nothing else alarms on it.
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
  // No per-status cases in the 4xx range, and that is the point: 401 from a rotated token,
  // 403 from ALLOWED_CHAT_IDS, 404 from a lost session row, 429 from the session cap, and
  // anything Cloudflare injects in front of the worker are all deployment-level conditions
  // that fail every call alike. Enumerating them would mean maintaining a list that a new
  // worker route or an intermediary could silently fall outside of.
  if (result.kind === "http_error" && result.status >= 400) {
    return "client_error";
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
   * Bounded by construction: at most one entry per (endpoint, class), so six.
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
        // Every class must be listed here. A missing one fails SILENTLY: its episode would
        // never clear, so it could never re-alert and would never emit a recovery.
        this.clear("server_error", endpoint, now);
        this.clear("transport", endpoint, now);
        this.clear("client_error", endpoint, now);
        return;
      }
      if (sample === "neutral") {
        // A 5xx we decline to count is the one case where the alarm stays deliberately
        // quiet, so it is also the one case that would otherwise leave no trace at all.
        // Leave a journal line: "no durable record" is what made the outage that motivated
        // this alarm undiagnosable. Since pigeon-5typ the samples reaching here are the
        // carved-out 502, the unreachable app_rejection, and an http_error below 400 —
        // an unfollowed 3xx, which `safeExecuteWorkerFetch` turns into an http_error like
        // any other non-ok response. That last one stays silent even here, since the guard
        // below is deliberately 5xx-only; it is remote enough not to be worth a line.
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
    const text =
      `Worker ${label} ${SYMPTOM[cls]}: ${episode.count} consecutive ${FAILURE_UNIT[cls]} ` +
      `over ${span} (latest ${episode.lastDetail}). ${describeConsequence(endpoint, cls)}`;

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
    const what = EPISODE_NOUN[cls];

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
