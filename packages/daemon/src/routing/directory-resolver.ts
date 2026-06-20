import { SessionDirectoryRegistry } from "../swarm/registry";
import type { IngressRouter } from "./router";

/** Builds a pool-aware, READ-ONLY directory resolver: resolves the owning serve's
 *  endpoint via the router's read-only resolveRoute, then GETs the session directory
 *  from that serve (per-endpoint registry cache). Falls back to a fixed endpoint. */
export function makeDirectoryResolver(opts: {
  ingressRouter?: Pick<IngressRouter, "resolveRoute">;
  fallbackBaseUrl?: string;
  ttlMs?: number;
  nowFn?: () => number;
}): (sessionId: string) => Promise<string | undefined> {
  const ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  const nowFn = opts.nowFn ?? (() => Date.now());
  const registries = new Map<string, SessionDirectoryRegistry>();
  const registryFor = (baseUrl: string): SessionDirectoryRegistry => {
    let r = registries.get(baseUrl);
    if (!r) {
      r = new SessionDirectoryRegistry({ baseUrl, ttlMs });
      registries.set(baseUrl, r);
    }
    return r;
  };
  return async (sessionId: string): Promise<string | undefined> => {
    let baseUrl: string | undefined;
    if (opts.ingressRouter) {
      baseUrl = opts.ingressRouter.resolveRoute(sessionId, nowFn())?.apiBase;
    }
    baseUrl ??= opts.fallbackBaseUrl;
    if (!baseUrl) return undefined;
    try {
      return await registryFor(baseUrl).resolve(sessionId);
    } catch {
      return undefined;
    }
  };
}
