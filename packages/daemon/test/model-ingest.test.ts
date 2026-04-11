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

  it("lists models grouped by allowed providers with entities", async () => {
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

    const [, text, entities] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, unknown[]];
    expect(text).toContain("🤖 ");
    expect(text).toContain("Available models:");
    expect(text).toContain("anthropic");
    expect(text).toContain("anthropic/claude-opus-4-6");
    expect(text).toContain("anthropic/claude-sonnet-4-5");
    expect(text).toContain("openai");
    expect(text).toContain("openai/gpt-5.4");
    expect(text).not.toContain("`");
    expect(text).not.toContain("*");
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "bold" }),
        expect.objectContaining({ type: "code" }),
      ]),
    );
  });

  it("includes session ID in reply as code entity", async () => {
    const input = makeInput({ sessionId: "sess-xyz" });

    await ingestModelListCommand(input);

    const [, text, entities] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, unknown[]];
    expect(text).toContain("sess-xyz");
    expect(text).not.toContain("`");
  });

  it("shows current model and reply hint without session ID", async () => {
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

    const [, text] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(text).toContain("Current: ");
    expect(text).toContain("anthropic/claude-opus-4-6");
    expect(text).toContain("/model <code>");
    // session ID removed from command hint (swipe-reply)
    expect(text).not.toMatch(/\/model <code> sess-abc/);
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

    const [, text] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(text).toContain("anthropic");
    expect(text).not.toContain("somecustom");
    expect(text).not.toContain("mistral");
    expect(text).not.toContain("custom-model");
    expect(text).not.toContain("mistral-7b");
  });

  it("sends error reply when listProviders throws (plain text, no entities)", async () => {
    const input = makeInput({
      opencodeClient: {
        listProviders: vi.fn().mockRejectedValue(new Error("API unavailable")),
      },
    });

    await ingestModelListCommand(input);

    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      "Failed to list models: API unavailable",
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

  it("validates model, calls setModelOverride, and sends confirmation with entities", async () => {
    const setModelOverride = vi.fn();
    const input = makeInput({
      model: "anthropic/claude-opus-4-6",
      storage: {
        sessions: { setModelOverride },
      },
    });

    await ingestModelSetCommand(input);

    expect(setModelOverride).toHaveBeenCalledWith("sess-abc", "anthropic/claude-opus-4-6");
    const [chatId, text, entities] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, unknown[]];
    expect(chatId).toBe("12345");
    expect(text).toContain("🤖 Model set to ");
    expect(text).toContain("anthropic/claude-opus-4-6");
    expect(text).toContain("sess-abc");
    expect(text).not.toContain("`");
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "code" }),
      ]),
    );
  });

  it("sends not found message when model does not exist, with entities", async () => {
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
    const [chatId, text, entities] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, unknown[]];
    expect(chatId).toBe("12345");
    expect(text).toContain("anthropic/claude-nonexistent");
    expect(text).toContain("not found");
    expect(text).toContain("/model");
    expect(text).not.toContain("`");
    // session ID removed from command hint (swipe-reply)
    expect(text).not.toMatch(/\/model sess-abc/);
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "code" }),
      ]),
    );
  });

  it("sends not found when provider does not exist, with entities", async () => {
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
    const [, text, entities] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, unknown[]];
    expect(text).toContain("unknownprovider/some-model");
    expect(text).toContain("not found");
    expect(text).not.toContain("`");
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "code" }),
      ]),
    );
  });

  it("sends error reply when listProviders throws (plain text, no entities)", async () => {
    const input = makeInput({
      opencodeClient: {
        listProviders: vi.fn().mockRejectedValue(new Error("connection refused")),
      },
    });

    await ingestModelSetCommand(input);

    expect(input.storage.sessions.setModelOverride).not.toHaveBeenCalled();
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "12345",
      "Failed to set model: connection refused",
    );
  });
});
