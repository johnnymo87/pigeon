import { withToken } from "./ws-transport.js";

/**
 * Why this module exists.
 *
 * When a connection to goose fails, the adapter must choose between two actions
 * whose consequences are opposite:
 *
 *   retry        goose was restarting, or the network blipped. Retrying works.
 *   give up      the secret is wrong. Retrying will NEVER work.
 *
 * Choosing "retry" for a bad secret produces a daemon that re-attempts every 60
 * seconds — the worker lease interval — until the command expires a day later,
 * silently, with nothing capping it. So the choice has to be made on evidence.
 *
 * The evidence exists on the wire but is destroyed on the way up. goose answers
 * a rejected credential with an HTTP 401 and a dead server with a refused TCP
 * connection; node's WebSocket collapses both into one indistinguishable error
 * event, and `ws-transport` collapses that further into a single string. By the
 * time an adapter sees it, "locked door" and "no door" read identically.
 *
 * So we ask over plain HTTP first, where the status code survives.
 *
 * MEASURED against goose 1.48.0 rather than assumed:
 *
 *   GET /acp?token=<correct>    406   auth passed; the route declined the GET
 *   GET /acp?token=<wrong>      401
 *   GET /acp  (no token)        401
 *   nothing listening           fetch rejects; no status at all
 *
 * The 406 is the useful part. goose's auth middleware (crates/goose/src/acp/
 * transport/auth.rs) runs BEFORE the route, returning 401 on a bad token and
 * otherwise delegating — so ANY non-401 status is proof the credential was
 * accepted, and a 406 in particular means we got that proof without creating a
 * session or causing any other side effect.
 *
 * This is deliberately a question about CREDENTIALS AND REACHABILITY, not about
 * health. It says nothing about whether goose can actually run a turn, and it
 * must not grow into a health check: a preflight that can fail for many reasons
 * is one whose failures nobody can act on.
 */
export type Reachability =
  | { kind: "ok" }
  | { kind: "auth-failed"; status: number }
  | { kind: "unreachable"; cause: string };

export interface PreflightOptions {
  /** Bounded so a silent server cannot stall the (serial) command poller. */
  timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export async function classifyReachability(
  url: string,
  token: string,
  opts: PreflightOptions = {},
): Promise<Reachability> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = opts.fetchFn ?? fetch;

  // Every await here is bounded. The command poller dispatches SERIALLY, so an
  // unbounded wait in this path would stall delivery for every session on the
  // machine — including another session's /interrupt. A server that accepts the
  // TCP connection and then never answers is the case that matters, because it
  // never rejects on its own.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(withToken(url, token), {
      method: "GET",
      signal: controller.signal,
    });

    // 401 is the ONLY status that means "your credential is wrong". Everything
    // else got past the auth middleware, which is the only question being asked.
    if (res.status === 401) return { kind: "auth-failed", status: 401 };
    return { kind: "ok" };
  } catch (err) {
    // Refused, DNS failure, TLS failure, or our own abort. All of them mean we
    // never got an answer, which is the retryable case.
    //
    // The message is deliberately built from the error alone and never from the
    // tokenised url, because this string gets logged.
    const cause = controller.signal.aborted
      ? `timed out after ${timeoutMs}ms`
      : err instanceof Error ? err.message : String(err);
    return { kind: "unreachable", cause };
  } finally {
    clearTimeout(timer);
  }
}
