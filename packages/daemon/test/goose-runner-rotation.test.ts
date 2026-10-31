import { afterEach, describe, expect, it } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { GOOSE_BACKEND_KIND } from "../src/goose/backend-kind";
import { GooseRunnerRegistry, GooseSessionRunner } from "../src/goose/session-runner";
import { dropGooseRunnerWithSwarmNotify } from "../src/goose/runner-rotation";

describe("goose runner rotation and session deletion cleanup", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newStorage(): StorageDb {
    storage = openStorageDb(":memory:");
    return storage;
  }

  it("notifies original sender when queued swarm items exist on dropped runner", () => {
    const s = newStorage();
    const now = 1_000_000;

    // Create session row for coordinator
    s.sessions.upsert({
      sessionId: "gse_coord_retire",
      backendKind: GOOSE_BACKEND_KIND,
      backendEndpoint: "ws://127.0.0.1:4280/acp",
      notify: true,
    });

    // Insert a swarm message from a worker to this coordinator
    s.swarm.insert(
      {
        msgId: "msg_queued_1",
        fromSession: "ses_worker",
        toSession: "gse_coord_retire",
        channel: null,
        kind: "task.assign",
        priority: "normal",
        replyTo: null,
        payload: "assign task to coordinator",
      },
      now,
    );
    s.swarm.markHandedOff("msg_queued_1", now);

    // Insert an inflight row for the turn
    s.gooseInflight.insert({
      commandId: "swarm:msg_queued_1",
      sessionId: "gse_coord_retire",
      backendSessionId: "20261031_1",
      isHonk: true,
      promptText: "assign task to coordinator",
      state: "queued",
    });

    // Create registry and runner
    const sessionRec = s.sessions.get("gse_coord_retire")!;
    const registry = new GooseRunnerRegistry({
      createRunner: () => {
        const runner = new GooseSessionRunner({
          session: sessionRec,
          client: {
            prompt: async () => ({ kind: "receipt" }),
            steer: async () => ({ kind: "steered" }),
            close: () => {},
            isClosed: () => false,
          } as never,
          inflight: s.gooseInflight,
          postStop: async () => {},
          touch: () => {},
        });
        // Simulate queued items
        runner.enqueueRecovered({
          commandId: "swarm:msg_queued_1",
          sessionId: "gse_coord_retire",
          backendSessionId: "20261031_1",
          isHonk: true,
          promptText: "assign task to coordinator",
          recoveryAttempts: 0,
          createdAt: now,
          updatedAt: now,
          lastAliveAt: now,
          cleanSuspend: false,
          state: "queued",
        });
        return runner;
      },
    });

    // Instantiate the runner in registry
    const runner = registry.get(sessionRec);
    expect(runner.queuedItems()).toHaveLength(1);
    expect(registry.peek("gse_coord_retire")).toBeDefined();

    // Call dropGooseRunnerWithSwarmNotify
    dropGooseRunnerWithSwarmNotify(s, registry, "gse_coord_retire", now + 1000);

    // Runner must be dropped from registry
    expect(registry.peek("gse_coord_retire")).toBeUndefined();

    // Original message marked failed
    const originalMsg = s.swarm.getByMsgId("msg_queued_1");
    expect(originalMsg?.state).toBe("failed");

    // Inflight turns row deleted
    expect(s.gooseInflight.get("swarm:msg_queued_1")).toBeUndefined();

    // Sender notified of failure with appropriate wording
    const failureRows = s.db
      .prepare("SELECT * FROM swarm_messages WHERE to_session = 'ses_worker' AND kind = 'delivery.failed'")
      .all() as Array<{ payload: string; reply_to: string }>;
    expect(failureRows).toHaveLength(1);
    expect(failureRows[0]!.reply_to).toBe("msg_queued_1");
    expect(failureRows[0]!.payload).toContain(
      "the coordinator session was retired before it read the message; resend to its successor",
    );
  });

  it("handles mixed queued items and ignores non-swarm items for notification", () => {
    const s = newStorage();
    const now = 1_000_000;

    s.sessions.upsert({
      sessionId: "gse_mixed",
      backendKind: GOOSE_BACKEND_KIND,
      backendEndpoint: "ws://127.0.0.1:4280/acp",
      notify: true,
    });

    s.swarm.insert(
      {
        msgId: "msg_sw_1",
        fromSession: "ses_sender_1",
        toSession: "gse_mixed",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "swarm payload",
      },
      now,
    );
    s.swarm.markHandedOff("msg_sw_1", now);

    s.gooseInflight.insert({
      commandId: "swarm:msg_sw_1",
      sessionId: "gse_mixed",
      backendSessionId: "20261031_mixed",
      isHonk: true,
      promptText: "swarm payload",
      state: "queued",
    });

    s.gooseInflight.insert({
      commandId: "tg_non_swarm",
      sessionId: "gse_mixed",
      backendSessionId: "20261031_mixed",
      isHonk: true,
      promptText: "telegram payload",
      state: "queued",
    });

    const sessionRec = s.sessions.get("gse_mixed")!;
    const registry = new GooseRunnerRegistry({
      createRunner: () => {
        const runner = new GooseSessionRunner({
          session: sessionRec,
          client: {
            prompt: async () => ({ kind: "receipt" }),
            steer: async () => ({ kind: "steered" }),
            close: () => {},
            isClosed: () => false,
          } as never,
          inflight: s.gooseInflight,
          postStop: async () => {},
          touch: () => {},
        });
        runner.enqueueRecovered({
          commandId: "swarm:msg_sw_1",
          sessionId: "gse_mixed",
          backendSessionId: "20261031_mixed",
          isHonk: true,
          promptText: "swarm payload",
          recoveryAttempts: 0,
          createdAt: now,
          updatedAt: now,
          lastAliveAt: now,
          cleanSuspend: false,
          state: "queued",
        });
        runner.enqueueRecovered({
          commandId: "tg_non_swarm",
          sessionId: "gse_mixed",
          backendSessionId: "20261031_mixed",
          isHonk: true,
          promptText: "telegram payload",
          recoveryAttempts: 0,
          createdAt: now,
          updatedAt: now,
          lastAliveAt: now,
          cleanSuspend: false,
          state: "queued",
        });
        return runner;
      },
    });

    registry.get(sessionRec);
    dropGooseRunnerWithSwarmNotify(s, registry, "gse_mixed", now + 1000);

    expect(registry.peek("gse_mixed")).toBeUndefined();
    expect(s.swarm.getByMsgId("msg_sw_1")?.state).toBe("failed");
    expect(s.gooseInflight.get("swarm:msg_sw_1")).toBeUndefined();

    // Only one delivery.failed message sent (for the swarm item)
    const failureRows = s.db
      .prepare("SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'")
      .all() as Array<{ reply_to: string }>;
    expect(failureRows).toHaveLength(1);
    expect(failureRows[0]!.reply_to).toBe("msg_sw_1");
  });

  it("does not throw when gooseRunners is undefined or session has no runner", () => {
    const s = newStorage();
    expect(() => dropGooseRunnerWithSwarmNotify(s, undefined, "gse_none")).not.toThrow();

    const registry = new GooseRunnerRegistry({
      createRunner: () => ({} as never),
    });
    expect(() => dropGooseRunnerWithSwarmNotify(s, registry, "gse_none")).not.toThrow();
  });
});
