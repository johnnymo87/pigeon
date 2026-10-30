import { describe, expect, it, vi, beforeEach } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import type { OpencodeClient } from "../src/opencode-client";
import { RequestTimeoutError } from "../src/routing/serve-outcome";
import {
  processLaunchItems,
  retryLaunchAcks,
  type LaunchReceiverDeps,
  type LaunchAckItem,
} from "../src/swarm/remote-launch-receiver";

describe("remote-launch-receiver", () => {
  let storage: StorageDb;
  let client: OpencodeClient;
  let ackMock: ReturnType<typeof vi.fn>;
  let statDirMock: ReturnType<typeof vi.fn>;
  let now = 1_000_000;

  beforeEach(() => {
    storage = openStorageDb(":memory:");
    now = 1_000_000;
    client = {
      healthCheck: vi.fn().mockResolvedValue(true),
      createSession: vi.fn().mockResolvedValue({ id: "ses_remote12345" }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as OpencodeClient;
    ackMock = vi.fn().mockResolvedValue(true);
    statDirMock = vi.fn().mockReturnValue(true);
  });

  function makeDeps(overrides: Partial<LaunchReceiverDeps> = {}): LaunchReceiverDeps {
    return {
      storage,
      selfMachineId: "cloudbox",
      launchFrom: ["devbox", "macbook"],
      relaySendEnabled: true,
      opencodeClient: client,
      ack: ackMock,
      statDirectory: statDirMock,
      nowFn: () => now,
      ...overrides,
    };
  }

  describe("happy path", () => {
    it("processes launch item, frames prompt, settles launched and acks", async () => {
      const deps = makeDeps();
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "lnch_001",
        from: "ses_sender12345",
        directory: "/home/dev/projects/pigeon",
        prompt: "echo hello",
        tag: null,
        expires_at: now + 60_000,
      };

      await processLaunchItems(deps, [item]);

      expect(client.createSession).toHaveBeenCalledWith("/home/dev/projects/pigeon", { timeoutMs: 15000 });
      expect(client.sendPrompt).toHaveBeenCalledWith(
        "ses_remote12345",
        "/home/dev/projects/pigeon",
        "[Remote launch requested by ses_sender12345 on devbox; report back with swarm_send to ses_sender12345.]\n\necho hello",
        { timeoutMs: 20000 },
      );

      expect(ackMock).toHaveBeenCalledWith([
        {
          kind: "launch",
          from_machine: "devbox",
          launch_id: "lnch_001",
          outcome: "launched",
          session_id: "ses_remote12345",
        },
      ]);

      const record = storage.remoteLaunch.inbound.get("devbox", "lnch_001");
      expect(record).not.toBeNull();
      expect(record?.state).toBe("settled");
      expect(record?.outcome).toBe("launched");
      expect(record?.sessionId).toBe("ses_remote12345");
      expect(record?.reason).toBeNull();
      expect(record?.ackDone).toBe(true);
    });
  });

  describe("step 1: missing or invalid from_machine or launch_id", () => {
    it("skips and does not ack when from_machine is missing or invalid", async () => {
      const deps = makeDeps();
      const invalidItems = [
        { item: "launch", launch_id: "l1", from: "ses_s1", directory: "/a", prompt: "p", expires_at: now + 1000 },
        { item: "launch", from_machine: "invalid machine with spaces", launch_id: "l1", from: "ses_s1", directory: "/a", prompt: "p", expires_at: now + 1000 },
        { item: "launch", from_machine: 123, launch_id: "l1", from: "ses_s1", directory: "/a", prompt: "p", expires_at: now + 1000 },
      ];

      await processLaunchItems(deps, invalidItems);

      expect(ackMock).not.toHaveBeenCalled();
      expect(client.createSession).not.toHaveBeenCalled();
    });

    it("skips and does not ack when launch_id is missing or invalid", async () => {
      const deps = makeDeps();
      const invalidItems = [
        { item: "launch", from_machine: "devbox", from: "ses_s1", directory: "/a", prompt: "p", expires_at: now + 1000 },
        { item: "launch", from_machine: "devbox", launch_id: "has:colon", from: "ses_s1", directory: "/a", prompt: "p", expires_at: now + 1000 },
        { item: "launch", from_machine: "devbox", launch_id: "has space", from: "ses_s1", directory: "/a", prompt: "p", expires_at: now + 1000 },
      ];

      await processLaunchItems(deps, invalidItems);

      expect(ackMock).not.toHaveBeenCalled();
      expect(client.createSession).not.toHaveBeenCalled();
    });
  });

  describe("step 2: shape invalid and expired", () => {
    it("refuses invalid when from is not a valid ses_ id", async () => {
      const deps = makeDeps();
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "l1",
        from: "not-a-ses-id",
        directory: "/a",
        prompt: "p",
        expires_at: now + 1000,
      };

      await processLaunchItems(deps, [item]);

      expect(ackMock).toHaveBeenCalledWith([
        { kind: "launch", from_machine: "devbox", launch_id: "l1", outcome: "refused", reason: "invalid" },
      ]);
      const record = storage.remoteLaunch.inbound.get("devbox", "l1");
      expect(record?.state).toBe("settled");
      expect(record?.outcome).toBe("refused");
      expect(record?.reason).toBe("invalid");
    });

    it("refuses invalid when directory is not a string", async () => {
      const deps = makeDeps();
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "l1",
        from: "ses_valid12345",
        directory: 123,
        prompt: "p",
        expires_at: now + 1000,
      };

      await processLaunchItems(deps, [item]);

      expect(ackMock).toHaveBeenCalledWith([
        { kind: "launch", from_machine: "devbox", launch_id: "l1", outcome: "refused", reason: "invalid" },
      ]);
    });

    it("refuses invalid when prompt is not a string", async () => {
      const deps = makeDeps();
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "l1",
        from: "ses_valid12345",
        directory: "/a",
        prompt: null,
        expires_at: now + 1000,
      };

      await processLaunchItems(deps, [item]);

      expect(ackMock).toHaveBeenCalledWith([
        { kind: "launch", from_machine: "devbox", launch_id: "l1", outcome: "refused", reason: "invalid" },
      ]);
    });

    it("refuses invalid when tag is invalid", async () => {
      const deps = makeDeps();
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "l1",
        from: "ses_valid12345",
        directory: "/a",
        prompt: "p",
        tag: "auto:mono",
        expires_at: now + 1000,
      };

      await processLaunchItems(deps, [item]);

      expect(ackMock).toHaveBeenCalledWith([
        { kind: "launch", from_machine: "devbox", launch_id: "l1", outcome: "refused", reason: "invalid" },
      ]);
    });

    it("refuses invalid when expires_at is not a number", async () => {
      const deps = makeDeps();
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "l1",
        from: "ses_valid12345",
        directory: "/a",
        prompt: "p",
        expires_at: "not-a-number",
      };

      await processLaunchItems(deps, [item]);

      expect(ackMock).toHaveBeenCalledWith([
        { kind: "launch", from_machine: "devbox", launch_id: "l1", outcome: "refused", reason: "invalid" },
      ]);
    });

    it("refuses expired when expires_at <= now", async () => {
      const deps = makeDeps();
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "l1",
        from: "ses_valid12345",
        directory: "/a",
        prompt: "p",
        expires_at: now,
      };

      await processLaunchItems(deps, [item]);

      expect(ackMock).toHaveBeenCalledWith([
        { kind: "launch", from_machine: "devbox", launch_id: "l1", outcome: "refused", reason: "expired" },
      ]);
      const record = storage.remoteLaunch.inbound.get("devbox", "l1");
      expect(record?.state).toBe("settled");
      expect(record?.outcome).toBe("refused");
      expect(record?.reason).toBe("expired");
    });
  });

  describe("step 4: from_machine acceptance", () => {
    it("refuses not_accepted if from_machine is not in launchFrom", async () => {
      const deps = makeDeps({ launchFrom: ["macbook"] });
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "l1",
        from: "ses_valid12345",
        directory: "/a",
        prompt: "p",
        expires_at: now + 1000,
      };

      await processLaunchItems(deps, [item]);

      expect(ackMock).toHaveBeenCalledWith([
        { kind: "launch", from_machine: "devbox", launch_id: "l1", outcome: "refused", reason: "not_accepted" },
      ]);
      const record = storage.remoteLaunch.inbound.get("devbox", "l1");
      expect(record?.reason).toBe("not_accepted");
    });

    it("refuses not_accepted if from_machine equals selfMachineId", async () => {
      const deps = makeDeps({ selfMachineId: "devbox", launchFrom: ["devbox"] });
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "l1",
        from: "ses_valid12345",
        directory: "/a",
        prompt: "p",
        expires_at: now + 1000,
      };

      await processLaunchItems(deps, [item]);

      expect(ackMock).toHaveBeenCalledWith([
        { kind: "launch", from_machine: "devbox", launch_id: "l1", outcome: "refused", reason: "not_accepted" },
      ]);
    });
  });

  describe("step 5: relaySendEnabled", () => {
    it("refuses no_return_path when relaySendEnabled is false", async () => {
      const deps = makeDeps({ relaySendEnabled: false });
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "l1",
        from: "ses_valid12345",
        directory: "/a",
        prompt: "p",
        expires_at: now + 1000,
      };

      await processLaunchItems(deps, [item]);

      expect(ackMock).toHaveBeenCalledWith([
        { kind: "launch", from_machine: "devbox", launch_id: "l1", outcome: "refused", reason: "no_return_path" },
      ]);
      const record = storage.remoteLaunch.inbound.get("devbox", "l1");
      expect(record?.reason).toBe("no_return_path");
    });
  });

  describe("step 6: opencodeClient availability", () => {
    it("refuses serve_unavailable when opencodeClient is undefined", async () => {
      const deps = makeDeps({ opencodeClient: undefined });
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "l1",
        from: "ses_valid12345",
        directory: "/a",
        prompt: "p",
        expires_at: now + 1000,
      };

      await processLaunchItems(deps, [item]);

      expect(ackMock).toHaveBeenCalledWith([
        { kind: "launch", from_machine: "devbox", launch_id: "l1", outcome: "refused", reason: "serve_unavailable" },
      ]);
      const record = storage.remoteLaunch.inbound.get("devbox", "l1");
      expect(record?.reason).toBe("serve_unavailable");
    });
  });

  describe("step 7: directory validation", () => {
    it("refuses invalid_directory when directory contains a character above U+00FF", async () => {
      const deps = makeDeps();
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "l1",
        from: "ses_valid12345",
        directory: "/home/dev/projects/dir_\u0101",
        prompt: "p",
        expires_at: now + 1000,
      };

      await processLaunchItems(deps, [item]);

      expect(ackMock).toHaveBeenCalledWith([
        { kind: "launch", from_machine: "devbox", launch_id: "l1", outcome: "refused", reason: "invalid_directory" },
      ]);
      const record = storage.remoteLaunch.inbound.get("devbox", "l1");
      expect(record?.reason).toBe("invalid_directory");
    });

    it("refuses no_such_directory when resolved directory is not absolute", async () => {
      const deps = makeDeps();
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "l1",
        from: "ses_valid12345",
        directory: "foo/bar",
        prompt: "p",
        expires_at: now + 1000,
      };

      await processLaunchItems(deps, [item]);

      expect(ackMock).toHaveBeenCalledWith([
        { kind: "launch", from_machine: "devbox", launch_id: "l1", outcome: "refused", reason: "no_such_directory" },
      ]);
      const record = storage.remoteLaunch.inbound.get("devbox", "l1");
      expect(record?.reason).toBe("no_such_directory");
    });

    it("refuses no_such_directory when statDirectory returns false", async () => {
      const deps = makeDeps({ statDirectory: vi.fn().mockReturnValue(false) });
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "l1",
        from: "ses_valid12345",
        directory: "/home/dev/projects/missing",
        prompt: "p",
        expires_at: now + 1000,
      };

      await processLaunchItems(deps, [item]);

      expect(ackMock).toHaveBeenCalledWith([
        { kind: "launch", from_machine: "devbox", launch_id: "l1", outcome: "refused", reason: "no_such_directory" },
      ]);
      const record = storage.remoteLaunch.inbound.get("devbox", "l1");
      expect(record?.reason).toBe("no_such_directory");
    });
  });

  describe("step 8: startSession outcome mapping", () => {
    it("refuses with startSession reason when health check fails (serve_unavailable)", async () => {
      (client.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const deps = makeDeps();
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "l1",
        from: "ses_valid12345",
        directory: "/home/dev/projects/pigeon",
        prompt: "p",
        expires_at: now + 1000,
      };

      await processLaunchItems(deps, [item]);

      expect(ackMock).toHaveBeenCalledWith([
        { kind: "launch", from_machine: "devbox", launch_id: "l1", outcome: "refused", reason: "serve_unavailable" },
      ]);
      const record = storage.remoteLaunch.inbound.get("devbox", "l1");
      expect(record?.state).toBe("settled");
      expect(record?.outcome).toBe("refused");
      expect(record?.reason).toBe("serve_unavailable");
    });
  });

  describe("step 3: re-handout of existing rows", () => {
    it("re-handout of settled row acks without calling createSession again", async () => {
      const deps = makeDeps();
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "lnch_rehandout",
        from: "ses_sender12345",
        directory: "/home/dev/projects/pigeon",
        prompt: "echo hello",
        tag: null,
        expires_at: now + 60_000,
      };

      // First handout
      await processLaunchItems(deps, [item]);
      expect(client.createSession).toHaveBeenCalledTimes(1);
      expect(ackMock).toHaveBeenCalledTimes(1);

      // Re-handout
      await processLaunchItems(deps, [item]);
      expect(client.createSession).toHaveBeenCalledTimes(1); // not called again
      expect(ackMock).toHaveBeenCalledTimes(2);
      expect(ackMock).toHaveBeenLastCalledWith([
        {
          kind: "launch",
          from_machine: "devbox",
          launch_id: "lnch_rehandout",
          outcome: "launched",
          session_id: "ses_remote12345",
        },
      ]);
    });

    it("re-handout of created row acks unconfirmed with session id", async () => {
      // Pre-populate DB with a row in 'created' state
      storage.remoteLaunch.inbound.insertReceived(
        { fromMachine: "devbox", launchId: "lnch_created", fromSession: "ses_sender12345" },
        now,
      );
      storage.remoteLaunch.inbound.markCreated("devbox", "lnch_created", "ses_partial999", now);

      const deps = makeDeps();
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "lnch_created",
        from: "ses_sender12345",
        directory: "/home/dev/projects/pigeon",
        prompt: "echo hello",
        tag: null,
        expires_at: now + 60_000,
      };

      await processLaunchItems(deps, [item]);

      expect(client.createSession).not.toHaveBeenCalled();
      expect(ackMock).toHaveBeenCalledWith([
        {
          kind: "launch",
          from_machine: "devbox",
          launch_id: "lnch_created",
          outcome: "unconfirmed",
          session_id: "ses_partial999",
        },
      ]);
    });

    it("re-handout of received row acks unconfirmed without session id", async () => {
      // Pre-populate DB with a row in 'received' state
      storage.remoteLaunch.inbound.insertReceived(
        { fromMachine: "devbox", launchId: "lnch_received", fromSession: "ses_sender12345" },
        now,
      );

      const deps = makeDeps();
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "lnch_received",
        from: "ses_sender12345",
        directory: "/home/dev/projects/pigeon",
        prompt: "echo hello",
        tag: null,
        expires_at: now + 60_000,
      };

      await processLaunchItems(deps, [item]);

      expect(client.createSession).not.toHaveBeenCalled();
      expect(ackMock).toHaveBeenCalledWith([
        {
          kind: "launch",
          from_machine: "devbox",
          launch_id: "lnch_received",
          outcome: "unconfirmed",
        },
      ]);
    });
  });

  describe("prompt timeout outcome", () => {
    it("acks unconfirmed with session id when prompt times out", async () => {
      (client.sendPrompt as ReturnType<typeof vi.fn>).mockRejectedValue(
        new RequestTimeoutError(20000, "http://127.0.0.1:4096/prompt_async"),
      );

      const deps = makeDeps();
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "lnch_timeout",
        from: "ses_sender12345",
        directory: "/home/dev/projects/pigeon",
        prompt: "echo hello",
        tag: null,
        expires_at: now + 60_000,
      };

      await processLaunchItems(deps, [item]);

      expect(ackMock).toHaveBeenCalledWith([
        {
          kind: "launch",
          from_machine: "devbox",
          launch_id: "lnch_timeout",
          outcome: "unconfirmed",
          session_id: "ses_remote12345",
        },
      ]);

      const record = storage.remoteLaunch.inbound.get("devbox", "lnch_timeout");
      expect(record?.state).toBe("settled");
      expect(record?.outcome).toBe("unconfirmed");
      expect(record?.sessionId).toBe("ses_remote12345");

      // Alert should include '(prompt may not have arrived)'
      const alert = storage.alerts.nextDrainable(now);
      expect(alert?.text).toContain("ses_remote12345");
      expect(alert?.text).toContain("(prompt may not have arrived)");
    });
  });

  describe("ack failure and retryLaunchAcks", () => {
    it("marks retry on ack failure, and retryLaunchAcks later sends the same item", async () => {
      ackMock.mockResolvedValueOnce(false); // First ack fails

      const deps = makeDeps();
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "lnch_ackfail",
        from: "ses_sender12345",
        directory: "/home/dev/projects/pigeon",
        prompt: "echo hello",
        tag: null,
        expires_at: now + 60_000,
      };

      await processLaunchItems(deps, [item]);

      const record = storage.remoteLaunch.inbound.get("devbox", "lnch_ackfail");
      expect(record?.state).toBe("settled");
      expect(record?.ackDone).toBe(false);
      expect(record?.ackAttempts).toBe(1);
      expect(record?.nextAckAt).toBe(now + 5000); // 5s backoff

      // Advance clock before nextAckAt: listAcksDue should be empty
      expect(storage.remoteLaunch.inbound.listAcksDue(now + 1000)).toHaveLength(0);

      // Now advance clock to nextAckAt
      now += 5000;
      expect(storage.remoteLaunch.inbound.listAcksDue(now)).toHaveLength(1);

      // Sockets/worker are now healthy: ack returns true
      ackMock.mockResolvedValueOnce(true);

      await retryLaunchAcks(deps);

      expect(ackMock).toHaveBeenLastCalledWith([
        {
          kind: "launch",
          from_machine: "devbox",
          launch_id: "lnch_ackfail",
          outcome: "launched",
          session_id: "ses_remote12345",
        },
      ]);

      const updated = storage.remoteLaunch.inbound.get("devbox", "lnch_ackfail");
      expect(updated?.ackDone).toBe(true);
    });

    it("marks ack done when ack item fails wire regexes (does not send invalid item)", async () => {
      // Settle a row with an invalid reason (e.g. uppercase letters or spaces not matching ^[a-z0-9_]{1,64}$)
      storage.remoteLaunch.inbound.insertReceived(
        { fromMachine: "devbox", launchId: "lnch_badack", fromSession: "ses_sender12345" },
        now,
      );
      storage.remoteLaunch.inbound.settle("devbox", "lnch_badack", "refused", null, "INVALID REASON!", now);

      const deps = makeDeps();
      await retryLaunchAcks(deps);

      expect(ackMock).not.toHaveBeenCalled();
      const updated = storage.remoteLaunch.inbound.get("devbox", "lnch_badack");
      expect(updated?.ackDone).toBe(true);
    });

    it("never throws if storage or ack throws", async () => {
      const throwingDeps = makeDeps({
        ack: vi.fn().mockRejectedValue(new Error("network explode")),
      });
      await expect(retryLaunchAcks(throwingDeps)).resolves.not.toThrow();
    });
  });

  describe("resilience", () => {
    it("processLaunchItems never throws even when items array is invalid or unexpected error occurs", async () => {
      const deps = makeDeps();
      await expect(processLaunchItems(deps, null as unknown as unknown[])).resolves.not.toThrow();
      await expect(processLaunchItems(deps, [undefined, 123, "string", {}])).resolves.not.toThrow();
    });
  });

  describe("step 10 side-effects: alerts, autoAttach, tagging", () => {
    it("enqueues alert once even when processed twice (refMsgId dedup)", async () => {
      const deps = makeDeps();
      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "lnch_dedup",
        from: "ses_sender12345",
        directory: "/home/dev/projects/pigeon",
        prompt: "echo hello",
        tag: null,
        expires_at: now + 60_000,
      };

      await processLaunchItems(deps, [item]);
      await processLaunchItems(deps, [item]);

      expect(storage.alerts.countDrainable(now)).toBe(1);
      const alert = storage.alerts.nextDrainable(now);
      expect(alert?.refMsgId).toBe("rl:devbox:lnch_dedup");
      expect(alert?.text).toBe(
        "🚀 Remote launch from devbox (ses_sender12345): session ses_remote12345 in /home/dev/projects/pigeon\necho hello",
      );
    });

    it("applies tag via fake runner and calls onTagged", async () => {
      const runOcTagsMock = vi.fn().mockResolvedValue({ code: 0, stdout: "Tagged", stderr: "" });
      const onTaggedMock = vi.fn();

      const deps = makeDeps({
        runOcTags: () => runOcTagsMock,
        onTagged: onTaggedMock,
      });

      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "lnch_tag",
        from: "ses_sender12345",
        directory: "/home/dev/projects/pigeon",
        prompt: "echo hello",
        tag: "my-tag",
        expires_at: now + 60_000,
      };

      await processLaunchItems(deps, [item]);

      // Allow background microtasks to finish
      await vi.waitFor(() => {
        expect(runOcTagsMock).toHaveBeenCalledWith(["set", "my-tag", "ses_remote12345"]);
        expect(onTaggedMock).toHaveBeenCalledWith("ses_remote12345");
      });
    });

    it("nothing awaits the tag (a never-resolving runner does not block processLaunchItems)", async () => {
      const neverResolvingRunner = vi.fn().mockImplementation(() => new Promise(() => {}));

      const deps = makeDeps({
        runOcTags: () => neverResolvingRunner,
      });

      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "lnch_never_resolve",
        from: "ses_sender12345",
        directory: "/home/dev/projects/pigeon",
        prompt: "echo hello",
        tag: "my-tag",
        expires_at: now + 60_000,
      };

      // processLaunchItems should resolve immediately without hanging on the runner
      await processLaunchItems(deps, [item]);

      expect(ackMock).toHaveBeenCalled();
      expect(neverResolvingRunner).toHaveBeenCalled();
    });

    it("calls autoAttach with spawn test seam", async () => {
      const spawnMock = vi.fn(() => ({
        unref: vi.fn(),
        on: vi.fn(),
      } as unknown as ReturnType<typeof import("child_process").spawn>));

      const deps = makeDeps({ spawn: spawnMock });

      const item = {
        item: "launch",
        from_machine: "devbox",
        launch_id: "lnch_attach",
        from: "ses_sender12345",
        directory: "/home/dev/projects/pigeon",
        prompt: "echo hello",
        tag: null,
        expires_at: now + 60_000,
      };

      await processLaunchItems(deps, [item]);

      expect(spawnMock).toHaveBeenCalledWith(
        expect.any(String),
        ["ses_remote12345"],
        expect.objectContaining({ detached: true }),
      );
    });
  });
});
