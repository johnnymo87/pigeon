import type { IngressRouter } from "../routing/router";
import type { ServeInstanceRepo, RoutingMetaRepo } from "../routing/route-repo";
import type { ResolveClientsFn, ClientSet, WatchdogClient } from "./delivery-watchdog";

/**
 * The subset of `OpencodeClientFactory` this module needs — spelled out
 * structurally (rather than `Pick<OpencodeClientFactory, "forEndpoint">`) so
 * a real `OpencodeClientFactory` (whose `forEndpoint` returns the concrete
 * `OpencodeClient`, a `WatchdogClient` structurally) is assignable here,
 * without forcing test doubles to fake the full `OpencodeClient` shape.
 */
export interface WatchdogClientFactory {
  forEndpoint(endpoint: string): WatchdogClient;
}

/**
 * Builds the delivery watchdog's `resolveClients`: given a target session,
 * returns the client to read its transcript from (`preferred`) plus every
 * currently-healthy serve client (`all`, used for a 404 second opinion and
 * for broadcasting an abort).
 *
 * Mirrors the ingress-router-or-fallback shape of
 * {@link makeDirectoryResolver} in `../routing/directory-resolver`:
 *
 * - Pool configured (`ingressRouter` + `clientFactory` present): `all` is
 *   every healthy serve (via the serve registry), reusing the same
 *   `OpencodeClientFactory` the router/arbiter already use to build
 *   `OpencodeClient`s (no second client factory). `preferred` is the serve
 *   `resolveProspectiveRoute` (READ-ONLY, no lease writes) predicts for this
 *   session, falling back to any healthy serve when it yields nothing (e.g.
 *   the session was never placed).
 * - No healthy serve in the pool: empty set (`{ preferred: undefined, all:
 *   [] }`) — the watchdog itself handles the skip + age alarm.
 * - Pool not configured (single-serve hosts, e.g. crostini): falls back to
 *   `singleClient` (the same plain `OpencodeClient` the arbiter uses) as
 *   both `preferred` and the sole entry of `all`.
 * - Neither configured: empty set.
 */
export interface WatchdogClientResolverOpts {
  ingressRouter?: Pick<IngressRouter, "resolveProspectiveRoute">;
  serveRegistry: Pick<ServeInstanceRepo, "listHealthy">;
  routingMeta: Pick<RoutingMetaRepo, "get">;
  clientFactory?: WatchdogClientFactory;
  staleServeMs: number;
  singleClient?: WatchdogClient;
  nowFn?: () => number;
}

export function makeWatchdogResolveClients(
  opts: WatchdogClientResolverOpts,
): ResolveClientsFn {
  const nowFn = opts.nowFn ?? (() => Date.now());
  const poolConfigured = Boolean(opts.ingressRouter && opts.clientFactory);

  return (sessionId: string): ClientSet => {
    if (poolConfigured) {
      const now = nowFn();
      const epoch = opts.routingMeta.get().binaryEpoch;
      const healthy = opts.serveRegistry.listHealthy(now, opts.staleServeMs, epoch);
      const all: WatchdogClient[] = healthy.map((s) =>
        opts.clientFactory!.forEndpoint(s.endpoint),
      );

      if (all.length === 0) {
        return { preferred: undefined, all: [] };
      }

      const prospective = opts.ingressRouter!.resolveProspectiveRoute(sessionId, now);
      const preferred = prospective
        ? opts.clientFactory!.forEndpoint(prospective.apiBase)
        : all[0];

      return { preferred, all };
    }

    if (opts.singleClient) {
      return { preferred: opts.singleClient, all: [opts.singleClient] };
    }

    return { preferred: undefined, all: [] };
  };
}
