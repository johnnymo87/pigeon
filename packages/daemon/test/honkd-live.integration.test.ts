import { describe, it, expect } from "vitest";
import {
  GooseAcpClient,
  type GooseReceipt,
} from "../src/goose/acp-client.js";
import { GooseSessionRunner, GooseRunnerRegistry } from "../src/goose/session-runner.js";
import { webSocketTransport } from "../src/goose/ws-transport.js";
import { openStorageDb } from "../src/storage/database.js";
import { recoverGooseTurns } from "../src/goose/recover-inflight.js";
import type { SessionRecord } from "../src/storage/types.js";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";

const HONKD_URL = process.env.PIGEON_TEST_HONKD_URL;
const HONKD_TOKEN = process.env.PIGEON_TEST_HONKD_TOKEN;
const HONKD_RESTART_CMD = process.env.PIGEON_TEST_HONKD_RESTART_CMD;
const HONKD_STOP_CMD = process.env.PIGEON_TEST_HONKD_STOP_CMD;
const HONKD_START_CMD = process.env.PIGEON_TEST_HONKD_START_CMD;
const GOOSE_URL = process.env.PIGEON_TEST_GOOSE_URL;
const GOOSE_TOKEN = process.env.PIGEON_TEST_GOOSE_TOKEN;

describe("honkd live integration with real pigeon client", () => {
  const runTest = HONKD_URL && HONKD_TOKEN ? it : it.skip;
  const runRestartTest = HONKD_URL && HONKD_TOKEN && HONKD_RESTART_CMD ? it : it.skip;
  const runStopStartTest = HONKD_URL && HONKD_TOKEN && HONKD_STOP_CMD && HONKD_START_CMD ? it : it.skip;

  runTest(
    "connects through honkd, starts developer session, and completes turn",
    async () => {
      const tmpdir = await fs.mkdtemp(
        path.join(os.tmpdir(), "pigeon-honkd-test-"),
      );
      const accumulatedText: string[] = [];

      const client = new GooseAcpClient({
        url: HONKD_URL!,
        transportFactory: webSocketTransport(HONKD_TOKEN!),
        permissionPolicy: (params) => params.options[0]?.optionId,
        sessionExtensions: [{ type: "platform", name: "developer" }],
        serveFloor: ["developer"],
        onSessionUpdate: (_sid, update) => {
          if (update.sessionUpdate === "agent_message_chunk") {
            const text = (update.content as { text?: unknown } | undefined)?.text;
            if (typeof text === "string" && text !== "") {
              accumulatedText.push(text);
            }
          }
        },
      });

      try {
        await client.connect();
        expect(client.isHonk).toBe(true);

        const sid = await client.newSession(tmpdir);
        expect(sid).toBeTruthy();

        const outcome = await client.prompt(
          sid,
          "Reply with exactly: PIGEON_OK",
          { clientReqId: `test-live-${Date.now()}` },
        );
        expect(outcome.kind).toBe("receipt");

        const receipt = outcome as GooseReceipt;
        expect(receipt.stopReason).toBe("end_turn");

        expect(receipt.text).toBeDefined();
        expect(receipt.text).toContain("PIGEON_OK");
      } finally {
        client.close();
        await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
      }
    },
    120_000,
  );

  runRestartTest(
    "recovers turn when honkd restarts mid-turn with same state dir",
    async () => {
      const tmpdir = await fs.mkdtemp(
        path.join(os.tmpdir(), "pigeon-honkd-restart-test-"),
      );
      const stopReports: Array<Record<string, unknown>> = [];

      const client = new GooseAcpClient({
        url: HONKD_URL!,
        transportFactory: webSocketTransport(HONKD_TOKEN!),
        permissionPolicy: (params) => params.options[0]?.optionId,
        sessionExtensions: [{ type: "platform", name: "developer" }],
        serveFloor: ["developer"],
      });

      await client.connect();
      const backendSid = await client.newSession(tmpdir);

      const runner = new GooseSessionRunner({
        session: {
          sessionId: `live-sess-${Date.now()}`,
          backendKind: "goose",
          backendSessionId: backendSid,
        } as SessionRecord,
        client,
        postStop: async (body) => {
          stopReports.push(body);
        },
        touch: () => {},
        honkReconnectBudgetMs: 30_000,
        honkReconnectInitialDelayMs: 250,
      });

      try {
        await runner.deliver(
          `cmd-live-restart-${Date.now()}`,
          "Run this shell command: sleep 4 && echo LIVE_TEST_RECOVERY_OK",
        );

        // Wait for command to start in goose
        await new Promise((r) => setTimeout(r, 1500));

        // Trigger honkd restart via the provided command
        execSync(HONKD_RESTART_CMD!, { stdio: "inherit", shell: "/bin/bash" });

        await runner.settled();

        expect(stopReports).toHaveLength(1);
        expect(stopReports[0]!.event).toBe("Stop");
        expect(String(stopReports[0]!.message)).toContain("LIVE_TEST_RECOVERY_OK");
      } finally {
        runner.close();
        await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
      }
    },
    120_000,
  );

  runTest(
    "cancels in-flight turn via runner.cancel(), prompt resolves with stopReason 'cancelled' well before completion",
    async () => {
      const tmpdir = await fs.mkdtemp(
        path.join(os.tmpdir(), "pigeon-honkd-cancel-test-"),
      );
      const stopReports: Array<Record<string, unknown>> = [];

      const client = new GooseAcpClient({
        url: HONKD_URL!,
        transportFactory: webSocketTransport(HONKD_TOKEN!),
        permissionPolicy: (params) => params.options[0]?.optionId,
        sessionExtensions: [{ type: "platform", name: "developer" }],
        serveFloor: ["developer"],
      });

      await client.connect();
      expect(client.isHonk).toBe(true);
      const backendSid = await client.newSession(tmpdir);

      const runner = new GooseSessionRunner({
        session: {
          sessionId: `live-sess-cancel-${Date.now()}`,
          backendKind: "goose",
          backendSessionId: backendSid,
        } as SessionRecord,
        client,
        postStop: async (body) => {
          stopReports.push(body);
        },
        touch: () => {},
      });

      try {
        const start = Date.now();
        await runner.deliver(
          `cmd-live-cancel-${Date.now()}`,
          "Run this shell command: sleep 10 && echo LIVE_TEST_HONKD_CANCEL_FAILED",
        );

        // Wait for command to start running in goose
        await new Promise((r) => setTimeout(r, 1500));

        const cancelOutcome = await runner.cancel();
        expect(cancelOutcome).toBe("sent");

        await runner.settled();
        const elapsed = Date.now() - start;

        // Settles well before the 10s sleep
        expect(elapsed).toBeLessThan(7000);
        // Turn cancel requested ends turn without posting stop notification (/kill reply covers it)
        expect(stopReports).toHaveLength(0);
      } finally {
        runner.close();
        await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
      }
    },
    120_000,
  );

  runTest(
    "cancels in-flight turn via separate fresh client B, client A prompt resolves stopReason 'cancelled'",
    async () => {
      const tmpdir = await fs.mkdtemp(
        path.join(os.tmpdir(), "pigeon-honkd-client-cancel-test-"),
      );

      const clientA = new GooseAcpClient({
        url: HONKD_URL!,
        transportFactory: webSocketTransport(HONKD_TOKEN!),
        permissionPolicy: (params) => params.options[0]?.optionId,
        sessionExtensions: [{ type: "platform", name: "developer" }],
        serveFloor: ["developer"],
      });

      await clientA.connect();
      expect(clientA.isHonk).toBe(true);
      const backendSid = await clientA.newSession(tmpdir);
      let clientB: GooseAcpClient | undefined;

      try {
        const start = Date.now();
        const promptA = clientA.prompt(
          backendSid,
          "Run this shell command: sleep 10 && echo LIVE_TEST_CLIENT_A_SHOULD_BE_CANCELLED",
        );

        // Wait for command to start running in goose
        await new Promise((r) => setTimeout(r, 1500));

        // Client B connects on a separate socket, sends cancel, and closes immediately
        clientB = new GooseAcpClient({
          url: HONKD_URL!,
          transportFactory: webSocketTransport(HONKD_TOKEN!),
        });
        await clientB.connect();
        expect(clientB.isHonk).toBe(true);
        clientB.cancel(backendSid);
        clientB.close();

        // Client A's in-flight prompt resolves with cancelled
        const outcome = await promptA;
        const elapsed = Date.now() - start;

        expect(outcome.kind).toBe("receipt");
        const receipt = outcome as GooseReceipt;
        expect(receipt.stopReason).toBe("cancelled");
        expect(elapsed).toBeLessThan(7000);
      } finally {
        clientB?.close();
        clientA.close();
        await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
      }
    },
    120_000,
  );

  runTest(
    "runner.cancel() on fresh (never-connected) runner against honkd while turn is running (after-restart path)",
    async () => {
      const tmpdir = await fs.mkdtemp(
        path.join(os.tmpdir(), "pigeon-honkd-restart-cancel-test-"),
      );

      // Connection 1: starts a long turn
      const client1 = new GooseAcpClient({
        url: HONKD_URL!,
        transportFactory: webSocketTransport(HONKD_TOKEN!),
        permissionPolicy: (params) => params.options[0]?.optionId,
        sessionExtensions: [{ type: "platform", name: "developer" }],
        serveFloor: ["developer"],
      });

      await client1.connect();
      expect(client1.isHonk).toBe(true);
      const backendSid = await client1.newSession(tmpdir);
      let freshRunner: GooseSessionRunner | undefined;
      let freshClient: GooseAcpClient | undefined;

      try {
        const start = Date.now();
        const prompt1 = client1.prompt(
          backendSid,
          "Run this shell command: sleep 10 && echo LIVE_TEST_RESTART_SHOULD_BE_CANCELLED",
        );

        // Wait for command to start running in goose
        await new Promise((r) => setTimeout(r, 1500));

        // Simulate after-restart: a fresh runner with a fresh client that has NEVER connected
        freshClient = new GooseAcpClient({
          url: HONKD_URL!,
          transportFactory: webSocketTransport(HONKD_TOKEN!),
        });
        freshRunner = new GooseSessionRunner({
          session: {
            sessionId: `sess-restart-${Date.now()}`,
            backendKind: "goose",
            backendSessionId: backendSid,
          } as SessionRecord,
          client: freshClient,
          postStop: async () => {},
          touch: () => {},
        });

        // Fresh runner connects within 3s and sends cancel
        const cancelOutcome = await freshRunner.cancel();
        expect(cancelOutcome).toBe("sent");

        // Client 1's prompt resolves with "cancelled"
        const outcome = await prompt1;
        const elapsed = Date.now() - start;

        expect(outcome.kind).toBe("receipt");
        const receipt = outcome as GooseReceipt;
        expect(receipt.stopReason).toBe("cancelled");
        expect(elapsed).toBeLessThan(7000);
      } finally {
        freshRunner?.close();
        freshClient?.close();
        client1.close();
        await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
      }
    },
    120_000,
  );

  runTest(
    "recovery case 1: long turn suspended mid-flight, recoverGooseTurns collects full reply across simulated restart",
    async () => {
      const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "pigeon-honkd-recover-1-"));
      const dbPath = path.join(tmpdir, "pigeon.db");
      const clientSetup = new GooseAcpClient({
        url: HONKD_URL!,
        transportFactory: webSocketTransport(HONKD_TOKEN!),
        permissionPolicy: (params) => params.options[0]?.optionId,
        sessionExtensions: [{ type: "platform", name: "developer" }],
        serveFloor: ["developer"],
      });
      await clientSetup.connect();
      expect(clientSetup.isHonk).toBe(true);
      expect(clientSetup.supportsResumeOnly).toBe(true);
      const backendSid = await clientSetup.newSession(tmpdir);
      clientSetup.close();

      const cmdId = `cmd-live-rec1-${Date.now()}`;
      const sessId = `sess-live-rec1-${Date.now()}`;

      // --- PHASE A: Registry A on dbPath starts turn and suspends ---
      const storageA = openStorageDb(dbPath);
      storageA.sessions.upsert({
        sessionId: sessId,
        backendKind: "goose",
        backendSessionId: backendSid,
        backendEndpoint: HONKD_URL!,
        backendAuthToken: HONKD_TOKEN!,
        cwd: tmpdir,
        notify: true,
      });
      storageA.inbox.persist({ commandId: cmdId, payload: "Run this shell command: sleep 4 && echo LIVE_CASE1_OK" });

      let firstChunkReceived = false;
      let onFirstChunk: (() => void) | undefined;
      const firstChunkPromise = new Promise<void>((resolve) => {
        onFirstChunk = resolve;
      });

      const clientA = new GooseAcpClient({
        url: HONKD_URL!,
        transportFactory: webSocketTransport(HONKD_TOKEN!),
        permissionPolicy: (params) => params.options[0]?.optionId,
        sessionExtensions: [{ type: "platform", name: "developer" }],
        serveFloor: ["developer"],
        onSessionUpdate: (_sid, update) => {
          if (update.sessionUpdate === "agent_message_chunk" && !firstChunkReceived) {
            firstChunkReceived = true;
            onFirstChunk?.();
          }
        },
      });

      const registryA = new GooseRunnerRegistry({
        inbox: storageA.inbox,
        inflight: storageA.gooseInflight,
        createRunner: (session) =>
          new GooseSessionRunner({
            session,
            client: clientA,
            inflight: storageA.gooseInflight,
            postStop: async () => {},
            touch: () => {},
          }),
      });
      const runnerA = registryA.get(storageA.sessions.get(sessId)!);

      try {
        await runnerA.deliver(cmdId, "Run this shell command: sleep 4 && echo LIVE_CASE1_OK");

        // Wait for first chunk from goose
        await Promise.race([
          firstChunkPromise,
          new Promise((r) => setTimeout(r, 2000)),
        ]);

        // Suspend all runners while turn is running
        await registryA.suspendAll();

        // Row should be kept and marked clean_suspend
        const inflightRow = storageA.gooseInflight.get(cmdId);
        expect(inflightRow).toBeDefined();
        expect(inflightRow?.cleanSuspend).toBe(true);
      } finally {
        storageA.db.close();
      }

      // --- PHASE B: Registry B starts on same dbPath and recovers ---
      const storageB = openStorageDb(dbPath);
      const stopReportsB: Array<Record<string, unknown>> = [];

      const registryB = new GooseRunnerRegistry({
        inbox: storageB.inbox,
        inflight: storageB.gooseInflight,
        createRunner: (session) =>
          new GooseSessionRunner({
            session,
            client: new GooseAcpClient({
              url: HONKD_URL!,
              transportFactory: webSocketTransport(HONKD_TOKEN!),
              permissionPolicy: (params) => params.options[0]?.optionId,
              sessionExtensions: [{ type: "platform", name: "developer" }],
              serveFloor: ["developer"],
            }),
            inflight: storageB.gooseInflight,
            postStop: async (body) => {
              stopReportsB.push(body);
            },
            touch: () => {},
          }),
      });

      try {
        await recoverGooseTurns({
          storage: storageB,
          gooseRunners: registryB,
          postStop: async (body) => {
            stopReportsB.push(body);
          },
        });

        const runnerB = registryB.peek(sessId);
        expect(runnerB).toBeDefined();
        await runnerB?.settled();

        // Exactly one postStop with full text
        expect(stopReportsB).toHaveLength(1);
        expect(stopReportsB[0]!.event).toBe("Stop");
        expect(String(stopReportsB[0]!.message)).toContain("LIVE_CASE1_OK");

        // Row is gone from inflight and inbox marked done
        expect(storageB.gooseInflight.get(cmdId)).toBeUndefined();
        expect(storageB.inbox.get(cmdId)?.status).toBe("done");
      } finally {
        registryB.closeAll();
        storageB.db.close();
        await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
      }
    },
    120_000,
  );

  runTest(
    "recovery case 2: turn finishes while pigeon is down, cached reply collected on startup",
    async () => {
      const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "pigeon-honkd-recover-2-"));
      const dbPath = path.join(tmpdir, "pigeon.db");

      const clientSetup = new GooseAcpClient({
        url: HONKD_URL!,
        transportFactory: webSocketTransport(HONKD_TOKEN!),
        permissionPolicy: (params) => params.options[0]?.optionId,
        sessionExtensions: [{ type: "platform", name: "developer" }],
        serveFloor: ["developer"],
      });
      await clientSetup.connect();
      const backendSid = await clientSetup.newSession(tmpdir);
      clientSetup.close();

      const cmdId = `cmd-live-rec2-${Date.now()}`;
      const sessId = `sess-live-rec2-${Date.now()}`;

      // --- PHASE A: Registry A starts turn and immediately suspends ---
      const storageA = openStorageDb(dbPath);
      storageA.sessions.upsert({
        sessionId: sessId,
        backendKind: "goose",
        backendSessionId: backendSid,
        backendEndpoint: HONKD_URL!,
        backendAuthToken: HONKD_TOKEN!,
        cwd: tmpdir,
        notify: true,
      });
      storageA.inbox.persist({ commandId: cmdId, payload: "Run this shell command: sleep 2 && echo LIVE_CASE2_CACHED_OK" });

      const clientA = new GooseAcpClient({
        url: HONKD_URL!,
        transportFactory: webSocketTransport(HONKD_TOKEN!),
        permissionPolicy: (params) => params.options[0]?.optionId,
        sessionExtensions: [{ type: "platform", name: "developer" }],
        serveFloor: ["developer"],
      });

      const registryA = new GooseRunnerRegistry({
        inbox: storageA.inbox,
        inflight: storageA.gooseInflight,
        createRunner: (session) =>
          new GooseSessionRunner({
            session,
            client: clientA,
            inflight: storageA.gooseInflight,
            postStop: async () => {},
            touch: () => {},
          }),
      });
      const runnerA = registryA.get(storageA.sessions.get(sessId)!);

      try {
        await runnerA.deliver(cmdId, "Run this shell command: sleep 2 && echo LIVE_CASE2_CACHED_OK");
        // Suspend immediately while turn is running on honkd
        await registryA.suspendAll();
      } finally {
        storageA.db.close();
      }

      // Wait 4 seconds while pigeon is "down" for the turn to complete in honkd/goose
      await new Promise((r) => setTimeout(r, 4000));

      // --- PHASE B: Pigeon starts up and recovers cached reply ---
      const storageB = openStorageDb(dbPath);
      const stopReportsB: Array<Record<string, unknown>> = [];

      const registryB = new GooseRunnerRegistry({
        inbox: storageB.inbox,
        inflight: storageB.gooseInflight,
        createRunner: (session) =>
          new GooseSessionRunner({
            session,
            client: new GooseAcpClient({
              url: HONKD_URL!,
              transportFactory: webSocketTransport(HONKD_TOKEN!),
              permissionPolicy: (params) => params.options[0]?.optionId,
              sessionExtensions: [{ type: "platform", name: "developer" }],
              serveFloor: ["developer"],
            }),
            inflight: storageB.gooseInflight,
            postStop: async (body) => {
              stopReportsB.push(body);
            },
            touch: () => {},
          }),
      });

      try {
        await recoverGooseTurns({
          storage: storageB,
          gooseRunners: registryB,
          postStop: async (body) => {
            stopReportsB.push(body);
          },
        });

        const runnerB = registryB.peek(sessId);
        expect(runnerB).toBeDefined();
        await runnerB?.settled();

        // Cached reply collected
        expect(stopReportsB).toHaveLength(1);
        expect(stopReportsB[0]!.event).toBe("Stop");
        expect(String(stopReportsB[0]!.message)).toContain("LIVE_CASE2_CACHED_OK");

        // Row is gone from inflight and inbox marked done
        expect(storageB.gooseInflight.get(cmdId)).toBeUndefined();
        expect(storageB.inbox.get(cmdId)?.status).toBe("done");
      } finally {
        registryB.closeAll();
        storageB.db.close();
        await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
      }
    },
    120_000,
  );

  runTest(
    "recovery case 3: random client_req_id + resumeOnly -> -32004, no run",
    async () => {
      const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "pigeon-honkd-recover-3-"));
      const client = new GooseAcpClient({
        url: HONKD_URL!,
        transportFactory: webSocketTransport(HONKD_TOKEN!),
        permissionPolicy: (params) => params.options[0]?.optionId,
        sessionExtensions: [{ type: "platform", name: "developer" }],
        serveFloor: ["developer"],
      });

      try {
        await client.connect();
        expect(client.isHonk).toBe(true);
        expect(client.supportsResumeOnly).toBe(true);

        const sid = await client.newSession(tmpdir);
        expect(sid).toBeTruthy();

        // Send resumeOnly: true with a random unknown clientReqId
        const randomCrid = `cmd-random-${Date.now()}-${Math.random()}`;
        const outcome = await client.prompt(sid, "This prompt should never execute", {
          clientReqId: randomCrid,
          resumeOnly: true,
        });

        // Must return unknown-request (honkd error -32004)
        expect(outcome.kind).toBe("unknown-request");

        // Verify no run was started: session should be idle
        expect(client.activeRunId(sid)).toBeUndefined();
      } finally {
        client.close();
        await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
      }
    },
    120_000,
  );

  runStopStartTest(
    "recovery case 4: recovery starts while honkd is stopped, retries in backoff, and collects reply once honkd starts",
    async () => {
      const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "pigeon-honkd-recover-4-"));
      const dbPath = path.join(tmpdir, "pigeon.db");

      const clientSetup = new GooseAcpClient({
        url: HONKD_URL!,
        transportFactory: webSocketTransport(HONKD_TOKEN!),
        permissionPolicy: (params) => params.options[0]?.optionId,
        sessionExtensions: [{ type: "platform", name: "developer" }],
        serveFloor: ["developer"],
      });
      await clientSetup.connect();
      const backendSid = await clientSetup.newSession(tmpdir);
      clientSetup.close();

      const cmdId = `cmd-live-rec4-${Date.now()}`;
      const sessId = `sess-live-rec4-${Date.now()}`;

      // --- PHASE A: Registry A starts turn and immediately suspends ---
      const storageA = openStorageDb(dbPath);
      storageA.sessions.upsert({
        sessionId: sessId,
        backendKind: "goose",
        backendSessionId: backendSid,
        backendEndpoint: HONKD_URL!,
        backendAuthToken: HONKD_TOKEN!,
        cwd: tmpdir,
        notify: true,
      });
      storageA.inbox.persist({ commandId: cmdId, payload: "Run this shell command: sleep 12 && echo LIVE_CASE4_DOWN_BOOT_OK" });

      const clientA = new GooseAcpClient({
        url: HONKD_URL!,
        transportFactory: webSocketTransport(HONKD_TOKEN!),
        permissionPolicy: (params) => params.options[0]?.optionId,
        sessionExtensions: [{ type: "platform", name: "developer" }],
        serveFloor: ["developer"],
      });

      const registryA = new GooseRunnerRegistry({
        inbox: storageA.inbox,
        inflight: storageA.gooseInflight,
        createRunner: (session) =>
          new GooseSessionRunner({
            session,
            client: clientA,
            inflight: storageA.gooseInflight,
            postStop: async () => {},
            touch: () => {},
          }),
      });
      const runnerA = registryA.get(storageA.sessions.get(sessId)!);

      try {
        await runnerA.deliver(cmdId, "Run this shell command: sleep 12 && echo LIVE_CASE4_DOWN_BOOT_OK");
        await registryA.suspendAll();
      } finally {
        storageA.db.close();
      }

      // Stop honkd while pigeon is down. The turn (sleep 12) is still running
      // in goose when honkd comes back: this case tests pigeon's reconnect
      // backoff.
      execSync(HONKD_STOP_CMD!, { stdio: "inherit", shell: "/bin/bash" });

      // --- PHASE B: Start Pigeon recovery WHILE honkd is STOPPED ---
      const storageB = openStorageDb(dbPath);
      const stopReportsB: Array<Record<string, unknown>> = [];

      const registryB = new GooseRunnerRegistry({
        inbox: storageB.inbox,
        inflight: storageB.gooseInflight,
        createRunner: (session) =>
          new GooseSessionRunner({
            session,
            client: new GooseAcpClient({
              url: HONKD_URL!,
              transportFactory: webSocketTransport(HONKD_TOKEN!),
              permissionPolicy: (params) => params.options[0]?.optionId,
              sessionExtensions: [{ type: "platform", name: "developer" }],
              serveFloor: ["developer"],
            }),
            inflight: storageB.gooseInflight,
            honkReconnectInitialDelayMs: 250,
            honkReconnectMaxDelayMs: 1000,
            postStop: async (body) => {
              stopReportsB.push(body);
            },
            touch: () => {},
          }),
      });

      try {
        await recoverGooseTurns({
          storage: storageB,
          gooseRunners: registryB,
          postStop: async (body) => {
            stopReportsB.push(body);
          },
        });

        const runnerB = registryB.peek(sessId);
        expect(runnerB).toBeDefined();
        expect(runnerB?.isBusy()).toBe(true);

        // Wait 1.5 seconds with honkd down — runnerB is retrying in backoff
        await new Promise((r) => setTimeout(r, 1500));
        expect(runnerB?.isBusy()).toBe(true);
        expect(stopReportsB).toHaveLength(0); // Not failed or given up!

        // Now START honkd!
        execSync(HONKD_START_CMD!, { stdio: "inherit", shell: "/bin/bash" });

        // Once honkd is back up, runnerB connects, prompts resumeOnly, and settles!
        await runnerB?.settled();

        expect(stopReportsB).toHaveLength(1);
        expect(stopReportsB[0]!.event).toBe("Stop");
        expect(String(stopReportsB[0]!.message)).toMatch(
          /LIVE_CASE4_DOWN_BOOT_OK|^goose ended the turn without a reply\.$/,
        );
        expect(String(stopReportsB[0]!.message)).not.toMatch(/unavailable/);

        expect(storageB.gooseInflight.get(cmdId)).toBeUndefined();
        expect(storageB.inbox.get(cmdId)?.status).toBe("done");
      } finally {
        registryB.closeAll();
        storageB.db.close();
        await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
      }
    },
    120_000,
  );
});

describe("bare sandbox goose live integration with real pigeon client", () => {
  const runBareTest = GOOSE_URL && GOOSE_TOKEN ? it : it.skip;

  runBareTest(
    "cancels in-flight turn against bare sandbox goose via session/cancel",
    async () => {
      const tmpdir = await fs.mkdtemp(
        path.join(os.tmpdir(), "pigeon-goose-cancel-test-"),
      );
      const client = new GooseAcpClient({
        url: GOOSE_URL!,
        transportFactory: webSocketTransport(GOOSE_TOKEN!),
        permissionPolicy: (params) => params.options[0]?.optionId,
        sessionExtensions: [{ type: "platform", name: "developer" }],
        serveFloor: ["developer"],
      });

      try {
        await client.connect();
        expect(client.isHonk).toBe(false);

        const sid = await client.newSession(tmpdir);
        expect(sid).toBeTruthy();

        const start = Date.now();
        const promptPromise = client.prompt(
          sid,
          "Run this shell command: sleep 10 && echo LIVE_TEST_BARE_CANCEL_FAILED",
        );

        // Wait for command to start running in goose
        await new Promise((r) => setTimeout(r, 1500));

        client.cancel(sid);
        const outcome = await promptPromise;
        const elapsed = Date.now() - start;

        expect(outcome.kind).toBe("receipt");
        const receipt = outcome as GooseReceipt;
        expect(receipt.stopReason).toBe("cancelled");
        expect(elapsed).toBeLessThan(7000);
      } finally {
        client.close();
        await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
      }
    },
    120_000,
  );
});
