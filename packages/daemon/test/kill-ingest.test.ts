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
      sendAck: vi.fn(),
      ...overrides,
    };
  }

  it("acks immediately, deletes session, and sends success reply", async () => {
    const input = makeInput();

    await ingestKillCommand(input);

    expect(input.sendAck).toHaveBeenCalledWith("cmd-123");
    expect(input.opencodeClient.deleteSession).toHaveBeenCalledWith("sess-abc");
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("terminated"),
    );
  });

  it("acks before attempting delete", async () => {
    const callOrder: string[] = [];
    const input = makeInput({
      sendAck: vi.fn(() => { callOrder.push("ack"); }),
      opencodeClient: {
        deleteSession: vi.fn(async () => { callOrder.push("delete"); }),
      } as any,
      sendTelegramReply: vi.fn(async () => { callOrder.push("reply"); }),
    });

    await ingestKillCommand(input);

    expect(callOrder).toEqual(["ack", "delete", "reply"]);
  });

  it("sends error reply when deleteSession fails", async () => {
    const input = makeInput({
      opencodeClient: {
        deleteSession: vi.fn().mockRejectedValue(new Error("session not found")),
      } as any,
    });

    await ingestKillCommand(input);

    expect(input.sendAck).toHaveBeenCalledWith("cmd-123");
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("Failed to kill"),
    );
  });
});
