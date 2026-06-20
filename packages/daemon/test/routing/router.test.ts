import { describe, expect, it } from "vitest";
import { openStorageDb } from "../../src/storage/database";
import { pickServe } from "../../src/routing/rendezvous";
import { IngressRouter, NoHealthyServeError, LeaseContendedError } from "../../src/routing/router";
import type { ServeInstanceRecord } from "../../src/routing/types";

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

    // Now, mark serve-1 unhealthy, and serve-2 healthy
    s.serves.setHealth("serve-1", "unhealthy", now);
    s.serves.setHealth("serve-2", "healthy", now);

    // Trigger reassignFromDeadServe
    router.reassignFromDeadServe("serve-1", now);

    // Both should now resolve on serve-2 with generation 2
    const res1 = router.resolveRoute("session-1", now);
    const res2 = router.resolveRoute("session-2", now);

    expect(res1?.serveId).toBe("serve-2");
    expect(res1?.ownerGeneration).toBe(2);
    expect(res2?.serveId).toBe("serve-2");
    expect(res2?.ownerGeneration).toBe(2);
  });

  // Test 8: Bounded-load skip
  it("Bounded-load skip: avoids over-utilized serves unless all are at capacity", () => {
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

    let dormantPickSid = "";
    for (let i = 0; i < 1000; i++) {
      const candidate = `session-dormant-pick-${i}`;
      if (pickServe(candidate, ["serve-1", "serve-2"]) === "serve-1") {
        dormantPickSid = candidate;
        break;
      }
    }
    expect(dormantPickSid).not.toBe("");

    // Force a dormant assignment on serve-1 (should NOT count toward capacity)
    s.assignments.upsert({
      sessionId: "session-dormant-temp",
      directoryKey: null,
      desiredServeId: "serve-1",
      ownerGeneration: 1,
      state: "dormant",
      lastActiveAt: now,
      updatedAt: now,
    });

    // Place session. Since serve-1's only assignment is dormant, active count is 0 < activeTurnCap (1).
    // So serve-1 is eligible and picked by HRW.
    const resDormant = router.placeSession(dormantPickSid, now);
    expect(resDormant.serveId).toBe("serve-1");

    // Force one active assignment on serve-1
    s.assignments.upsert({
      sessionId: "session-forced-1",
      directoryKey: null,
      desiredServeId: "serve-1",
      ownerGeneration: 1,
      state: "assigned",
      lastActiveAt: now,
      updatedAt: now,
    });

    // Place a new session. It should pick serve-2 since serve-1 is at capacity (1 >= activeTurnCap=1)
    const res1 = router.placeSession("session-new", now);
    expect(res1.serveId).toBe("serve-2");

    // Force both serves to be at capacity by adding an active assignment on serve-2
    s.assignments.upsert({
      sessionId: "session-forced-2",
      directoryKey: null,
      desiredServeId: "serve-2",
      ownerGeneration: 1,
      state: "assigned",
      lastActiveAt: now,
      updatedAt: now,
    });

    // Now both serves are at cap. Next placeSession falls back to the full pool (and picks one of them)
    const res2 = router.placeSession("session-fallback", now);
    expect(["serve-1", "serve-2"]).toContain(res2.serveId);
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
});
