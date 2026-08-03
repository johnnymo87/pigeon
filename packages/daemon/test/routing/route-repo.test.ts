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

  it("ServeInstanceRepo: insertStubIfAbsent and setHealthState", () => {
    const s = openStorageDb(":memory:");

    const stub: ServeInstanceRecord = {
      serveId: "serve-1",
      instanceUuid: "placeholder-uuid",
      endpoint: "http://localhost:8001",
      binaryEpoch: 0,
      healthState: "unknown",
      heartbeatAt: 0,
      draining: false,
    };

    // 1. insertStubIfAbsent when absent
    s.serves.insertStubIfAbsent(stub);
    expect(s.serves.get("serve-1")).toEqual(stub);

    // 2. insertStubIfAbsent on conflict does nothing (idempotent/TOCTOU safe)
    const activeServe: ServeInstanceRecord = {
      serveId: "serve-1",
      instanceUuid: "real-uuid",
      endpoint: "http://localhost:8080",
      binaryEpoch: 2,
      healthState: "healthy",
      heartbeatAt: 12345,
      draining: false,
    };
    s.serves.upsert(activeServe);

    // Call insertStubIfAbsent again with stub, should NOT clobber activeServe
    s.serves.insertStubIfAbsent(stub);
    expect(s.serves.get("serve-1")).toEqual(activeServe);

    // 3. setHealthState updates healthState ONLY, without bumping heartbeatAt
    s.serves.setHealthState("serve-1", "unhealthy");
    const afterSetHealthState = s.serves.get("serve-1");
    expect(afterSetHealthState?.healthState).toBe("unhealthy");
    expect(afterSetHealthState?.heartbeatAt).toBe(12345); // Unchanged!
    expect(afterSetHealthState?.instanceUuid).toBe("real-uuid"); // Unchanged!

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

    // 5c. setState round-trips through every state.
    // (There is no longer an assignment-derived load counter to assert here: it was
    // removed in pigeon-76k because 'assigned' counts placements, not turns. Live
    // load lives on the lease repo — see countLiveForServe below.)
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
    expect(s.assignments.get("session-3")?.state).toBe("assigned");

    s.assignments.setState("session-3", "draining", 11_000);
    expect(s.assignments.get("session-3")?.state).toBe("draining");

    s.assignments.setState("session-3", "assigned", 11_000);
    expect(s.assignments.get("session-3")?.state).toBe("assigned");

    // bumpGeneration on missing assignment throws
    expect(() => s.assignments.bumpGeneration("nonexistent", 12_000)).toThrow(
      "Assignment not found to bump generation: nonexistent"
    );

    s.db.close();
  });

  it("SessionAssignmentRepo.setDormantFenced: only dormant-marks when serve+generation match", () => {
    const s = openStorageDb(":memory:");

    s.assignments.upsert({
      sessionId: "session-1",
      directoryKey: null,
      desiredServeId: "serve-1",
      ownerGeneration: 2,
      state: "assigned",
      lastActiveAt: 10_000,
      updatedAt: 10_000,
    });

    // Wrong generation -> no-op, state unchanged.
    expect(s.assignments.setDormantFenced("session-1", "serve-1", 1, 11_000)).toBe(false);
    expect(s.assignments.get("session-1")?.state).toBe("assigned");

    // Wrong serve -> no-op.
    expect(s.assignments.setDormantFenced("session-1", "serve-9", 2, 11_000)).toBe(false);
    expect(s.assignments.get("session-1")?.state).toBe("assigned");

    // Matching serve+generation -> dormant.
    expect(s.assignments.setDormantFenced("session-1", "serve-1", 2, 12_000)).toBe(true);
    expect(s.assignments.get("session-1")?.state).toBe("dormant");
    expect(s.assignments.get("session-1")?.updatedAt).toBe(12_000);

    // Already dormant -> no-op (changes=0).
    expect(s.assignments.setDormantFenced("session-1", "serve-1", 2, 13_000)).toBe(false);

    s.db.close();
  });

  it("assignments.delete removes the row", () => {
    const s = openStorageDb(":memory:");
    const now = 1000;
    s.assignments.upsert({
      sessionId: "ses_del", directoryKey: null, desiredServeId: "serve-0",
      ownerGeneration: 1, state: "dormant", lastActiveAt: now, updatedAt: now,
    });
    expect(s.assignments.get("ses_del")).not.toBeNull();
    s.assignments.delete("ses_del");
    expect(s.assignments.get("ses_del")).toBeNull();
    // Idempotent: deleting a missing row does not throw.
    expect(() => s.assignments.delete("ses_missing")).not.toThrow();
  });

  it("SessionLeaseRepo CAS logic: acquireCAS, renewCAS, release, listExpired", () => {
    const s = openStorageDb(":memory:");

    // We must bump binary epoch of routing_meta to 1, to match input1's epoch (1)
    s.meta.bumpEpoch(10_000);

    const input1 = {
      sessionId: "session-1",
      serveId: "serve-1",
      instanceUuid: "uuid-1",
      ownerGeneration: 1,
      binaryEpoch: 1,
    };

    // Before acquire, we must seed the assignment to match!
    s.assignments.upsert({
      sessionId: "session-1",
      directoryKey: null,
      desiredServeId: "serve-1",
      ownerGeneration: 1,
      state: "assigned",
      lastActiveAt: 10_000,
      updatedAt: 10_000,
    });

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
    // Desired assignment is serve-1, so acquiring with serve-2 should be rejected.
    acquired = s.leases.acquireCAS(inputDiff, 12_000, 5_000);
    expect(acquired).toBe(false);

    // 3. same-owner renew via acquireCAS (same serve+instance) -> true.
    acquired = s.leases.acquireCAS(input1, 13_000, 5_000); // expires 18_000
    expect(acquired).toBe(true);
    expect(s.leases.get("session-1")?.leaseExpiresAt).toBe(18_000);

    // 4. renewCAS with matching owner -> true and pushes lease_expires_at out;
    let renewed = s.leases.renewCAS("session-1", "serve-1", "uuid-1", 1, 1, 14_000, 6_000); // expires 20_000
    expect(renewed).toBe(true);
    expect(s.leases.get("session-1")?.leaseExpiresAt).toBe(20_000);

    // renewCAS with wrong instance_uuid -> false.
    renewed = s.leases.renewCAS("session-1", "serve-1", "uuid-wrong", 1, 1, 15_000, 5_000);
    expect(renewed).toBe(false);

    // 5. acquireCAS by a HIGHER owner_generation -> true (crash-reassignment wins).
    const inputHigher = {
      sessionId: "session-1",
      serveId: "serve-2",
      instanceUuid: "uuid-2",
      ownerGeneration: 2,
      binaryEpoch: 1,
    };
    // Must update assignment first for the higher generation on serve-2 to succeed
    s.assignments.upsert({
      sessionId: "session-1",
      directoryKey: null,
      desiredServeId: "serve-2",
      ownerGeneration: 2,
      state: "assigned",
      lastActiveAt: 16_000,
      updatedAt: 16_000,
    });
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
    // Must update assignment to point to serve-3 at gen 2
    s.assignments.upsert({
      sessionId: "session-1",
      directoryKey: null,
      desiredServeId: "serve-3",
      ownerGeneration: 2,
      state: "assigned",
      lastActiveAt: 22_000,
      updatedAt: 22_000,
    });
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
    s.assignments.upsert({
      sessionId: "session-1",
      directoryKey: null,
      desiredServeId: "serve-4",
      ownerGeneration: 1,
      state: "assigned",
      lastActiveAt: 28_000,
      updatedAt: 28_000,
    });
    const staleAcquired = s.leases.acquireCAS(inputStaleLower, 28_000, 5_000); // lease has expired (27_000), but generation is stale (1 < 2)
    expect(staleAcquired).toBe(false);

    // renewCAS on non-existent lease returns false safely
    const renewNonExistent = s.leases.renewCAS("nonexistent", "serve-1", "uuid-1", 1, 1, 10_000, 5_000);
    expect(renewNonExistent).toBe(false);

    // 8. release with exact owning token
    s.leases.release("session-1", "serve-3", "uuid-3", 2, 1);
    expect(s.leases.get("session-1")).toBeNull();

    s.db.close();
  });

  it("Hole 2 / release fence", () => {
    const s = openStorageDb(":memory:");
    s.meta.bumpEpoch(10_000); // epoch = 1

    // Seed assignment
    s.assignments.upsert({
      sessionId: "session-fence",
      directoryKey: null,
      desiredServeId: "serve-A",
      ownerGeneration: 5,
      state: "assigned",
      lastActiveAt: 10_000,
      updatedAt: 10_000,
    });

    // Acquire lease
    const acquired = s.leases.acquireCAS(
      { sessionId: "session-fence", serveId: "serve-A", instanceUuid: "uuid-A", ownerGeneration: 5, binaryEpoch: 1 },
      10_000,
      5_000,
    );
    expect(acquired).toBe(true);

    // Try to release with stale tokens
    // 1. Wrong instanceUuid
    let released = s.leases.release("session-fence", "serve-A", "uuid-wrong", 5, 1);
    expect(released).toBe(false);
    expect(s.leases.get("session-fence")).not.toBeNull();

    // 2. Lower generation
    released = s.leases.release("session-fence", "serve-A", "uuid-A", 4, 1);
    expect(released).toBe(false);
    expect(s.leases.get("session-fence")).not.toBeNull();

    // 3. Wrong epoch
    released = s.leases.release("session-fence", "serve-A", "uuid-A", 5, 0);
    expect(released).toBe(false);
    expect(s.leases.get("session-fence")).not.toBeNull();

    // 4. Different serveId
    released = s.leases.release("session-fence", "serve-B", "uuid-A", 5, 1);
    expect(released).toBe(false);
    expect(s.leases.get("session-fence")).not.toBeNull();

    // Correct token release
    released = s.leases.release("session-fence", "serve-A", "uuid-A", 5, 1);
    expect(released).toBe(true);
    expect(s.leases.get("session-fence")).toBeNull();

    s.db.close();
  });

  it("Hole 1 / acquire correctness", () => {
    const s = openStorageDb(":memory:");
    s.meta.bumpEpoch(10_000); // epoch = 1

    // Seed assignment
    s.assignments.upsert({
      sessionId: "session-acq",
      directoryKey: null,
      desiredServeId: "serve-A",
      ownerGeneration: 5,
      state: "assigned",
      lastActiveAt: 10_000,
      updatedAt: 10_000,
    });

    // (a) Caller generation (4) < assignment generation (5) with no existing lease
    let acquired = s.leases.acquireCAS(
      { sessionId: "session-acq", serveId: "serve-A", instanceUuid: "uuid-A", ownerGeneration: 4, binaryEpoch: 1 },
      10_000,
      5_000,
    );
    expect(acquired).toBe(false);
    expect(s.leases.get("session-acq")).toBeNull();

    // (b) Higher-gen (or matching) acquire wins
    acquired = s.leases.acquireCAS(
      { sessionId: "session-acq", serveId: "serve-A", instanceUuid: "uuid-A", ownerGeneration: 5, binaryEpoch: 1 },
      10_000,
      5_000,
    );
    expect(acquired).toBe(true);
    expect(s.leases.get("session-acq")?.ownerGeneration).toBe(5);

    // (c) Same-gen self-renew idempotent -> true
    acquired = s.leases.acquireCAS(
      { sessionId: "session-acq", serveId: "serve-A", instanceUuid: "uuid-A", ownerGeneration: 5, binaryEpoch: 1 },
      11_000,
      5_000,
    );
    expect(acquired).toBe(true);
    expect(s.leases.get("session-acq")?.leaseExpiresAt).toBe(16_000);

    // (d) Same-gen, expired, different serve+instance -> steal succeeds
    // Expire the lease by advancing time to 17_000 (expires at 16_000)
    // Update assignment to point to serve-B at generation 5
    s.assignments.upsert({
      sessionId: "session-acq",
      directoryKey: null,
      desiredServeId: "serve-B",
      ownerGeneration: 5,
      state: "assigned",
      lastActiveAt: 17_000,
      updatedAt: 17_000,
    });

    acquired = s.leases.acquireCAS(
      { sessionId: "session-acq", serveId: "serve-B", instanceUuid: "uuid-B", ownerGeneration: 5, binaryEpoch: 1 },
      17_000,
      5_000,
    );
    expect(acquired).toBe(true);
    const l = s.leases.get("session-acq");
    expect(l?.serveId).toBe("serve-B");
    expect(l?.instanceUuid).toBe("uuid-B");

    // (e) Epoch mismatch (routing_meta has 1, caller passes 2) -> rejected
    acquired = s.leases.acquireCAS(
      { sessionId: "session-acq", serveId: "serve-B", instanceUuid: "uuid-B", ownerGeneration: 5, binaryEpoch: 2 },
      18_000,
      5_000,
    );
    expect(acquired).toBe(false);

    s.db.close();
  });

  it("Hole 3 / renew correctness", () => {
    const s = openStorageDb(":memory:");
    s.meta.bumpEpoch(10_000); // epoch = 1

    s.assignments.upsert({
      sessionId: "session-renew",
      directoryKey: null,
      desiredServeId: "serve-A",
      ownerGeneration: 5,
      state: "assigned",
      lastActiveAt: 10_000,
      updatedAt: 10_000,
    });

    const acquired = s.leases.acquireCAS(
      { sessionId: "session-renew", serveId: "serve-A", instanceUuid: "uuid-A", ownerGeneration: 5, binaryEpoch: 1 },
      10_000,
      5_000,
    );
    expect(acquired).toBe(true);

    // (a) Renew fails after assignments.bumpGeneration (assignment gen no longer matches caller's gen)
    s.assignments.bumpGeneration("session-renew", 11_000); // generation is now 6
    let renewed = s.leases.renewCAS("session-renew", "serve-A", "uuid-A", 5, 1, 11_000, 5_000);
    expect(renewed).toBe(false);

    // Restore assignment gen to 5 for next checks
    s.assignments.upsert({
      sessionId: "session-renew",
      directoryKey: null,
      desiredServeId: "serve-A",
      ownerGeneration: 5,
      state: "assigned",
      lastActiveAt: 12_000,
      updatedAt: 12_000,
    });

    // (b) Renew fails after meta.bumpEpoch (caller's epoch no longer matches)
    s.meta.bumpEpoch(12_000); // meta binary_epoch is now 2
    renewed = s.leases.renewCAS("session-renew", "serve-A", "uuid-A", 5, 1, 12_000, 5_000);
    expect(renewed).toBe(false);

    // (c) Renew succeeds for current owner at current epoch+gen
    // Bump assignment gen to 6, meta epoch is 2. Let's align both!
    s.assignments.upsert({
      sessionId: "session-renew",
      directoryKey: null,
      desiredServeId: "serve-A",
      ownerGeneration: 6,
      state: "assigned",
      lastActiveAt: 13_000,
      updatedAt: 13_000,
    });
    // First let the current owner acquire at generation 6, epoch 2
    const acq2 = s.leases.acquireCAS(
      { sessionId: "session-renew", serveId: "serve-A", instanceUuid: "uuid-A", ownerGeneration: 6, binaryEpoch: 2 },
      13_000,
      5_000,
    );
    expect(acq2).toBe(true);

    // Now renew with gen 6, epoch 2
    renewed = s.leases.renewCAS("session-renew", "serve-A", "uuid-A", 6, 2, 14_000, 5_000);
    expect(renewed).toBe(true);

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
