import type { ServeInstanceRepo } from "./route-repo";
import type { IngressRouter } from "./router";

export class ServeHealthPoller {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private serves: ServeInstanceRepo,
    private router: Pick<IngressRouter, "reassignFromDeadServe">,
    private opts: {
      healthPollMs: number;
      fetchFn?: typeof fetch;
      nowFn?: () => number;
      timeoutMs?: number;
    },
  ) {}

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
          const res = await fetchFn(url, { signal: controller.signal });
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
}
