import type { WorkerResult } from "./poller";

export type DeliveryAction =
  | { action: "retry" }
  | { action: "pause"; retryAfterSec: number }
  | { action: "terminal"; reason: string }
  | { action: "reregister" }
  | { action: "strip_entities" };

export interface DeliveryPolicyContext {
  hasLocalSession: boolean;      // does the daemon still have a local session row
  alreadyReregistered: boolean;  // have we already tried re-registration for THIS entry
  payloadHasEntities: boolean;   // does the payload carry message entities
  attempts: number;              // entry.attempts, i.e. failures SO FAR, 0 on first failure
}

/**
 * Safely extracts Telegram details.error_code from worker response body.
 * Body may be undefined, a string, or an object without details.
 */
function getTelegramErrorCode(body: unknown): number | undefined {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const details = (body as { details?: unknown }).details;
    if (details && typeof details === "object" && !Array.isArray(details)) {
      const errorCode = (details as { error_code?: unknown }).error_code;
      if (typeof errorCode === "number" && Number.isFinite(errorCode)) {
        return errorCode;
      }
    }
  }
  return undefined;
}

/**
 * Returns true if the delivery/registration failure was caused by a transport outage,
 * worker 5xx error, or worker rate limit (429).
 *
 * Such failures indicate the transport or worker infrastructure is down or busy,
 * NOT that this specific message is defective. Rescheduling a transport failure
 * must NOT charge the message an attempt against its MAX_ATTEMPTS budget.
 */
export function isTransportFailure(result: WorkerResult): boolean {
  if (result.kind === "transport_error") {
    return true;
  }
  if (result.kind === "http_error") {
    return result.status >= 500 || result.status === 429;
  }
  return false;
}

/**
 * Pure failure classifier for worker outbox notification delivery results.
 *
 * Rules precedence order:
 * 1. transport_error -> retry
 * 2. 404 -> reregister (if local session exists and not yet tried) or terminal
 * 3. 403 -> retry, never terminal (a 403 never reaches Telegram; see the arm for why)
 * 4. 400 -> terminal
 * 5. positive finite retryAfter on remaining !ok -> pause
 * 6. 502 + Telegram details.error_code 400 + payloadHasEntities -> strip_entities
 * 7. anything else -> retry
 *
 * Note on ok:true results:
 * An ok:true result should never reach this function. If passed defensively,
 * returns { action: "retry" }.
 */
export function classifyDeliveryFailure(
  result: WorkerResult,
  ctx: DeliveryPolicyContext,
): DeliveryAction {
  if (result.ok) {
    return { action: "retry" };
  }

  // Rule 1: transport_error
  if (result.kind === "transport_error") {
    return { action: "retry" };
  }

  // Rule 2: http_error status 404
  // WHY: 404 gets a recovery arm, not an immediate death. A real incident on 2026-07-15 lost a message
  // because its session was never registered with the worker, so all 10 retries 404'd. Making 404
  // terminal WITHOUT a re-registration arm would have made that incident lose the message FASTER.
  // HOWEVER, 404 with no local session row is terminal. That means the session was deliberately unregistered
  // by the reaper (session-reaper.ts deletes the local row BEFORE unregistering). Re-registering there
  // would resurrect a session the reaper just cleaned up, and the worker has NO session TTL cron, so
  // the leaked row would live forever.
  if (result.kind === "http_error" && result.status === 404) {
    if (ctx.hasLocalSession && !ctx.alreadyReregistered) {
      return { action: "reregister" };
    }
    const reason = !ctx.hasLocalSession
      ? "Session not locally known (reaped or never existed)"
      : "Re-registration already attempted for this outbox entry";
    return { action: "terminal", reason };
  }

  // Rule 3: http_error status 403 -> RETRY, never terminal. Falls through to rule 7.
  //
  // Bead pigeon-bzf asked for 403 to be terminal alongside 400 and 404. That is rejected, with
  // evidence. Making it terminal has no upside and one large downside.
  //
  // No upside: the reason to kill a doomed entry early is the shared Telegram budget - roughly 20
  // messages per minute per group, spent by every session at once, so a wasted call costs somebody
  // else's notification. A 403 does not spend it. The worker rejects the chat id at
  // notifications.ts:202, BEFORE resolveTopic (:230) and before createTelegramClient (:248), so a
  // retried 403 never reaches Telegram at all. It costs one cheap worker request. (Same is true of
  // 400 at :188 and 404 at :197 - those are terminal for a different reason: they are genuinely
  // deterministic, so retrying cannot ever succeed.)
  //
  // Large downside: a 403 is NOT deterministic. It is a property of WORKER CONFIG (ALLOWED_CHAT_IDS)
  // and changes the moment the config does. Terminal converts a recoverable misconfiguration into
  // permanent loss of everything queued at that instant. This is live right now: production
  // deliberately keeps two chat ids allowed during the Telegram forum migration precisely because
  // narrowing that list produces 403s.
  //
  // An earlier draft compromised with "terminal at attempts >= 2". Adversarial review killed it on
  // two counts. First, ctx.attempts counts failures of EVERY kind (outbox-repo.ts increments it on
  // each markRetry), so an entry that had already accrued two unrelated transport failures would hit
  // its FIRST 403 and die instantly - two individually-recoverable transients combining into
  // permanent loss. Second, it bought about 15 seconds of rollback window (5s + 10s backoff) while
  // the comment justifying it claimed 15 minutes. No operator rolls back a worker config in 15
  // seconds. Retrying under the normal budget restores the real window and needs no extra state.
  //
  // Do not "optimise" this back into a terminal arm without first showing that a 403 reaches
  // Telegram. It does not.
  //
  // This returns explicitly rather than falling through to rule 7, so that a 403 can never reach
  // rule 5 and PAUSE the entire outbox. The worker does not attach retryAfter to a 403 today, but
  // one stray field should not be able to stall every other session's delivery.
  if (result.kind === "http_error" && result.status === 403) {
    return { action: "retry" };
  }

  // Rule 4: http_error status 400
  // Worker field validation ONLY ("sessionId, chatId, and text required").
  if (result.kind === "http_error" && result.status === 400) {
    return {
      action: "terminal",
      reason: "Worker field validation failed (HTTP 400)",
    };
  }

  // Rule 5: Positive finite retryAfter on ANY remaining !ok result
  // This is how 429 rate limit retries are handled. 429 never collides with 400/403/404 above.
  if (
    typeof result.retryAfter === "number" &&
    Number.isFinite(result.retryAfter) &&
    result.retryAfter > 0
  ) {
    return { action: "pause", retryAfterSec: result.retryAfter };
  }

  // Rule 6: http_error status 502 AND body.details.error_code === 400 AND ctx.payloadHasEntities
  // WHY: Entity stripping keys on 502 + details.error_code 400.
  // A Telegram 400 (for example a malformed message entity) does NOT reach the daemon as HTTP 400.
  // It arrives as HTTP 502 with body.details.error_code === 400. The only 400 the daemon can observe
  // is worker field validation, where stripping entities would be useless.
  if (
    result.kind === "http_error" &&
    result.status === 502 &&
    getTelegramErrorCode(result.body) === 400 &&
    ctx.payloadHasEntities
  ) {
    return { action: "strip_entities" };
  }

  // Rule 7: Anything else still !ok (other 5xx, 502 without an entity-400, app_rejection)
  return { action: "retry" };
}
