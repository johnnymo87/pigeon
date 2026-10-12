import { describe, it, expect } from "vitest";
import {
  GooseAcpClient,
  type GooseReceipt,
} from "../src/goose/acp-client.js";
import { GooseSessionRunner } from "../src/goose/session-runner.js";
import { webSocketTransport } from "../src/goose/ws-transport.js";
import type { SessionRecord } from "../src/storage/types.js";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";

const HONKD_URL = process.env.PIGEON_TEST_HONKD_URL;
const HONKD_TOKEN = process.env.PIGEON_TEST_HONKD_TOKEN;
const HONKD_RESTART_CMD = process.env.PIGEON_TEST_HONKD_RESTART_CMD;
const GOOSE_URL = process.env.PIGEON_TEST_GOOSE_URL;
const GOOSE_TOKEN = process.env.PIGEON_TEST_GOOSE_TOKEN;

describe("honkd live integration with real pigeon client", () => {
  const runTest = HONKD_URL && HONKD_TOKEN ? it : it.skip;
  const runRestartTest = HONKD_URL && HONKD_TOKEN && HONKD_RESTART_CMD ? it : it.skip;

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
        expect(stopReports).toHaveLength(1);
        expect(stopReports[0]!.event).toBe("Error");
        expect(stopReports[0]!.error_kind).toBe("goose-stop-cancelled");
        expect(String(stopReports[0]!.message)).not.toContain("LIVE_TEST_HONKD_CANCEL_FAILED");
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

      try {
        const start = Date.now();
        const promptA = clientA.prompt(
          backendSid,
          "Run this shell command: sleep 10 && echo LIVE_TEST_CLIENT_A_SHOULD_BE_CANCELLED",
        );

        // Wait for command to start running in goose
        await new Promise((r) => setTimeout(r, 1500));

        // Client B connects on a separate socket, sends cancel, and closes immediately
        const clientB = new GooseAcpClient({
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

      try {
        const start = Date.now();
        const prompt1 = client1.prompt(
          backendSid,
          "Run this shell command: sleep 10 && echo LIVE_TEST_RESTART_SHOULD_BE_CANCELLED",
        );

        // Wait for command to start running in goose
        await new Promise((r) => setTimeout(r, 1500));

        // Simulate after-restart: a fresh runner with a fresh client that has NEVER connected
        const freshClient = new GooseAcpClient({
          url: HONKD_URL!,
          transportFactory: webSocketTransport(HONKD_TOKEN!),
        });
        const freshRunner = new GooseSessionRunner({
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
        client1.close();
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
