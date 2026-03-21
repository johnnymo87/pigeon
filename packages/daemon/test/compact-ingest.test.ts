import { describe, expect, it, vi } from "vitest";
import { ingestCompactCommand, type CompactCommandInput } from "../src/worker/compact-ingest";

describe("ingestCompactCommand", () => {
  function makeInput(overrides?: Partial<CompactCommandInput>): CompactCommandInput {
    return {
      commandId: "cmd-456",
      sessionId: "sess-xyz",
      chatId: "99999",
      opencodeClient: {
        getSessionMessages: vi.fn().mockResolvedValue([]),
        summarize: vi.fn().mockResolvedValue(undefined),
      },
      sendTelegramReply: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("fetches messages, extracts model from last user message, and calls summarize", async () => {
    const messages = [
      { role: "user", model: { providerID: "anthropic", modelID: "claude-3-5-sonnet" } },
    ];
    const input = makeInput({
      opencodeClient: {
        getSessionMessages: vi.fn().mockResolvedValue(messages),
        summarize: vi.fn().mockResolvedValue(undefined),
      },
    });

    await ingestCompactCommand(input);

    expect(input.opencodeClient.getSessionMessages).toHaveBeenCalledWith("sess-xyz");
    expect(input.opencodeClient.summarize).toHaveBeenCalledWith(
      "sess-xyz",
      "anthropic",
      "claude-3-5-sonnet",
    );
  });

  it("uses the LAST user message's model, not the first", async () => {
    const messages = [
      { role: "user", model: { providerID: "openai", modelID: "gpt-4" } },
      { role: "assistant", content: "response" },
      { role: "user", model: { providerID: "anthropic", modelID: "claude-3-7-sonnet" } },
    ];
    const input = makeInput({
      opencodeClient: {
        getSessionMessages: vi.fn().mockResolvedValue(messages),
        summarize: vi.fn().mockResolvedValue(undefined),
      },
    });

    await ingestCompactCommand(input);

    expect(input.opencodeClient.summarize).toHaveBeenCalledWith(
      "sess-xyz",
      "anthropic",
      "claude-3-7-sonnet",
    );
  });

  it("sends error reply when no user messages are found, does not call summarize", async () => {
    const messages = [
      { role: "assistant", content: "a response" },
    ];
    const input = makeInput({
      opencodeClient: {
        getSessionMessages: vi.fn().mockResolvedValue(messages),
        summarize: vi.fn().mockResolvedValue(undefined),
      },
    });

    await ingestCompactCommand(input);

    expect(input.opencodeClient.summarize).not.toHaveBeenCalled();
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "99999",
      expect.stringContaining("No user messages found"),
    );
  });

  it("sends error reply when summarize throws", async () => {
    const messages = [
      { role: "user", model: { providerID: "anthropic", modelID: "claude-3-5-sonnet" } },
    ];
    const input = makeInput({
      opencodeClient: {
        getSessionMessages: vi.fn().mockResolvedValue(messages),
        summarize: vi.fn().mockRejectedValue(new Error("summarize server error")),
      },
    });

    await ingestCompactCommand(input);

    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "99999",
      expect.stringContaining("summarize server error"),
    );
  });

  it("includes machineId in error reply when provided", async () => {
    const input = makeInput({
      machineId: "devbox",
      opencodeClient: {
        getSessionMessages: vi.fn().mockRejectedValue(new Error("connection failed")),
        summarize: vi.fn().mockResolvedValue(undefined),
      },
    });

    await ingestCompactCommand(input);

    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "99999",
      expect.stringContaining("devbox"),
    );
  });
});
