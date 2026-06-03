import { describe, expect, it, vi } from "vitest";
import {
  OPENCODE_DIRECT_PROTOCOL_VERSION,
  OpencodeDirectMessageType,
} from "../src/opencode-direct/contracts";
import { DirectChannelAdapter } from "../src/adapters/direct-channel";
import type { SessionRecord } from "../src/storage/types";

function makeSession(): SessionRecord {
  return {
    sessionId: "s1",
    backendKind: "opencode-plugin-direct",
    backendProtocolVersion: 1,
    backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
    backendAuthToken: "tok",
  } as unknown as SessionRecord;
}

function successResponse(): Response {
  return new Response(
    JSON.stringify({
      ack: {
        type: OpencodeDirectMessageType.Ack,
        version: OPENCODE_DIRECT_PROTOCOL_VERSION,
        requestId: "c1",
        commandId: "c1",
        sessionId: "s1",
        accepted: true,
        acceptedAt: Date.now(),
      },
      result: {
        type: OpencodeDirectMessageType.Result,
        version: OPENCODE_DIRECT_PROTOCOL_VERSION,
        requestId: "c1",
        commandId: "c1",
        sessionId: "s1",
        success: true,
        finishedAt: Date.now(),
        output: "queued",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("DirectChannelAdapter execute retry (Phase 2)", () => {
  // Phase 1 set maxRetries: 0 on the execute path because a retry re-injected a
  // non-idempotent prompt. Phase 2 makes the plugin sink idempotent on
  // commandId, so the adapter may safely retry an ambiguous timeout again — the
  // retry carries the same commandId and the plugin dedups it.
  // See docs/plans/2026-06-03-triple-injection-idempotency-design.md (§2b).
  it("retries the execute path on an ambiguous timeout and succeeds", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        // Simulate the daemon aborting a slow plugin (ambiguous timeout).
        throw new Error("The operation was aborted");
      }
      return successResponse();
    });

    const adapter = new DirectChannelAdapter({
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep: async () => {},
    });

    const result = await adapter.deliverCommand(makeSession(), "fix the bug", {
      commandId: "c1",
      chatId: "5",
    });

    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect((result.meta as { attempts?: number } | undefined)?.attempts).toBe(2);
  });
});
