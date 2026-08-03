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
import type { ReassignmentEventRepo } from "./reassignment-repo";

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

/** Structured logger, matching the shape used by the flap detector and outcome sensor. */
export type RouterLogger = (msg: string, fields?: Record<string, unknown>) => void;

export class IngressRouter {
  private sticky: StickyRouter<string, string>;
  private readonly log: RouterLogger;

  constructor(
    private repos: {
      serves: ServeInstanceRepo;
      assignments: SessionAssignmentRepo;
      leases: SessionLeaseRepo;
      meta: RoutingMetaRepo;
      /**
       * Dated log of serve moves (bead pigeon-f2a). OPTIONAL: several call sites
       * build this repo bag by hand, and observability must never be a
       * precondition for routing.
       */
      reassignments?: Pick<ReassignmentEventRepo, "record">;
    },
    private opts: {
      leaseTtlMs: number;
      staleServeMs: number;
      idleMigrateMs: number;
      dormantTtlMs: number;
      activeTurnCap: number;
      log?: RouterLogger;
    },
  ) {
    this.sticky = new StickyRouter<string, string>(opts.idleMigrateMs);
    this.log = opts.log ?? ((msg, fields) => {
      console.log(`[router] ${msg}`, fields ? JSON.stringify(fields) : "");
    });
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

    // Lease FIRST, liveness second (bead pigeon-pov). An unexpired, full-token
    // lease PROVES the owning serve is alive: only that serve can renew it, and
    // renewCAS is fenced on (serve, instance_uuid, generation, epoch) plus the
    // assignment. A single-threaded opencode serve whose event loop is blocked by
    // a CPU-heavy turn misses heartbeats for >staleServeMs while the run is
    // perfectly healthy, so gating on heartbeat freshness here used to declare a
    // live session unroutable -- and ensureRouted then called placeSession, which
    // bumps owner_generation and steals the lease via the acquireCAS take-over
    // ladder, killing the in-flight turn ("session lease lost mid-run", June).
    // reassignFromDeadServe and resolveProspectiveRoute already encode this rule;
    // resolveRoute was the sole holdout contradicting it.
    //
    // SCOPE, stated plainly so the next incident does not "disprove" this fix.
    // The lease is renewed by the SERVE ITSELF, out of process: the patched
    // opencode serve holds this SQLite file open and refreshes its own
    // session_lease row on a ~leaseTtlMs/3 fiber. Nothing in the DAEMON renews --
    // renewCAS's only TS caller is touch(), which has no callers -- so do not
    // conclude from "no TS caller" that renewal does not happen. (It was concluded
    // here once, and it was wrong: verified by sampling session_lease 40s apart,
    // longer than the 30s TTL, and seeing every row's expiry advance by exactly
    // the elapsed time with zero generation changes, plus the serve PIDs holding
    // this .db open in /proc/<pid>/fd.)
    //
    // That renewal fiber lives inside the serve's own single-threaded event loop
    // -- the same loop a CPU-heavy turn blocks. So a stall stops renewal too, and
    // the lease lapses ~leaseTtlMs after the last successful renew. This fix
    // therefore protects a stall only up to roughly leaseTtlMs; a longer stall
    // lapses the lease, resolveRoute goes null again, and placeSession clobbers as
    // before. It narrows the window; it does not close it (bead pigeon-u1a).
    //
    // It also slows failover for a GENUINELY dead serve: commands now fail with
    // connection errors until the lease lapses instead of migrating on the next
    // health probe. That is the identical trade reassignFromDeadServe already
    // makes deliberately, and lease expiry bounds it.
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

    // The serve record must still exist and be at the current epoch, and a
    // DRAINING serve must still shed its sessions even while its lease is valid
    // (that is the whole point of drain). Deliberately NOT isServeHealthy: the
    // healthState and heartbeat clauses are exactly what the lease supersedes.
    const serve = this.repos.serves.get(a.desiredServeId);
    if (!serve || serve.draining || serve.binaryEpoch !== epoch) {
      return null;
    }

    // Positive signal that this fix fired. Production has no other way to observe
    // it: there is no health-state-change log (bead pigeon-f02) and five days of
    // daemon journal contain zero [router] lines. Bounded by command rate and
    // gated on a rare condition (a stall in progress), so it cannot become chatty.
    if (!this.isServeHealthy(serve, now, epoch)) {
      this.log("honoring a valid lease on a serve that looks unhealthy (CPU-stalled owner)", {
        sessionId,
        serveId: a.desiredServeId,
        healthState: serve.healthState,
        heartbeatAgeMs: now - serve.heartbeatAt,
        staleServeMs: this.opts.staleServeMs,
        leaseExpiresAt: lease.leaseExpiresAt,
      });
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

    // Bounded-load skip. Load is LIVE LEASES, never `session_assignment` rows — see
    // SessionLeaseRepo.countLiveForServe and bead pigeon-76k for why the old counter
    // turned this filter into a magnet. The session being placed is excluded from its
    // own serve's load, so re-placing an idle session is a fixed point rather than a
    // self-eviction.
    const load = new Map(
      candidates.map((id) => [
        id,
        this.repos.leases.countLiveForServe(id, now, epoch, sessionId),
      ]),
    );
    let eligible = candidates.filter((id) => load.get(id)! < this.opts.activeTurnCap);
    const narrowed = eligible.length > 0 && eligible.length < candidates.length;
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

    // Narrowing the pool is allowed — with a truthful counter, steering placements
    // toward the serves that still have capacity is the point — but it is an overload
    // decision and must never be silent. Nobody could see the narrowing that drove the
    // 2026-08-02 flap for thirty hours, which is most of why it took DB archaeology to
    // find. Logged AFTER the sticky pin resolves, because a pinned session can still
    // land on an over-cap serve and a log line that reported only the filter's input
    // would describe a placement that did not happen.
    if (narrowed) {
      this.log("bounded-load skip narrowed the eligible pool", {
        sessionId,
        candidates,
        eligible,
        chosen,
        activeTurnCap: this.opts.activeTurnCap,
        liveLeases: Object.fromEntries(load),
      });
    }

    // Tripwire (bead pigeon-pov): placeSession is about to kill an in-flight turn.
    // After the resolveRoute fix, ensureRouted no longer reaches here with a valid
    // lease and reassignFromDeadServe skips such sessions outright, so a hit is
    // normally a regression.
    //
    // DRAIN IS EXCLUDED, and deliberately so: evicting a busy session off a
    // draining serve is the POINT of drain (resolveRoute rejects draining, which
    // routes us straight here), so a drain of a busy serve would otherwise fire
    // this on every session and train the reader to ignore it. This log is only
    // worth having if it stays rare, so it must not cry wolf during a routine
    // pool bounce or an operator eviction.
    //
    // Logged BEFORE the assignment upsert, while the prior lease is still
    // observable.
    const priorLease = this.repos.leases.get(sessionId);
    const priorServe = priorLease ? this.repos.serves.get(priorLease.serveId) : undefined;
    if (
      priorLease &&
      priorLease.leaseExpiresAt > now &&
      priorLease.binaryEpoch === epoch &&
      priorLease.serveId !== chosen &&
      !priorServe?.draining
    ) {
      this.log("placeSession is displacing a LIVE lease (in-flight turn will be killed)", {
        sessionId,
        leaseServeId: priorLease.serveId,
        chosen,
        leaseOwnerGeneration: priorLease.ownerGeneration,
        leaseExpiresAt: priorLease.leaseExpiresAt,
      });
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

    // Flap instrumentation (pigeon-f2a). Recorded AFTER the upsert, so the log
    // reflects moves that were actually committed, and only for genuine moves —
    // a first placement is session creation, not flapping, and counting it would
    // drown the rate signal in ordinary traffic.
    //
    // Wrapped because this is the live routing path: `owner_generation` is
    // already durably bumped by the line above, and an observability insert that
    // hits SQLITE_BUSY (which happens on this shared DB when serves restart
    // together) must degrade to a missing metric, never to a failed route.
    if (existing && chosen !== existing.desiredServeId) {
      try {
        this.repos.reassignments?.record({
          sessionId,
          fromServeId: existing.desiredServeId,
          toServeId: chosen,
          ownerGeneration,
          at: now,
        });
      } catch {
        // Intentionally swallowed. See above.
      }
    }

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

  /**
   * Renew the lease of a session that is still validly routed.
   *
   * NOTE (bead pigeon-pov): this method has NO production callers, and it is the
   * only TS caller of renewCAS. That does NOT mean leases go unrenewed — the
   * patched opencode serve renews its own lease out of process by writing this
   * SQLite file directly. Do not follow the dead-code thread from here into
   * deleting renewCAS or the session_lease renewal SQL: that would silently break
   * out-of-process renewal, and no test in this repo would catch it.
   *
   * If you wire one up, mind the liveness gate below. resolveRoute now honors a
   * valid lease over a stale heartbeat, which is right for ROUTING (the owner is
   * probably just CPU-stalled) but would be catastrophic for RENEWAL: renewCAS is
   * full-token fenced, so for a serve that is genuinely dead and has not
   * re-registered, the token still matches and a periodic touch() would extend
   * the corpse's lease forever. The lease would never expire, placeSession would
   * never run, and the session would be pinned to a dead serve permanently.
   * Renewal therefore fails closed on liveness, which routing does not.
   */
  touch(sessionId: string, now: number): RouteResult | null {
    const epoch = this.repos.meta.get().binaryEpoch;
    const r = this.resolveRoute(sessionId, now);
    if (!r) {
      return null;
    }

    // See the docstring: renewal, unlike routing, must not trust a lease alone.
    const serve = this.repos.serves.get(r.serveId);
    if (!this.isServeHealthy(serve ?? null, now, epoch)) {
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
