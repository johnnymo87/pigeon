import { StickyRouter } from "sticky-router";
import { pickServe } from "./rendezvous";
import type {
  ServeInstanceRepo,
  SessionAssignmentRepo,
  SessionLeaseRepo,
  RoutingMetaRepo,
} from "./route-repo";
import type {
  ServeInstanceRecord,
  RouteResult,
} from "./types";

export class NoHealthyServeError extends Error {
  constructor() {
    super("No healthy serves available");
    this.name = "NoHealthyServeError";
  }
}

export class LeaseContendedError extends Error {
  constructor(sessionId: string) {
    super(`Lease contended for session: ${sessionId}`);
    this.name = "LeaseContendedError";
  }
}

export class IngressRouter {
  private sticky: StickyRouter<string, string>;

  constructor(
    private repos: {
      serves: ServeInstanceRepo;
      assignments: SessionAssignmentRepo;
      leases: SessionLeaseRepo;
      meta: RoutingMetaRepo;
    },
    private opts: {
      leaseTtlMs: number;
      staleServeMs: number;
      idleMigrateMs: number;
      dormantTtlMs: number;
      activeTurnCap: number;
    },
  ) {
    this.sticky = new StickyRouter<string, string>(opts.idleMigrateMs);
  }

  private isServeHealthy(s: ServeInstanceRecord | null, now: number, epoch: number): boolean {
    return (
      !!s &&
      s.healthState === "healthy" &&
      s.heartbeatAt > now - this.opts.staleServeMs &&
      !s.draining &&
      s.binaryEpoch === epoch
    );
  }

  resolveRoute(sessionId: string, now: number): RouteResult | null {
    const epoch = this.repos.meta.get().binaryEpoch;
    const a = this.repos.assignments.get(sessionId);
    if (!a) {
      return null;
    }

    const serve = this.repos.serves.get(a.desiredServeId);
    if (!serve || !this.isServeHealthy(serve, now, epoch)) {
      return null;
    }

    const lease = this.repos.leases.get(sessionId);
    if (
      !lease ||
      lease.leaseExpiresAt <= now ||
      lease.ownerGeneration !== a.ownerGeneration ||
      lease.serveId !== a.desiredServeId ||
      // Defense-in-depth: reject a stale-epoch lease even if the serve has already
      // re-registered at the new epoch (the lease itself must be at the current epoch).
      lease.binaryEpoch !== epoch
    ) {
      return null;
    }

    return {
      sessionId,
      serveId: a.desiredServeId,
      instanceUuid: serve.instanceUuid,
      ownerGeneration: a.ownerGeneration,
      apiBase: serve.endpoint,
      eventUrl: `${serve.endpoint}/event?session_ids=${sessionId}`,
      expiresAt: lease.leaseExpiresAt,
    };
  }

  /**
   * Read-only PROSPECTIVE route for an IDLE session (resolveRoute returned null
   * because no valid+healthy lease is held). Predicts the serve the session will
   * (re)activate on so an idle TUI's stream is pre-positioned, instead of all
   * idle TUIs piling onto the default serve. Performs NO writes.
   *
   * Order: (gate) assignment must exist — a never-placed/deleted/garbage sid
   * returns null so GET /route still 404s (no phantom route; assignments are
   * deleted on session delete/reap). (1) honor a still-valid, current-epoch lease
   * on a non-draining serve — an unexpired lease proves the serve is alive even
   * if its heartbeat is stale (CPU-stalled owner), mirroring reassignFromDeadServe.
   * (2) else the assigned serve if currently healthy. (3) else a fresh HRW re-pick
   * over the healthy pool; null if empty (-> caller falls back to the default serve).
   */
  resolveProspectiveRoute(sessionId: string, now: number): RouteResult | null {
    const a = this.repos.assignments.get(sessionId);
    if (!a) {
      return null;
    }

    const epoch = this.repos.meta.get().binaryEpoch;

    const lease = this.repos.leases.get(sessionId);
    if (lease && lease.leaseExpiresAt > now && lease.binaryEpoch === epoch) {
      const leaseServe = this.repos.serves.get(lease.serveId);
      if (leaseServe && !leaseServe.draining) {
        return this.prospectiveResult(sessionId, lease.serveId, leaseServe, lease.ownerGeneration);
      }
    }

    const assigned = this.repos.serves.get(a.desiredServeId);
    if (assigned && this.isServeHealthy(assigned, now, epoch)) {
      return this.prospectiveResult(sessionId, a.desiredServeId, assigned, a.ownerGeneration);
    }

    const healthy = this.repos.serves.listHealthy(now, this.opts.staleServeMs, epoch);
    const chosen = pickServe(sessionId, healthy.map((s) => s.serveId));
    if (!chosen) {
      return null;
    }
    const chosenServe = healthy.find((s) => s.serveId === chosen)!;
    return this.prospectiveResult(sessionId, chosen, chosenServe, a.ownerGeneration);
  }

  private prospectiveResult(
    sessionId: string,
    serveId: string,
    serve: ServeInstanceRecord,
    ownerGeneration: number,
  ): RouteResult {
    return {
      sessionId,
      serveId,
      instanceUuid: serve.instanceUuid,
      ownerGeneration,
      apiBase: serve.endpoint,
      eventUrl: `${serve.endpoint}/event?session_ids=${sessionId}`,
      expiresAt: 0,
      prospective: true,
    };
  }

  placeSession(
    sessionId: string,
    now: number,
    directoryKey?: string | null,
  ): RouteResult {
    const epoch = this.repos.meta.get().binaryEpoch;
    const healthy = this.repos.serves.listHealthy(
      now,
      this.opts.staleServeMs,
      epoch,
    );
    const candidates = healthy.map((s) => s.serveId);
    if (candidates.length === 0) {
      throw new NoHealthyServeError();
    }

    // Bounded-load skip
    let eligible = candidates.filter(
      (id) => this.repos.assignments.countActiveForServe(id) < this.opts.activeTurnCap,
    );
    if (eligible.length === 0) {
      eligible = candidates;
    }

    const desired = pickServe(sessionId, eligible)!;
    let chosen = this.sticky.route(sessionId, now, desired);

    // Dead-serve guard: if sticky pin points at an unhealthy serve and we can't reset it,
    // override the output to a healthy serve. The stale pin self-heals on idle/sweep.
    if (!candidates.includes(chosen)) {
      chosen = desired;
    }

    const existing = this.repos.assignments.get(sessionId);
    const ownerGeneration = !existing
      ? 1
      : chosen !== existing.desiredServeId
      ? existing.ownerGeneration + 1
      : existing.ownerGeneration;

    this.repos.assignments.upsert({
      sessionId,
      directoryKey: directoryKey ?? existing?.directoryKey ?? null,
      desiredServeId: chosen,
      ownerGeneration,
      state: "assigned",
      lastActiveAt: now,
      updatedAt: now,
    });

    const serve = this.repos.serves.get(chosen)!;
    const acquired = this.repos.leases.acquireCAS(
      {
        sessionId,
        serveId: chosen,
        instanceUuid: serve.instanceUuid,
        ownerGeneration,
        binaryEpoch: epoch,
      },
      now,
      this.opts.leaseTtlMs,
    );

    if (!acquired) {
      const r = this.resolveRoute(sessionId, now);
      if (r) {
        return r;
      }
      throw new LeaseContendedError(sessionId);
    }

    return {
      sessionId,
      serveId: chosen,
      instanceUuid: serve.instanceUuid,
      ownerGeneration,
      apiBase: serve.endpoint,
      eventUrl: `${serve.endpoint}/event?session_ids=${sessionId}`,
      expiresAt: now + this.opts.leaseTtlMs,
    };
  }

  ensureRouted(sessionId: string, now: number): RouteResult {
    return this.resolveRoute(sessionId, now) ?? this.placeSession(sessionId, now);
  }

  touch(sessionId: string, now: number): RouteResult | null {
    const epoch = this.repos.meta.get().binaryEpoch;
    const r = this.resolveRoute(sessionId, now);
    if (!r) {
      return null;
    }

    // Fail closed: if the lease can no longer be renewed (generation or epoch bumped
    // underneath us), we have lost ownership — do NOT report the session as still routed.
    const renewed = this.repos.leases.renewCAS(
      sessionId,
      r.serveId,
      r.instanceUuid,
      r.ownerGeneration,
      epoch,
      now,
      this.opts.leaseTtlMs,
    );
    if (!renewed) {
      return null;
    }
    this.repos.assignments.touchActive(sessionId, now);
    this.sticky.route(sessionId, now, r.serveId);
    return r;
  }

  sweep(now: number): void {
    this.sticky.sweep(now, this.opts.dormantTtlMs);
    const expired = this.repos.leases.listExpired(now);
    for (const l of expired) {
      // Release FIRST with the full token: if a newer owner has already replaced this
      // lease (concurrent re-route), release no-ops and we must NOT touch the assignment.
      const released = this.repos.leases.release(
        l.sessionId,
        l.serveId,
        l.instanceUuid,
        l.ownerGeneration,
        l.binaryEpoch,
      );
      if (released) {
        // Fenced by serve + generation so we only dormant-mark the assignment we just expired.
        this.repos.assignments.setDormantFenced(l.sessionId, l.serveId, l.ownerGeneration, now);
      }
    }
  }

  rebuildFromDb(): void {
    const allAssignments = this.repos.assignments.all();
    for (const a of allAssignments) {
      this.sticky.route(a.sessionId, a.lastActiveAt, a.desiredServeId);
    }
  }

  reassignFromDeadServe(serveId: string, now: number): void {
    const assignments = this.repos.assignments.listForServe(serveId);
    for (const a of assignments) {
      // Do NOT evict a session whose lease on this serve is still valid. A
      // stale heartbeat can falsely flag a live-but-busy single-threaded serve
      // as dead (its event loop is blocked by a CPU-heavy turn for longer than
      // staleServeMs), but only the owning serve can renew its own lease
      // (renewCAS is full-token fenced), so an unexpired lease proves the serve
      // is still alive and actively running the turn. Migrating it here bumps
      // owner_generation and yanks the lease out from under the in-flight run,
      // killing it with "session lease lost mid-run". A genuinely dead serve
      // stops renewing, so its lease expires within leaseTtlMs and the session
      // becomes eligible for reassignment on the next sweep/poll.
      const lease = this.repos.leases.get(a.sessionId);
      if (lease && lease.serveId === serveId && lease.leaseExpiresAt > now) {
        continue;
      }
      this.placeSession(a.sessionId, now);
    }
  }
}
