import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, unlinkSync } from "node:fs";
import { openStorageDb } from "../../src/storage/database";
import type {
  ServeInstanceRecord,
  AssignmentRecord,
} from "../../src/routing/types";

describe("Routing Repositories", () => {
  it("ServeInstanceRepo: upsert, get, all, listHealthy, setHealth, setDraining", () => {
    const s = openStorageDb(":memory:");

    const s1: ServeInstanceRecord = {
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      endpoint: "http://localhost:8001",
      binaryEpoch: 1,
      healthState: "healthy",
      heartbeatAt: 10_000,
      draining: false,
    };

    const s2: ServeInstanceRecord = {
      serveId: "serve-2",
      instanceUuid: "uuid-2",
      endpoint: "http://localhost:8002",
      binaryEpoch: 1,
      healthState: "healthy",
      heartbeatAt: 9_000,
      draining: false,
    };

    // 1. upsert and get round-trips (including draining boolean/integer conversion)
    s.serves.upsert(s1);
    s.serves.upsert(s2);

    const r1 = s.serves.get("serve-1");
    expect(r1).toEqual(s1);

    const r2 = s.serves.get("serve-2");
    expect(r2).toEqual(s2);

    // 2. all lists everything
    const all = s.serves.all();
    expect(all).toHaveLength(2);
    expect(all.find(x => x.serveId === "serve-1")).toEqual(s1);

    // 3. listHealthy logic:
    // listHealthy(now, staleMs, binaryEpoch) - healthState='healthy', heartbeat_at > (now - staleMs), draining=0, binary_epoch=?
    // s1: heartbeatAt 10_000, not draining, epoch 1
    // s2: heartbeatAt 9_000, not draining, epoch 1

    // fresh (10_000 - 2_000) = 8_000. heartbeatAt 10_000 and 9_000 are > 8_000. Both should be healthy
    let healthy = s.serves.listHealthy(10_000, 2_000, 1);
    expect(healthy).toHaveLength(2);

    // listHealthy exact boundary check: heartbeat_at is exactly now - staleMs (9_000) -> should be excluded
    healthy = s.serves.listHealthy(11_000, 2_000, 1); // threshold is 9_000. s2 is exactly 9_000 -> excluded. s1 is 10_000 -> included.
    expect(healthy).toHaveLength(1);
    expect(healthy[0]!.serveId).toBe("serve-1");

    // Stale check: let's make s2 stale by setting now to 12_000, staleMs 2_000 (threshold 10_000). s1 is exactly at 10_000 (not > 10_000, or is it > or >=? Let's check instructions: "heartbeat_at > (now-staleMs)")
    // heartbeat_at > (now - staleMs) -> threshold = 12_000 - 2_000 = 10_000. s1 heartbeat is 10_000, so not > 10_000. s2 is 9_000, not > 10_000. So both excluded if now is 12_000.
    // If now is 11_500, threshold is 11_500 - 2_000 = 9_500. s1 (10_000) is included, s2 (9_000) is excluded.
    healthy = s.serves.listHealthy(11_500, 2_000, 1);
    expect(healthy).toHaveLength(1);
    expect(healthy[0]!.serveId).toBe("serve-1");

    // 4. wrong binary_epoch check
    healthy = s.serves.listHealthy(11_500, 2_000, 2);
    expect(healthy).toHaveLength(0);

    // 5. setHealth
    s.serves.setHealth("serve-1", "unhealthy", 15_000);
    const updatedS1 = s.serves.get("serve-1");
    expect(updatedS1?.healthState).toBe("unhealthy");
    expect(updatedS1?.heartbeatAt).toBe(15_000);

    // unhealthy is excluded from listHealthy
    healthy = s.serves.listHealthy(15_000, 10_000, 1); // s2 is stale (9_000 <= 5_000 ? no, 9_000 > 5_000 so s2 is healthy, s1 is unhealthy).
    expect(healthy).toHaveLength(1);
    expect(healthy[0]!.serveId).toBe("serve-2");

    // 6. setDraining
    s.serves.setDraining("serve-2", true);
    const updatedS2 = s.serves.get("serve-2");
    expect(updatedS2?.draining).toBe(true);

    // draining is excluded from listHealthy
    healthy = s.serves.listHealthy(15_000, 10_000, 1);
    expect(healthy).toHaveLength(0);

    s.db.close();
  });

  it("SessionAssignmentRepo: upsert, get, bumpGeneration, touchActive, setState, listForServe", () => {
    const s = openStorageDb(":memory:");

    const a1: AssignmentRecord = {
      sessionId: "session-1",
      directoryKey: "/path/to/dir",
      desiredServeId: "serve-1",
      ownerGeneration: 1,
      state: "assigned",
      lastActiveAt: 10_000,
      updatedAt: 10_000,
    };

    const a2: AssignmentRecord = {
      sessionId: "session-2",
      directoryKey: null,
      desiredServeId: "serve-1",
      ownerGeneration: 3,
      state: "dormant",
      lastActiveAt: 9_000,
      updatedAt: 9_500,
    };

    // 1. upsert and get round-trips
    s.assignments.upsert(a1);
    s.assignments.upsert(a2);

    expect(s.assignments.get("session-1")).toEqual(a1);
    expect(s.assignments.get("session-2")).toEqual(a2);

    // 2. bumpGeneration
    const newGen = s.assignments.bumpGeneration("session-1", 12_000);
    expect(newGen).toBe(2);
    const updatedA1 = s.assignments.get("session-1");
    expect(updatedA1?.ownerGeneration).toBe(2);
    expect(updatedA1?.updatedAt).toBe(12_000);

    // 3. touchActive
    s.assignments.touchActive("session-1", 13_000);
    const touchedA1 = s.assignments.get("session-1");
    expect(touchedA1?.lastActiveAt).toBe(13_000);
    expect(touchedA1?.updatedAt).toBe(13_000);

    // 4. setState
    s.assignments.setState("session-1", "migrating", 14_000);
    const stateA1 = s.assignments.get("session-1");
    expect(stateA1?.state).toBe("migrating");
    expect(stateA1?.updatedAt).toBe(14_000);

    // 5. listForServe
    const list = s.assignments.listForServe("serve-1");
    expect(list).toHaveLength(2);
    expect(list.find(x => x.sessionId === "session-1")?.state).toBe("migrating");
    expect(list.find(x => x.sessionId === "session-2")?.state).toBe("dormant");

    // 5b. all
    const allAssignments = s.assignments.all();
    expect(allAssignments).toHaveLength(2);
    expect(allAssignments.find(x => x.sessionId === "session-1")?.state).toBe("migrating");

    // 5c. countActiveForServe
    // Right now, both assignments are non-assigned ('migrating' and 'dormant')
    expect(s.assignments.countActiveForServe("serve-1")).toBe(0);

    // Upsert an 'assigned' one
    const a3: AssignmentRecord = {
      sessionId: "session-3",
      directoryKey: null,
      desiredServeId: "serve-1",
      ownerGeneration: 1,
      state: "assigned",
      lastActiveAt: 10_000,
      updatedAt: 10_000,
    };
    s.assignments.upsert(a3);
    expect(s.assignments.countActiveForServe("serve-1")).toBe(1);

    // Upsert other states
    s.assignments.setState("session-3", "draining", 11_000);
    expect(s.assignments.countActiveForServe("serve-1")).toBe(0);

    s.assignments.setState("session-3", "assigned", 11_000);
    expect(s.assignments.countActiveForServe("serve-1")).toBe(1);

    // bumpGeneration on missing assignment throws
    expect(() => s.assignments.bumpGeneration("nonexistent", 12_000)).toThrow(
      "Assignment not found to bump generation: nonexistent"
    );

    s.db.close();
  });

  it("SessionLeaseRepo CAS logic: acquireCAS, renewCAS, release, listExpired", () => {
    const s = openStorageDb(":memory:");

    const input1 = {
      sessionId: "session-1",
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      ownerGeneration: 1,
      binaryEpoch: 1,
    };

    // 1. acquireCAS on empty row -> true.
    let acquired = s.leases.acquireCAS(input1, 10_000, 5_000); // lease expires at 15_000
    expect(acquired).toBe(true);

    const lease = s.leases.get("session-1");
    expect(lease).toEqual({
      sessionId: "session-1",
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      ownerGeneration: 1,
      leaseExpiresAt: 15_000,
      heartbeatAt: 10_000,
      binaryEpoch: 1,
    });

    // 2. second acquireCAS by a DIFFERENT serve/instance with the SAME owner_generation, before expiry -> false (lease held).
    const inputDiff = {
      sessionId: "session-1",
      serveId: "serve-2",
      instanceUuid: "uuid-2",
      ownerGeneration: 1,
      binaryEpoch: 1,
    };
    acquired = s.leases.acquireCAS(inputDiff, 12_000, 5_000);
    expect(acquired).toBe(false);

    // 3. same-owner renew via acquireCAS (same serve+instance) -> true.
    acquired = s.leases.acquireCAS(input1, 13_000, 5_000); // expires 18_000
    expect(acquired).toBe(true);
    expect(s.leases.get("session-1")?.leaseExpiresAt).toBe(18_000);

    // 4. renewCAS with matching owner -> true and pushes lease_expires_at out;
    let renewed = s.leases.renewCAS("session-1", "serve-1", "uuid-1", 1, 14_000, 6_000); // expires 20_000
    expect(renewed).toBe(true);
    expect(s.leases.get("session-1")?.leaseExpiresAt).toBe(20_000);

    // renewCAS with wrong instance_uuid -> false.
    renewed = s.leases.renewCAS("session-1", "serve-1", "uuid-wrong", 1, 15_000, 5_000);
    expect(renewed).toBe(false);

    // 5. acquireCAS by a HIGHER owner_generation -> true (crash-reassignment wins).
    const inputHigher = {
      sessionId: "session-1",
      serveId: "serve-2",
      instanceUuid: "uuid-2",
      ownerGeneration: 2,
      binaryEpoch: 1,
    };
    acquired = s.leases.acquireCAS(inputHigher, 16_000, 5_000); // expires 21_000
    expect(acquired).toBe(true);

    const leaseHigher = s.leases.get("session-1");
    expect(leaseHigher?.serveId).toBe("serve-2");
    expect(leaseHigher?.instanceUuid).toBe("uuid-2");
    expect(leaseHigher?.ownerGeneration).toBe(2);

    // 6. after lease_expires_at has passed (advance now) a different serve acquireCAS -> true.
    // current expires at 21_000. Let's try to acquire at 22_000 with lower/same generation from another serve.
    const inputDiffAfterExpiry = {
      sessionId: "session-1",
      serveId: "serve-3",
      instanceUuid: "uuid-3",
      ownerGeneration: 2,
      binaryEpoch: 1,
    };
    acquired = s.leases.acquireCAS(inputDiffAfterExpiry, 22_000, 5_000); // now is 22_000, past 21_000
    expect(acquired).toBe(true);
    expect(s.leases.get("session-1")?.serveId).toBe("serve-3");

    // 7. listExpired
    // current expires at 27_000.
    expect(s.leases.listExpired(26_000)).toHaveLength(0);
    const expired = s.leases.listExpired(27_000);
    expect(expired).toHaveLength(1);
    expect(expired[0]!.sessionId).toBe("session-1");

    // Zombie check: lease at owner_generation=2 that has expired CANNOT be acquired by owner_generation=1
    const inputStaleLower = {
      sessionId: "session-1",
      serveId: "serve-4",
      instanceUuid: "uuid-4",
      ownerGeneration: 1,
      binaryEpoch: 1,
    };
    const staleAcquired = s.leases.acquireCAS(inputStaleLower, 28_000, 5_000); // lease has expired (27_000), but generation is stale (1 < 2)
    expect(staleAcquired).toBe(false);

    // renewCAS on non-existent lease returns false safely
    const renewNonExistent = s.leases.renewCAS("nonexistent", "serve-1", "uuid-1", 1, 10_000, 5_000);
    expect(renewNonExistent).toBe(false);

    // 8. release
    s.leases.release("session-1");
    expect(s.leases.get("session-1")).toBeNull();

    s.db.close();
  });

  it("RoutingMetaRepo: get, bumpEpoch, idempotent seed", () => {
    // 1. After openStorageDb(":memory:"), s.meta.get() returns initial row
    const s = openStorageDb(":memory:");
    const meta = s.meta.get();
    expect(meta).toEqual({
      schemaVersion: 1,
      binaryEpoch: 0,
      ddlChecksum: expect.any(String),
      updatedAt: expect.any(Number),
    });
    expect(meta.ddlChecksum.length).toBeGreaterThan(0);

    // 2. s.meta.bumpEpoch(now) returns 1, subsequent get reflects change
    const now = 20_000;
    const newEpoch = s.meta.bumpEpoch(now);
    expect(newEpoch).toBe(1);

    // Sequential bump should return 2
    const secondEpoch = s.meta.bumpEpoch(now + 1000);
    expect(secondEpoch).toBe(2);

    const meta2 = s.meta.get();
    expect(meta2.binaryEpoch).toBe(2);
    expect(meta2.updatedAt).toBe(now + 1000);

    s.db.close();

    // 3. Idempotent seed using a file-backed temp DB
    const dbPath = join(tmpdir(), `pigeon-test-routing-meta-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }

    try {
      // First open -> seeds meta with epoch=0
      const sFile1 = openStorageDb(dbPath);
      expect(sFile1.meta.get().binaryEpoch).toBe(0);

      // Bump to 3
      sFile1.meta.bumpEpoch(10_000);
      sFile1.meta.bumpEpoch(11_000);
      sFile1.meta.bumpEpoch(12_000);
      expect(sFile1.meta.get().binaryEpoch).toBe(3);

      sFile1.db.close();

      // Re-open same path -> initRouteSchema runs again, should NOT reset epoch or updatedAt
      const sFile2 = openStorageDb(dbPath);
      const metaAfterReopen = sFile2.meta.get();
      expect(metaAfterReopen.binaryEpoch).toBe(3);
      expect(metaAfterReopen.updatedAt).toBe(12_000);

      sFile2.db.close();
    } finally {
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
    }
  });
});
