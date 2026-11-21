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

  // pigeon-4ogz.20: a /kill used to leave the daemon's sessions row behind, so the topic (or
  // Slack channel) stayed open until the orphan closer found it past the 7-day idle TTL.
  it("tears pigeon's side down AFTER the reply, so the reply lands before the topic closes", async () => {
    const callOrder: string[] = [];
    const input = makeInput({
      opencodeClient: {
        deleteSession: vi.fn(async () => { callOrder.push("delete"); }),
      } as any,
      sendTelegramReply: vi.fn(async () => { callOrder.push("reply"); }),
      onTerminated: vi.fn(async (id: string) => { callOrder.push(`teardown:${id}`); }),
    });

    await ingestKillCommand(input);

    expect(callOrder).toEqual(["delete", "reply", "teardown:sess-abc"]);
  });

  it("still tears down when the reply fails", async () => {
    const onTerminated = vi.fn(async () => {});
    const input = makeInput({
      sendTelegramReply: vi.fn().mockRejectedValue(new Error("worker down")),
      onTerminated,
    });

    await expect(ingestKillCommand(input)).resolves.toBeUndefined();

    expect(onTerminated).toHaveBeenCalledWith("sess-abc");
  });

  it("does not tear down when deleteSession fails: the session may still be alive", async () => {
    const onTerminated = vi.fn(async () => {});
    const input = makeInput({
      opencodeClient: {
        deleteSession: vi.fn().mockRejectedValue(new Error("deleteSession failed: 500")),
      } as any,
      onTerminated,
    });

    await ingestKillCommand(input);

    expect(onTerminated).not.toHaveBeenCalled();
  });

  it("swallows a teardown failure: a throw would skip the ack and redeliver the kill", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = makeInput({
      onTerminated: vi.fn().mockRejectedValue(new Error("unregister failed")),
    });

    await expect(ingestKillCommand(input)).resolves.toBeUndefined();

    expect(input.sendTelegramReply).toHaveBeenCalledTimes(1);
    expect(input.sendTelegramReply).toHaveBeenCalledWith("12345", expect.stringContaining("terminated"), expect.anything());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("teardown failed"));
    warn.mockRestore();
  });
});
