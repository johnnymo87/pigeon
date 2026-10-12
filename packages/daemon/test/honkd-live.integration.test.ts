import { describe, it, expect } from "vitest";
import {
  GooseAcpClient,
  type GooseReceipt,
} from "../src/goose/acp-client.js";
import { webSocketTransport } from "../src/goose/ws-transport.js";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const HONKD_URL = process.env.PIGEON_TEST_HONKD_URL;
const HONKD_TOKEN = process.env.PIGEON_TEST_HONKD_TOKEN;

describe("honkd live integration with real pigeon client", () => {
  const runTest = HONKD_URL && HONKD_TOKEN ? it : it.skip;

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

        const effectiveText = receipt.text ?? accumulatedText.join("");
        expect(effectiveText).toContain("PIGEON_OK");
      } finally {
        client.close();
        await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
      }
    },
    120_000,
  );
});
