import { describe, expect, it, vi } from "vitest";
import { handleLaunchItems, type HandleLaunchItemsDeps } from "../src/swarm/remote-launch-poll";
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
});
