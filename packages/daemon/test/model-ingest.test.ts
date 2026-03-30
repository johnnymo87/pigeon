import { describe, expect, it, vi } from "vitest";
import {
  ingestModelListCommand,
  ingestModelSetCommand,
  type ModelListCommandInput,
  type ModelSetCommandInput,
} from "../src/worker/model-ingest";

describe("ingestModelListCommand", () => {
  function makeInput(overrides?: Partial<ModelListCommandInput>): ModelListCommandInput {
    return {
      commandId: "cmd-1",
      sessionId: "sess-abc",
      chatId: "12345",
      opencodeClient: {
        listProviders: vi.fn().mockResolvedValue({
          all: [],
          default: { code: "anthropic/claude-opus-4-6" },
          connected: [],
        }),
      },
      sendTelegramReply: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("lists models grouped by allowed providers", async () => {
    const input = makeInput({
      opencodeClient: {
        listProviders: vi.fn().mockResolvedValue({
          all: [
            {
              id: "anthropic",
              models: {
                "claude-opus-4-6": {},
                "claude-sonnet-4-5": {},
              },
            },
            {
              id: "openai",
              models: {
                "gpt-5.4": {},
              },
            },
          ],
          default: { code: "anthropic/claude-opus-4-6" },
          connected: ["anthropic"],
        }),
      },
    });

    await ingestModelListCommand(input);

    const [, reply] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(reply).toContain("🤖 *Available models:*");
    expect(reply).toContain("*anthropic*");
    expect(reply).toContain("`anthropic/claude-opus-4-6`");
    expect(reply).toContain("`anthropic/claude-sonnet-4-5`");
    expect(reply).toContain("*openai*");
    expect(reply).toContain("`openai/gpt-5.4`");
  });

  it("includes session ID in reply", async () => {
    const input = makeInput({ sessionId: "sess-xyz" });

    await ingestModelListCommand(input);

    const [, reply] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(reply).toContain("`sess-xyz`");
  });

  it("shows current model and reply hint", async () => {
    const input = makeInput({
      sessionId: "sess-abc",
      opencodeClient: {
        listProviders: vi.fn().mockResolvedValue({
          all: [],
          default: { code: "anthropic/claude-opus-4-6" },
          connected: [],
        }),
      },
    });

    await ingestModelListCommand(input);

    const [, reply] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(reply).toContain("Current: `anthropic/claude-opus-4-6`");
    expect(reply).toContain("/model <code> sess-abc");
  });

  it("filters out non-allowed providers", async () => {
    const input = makeInput({
      opencodeClient: {
        listProviders: vi.fn().mockResolvedValue({
          all: [
            { id: "anthropic", models: { "claude-opus-4-6": {} } },
            { id: "somecustom", models: { "custom-model": {} } },
            { id: "mistral", models: { "mistral-7b": {} } },
          ],
          default: { code: "anthropic/claude-opus-4-6" },
          connected: ["anthropic"],
        }),
      },
    });

    await ingestModelListCommand(input);

    const [, reply] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(reply).toContain("anthropic");
    expect(reply).not.toContain("somecustom");
    expect(reply).not.toContain("mistral");
    expect(reply).not.toContain("custom-model");
    expect(reply).not.toContain("mistral-7b");
  });

  it("sends error reply when listProviders throws", async () => {
    const input = makeInput({
      opencodeClient: {
        listProviders: vi.fn().mockRejectedValue(new Error("API unavailable")),
      },
    });

    await ingestModelListCommand(input);

    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("Failed to list models: API unavailable"),
    );
  });
});

describe("ingestModelSetCommand", () => {
  function makeInput(overrides?: Partial<ModelSetCommandInput>): ModelSetCommandInput {
    return {
      commandId: "cmd-2",
      sessionId: "sess-abc",
      chatId: "12345",
      model: "anthropic/claude-opus-4-6",
      opencodeClient: {
        listProviders: vi.fn().mockResolvedValue({
          all: [
            {
              id: "anthropic",
              models: { "claude-opus-4-6": {} },
            },
          ],
          default: { code: "anthropic/claude-opus-4-6" },
          connected: ["anthropic"],
        }),
      },
      storage: {
        sessions: {
          setModelOverride: vi.fn(),
        },
      },
      sendTelegramReply: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("validates model, calls setModelOverride, and sends confirmation", async () => {
    const setModelOverride = vi.fn();
    const input = makeInput({
      model: "anthropic/claude-opus-4-6",
      storage: {
        sessions: { setModelOverride },
      },
    });

    await ingestModelSetCommand(input);

    expect(setModelOverride).toHaveBeenCalledWith("sess-abc", "anthropic/claude-opus-4-6");
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("🤖 Model set to `anthropic/claude-opus-4-6` for session `sess-abc`"),
    );
  });

  it("sends not found message when model does not exist", async () => {
    const input = makeInput({
      model: "anthropic/claude-nonexistent",
      opencodeClient: {
        listProviders: vi.fn().mockResolvedValue({
          all: [
            { id: "anthropic", models: { "claude-opus-4-6": {} } },
          ],
          default: { code: "anthropic/claude-opus-4-6" },
          connected: ["anthropic"],
        }),
      },
    });

    await ingestModelSetCommand(input);

    expect(input.storage.sessions.setModelOverride).not.toHaveBeenCalled();
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("Model `anthropic/claude-nonexistent` not found"),
    );
    const [, reply] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(reply).toContain("/model sess-abc");
  });

  it("sends not found when provider does not exist", async () => {
    const input = makeInput({
      model: "unknownprovider/some-model",
      opencodeClient: {
        listProviders: vi.fn().mockResolvedValue({
          all: [{ id: "anthropic", models: { "claude-opus-4-6": {} } }],
          default: { code: "anthropic/claude-opus-4-6" },
          connected: ["anthropic"],
        }),
      },
    });

    await ingestModelSetCommand(input);

    expect(input.storage.sessions.setModelOverride).not.toHaveBeenCalled();
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("Model `unknownprovider/some-model` not found"),
    );
  });

  it("sends error reply when listProviders throws", async () => {
    const input = makeInput({
      opencodeClient: {
        listProviders: vi.fn().mockRejectedValue(new Error("connection refused")),
      },
    });

    await ingestModelSetCommand(input);

    expect(input.storage.sessions.setModelOverride).not.toHaveBeenCalled();
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("Failed to set model: connection refused"),
    );
  });
});
