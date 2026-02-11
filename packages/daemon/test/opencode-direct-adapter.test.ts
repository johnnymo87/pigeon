import { describe, expect, it, vi } from "vitest";
import {
  OPENCODE_DIRECT_PROTOCOL_VERSION,
  OpencodeDirectMessageType,
  ResultErrorCode,
} from "../src/opencode-direct/contracts";
import { executeViaOpencodeDirectChannel } from "../src/opencode-direct/adapter";

describe("executeViaOpencodeDirectChannel", () => {
  it("returns ok true for accepted successful result", async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(JSON.stringify({
        ack: {
          type: OpencodeDirectMessageType.Ack,
          version: OPENCODE_DIRECT_PROTOCOL_VERSION,
          requestId: "req-1",
          commandId: "cmd-1",
          sessionId: "sess-1",
          accepted: true,
          acceptedAt: Date.now(),
        },
        result: {
          type: OpencodeDirectMessageType.Result,
          version: OPENCODE_DIRECT_PROTOCOL_VERSION,
          requestId: "req-1",
          commandId: "cmd-1",
          sessionId: "sess-1",
          success: true,
          finishedAt: Date.now(),
          output: "ok",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await executeViaOpencodeDirectChannel(
      {
        requestId: "req-1",
        commandId: "cmd-1",
        sessionId: "sess-1",
        command: "echo ok",
        endpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        authToken: "tok",
      },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.result?.success).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns rejected status when ack accepted=false", async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(JSON.stringify({
        ack: {
          type: OpencodeDirectMessageType.Ack,
          version: OPENCODE_DIRECT_PROTOCOL_VERSION,
          requestId: "req-2",
          commandId: "cmd-2",
          sessionId: "sess-2",
          accepted: false,
          acceptedAt: Date.now(),
          rejectReason: "BUSY",
        },
      }), { status: 409, headers: { "content-type": "application/json" } });
    });

    const result = await executeViaOpencodeDirectChannel(
      {
        requestId: "req-2",
        commandId: "cmd-2",
        sessionId: "sess-2",
        command: "echo hi",
        endpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        authToken: "tok",
      },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );

    expect(result.ok).toBe(false);
    expect(result.ack?.accepted).toBe(false);
    expect(result.error).toBe("BUSY");
  });

  it("returns invalid-json error when backend response is malformed", async () => {
    const fetchFn = vi.fn(async () => new Response("not-json", { status: 200 }));

    const result = await executeViaOpencodeDirectChannel(
      {
        requestId: "req-3",
        commandId: "cmd-3",
        sessionId: "sess-3",
        command: "echo hi",
        endpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        authToken: "tok",
      },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid JSON");
  });

  it("handles network error deterministically", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    const result = await executeViaOpencodeDirectChannel(
      {
        requestId: "req-4",
        commandId: "cmd-4",
        sessionId: "sess-4",
        command: "echo hi",
        endpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        authToken: "tok",
      },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("accepts explicit result failure envelope shape", async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(JSON.stringify({
        ack: {
          type: OpencodeDirectMessageType.Ack,
          version: OPENCODE_DIRECT_PROTOCOL_VERSION,
          requestId: "req-5",
          commandId: "cmd-5",
          sessionId: "sess-5",
          accepted: true,
          acceptedAt: Date.now(),
        },
        result: {
          type: OpencodeDirectMessageType.Result,
          version: OPENCODE_DIRECT_PROTOCOL_VERSION,
          requestId: "req-5",
          commandId: "cmd-5",
          sessionId: "sess-5",
          success: false,
          finishedAt: Date.now(),
          errorCode: ResultErrorCode.ExecutionError,
          errorMessage: "runtime failed",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await executeViaOpencodeDirectChannel(
      {
        requestId: "req-5",
        commandId: "cmd-5",
        sessionId: "sess-5",
        command: "boom",
        endpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
        authToken: "tok",
      },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );

    expect(result.ok).toBe(false);
    expect(result.result?.success).toBe(false);
    expect(result.result?.errorCode).toBe(ResultErrorCode.ExecutionError);
  });
});
