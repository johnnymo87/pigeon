import { describe, expect, it, vi } from "vitest";
import { ingestKillCommand, type KillCommandInput } from "../src/worker/kill-ingest";

describe("ingestKillCommand", () => {
  function makeInput(overrides?: Partial<KillCommandInput>): KillCommandInput {
    return {
      commandId: "cmd-123",
      sessionId: "sess-abc",
      chatId: "12345",
      opencodeClient: {
        deleteSession: vi.fn().mockResolvedValue(undefined),
      } as any,
      sendTelegramReply: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("deletes session and sends success reply with entities", async () => {
    const input = makeInput();

    await ingestKillCommand(input);

    expect(input.opencodeClient.deleteSession).toHaveBeenCalledWith("sess-abc");
    const [chatId, text, entities] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, unknown[]];
    expect(chatId).toBe("12345");
    expect(text).toContain("terminated");
    expect(text).toContain("sess-abc");
    expect(text).not.toContain("`");
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "code" }),
      ]),
    );
  });

  it("sends error reply when deleteSession fails", async () => {
    const input = makeInput({
      opencodeClient: {
        deleteSession: vi.fn().mockRejectedValue(new Error("session not found")),
      } as any,
    });

    await ingestKillCommand(input);

    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("Failed to kill"),
    );
  });

  it("calls delete before sending reply", async () => {
    const callOrder: string[] = [];
    const input = makeInput({
      opencodeClient: {
        deleteSession: vi.fn(async () => { callOrder.push("delete"); }),
      } as any,
      sendTelegramReply: vi.fn(async () => { callOrder.push("reply"); }),
    });

    await ingestKillCommand(input);

    expect(callOrder).toEqual(["delete", "reply"]);
  });
});
