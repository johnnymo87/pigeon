/**
 * Serve health-state transition observer — makes serve health transitions visible.
 *
 * ── WHY THIS IS AN OBSERVER ───────────────────────────────────────────────────
 *
 * `serve_instance.health_state` has MULTIPLE writers, and the most important one is
 * NOT in this process:
 *
 *  - In `self` liveness mode — which ALL THREE production hosts run (`config.ts`,
 *    `index.ts`, design doc docs/plans/2026-07-27-serve-serviceability-design.md §1)
 *    — the patched opencode serve writes `health_state='healthy'` itself,
 *    unconditionally every 5s, from a worker thread, OUT OF PROCESS (it holds the
 *    same sqlite file open).
 *  - Pigeon's ONLY in-process production writer is `ServeHealthPoller.sweepStale` ->
 *    `setHealthState('unhealthy')`.
 *  - `pollOnce` writes both states but is wired ONLY in `http` mode (never in prod).
 *
 * There are in fact THREE serve-side writers of `health_state='healthy'`, all of
 * them out-of-process: the 5s heartbeat and `registerSelf` at boot
 * (opencode-patched `patches/serve-lease.patch`), and the drift repair `selfHeal`
 * (`patches/registry-port-fence.patch`), whose UPDATE sets `health_state='healthy'`
 * despite a comment above it claiming it owns "instance_uuid / endpoint / draining
 * and nothing else".
 *
 * Consequence: logging inside write-site methods (`setHealth`/`setHealthState`)
 * would capture only the unhealthy edge in production and would be structurally
 * BLIND to a serve REJOINING the healthy pool — which is the exact transition this
 * bead exists to make visible.
 *
 * In self mode a `to: "healthy"` observed transition therefore means "the serve
 * wrote it", not "the heartbeat wrote it" — it could be any of those three. The
 * logged `instanceUuid` is what separates them: unchanged means the same process
 * resurrected itself, changed means it restarted and re-registered.
 *
 * Also note that the observer and the sweep run on separate intervals of the same
 * period, so a sweepStale-caused transition may produce its own line one tick AFTER
 * the sweepStale line for the same event — two lines ~5s apart for one event is
 * expected, not a double-fire.
 *
 * ── READ-ONLY RULE ────────────────────────────────────────────────────────────
 *
 * READ-ONLY. The observer must never write to serve_instance. The moment it
 * "corrects" state it becomes a second writer, violating the design doc's rule 3
 * (only the serve owns its liveness columns).
 */
import type { ServeInstanceRepo } from "./route-repo";

export type HealthTransitionLogger = (msg: string, fields?: Record<string, unknown>) => void;

export type HealthObserverRepo = Pick<ServeInstanceRepo, "all">;

export interface HealthTransitionObserverOptions {
  serves: HealthObserverRepo;
  log?: HealthTransitionLogger;
  nowFn?: () => number;
}

export class HealthTransitionObserver {
  private readonly serves: HealthObserverRepo;
  private readonly log: HealthTransitionLogger;
  private readonly nowFn: () => number;

  private readonly lastObserved = new Map<string, string>();
  private initialized = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: HealthTransitionObserverOptions) {
    this.serves = opts.serves;
    this.log = opts.log ?? ((msg, fields) => {
      console.warn(`[serve-health] ${msg}`, fields ? JSON.stringify(fields) : "");
    });
    this.nowFn = opts.nowFn ?? (() => Date.now());
  }

  /**
   * One diff pass over `serve_instance`.
   *
   * First tick after construction/restart emits exactly ONE baseline line listing
   * every serve and its current state (a `baseline` marker field), NOT a set of
   * synthetic transitions. Rationale: the repo's doctrine is that absence of a log
   * line is not a positive statement (see flap-detector.ts:474-479); a restart must
   * not fabricate transitions that did not occur, but must also not go silently dark
   * about where the pool started.
   */
  tick(now = this.nowFn()): void {
    const serves = this.serves.all();

    if (!this.initialized) {
      this.initialized = true;
      for (const s of serves) {
        this.lastObserved.set(s.serveId, s.healthState);
      }
      const poolStr = serves.map((s) => `${s.serveId}:${s.healthState}`).join(",");
      this.log("serve health baseline", { baseline: true, pool: poolStr });
      return;
    }

    for (const s of serves) {
      const prev = this.lastObserved.get(s.serveId);
      if (prev === undefined) {
        // A serve appearing for the first time on a LATER tick (new row added after
        // baseline) is recorded into observed state without generating a fake transition.
        this.lastObserved.set(s.serveId, s.healthState);
        continue;
      }

      if (prev !== s.healthState) {
        this.lastObserved.set(s.serveId, s.healthState);
        this.log("serve health state transition", {
          serveId: s.serveId,
          from: prev,
          to: s.healthState,
          heartbeatAgeMs: now - s.heartbeatAt,
          instanceUuid: s.instanceUuid,
          binaryEpoch: s.binaryEpoch,
          draining: s.draining,
          writer: "observed",
        });
      }
    }
  }

  /**
   * `tick()` wrapped in try/catch to ensure errors are caught and logged.
   */
  safeTick(now = this.nowFn()): void {
    try {
      this.tick(now);
    } catch (err) {
      this.log("tick failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  start(intervalMs: number): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      this.safeTick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
