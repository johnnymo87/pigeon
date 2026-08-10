/**
 * OutboxSender — background loop that reads queued outbox entries and delivers
 * them to the worker (Telegram) via sendNotification.
 *
 * Runs on a 5s interval alongside the Poller. Implements retry with backoff
 * and terminal failure on max attempts or max age.
 */

import type { StorageDb } from "../storage/database";
import type { OutboxRecord } from "../storage/outbox-repo";
import { PENDING_QUESTION_TTL_MS, REPLY_TOKEN_TTL_MS } from "../storage/schema";
import type { SendNotificationInput, WorkerResult } from "./poller";
import {
  classifyDeliveryFailure,
  getTelegramErrorCode,
  getTelegramErrorDescription,
  isTransportFailure,
} from "./delivery-policy";
import type { DeliveryPolicyContext } from "./delivery-policy";

export type SendNotificationFn = (
  input: SendNotificationInput,
) => Promise<WorkerResult>;

export type RegisterSessionFn = (
  sessionId: string,
  label?: string,
) => Promise<WorkerResult>;

/**
 * Returns WorkerResult so the compensating-unregister path can tell whether the worker row was
 * really removed; `void` is still accepted so best-effort callers and existing test doubles work.
 */
export type UnregisterSessionFn = (sessionId: string) => Promise<WorkerResult | void>;

export type LogFn = (message: string, fields?: Record<string, unknown>) => void;

export interface OutboxSenderOptions {
  storage: StorageDb;
  sendNotification: SendNotificationFn;
  registerSession?: RegisterSessionFn;
  unregisterSession?: UnregisterSessionFn;
  chatId?: string;
  nowFn?: () => number;
  log?: LogFn;
}

/**
 * Maximum number of attempts allowed for deterministic per-message failures.
 * `attempts` now means "the transport was up and this message failed anyway"
 * (e.g. 403, 400, app_rejection, strip_entities), which is what makes exhausting
 * it a deterministic terminal rather than a budget one.
 * Transient transport failures (transport_error, 5xx, 429) do NOT increment attempts.
 */
const MAX_ATTEMPTS = 10;

const MIRROR_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Outbox expiry durations grounded in system affordance TTLs.
 * - question: PENDING_QUESTION_TTL_MS (4h) - pending question expires after 4h so reply can't route
 * - stop/card: REPLY_TOKEN_TTL_MS (24h) - reply token expires after 24h so reply can't route
 * - swarm: REPLY_TOKEN_TTL_MS (24h) - a stale swarm post still explains history
 * - mirror: MIRROR_TTL_MS (6h) - a stale prompt mirror has no value
 * - default: REPLY_TOKEN_TTL_MS (24h)
 */
const EXPIRY_BY_KIND: Record<string, number> = {
  question: PENDING_QUESTION_TTL_MS,
  stop: REPLY_TOKEN_TTL_MS,
  card: REPLY_TOKEN_TTL_MS,
  swarm: REPLY_TOKEN_TTL_MS,
  mirror: MIRROR_TTL_MS,
};

export function expiryForKind(kind: string): number {
  return EXPIRY_BY_KIND[kind] ?? REPLY_TOKEN_TTL_MS;
}

const BACKOFF_SCHEDULE = [5_000, 10_000, 30_000, 60_000, 120_000];

/**
 * Maximum duration (ms) to pause the outbox on a rate limit response (300s = 5m).
 * Bounded probe interval means we re-check reality rather than trusting an
 * arbitrarily large upstream retry_after value indefinitely.
 */
export const MAX_PAUSE_MS = 5 * 60 * 1000;

/**
 * Proactive rate governor limit: max sendNotification calls within 60 seconds.
 * Telegram supergroups cap bot messages at ~20/min shared globally across all producers
 * (outbox stop/question notifications, wizard edits, webhook acks, media, topic management).
 * Setting this to 12 leaves ~8 messages/min headroom for other producers.
 */
export const OUTBOX_RATE_LIMIT = 12;
export const OUTBOX_RATE_WINDOW_MS = 60_000;

export function formatWorkerError(result: WorkerResult): string {
  if (result.kind === "transport_error") {
    return result.error;
  }
  if (result.kind === "http_error" || result.kind === "app_rejection") {
    const bodyStr = result.body !== undefined ? ` - ${typeof result.body === "string" ? result.body : JSON.stringify(result.body)}` : "";
    return `HTTP ${result.status}${bodyStr}`;
  }
  return "Unknown error";
}

function getBackoff(retryCount: number): number {
  return BACKOFF_SCHEDULE[Math.min(retryCount, BACKOFF_SCHEDULE.length - 1)] ?? BACKOFF_SCHEDULE[BACKOFF_SCHEDULE.length - 1] ?? 120_000;
}

/**
 * Per-chunk idempotency key. The LAST chunk keeps the bare notificationId
 * because handleEditNotification (the multi-question wizard) looks messages up
 * by exactly that id, and it is the chunk that carries reply_markup.
 * Earlier chunks get a "#c{i}" suffix so worker-side dedup can suppress them
 * on retry. See webhook.ts question-id parsing, which strips this suffix.
 */
export function chunkNotificationId(
  notificationId: string | undefined,
  index: number,
  isLast: boolean,
): string | undefined {
  if (!notificationId) return undefined;
  return isLast ? notificationId : `${notificationId}#c${index}`;
}

export class OutboxSender {
  private readonly storage: StorageDb;
  private readonly sendNotification: SendNotificationFn;
  private readonly registerSession: RegisterSessionFn | undefined;
  private readonly unregisterSession: UnregisterSessionFn | undefined;
  private readonly chatId: string | undefined;
  private readonly nowFn: () => number;
  private readonly log: LogFn;

  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  /**
   * Timestamp (ms) until which outbox delivery is paused due to rate limiting.
   * Kept in-memory: if daemon restarts mid-pause, state is self-healing as the
   * next delivery attempt will receive another 429 and re-establish pausedUntil.
   */
  private pausedUntil = 0;

  /**
   * Timestamps (ms) of sendNotification calls within the rate governor sliding window.
   */
  private sendTimestamps: number[] = [];

  /**
   * Set of notificationIds that have already attempted re-registration.
   * Prevents repeated re-registration loops for the same outbox entry.
   */
  private reregisteredEntries = new Set<string>();

  constructor(opts: OutboxSenderOptions) {
    this.storage = opts.storage;
    this.sendNotification = opts.sendNotification;
    this.registerSession = opts.registerSession;
    this.unregisterSession = opts.unregisterSession;
    this.chatId = opts.chatId;
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.log = opts.log ?? ((msg, fields) => {
      if (fields) {
        console.log(`[outbox-sender] ${msg}`, fields);
      } else {
        console.log(`[outbox-sender] ${msg}`);
      }
    });
  }

  /** Mark an outbox entry failed terminally, clean up, and log uniform outbox terminal drop. */
  private markTerminal(
    entry: OutboxRecord,
    now: number,
    reason: string,
    lastError?: string,
    extraFields?: Record<string, unknown>,
  ): void {
    this.storage.outbox.markFailed(entry.notificationId, now, reason, lastError);
    this.reregisteredEntries.delete(entry.notificationId);
    const ageMs = now - entry.createdAt;
    this.log("outbox terminal drop", {
      notificationId: entry.notificationId,
      sessionId: entry.sessionId,
      kind: entry.kind,
      reason,
      attempts: entry.attempts,
      ageMs,
      ...(lastError ? { lastError } : {}),
      ...extraFields,
    });
  }

  /** Start the background delivery loop. */
  start(intervalMs = 5_000): void {
    this.timer = setInterval(() => {
      void this.processOnce();
    }, intervalMs);
  }

  /** Stop the background delivery loop. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Process one batch of ready outbox entries. Public for testing. */
  async processOnce(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;

    try {
      if (!this.chatId) {
        return;
      }

      const now = this.nowFn();
      if (this.pausedUntil > 0) {
        if (now < this.pausedUntil) {
          return;
        }
        this.log("outbox rate-limit pause ended, resuming delivery", {
          now,
          wasPausedUntil: this.pausedUntil,
        });
        this.pausedUntil = 0;
      }

      const entries = this.storage.outbox.getReady(now, 5);

      batchLoop: for (const entry of entries) {
        const now = this.nowFn();

        // Prune send timestamps older than 60 seconds
        const windowStart = now - OUTBOX_RATE_WINDOW_MS;
        this.sendTimestamps = this.sendTimestamps.filter((t) => t > windowStart);

        // Proactive rate governor check before starting an entry.
        // Checking per-entry (rather than between chunks) prevents torn messages where chunk 1 is sent
        // but chunks 2-3 are deferred. An entry with multiple chunks may overshoot the limit slightly,
        // which is an intended trade-off and why OUTBOX_RATE_LIMIT sits well below the Telegram group cap (20/min).
        if (this.sendTimestamps.length >= OUTBOX_RATE_LIMIT) {
          this.log("outbox rate governor limit reached, deferring remaining entries", {
            countInWindow: this.sendTimestamps.length,
            limit: OUTBOX_RATE_LIMIT,
          });
          break batchLoop;
        }

        const age = now - entry.createdAt;
        const expiryMs = expiryForKind(entry.kind);

        // Check terminal conditions
        if (entry.attempts >= MAX_ATTEMPTS) {
          this.markTerminal(entry, now, "attempts_exhausted");
          continue;
        }

        if (age > expiryMs) {
          this.markTerminal(entry, now, "expired", undefined, { expiryMs });
          continue;
        }

        // Parse payload
        let messages: Array<{ text: string; entities?: unknown[] }>;
        let replyMarkup: unknown;
        let notificationId: string | undefined;
        let title: string | undefined;
        let dir: string | undefined;
        let threaded: boolean | undefined;
        try {
          const parsed = JSON.parse(entry.payload) as {
            messages?: Array<{ text: string; entities?: unknown[] }>;
            message?: { text: string; entities?: unknown[] };
            replyMarkup: unknown;
            notificationId?: string;
            title?: string;
            dir?: string;
            threaded?: boolean;
          };
          messages = parsed.messages ?? (parsed.message ? [parsed.message] : []);
          replyMarkup = parsed.replyMarkup;
          notificationId = parsed.notificationId;
          title = parsed.title;
          dir = parsed.dir;
          threaded = parsed.threaded;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.markTerminal(entry, now, "payload_parse_failed", errMsg);
          continue;
        }

        if (messages.length === 0) {
          this.markTerminal(entry, now, "payload_empty");
          continue;
        }

        // Attempt delivery — send each chunk
        try {
          let allOk = true;
          for (let i = 0; i < messages.length; i++) {
            const isLast = i === messages.length - 1;
            const msg = messages[i]!;
            this.sendTimestamps.push(this.nowFn());
            const result = await this.sendNotification({
              sessionId: entry.sessionId,
              chatId: this.chatId,
              text: msg.text,
              replyMarkup: isLast ? replyMarkup : { inline_keyboard: [] },
              notificationId: chunkNotificationId(notificationId, i, isLast),
              entities: msg.entities,
              title,
              dir,
              threaded,
            });

            if (!result.ok) {
              allOk = false;
              const localSession = this.storage.sessions.get(entry.sessionId);
              const hasLocalSession = localSession !== null;
              const alreadyReregistered = this.reregisteredEntries.has(entry.notificationId);
              const payloadHasEntities = messages.some(
                (m) => Array.isArray(m.entities) && m.entities.length > 0,
              );

              const ctx: DeliveryPolicyContext = {
                hasLocalSession,
                alreadyReregistered,
                payloadHasEntities,
                attempts: entry.attempts,
              };

              const action = classifyDeliveryFailure(result, ctx);

              if (action.action === "pause") {
                const backoff = getBackoff(entry.retryCount);
                const countAttempt = !isTransportFailure(result);
                this.storage.outbox.markRetry(entry.notificationId, now, backoff, formatWorkerError(result), countAttempt);
                this.log("outbox entry delivery failed, scheduling retry", {
                  notificationId: entry.notificationId,
                  sessionId: entry.sessionId,
                  attempts: entry.attempts + (countAttempt ? 1 : 0),
                  nextRetryIn: backoff,
                  kind: result.kind,
                  ...(result.kind === "http_error" || result.kind === "app_rejection" ? { status: result.status, body: result.body } : {}),
                  ...(result.kind === "transport_error" ? { error: result.error } : {}),
                });
                const pauseMs = Math.min(action.retryAfterSec * 1000, MAX_PAUSE_MS);
                this.pausedUntil = now + pauseMs;
                this.log("outbox paused due to rate limit", {
                  notificationId: entry.notificationId,
                  retryAfterSec: action.retryAfterSec,
                  pauseMs,
                  pausedUntil: this.pausedUntil,
                });
                break batchLoop;
              }

              if (action.action === "terminal") {
                this.markTerminal(entry, now, action.reason, formatWorkerError(result));
                break;
              }

              if (action.action === "reregister") {
                if (!this.registerSession) {
                  const backoff = getBackoff(entry.retryCount);
                  const countAttempt = !isTransportFailure(result);
                  this.storage.outbox.markRetry(entry.notificationId, now, backoff, formatWorkerError(result), countAttempt);
                  this.log("outbox entry delivery failed, scheduling retry (reregister unavailable)", {
                    notificationId: entry.notificationId,
                    sessionId: entry.sessionId,
                    attempts: entry.attempts + (countAttempt ? 1 : 0),
                    nextRetryIn: backoff,
                    kind: result.kind,
                  });
                  break;
                }

                const regResult = await this.registerSession(entry.sessionId, localSession?.label ?? undefined);
                if (regResult.ok) {
                  const recheck = this.storage.sessions.get(entry.sessionId);
                  if (recheck === null) {
                    // The reaper deleted the local row between our check and the register, so we
                    // have just resurrected a session it deliberately unregistered. Compensate.
                    // Nothing else can: the reaper only unregisters sessions it still holds
                    // locally, and the worker has no session TTL cron, so a failure here leaks
                    // this row forever. Surface it loudly rather than swallowing it.
                    let compensated: boolean | undefined;
                    if (this.unregisterSession) {
                      const unregResult = await this.unregisterSession(entry.sessionId);
                      compensated = unregResult?.ok ?? undefined;
                    }
                    this.markTerminal(entry, now, "reregister_compensated", undefined, {
                      compensated: compensated ?? false,
                    });
                    if (compensated === false) {
                      this.log("LEAKED worker session row: compensating unregister failed, nothing else will remove it", {
                        sessionId: entry.sessionId,
                        notificationId: entry.notificationId,
                      });
                    }
                    break;
                  }

                  this.reregisteredEntries.add(entry.notificationId);
                  const backoff = getBackoff(entry.retryCount);
                  const countAttempt = !isTransportFailure(result);
                  this.storage.outbox.markRetry(entry.notificationId, now, backoff, undefined, countAttempt);
                  this.log("outbox entry re-registered, scheduling retry", {
                    notificationId: entry.notificationId,
                    sessionId: entry.sessionId,
                    attempts: entry.attempts + (countAttempt ? 1 : 0),
                    nextRetryIn: backoff,
                  });
                  break;
                } else {
                  // Terminal ONLY on a DEFINITIVE 4xx. Everything ambiguous retries.
                  //
                  // This asymmetry is deliberate and is the whole point of the cycle that
                  // introduced it: the failure mode being designed against is losing a message
                  // FASTER than the old blind-retry loop did. A wrong "retry" costs a few
                  // attempts out of a bounded budget; a wrong "terminal" is permanent data loss.
                  //
                  // - transport_error / 5xx: the worker is briefly down. This is exactly the
                  //   2026-07-15 incident (bead pigeon-6be), which self-healed about two hours
                  //   later with no restart. Terminal here would lose the message precisely when
                  //   a plain retry would have saved it.
                  // - app_rejection is HTTP 2xx carrying ok:false. POST /sessions/register cannot
                  //   currently produce it (packages/worker/src/sessions.ts returns 400, 429, or
                  //   200 ok:true), so this arm is unreachable today. It is written as retryable
                  //   anyway: "2xx but not ok" is inherently ambiguous, and if the worker ever
                  //   starts reporting a transient D1 failure that way, the safe default must
                  //   already be in place. Do not "simplify" this to terminal.
                  // - 429 "Session limit reached" (sessions.ts:69) is a CAPACITY condition that
                  //   clears as other sessions are unregistered, not a property of this message.
                  //   It also carries no retryAfter, so it must never reach the pause path.
                  //   Retrying is bounded by the normal attempt budget, so the cost of being
                  //   wrong is a few attempts; the cost of terminal is the message.
                  const isTransient =
                    regResult.kind === "transport_error" ||
                    regResult.kind === "app_rejection" ||
                    (regResult.kind === "http_error" &&
                      (regResult.status >= 500 || regResult.status === 429));

                  if (isTransient) {
                    const backoff = getBackoff(entry.retryCount);
                    const countAttempt = !isTransportFailure(regResult);
                    this.storage.outbox.markRetry(entry.notificationId, now, backoff, formatWorkerError(regResult), countAttempt);
                    this.log("outbox entry re-registration failed (transient), scheduling retry", {
                      notificationId: entry.notificationId,
                      sessionId: entry.sessionId,
                      attempts: entry.attempts + (countAttempt ? 1 : 0),
                      nextRetryIn: backoff,
                      kind: regResult.kind,
                    });
                    break;
                  } else {
                    this.markTerminal(entry, now, "reregister_failed", formatWorkerError(regResult));
                    break;
                  }
                }
              }

              if (action.action === "strip_entities") {
                try {
                  const parsedObj = JSON.parse(entry.payload) as {
                    messages?: Array<{ text: string; entities?: unknown[] }>;
                    message?: { text: string; entities?: unknown[] };
                    [key: string]: unknown;
                  };
                  if (Array.isArray(parsedObj.messages)) {
                    for (const m of parsedObj.messages) {
                      delete m.entities;
                    }
                  }
                  if (parsedObj.message && typeof parsedObj.message === "object") {
                    delete parsedObj.message.entities;
                  }
                  const strippedPayload = JSON.stringify(parsedObj);
                  this.storage.outbox.updatePayload(entry.notificationId, strippedPayload, now);
                } catch (err) {
                  this.log("outbox entry strip_entities payload update failed", {
                    notificationId: entry.notificationId,
                    err: err instanceof Error ? err.message : String(err),
                  });
                }

                const backoff = getBackoff(entry.retryCount);
                // Strip entities retry is caused by malformed entity formatting (per-message payload error).
                // It MUST count as an attempt even though the worker returned HTTP 502 (Telegram 400).
                this.storage.outbox.markRetry(entry.notificationId, now, backoff, formatWorkerError(result), true);
                this.log("outbox entry stripped entities, scheduling retry", {
                  notificationId: entry.notificationId,
                  sessionId: entry.sessionId,
                  attempts: entry.attempts + 1,
                  nextRetryIn: backoff,
                  telegramErrorCode: getTelegramErrorCode("body" in result ? result.body : undefined),
                  telegramErrorDescription: getTelegramErrorDescription("body" in result ? result.body : undefined),
                });
                break;
              }

              // Default retry arm (action.action === "retry")
              const backoff = getBackoff(entry.retryCount);
              const countAttempt = !isTransportFailure(result);
              this.storage.outbox.markRetry(entry.notificationId, now, backoff, formatWorkerError(result), countAttempt);
              this.log("outbox entry delivery failed, scheduling retry", {
                notificationId: entry.notificationId,
                sessionId: entry.sessionId,
                attempts: entry.attempts + (countAttempt ? 1 : 0),
                nextRetryIn: backoff,
                kind: result.kind,
                ...(result.kind === "http_error" || result.kind === "app_rejection" ? { status: result.status, body: result.body } : {}),
                ...(result.kind === "transport_error" ? { error: result.error } : {}),
              });
              break;
            }
          }

          if (allOk) {
            this.storage.outbox.markSent(entry.notificationId, now);
            this.reregisteredEntries.delete(entry.notificationId);
            this.log("outbox entry sent", {
              notificationId: entry.notificationId,
              sessionId: entry.sessionId,
              chunks: messages.length,
            });
          }
        } catch (err) {
          const backoff = getBackoff(entry.retryCount);
          const errMsg = err instanceof Error ? err.message : String(err);
          // Exception during delivery is ambiguous and may be a bug in our own code;
          // with a long age cap, not counting would retry a genuine code defect thousands of times.
          // Be conservative here and count as an attempt.
          this.storage.outbox.markRetry(entry.notificationId, now, backoff, errMsg, true);
          this.log("outbox entry delivery threw, scheduling retry", {
            notificationId: entry.notificationId,
            sessionId: entry.sessionId,
            attempts: entry.attempts + 1,
            err: errMsg,
          });
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
