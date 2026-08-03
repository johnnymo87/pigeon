import { describe, expect, it } from "vitest";
import { openStorageDb } from "../../src/storage/database";
import { pickServe } from "../../src/routing/rendezvous";
import { IngressRouter, NoHealthyServeError, LeaseContendedError } from "../../src/routing/router";
import type { ServeInstanceRecord } from "../../src/routing/types";

/**
 * Find a session id whose HRW top choice within `pool` is `serveId`.
 *
 * HRW is a pure hash of (serveId, sessionId), so capacity tests have to search
 * for an id rather than assert one: the point of the bounded-load tests is that a
 * session is diverted AWAY from the serve it actually prefers, which is only
 * meaningful if we know which serve that is.
 */
function sessionPreferring(serveId: string, pool: string[], ...exclude: string[]): string {
  for (let i = 0; i < 10_000; i++) {
    const sid = `session-prefers-${serveId}-${i}`;
    if (!exclude.includes(sid) && pickServe(sid, pool) === serveId) {
      return sid;
    }
  }
  throw new Error(`no session id found preferring ${serveId}`);
}

describe("IngressRouter Service Logic", () => {
  // Test 1: New placement
  it("New placement: one healthy serve seeded -> route assignment + lease", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    const now = 10_000;
    const serve: ServeInstanceRecord = {
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    s.serves.upsert(serve);

    const res = router.ensureRouted("session-1", now);
    expect(res).not.toBeNull();
    expect(res.serveId).toBe("serve-1");
    expect(res.instanceUuid).toBe("uuid-1");
    expect(res.ownerGeneration).toBe(1);
    expect(res.apiBase).toBe("http://localhost:8001");
    expect(res.eventUrl).toBe("http://localhost:8001/event?session_ids=session-1");
    expect(res.expiresAt).toBe(now + 5000);

    // Verify assignment and lease exist in DB
    const ass = s.assignments.get("session-1");
    expect(ass).not.toBeNull();
    expect(ass?.desiredServeId).toBe("serve-1");
    expect(ass?.ownerGeneration).toBe(1);
    expect(ass?.state).toBe("assigned");

    const lease = s.leases.get("session-1");
    expect(lease).not.toBeNull();
    expect(lease?.serveId).toBe("serve-1");
    expect(lease?.ownerGeneration).toBe(1);
    expect(lease?.leaseExpiresAt).toBe(now + 5000);
  });

  // Test 2: Resolve hit, no bump
  it("Resolve hit, no bump: multiple calls to ensureRouted reuse route without bumping generation", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    const now = 10_000;
    const serve: ServeInstanceRecord = {
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    s.serves.upsert(serve);

    const res1 = router.ensureRouted("session-1", now);
    const res2 = router.ensureRouted("session-1", now + 1000);

    expect(res2).toEqual(res1);
    expect(res2.ownerGeneration).toBe(1);
    const ass = s.assignments.get("session-1");
    expect(ass?.ownerGeneration).toBe(1);
  });

  // Test 3: Crash migration
  it("Crash migration: if old serve is unhealthy, migrates to new serve and increments generation", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    let now = 10_000;
    const s1: ServeInstanceRecord = {
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    const s2: ServeInstanceRecord = {
      serveId: "serve-2",
      instanceUuid: "uuid-2",
      endpoint: "http://localhost:8002",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    s.serves.upsert(s1);
    s.serves.upsert(s2);

    // Initial placement (say it lands on serve-1)
    const res1 = router.placeSession("session-1", now);
    const firstServe = res1.serveId;

    // Mark that serve unhealthy
    s.serves.setHealth(firstServe, "unhealthy", now);

    // Resolve should be null because serve is unhealthy
    const r = router.resolveRoute("session-1", now);
    expect(r).toBeNull();

    // Now call ensureRouted again. It should migrate to the other serve.
    const res2 = router.ensureRouted("session-1", now);
    expect(res2.serveId).not.toBe(firstServe);
    expect(res2.ownerGeneration).toBe(2);

    const ass = s.assignments.get("session-1");
    expect(ass?.ownerGeneration).toBe(2);
    expect(ass?.desiredServeId).toBe(res2.serveId);

    const lease = s.leases.get("session-1");
    expect(lease?.ownerGeneration).toBe(2);
    expect(lease?.serveId).toBe(res2.serveId);
  });

  // Test 4: Stickiness vs idle-migration
  it("Stickiness vs idle-migration: stays on S0 within idleMigrateMs, migrates to S1 after idleMigrateMs", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 10000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    let now = 10_000;
    // Find a sessionId that picks S1 if both are candidates, but S0 when S0 is the only option.
    let sessionId = "";
    for (let i = 0; i < 1000; i++) {
      const candidate = `session-${i}`;
      if (pickServe(candidate, ["serve-0", "serve-1"]) === "serve-1") {
        sessionId = candidate;
        break;
      }
    }
    expect(sessionId).not.toBe("");

    // S0 is healthy initially
    const s0: ServeInstanceRecord = {
      serveId: "serve-0",
      instanceUuid: "uuid-0",
      endpoint: "http://localhost:8000",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    s.serves.upsert(s0);

    // Initial placement goes to S0 since it's the only healthy serve
    const res1 = router.ensureRouted(sessionId, now);
    expect(res1.serveId).toBe("serve-0");

    // S1 becomes healthy
    const s1: ServeInstanceRecord = {
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    s.serves.upsert(s1);

    // Call touch or keep-alive within idleMigrateMs. It should remain on S0 due to stickiness.
    now += 1000; // 1s idle (less than idleMigrateMs=3s)
    const res2 = router.touch(sessionId, now);
    expect(res2?.serveId).toBe("serve-0");

    // Even if we placeSession, because of stickiness activity being warm, it should keep S0
    now += 1500; // another 1.5s (cumulative idle is 1.5s since the last touch)
    const res3 = router.placeSession(sessionId, now);
    expect(res3.serveId).toBe("serve-0");

    // Now let idle time pass beyond idleMigrateMs without touch/activity
    now += 3100; // 3.1s since last placeSession
    const res4 = router.placeSession(sessionId, now);
    expect(res4.serveId).toBe("serve-1"); // migrated to S1 (highest HRW score pick)
    expect(res4.ownerGeneration).toBe(2);
  });

  // Test 5: NoHealthyServeError
  it("NoHealthyServeError: throws if there are no healthy serves", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    expect(() => router.placeSession("session-1", 10_000)).toThrow(NoHealthyServeError);
  });

  // Test 6: rebuildFromDb
  it("rebuildFromDb: constructs a fresh IngressRouter and recovers pins from db", () => {
    const s = openStorageDb(":memory:");

    const now = 10_000;
    // Populate rows directly to simulate prior state
    const serve: ServeInstanceRecord = {
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    s.serves.upsert(serve);

    s.assignments.upsert({
      sessionId: "session-1",
      directoryKey: null,
      desiredServeId: "serve-1",
      ownerGeneration: 1,
      state: "assigned",
      lastActiveAt: now,
      updatedAt: now,
    });

    s.leases.acquireCAS({
      sessionId: "session-1",
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      ownerGeneration: 1,
      binaryEpoch: 0,
    }, now, 5000);

    // Construct fresh router
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    router.rebuildFromDb();

    // Resolving route should work immediately without placement
    const res = router.resolveRoute("session-1", now);
    expect(res).not.toBeNull();
    expect(res?.serveId).toBe("serve-1");
    expect(res?.ownerGeneration).toBe(1);
  });

  // Test 7: reassignFromDeadServe
  it("reassignFromDeadServe: forces migration from dead serve to healthy one", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    const now = 10_000;
    const s1: ServeInstanceRecord = {
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    const s2: ServeInstanceRecord = {
      serveId: "serve-2",
      instanceUuid: "uuid-2",
      endpoint: "http://localhost:8002",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    s.serves.upsert(s1);
    s.serves.upsert(s2);

    // Place both on serve-1 by forcing candidate pool to just s1 initially
    s.serves.setHealth("serve-2", "unhealthy", now);
    router.ensureRouted("session-1", now);
    router.ensureRouted("session-2", now);

    expect(s.assignments.get("session-1")?.desiredServeId).toBe("serve-1");
    expect(s.assignments.get("session-2")?.desiredServeId).toBe("serve-1");

    // Now, mark serve-1 unhealthy. serve-1 is a TRULY dead serve here: it stops
    // renewing, so once we advance past the lease TTL (5000) its leases expire
    // and the sessions become eligible for reassignment.
    s.serves.setHealth("serve-1", "unhealthy", now);
    const later = now + 6000;
    s.serves.setHealth("serve-2", "healthy", later);

    // Trigger reassignFromDeadServe after the dead serve's leases have expired.
    router.reassignFromDeadServe("serve-1", later);

    // Both should now resolve on serve-2 with generation 2
    const res1 = router.resolveRoute("session-1", later);
    const res2 = router.resolveRoute("session-2", later);

    expect(res1?.serveId).toBe("serve-2");
    expect(res1?.ownerGeneration).toBe(2);
    expect(res2?.serveId).toBe("serve-2");
    expect(res2?.ownerGeneration).toBe(2);
  });

  // Test 7b: a serve flagged "dead" by stale heartbeat but still holding a VALID
  // (unexpired) lease is NOT actually dead — it is provably still renewing. The
  // single-threaded opencode serve can miss heartbeats for >staleServeMs while a
  // CPU-heavy turn blocks its event loop, yet keep the run alive. Evicting it
  // bumps the generation and kills the in-flight run ("session lease lost
  // mid-run"). reassignFromDeadServe must therefore SKIP sessions whose lease on
  // the dead serve is still valid, and only migrate them once the lease expires.
  it("reassignFromDeadServe: does NOT evict a session whose lease on the dead serve is still valid", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    const now = 10_000;
    s.serves.upsert({
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    });
    s.serves.upsert({
      serveId: "serve-2",
      instanceUuid: "uuid-2",
      endpoint: "http://localhost:8002",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    });

    // Place session-1 on serve-1 with a fresh lease (TTL 5000, gen 1).
    s.serves.setHealth("serve-2", "unhealthy", now);
    const placed = router.ensureRouted("session-1", now);
    expect(placed.serveId).toBe("serve-1");
    expect(placed.ownerGeneration).toBe(1);
    s.serves.setHealth("serve-2", "healthy", now);

    // serve-1's heartbeat went stale (event-loop blocked by a busy turn), so the
    // poller flags it unhealthy — but the lease is STILL VALID (lease_expires_at
    // is now+5000 > now): the serve is alive and still renewing.
    s.serves.setHealth("serve-1", "unhealthy", now);

    router.reassignFromDeadServe("serve-1", now);

    // The session must NOT have been migrated: same serve, same generation, lease intact.
    const a = s.assignments.get("session-1");
    expect(a?.desiredServeId).toBe("serve-1");
    expect(a?.ownerGeneration).toBe(1);
    const lease = s.leases.get("session-1");
    expect(lease?.serveId).toBe("serve-1");
    expect(lease?.ownerGeneration).toBe(1);
  });

  // Test 7c: once the lease on the dead serve has actually expired (a truly dead
  // serve stops renewing), reassignFromDeadServe migrates the session to a
  // healthy serve, bumping the generation.
  it("reassignFromDeadServe: migrates a session once its lease on the dead serve has expired", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    const now = 10_000;
    s.serves.upsert({
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    });
    s.serves.upsert({
      serveId: "serve-2",
      instanceUuid: "uuid-2",
      endpoint: "http://localhost:8002",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    });

    s.serves.setHealth("serve-2", "unhealthy", now);
    router.ensureRouted("session-1", now);
    s.serves.setHealth("serve-1", "unhealthy", now);

    // Advance past lease expiry (TTL 5000): the dead serve stopped renewing.
    // Keep serve-2's heartbeat fresh at `later` so it's an eligible target.
    const later = now + 6000;
    s.serves.setHealth("serve-2", "healthy", later);
    router.reassignFromDeadServe("serve-1", later);

    const res1 = router.resolveRoute("session-1", later);
    expect(res1?.serveId).toBe("serve-2");
    expect(res1?.ownerGeneration).toBe(2);
  });

  // Test 8: Bounded-load skip
  //
  // The cap is measured in LIVE LEASES, not in `session_assignment` rows (bead
  // pigeon-76k). An unexpired lease means the session was placed, renewed, or ran a
  // turn within the last TTL — a decaying proxy for load, where an assignment row is
  // a permanent record of having once been placed.
  it("Bounded-load skip: avoids serves with too many live leases unless all are at capacity", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 1,
    });

    const now = 10_000;
    const s1: ServeInstanceRecord = {
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    const s2: ServeInstanceRecord = {
      serveId: "serve-2",
      instanceUuid: "uuid-2",
      endpoint: "http://localhost:8002",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    s.serves.upsert(s1);
    s.serves.upsert(s2);

    const serve1Sid = sessionPreferring("serve-1", ["serve-1", "serve-2"]);

    // A pile of `assigned` rows on serve-1 with NO live lease is NOT load. This is
    // the exact state the 2026-08-02 flap ran on: 253 'assigned' rows against six
    // real leases. serve-1 must still be eligible.
    for (let i = 0; i < 5; i++) {
      s.assignments.upsert({
        sessionId: `session-stale-assigned-${i}`,
        directoryKey: null,
        desiredServeId: "serve-1",
        ownerGeneration: 1,
        state: "assigned",
        lastActiveAt: now,
        updatedAt: now,
      });
    }

    const resIdle = router.placeSession(serve1Sid, now);
    expect(resIdle.serveId).toBe("serve-1");

    // Now give serve-1 a genuine in-flight turn. serve1Sid's own placement above
    // took a lease on serve-1, so serve-1 is already at cap (1 >= activeTurnCap).
    const other = sessionPreferring("serve-1", ["serve-1", "serve-2"], serve1Sid);
    const res1 = router.placeSession(other, now);
    expect(res1.serveId).toBe("serve-2");

    // Both serves now hold one live lease each => filter empties => fall back to
    // the full pool, so HRW rank 0 wins and placement stays deterministic.
    const fallbackSid = sessionPreferring("serve-1", ["serve-1", "serve-2"], serve1Sid, other);
    const res2 = router.placeSession(fallbackSid, now);
    expect(res2.serveId).toBe("serve-1");
  });

  // Test 8a: the accounting property under pigeon-76k, at the repo level.
  //
  // A cleanly-released lease must return capacity. The old counter read
  // `session_assignment.state='assigned'`, whose only exit is lease EXPIRY, while
  // the normal end-of-turn path DELETEs the lease row and leaves the assignment
  // 'assigned' forever. So the count only ever ratcheted up, drifted past any cap,
  // and — once a mass evacuation put exactly one serve back under it — inverted the
  // cap into a magnet.
  //
  // This test states the invariant; it does NOT by itself prove the router honors it
  // (with one serve, every filter outcome picks that serve). Test 8 is the router-
  // level guard and is the one that fails against the old counter's behavior. Keep
  // both.
  it("Capacity accounting: a cleanly released lease returns capacity to the serve", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    const now = 10_000;
    s.serves.upsert({
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    });

    expect(s.leases.countLiveForServe("serve-1", now, 0)).toBe(0);

    const res = router.placeSession("session-1", now);
    expect(s.leases.countLiveForServe("serve-1", now, 0)).toBe(1);

    // A session is never load against itself — that is what keeps re-placement from
    // evicting a session off its own serve once the sticky pin expires.
    expect(s.leases.countLiveForServe("serve-1", now, 0, "session-1")).toBe(0);

    // The end-of-turn path: withSessionLease's finalizer releases the lease.
    const released = s.leases.release(
      "session-1",
      res.serveId,
      res.instanceUuid,
      res.ownerGeneration,
      0,
    );
    expect(released).toBe(true);

    // Capacity is back. The assignment row is still 'assigned' — that is fine, it
    // records placement, not concurrency.
    expect(s.leases.countLiveForServe("serve-1", now, 0)).toBe(0);
    expect(s.assignments.get("session-1")?.state).toBe("assigned");
  });

  // Test 8b: expired and wrong-epoch leases are not load.
  it("Capacity accounting: expired leases and stale-epoch leases do not count", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    const now = 10_000;
    s.serves.upsert({
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    });

    router.placeSession("session-1", now);
    expect(s.leases.countLiveForServe("serve-1", now, 0)).toBe(1);

    // Expired: sweep is periodic, so corpse rows linger between sweeps and must
    // not be charged to the serve.
    expect(s.leases.countLiveForServe("serve-1", now + 5001, 0)).toBe(0);

    // Wrong epoch: after a pool restart bumps the epoch, a re-registered serve is
    // healthy again while its old-epoch leases live on for up to one TTL. Charging
    // those to the serve would inflate exactly during the restart window.
    expect(s.leases.countLiveForServe("serve-1", now, 1)).toBe(0);
  });

  // Test 8c: repeated placement of one idle session is a fixed point.
  //
  // The 2026-08-02 bug was bistable: place -> serve crosses cap -> filter empties
  // -> fallback -> HRW yanks the session back -> serve dips under cap -> magnet
  // again. Placement of an unchanging session against an unchanging pool must not
  // move it, and must not emit reassignment events.
  it("Placement is a fixed point: re-placing one idle session never moves it", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      // Deliberately > the dt used below, so the serves stay healthy across the
      // second half of this test and the only thing under examination is the cap.
      staleServeMs: 20_000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 1,
    });

    const now = 10_000;
    for (const [id, uuid, port] of [
      ["serve-0", "uuid-0", 8000],
      ["serve-1", "uuid-1", 8001],
      ["serve-2", "uuid-2", 8002],
      ["serve-3", "uuid-3", 8003],
    ] as const) {
      s.serves.upsert({
        serveId: id,
        instanceUuid: uuid,
        endpoint: `http://localhost:${port}`,
        binaryEpoch: 0,
        healthState: "healthy",
        heartbeatAt: now,
        draining: false,
      });
    }

    const first = router.placeSession("session-1", now);
    for (let i = 0; i < 10; i++) {
      const again = router.placeSession("session-1", now);
      expect(again.serveId).toBe(first.serveId);
      expect(again.ownerGeneration).toBe(first.ownerGeneration);
    }
    expect(s.reassignments.countSince(0)).toBe(0);

    // And again with the sticky pin EXPIRED but the session's own lease still
    // live (idleMigrateMs < dt < leaseTtlMs). This is the window where a session
    // can evict itself: its own placement lease is load on its own serve, so a
    // low cap would rule out the serve it is already on and HRW would divert it —
    // a per-session version of the magnet. Nothing but the counter can prevent
    // that here, because the pin is gone.
    const later = now + 4000; // pin (3000) dead, lease (5000) alive
    const afterPinExpiry = router.placeSession("session-1", later);
    expect(afterPinExpiry.serveId).toBe(first.serveId);
    expect(s.reassignments.countSince(0)).toBe(0);
  });

  // Test 8d: narrowing the eligible set is a deliberate, LOGGED overload decision.
  //
  // Invariant from pigeon-76k: the filter may never quietly shrink the pool. The
  // 2026-08-02 magnet ran for 30 hours with no record of the narrowing that caused
  // it, which is why root-causing it took DB archaeology.
  it("Bounded-load skip logs whenever it narrows the eligible set", () => {
    const s = openStorageDb(":memory:");
    const logged: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 1,
      log: (msg, fields) => logged.push({ msg, fields }),
    });

    const now = 10_000;
    s.serves.upsert({
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    });
    s.serves.upsert({
      serveId: "serve-2",
      instanceUuid: "uuid-2",
      endpoint: "http://localhost:8002",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    });

    // Nobody is loaded: no narrowing, no log.
    const serve1Sid = sessionPreferring("serve-1", ["serve-1", "serve-2"]);
    router.placeSession(serve1Sid, now);
    expect(logged).toHaveLength(0);

    // serve-1 now holds a live lease and is at cap => the pool narrows to
    // [serve-2]. That must be visible.
    const other = sessionPreferring("serve-1", ["serve-1", "serve-2"], serve1Sid);
    router.placeSession(other, now);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.fields).toMatchObject({
      sessionId: other,
      candidates: ["serve-1", "serve-2"],
      eligible: ["serve-2"],
      activeTurnCap: 1,
    });
  });

  // Test 9: Sweep marks dormant + prunes lease
  it("Sweep marks dormant + prunes lease: transitions expired lease assignments to dormant and removes lease rows", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    const now = 10_000;
    const serve: ServeInstanceRecord = {
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    s.serves.upsert(serve);

    const res = router.ensureRouted("session-1", now);
    expect(res.expiresAt).toBe(now + 5000);

    // sweep before expiry keeps it assigned
    router.sweep(now + 2000);
    expect(s.assignments.get("session-1")?.state).toBe("assigned");
    expect(s.leases.get("session-1")).not.toBeNull();

    // sweep after expiry transitions to dormant and prunes lease
    router.sweep(now + 6000); // 5000 is expiry, so 6000 is after expiry
    expect(s.assignments.get("session-1")?.state).toBe("dormant");
    expect(s.leases.get("session-1")).toBeNull();
  });

  // Test 10: LeaseContendedError
  it("LeaseContendedError: throws LeaseContendedError if lease acquisition fails and resolveRoute is null", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    const now = 10_000;
    const s1: ServeInstanceRecord = {
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    const s2: ServeInstanceRecord = {
      serveId: "serve-2",
      instanceUuid: "uuid-2",
      endpoint: "http://localhost:8002",
      binaryEpoch: 0,
      healthState: "unhealthy",
      heartbeatAt: now,
      draining: false,
    };
    s.serves.upsert(s1);
    s.serves.upsert(s2);

    // Force assignment.desiredServeId = "serve-1", generation = 2
    s.assignments.upsert({
      sessionId: "session-contended",
      directoryKey: null,
      desiredServeId: "serve-1",
      ownerGeneration: 2,
      state: "assigned",
      lastActiveAt: now,
      updatedAt: now,
    });

    // Force lease row on serve-2 at generation 2 (unexpired)
    s.db.prepare(
      `INSERT INTO session_lease (session_id, serve_id, instance_uuid, owner_generation, lease_expires_at, heartbeat_at, binary_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("session-contended", "serve-2", "uuid-2", 2, now + 5000, now, 0);

    // Verify lease row exists with serve-2 and gen 2
    const forcedLease = s.leases.get("session-contended");
    expect(forcedLease?.serveId).toBe("serve-2");
    expect(forcedLease?.ownerGeneration).toBe(2);

    // Call placeSession.
    expect(() => router.placeSession("session-contended", now)).toThrow(LeaseContendedError);
  });

  // Test 11: touch on unrouted session -> null
  it("touch on unrouted session: returns null", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    const res = router.touch("session-unrouted", 10_000);
    expect(res).toBeNull();
  });

  // Test 12: Epoch gates serve health
  it("Epoch gates serve health: places successfully when serve binaryEpoch matches meta binaryEpoch", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    const now = 10_000;
    const serve: ServeInstanceRecord = {
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 1,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    s.serves.upsert(serve);

    // Separately: serve seeded with binaryEpoch: 1 while meta stays 0 -> placeSession throws NoHealthyServeError
    expect(() => router.placeSession("session-1", now)).toThrow(NoHealthyServeError);

    // Bump meta epoch to 1
    s.meta.bumpEpoch(now);

    // Now placeSession / ensureRouted should succeed
    const res = router.ensureRouted("session-1", now);
    expect(res).not.toBeNull();
    expect(res.serveId).toBe("serve-1");
  });

  // Test 13: Epoch bump self-invalidates a route
  it("Epoch bump self-invalidates a route: returns null from resolveRoute after an epoch bump", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    const now = 10_000;
    const serve: ServeInstanceRecord = {
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    };
    s.serves.upsert(serve);

    const res = router.ensureRouted("session-1", now);
    expect(res).not.toBeNull();

    // Now resolveRoute succeeds
    const resolved = router.resolveRoute("session-1", now);
    expect(resolved).not.toBeNull();

    // Bump meta epoch to 1
    s.meta.bumpEpoch(now);

    // Now resolveRoute returns null because the current epoch is 1, but the serve and assignment/lease are still at 0
    const resolvedAfterBump = router.resolveRoute("session-1", now);
    expect(resolvedAfterBump).toBeNull();
  });

  // Test 14: resolveRoute rejects a stale-epoch lease even if the serve re-registers at the new epoch
  it("resolveRoute: rejects a stale-epoch lease even when the serve has re-registered at the new epoch", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    const now = 10_000;
    s.serves.upsert({
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    });

    router.ensureRouted("session-1", now);
    expect(router.resolveRoute("session-1", now)).not.toBeNull();

    // Cutover: bump meta epoch to 1 AND have the serve re-register at epoch 1 (healthy).
    s.meta.bumpEpoch(now);
    s.serves.upsert({
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 1,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    });

    // The serve is now healthy at epoch 1, but the lease is still epoch 0 -> must reject.
    expect(router.resolveRoute("session-1", now)).toBeNull();
  });

  // Test 15: touch fails closed when the lease can no longer be renewed
  it("touch: returns null (fail closed) when renew is rejected after a generation bump", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    const now = 10_000;
    s.serves.upsert({
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    });

    router.ensureRouted("session-1", now);
    // Happy path: touch renews and returns the route.
    expect(router.touch("session-1", now + 1000)).not.toBeNull();

    // Pigeon bumps the assignment generation -> the held lease (gen 1) can no longer be renewed.
    s.assignments.bumpGeneration("session-1", now + 1500);

    // touch must fail closed: renew is rejected, so do not report the session as still routed.
    expect(router.touch("session-1", now + 2000)).toBeNull();
  });

  // Test 16: sweep does not clobber a newer assignment created by a concurrent re-route
  it("sweep: fenced dormant — an expired old lease does not clobber a newer re-routed assignment", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, {
      leaseTtlMs: 5000,
      staleServeMs: 2000,
      idleMigrateMs: 3000,
      dormantTtlMs: 10000,
      activeTurnCap: 10,
    });

    const now = 10_000;
    s.serves.upsert({
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: now,
      draining: false,
    });

    // Old state: an expired lease at generation 1.
    s.assignments.upsert({
      sessionId: "session-1",
      directoryKey: null,
      desiredServeId: "serve-1",
      ownerGeneration: 1,
      state: "assigned",
      lastActiveAt: now,
      updatedAt: now,
    });
    // Expired lease row (gen 1) via raw insert so it's listed by listExpired.
    s.db
      .prepare(
        `INSERT INTO session_lease (session_id, serve_id, instance_uuid, owner_generation, lease_expires_at, heartbeat_at, binary_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("session-1", "serve-1", "uuid-1", 1, now - 1, now - 5000, 0);

    // Concurrent re-route happened: assignment is now gen 2 'assigned' with a fresh unexpired lease.
    s.assignments.upsert({
      sessionId: "session-1",
      directoryKey: null,
      desiredServeId: "serve-1",
      ownerGeneration: 2,
      state: "assigned",
      lastActiveAt: now,
      updatedAt: now,
    });

    // sweep at `now`: the OLD (gen 1) lease is expired and listed. But release with the old token
    // must no-op (the live row is gen 2), so the assignment must NOT be marked dormant.
    router.sweep(now);

    expect(s.assignments.get("session-1")?.state).toBe("assigned");
    expect(s.assignments.get("session-1")?.ownerGeneration).toBe(2);
  });
});

describe("resolveProspectiveRoute (idle prospective routing)", () => {
  const OPTS = { leaseTtlMs: 5000, staleServeMs: 2000, idleMigrateMs: 3000, dormantTtlMs: 10000, activeTurnCap: 10 };
  const now = 100_000;

  type S = ReturnType<typeof openStorageDb>;
  const seedServe = (s: S, id: string, endpoint: string, opts: { healthy?: boolean; epoch?: number; draining?: boolean; heartbeatAt?: number } = {}) =>
    s.serves.upsert({
      serveId: id, instanceUuid: `uuid-${id}`, endpoint,
      binaryEpoch: opts.epoch ?? 0,
      healthState: opts.healthy === false ? "unhealthy" : "healthy",
      heartbeatAt: opts.heartbeatAt ?? now, draining: opts.draining ?? false,
    });
  const seedAssignment = (s: S, sid: string, serveId: string, state: "assigned" | "dormant" = "dormant") =>
    s.assignments.upsert({ sessionId: sid, directoryKey: null, desiredServeId: serveId, ownerGeneration: 1, state, lastActiveAt: now, updatedAt: now });

  it("REAL dormant path: placeSession -> expire -> sweep -> prospective 200", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    seedServe(s, "serve-1", "http://localhost:8001");
    router.placeSession("session-x", now);
    const later = now + OPTS.leaseTtlMs + 1;
    s.serves.setHealth("serve-1", "healthy", later);
    router.sweep(later);
    expect(router.resolveRoute("session-x", later)).toBeNull();
    expect(s.assignments.get("session-x")?.state).toBe("dormant");
    const r = router.resolveProspectiveRoute("session-x", later)!;
    expect(r.serveId).toBe("serve-1");
    expect(r.prospective).toBe(true);
    expect(r.expiresAt).toBe(0);
  });

  it("idle, assigned serve healthy -> assignment serve, no writes", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    seedServe(s, "serve-1", "http://localhost:8001");
    seedAssignment(s, "ses_a", "serve-1");
    expect(router.resolveRoute("ses_a", now)).toBeNull();
    const r = router.resolveProspectiveRoute("ses_a", now)!;
    expect(r.serveId).toBe("serve-1");
    expect(r.apiBase).toBe("http://localhost:8001");
    expect(r.eventUrl).toBe("http://localhost:8001/event?session_ids=ses_a");
    expect(r.prospective).toBe(true);
    expect(s.leases.get("ses_a")).toBeNull();
    expect(s.assignments.get("ses_a")?.desiredServeId).toBe("serve-1");
  });

  it("lease-honor: unexpired lease but stale-heartbeat serve -> returns lease serve (not a re-pick)", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    seedServe(s, "serve-0", "http://localhost:8000", { heartbeatAt: now - OPTS.staleServeMs - 1 });
    seedServe(s, "serve-1", "http://localhost:8001");
    seedAssignment(s, "ses_b", "serve-0", "assigned");
    s.leases.acquireCAS({ sessionId: "ses_b", serveId: "serve-0", instanceUuid: "uuid-serve-0", ownerGeneration: 1, binaryEpoch: 0 }, now, OPTS.leaseTtlMs);
    expect(router.resolveRoute("ses_b", now)).toBeNull();
    const r = router.resolveProspectiveRoute("ses_b", now)!;
    expect(r.serveId).toBe("serve-0");
  });

  it("never-placed sid -> null; deleted sid (assignment removed) -> null", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    seedServe(s, "serve-1", "http://localhost:8001");
    expect(router.resolveProspectiveRoute("ses_ghost", now)).toBeNull();
    seedAssignment(s, "ses_gone", "serve-1");
    s.assignments.delete("ses_gone");
    expect(router.resolveProspectiveRoute("ses_gone", now)).toBeNull();
  });

  it("assigned serve dead + multiple healthy -> true HRW re-pick over the healthy pool", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    seedServe(s, "serve-0", "http://localhost:8000", { healthy: false });
    seedServe(s, "serve-1", "http://localhost:8001");
    seedServe(s, "serve-2", "http://localhost:8002");
    seedServe(s, "serve-3", "http://localhost:8003");
    seedAssignment(s, "ses_c", "serve-0");
    const r = router.resolveProspectiveRoute("ses_c", now)!;
    expect(r.serveId).toBe(pickServe("ses_c", ["serve-1", "serve-2", "serve-3"]));
    expect(r.serveId).not.toBe("serve-0");
  });

  it("assigned serve dead + no other healthy serve -> null", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    seedServe(s, "serve-0", "http://localhost:8000", { healthy: false });
    seedAssignment(s, "ses_d", "serve-0");
    expect(router.resolveProspectiveRoute("ses_d", now)).toBeNull();
  });

  it("wrong-epoch assigned serve -> never returns a stale-epoch serve", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    seedServe(s, "serve-old", "http://localhost:8000", { epoch: 1 });
    seedServe(s, "serve-new", "http://localhost:8001", { epoch: 0 });
    seedAssignment(s, "ses_e", "serve-old");
    const r = router.resolveProspectiveRoute("ses_e", now);
    expect(r).not.toBeNull();
    expect(r!.serveId).toBe("serve-new");
  });

  it("ignores assignment.state: 'assigned' + expired lease -> 200", () => {
    const s = openStorageDb(":memory:");
    const router = new IngressRouter(s, OPTS);
    seedServe(s, "serve-1", "http://localhost:8001");
    seedAssignment(s, "ses_f", "serve-1", "assigned");
    expect(router.resolveProspectiveRoute("ses_f", now)!.serveId).toBe("serve-1");
  });
});
