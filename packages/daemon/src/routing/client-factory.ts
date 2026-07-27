import { OpencodeClient } from "../opencode-client";
import { type IngressRouter, NoHealthyServeError } from "./router";
import type { OutcomeObservation } from "./serve-outcome";

/** Resolves an OpencodeClient bound to the serve that owns a given session. */
export class OpencodeClientFactory {
  private cache = new Map<string, OpencodeClient>(); // keyed by apiBase endpoint
  constructor(
    private router: Pick<IngressRouter, "ensureRouted">,
    private nowFn: () => number = Date.now,
    /**
     * Shadow-mode outcome tap (bead pigeon-f2a). Bound per endpoint below.
     * Optional, and observability only — nothing here affects routing.
     */
    private onOutcome?: (endpoint: string, obs: OutcomeObservation) => void,
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
      // The endpoint is captured, but attribution to a (serveId, instanceUuid)
      // is resolved by the sensor AT RECORD TIME. A serve that restarts keeps its
      // endpoint and gets a fresh instance_uuid, so binding attribution here
      // would credit a new process's outcomes to the dead one.
      const onOutcome = this.onOutcome;
      c = new OpencodeClient({
        baseUrl: apiBase,
        onOutcome: onOutcome ? (obs) => onOutcome(apiBase, obs) : undefined,
      });
      this.cache.set(apiBase, c);
    }
    return c;
  }
}
