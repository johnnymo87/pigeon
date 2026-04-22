export interface RegistryOptions {
  baseUrl: string; // opencode serve base, e.g. http://127.0.0.1:4096
  ttlMs: number;
  fetchFn?: typeof fetch;
  nowFn?: () => number;
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
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: RegistryOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.ttlMs = opts.ttlMs;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.nowFn = opts.nowFn ?? (() => Date.now());
  }

  async resolve(sessionId: string): Promise<string> {
    const now = this.nowFn();
    const hit = this.cache.get(sessionId);
    if (hit && hit.expiresAt > now) return hit.directory;

    const res = await this.fetchFn(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}`,
      { method: "GET" },
    );
    if (!res.ok) {
      throw new Error(
        `session lookup failed: ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { id?: string; directory?: string };
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
  }

  invalidate(sessionId: string): void {
    this.cache.delete(sessionId);
  }
}
