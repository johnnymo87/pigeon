import { describe, expect, it, vi, beforeEach } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import {
  RemoteLaunchRequester,
  formatLaunchResult,
  type RemoteLaunchRequesterDeps,
  type LaunchResultAck,
} from "../src/swarm/remote-launch-requester";
import type { RemoteLaunchClient } from "../src/worker/remote-launch-client";

describe("RemoteLaunchRequester", () => {
  let storage: StorageDb;
  let client: Pick<RemoteLaunchClient, "request" | "ack">;
  let now = 1_000_000;
  const selfMachineId = "cloudbox";

  beforeEach(() => {
    storage = openStorageDb(":memory:");
    now = 1_000_000;
    client = {
      request: vi.fn().mockResolvedValue({ kind: "accepted", toMachine: "devbox", duplicate: false }),
      ack: vi.fn().mockResolvedValue(true),
    };
  });

  function makeRequester(overrides: Partial<RemoteLaunchRequesterDeps> = {}): RemoteLaunchRequester {
    return new RemoteLaunchRequester({
      storage,
      client,
      sendEnabled: true,
      selfMachineId,
      nowFn: () => now,
      ...overrides,
    });
  }

  function getSwarmMessages(): Array<{
    msg_id: string;
    from_session: string;
    to_session: string;
    kind: string;
    payload: string;
  }> {
    return storage.db
      .prepare("SELECT msg_id, from_session, to_session, kind, payload FROM swarm_messages ORDER BY created_at ASC")
      .all() as any[];
  }

  describe("formatLaunchResult", () => {
    it("formats launched outcome", () => {
      const text = formatLaunchResult({
        launchId: "lnch_1",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        outcome: "launched",
        sessionId: "ses_abc12345",
        reason: null,
      });
      expect(text).toBe(
        "REMOTE LAUNCH STARTED: launch lnch_1 started session ses_abc12345 on devbox in /home/dev/pigeon. Message it with swarm_send to ses_abc12345.",
      );
    });

    it("formats refused outcome with reason never_collected", () => {
      const text = formatLaunchResult({
        launchId: "lnch_1",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        outcome: "refused",
        sessionId: null,
        reason: "never_collected",
      });
      expect(text).toBe(
        "REMOTE LAUNCH NOT STARTED: launch lnch_1 was never collected by devbox and did NOT start. Safe to retry.",
      );
    });

    it("formats refused outcome with other reason", () => {
      const text = formatLaunchResult({
        launchId: "lnch_1",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        outcome: "refused",
        sessionId: null,
        reason: "target_offline",
      });
      expect(text).toBe(
        "REMOTE LAUNCH REFUSED: launch lnch_1 did NOT start on devbox (target_offline). Safe to retry.",
      );
    });

    it("formats unconfirmed outcome with session id", () => {
      const text = formatLaunchResult({
        launchId: "lnch_1",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        outcome: "unconfirmed",
        sessionId: "ses_abc12345",
        reason: null,
      });
      expect(text).toBe(
        "REMOTE LAUNCH UNCONFIRMED: launch lnch_1 created session ses_abc12345 on devbox, but its prompt may not have arrived. swarm_send it the task if it does not report in. Do NOT launch again.",
      );
    });

    it("formats unconfirmed outcome without session id", () => {
      const text = formatLaunchResult({
        launchId: "lnch_1",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        outcome: "unconfirmed",
        sessionId: null,
        reason: null,
      });
      expect(text).toBe(
        "REMOTE LAUNCH UNCONFIRMED: launch lnch_1 may or may not have started on devbox. Check swarm_list remote: true before retrying.",
      );
    });
  });

  describe("handleRequest", () => {
    it("returns 403 when sendEnabled is false", async () => {
      const requester = makeRequester({ sendEnabled: false });
      const res = await requester.handleRequest({
        launch_id: "lnch_1",
        from: "ses_sender123",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        prompt: "hello",
      });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "launch_send_disabled" });
    });

    it("validates request body fields and writes nothing on failure", async () => {
      const requester = makeRequester();

      // invalid body type
      expect(await requester.handleRequest("not-an-object")).toEqual({
        status: 400,
        body: { error: "invalid", detail: "request body must be an object" },
      });

      // invalid launch_id
      expect(
        await requester.handleRequest({
          launch_id: "bad:id",
          from: "ses_sender123",
          machine: "devbox",
          directory: "/home/dev/pigeon",
          prompt: "hello",
        }),
      ).toEqual({
        status: 400,
        body: { error: "invalid", detail: "launch_id must be 1-128 characters with no ':' or whitespace" },
      });

      // invalid from
      expect(
        await requester.handleRequest({
          launch_id: "lnch_1",
          from: "not_a_session",
          machine: "devbox",
          directory: "/home/dev/pigeon",
          prompt: "hello",
        }),
      ).toEqual({
        status: 400,
        body: { error: "invalid", detail: "from must be a ses_ session id" },
      });

      // invalid machine
      expect(
        await requester.handleRequest({
          launch_id: "lnch_1",
          from: "ses_sender123",
          machine: "invalid machine id with spaces",
          directory: "/home/dev/pigeon",
          prompt: "hello",
        }),
      ).toEqual({
        status: 400,
        body: { error: "invalid", detail: "machine must be a valid machine id" },
      });

      // invalid directory
      expect(
        await requester.handleRequest({
          launch_id: "lnch_1",
          from: "ses_sender123",
          machine: "devbox",
          directory: "",
          prompt: "hello",
        }),
      ).toEqual({
        status: 400,
        body: { error: "invalid", detail: "directory must be 1-512 characters with no control characters" },
      });

      // invalid prompt
      expect(
        await requester.handleRequest({
          launch_id: "lnch_1",
          from: "ses_sender123",
          machine: "devbox",
          directory: "/home/dev/pigeon",
          prompt: "",
        }),
      ).toEqual({
        status: 400,
        body: { error: "invalid", detail: "prompt must be 1-16000 code points" },
      });

      // invalid tag
      expect(
        await requester.handleRequest({
          launch_id: "lnch_1",
          from: "ses_sender123",
          machine: "devbox",
          directory: "/home/dev/pigeon",
          prompt: "hello",
          tag: "auto:bad",
        }),
      ).toEqual({
        status: 400,
        body: { error: "invalid", detail: "tag must be null or a valid tag" },
      });

      // Check nothing written to DB
      expect(storage.remoteLaunch.outbound.get("lnch_1")).toBeNull();
      expect(client.request).not.toHaveBeenCalled();
    });

    it("asserts outbound row exists before client.request is called", async () => {
      let outboundExistedDuringRequest = false;
      client.request = vi.fn().mockImplementation(async (body) => {
        const row = storage.remoteLaunch.outbound.get(body.launch_id);
        if (row && row.state === "sending") {
          outboundExistedDuringRequest = true;
        }
        return { kind: "accepted", toMachine: "devbox", duplicate: false };
      });

      const requester = makeRequester();
      const res = await requester.handleRequest({
        launch_id: "lnch_001",
        from: "ses_sender123",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        prompt: "echo hi",
      });

      expect(outboundExistedDuringRequest).toBe(true);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        launch_id: "lnch_001",
        status: "accepted",
        to_machine: "devbox",
      });

      const stored = storage.remoteLaunch.outbound.get("lnch_001");
      expect(stored?.state).toBe("accepted");
    });

    it("uses tag inheritance only when tag is absent (undefined), not explicit null", async () => {
      const resolveRequesterTag = vi.fn().mockResolvedValue("inherited-tag");
      const requester = makeRequester({ resolveRequesterTag });

      // 1. Tag absent: inherits
      await requester.handleRequest({
        launch_id: "lnch_inherit",
        from: "ses_sender123",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        prompt: "echo hi",
      });
      expect(resolveRequesterTag).toHaveBeenCalledWith("ses_sender123");
      const row1 = storage.remoteLaunch.outbound.get("lnch_inherit");
      const body1 = JSON.parse(row1!.requestJson);
      expect(body1.tag).toBe("inherited-tag");

      resolveRequesterTag.mockClear();

      // 2. Tag explicit null: does NOT inherit
      await requester.handleRequest({
        launch_id: "lnch_explicit_null",
        from: "ses_sender123",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        prompt: "echo hi",
        tag: null,
      });
      expect(resolveRequesterTag).not.toHaveBeenCalled();
      const row2 = storage.remoteLaunch.outbound.get("lnch_explicit_null");
      const body2 = JSON.parse(row2!.requestJson);
      expect(body2.tag).toBeNull();
    });

    it("handles client refusal at request time (no local swarm message)", async () => {
      client.request = vi.fn().mockResolvedValue({
        kind: "refused",
        code: "target_offline",
        detail: "devbox is offline",
        status: 503,
      });

      const requester = makeRequester();
      const res = await requester.handleRequest({
        launch_id: "lnch_refused",
        from: "ses_sender123",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        prompt: "echo hi",
      });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: "target_offline",
        detail: "devbox is offline",
      });

      const row = storage.remoteLaunch.outbound.get("lnch_refused");
      expect(row?.state).toBe("refused");
      expect(row?.refusalCode).toBe("target_offline");
      expect(row?.refusalStatus).toBe(503);

      // Verify NO local swarm messages inserted
      expect(getSwarmMessages()).toHaveLength(0);
    });

    it("handles client transient error at request time -> marks retry and returns 202 pending", async () => {
      client.request = vi.fn().mockResolvedValue({
        kind: "transient",
        detail: "network timeout",
      });

      const requester = makeRequester();
      const res = await requester.handleRequest({
        launch_id: "lnch_transient",
        from: "ses_sender123",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        prompt: "echo hi",
      });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        launch_id: "lnch_transient",
        status: "pending",
      });

      const row = storage.remoteLaunch.outbound.get("lnch_transient");
      expect(row?.state).toBe("sending");
      expect(row?.attempts).toBe(1);
      expect(row?.nextAttemptAt).toBe(now + 5000);
    });

    it("handles idempotent repeat of existing launch_id", async () => {
      const requester = makeRequester();

      // 1. Initial request -> accepted
      const res1 = await requester.handleRequest({
        launch_id: "lnch_dup",
        from: "ses_sender123",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        prompt: "echo hi",
      });
      expect(res1.status).toBe(202);
      expect(res1.body).toEqual({
        launch_id: "lnch_dup",
        status: "accepted",
        to_machine: "devbox",
      });
      expect(client.request).toHaveBeenCalledTimes(1);

      // 2. Same request again -> answered from state, client NOT called again
      const res2 = await requester.handleRequest({
        launch_id: "lnch_dup",
        from: "ses_sender123",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        prompt: "echo hi",
      });
      expect(res2.status).toBe(202);
      expect(res2.body).toEqual({
        launch_id: "lnch_dup",
        status: "accepted",
        to_machine: "devbox",
      });
      expect(client.request).toHaveBeenCalledTimes(1);

      // 3. Different from or machine -> 409 launch_id_conflict
      const resConflict = await requester.handleRequest({
        launch_id: "lnch_dup",
        from: "ses_other_sender",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        prompt: "echo hi",
      });
      expect(resConflict.status).toBe(409);
      expect(resConflict.body).toEqual({ error: "launch_id_conflict" });
    });

    it("idempotent repeat for refused state returns stored code and status", async () => {
      client.request = vi.fn().mockResolvedValue({
        kind: "refused",
        code: "not_accepted",
        detail: "launch not accepted",
        status: 403,
      });

      const requester = makeRequester();
      await requester.handleRequest({
        launch_id: "lnch_refused_dup",
        from: "ses_sender123",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        prompt: "echo hi",
      });

      // Repeat request
      const res = await requester.handleRequest({
        launch_id: "lnch_refused_dup",
        from: "ses_sender123",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        prompt: "echo hi",
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "not_accepted",
        detail: "launch not accepted",
      });
      expect(client.request).toHaveBeenCalledTimes(1);
    });
  });

  describe("tick", () => {
    it("retries transient requests and transitions to accepted", async () => {
      client.request = vi.fn().mockResolvedValueOnce({
        kind: "transient",
        detail: "network hiccup",
      });

      const requester = makeRequester();
      await requester.handleRequest({
        launch_id: "lnch_retry",
        from: "ses_sender123",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        prompt: "echo hi",
      });

      expect(storage.remoteLaunch.outbound.get("lnch_retry")?.state).toBe("sending");

      // Advance time past next_attempt_at
      now += 6000;
      client.request = vi.fn().mockResolvedValueOnce({
        kind: "accepted",
        toMachine: "devbox",
        duplicate: false,
      });

      await requester.tick();

      const row = storage.remoteLaunch.outbound.get("lnch_retry");
      expect(row?.state).toBe("accepted");
      expect(client.request).toHaveBeenCalledTimes(1);
    });

    it("transient then refused on tick inserts a refused launch.result swarm row to the requester", async () => {
      client.request = vi.fn().mockResolvedValueOnce({
        kind: "transient",
        detail: "network hiccup",
      });

      const requester = makeRequester();
      await requester.handleRequest({
        launch_id: "lnch_refuse_tick",
        from: "ses_sender123",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        prompt: "echo hi",
      });

      now += 6000;
      client.request = vi.fn().mockResolvedValueOnce({
        kind: "refused",
        code: "target_offline",
        detail: "devbox offline",
        status: 503,
      });

      await requester.tick();

      const row = storage.remoteLaunch.outbound.get("lnch_refuse_tick");
      expect(row?.state).toBe("refused");
      expect(row?.resolvedOutcome).toBe("refused");

      // Check local swarm message was inserted
      const messages = getSwarmMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.from_session).toBe("pigeon");
      expect(messages[0]!.to_session).toBe("ses_sender123");
      expect(messages[0]!.kind).toBe("launch.result");
      expect(messages[0]!.payload).toBe(
        "REMOTE LAUNCH REFUSED: launch lnch_refuse_tick did NOT start on devbox (target_offline). Safe to retry.",
      );
    });

    describe("pre-dedup refusal codes on tick resend", () => {
      const preDedupCodes = [
        { code: "unauthorized", status: 401 },
        { code: "machine_mismatch", status: 400 },
        { code: "worker_too_old", status: 404 },
        { code: "launch_unavailable", status: 503 },
      ];

      for (const { code, status } of preDedupCodes) {
        it(`treats ${code} in tick as transient: no refused message, row stays sending with backoff`, async () => {
          client.request = vi.fn().mockResolvedValueOnce({
            kind: "transient",
            detail: "timeout",
          });

          const requester = makeRequester();
          await requester.handleRequest({
            launch_id: `lnch_${code}`,
            from: "ses_sender123",
            machine: "devbox",
            directory: "/home/dev/pigeon",
            prompt: "echo hi",
          });

          // Row is in state 'sending' with attempts = 1
          const initialRow = storage.remoteLaunch.outbound.get(`lnch_${code}`);
          expect(initialRow?.state).toBe("sending");
          expect(initialRow?.attempts).toBe(1);

          now += 6000;
          client.request = vi.fn().mockResolvedValueOnce({
            kind: "refused",
            code,
            detail: `${code} occurred`,
            status,
          });

          await requester.tick();

          const row = storage.remoteLaunch.outbound.get(`lnch_${code}`);
          expect(row?.state).toBe("sending");
          expect(row?.resolvedOutcome).toBeNull();
          expect(row?.attempts).toBe(2);
          expect(row?.nextAttemptAt).toBe(now + 10_000); // 5000 * 2^1 = 10000

          // No refused launch.result message was inserted
          const messages = getSwarmMessages();
          expect(messages).toHaveLength(0);
        });
      }

      it("normal refusal (not_accepted) in tick still marks refused and inserts launch.result", async () => {
        client.request = vi.fn().mockResolvedValueOnce({
          kind: "transient",
          detail: "timeout",
        });

        const requester = makeRequester();
        await requester.handleRequest({
          launch_id: "lnch_not_accepted",
          from: "ses_sender123",
          machine: "devbox",
          directory: "/home/dev/pigeon",
          prompt: "echo hi",
        });

        now += 6000;
        client.request = vi.fn().mockResolvedValueOnce({
          kind: "refused",
          code: "not_accepted",
          detail: "devbox does not accept launches from cloudbox",
          status: 403,
        });

        await requester.tick();

        const row = storage.remoteLaunch.outbound.get("lnch_not_accepted");
        expect(row?.state).toBe("refused");
        expect(row?.resolvedOutcome).toBe("refused");

        const messages = getSwarmMessages();
        expect(messages).toHaveLength(1);
        expect(messages[0]!.kind).toBe("launch.result");
        expect(messages[0]!.payload).toContain(
          "REMOTE LAUNCH REFUSED: launch lnch_not_accepted did NOT start on devbox (not_accepted).",
        );
      });

      it("handleRequest first attempt with pre-dedup refusal code still marks refused immediately", async () => {
        client.request = vi.fn().mockResolvedValueOnce({
          kind: "refused",
          code: "unauthorized",
          detail: "bad token",
          status: 401,
        });

        const requester = makeRequester();
        const res = await requester.handleRequest({
          launch_id: "lnch_unauth_initial",
          from: "ses_sender123",
          machine: "devbox",
          directory: "/home/dev/pigeon",
          prompt: "echo hi",
        });

        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: "unauthorized", detail: "bad token" });

        const row = storage.remoteLaunch.outbound.get("lnch_unauth_initial");
        expect(row?.state).toBe("refused");
        expect(row?.resolvedOutcome).toBe("refused");
      });
    });

    it("deadline inserts unconfirmed once", async () => {
      const requester = makeRequester();
      await requester.handleRequest({
        launch_id: "lnch_deadline",
        from: "ses_sender123",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        prompt: "echo hi",
      });

      const row = storage.remoteLaunch.outbound.get("lnch_deadline");
      expect(row?.state).toBe("accepted");

      // Advance time past deadline
      now = row!.deadlineAt + 1000;

      await requester.tick();

      const updated = storage.remoteLaunch.outbound.get("lnch_deadline");
      expect(updated?.state).toBe("deadline");
      expect(updated?.resolvedOutcome).toBe("unconfirmed");

      const messages = getSwarmMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.kind).toBe("launch.result");
      expect(messages[0]!.payload).toBe(
        "REMOTE LAUNCH UNCONFIRMED: launch lnch_deadline may or may not have started on devbox. Check swarm_list remote: true before retrying.",
      );

      // Calling tick again does NOT insert duplicate message
      await requester.tick();
      expect(getSwarmMessages()).toHaveLength(1);
    });

    it("tick run while request is pending does not call request a second time", async () => {
      let resolveRequest: (val: any) => void;
      client.request = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRequest = resolve;
          }),
      );

      const requester = makeRequester();
      const requestPromise = requester.handleRequest({
        launch_id: "lnch_race",
        from: "ses_sender123",
        machine: "devbox",
        directory: "/home/dev/pigeon",
        prompt: "echo hi",
      });

      // The outbound row now exists
      expect(storage.remoteLaunch.outbound.get("lnch_race")?.state).toBe("sending");

      // Tick runs while request is still pending
      await requester.tick();

      // client.request was only called once (by handleRequest), NOT a second time by tick
      expect(client.request).toHaveBeenCalledTimes(1);

      // Now complete the pending request
      resolveRequest!({
        kind: "accepted",
        toMachine: "devbox",
        duplicate: false,
      });
      await requestPromise;
      expect(storage.remoteLaunch.outbound.get("lnch_race")?.state).toBe("accepted");
    });
  });

  describe("processResults", () => {
    it("result receipt inserts one swarm row and duplicate result id inserts none", () => {
      const requester = makeRequester();
      // Setup outbound launch
      storage.remoteLaunch.outbound.insert({
        launchId: "lnch_001",
        fromSession: "ses_sender123",
        toMachine: "devbox",
        directory: "/home/dev/pigeon",
        requestJson: "{}",
        createdAt: now,
      });

      const item = {
        item: "launch_result",
        from_machine: selfMachineId,
        result_id: "r:lnch_001",
        launch_id: "lnch_001",
        machine: "devbox",
        outcome: "launched",
        session_id: "ses_started456",
        reason: null,
      };

      const acks1 = requester.processResults([item]);
      expect(acks1).toEqual([
        {
          kind: "result",
          from_machine: selfMachineId,
          result_id: "r:lnch_001",
          outcome: "delivered",
        },
      ]);

      const messages = getSwarmMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.kind).toBe("launch.result");
      expect(messages[0]!.to_session).toBe("ses_sender123");
      expect(messages[0]!.payload).toBe(
        "REMOTE LAUNCH STARTED: launch lnch_001 started session ses_started456 on devbox in /home/dev/pigeon. Message it with swarm_send to ses_started456.",
      );

      // Repeat with same result_id
      const acks2 = requester.processResults([item]);
      expect(acks2).toEqual([
        {
          kind: "result",
          from_machine: selfMachineId,
          result_id: "r:lnch_001",
          outcome: "delivered",
        },
      ]);
      // No new message
      expect(getSwarmMessages()).toHaveLength(1);
    });

    it("correction (r:x unconfirmed then r:x:launched) inserts two rows", () => {
      const requester = makeRequester();
      storage.remoteLaunch.outbound.insert({
        launchId: "lnch_corr",
        fromSession: "ses_sender123",
        toMachine: "devbox",
        directory: "/home/dev/pigeon",
        requestJson: "{}",
        createdAt: now,
      });

      // 1. First poll delivers unconfirmed
      const item1 = {
        item: "launch_result",
        from_machine: selfMachineId,
        result_id: "r:lnch_corr",
        launch_id: "lnch_corr",
        machine: "devbox",
        outcome: "unconfirmed",
        session_id: null,
        reason: null,
      };

      const acks1 = requester.processResults([item1]);
      expect(acks1[0]!.outcome).toBe("delivered");
      expect(getSwarmMessages()).toHaveLength(1);
      expect(getSwarmMessages()[0]!.payload).toContain("REMOTE LAUNCH UNCONFIRMED");

      // 2. Correction delivers launched with distinct result_id
      const item2 = {
        item: "launch_result",
        from_machine: selfMachineId,
        result_id: "r:lnch_corr:launched",
        launch_id: "lnch_corr",
        machine: "devbox",
        outcome: "launched",
        session_id: "ses_recovered99",
        reason: null,
      };

      const acks2 = requester.processResults([item2]);
      expect(acks2[0]!.outcome).toBe("delivered");
      const messages = getSwarmMessages();
      expect(messages).toHaveLength(2);
      expect(messages[1]!.payload).toContain("REMOTE LAUNCH STARTED");
    });

    it("refuses downgrade from launched/refused to unconfirmed (no message inserted)", () => {
      const requester = makeRequester();
      storage.remoteLaunch.outbound.insert({
        launchId: "lnch_downgrade",
        fromSession: "ses_sender123",
        toMachine: "devbox",
        directory: "/home/dev/pigeon",
        requestJson: "{}",
        createdAt: now,
      });

      // Already launched
      requester.processResults([
        {
          item: "launch_result",
          from_machine: selfMachineId,
          result_id: "r:lnch_downgrade:launched",
          launch_id: "lnch_downgrade",
          machine: "devbox",
          outcome: "launched",
          session_id: "ses_good1",
          reason: null,
        },
      ]);
      expect(getSwarmMessages()).toHaveLength(1);

      // Stale/reordered unconfirmed result arrives
      const acks = requester.processResults([
        {
          item: "launch_result",
          from_machine: selfMachineId,
          result_id: "r:lnch_downgrade:late_unconfirmed",
          launch_id: "lnch_downgrade",
          machine: "devbox",
          outcome: "unconfirmed",
          session_id: null,
          reason: null,
        },
      ]);

      expect(acks[0]!.outcome).toBe("delivered");
      // Still only 1 message, no downgrade message inserted
      expect(getSwarmMessages()).toHaveLength(1);
    });

    it("foreign/mismatched results acked refused with no_matching_launch", () => {
      const requester = makeRequester();
      storage.remoteLaunch.outbound.insert({
        launchId: "lnch_match",
        fromSession: "ses_sender123",
        toMachine: "devbox",
        directory: "/home/dev/pigeon",
        requestJson: "{}",
        createdAt: now,
      });

      // 1. from_machine !== self
      const acks1 = requester.processResults([
        {
          item: "launch_result",
          from_machine: "other_box",
          result_id: "r:1",
          launch_id: "lnch_match",
          machine: "devbox",
          outcome: "launched",
          session_id: "ses_x",
        },
      ]);
      expect(acks1).toEqual([
        {
          kind: "result",
          from_machine: "other_box",
          result_id: "r:1",
          outcome: "refused",
          reason: "no_matching_launch",
        },
      ]);

      // 2. Unknown launch_id
      const acks2 = requester.processResults([
        {
          item: "launch_result",
          from_machine: selfMachineId,
          result_id: "r:2",
          launch_id: "lnch_unknown",
          machine: "devbox",
          outcome: "launched",
          session_id: "ses_x",
        },
      ]);
      expect(acks2).toEqual([
        {
          kind: "result",
          from_machine: selfMachineId,
          result_id: "r:2",
          outcome: "refused",
          reason: "no_matching_launch",
        },
      ]);

      // 3. Mismatched machine
      const acks3 = requester.processResults([
        {
          item: "launch_result",
          from_machine: selfMachineId,
          result_id: "r:3",
          launch_id: "lnch_match",
          machine: "wrong_machine",
          outcome: "launched",
          session_id: "ses_x",
        },
      ]);
      expect(acks3).toEqual([
        {
          kind: "result",
          from_machine: selfMachineId,
          result_id: "r:3",
          outcome: "refused",
          reason: "no_matching_launch",
        },
      ]);

      expect(getSwarmMessages()).toHaveLength(0);
    });

    it("sanitizes invalid session_id and invalid reason", () => {
      const requester = makeRequester();
      storage.remoteLaunch.outbound.insert({
        launchId: "lnch_sanitize",
        fromSession: "ses_sender123",
        toMachine: "devbox",
        directory: "/home/dev/pigeon",
        requestJson: "{}",
        createdAt: now,
      });

      requester.processResults([
        {
          item: "launch_result",
          from_machine: selfMachineId,
          result_id: "r:lnch_sanitize",
          launch_id: "lnch_sanitize",
          machine: "devbox",
          outcome: "refused",
          session_id: "bad_session_id",
          reason: "INVALID REASON WITH SPACES AND CAPS!",
        },
      ]);

      const messages = getSwarmMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]!.payload).toBe(
        "REMOTE LAUNCH REFUSED: launch lnch_sanitize did NOT start on devbox (unrecognised). Safe to retry.",
      );
    });

    it("rolls back seen-record and emits no ack if transaction throws, enabling redelivery", () => {
      const requester = makeRequester();
      storage.remoteLaunch.outbound.insert({
        launchId: "lnch_tx_fail",
        fromSession: "ses_sender123",
        toMachine: "devbox",
        directory: "/home/dev/pigeon",
        requestJson: "{}",
        createdAt: now,
      });

      const item = {
        item: "launch_result",
        from_machine: selfMachineId,
        result_id: "r:lnch_tx_fail",
        launch_id: "lnch_tx_fail",
        machine: "devbox",
        outcome: "launched",
        session_id: "ses_started_ok",
        reason: null,
      };

      // Mock markResolved to throw
      const markResolvedSpy = vi
        .spyOn(storage.remoteLaunch.outbound, "markResolved")
        .mockImplementationOnce(() => {
          throw new Error("simulated database failure");
        });

      const acks = requester.processResults([item]);
      // Emits NO ack for this item
      expect(acks).toHaveLength(0);
      // Seen record was rolled back!
      expect(storage.remoteLaunch.resultsSeen.get("r:lnch_tx_fail")).toBeNull();

      // On next redelivery without error:
      markResolvedSpy.mockRestore();
      const retryAcks = requester.processResults([item]);
      expect(retryAcks).toEqual([
        {
          kind: "result",
          from_machine: selfMachineId,
          result_id: "r:lnch_tx_fail",
          outcome: "delivered",
        },
      ]);
      expect(storage.remoteLaunch.resultsSeen.get("r:lnch_tx_fail")).not.toBeNull();
      expect(getSwarmMessages()).toHaveLength(1);
    });

    it("earlier items' acks are preserved if a subsequent item throws", () => {
      const requester = makeRequester();
      storage.remoteLaunch.outbound.insert({
        launchId: "lnch_item1",
        fromSession: "ses_sender123",
        toMachine: "devbox",
        directory: "/home/dev/pigeon",
        requestJson: "{}",
        createdAt: now,
      });
      storage.remoteLaunch.outbound.insert({
        launchId: "lnch_item2",
        fromSession: "ses_sender123",
        toMachine: "devbox",
        directory: "/home/dev/pigeon",
        requestJson: "{}",
        createdAt: now,
      });

      const item1 = {
        item: "launch_result",
        from_machine: selfMachineId,
        result_id: "r:lnch_item1",
        launch_id: "lnch_item1",
        machine: "devbox",
        outcome: "launched",
        session_id: "ses_started_1",
        reason: null,
      };
      const item2 = {
        item: "launch_result",
        from_machine: selfMachineId,
        result_id: "r:lnch_item2",
        launch_id: "lnch_item2",
        machine: "devbox",
        outcome: "launched",
        session_id: "ses_started_2",
        reason: null,
      };

      // Mock markResolved to throw only for item2
      const origMarkResolved = storage.remoteLaunch.outbound.markResolved.bind(storage.remoteLaunch.outbound);
      vi.spyOn(storage.remoteLaunch.outbound, "markResolved").mockImplementation((id, outcome, t) => {
        if (id === "lnch_item2") throw new Error("crash on item 2");
        return origMarkResolved(id, outcome, t);
      });

      const acks = requester.processResults([item1, item2]);
      // Item 1 acked, item 2 not acked
      expect(acks).toHaveLength(1);
      expect(acks[0]!.result_id).toBe("r:lnch_item1");
      expect(acks[0]!.outcome).toBe("delivered");
    });

    it("duplicate unconfirmed without session id carries no new info when already unconfirmed (records seen, ack delivered, no message)", () => {
      const requester = makeRequester();
      storage.remoteLaunch.outbound.insert({
        launchId: "lnch_unconf_dup",
        fromSession: "ses_sender123",
        toMachine: "devbox",
        directory: "/home/dev/pigeon",
        requestJson: "{}",
        createdAt: now,
      });

      // Initially marked deadline (resolvedOutcome = 'unconfirmed', 1 message inserted)
      storage.remoteLaunch.outbound.markDeadline("lnch_unconf_dup", now);
      // Insert deadline message manually to simulate tick's message
      storage.swarm.insert(
        {
          msgId: "m_deadline",
          fromSession: "pigeon",
          toSession: "ses_sender123",
          channel: null,
          kind: "launch.result",
          priority: "normal",
          replyTo: null,
          payload: "deadline payload",
        },
        now,
      );
      expect(getSwarmMessages()).toHaveLength(1);

      // Now incoming unconfirmed without session id
      const acks = requester.processResults([
        {
          item: "launch_result",
          from_machine: selfMachineId,
          result_id: "r:lnch_unconf_dup:1",
          launch_id: "lnch_unconf_dup",
          machine: "devbox",
          outcome: "unconfirmed",
          session_id: null,
          reason: null,
        },
      ]);

      expect(acks).toEqual([
        {
          kind: "result",
          from_machine: selfMachineId,
          result_id: "r:lnch_unconf_dup:1",
          outcome: "delivered",
        },
      ]);
      // Seen record recorded
      expect(storage.remoteLaunch.resultsSeen.get("r:lnch_unconf_dup:1")).not.toBeNull();
      // NO new message inserted!
      expect(getSwarmMessages()).toHaveLength(1);
    });

    it("incoming unconfirmed WITH session id is delivered even when already unconfirmed", () => {
      const requester = makeRequester();
      storage.remoteLaunch.outbound.insert({
        launchId: "lnch_unconf_with_id",
        fromSession: "ses_sender123",
        toMachine: "devbox",
        directory: "/home/dev/pigeon",
        requestJson: "{}",
        createdAt: now,
      });

      // Initially resolved_outcome is unconfirmed (e.g. from deadline)
      storage.remoteLaunch.outbound.markDeadline("lnch_unconf_with_id", now);
      expect(getSwarmMessages()).toHaveLength(0);

      // Incoming unconfirmed WITH session id
      const acks = requester.processResults([
        {
          item: "launch_result",
          from_machine: selfMachineId,
          result_id: "r:lnch_unconf_with_id:late",
          launch_id: "lnch_unconf_with_id",
          machine: "devbox",
          outcome: "unconfirmed",
          session_id: "ses_recovered999",
          reason: null,
        },
      ]);

      expect(acks).toEqual([
        {
          kind: "result",
          from_machine: selfMachineId,
          result_id: "r:lnch_unconf_with_id:late",
          outcome: "delivered",
        },
      ]);
      expect(getSwarmMessages()).toHaveLength(1);
      expect(getSwarmMessages()[0]!.payload).toContain(
        "REMOTE LAUNCH UNCONFIRMED: launch lnch_unconf_with_id created session ses_recovered999 on devbox",
      );
    });
  });
});
