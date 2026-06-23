import { describe, expect, it, vi } from "vitest";
import { openStorageDb } from "../../src/storage/database";
import { IngressRouter } from "../../src/routing/router";
import { ServeHealthPoller } from "../../src/routing/serve-health-poller";
import { seedServes } from "../../src/routing/serve-registry";

describe("serve-health-poller", () => {
  it("marks a healthy serve as healthy and updates heartbeatAt", async () => {
    const s = openStorageDb(":memory:");
    seedServes(s.serves, ["http://127.0.0.1:4096"], 1000, { uuidFn: () => "uuid-0" });

    // Mock fetchFn returning ok: true
    const fetchFn = vi.fn().mockResolvedValue({ ok: true } as Response);

    const poller = new ServeHealthPoller(s.serves, {
      reassignFromDeadServe: () => {}
    }, {
      healthPollMs: 5000,
      fetchFn,
    });

    await poller.pollOnce(2000);

    const record = s.serves.get("serve-0")!;
    expect(record.healthState).toBe("healthy");
    expect(record.heartbeatAt).toBe(2000);
    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:4096/global/health", expect.any(Object));

    s.db.close();
  });

  it("does NOT reassign a session with a live lease on a probe-failed serve, but DOES once the lease expires", async () => {
    const s = openStorageDb(":memory:");
    seedServes(s.serves, ["http://serve-0.local", "http://serve-1.local"], 1000, { uuidFn: () => "uuid-0" });

    // Seed them healthy first so router can place session
    s.serves.setHealth("serve-0", "healthy", 1000);
    s.serves.setHealth("serve-1", "healthy", 1000);

    const leaseTtlMs = 30000;
    const router = new IngressRouter(
      s,
      {
        leaseTtlMs,
        staleServeMs: 15000,
        idleMigrateMs: 60000,
        dormantTtlMs: 300000,
        activeTurnCap: 25,
      }
    );

    // Place session (lease at 1000 -> expires at 1000 + leaseTtlMs)
    const placement = router.placeSession("sess-1", 1000);
    const assignedServeId = placement.serveId;
    const otherServeId = assignedServeId === "serve-0" ? "serve-1" : "serve-0";

    // Setup fetchFn: assigned endpoint fails, other endpoint succeeds
    const assignedEndpoint = s.serves.get(assignedServeId)!.endpoint;
    const fetchFn = vi.fn((url: any) => {
      if (typeof url === "string" && url.includes(assignedEndpoint)) {
        return Promise.resolve({ ok: false } as Response);
      }
      return Promise.resolve({ ok: true } as Response);
    });

    const poller = new ServeHealthPoller(s.serves, router, {
      healthPollMs: 5000,
      fetchFn,
    });

    // Phase 1: probe fails at 2000 while the lease is still valid. The serve is
    // flagged unhealthy, but the session must NOT be migrated — a live lease
    // proves the (single-threaded, momentarily-unresponsive) serve is still
    // running the turn. Evicting it would kill the run with "lease lost mid-run".
    await poller.pollOnce(2000);

    expect(s.serves.get(assignedServeId)!.healthState).toBe("unhealthy");
    const stillAssigned = s.assignments.get("sess-1");
    expect(stillAssigned!.desiredServeId).toBe(assignedServeId);
    expect(stillAssigned!.ownerGeneration).toBe(1);
    expect(s.leases.get("sess-1")!.serveId).toBe(assignedServeId);

    // Phase 2: the lease has now expired (a truly dead serve stopped renewing).
    // A subsequent poll migrates the session to the healthy serve.
    const afterExpiry = 1000 + leaseTtlMs + 1000;
    s.serves.setHealth(otherServeId, "healthy", afterExpiry); // keep target fresh
    await poller.pollOnce(afterExpiry);

    expect(s.serves.get(assignedServeId)!.healthState).toBe("unhealthy");
    expect(s.serves.get(otherServeId)!.healthState).toBe("healthy");

    const newRoute = router.resolveRoute("sess-1", afterExpiry);
    expect(newRoute).not.toBeNull();
    expect(newRoute!.serveId).toBe(otherServeId);
    expect(newRoute!.ownerGeneration).toBe(2);

    s.db.close();
  });

  it("recovers an unhealthy serve back to healthy", async () => {
    const s = openStorageDb(":memory:");
    seedServes(s.serves, ["http://127.0.0.1:4096"], 1000);
    s.serves.setHealth("serve-0", "unhealthy", 1500);

    const fetchFn = vi.fn().mockResolvedValue({ ok: true } as Response);
    const poller = new ServeHealthPoller(s.serves, {
      reassignFromDeadServe: () => {}
    }, {
      healthPollMs: 5000,
      fetchFn,
    });

    await poller.pollOnce(2000);

    const record = s.serves.get("serve-0")!;
    expect(record.healthState).toBe("healthy");
    expect(record.heartbeatAt).toBe(2000);

    s.db.close();
  });

  it("handles a single serve failure without throwing or crashing (NoHealthyServeError swallowed)", async () => {
    const s = openStorageDb(":memory:");
    seedServes(s.serves, ["http://serve-0.local"], 1000);
    s.serves.setHealth("serve-0", "healthy", 1000);

    const router = new IngressRouter(
      s,
      {
        leaseTtlMs: 30000,
        staleServeMs: 15000,
        idleMigrateMs: 60000,
        dormantTtlMs: 300000,
        activeTurnCap: 25,
      }
    );

    // Place session
    router.placeSession("sess-1", 1000);

    // Mock fetch failing
    const fetchFn = vi.fn().mockRejectedValue(new Error("Network fail"));

    const poller = new ServeHealthPoller(s.serves, router, {
      healthPollMs: 5000,
      fetchFn,
    });

    // This must resolve without throwing NoHealthyServeError
    await expect(poller.pollOnce(2000)).resolves.not.toThrow();

    expect(s.serves.get("serve-0")!.healthState).toBe("unhealthy");

    s.db.close();
  });

  it("failing one serve does not stop health polling of other serves", async () => {
    const s = openStorageDb(":memory:");
    seedServes(s.serves, ["http://serve-0.local", "http://serve-1.local"], 1000);

    const fetchFn = vi.fn((url: any) => {
      if (typeof url === "string" && url.includes("serve-0.local")) {
        return Promise.reject(new Error("Timeout"));
      }
      return Promise.resolve({ ok: true } as Response);
    });

    const poller = new ServeHealthPoller(s.serves, {
      reassignFromDeadServe: () => {}
    }, {
      healthPollMs: 5000,
      fetchFn,
    });

    await poller.pollOnce(2000);

    expect(s.serves.get("serve-0")!.healthState).toBe("unhealthy");
    expect(s.serves.get("serve-1")!.healthState).toBe("healthy");

    s.db.close();
  });

  it("start() and stop() manage the interval timer correctly", () => {
    vi.useFakeTimers();
    const s = openStorageDb(":memory:");
    seedServes(s.serves, ["http://127.0.0.1:4096"], 1000);

    const fetchFn = vi.fn().mockResolvedValue({ ok: true } as Response);
    const poller = new ServeHealthPoller(s.serves, {
      reassignFromDeadServe: () => {}
    }, {
      healthPollMs: 5000,
      fetchFn,
    });

    poller.start();

    // Fast-forward 5000ms
    vi.advanceTimersByTime(5000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Fast-forward another 5000ms
    vi.advanceTimersByTime(5000);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    poller.stop();

    // Fast-forward 5000ms, should NOT increment calls
    vi.advanceTimersByTime(5000);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    s.db.close();
  });

  it("staleness sweep logic (sweepStale)", async () => {
    const s = openStorageDb(":memory:");

    const staleMs = 15000;
    const now = 20000;

    // 1. A healthy+stale serve (heartbeat_at <= now - staleMs)
    // stale threshold: 20000 - 15000 = 5000
    // heartbeat_at = 4000
    s.serves.upsert({
      serveId: "serve-stale",
      instanceUuid: "uuid-stale",
      endpoint: "http://localhost:4001",
      binaryEpoch: 1,
      healthState: "healthy",
      heartbeatAt: 4000,
      draining: false,
    });

    // 2. A fresh serve (heartbeat_at > now - staleMs)
    // heartbeat_at = 6000
    s.serves.upsert({
      serveId: "serve-fresh",
      instanceUuid: "uuid-fresh",
      endpoint: "http://localhost:4002",
      binaryEpoch: 1,
      healthState: "healthy",
      heartbeatAt: 6000,
      draining: false,
    });

    // 3. A stub / never-registered serve (healthState = 'unknown', heartbeatAt = 0)
    s.serves.upsert({
      serveId: "serve-stub",
      instanceUuid: "uuid-stub",
      endpoint: "http://localhost:4003",
      binaryEpoch: 0,
      healthState: "unknown",
      heartbeatAt: 0,
      draining: false,
    });

    // 4. An already unhealthy serve (healthState = 'unhealthy', heartbeatAt = 1000)
    s.serves.upsert({
      serveId: "serve-unhealthy",
      instanceUuid: "uuid-unhealthy",
      endpoint: "http://localhost:4004",
      binaryEpoch: 1,
      healthState: "unhealthy",
      heartbeatAt: 1000,
      draining: false,
    });

    const reassignedServeIds: string[] = [];
    const poller = new ServeHealthPoller(s.serves, {
      reassignFromDeadServe: (serveId) => {
        reassignedServeIds.push(serveId);
      }
    }, {
      healthPollMs: 5000,
    });

    // Run sweepStale
    poller.sweepStale(now, staleMs);

    // Verify stale serve is marked unhealthy, without bumping heartbeatAt
    const recordStale = s.serves.get("serve-stale")!;
    expect(recordStale.healthState).toBe("unhealthy");
    expect(recordStale.heartbeatAt).toBe(4000); // Unchanged!

    // Verify fresh serve is untouched
    const recordFresh = s.serves.get("serve-fresh")!;
    expect(recordFresh.healthState).toBe("healthy");
    expect(recordFresh.heartbeatAt).toBe(6000);

    // Verify other serves are untouched
    expect(s.serves.get("serve-stub")!.healthState).toBe("unknown");
    expect(s.serves.get("serve-unhealthy")!.healthState).toBe("unhealthy");

    // Only the healthy->stale transition triggers reassignment
    expect(reassignedServeIds).toEqual(["serve-stale"]);

    s.db.close();
  });
});
