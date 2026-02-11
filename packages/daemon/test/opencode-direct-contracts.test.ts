import { describe, expect, it } from "vitest";
import {
  AckRejectReason,
  OPENCODE_DIRECT_PROTOCOL_VERSION,
  OpencodeDirectMessageType,
  OpencodeDirectSource,
  ResultErrorCode,
  isCommandAckEnvelope,
  isCommandResultEnvelope,
  isExecuteCommandEnvelope,
} from "../src/opencode-direct/contracts";

describe("opencode-direct contracts", () => {
  it("validates execute envelope", () => {
    const input = {
      type: OpencodeDirectMessageType.Execute,
      version: OPENCODE_DIRECT_PROTOCOL_VERSION,
      requestId: "req-1",
      commandId: "cmd-1",
      sessionId: "sess-1",
      command: "echo hi",
      source: OpencodeDirectSource.TelegramReply,
      issuedAt: Date.now(),
      metadata: { chatId: "8248" },
    };

    expect(isExecuteCommandEnvelope(input)).toBe(true);
    expect(isExecuteCommandEnvelope({ ...input, source: "unknown" })).toBe(false);
  });

  it("validates ack envelope", () => {
    const ack = {
      type: OpencodeDirectMessageType.Ack,
      version: OPENCODE_DIRECT_PROTOCOL_VERSION,
      requestId: "req-1",
      commandId: "cmd-1",
      sessionId: "sess-1",
      accepted: false,
      acceptedAt: Date.now(),
      rejectReason: AckRejectReason.Busy,
      message: "already running",
    };

    expect(isCommandAckEnvelope(ack)).toBe(true);
    expect(isCommandAckEnvelope({ ...ack, rejectReason: "NOPE" })).toBe(false);
  });

  it("validates result envelope", () => {
    const result = {
      type: OpencodeDirectMessageType.Result,
      version: OPENCODE_DIRECT_PROTOCOL_VERSION,
      requestId: "req-1",
      commandId: "cmd-1",
      sessionId: "sess-1",
      success: false,
      finishedAt: Date.now(),
      errorCode: ResultErrorCode.ExecutionError,
      errorMessage: "failed",
    };

    expect(isCommandResultEnvelope(result)).toBe(true);
    expect(isCommandResultEnvelope({ ...result, errorCode: "INVALID" })).toBe(false);
  });
});
