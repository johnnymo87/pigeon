/**
 * Which goose sessions a swarm message can reach, and which of them are stall-watch
 * program coordinators (pigeon-a0o8, docs/plans/2026-11-06-coordinator-discovery-design.md).
 *
 * One predicate for "reachable", shared by delivery (bank-or-insert), discovery
 * (`GET /swarm/goose-sessions`) and the relay receiver's coordinator rule, so what
 * swarm_list shows cannot drift from what swarm_send does.
 */

import type { SessionRecord } from "../storage/types";
import { GOOSE_BACKEND_KIND } from "../goose/backend-kind";
import { coordinatorProgramOf } from "../tag-key";

type GooseRow = Pick<SessionRecord, "backendKind" | "backendEndpoint" | "pullSources">;

/** A goose-acp row with an endpoint: a swarm message is pushed into it as a turn. */
export function isGoosePushRow(row: GooseRow | null | undefined): boolean {
  return Boolean(row && row.backendKind === GOOSE_BACKEND_KIND && row.backendEndpoint);
}

/**
 * A goose-acp row a local swarm_send reaches: pushed (it has an endpoint), or banked
 * (no endpoint, but its swarm mailbox is open).
 */
export function isSwarmReachableGooseRow(row: GooseRow | null | undefined): boolean {
  if (!row || row.backendKind !== GOOSE_BACKEND_KIND) return false;
  return isGoosePushRow(row) || row.pullSources.includes("swarm");
}

/**
 * The program a goose-acp row coordinates, or null. A coordinator is bound to the named
 * topic `stallwatch:<tag>` with a valid tag; any other suffix (`stallwatch:_notices`) is
 * not one, matching honk's `coordinator_program`. goose-pull rows bound to such a topic
 * (the legacy shape) are not coordinators here.
 */
export function coordinatorProgram(
  row: (GooseRow & Pick<SessionRecord, "sessionId" | "backendSessionId"> & { boundTopicKey?: string | null }) | null | undefined,
): string | null {
  if (!row || row.backendKind !== GOOSE_BACKEND_KIND) return null;
  const res = coordinatorProgramOf(row);
  return res && "program" in res ? res.program : null;
}
