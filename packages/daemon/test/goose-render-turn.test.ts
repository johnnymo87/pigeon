import { describe, expect, it } from "vitest";
import {
  capText,
  DEFAULT_MAX_TRANSCRIPT_BYTES,
  emptyReplyText,
  honkReasonDetail,
  renderHookTurn,
  TRUNCATION_NOTICE,
} from "../src/goose/render-turn.js";

describe("capText", () => {
  it("leaves text within the cap unchanged", () => {
    const res = capText("hello world", 20);
    expect(res).toEqual({ text: "hello world", truncated: false });
  });

  it("leaves text exactly at the cap unchanged", () => {
    const res = capText("hello", 5);
    expect(res).toEqual({ text: "hello", truncated: false });
  });

  it("truncates text exceeding the cap on a normal boundary", () => {
    const res = capText("abcdefghij", 5);
    expect(res).toEqual({ text: "abcde", truncated: true });
  });

  it("avoids splitting a surrogate pair at the cap boundary", () => {
    // "abc" (3 code units) + "🎉" (\uD83C\uDF89, 2 code units) -> length 5
    const text = "abc\uD83C\uDF89";
    // cap = 4: index 3 is \uD83C (high surrogate). Slicing at 4 would split the pair.
    const res = capText(text, 4);
    expect(res).toEqual({ text: "abc", truncated: true });
  });
});

describe("honkReasonDetail", () => {
  it("returns detail for not_delivered when cancelled", () => {
    expect(honkReasonDetail("cancelled", "not_delivered")).toBe(
      "The message was not delivered; please send it again.",
    );
  });

  it("returns detail for upstream_restart when cancelled or without stopReason", () => {
    expect(honkReasonDetail("cancelled", "upstream_restart")).toBe(
      "goose restarted and the turn was cancelled.",
    );
    expect(honkReasonDetail(undefined, "upstream_restart")).toBe(
      "goose restarted and the turn was cancelled.",
    );
  });

  it("returns detail for delivery_unknown when cancelled or without stopReason", () => {
    expect(honkReasonDetail("cancelled", "delivery_unknown")).toBe(
      "honkd could not confirm goose received this message; check the session before resending.",
    );
    expect(honkReasonDetail(null, "delivery_unknown")).toBe(
      "honkd could not confirm goose received this message; check the session before resending.",
    );
  });

  it("returns undefined for end_turn stopReason or unknown honkReason", () => {
    expect(honkReasonDetail("end_turn", "upstream_restart")).toBeUndefined();
    expect(honkReasonDetail("cancelled", "other")).toBeUndefined();
    expect(honkReasonDetail(undefined, undefined)).toBeUndefined();
  });
});

describe("emptyReplyText", () => {
  it("returns default empty wording for end_turn or missing stopReason", () => {
    expect(emptyReplyText("end_turn")).toBe("goose ended the turn without a reply.");
    expect(emptyReplyText(undefined)).toBe("goose ended the turn without a reply.");
    expect(emptyReplyText(null)).toBe("goose ended the turn without a reply.");
    expect(emptyReplyText("")).toBe("goose ended the turn without a reply.");
  });

  it("includes stopReason when not end_turn", () => {
    expect(emptyReplyText("max_tokens")).toBe(
      "goose ended the turn without a reply (stopReason: max_tokens).",
    );
    expect(emptyReplyText("cancelled")).toBe(
      "goose ended the turn without a reply (stopReason: cancelled).",
    );
  });
});

describe("renderHookTurn", () => {
  it("renders end_turn with text", () => {
    const res = renderHookTurn({
      stop_reason: "end_turn",
      final_text: "Task completed successfully.",
    });
    expect(res).toEqual({
      message: "Task completed successfully.",
      event: "Stop",
      errorKind: undefined,
    });
  });

  it("renders end_turn with empty text", () => {
    const res1 = renderHookTurn({
      stop_reason: "end_turn",
      final_text: "",
    });
    expect(res1).toEqual({
      message: "goose ended the turn without a reply.",
      event: "Stop",
      errorKind: undefined,
    });

    const res2 = renderHookTurn({
      stop_reason: "end_turn",
      final_text: null,
    });
    expect(res2).toEqual({
      message: "goose ended the turn without a reply.",
      event: "Stop",
      errorKind: undefined,
    });
  });

  it("renders user cancelled when empty or with text", () => {
    // Empty text with stop_reason: cancelled
    const resEmpty = renderHookTurn({
      stop_reason: "cancelled",
      final_text: null,
    });
    expect(resEmpty).toEqual({
      message: "Turn cancelled.",
      event: "Stop",
      errorKind: undefined,
    });

    // Empty text with honk_reason: cancelled
    const resHonkEmpty = renderHookTurn({
      honk_reason: "cancelled",
      final_text: "",
    });
    expect(resHonkEmpty).toEqual({
      message: "Turn cancelled.",
      event: "Stop",
      errorKind: undefined,
    });

    // With text
    const resWithText = renderHookTurn({
      stop_reason: "cancelled",
      honk_reason: "cancelled",
      final_text: "Working on it...",
    });
    expect(resWithText).toEqual({
      message: "Working on it...\n\n(cancelled)",
      event: "Stop",
      errorKind: undefined,
    });
  });

  it("renders upstream_restart", () => {
    const res = renderHookTurn({
      stop_reason: "cancelled",
      honk_reason: "upstream_restart",
      final_text: null,
    });
    expect(res).toEqual({
      message: "goose restarted and the turn was cancelled.",
      event: "Error",
      errorKind: "honk-upstream_restart",
    });

    const resWithText = renderHookTurn({
      stop_reason: "cancelled",
      honk_reason: "upstream_restart",
      final_text: "Running tests...",
    });
    expect(resWithText).toEqual({
      message: "Running tests...\n\ngoose restarted and the turn was cancelled.",
      event: "Error",
      errorKind: "honk-upstream_restart",
    });
  });

  it("renders delivery_unknown", () => {
    const res = renderHookTurn({
      stop_reason: "cancelled",
      honk_reason: "delivery_unknown",
      final_text: null,
    });
    expect(res).toEqual({
      message:
        "honkd could not confirm goose received this message; check the session before resending.",
      event: "Error",
      errorKind: "honk-delivery_unknown",
    });
  });

  it("renders max_tokens", () => {
    const resWithText = renderHookTurn({
      stop_reason: "max_tokens",
      final_text: "Here is part of the code",
    });
    expect(resWithText).toEqual({
      message: "Here is part of the code",
      event: "Error",
      errorKind: "goose-stop-max_tokens",
    });

    const resEmpty = renderHookTurn({
      stop_reason: "max_tokens",
      final_text: null,
    });
    expect(resEmpty).toEqual({
      message: "goose ended the turn without a reply (stopReason: max_tokens).",
      event: "Error",
      errorKind: "goose-stop-max_tokens",
    });
  });

  it("renders error", () => {
    const res = renderHookTurn({
      error: "JSON-RPC error: context window exceeded",
      final_text: null,
    });
    expect(res).toEqual({
      message: "JSON-RPC error: context window exceeded",
      event: "Error",
      errorKind: "goose-turn-failed",
    });

    const resWithText = renderHookTurn({
      stop_reason: "end_turn",
      error: "JSON-RPC error: tool execution failed",
      final_text: "Some output",
    });
    expect(resWithText).toEqual({
      message: "Some output\n\nJSON-RPC error: tool execution failed",
      event: "Error",
      errorKind: "goose-turn-failed",
    });
  });

  it("renders truncated flag", () => {
    const res = renderHookTurn({
      stop_reason: "end_turn",
      final_text: "Short text",
      final_text_truncated: true,
    });
    expect(res).toEqual({
      message: "Short text" + TRUNCATION_NOTICE,
      event: "Stop",
      errorKind: undefined,
    });
  });

  it("renders synthesized like end_turn", () => {
    const res = renderHookTurn({
      stop_reason: "end_turn",
      honk_reason: "synthesized",
      final_text: "Synthesized gap reply",
    });
    expect(res).toEqual({
      message: "Synthesized gap reply",
      event: "Stop",
      errorKind: undefined,
    });
  });

  it("caps final_text exceeding DEFAULT_MAX_TRANSCRIPT_BYTES and appends TRUNCATION_NOTICE", () => {
    const longText = "a".repeat(DEFAULT_MAX_TRANSCRIPT_BYTES + 100);
    const res = renderHookTurn({
      stop_reason: "end_turn",
      final_text: longText,
    });
    expect(res.event).toBe("Stop");
    expect(res.message).toBe("a".repeat(DEFAULT_MAX_TRANSCRIPT_BYTES) + TRUNCATION_NOTICE);
  });

  it("appends TRUNCATION_NOTICE exactly once when text is over cap and final_text_truncated is true", () => {
    const longText = "a".repeat(DEFAULT_MAX_TRANSCRIPT_BYTES + 100);
    const res = renderHookTurn({
      stop_reason: "end_turn",
      final_text: longText,
      final_text_truncated: true,
    });
    expect(res.event).toBe("Stop");
    expect(res.message).toBe("a".repeat(DEFAULT_MAX_TRANSCRIPT_BYTES) + TRUNCATION_NOTICE);
    const occurrences = res.message.split(TRUNCATION_NOTICE).length - 1;
    expect(occurrences).toBe(1);
  });

  it("joins upstream_restart and error with \\n\\n, event Error, errorKind goose-turn-failed", () => {
    const res = renderHookTurn({
      stop_reason: "cancelled",
      honk_reason: "upstream_restart",
      error: "JSON-RPC error: connection reset",
      final_text: null,
    });
    expect(res).toEqual({
      message:
        "goose restarted and the turn was cancelled.\n\nJSON-RPC error: connection reset",
      event: "Error",
      errorKind: "goose-turn-failed",
    });

    const resWithText = renderHookTurn({
      stop_reason: "cancelled",
      honk_reason: "upstream_restart",
      error: "JSON-RPC error: connection reset",
      final_text: "Partial response",
    });
    expect(resWithText).toEqual({
      message:
        "Partial response\n\ngoose restarted and the turn was cancelled.\n\nJSON-RPC error: connection reset",
      event: "Error",
      errorKind: "goose-turn-failed",
    });
  });

  describe("usage footer in renderHookTurn", () => {
    it("appends usage footer to a normal Stop turn", () => {
      const res = renderHookTurn({
        stop_reason: "end_turn",
        final_text: "Task completed successfully.",
        usage: {
          used: 45231,
          size: 200000,
          cost: { amount: 1.84, currency: "USD" },
        },
      });
      expect(res).toEqual({
        message: "Task completed successfully.\n\n📊 45.2K tokens · 23% · $1.84",
        event: "Stop",
        errorKind: undefined,
      });
    });

    it("appends usage footer to an Error turn (stop_reason: max_tokens)", () => {
      const res = renderHookTurn({
        stop_reason: "max_tokens",
        final_text: "Reached token limit...",
        usage: {
          used: 200000,
          size: 200000,
        },
      });
      expect(res).toEqual({
        message: "Reached token limit...\n\n📊 200.0K tokens · 100%",
        event: "Error",
        errorKind: "goose-stop-max_tokens",
      });
    });

    it("appends usage footer to a cancelled turn", () => {
      const res = renderHookTurn({
        stop_reason: "cancelled",
        honk_reason: "cancelled",
        final_text: "Partial text before cancel",
        usage: {
          used: 12300,
          size: 200000,
        },
      });
      expect(res).toEqual({
        message: "Partial text before cancel\n\n(cancelled)\n\n📊 12.3K tokens · 6%",
        event: "Stop",
        errorKind: undefined,
      });
    });

    it("appends usage footer to a synthesized turn", () => {
      const res = renderHookTurn({
        stop_reason: "end_turn",
        honk_reason: "synthesized",
        final_text: "Synthesized text",
        usage: {
          used: 812,
          size: 0,
        },
      });
      expect(res).toEqual({
        message: "Synthesized text\n\n📊 812 tokens",
        event: "Stop",
        errorKind: undefined,
      });
    });

    it("leaves message unchanged when usage is absent or invalid or used is 0", () => {
      const base = {
        stop_reason: "end_turn",
        final_text: "Normal text",
      };
      expect(renderHookTurn(base).message).toBe("Normal text");
      expect(renderHookTurn({ ...base, usage: null }).message).toBe("Normal text");
      expect(renderHookTurn({ ...base, usage: "invalid" }).message).toBe("Normal text");
      expect(renderHookTurn({ ...base, usage: { used: "many" } }).message).toBe("Normal text");
      expect(renderHookTurn({ ...base, usage: { used: 0 } }).message).toBe("Normal text");
    });
  });
});
