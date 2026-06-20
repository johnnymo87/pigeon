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

  it("performs dead serve reassignment off a failed serve", async () => {
    const s = openStorageDb(":memory:");
    seedServes(s.serves, ["http://serve-0.local", "http://serve-1.local"], 1000, { uuidFn: () => "uuid-0" });
    
    // Seed them healthy first so router can place session
    s.serves.setHealth("serve-0", "healthy", 1000);
    s.serves.setHealth("serve-1", "healthy", 1000);

    const router = new IngressRouter(
      {
        serves: s.serves,
        assignments: s.assignments,
        leases: s.leases,
      },
      {
        leaseTtlMs: 30000,
        staleServeMs: 15000,
        idleMigrateMs: 60000,
        dormantTtlMs: 300000,
        activeTurnCap: 25,
        binaryEpoch: 0,
      }
    );

    // Place session
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

    // Run pollOnce at 2000
    await poller.pollOnce(2000);

    // Assigned serve should be unhealthy, other serve healthy
    expect(s.serves.get(assignedServeId)!.healthState).toBe("unhealthy");
    expect(s.serves.get(otherServeId)!.healthState).toBe("healthy");

    // Session should have been reassigned to the other serve
    const newRoute = router.resolveRoute("sess-1", 2000);
    expect(newRoute).not.toBeNull();
    expect(newRoute!.serveId).toBe(otherServeId);

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
      {
        serves: s.serves,
        assignments: s.assignments,
        leases: s.leases,
      },
      {
        leaseTtlMs: 30000,
        staleServeMs: 15000,
        idleMigrateMs: 60000,
        dormantTtlMs: 300000,
        activeTurnCap: 25,
        binaryEpoch: 0,
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
});
