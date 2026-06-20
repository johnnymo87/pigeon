import { OpencodeClient } from "../opencode-client";
import { type IngressRouter, NoHealthyServeError } from "./router";

/** Resolves an OpencodeClient bound to the serve that owns a given session. */
export class OpencodeClientFactory {
  private cache = new Map<string, OpencodeClient>(); // keyed by apiBase endpoint
  constructor(
    private router: Pick<IngressRouter, "ensureRouted">,
    private nowFn: () => number = Date.now,
  ) {}

  /** The owning serve's client, or undefined if the session can't currently be routed (no healthy serve). */
  forSession(sessionId: string): OpencodeClient | undefined {
    let apiBase: string;
    try {
      apiBase = this.router.ensureRouted(sessionId, this.nowFn()).apiBase;
    } catch (err) {
      if (err instanceof NoHealthyServeError) return undefined;
      throw err;
    }
    return this.forEndpoint(apiBase);
  }

  /** Get-or-create a cached client for a serve endpoint. */
  forEndpoint(apiBase: string): OpencodeClient {
    let c = this.cache.get(apiBase);
    if (!c) {
      c = new OpencodeClient({ baseUrl: apiBase });
      this.cache.set(apiBase, c);
    }
    return c;
  }
}
