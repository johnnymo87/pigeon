import { resolveServeAuthHeader, invalidateServeAuthHeader } from "../serve-auth";

/**
 * Where a swarm target lives, as seen from this daemon (pigeon-k0qn.2, spec §1 of
 * docs/plans/2026-10-20-cross-machine-swarm-design.md).
 *
 *   local    a session this machine can deliver to
 *   remote   a session this machine provably does not have
 *   unknown  we could not tell; a TRANSIENT state, retried like an outage
 *
 * "unknown" is never folded into "remote". A briefly sick serve must not push
 * local traffic into a permanent cross-machine failure.
 */
export type Locality = "local" | "remote" | "unknown";

/** Per-probe ceiling, headers and body. */
export const DEFAULT_LOCALITY_PROBE_TIMEOUT_MS = 3_000;

export interface LocalityResolverOptions {
  /** Whether this daemon holds a `sessions` row for the id. */
  hasLocalSession(sessionId: string): boolean;
  /** Candidate serve bases to probe, in order. Duplicates are ignored. */
  baseUrlsFor(sessionId: string): string[];
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Builds the tri-state locality check. READ-ONLY by construction: it never
 * touches the ingress router's placement path, so asking about an id this
 * machine does not have cannot create a `session_assignment` for it (which is
 * what `clientForSession` -> `ensureRouted` does for any unknown id).
 *
 * Rules, in order:
 *  - a local `sessions` row -> local (every backend, goose included);
 *  - `gse_` without a row -> remote. pigeon mints those ids, so the row is
 *    authoritative, and an opencode serve answers `GET /session/gse_…` with 500,
 *    which would leave every remote goose target "unknown" forever;
 *  - otherwise `GET <serve>/session/<id>`, no directory header. All serves on a
 *    machine read one opencode.db (pinned by OPENCODE_DB and
 *    OPENCODE_DISABLE_CHANNEL_DB on every host): a 200 from any base -> local
 *    (includes subagents, which never register); otherwise at least one 404 ->
 *    remote; otherwise unknown.
 *
 * Not cached: a session can come back (a reaped row revived), and a stale
 * "remote" would fail it permanently.
 */
export function makeLocalityResolver(
  opts: LocalityResolverOptions,
): (sessionId: string) => Promise<Locality> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCALITY_PROBE_TIMEOUT_MS;

  const probe = async (base: string, sessionId: string): Promise<number | null> => {
    const url = `${base}/session/${encodeURIComponent(sessionId)}`;
    const headers: Record<string, string> = {};
    const auth = resolveServeAuthHeader();
    if (auth) headers["Authorization"] = auth;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    // Raced explicitly: a fetch that ignores its signal must not hold the
    // arbiter's per-target in-flight slot open.
    const attempt = (async (): Promise<number | null> => {
      try {
        const res = await fetchFn(url, { method: "GET", headers, signal: controller.signal });
        if (res.status === 401) invalidateServeAuthHeader();
        // Drain the body so the connection is released.
        await res.text().catch(() => "");
        return res.status;
      } catch {
        return null;
      }
    })();
    try {
      return await Promise.race([attempt, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  return async (sessionId) => {
    if (opts.hasLocalSession(sessionId)) return "local";
    if (sessionId.startsWith("gse_")) return "remote";

    // A 200 from ANY base is local. "remote" needs a 404 and no 200 anywhere, so
    // one stray serve on a different data dir (a hijacked pool slot, a channel-
    // suffixed DB) cannot turn a local session into a permanent failure. The
    // extra probes run only on the remote path, against localhost.
    let sawNotFound = false;
    const seen = new Set<string>();
    for (const raw of opts.baseUrlsFor(sessionId)) {
      const base = raw.replace(/\/+$/, "");
      if (!base || seen.has(base)) continue;
      seen.add(base);
      const status = await probe(base, sessionId);
      if (status === 200) return "local";
      if (status === 404) sawNotFound = true;
    }
    return sawNotFound ? "remote" : "unknown";
  };
}
