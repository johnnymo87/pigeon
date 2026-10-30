import { describe, expect, it, vi } from "vitest";
import {
  handleLaunchItems,
  runAckRetries,
  createLaunchWorkLock,
  type HandleLaunchItemsDeps,
} from "../src/swarm/remote-launch-poll";
import * as receiverMod from "../src/swarm/remote-launch-receiver";

describe("handleLaunchItems", () => {
  it("mixed batch routes launch_result to requester + acks each, launch items to processLaunchItems, then retryLaunchAcks", async () => {
    const ack1 = { kind: "result" as const, from_machine: "m1", result_id: "r1", outcome: "delivered" as const };
    const ack2 = { kind: "result" as const, from_machine: "m1", result_id: "r2", outcome: "delivered" as const };

    const processResults = vi.fn().mockReturnValue([ack1, ack2]);
    const mockRequester = { processResults } as any;

    const mockAck = vi.fn().mockResolvedValue(true);
    const mockClient = { ack: mockAck } as any;

    const processLaunchItemsSpy = vi.spyOn(receiverMod, "processLaunchItems").mockResolvedValue(undefined);
    const retryLaunchAcksSpy = vi.spyOn(receiverMod, "retryLaunchAcks").mockResolvedValue(undefined);

    const receiverDeps = { storage: {} } as any;
    const deps: HandleLaunchItemsDeps = {
      requester: mockRequester,
      client: mockClient,
      receiverDeps,
      log: vi.fn(),
    };

    const resItem1 = { item: "launch_result", result_id: "r1" };
    const launchItem1 = { item: "launch", launch_id: "l1" };
    const resItem2 = { item: "launch_result", result_id: "r2" };

    await handleLaunchItems(deps, [resItem1, launchItem1, resItem2]);

    // Results routed to requester
    expect(processResults).toHaveBeenCalledWith([resItem1, resItem2]);
    // Acks sent one item per request
    expect(mockAck).toHaveBeenCalledTimes(2);
    expect(mockAck).toHaveBeenNthCalledWith(1, [ack1]);
    expect(mockAck).toHaveBeenNthCalledWith(2, [ack2]);

    // Launch items routed to processLaunchItems
    expect(processLaunchItemsSpy).toHaveBeenCalledWith(receiverDeps, [launchItem1]);

    // retryLaunchAcks called
    expect(retryLaunchAcksSpy).toHaveBeenCalledWith(receiverDeps);

    processLaunchItemsSpy.mockRestore();
    retryLaunchAcksSpy.mockRestore();
  });

  it("a throw in result processing does not prevent launch processing or retryLaunchAcks", async () => {
    const processResults = vi.fn().mockImplementation(() => {
      throw new Error("results exploded");
    });
    const mockRequester = { processResults } as any;
    const mockClient = { ack: vi.fn() } as any;

    const processLaunchItemsSpy = vi.spyOn(receiverMod, "processLaunchItems").mockResolvedValue(undefined);
    const retryLaunchAcksSpy = vi.spyOn(receiverMod, "retryLaunchAcks").mockResolvedValue(undefined);

    const receiverDeps = { storage: {} } as any;
    const deps: HandleLaunchItemsDeps = {
      requester: mockRequester,
      client: mockClient,
      receiverDeps,
      log: vi.fn(),
    };

    const resItem = { item: "launch_result", result_id: "r1" };
    const launchItem = { item: "launch", launch_id: "l1" };

    await handleLaunchItems(deps, [resItem, launchItem]);

    expect(processLaunchItemsSpy).toHaveBeenCalledWith(receiverDeps, [launchItem]);
    expect(retryLaunchAcksSpy).toHaveBeenCalledWith(receiverDeps);

    processLaunchItemsSpy.mockRestore();
    retryLaunchAcksSpy.mockRestore();
  });

  it("a throw in processLaunchItems does not prevent retryLaunchAcks", async () => {
    const processResults = vi.fn().mockReturnValue([]);
    const mockRequester = { processResults } as any;
    const mockClient = { ack: vi.fn() } as any;

    const processLaunchItemsSpy = vi.spyOn(receiverMod, "processLaunchItems").mockRejectedValue(new Error("launch exploded"));
    const retryLaunchAcksSpy = vi.spyOn(receiverMod, "retryLaunchAcks").mockResolvedValue(undefined);

    const receiverDeps = { storage: {} } as any;
    const deps: HandleLaunchItemsDeps = {
      requester: mockRequester,
      client: mockClient,
      receiverDeps,
      log: vi.fn(),
    };

    const launchItem = { item: "launch", launch_id: "l1" };

    await handleLaunchItems(deps, [launchItem]);

    expect(processLaunchItemsSpy).toHaveBeenCalledWith(receiverDeps, [launchItem]);
    expect(retryLaunchAcksSpy).toHaveBeenCalledWith(receiverDeps);

    processLaunchItemsSpy.mockRestore();
    retryLaunchAcksSpy.mockRestore();
  });

  it("retries fire with no launches in the poll via runAckRetries", async () => {
    const retryLaunchAcksSpy = vi.spyOn(receiverMod, "retryLaunchAcks").mockResolvedValue(undefined);
    const receiverDeps = { storage: {} } as any;
    const lock = createLaunchWorkLock();

    await runAckRetries({ receiverDeps, lock });

    expect(retryLaunchAcksSpy).toHaveBeenCalledTimes(1);
    expect(retryLaunchAcksSpy).toHaveBeenCalledWith(receiverDeps);

    retryLaunchAcksSpy.mockRestore();
  });

  it("overlapping calls to handleLaunchItems and runAckRetries are serialized", async () => {
    let activeWorkers = 0;
    let maxConcurrent = 0;
    const executionOrder: string[] = [];

    let resolveLaunch: () => void;
    const launchPromise = new Promise<void>((resolve) => {
      resolveLaunch = resolve;
    });

    const processLaunchItemsSpy = vi.spyOn(receiverMod, "processLaunchItems").mockImplementation(async () => {
      activeWorkers++;
      maxConcurrent = Math.max(maxConcurrent, activeWorkers);
      executionOrder.push("processLaunchItems:start");
      await launchPromise;
      executionOrder.push("processLaunchItems:end");
      activeWorkers--;
    });

    const retryLaunchAcksSpy = vi.spyOn(receiverMod, "retryLaunchAcks").mockImplementation(async () => {
      activeWorkers++;
      maxConcurrent = Math.max(maxConcurrent, activeWorkers);
      executionOrder.push("retryLaunchAcks:start");
      executionOrder.push("retryLaunchAcks:end");
      activeWorkers--;
    });

    const receiverDeps = { storage: {} } as any;
    const lock = createLaunchWorkLock();
    const deps: HandleLaunchItemsDeps = {
      client: { ack: vi.fn() } as any,
      receiverDeps,
      lock,
      log: vi.fn(),
    };

    // 1. Start handleLaunchItems with a launch item
    const launchPromiseCall = handleLaunchItems(deps, [{ item: "launch", launch_id: "l1" }]);

    // Give microtasks a turn so handleLaunchItems enters lock and starts processLaunchItems
    await new Promise((r) => setTimeout(r, 15));

    expect(executionOrder).toEqual(["processLaunchItems:start"]);
    expect(activeWorkers).toBe(1);

    // 2. Start runAckRetries while handleLaunchItems is still in flight
    const ackRetryPromise = runAckRetries({ receiverDeps, lock });

    // Give microtasks a turn; runAckRetries should be queued behind the lock
    await new Promise((r) => setTimeout(r, 15));

    expect(executionOrder).toEqual(["processLaunchItems:start"]);
    expect(activeWorkers).toBe(1);

    // 3. Resolve the in-flight processLaunchItems
    resolveLaunch!();
    await Promise.all([launchPromiseCall, ackRetryPromise]);

    // Both completed, but serialized: maxConcurrent was never > 1
    expect(maxConcurrent).toBe(1);
    expect(executionOrder).toEqual([
      "processLaunchItems:start",
      "processLaunchItems:end",
      "retryLaunchAcks:start", // from handleLaunchItems step 3
      "retryLaunchAcks:end",
      "retryLaunchAcks:start", // from runAckRetries
      "retryLaunchAcks:end",
    ]);

    processLaunchItemsSpy.mockRestore();
    retryLaunchAcksSpy.mockRestore();
  });
});

describe("createLaunchWorkLock", () => {
  it("serializes overlapping asynchronous tasks", async () => {
    const lock = createLaunchWorkLock();
    let active = 0;
    let maxActive = 0;
    const results: number[] = [];

    const makeTask = (id: number, delayMs: number) => async () => {
      return lock.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, delayMs));
        results.push(id);
        active--;
        return id;
      });
    };

    await Promise.all([makeTask(1, 20)(), makeTask(2, 10)(), makeTask(3, 5)()]);

    expect(maxActive).toBe(1);
    expect(results).toEqual([1, 2, 3]);
  });

  it("continues queue even when a task rejects", async () => {
    const lock = createLaunchWorkLock();
    const results: string[] = [];

    const p1 = lock.run(async () => {
      throw new Error("task 1 failed");
    });
    const p2 = lock.run(async () => {
      results.push("task 2 succeeded");
      return "ok";
    });

    await expect(p1).rejects.toThrow("task 1 failed");
    await expect(p2).resolves.toBe("ok");
    expect(results).toEqual(["task 2 succeeded"]);
  });
});
