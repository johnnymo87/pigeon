import { describe, expect, it, vi } from "vitest";
import { ingestInterruptCommand, type InterruptCommandInput } from "../src/worker/interrupt-ingest";

describe("ingestInterruptCommand", () => {
  function makeInput(overrides?: Partial<InterruptCommandInput>): InterruptCommandInput {
    return {
      commandId: "cmd-123",
      sessionId: "sess-abc",
      chatId: "12345",
      opencodeClient: {
        abortSession: vi.fn().mockResolvedValue(undefined),
      } as any,
      sendTelegramReply: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("aborts session and sends success reply with entities", async () => {
    const input = makeInput();

    await ingestInterruptCommand(input);

    expect(input.opencodeClient.abortSession).toHaveBeenCalledWith("sess-abc");
    const [chatId, text, entities] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, unknown[]];
    expect(chatId).toBe("12345");
    expect(text).toContain("interrupted");
    expect(text).toContain("sess-abc");
    expect(text).not.toContain("`");
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "code" }),
      ]),
    );
  });

  it("sends error reply when abortSession fails", async () => {
    const input = makeInput({
      opencodeClient: {
        abortSession: vi.fn().mockRejectedValue(new Error("session not found")),
      } as any,
    });

    await ingestInterruptCommand(input);

    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("Failed to interrupt"),
    );
  });

  it("calls abort before sending reply", async () => {
    const callOrder: string[] = [];
    const input = makeInput({
      opencodeClient: {
        abortSession: vi.fn(async () => { callOrder.push("abort"); }),
      } as any,
      sendTelegramReply: vi.fn(async () => { callOrder.push("reply"); }),
    });

    await ingestInterruptCommand(input);

    expect(callOrder).toEqual(["abort", "reply"]);
  });
});
