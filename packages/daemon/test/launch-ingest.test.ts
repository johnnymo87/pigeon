import { describe, expect, it, vi } from "vitest";
import { ingestLaunchCommand, type LaunchCommandInput } from "../src/worker/launch-ingest";
import type { OpencodeClient } from "../src/opencode-client";

function makeInput(overrides: Partial<LaunchCommandInput> = {}): LaunchCommandInput {
  const opencodeClient: OpencodeClient = {
    healthCheck: vi.fn().mockResolvedValue(true),
    createSession: vi.fn().mockResolvedValue({ id: "sess-123" }),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
  } as unknown as OpencodeClient;

  return {
    commandId: "cmd-001",
    directory: "/home/user/project",
    prompt: "Write a hello world program",
    chatId: "42",
    opencodeClient,
    sendTelegramReply: vi.fn().mockResolvedValue(undefined),
    sendAck: vi.fn(),
    ...overrides,
  };
}

describe("ingestLaunchCommand", () => {
  describe("healthy server flow", () => {
    it("calls sendAck immediately with the commandId", async () => {
      const input = makeInput();

      await ingestLaunchCommand(input);

      expect(input.sendAck).toHaveBeenCalledWith("cmd-001");
    });

    it("creates a session with the given directory", async () => {
      const input = makeInput();

      await ingestLaunchCommand(input);

      expect(input.opencodeClient.createSession).toHaveBeenCalledWith("/home/user/project");
    });

    it("resolves tilde in directory before calling opencode API", async () => {
      const input = makeInput({ directory: "~/project" });

      await ingestLaunchCommand(input);

      const homeDir = require("os").homedir();
      expect(input.opencodeClient.createSession).toHaveBeenCalledWith(`${homeDir}/project`);
      expect(input.opencodeClient.sendPrompt).toHaveBeenCalledWith(
        "sess-123",
        `${homeDir}/project`,
        "Write a hello world program",
      );
    });

    it("sends the prompt to the created session with directory and prompt", async () => {
      const input = makeInput();

      await ingestLaunchCommand(input);

      expect(input.opencodeClient.sendPrompt).toHaveBeenCalledWith(
        "sess-123",
        "/home/user/project",
        "Write a hello world program",
      );
    });

    it("sends a confirmation Telegram reply containing the session id and directory", async () => {
      const input = makeInput();

      await ingestLaunchCommand(input);

      expect(input.sendTelegramReply).toHaveBeenCalledWith(
        "42",
        expect.stringContaining("sess-123"),
      );
      expect(input.sendTelegramReply).toHaveBeenCalledWith(
        "42",
        expect.stringContaining("/home/user/project"),
      );
    });
  });

  describe("server down", () => {
    it("sends 'not running' Telegram reply when healthCheck returns false", async () => {
      const input = makeInput({
        opencodeClient: {
          healthCheck: vi.fn().mockResolvedValue(false),
          createSession: vi.fn(),
          sendPrompt: vi.fn(),
        } as unknown as OpencodeClient,
      });

      await ingestLaunchCommand(input);

      expect(input.sendTelegramReply).toHaveBeenCalledWith(
        "42",
        "opencode serve is not running.",
      );
    });

    it("does not try to create a session when healthCheck returns false", async () => {
      const input = makeInput({
        opencodeClient: {
          healthCheck: vi.fn().mockResolvedValue(false),
          createSession: vi.fn(),
          sendPrompt: vi.fn(),
        } as unknown as OpencodeClient,
      });

      await ingestLaunchCommand(input);

      expect(input.opencodeClient.createSession).not.toHaveBeenCalled();
    });

    it("still sends ack when server is down", async () => {
      const input = makeInput({
        opencodeClient: {
          healthCheck: vi.fn().mockResolvedValue(false),
          createSession: vi.fn(),
          sendPrompt: vi.fn(),
        } as unknown as OpencodeClient,
      });

      await ingestLaunchCommand(input);

      expect(input.sendAck).toHaveBeenCalledWith("cmd-001");
    });
  });

  describe("session creation fails", () => {
    it("sends 'Failed to launch' Telegram reply when createSession throws", async () => {
      const input = makeInput({
        opencodeClient: {
          healthCheck: vi.fn().mockResolvedValue(true),
          createSession: vi.fn().mockRejectedValue(new Error("createSession failed: 500 Internal Server Error")),
          sendPrompt: vi.fn(),
        } as unknown as OpencodeClient,
      });

      await ingestLaunchCommand(input);

      expect(input.sendTelegramReply).toHaveBeenCalledWith(
        "42",
        expect.stringContaining("Failed to launch session"),
      );
    });

    it("still sends ack when createSession throws", async () => {
      const input = makeInput({
        opencodeClient: {
          healthCheck: vi.fn().mockResolvedValue(true),
          createSession: vi.fn().mockRejectedValue(new Error("createSession failed: 500 Internal Server Error")),
          sendPrompt: vi.fn(),
        } as unknown as OpencodeClient,
      });

      await ingestLaunchCommand(input);

      expect(input.sendAck).toHaveBeenCalledWith("cmd-001");
    });
  });

  describe("prompt sending fails", () => {
    it("sends 'Failed to launch' Telegram reply when sendPrompt throws", async () => {
      const input = makeInput({
        opencodeClient: {
          healthCheck: vi.fn().mockResolvedValue(true),
          createSession: vi.fn().mockResolvedValue({ id: "sess-xyz" }),
          sendPrompt: vi.fn().mockRejectedValue(new Error("sendPrompt failed: 500 Internal Server Error")),
        } as unknown as OpencodeClient,
      });

      await ingestLaunchCommand(input);

      expect(input.sendTelegramReply).toHaveBeenCalledWith(
        "42",
        expect.stringContaining("Failed to launch session"),
      );
    });

    it("still sends ack when sendPrompt throws", async () => {
      const input = makeInput({
        opencodeClient: {
          healthCheck: vi.fn().mockResolvedValue(true),
          createSession: vi.fn().mockResolvedValue({ id: "sess-xyz" }),
          sendPrompt: vi.fn().mockRejectedValue(new Error("sendPrompt failed: 500 Internal Server Error")),
        } as unknown as OpencodeClient,
      });

      await ingestLaunchCommand(input);

      expect(input.sendAck).toHaveBeenCalledWith("cmd-001");
    });
  });

  describe("ack is always sent", () => {
    it("sends ack before any async operations (immediately)", async () => {
      const callOrder: string[] = [];
      const input = makeInput({
        sendAck: vi.fn(() => {
          callOrder.push("ack");
        }),
        opencodeClient: {
          healthCheck: vi.fn(async () => {
            callOrder.push("healthCheck");
            return true;
          }),
          createSession: vi.fn(async () => {
            callOrder.push("createSession");
            return { id: "sess-123" };
          }),
          sendPrompt: vi.fn(async () => {
            callOrder.push("sendPrompt");
          }),
        } as unknown as OpencodeClient,
        sendTelegramReply: vi.fn(async () => {
          callOrder.push("sendTelegramReply");
        }),
      });

      await ingestLaunchCommand(input);

      expect(callOrder[0]).toBe("ack");
    });
  });
});
