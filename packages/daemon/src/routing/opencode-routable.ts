import type { OpencodeClient } from "../opencode-client";
import { GOOSE_BACKEND_KIND } from "../goose/backend-kind";
import type { SessionRecord } from "../storage/types";

/**
 * The only backend kind the opencode serve pool can own.
 *
 * The opencode plugin sends this literal on every registration
 * (packages/opencode-plugin/src/index.ts), so a session the pool can serve
 * always carries it.
 */
export const OPENCODE_BACKEND_KIND = "opencode-plugin-direct";

/** The fields of a session record that decide whether the pool can own it. */
export type RoutableEvidence = Pick<SessionRecord, "backendKind" | "nvimSocket" | "ptyPath">;

/**
 * Whether a session may be handed to the opencode ingress router.
 *
 * WHY THIS IS AN ALLOW-LIST. Routing is not a lookup: `ensureRouted` ->
 * `placeSession` does not decline an id it has never seen, it writes a
 * `session_assignment` row and acquires a LIVE lease, and live leases are what
 * `activeTurnCap` is counted against. So every non-opencode session that
 * reaches the router narrows placement for the human's real opencode sessions,
 * and the damage lands on OTHER sessions, which is what makes it hard to
 * attribute. Guarding goose alone (the previous rule) left every other
 * registrant exposed: a session registered with no backend at all -- a scripted
 * job that only wants a Telegram topic -- placed a lease on the first Telegram
 * reply to its topic, and so did a session carrying a backend kind this daemon
 * has no adapter for. A deny-list has to be updated for each new registrant; an
 * allow-list fails safe.
 *
 * WHAT IS ALLOWED, and why each case:
 *  - No row at all. `/launch` resolves the owner of a session it has just
 *    created, before the plugin inside it has registered, and must place it.
 *    (This preserves existing behaviour for unknown ids; it does not bless it.)
 *  - `opencode-plugin-direct`, whatever else the row holds: that is an opencode
 *    session by construction.
 *  - A non-goose row carrying BOTH an nvim socket and a pty, whatever its kind.
 *    `selectAdapter` serves these through NvimRpcAdapter without looking at the
 *    kind, and that adapter's connection-error recovery revives through the
 *    opencode client; with no client the same branch DELETES the session. So
 *    this clause is exactly "every row that has a non-surface adapter", which is
 *    what keeps the delete branch unreachable for anything refused here.
 *    Measured on one live daemon on 2026-09-25: zero rows with an nvim socket
 *    out of 683, so this is kept for safety, not because it is common.
 *
 * goose is refused first, whatever else its row carries: its adapter is
 * `surface`, and its control commands have their own answers.
 *
 * Everything else is refused. The callers already cope with `undefined`: a
 * Telegram reply falls through to the no-adapter path and the human is told the
 * session is not reachable, which is true.
 */
export function isOpencodeRoutable(session: RoutableEvidence | undefined): boolean {
  if (session === undefined) return true;
  if (session.backendKind === GOOSE_BACKEND_KIND) return false;
  if (session.backendKind === OPENCODE_BACKEND_KIND) return true;
  return Boolean(session.nvimSocket && session.ptyPath);
}

export interface ClientForSessionDeps {
  getSession(sessionId: string): SessionRecord | undefined;
  /** The pool-aware factory; absent when routing is unconfigured. */
  clientFactory: { forSession(sessionId: string): OpencodeClient | undefined } | undefined;
  /** The single legacy client used when routing is unconfigured. */
  fallbackClient: OpencodeClient | undefined;
}

/**
 * Builds the daemon's `clientForSession`: the owning-serve client for a
 * session, or `undefined` when the pool must not own it.
 *
 * The guard lives HERE, at the choke point, rather than at call sites: the
 * resolver is handed whole to the swarm arbiter and to `/launch`'s owner
 * resolution as well as to the nine control handlers, and a guard at a subset of
 * callers was already tried once for goose and found insufficient.
 *
 * The session is read BEFORE the factory is touched, because touching the
 * factory is the side effect.
 */
export function makeClientForSession(
  deps: ClientForSessionDeps,
): (sessionId: string) => OpencodeClient | undefined {
  return (sessionId) => {
    if (!isOpencodeRoutable(deps.getSession(sessionId))) return undefined;
    return deps.clientFactory ? deps.clientFactory.forSession(sessionId) : deps.fallbackClient;
  };
}
