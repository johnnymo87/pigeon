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
      lease.serveId !== a.desiredServeId
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

    this.repos.assignments.touchActive(sessionId, now);
    this.repos.leases.renewCAS(
      sessionId,
      r.serveId,
      r.instanceUuid,
      r.ownerGeneration,
      epoch,
      now,
      this.opts.leaseTtlMs,
    );
    this.sticky.route(sessionId, now, r.serveId);
    return r;
  }

  sweep(now: number): void {
    this.sticky.sweep(now, this.opts.dormantTtlMs);
    const expired = this.repos.leases.listExpired(now);
    for (const l of expired) {
      this.repos.assignments.setState(l.sessionId, "dormant", now);
      this.repos.leases.release(l.sessionId, l.serveId, l.instanceUuid, l.ownerGeneration, l.binaryEpoch);
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
      this.placeSession(a.sessionId, now);
    }
  }
}
