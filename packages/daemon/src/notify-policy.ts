import { isQuietTitle } from "./quiet-title";
import type { NotifyPolicy } from "./storage/session-origin-repo";

/**
 * Which notification layer made the suppression decision.
 *
 * NOTE: Values here ("origin", "title", "default") are templated directly into
 * the POST /stop response as `quiet_${layer}` (e.g. `quiet_origin`, `quiet_title`).
 * They are part of the wire contract consumed by callers and tests; adding or
 * changing a variant requires a deliberate decision about its wire string.
 */
export type NotifyLayer = "origin" | "title" | "default";

export interface NotifyDecisionInput {
  event: string;
  policy: NotifyPolicy | null;
  title: string | null | undefined;
}

export interface NotifyDecision {
  deliver: boolean;
  layer: NotifyLayer;
}

/** Events that `errors-only` still delivers. */
const ERROR_EVENTS = new Set(["Error", "Retry"]);

/** Recognised spellings for switching the transitional title layer off. */
const LAYER_OFF_VALUES = new Set(["off", "false", "0", "no"]);
/** Recognised spellings for leaving it on. */
const LAYER_ON_VALUES = new Set(["on", "true", "1", "yes"]);

function isTitleLayerOn(env: Record<string, string | undefined>): boolean {
  const raw = env.PIGEON_QUIET_TITLE_LAYER?.trim();
  if (!raw) return true;

  const val = raw.toLowerCase();
  if (LAYER_OFF_VALUES.has(val)) return false;
  if (LAYER_ON_VALUES.has(val)) return true;

  console.warn(
    `[notify-policy] unrecognised PIGEON_QUIET_TITLE_LAYER="${raw}", leaving title layer enabled`,
  );
  return true;
}

/**
 * Which notification layer decided, and what it decided.
 *
 * Precedence, strongest first:
 *   1. session_origin.notify_policy  (declared provenance)
 *   2. the legacy quiet-title regex  (transitional; disable with
 *      PIGEON_QUIET_TITLE_LAYER=off, delete under pigeon-qdcb.5)
 *   3. deliver
 *
 * The caller checks `sessions.notify` BEFORE calling this (the `!session.notify` short-circuit in the POST /stop handler); that short-circuit
 * is upstream of the whole matrix.
 *
 * Every unnamed case delivers. `Error` and `Retry` arrive on the same POST /stop as `Stop`
 * (see the `Error` and `Retry` calls into `notifyStop` in opencode-plugin/src/index.ts), and have always been delivered for lgtm sessions
 * because the old gate tested `event === "Stop"`. Silencing them here would be a
 * regression that no counter would surface.
 */
export function decideNotify(
  input: NotifyDecisionInput,
  env: Record<string, string | undefined> = process.env,
): NotifyDecision {
  const { event, policy, title } = input;

  if (policy === "none") {
    if (event === "Stop" || ERROR_EVENTS.has(event)) return { deliver: false, layer: "origin" };
    return { deliver: true, layer: "origin" };
  }

  if (policy === "errors-only") {
    if (event === "Stop") return { deliver: false, layer: "origin" };
    return { deliver: true, layer: "origin" };
  }

  if (policy === "all") return { deliver: true, layer: "origin" };

  const titleLayerOn = isTitleLayerOn(env);
  if (titleLayerOn && event === "Stop" && isQuietTitle(title, env)) {
    return { deliver: false, layer: "title" };
  }

  return { deliver: true, layer: "default" };
}

export type QuietReason = "unregistered" | "notify-flag" | "origin" | "title";

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

/** Returns null when a Stop WOULD be delivered; an explanation when it would not. */
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
      case "title":
        return { reason: decision.layer, origin, policy };
      case "default":
        // Unreachable today: decideNotify only ever returns layer "default"
        // together with deliver:true. Handled explicitly so the exhaustiveness
        // check below stays meaningful.
        break;
      default: {
        // A NEW suppressing NotifyLayer was added without teaching explainQuiet
        // about it. That is the FALSE-REASSURANCE direction -- the session would
        // be silent while its card showed nothing -- so fail loudly at compile
        // time rather than silently returning null.
        const unhandled: never = decision.layer;
        console.warn(
          `[notify-policy] explainQuiet saw an unknown suppressing layer "${String(unhandled)}"; ` +
          `card will not show a mute indicator for a session that is actually silent`,
        );
        break;
      }
    }
  }

  return null;
}
