import { describe, it, expect } from "vitest";
import {
  GooseAcpClient,
  type GooseReceipt,
} from "../src/goose/acp-client.js";
import { GooseSessionRunner } from "../src/goose/session-runner.js";
import { webSocketTransport } from "../src/goose/ws-transport.js";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";

const HONKD_URL = process.env.PIGEON_TEST_HONKD_URL;
const HONKD_TOKEN = process.env.PIGEON_TEST_HONKD_TOKEN;
const HONKD_RESTART_CMD = process.env.PIGEON_TEST_HONKD_RESTART_CMD;

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
          createdAt: new Date(),
          lastSeen: new Date(),
        },
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
});
