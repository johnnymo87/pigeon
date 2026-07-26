/**
 * Serve endpoint reconciler — makes the CONFIGURED pool endpoints authoritative
 * for `serve_instance.endpoint`, continuously.
 *
 * Why this exists (bead pigeon-13p, 2026-07-25 cloudbox incident):
 *
 * `registerSelf` on the serve side upserts `endpoint = excluded.endpoint`, so any
 * process that inherits OPENCODE_SERVE_ID + OPENCODE_ROUTING_DB from its parent
 * environment silently takes over that pool slot and points it at whatever port
 * it happened to bind. A throwaway `opencode serve` did exactly that, twice.
 *
 * The result was unhealable by every existing mechanism:
 *
 *  - The REAL serve keeps heartbeating the same row by serve_id, so
 *    `heartbeat_at` stays fresh and `health_state` stays 'healthy' forever. A
 *    live process therefore keeps a dead address marked healthy and no staleness
 *    TTL can ever fire (`IngressRouter.isServeHealthy` never looks at `endpoint`).
 *  - `seedServes`/`insertStubIfAbsent` uses ON CONFLICT DO NOTHING, so
 *    PIGEON_SERVE_ENDPOINTS only applies when the row is ABSENT. Restarting the
 *    daemon does not repair a wrong endpoint.
 *  - On cloudbox PIGEON_SERVE_LIVENESS=self, so the endpoint-reachability poller
 *    that would have caught it is not even running.
 *
 * 76 sessions were routed to a closed port and the frontdoor 502'd indefinitely.
 *
 * Two deliberate design choices:
 *
 * 1. CONTINUOUS, not boot-only. A boot-only reassert means a hijack persists until
 *    someone restarts the daemon — that is a manual runbook step wearing a
 *    self-heal costume. On the tick, drift self-heals within one poll interval.
 * 2. The reassert firing IS the alert condition. Detection and repair are the
 *    same code path, so there is no way to ship the repair without the signal.
 *    The incident cost hours precisely because nothing was loud.
 *
 * NOT in scope (bead pigeon-886): a serve that heartbeats but cannot answer HTTP
 * on its CONFIGURED endpoint still stays routed forever. This module only
 * guarantees the registry says what config says; it does not verify reachability.
 */
import type { ServeInstanceRepo } from "./route-repo";
import { serveIdForIndex } from "./serve-registry";

export interface EndpointDrift {
  serveId: string;
  /** The endpoint PIGEON_SERVE_ENDPOINTS says this slot must have. */
  configured: string;
  /** The endpoint we found in the registry, i.e. what the hijacker wrote. */
  found: string;
}

/** The narrow repo surface this module needs. */
export type EndpointReconcilerRepo = Pick<ServeInstanceRepo, "get" | "reassertEndpoint">;

/** Matches `StopNotifier.sendPlainAlert` — a session-free operational message. */
export interface EndpointDriftNotifier {
  sendPlainAlert?(text: string, severity: "info" | "warning" | "error"): Promise<void>;
}

export type ReconcilerLogger = (msg: string, fields?: Record<string, unknown>) => void;

/** Per-slot alert cooldown, so a pathological re-hijack loop cannot spam Telegram. */
export const DEFAULT_ALERT_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Pure repair pass. Rewrites `endpoint` for every CONFIGURED slot whose registry
 * row disagrees with config, and returns what it had to fix.
 *
 * Slots with no row yet are skipped — `seedServes` owns row creation, and
 * inserting here would let the reconciler manufacture serves. Rows for serve ids
 * outside the configured list are left alone, so shrinking K never mutates the
 * rows belonging to the retired slots.
 */
export function reconcileServeEndpoints(
  serves: EndpointReconcilerRepo,
  endpoints: readonly string[],
): EndpointDrift[] {
  const drifts: EndpointDrift[] = [];

  for (let i = 0; i < endpoints.length; i++) {
    const configured = endpoints[i]!;
    const serveId = serveIdForIndex(i);

    const row = serves.get(serveId);
    if (!row || row.endpoint === configured) {
      continue;
    }

    // Fenced on the value we just read: a concurrent registerSelf wins and we
    // re-observe next tick rather than clobbering a newer truth.
    if (serves.reassertEndpoint(serveId, configured, row.endpoint)) {
      drifts.push({ serveId, configured, found: row.endpoint });
    }
  }

  return drifts;
}

export interface ServeEndpointReconcilerOptions {
  serves: EndpointReconcilerRepo;
  endpoints: readonly string[];
  notifier?: EndpointDriftNotifier;
  log?: ReconcilerLogger;
  nowFn?: () => number;
  alertCooldownMs?: number;
  machineId?: string;
}

export class ServeEndpointReconciler {
  private readonly serves: EndpointReconcilerRepo;
  private readonly endpoints: readonly string[];
  private readonly notifier: EndpointDriftNotifier | undefined;
  private readonly log: ReconcilerLogger;
  private readonly nowFn: () => number;
  private readonly alertCooldownMs: number;
  private readonly machineId: string | undefined;

  /** serveId -> timestamp of the last alert we sent for that slot. */
  private readonly lastAlertAt = new Map<string, number>();

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ServeEndpointReconcilerOptions) {
    this.serves = opts.serves;
    this.endpoints = opts.endpoints;
    this.notifier = opts.notifier;
    this.log = opts.log ?? ((msg, fields) => {
      if (fields) {
        console.warn(`[endpoint-reconciler] ${msg}`, fields);
      } else {
        console.warn(`[endpoint-reconciler] ${msg}`);
      }
    });
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.alertCooldownMs = opts.alertCooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS;
    this.machineId = opts.machineId;
  }

  /**
   * One reconcile pass. The repair is synchronous and happens FIRST; alerting is
   * best-effort afterwards, so a Telegram outage can never block or undo it.
   */
  async tick(): Promise<EndpointDrift[]> {
    const drifts = reconcileServeEndpoints(this.serves, this.endpoints);
    if (drifts.length === 0) {
      return drifts;
    }

    const now = this.nowFn();
    for (const drift of drifts) {
      // Logged unconditionally — the cooldown throttles Telegram, never the record.
      this.log("serve endpoint drift repaired", {
        serveId: drift.serveId,
        found: drift.found,
        reassertedTo: drift.configured,
      });

      const last = this.lastAlertAt.get(drift.serveId);
      if (last !== undefined && now - last < this.alertCooldownMs) {
        continue;
      }
      this.lastAlertAt.set(drift.serveId, now);
      await this.alert(drift);
    }

    return drifts;
  }

  private async alert(drift: EndpointDrift): Promise<void> {
    if (!this.notifier?.sendPlainAlert) {
      return;
    }
    const where = this.machineId ? ` on ${this.machineId}` : "";
    const text =
      `routing registry hijack repaired${where}: ${drift.serveId} endpoint had drifted ` +
      `to ${drift.found}, reasserted ${drift.configured}. ` +
      `Some process claimed this pool slot — check for a stray "opencode serve" ` +
      `that inherited OPENCODE_SERVE_ID + OPENCODE_ROUTING_DB.`;
    try {
      await this.notifier.sendPlainAlert(text, "error");
    } catch (err) {
      this.log("drift alert send failed", {
        serveId: drift.serveId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Start the periodic reconcile loop. */
  start(intervalMs: number): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.log("tick failed", { error: err instanceof Error ? err.message : String(err) });
      });
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
