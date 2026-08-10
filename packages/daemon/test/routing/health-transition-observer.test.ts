import { describe, expect, it, vi } from "vitest";
import { openStorageDb } from "../../src/storage/database";
import {
  HealthTransitionObserver,
} from "../../src/routing/health-transition-observer";
import { ServeHealthPoller } from "../../src/routing/serve-health-poller";
import type { ServeInstanceRecord } from "../../src/routing/types";

function mockServeRow(overrides: Partial<ServeInstanceRecord> = {}): ServeInstanceRecord {
  return {
    serveId: "serve-0",
    instanceUuid: "uuid-serve-0",
    endpoint: "http://127.0.0.1:4096",
    binaryEpoch: 1,
    healthState: "healthy",
    heartbeatAt: 1000,
    draining: false,
    ...overrides,
  };
}

describe("HealthTransitionObserver", () => {
  it("first tick emits exactly one baseline line, not N transition lines", () => {
    const s = openStorageDb(":memory:");
    s.serves.upsert(mockServeRow({ serveId: "serve-0", healthState: "healthy" }));
    s.serves.upsert(mockServeRow({ serveId: "serve-1", healthState: "unhealthy" }));

    const log = vi.fn();
    const observer = new HealthTransitionObserver({
      serves: s.serves,
      log,
      nowFn: () => 2000,
    });

    observer.tick();

    expect(log).toHaveBeenCalledTimes(1);
    const [msg, fields] = log.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toContain("baseline");
    expect(fields).toHaveProperty("baseline");
    expect(fields.baseline).toBeTruthy();
    // The baseline line's whole job is to state WHERE the pool was found, so an
    // empty or truncated pool string is the failure mode that matters — asserting
    // only the call count would let a baseline carrying nothing pass.
    expect(fields.pool).toContain("serve-0:healthy");
    expect(fields.pool).toContain("serve-1:unhealthy");

    s.db.close();
  });

  it("healthy -> unhealthy logs one line with the right fields", () => {
    const s = openStorageDb(":memory:");
    const initial = mockServeRow({ serveId: "serve-0", healthState: "healthy", heartbeatAt: 1000 });
    s.serves.upsert(initial);

    const log = vi.fn();
    let now = 1000;
    const observer = new HealthTransitionObserver({
      serves: s.serves,
      log,
      nowFn: () => now,
    });

    // Tick 1: baseline
    observer.tick();
    log.mockClear();

    // Transition to unhealthy
    now = 2000;
    s.serves.setHealthState("serve-0", "unhealthy");

    // Tick 2: transition
    observer.tick();

    expect(log).toHaveBeenCalledTimes(1);
    const [msg, fields] = log.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe("serve health state transition");
    expect(fields).toEqual({
      serveId: "serve-0",
      from: "healthy",
      to: "unhealthy",
      heartbeatAgeMs: 1000, // 2000 - 1000
      instanceUuid: "uuid-serve-0",
      binaryEpoch: 1,
      draining: false,
      writer: "observed",
    });

    // Tick 3: the state is now STABLE at unhealthy. A transition is an edge, not a
    // level, so it must be reported exactly once.
    //
    // This assertion is the fence on `lastObserved` being advanced inside the
    // transition branch. Without it, deleting that one line leaves every test here
    // green while the observer re-logs the same transition on every 5s tick
    // forever — unbounded journald spam, and a transition count that is really a
    // duration count. Found by mutation-testing this exact deletion.
    log.mockClear();
    now = 3000;
    observer.tick();
    expect(log).not.toHaveBeenCalled();

    s.db.close();
  });

  it("unhealthy -> healthy (REJOIN) logs one line — simulating out-of-process serve heartbeat", () => {
    const s = openStorageDb(":memory:");
    s.serves.upsert(mockServeRow({ serveId: "serve-0", healthState: "unhealthy", heartbeatAt: 1000 }));

    const log = vi.fn();
    let now = 1000;
    const observer = new HealthTransitionObserver({
      serves: s.serves,
      log,
      nowFn: () => now,
    });

    // Tick 1: baseline
    observer.tick();
    log.mockClear();

    // Simulate out-of-process serve heartbeat writing healthy directly via repo
    now = 5000;
    s.serves.upsert(mockServeRow({ serveId: "serve-0", healthState: "healthy", heartbeatAt: 5000 }));

    // Tick 2: transition
    observer.tick();

    expect(log).toHaveBeenCalledTimes(1);
    const [msg, fields] = log.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe("serve health state transition");
    expect(fields).toEqual({
      serveId: "serve-0",
      from: "unhealthy",
      to: "healthy",
      heartbeatAgeMs: 0, // 5000 - 5000
      instanceUuid: "uuid-serve-0",
      binaryEpoch: 1,
      draining: false,
      writer: "observed",
    });

    s.db.close();
  });

  it("no change across two ticks logs nothing the second time", () => {
    const s = openStorageDb(":memory:");
    s.serves.upsert(mockServeRow({ serveId: "serve-0", healthState: "healthy" }));

    const log = vi.fn();
    const observer = new HealthTransitionObserver({
      serves: s.serves,
      log,
      nowFn: () => 1000,
    });

    observer.tick(); // Baseline
    log.mockClear();

    observer.tick(); // No change
    expect(log).not.toHaveBeenCalled();

    s.db.close();
  });

  it("a serve appearing for the first time on a LATER tick is handled sanely without fake transition, and tracked thereafter", () => {
    const s = openStorageDb(":memory:");
    s.serves.upsert(mockServeRow({ serveId: "serve-0", healthState: "healthy" }));

    const log = vi.fn();
    let now = 1000;
    const observer = new HealthTransitionObserver({
      serves: s.serves,
      log,
      nowFn: () => now,
    });

    // Tick 1: baseline for serve-0
    observer.tick();
    log.mockClear();

    // Serve-1 appears on later tick
    now = 2000;
    s.serves.upsert(mockServeRow({ serveId: "serve-1", healthState: "healthy", heartbeatAt: 2000 }));

    observer.tick();
    // No transition line should be emitted for serve-1 because there was no prior observed state
    expect(log).not.toHaveBeenCalled();

    // Now serve-1 transitions to unhealthy on tick 3
    now = 3000;
    s.serves.setHealthState("serve-1", "unhealthy");

    observer.tick();
    expect(log).toHaveBeenCalledTimes(1);
    const [msg, fields] = log.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe("serve health state transition");
    expect(fields.serveId).toBe("serve-1");
    expect(fields.from).toBe("healthy");
    expect(fields.to).toBe("unhealthy");

    s.db.close();
  });

  it("multiple serves changing in one tick each get their own line", () => {
    const s = openStorageDb(":memory:");
    s.serves.upsert(mockServeRow({ serveId: "serve-0", healthState: "healthy" }));
    s.serves.upsert(mockServeRow({ serveId: "serve-1", healthState: "unhealthy" }));

    const log = vi.fn();
    let now = 1000;
    const observer = new HealthTransitionObserver({
      serves: s.serves,
      log,
      nowFn: () => now,
    });

    observer.tick(); // Baseline
    log.mockClear();

    now = 2000;
    s.serves.setHealthState("serve-0", "unhealthy");
    s.serves.setHealthState("serve-1", "healthy");

    observer.tick();

    expect(log).toHaveBeenCalledTimes(2);
    const calls = log.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(calls).toEqual([
      expect.objectContaining({ serveId: "serve-0", from: "healthy", to: "unhealthy" }),
      expect.objectContaining({ serveId: "serve-1", from: "unhealthy", to: "healthy" }),
    ]);

    s.db.close();
  });

  it("safeTick swallows a throwing repo and logs rather than propagating", () => {
    const log = vi.fn();
    const explodingRepo = {
      all: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    };

    const observer = new HealthTransitionObserver({
      serves: explodingRepo as any,
      log,
    });

    expect(() => observer.safeTick()).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    const [msg, fields] = log.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe("tick failed");
    expect(fields.error).toBe("SQLITE_BUSY: database is locked");
  });
});

describe("ServeHealthPoller sweepStale logging", () => {
  it("the sweepStale line fires with writer 'sweepStale' and correct heartbeatAgeMs", () => {
    const s = openStorageDb(":memory:");
    s.serves.upsert(mockServeRow({ serveId: "serve-0", healthState: "healthy", heartbeatAt: 1000 }));

    const log = vi.fn();
    const poller = new ServeHealthPoller(
      s.serves,
      { reassignFromDeadServe: () => {} },
      { healthPollMs: 5000, log },
    );

    const now = 20000;
    const staleMs = 15000;
    poller.sweepStale(now, staleMs);

    expect(log).toHaveBeenCalledTimes(1);
    const [msg, fields] = log.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe("serve health stale sweep");
    expect(fields).toEqual({
      writer: "sweepStale",
      serveId: "serve-0",
      from: "healthy",
      to: "unhealthy",
      heartbeatAgeMs: 19000, // 20000 - 1000
      staleMs: 15000,
    });

    s.db.close();
  });

  it("sweepStale line does NOT fire when serve is already unhealthy", () => {
    const s = openStorageDb(":memory:");
    s.serves.upsert(mockServeRow({ serveId: "serve-0", healthState: "unhealthy", heartbeatAt: 1000 }));

    const log = vi.fn();
    const poller = new ServeHealthPoller(
      s.serves,
      { reassignFromDeadServe: () => {} },
      { healthPollMs: 5000, log },
    );

    const now = 20000;
    const staleMs = 15000;
    poller.sweepStale(now, staleMs);

    expect(log).not.toHaveBeenCalled();

    s.db.close();
  });
});
