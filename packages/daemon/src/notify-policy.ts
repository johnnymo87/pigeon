import { isQuietTitle } from "./quiet-title";
import type { NotifyPolicy } from "./storage/session-origin-repo";

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

/**
 * Which notification layer decided, and what it decided.
 *
 * Precedence, strongest first:
 *   1. session_origin.notify_policy  (declared provenance)
 *   2. the legacy quiet-title regex  (transitional; disable with
 *      PIGEON_QUIET_TITLE_LAYER=off, delete under pigeon-qdcb.5)
 *   3. deliver
 *
 * The caller checks `sessions.notify` BEFORE calling this (app.ts:684); that short-circuit
 * is upstream of the whole matrix.
 *
 * Every unnamed case delivers. `Error` and `Retry` arrive on the same POST /stop as `Stop`
 * (opencode-plugin/src/index.ts:543,652), and have always been delivered for lgtm sessions
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

  const titleLayerOn = (env.PIGEON_QUIET_TITLE_LAYER ?? "on").trim() !== "off";
  if (titleLayerOn && event === "Stop" && isQuietTitle(title, env)) {
    return { deliver: false, layer: "title" };
  }

  return { deliver: true, layer: "default" };
}
