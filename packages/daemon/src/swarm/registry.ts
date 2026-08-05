import { resolveServeAuthHeader, invalidateServeAuthHeader } from "../serve-auth";
import { RequestTimeoutError } from "../routing/serve-outcome";

/** Ceiling for a single session lookup, headers AND body. See `resolve`. */
export const DEFAULT_REGISTRY_TIMEOUT_MS = 10_000;

export interface RegistryOptions {
  baseUrl: string; // opencode serve base, e.g. http://127.0.0.1:4096
  ttlMs: number;
  fetchFn?: typeof fetch;
  nowFn?: () => number;
  /** Per-lookup ceiling. Defaults to `DEFAULT_REGISTRY_TIMEOUT_MS`. */
  requestTimeoutMs?: number;
}

interface CacheEntry {
  directory: string;
  expiresAt: number;
}

export class SessionDirectoryRegistry {
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly nowFn: () => number;
  private readonly requestTimeoutMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: RegistryOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.ttlMs = opts.ttlMs;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS;
  }

  /**
   * Look up a session's directory, bounded end to end (pigeon-wfj1).
   *
   * This had no bound at all -- no signal, no timeout, on either the header or
   * the body phase. It is reached from the SwarmArbiter through
   * `makeDirectoryResolver`, which wraps it in a try/catch that CANNOT help:
   * the failure mode is a promise that never settles, not one that rejects.
   * The arbiter is at-most-one-in-flight per target and releases the slot in a
   * `.finally()`, so a hang here wedges delivery to that session permanently.
   */
  async resolve(sessionId: string): Promise<string> {
    const now = this.nowFn();
    const hit = this.cache.get(sessionId);
    if (hit && hit.expiresAt > now) return hit.directory;

    const authHeader = resolveServeAuthHeader();
    const headers: Record<string, string> = {};
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }

    const url = `${this.baseUrl}/session/${encodeURIComponent(sessionId)}`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new RequestTimeoutError(this.requestTimeoutMs, url));
      }, this.requestTimeoutMs);
    });
    // Losers of the races below reject into the void; without a handler that is
    // an unhandled rejection.
    deadline.catch(() => {});
    // Aborting makes the in-flight fetch (and any in-flight body read) reject
    // with AbortError, which RACES the deadline's own rejection -- so without
    // this conversion the caller sometimes sees a bare "The operation was
    // aborted." instead of a timeout, depending on which rejection lands first.
    const withDeadline = async <R>(p: Promise<R>): Promise<R> => {
      p.catch(() => {});
      try {
        return await Promise.race([p, deadline]);
      } catch (err) {
        if (controller.signal.aborted && !(err instanceof RequestTimeoutError)) {
          throw new RequestTimeoutError(this.requestTimeoutMs, url);
        }
        throw err;
      }
    };

    try {
      const res = await withDeadline(
        this.fetchFn(url, {
          method: "GET",
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          signal: controller.signal,
        }),
      );
      if (res.status === 401) {
        invalidateServeAuthHeader();
      }
      if (!res.ok) {
        throw new Error(
          `session lookup failed: ${res.status} ${await withDeadline(res.text())}`,
        );
      }
      const body = (await withDeadline(res.json())) as {
        id?: string;
        directory?: string;
      };
      if (!body.directory) {
        throw new Error(
          `session response missing directory: ${JSON.stringify(body)}`,
        );
      }
      this.cache.set(sessionId, {
        directory: body.directory,
        expiresAt: now + this.ttlMs,
      });
      return body.directory;
    } finally {
      clearTimeout(timer);
    }
  }

  invalidate(sessionId: string): void {
    this.cache.delete(sessionId);
  }
}
