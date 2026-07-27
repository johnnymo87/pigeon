import { RequestTimeoutError, type OutcomeObservation } from "./routing/serve-outcome";
import { resolveServeAuthHeader, invalidateServeAuthHeader } from "./serve-auth";

interface OpencodeClientOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
  /** Per-request ceiling. See `fetchWithTimeout`. Defaults to 30s. */
  requestTimeoutMs?: number;
  /**
   * Shadow-mode observability tap (bead pigeon-f2a). Fires once per request with
   * the raw status or error; classification happens in the sensor, not here.
   *
   * Records only — it must not influence this client's behaviour, and today
   * nothing reads its output for routing. See routing/serve-outcome.ts.
   */
  onOutcome?: (obs: OutcomeObservation) => void;
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

  constructor(options: OpencodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onOutcome = options.onOutcome;
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
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const buildHeaders = (): Record<string, string> => {
      const authHeader = resolveServeAuthHeader();
      const authObj: Record<string, string> = authHeader ? { Authorization: authHeader } : {};
      const callerHeaders = (init.headers as Record<string, string> | undefined) ?? {};
      return {
        ...authObj,
        ...callerHeaders,
      };
    };

    const execFetch = async (): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await this.fetchFn(url, {
          ...init,
          headers: buildHeaders(),
          signal: controller.signal,
        });
        return response;
      } catch (err) {
        if (controller.signal.aborted) {
          const timeout = new RequestTimeoutError(this.requestTimeoutMs, url);
          this.observe({ error: timeout });
          throw timeout;
        }
        this.observe({ error: err as Error });
        throw err;
      } finally {
        clearTimeout(timer);
      }
    };

    let res = await execFetch();
    if (res.status === 401) {
      invalidateServeAuthHeader();
      res = await execFetch();
    }

    this.observe({ status: res.status });
    return res;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/global/health`, {
        method: "GET",
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async createSession(directory: string): Promise<{ id: string }> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/session`, {
      method: "POST",
      headers: { "x-opencode-directory": directory },
    });

    if (!response.ok) {
      throw new Error(`createSession failed: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<{ id: string }>;
  }

  /**
   * Look up a session by id. Returns null on 404 (session truly gone),
   * throws on other failures (network error, 5xx). The 404 vs throw split
   * lets callers distinguish "session deleted from opencode-serve" from
   * "opencode-serve is unreachable."
   */
  async getSession(sessionId: string): Promise<{ id: string; directory: string } | null> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}`, {
      method: "GET",
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      throw new Error(`getSession failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as { id?: string; directory?: string };
    if (!body || !body.id || !body.directory) {
      throw new Error(`getSession response missing id or directory: ${JSON.stringify(body)}`);
    }
    return { id: body.id, directory: body.directory };
  }

  async getSessionInfo(sessionId: string): Promise<{
    id: string;
    title: string;
    directory: string;
    time: { created: number; updated: number };
  } | null> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}`, {
      method: "GET",
    });

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
  }

  async sendPrompt(sessionId: string, directory: string, prompt: string): Promise<void> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: {
        "x-opencode-directory": directory,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
    });

    if (!response.ok) {
      throw new Error(`sendPrompt failed: ${response.status} ${response.statusText}`);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/session/${sessionId}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error(`deleteSession failed: ${response.status} ${response.statusText}`);
    }
  }

  async abortSession(sessionId: string): Promise<void> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/session/${sessionId}/abort`, {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(`abortSession failed: ${response.status} ${response.statusText}`);
    }
  }

  async getSessionMessages(sessionId: string): Promise<unknown[]> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/session/${sessionId}/message`, {
      method: "GET",
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`getSessionMessages failed (${res.status}): ${body}`);
    }
    return res.json();
  }

  async summarize(sessionId: string, providerID: string, modelID: string): Promise<void> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/session/${sessionId}/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerID, modelID, auto: false }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`summarize failed (${res.status}): ${body}`);
    }
  }

  async mcpStatus(directory?: string): Promise<Record<string, { status: string; error?: string }>> {
    const headers: Record<string, string> = {};
    if (directory) headers["x-opencode-directory"] = directory;
    const res = await this.fetchWithTimeout(`${this.baseUrl}/mcp`, {
      method: "GET",
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`mcpStatus failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<Record<string, { status: string; error?: string }>>;
  }

  async mcpConnect(name: string, directory?: string): Promise<boolean> {
    const headers: Record<string, string> = {};
    if (directory) headers["x-opencode-directory"] = directory;
    const res = await this.fetchWithTimeout(`${this.baseUrl}/mcp/${encodeURIComponent(name)}/connect`, {
      method: "POST",
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    return res.ok;
  }

  async mcpDisconnect(name: string, directory?: string): Promise<boolean> {
    const headers: Record<string, string> = {};
    if (directory) headers["x-opencode-directory"] = directory;
    const res = await this.fetchWithTimeout(`${this.baseUrl}/mcp/${encodeURIComponent(name)}/disconnect`, {
      method: "POST",
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    return res.ok;
  }

  async listProviders(): Promise<{
    all: Array<{ id: string; models: Record<string, unknown> }>;
    default: Record<string, string>;
    connected: string[];
  }> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/provider`, {
      method: "GET",
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`listProviders failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<{
      all: Array<{ id: string; models: Record<string, unknown> }>;
      default: Record<string, string>;
      connected: string[];
    }>;
  }
}
