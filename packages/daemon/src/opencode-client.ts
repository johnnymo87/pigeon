import {
  RequestTimeoutError,
  TransportError,
  type OutcomeObservation,
} from "./routing/serve-outcome";
import { resolveServeAuthHeader, invalidateServeAuthHeader } from "./serve-auth";
import type { InjectedPromptsRepository } from "./storage/injected-prompts-repo";
import { hashPrompt } from "./hash-prompt";

export class OpencodeHttpError extends Error {
  readonly status: number;
  readonly statusText: string;

  constructor(status: number, statusText: string, message?: string) {
    super(message ?? `HTTP ${status} ${statusText}`);
    this.name = "OpencodeHttpError";
    this.status = status;
    this.statusText = statusText;
  }
}

// Re-exported for callers that classify failures from this client. Defined in
// ./routing/serve-outcome because that module must `instanceof` it and this
// module already imports from there.
export { TransportError };

interface OpencodeClientOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
  /** Per-request ceiling, covering headers AND body. See `request`. Defaults to 30s. */
  requestTimeoutMs?: number;
  /**
   * Shadow-mode observability tap (bead pigeon-f2a). Fires once per request with
   * the raw status or error; classification happens in the sensor, not here.
   *
   * Records only — it must not influence this client's behaviour, and today
   * nothing reads its output for routing. See routing/serve-outcome.ts.
   */
  onOutcome?: (obs: OutcomeObservation) => void;
  injectedPrompts?: InjectedPromptsRepository;
}

/**
 * Deliberately generous (bead pigeon-h21). Every endpoint here should answer in
 * milliseconds -- `prompt_async` in particular returns at ACCEPT, not at
 * completion -- so this is a liveness backstop, not a latency budget. A tight
 * value would abort a serve that is merely busy, which is the false-positive
 * class that caused the June 2026 lease-flapping incident.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class OpencodeClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly onOutcome: ((obs: OutcomeObservation) => void) | undefined;
  private readonly injectedPrompts: InjectedPromptsRepository | undefined;

  constructor(options: OpencodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onOutcome = options.onOutcome;
    this.injectedPrompts = options.injectedPrompts;
  }

  /** Never let the observability tap perturb the request it is observing. */
  private observe(obs: OutcomeObservation): void {
    try {
      this.onOutcome?.(obs);
    } catch {
      // Deliberately ignored.
    }
  }

  /**
   * Bounds every request so a serve that ACCEPTS the connection but never
   * responds cannot leave a promise pending forever (bead pigeon-h21).
   *
   * The deadline covers the RESPONSE BODY as well as the headers (pigeon-wfj1).
   * The original h21 fix disarmed the abort in a `finally` that ran the moment
   * the fetch promise resolved -- i.e. when the headers arrived -- and each
   * caller then read the body unbounded. A serve that returns 200 headers and
   * then stalls mid-body reproduced the exact defect h21 was written to
   * prevent, one phase later. That is why callers pass a `consume` callback
   * instead of receiving the `Response`: the body cannot be read outside the
   * bound, because the Response never leaves this method.
   *
   * That state is worse than a fast failure. The SwarmArbiter is
   * at-most-one-in-flight per target and releases the slot in a `.finally()`
   * (`swarm/arbiter.ts:76-77`), so a promise that never settles wedges ALL swarm
   * delivery to that session permanently: no rejection means no retry, and no
   * failure means nothing to observe. Silence reads as success.
   *
   * The abort is surfaced as a normal Error rather than a bare AbortError so
   * callers get a message that names the cause. Note the timeout must NOT be fed
   * into any serve-health verdict -- see
   * docs/plans/2026-07-27-serve-serviceability-design.md 5.1 C.
   */
  private async request<T>(
    url: string,
    init: RequestInit,
    consume: (res: Response) => T | Promise<T>,
  ): Promise<T> {
    const buildHeaders = (): Record<string, string> => {
      const authHeader = resolveServeAuthHeader();
      const authObj: Record<string, string> = authHeader ? { Authorization: authHeader } : {};
      const callerHeaders = (init.headers as Record<string, string> | undefined) ?? {};
      return {
        ...authObj,
        ...callerHeaders,
      };
    };

    // ONE deadline for the WHOLE call: connect, headers, retry, and body. The
    // controller stays armed across all of them, so there is no window in which
    // a stalled peer can leave us pending. See the doc comment above for why
    // the body phase is the one that actually bit us (pigeon-wfj1).
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new RequestTimeoutError(this.requestTimeoutMs, url));
      }, this.requestTimeoutMs);
    });
    // The loser of every race below is left rejecting into the void; without a
    // handler that is an unhandled rejection (fatal under Node's default).
    deadline.catch(() => {});

    /**
     * Race `p` against the shared deadline without leaking its rejection.
     *
     * Aborting makes an in-flight body read reject with AbortError, which RACES
     * the deadline's own rejection. Converting here makes the caller's error
     * deterministic instead of depending on which rejection lands first -- and
     * it matters: `RequestTimeoutError` is what keeps a hung serve out of the
     * health verdict and away from the watchdog's 404-terminal path.
     */
    let observed = false;
    /** Enforces the once-per-request contract structurally, not by convention. */
    const observeOnce = (obs: OutcomeObservation): void => {
      if (observed) return;
      observed = true;
      this.observe(obs);
    };

    const withDeadline = async <R>(p: Promise<R>): Promise<R> => {
      p.catch(() => {});
      try {
        return await Promise.race([p, deadline]);
      } catch (err) {
        if (controller.signal.aborted && !(err instanceof RequestTimeoutError)) {
          const timeout = new RequestTimeoutError(this.requestTimeoutMs, url);
          // A body-phase abort arrives AFTER the final status was observed, so
          // this is normally a no-op; it matters only when the body read is what
          // aborts before any status exists. Without the guard one hung-body
          // request contributed both a success and a timeout to the shadow tally
          // -- and which one depended on microtask race order.
          observeOnce({ error: timeout });
          throw timeout;
        }
        throw err;
      }
    };

    const execFetch = async (): Promise<Response> => {
      try {
        return await this.fetchFn(url, {
          ...init,
          headers: buildHeaders(),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          const timeout = new RequestTimeoutError(this.requestTimeoutMs, url);
          observeOnce({ error: timeout });
          throw timeout;
        }
        const transportErr = new TransportError(err as Error);
        observeOnce({ error: transportErr });
        throw transportErr;
      }
    };

    try {
      let res = await withDeadline(execFetch());

    // Credential rotation self-heal: a 401 may mean the cached header is stale
    // (the secret file was rewritten under a long-running daemon). Re-resolve and
    // retry ONCE -- but only if re-resolution actually produced a DIFFERENT, defined
    // credential. Retrying with the same value, or with no value at all when auth is
    // off, is guaranteed to 401 again and just doubles the request. A 401 is emitted
    // by the auth middleware before the body is parsed or any handler runs, so no
    // side effect can have occurred on the first attempt -- that is what makes this
    // safe for the non-idempotent methods (prompt_async, summarize, abort, delete).
      if (res.status === 401) {
        const staleHeader = resolveServeAuthHeader();
        invalidateServeAuthHeader();
        const freshHeader = resolveServeAuthHeader();
        if (freshHeader !== undefined && freshHeader !== staleHeader) {
          // Release the discarded response's socket back to the undici pool instead of
          // waiting for GC; this client runs on every swarm delivery.
          res.body?.cancel().catch(() => {});
          res = await withDeadline(execFetch());
        }
      }

      // Observe the FINAL status only. A transient 401 that succeeded on retry should
      // not be reported as a failed request. This does not weaken the serve-health
      // verdict: classifyServeOutcome() already treats 4xx as client_error, and
      // countsTowardVerdict() admits only "refused" and "server_error" (serve-outcome.ts
      // rule B -- "4xx IS NOT ILL-HEALTH").
      observeOnce({ status: res.status });

      // The body is read HERE, still inside the deadline. Callers never receive
      // the Response, so there is no way to read a body outside the bound --
      // the guarantee is structural, not a convention someone must remember.
      // `Promise.resolve` on a native promise returns THAT promise, adding no
      // microtask hop. That is deliberate: with a hop, the deadline's rejection
      // always beat the body's abort rejection to the race, so the
      // abort->timeout conversion in `withDeadline` was unreachable — it only
      // looked protective. A `consume` that returns the body promise directly
      // (no `async` wrapper) has no hop, and then the abort rejection DOES win.
      // Keeping the shapes indistinguishable means the conversion is exercised
      // rather than dead.
      return await withDeadline(Promise.resolve(consume(res)));
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      return await this.request(
        `${this.baseUrl}/global/health`,
        { method: "GET" },
        (response) => response.ok,
      );
    } catch {
      return false;
    }
  }

  async createSession(directory: string): Promise<{ id: string }> {
    return this.request(
      `${this.baseUrl}/session`,
      {
        method: "POST",
        headers: { "x-opencode-directory": directory },
      },
      async (response) => {
        if (!response.ok) {
          throw new Error(`createSession failed: ${response.status} ${response.statusText}`);
        }
        return (await response.json()) as { id: string };
      },
    );
  }

  /**
   * Look up a session by id. Returns null on 404 (session truly gone),
   * throws on other failures (network error, 5xx). The 404 vs throw split
   * lets callers distinguish "session deleted from opencode-serve" from
   * "opencode-serve is unreachable."
   */
  async getSession(sessionId: string): Promise<{ id: string; directory: string } | null> {
    return this.request(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}`,
      { method: "GET" },
      async (response) => {
        if (response.status === 404) return null;

        if (!response.ok) {
          throw new Error(`getSession failed: ${response.status} ${response.statusText}`);
        }

        const body = (await response.json()) as { id?: string; directory?: string };
        if (!body || !body.id || !body.directory) {
          throw new Error(`getSession response missing id or directory: ${JSON.stringify(body)}`);
        }
        return { id: body.id, directory: body.directory };
      },
    );
  }

  async getSessionInfo(sessionId: string): Promise<{
    id: string;
    title: string;
    directory: string;
    time: { created: number; updated: number };
  } | null> {
    return this.request(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}`,
      { method: "GET" },
      async (response) => {
        if (response.status === 404) return null;

        if (!response.ok) {
          throw new Error(`getSessionInfo failed: ${response.status} ${response.statusText}`);
        }

        const body = (await response.json()) as {
          id?: string;
          title?: string;
          directory?: string;
          time?: { created?: number; updated?: number };
        };

        if (!body || !body.id || !body.directory) {
          throw new Error(`getSessionInfo response missing id or directory: ${JSON.stringify(body)}`);
        }

        return {
          id: body.id,
          title: body.title ?? "",
          directory: body.directory,
          time: {
            created: body.time?.created ?? 0,
            updated: body.time?.updated ?? 0,
          },
        };
      },
    );
  }

  async sendPrompt(sessionId: string, directory: string, prompt: string): Promise<void> {
    this.injectedPrompts?.record(sessionId, hashPrompt(prompt));
    return this.request(
      `${this.baseUrl}/session/${sessionId}/prompt_async`,
      {
        method: "POST",
        headers: {
          "x-opencode-directory": directory,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
      },
      (response) => {
        if (!response.ok) {
          throw new OpencodeHttpError(
            response.status,
            response.statusText,
            `sendPrompt failed: ${response.status} ${response.statusText}`,
          );
        }
      },
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    return this.request(
      `${this.baseUrl}/session/${sessionId}`,
      { method: "DELETE" },
      (response) => {
        if (!response.ok) {
          throw new Error(`deleteSession failed: ${response.status} ${response.statusText}`);
        }
      },
    );
  }

  async abortSession(sessionId: string): Promise<void> {
    return this.request(
      `${this.baseUrl}/session/${sessionId}/abort`,
      { method: "POST" },
      (response) => {
        if (!response.ok) {
          throw new Error(`abortSession failed: ${response.status} ${response.statusText}`);
        }
      },
    );
  }

  async getSessionMessages(sessionId: string): Promise<unknown[]> {
    return this.request(
      `${this.baseUrl}/session/${sessionId}/message`,
      { method: "GET" },
      async (res) => {
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`getSessionMessages failed (${res.status}): ${body}`);
        }
        return (await res.json()) as unknown[];
      },
    );
  }

  async summarize(sessionId: string, providerID: string, modelID: string): Promise<void> {
    return this.request(
      `${this.baseUrl}/session/${sessionId}/summarize`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerID, modelID, auto: false }),
      },
      async (res) => {
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`summarize failed (${res.status}): ${body}`);
        }
      },
    );
  }

  async mcpStatus(directory?: string): Promise<Record<string, { status: string; error?: string }>> {
    const headers: Record<string, string> = {};
    if (directory) headers["x-opencode-directory"] = directory;
    return this.request(
      `${this.baseUrl}/mcp`,
      {
        method: "GET",
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
      async (res) => {
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`mcpStatus failed (${res.status}): ${body}`);
        }
        return (await res.json()) as Record<string, { status: string; error?: string }>;
      },
    );
  }

  async mcpConnect(name: string, directory?: string): Promise<boolean> {
    const headers: Record<string, string> = {};
    if (directory) headers["x-opencode-directory"] = directory;
    return this.request(
      `${this.baseUrl}/mcp/${encodeURIComponent(name)}/connect`,
      {
        method: "POST",
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
      (res) => res.ok,
    );
  }

  async mcpDisconnect(name: string, directory?: string): Promise<boolean> {
    const headers: Record<string, string> = {};
    if (directory) headers["x-opencode-directory"] = directory;
    return this.request(
      `${this.baseUrl}/mcp/${encodeURIComponent(name)}/disconnect`,
      {
        method: "POST",
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
      (res) => res.ok,
    );
  }

  async listProviders(): Promise<{
    all: Array<{ id: string; models: Record<string, unknown> }>;
    default: Record<string, string>;
    connected: string[];
  }> {
    return this.request(
      `${this.baseUrl}/provider`,
      { method: "GET" },
      async (res) => {
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`listProviders failed (${res.status}): ${body}`);
        }
        return (await res.json()) as {
          all: Array<{ id: string; models: Record<string, unknown> }>;
          default: Record<string, string>;
          connected: string[];
        };
      },
    );
  }
}
