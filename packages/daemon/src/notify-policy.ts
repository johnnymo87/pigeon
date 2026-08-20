import type { NotifyPolicy, OriginSource } from "./storage/session-origin-repo";

/**
 * How long an AUTOMATED (declared/inferred) suppression stays in force.
 *
 * Sized against production: observed lgtm session lifetimes are 0-59 minutes, so 2h is
 * ~2x headroom over the longest real run. Overshooting costs SILENCE on an adopted
 * session for the whole window; undershooting costs NOISE on an unusually long review.
 * Noise is the recoverable direction, so this is deliberately tight rather than generous.
 *
 * To disable expiry entirely (restoring the old sticky-forever behaviour) set
 * PIGEON_DECLARED_QUIET_TTL_MS to a huge finite value such as 1e15. "Infinity" is NOT
 * accepted -- it is non-finite, so it falls back to this default with a warning.
 */
export const DEFAULT_DECLARED_QUIET_TTL_MS = 2 * 60 * 60 * 1000; // 2h

export interface EffectivePolicyInput {
  policy: NotifyPolicy | null;
  source: OriginSource | null;
  declaredAt: number | null;
  now: number;
}

export interface EffectivePolicyResult {
  policy: NotifyPolicy | null;
  expired: boolean; // true ONLY when expiry actually changed the outcome
}

function parseDeclaredQuietTtlMs(env: Record<string, string | undefined>): number {
  const raw = env.PIGEON_DECLARED_QUIET_TTL_MS?.trim();
  if (!raw) return DEFAULT_DECLARED_QUIET_TTL_MS;

  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }

  console.warn(
    `[notify-policy] unrecognised PIGEON_DECLARED_QUIET_TTL_MS="${raw}", using default ${DEFAULT_DECLARED_QUIET_TTL_MS}ms`,
  );
  return DEFAULT_DECLARED_QUIET_TTL_MS;
}

/**
 * Computes the effective notification policy for a session origin record,
 * applying time-to-live (TTL) expiry to quiet declared/inferred rows.
 *
 * WHY expiry returns 'all' and not null:
 * Expiry MUST NOT resolve to policy = null. Expiring to 'all' decides explicitly at
 * the origin layer instead of falling through to whatever downstream default happens
 * to be configured. Expiring to 'all' explicitly overrides downstream layers.
 * (Deliberately no line numbers here: this is the load-bearing comment in the change and
 * line citations rot on the first edit above them.)
 *
 * WHY 'override' is exempt:
 * User-issued un-quiet actions write source = 'override'. A user's explicit decision
 * to un-quiet or change policy is permanent. Expiring an override would fail toward
 * silence, defeating the user's explicit choice.
 *
 * WHY the clock uses declared_at instead of created_at or updated_at:
 * The clock measures from the most recent declaration (declared_at), so quiet lasts
 * TTL past the last time automation asserted it. An abandoned session still un-quiets
 * TTL after its final dispatch (the safety property the TTL exists for).
 * A human who adopts an lgtm session is re-silenced for TTL on each reawaken event,
 * and the durable escape hatch is POST /sessions/enable-notify, which writes
 * source: "override" — TTL-exempt before any clock is read, and protected by the rank
 * guard from being undone by a later declared write.
 */
export function effectiveNotifyPolicy(
  input: EffectivePolicyInput,
  env: Record<string, string | undefined> = process.env,
): EffectivePolicyResult {
  const { policy, source, declaredAt, now } = input;

  if (policy === null) {
    return { policy: null, expired: false };
  }

  if (source === "override" || policy === "all") {
    return { policy, expired: false };
  }

  if ((policy === "errors-only" || policy === "none") && (source === "declared" || source === "inferred")) {
    // An UNUSABLE clock (absent, NaN, Infinity -- e.g. a corrupt declared_at read back
    // through Number()) means we cannot prove the suppression is still young. Ambiguity
    // resolves toward DELIVERING, so treat it as expired rather than silencing forever:
    // a bad clock must not be a way to make a session permanently silent.
    if (declaredAt === null || !Number.isFinite(declaredAt)) {
      return { policy: "all", expired: true };
    }

    const ttl = parseDeclaredQuietTtlMs(env);
    if (now - declaredAt > ttl) {
      return { policy: "all", expired: true };
    }
  }

  return { policy, expired: false };
}

/**
 * Which notification layer made the suppression decision.
 *
 * NOTE: Values here ("origin", "default") are templated directly into
 * the POST /stop response as `quiet_${layer}` (e.g. `quiet_origin`).
 * They are part of the wire contract consumed by callers and tests; adding or
 * changing a variant requires a deliberate decision about its wire string.
 */
export type NotifyLayer = "origin" | "default";

export interface NotifyDecisionInput {
  event: string;
  policy: NotifyPolicy | null;
  title?: string | null | undefined;
  errorKind?: string | null;
}

export interface NotifyDecision {
  deliver: boolean;
  layer: NotifyLayer;
}

/** Events that `none` suppresses in addition to Stop. */
const ERROR_EVENTS = new Set(["Error", "Retry"]);

/**
 * Which notification layer decided, and what it decided.
 *
 * Precedence, strongest first:
 *   1. session_origin.notify_policy  (declared provenance)
 *   2. deliver
 *
 * The caller checks `sessions.notify` BEFORE calling this (the `!session.notify` short-circuit in the POST /stop handler); that short-circuit
 * is upstream of the whole matrix.
 *
 * Every unnamed case delivers. `Error` and `Retry` arrive on the same POST /stop as `Stop`
 * (see the `Error` and `Retry` calls into `notifyStop` in opencode-plugin/src/index.ts).
 * Under `errors-only`, `Retry` is suppressed because rate-limit retries are transient,
 * self-healing, and have nothing for a human to do (pure noise in Telegram).
 * Aborted `Error` events (`errorKind === "aborted"`) are also suppressed under `errors-only`
 * as expected routine stops. Genuine, non-abort errors are delivered.
 *
 * Retry suppression is bounded by the declared-quiet TTL: `POST /stop` runs
 * `effectiveNotifyPolicy` BEFORE `decideNotify`, so declared/inferred quiet expires
 * to `all` after the TTL and a session retrying past it becomes audible again;
 * a session that exhausts its retries surfaces via a delivered (non-abort) `Error`.
 * This TTL coupling ensures retry suppression cannot indefinitely mask a stuck session.
 */
export function decideNotify(
  input: NotifyDecisionInput,
  _env: Record<string, string | undefined> = process.env,
): NotifyDecision {
  const { event, policy, errorKind } = input;

  if (policy === "none") {
    if (event === "Stop" || ERROR_EVENTS.has(event)) return { deliver: false, layer: "origin" };
    return { deliver: true, layer: "origin" };
  }

  if (policy === "errors-only") {
    if (event === "Stop" || event === "Retry") return { deliver: false, layer: "origin" };
    if (event === "Error" && errorKind === "aborted") return { deliver: false, layer: "origin" };
    return { deliver: true, layer: "origin" };
  }

  if (policy === "all") return { deliver: true, layer: "origin" };

  return { deliver: true, layer: "default" };
}

export type QuietReason = "unregistered" | "notify-flag" | "origin";

export interface QuietExplanation {
  reason: QuietReason;
  /** The declared origin (e.g. "lgtm") when a session_origin row exists, else null. */
  origin: string | null;
  /** The row's notify policy when one exists, else null. */
  policy: NotifyPolicy | null;
}

export interface ExplainQuietInput {
  /** false when the daemon has no sessions row for this sid. */
  registered: boolean;
  /** sessions.notify. Ignored when registered === false. */
  notify: boolean;
  policy: NotifyPolicy | null;
  origin: string | null;
  title: string | null | undefined;
}

/**
 * Returns null when a Stop WOULD be delivered; an explanation when it would not.
 *
 * NO PRODUCTION CALLER as of pigeon-mlc0 (2026-08-09). Its only caller was the
 * /current-state card renderer, which was deleted with the command. Kept
 * deliberately, by explicit decision, as the reusable "is this session silent,
 * and why?" primitive: it delegates to decideNotify, so it cannot drift from the
 * real POST /stop decision, and the exhaustiveness guard below fails compilation
 * if a new suppressing layer is added without teaching this function about it.
 * Anything that needs to answer that question should route through here rather
 * than re-deriving the answer. Do not delete it for being unreferenced.
 */
export function explainQuiet(
  input: ExplainQuietInput,
  env: Record<string, string | undefined> = process.env,
): QuietExplanation | null {
  const { registered, notify, policy, origin, title } = input;

  if (!registered) {
    return {
      reason: "unregistered",
      origin,
      policy,
    };
  }

  if (!notify) {
    return {
      reason: "notify-flag",
      origin,
      policy,
    };
  }

  const decision = decideNotify(
    {
      event: "Stop",
      policy,
      title,
    },
    env,
  );

  if (!decision.deliver) {
    switch (decision.layer) {
      case "origin":
        return { reason: decision.layer, origin, policy };
      case "default":
        // Unreachable today: decideNotify only ever returns layer "default"
        // together with deliver:true. Handled explicitly so the exhaustiveness
        // check below stays meaningful.
        break;
      default: {
        // A NEW suppressing NotifyLayer was added without teaching explainQuiet
        // about it. That is the FALSE-REASSURANCE direction -- the session would
        // be silent while this function reported it as audible -- so fail loudly
        // at compile time rather than silently returning null.
        const unhandled: never = decision.layer;
        console.warn(
          `[notify-policy] explainQuiet saw an unknown suppressing layer "${String(unhandled)}"; ` +
          `reporting a session as audible when it is actually silent`,
        );
        break;
      }
    }
  }

  return null;
}
