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
 * MEASURED against a real goose 1.48.0 serve rather than assumed:
 *
 *   GET /acp?token=<correct>    406   auth passed; the route declined the GET
 *   GET /acp?token=<wrong>      401
 *   GET /acp  (no token)        401
 *   nothing listening           fetch rejects; no status at all
 *
 * The 406 is the useful part. goose's auth middleware (crates/goose/src/acp/
 * transport/auth.rs at v1.48.0) runs BEFORE the route, returning 401 on a bad
 * token and otherwise delegating — so a non-401 status is proof the credential
 * was accepted, and the 406 in particular delivers that proof without creating a
 * session or allocating anything (the Accept check is the route's first
 * statement).
 *
 * WHAT THIS DOES NOT DO, stated plainly because the honest scope is narrow: it
 * removes the 401 from the retry loop. It does NOT bound retries in general. A
 * host that black-holes packets, a DNS typo, or a TLS mismatch all still look
 * transient and still retry until the command expires. Capping that is the
 * adapter's job and needs an attempt counter that `CommandDeliveryContext` does
 * not currently carry.
 *
 * Deliberately NOT a health check. It answers "are you there, are you goose, and
 * do you accept this credential" — nothing about whether a turn can run. A
 * preflight that can fail for many reasons is one whose failures nobody can act
 * on.
 */
export type Reachability =
  /** Credential accepted and the answer looks like goose. Proceed. */
  | { kind: "ok" }
  /** 401. Permanent: the secret is wrong. Never retry this. */
  | { kind: "auth-failed" }
  /**
   * Something answered, but it cannot be goose: goose's GET /acp only ever
   * returns 401, 406, 400 or 404, so a 2xx/3xx means a wrong port, or a proxy
   * that swallowed the auth failure and answered on goose's behalf. Permanent in
   * practice — retrying a misconfigured port for a day helps nobody.
   */
  | { kind: "not-goose"; status: number }
  /** No answer at all: refused, DNS, TLS, or our own timeout. Retryable. */
  | { kind: "unreachable"; cause: string };

export interface PreflightOptions {
  /** Bounded so a silent server cannot stall the (serial) command poller. */
  timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * `fetch` cannot speak ws:. It rejects a ws:// url with TypeError("fetch
 * failed") — the SAME message as a refused connection — and hides the real
 * reason in `err.cause` ("unknown scheme"). Since the natural goose url is
 * ws://, probing one unnormalised would report healthy goose as a dead server
 * forever. Verified on node 22.22.2.
 */
function toHttpScheme(url: string): string {
  const u = new URL(url);
  if (u.protocol === "ws:") u.protocol = "http:";
  else if (u.protocol === "wss:") u.protocol = "https:";
  return u.toString();
}

/** Never let a secret reach a log line, whatever an error decided to embed. */
function redact(text: string, token: string): string {
  return token ? text.split(token).join("<redacted>") : text;
}

/**
 * Flattens an error chain into something a human can act on. node puts the
 * actionable part ("unknown scheme", "connect ECONNREFUSED 127.0.0.1:3400",
 * "getaddrinfo ENOTFOUND host") in `cause`, not in `message`, and the top-level
 * message is the useless-but-identical "fetch failed" in every case.
 */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const inner = (err as Error & { cause?: unknown }).cause;
  const innerMsg = inner instanceof Error ? inner.message : undefined;
  return innerMsg ? `${err.message}: ${innerMsg}` : err.message;
}

export async function classifyReachability(
  url: string,
  token: string,
  opts: PreflightOptions = {},
): Promise<Reachability> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = opts.fetchFn ?? fetch;

  // Every await here is bounded. The command poller dispatches SERIALLY, so an
  // unbounded wait would stall delivery for every session on the machine —
  // including another session's /interrupt. A server that accepts the TCP
  // connection and then never answers is the case that matters, because it never
  // rejects on its own.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(withToken(toHttpScheme(url), token), {
      method: "GET",
      signal: controller.signal,
      // Follow nothing. A 302 to a login page that answers 200 would otherwise
      // read as success; the redirect itself is the more honest answer.
      redirect: "manual",
    });

    // The body is never read. Release it rather than leaving a stream open —
    // the timer is already cleared by the time we return, so a chunked endpoint
    // on a wrong port would otherwise hold the connection with nothing to kill
    // it.
    void res.body?.cancel?.().catch(() => {});

    if (res.status === 401) return { kind: "auth-failed" };
    // goose answers this path with 401/406/400/404 and nothing else, so a
    // success or a redirect proves we are not talking to goose.
    if (res.status < 400) return { kind: "not-goose", status: res.status };
    return { kind: "ok" };
  } catch (err) {
    // Refused, DNS failure, TLS failure, bad scheme, or our own abort — all mean
    // we never got an answer.
    const cause = controller.signal.aborted
      ? `timed out after ${timeoutMs}ms`
      : describe(err);
    return { kind: "unreachable", cause: redact(cause, token) };
  } finally {
    clearTimeout(timer);
  }
}
