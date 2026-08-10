import type { ServeInstanceRepo } from "./route-repo";
import type { IngressRouter } from "./router";
import { resolveServeAuthHeader, invalidateServeAuthHeader } from "../serve-auth";

export class ServeHealthPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private log: (msg: string, fields?: Record<string, unknown>) => void;

  constructor(
    private serves: ServeInstanceRepo,
    private router: Pick<IngressRouter, "reassignFromDeadServe">,
    private opts: {
      healthPollMs: number;
      fetchFn?: typeof fetch;
      nowFn?: () => number;
      timeoutMs?: number;
      log?: (msg: string, fields?: Record<string, unknown>) => void;
    },
  ) {
    this.log =
      opts.log ??
      ((msg, fields) => console.warn(`[serve-health] ${msg}`, fields ? JSON.stringify(fields) : ""));
  }

  async pollOnce(now = (this.opts.nowFn ?? Date.now)()): Promise<void> {
    const allServes = this.serves.all();
    const fetchFn = this.opts.fetchFn ?? globalThis.fetch;
    const timeoutMs = this.opts.timeoutMs ?? 2000;

    await Promise.all(
      allServes.map(async (s) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        let ok = false;
        try {
          const url = `${s.endpoint}/global/health`;
          const authHeader = resolveServeAuthHeader();
          const headers: Record<string, string> = {};
          if (authHeader) {
            headers["Authorization"] = authHeader;
          }
          const res = await fetchFn(url, {
            signal: controller.signal,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          });
          if (res.status === 401) {
            invalidateServeAuthHeader();
          }
          ok = res.ok;
        } catch (err) {
          // ignore error, ok remains false
        } finally {
          clearTimeout(timeoutId);
        }

        try {
          if (ok) {
            this.serves.setHealth(s.serveId, "healthy", now);
          } else {
            this.serves.setHealth(s.serveId, "unhealthy", now);
            try {
              this.router.reassignFromDeadServe(s.serveId, now);
            } catch (err) {
              // Swallow NoHealthyServeError / reassignment error to avoid interrupting the loop
            }
          }
        } catch (err) {
          // Wrap everything per serve so a db / state error doesn't halt others
        }
      })
    );
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.opts.healthPollMs);

    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  sweepStale(now: number, staleMs: number): void {
    const allServes = this.serves.all();
    for (const s of allServes) {
      if (s.healthState === "healthy" && s.heartbeatAt <= now - staleMs) {
        try {
          this.log("serve health stale sweep", {
            writer: "sweepStale",
            serveId: s.serveId,
            from: "healthy",
            to: "unhealthy",
            heartbeatAgeMs: now - s.heartbeatAt,
            staleMs,
          });
          this.serves.setHealthState(s.serveId, "unhealthy");
          try {
            this.router.reassignFromDeadServe(s.serveId, now);
          } catch (err) {
            // Swallow NoHealthyServeError / reassignment error per serve
          }
        } catch (err) {
          // Swallow DB / state errors per serve
        }
      }
    }
  }
}
