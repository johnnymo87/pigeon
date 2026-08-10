import { describe, expect, it, vi } from "vitest";
import {
  OPENCODE_DIRECT_PROTOCOL_VERSION,
  OpencodeDirectMessageType,
} from "../src/opencode-direct/contracts";
import { DirectChannelAdapter } from "../src/adapters/direct-channel";
import type { SessionRecord } from "../src/storage/types";
import { openStorageDb } from "../src/storage/database";
import { hashPrompt } from "../src/hash-prompt";

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

describe("DirectChannelAdapter execute (Phase 2)", () => {
  // The execute path makes a SINGLE attempt per call. Retrying a non-idempotent
  // injection is the responsibility of command-ingest's deadline-aware budget
  // loop (which retries ambiguous timeouts through the now-idempotent plugin),
  // so the retry lives in exactly one layer. Here we lock that the adapter does
  // NOT retry on its own (an ambiguous timeout returns a single-attempt failure).
  // See docs/plans/2026-06-03-triple-injection-idempotency-design.md (§2b).
  it("makes a single attempt and does not retry on an ambiguous timeout", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("The operation was aborted");
    });

    const adapter = new DirectChannelAdapter({
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep: async () => {},
    });

    const result = await adapter.deliverCommand(makeSession(), "fix the bug", {
      commandId: "c1",
      chatId: "5",
    });

    expect(result.ok).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((result.meta as { attempts?: number } | undefined)?.attempts).toBe(1);
  });

  it("succeeds on a single attempt when the plugin responds ok", async () => {
    const fetchFn = vi.fn(async () => successResponse());

    const adapter = new DirectChannelAdapter({
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep: async () => {},
    });

    const result = await adapter.deliverCommand(makeSession(), "fix the bug", {
      commandId: "c1",
      chatId: "5",
    });

    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("records the prompt in injectedPrompts repository before issuing execute request", async () => {
    const db = openStorageDb(":memory:");
    let recordedAtCallTime = false;
    const fetchFn = vi.fn(async () => {
      recordedAtCallTime = db.injectedPrompts.has("s1", hashPrompt("fix the bug"));
      throw new Error("network error");
    });

    const adapter = new DirectChannelAdapter({
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep: async () => {},
      injectedPrompts: db.injectedPrompts,
    });

    await adapter.deliverCommand(makeSession(), "fix the bug", {
      commandId: "c1",
      chatId: "5",
    });

    expect(recordedAtCallTime).toBe(true);
    expect(db.injectedPrompts.has("s1", hashPrompt("fix the bug"))).toBe(true);
  });
});
