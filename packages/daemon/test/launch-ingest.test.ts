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
    spawn: vi.fn(() => ({
      unref: vi.fn(),
      on: vi.fn(),
    } as unknown as ReturnType<typeof import("child_process").spawn>)),
    ...overrides,
  };
}

describe("ingestLaunchCommand", () => {
  describe("healthy server flow", () => {
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

    it("expands a single word directory to ~/projects/<word>", async () => {
      const input = makeInput({ directory: "pigeon" });

      await ingestLaunchCommand(input);

      const homeDir = require("os").homedir();
      expect(input.opencodeClient.createSession).toHaveBeenCalledWith(`${homeDir}/projects/pigeon`);
      expect(input.opencodeClient.sendPrompt).toHaveBeenCalledWith(
        "sess-123",
        `${homeDir}/projects/pigeon`,
        "Write a hello world program",
      );
    });

    it("does not expand multi-word paths containing slashes", async () => {
      const input = makeInput({ directory: "foo/bar" });

      await ingestLaunchCommand(input);

      expect(input.opencodeClient.createSession).toHaveBeenCalledWith("foo/bar");
    });

    it("does not expand absolute paths", async () => {
      const input = makeInput({ directory: "/opt/myproject" });

      await ingestLaunchCommand(input);

      expect(input.opencodeClient.createSession).toHaveBeenCalledWith("/opt/myproject");
    });

    it("does not expand tilde paths as shorthand", async () => {
      const input = makeInput({ directory: "~/myproject" });

      await ingestLaunchCommand(input);

      const homeDir = require("os").homedir();
      expect(input.opencodeClient.createSession).toHaveBeenCalledWith(`${homeDir}/myproject`);
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

    it("sends a confirmation Telegram reply containing the session id and directory with entities", async () => {
      const input = makeInput();

      await ingestLaunchCommand(input);

      const [chatId, text, entities] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, unknown[]];
      expect(chatId).toBe("42");
      expect(text).toContain("sess-123");
      expect(text).toContain("/home/user/project");
      expect(entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "code" }),
        ]),
      );
      // Session ID and directory should be code entities (no backtick wrappers)
      expect(text).not.toContain("`");
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
  });

  describe("auto-attach", () => {
    function makeChildStub(): { unref: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; emit: (event: string, ...args: unknown[]) => void } {
      // Minimal EventEmitter-shaped child stub for tests.
      const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
      return {
        unref: vi.fn(),
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          (handlers[event] ??= []).push(handler);
        }),
        emit: (event: string, ...args: unknown[]) => {
          (handlers[event] ?? []).forEach((h) => h(...args));
        },
      };
    }

    it("spawns oc-auto-attach with the session id after sendPrompt succeeds", async () => {
      const spawnFn = vi.fn(() => makeChildStub() as unknown as ReturnType<typeof import("child_process").spawn>);
      const input = makeInput({ spawn: spawnFn });

      await ingestLaunchCommand(input);

      expect(spawnFn).toHaveBeenCalledWith(
        "oc-auto-attach",
        ["sess-123"],
        expect.objectContaining({ stdio: "ignore", detached: true }),
      );
    });

    it("calls unref on the spawned child", async () => {
      const child = makeChildStub();
      const input = makeInput({
        spawn: vi.fn(() => child as unknown as ReturnType<typeof import("child_process").spawn>),
      });

      await ingestLaunchCommand(input);

      expect(child.unref).toHaveBeenCalledOnce();
    });

    it("attaches an error listener to the spawned child", async () => {
      const child = makeChildStub();
      const input = makeInput({
        spawn: vi.fn(() => child as unknown as ReturnType<typeof import("child_process").spawn>),
      });

      await ingestLaunchCommand(input);

      expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
    });

    it("swallows ENOENT emitted asynchronously when oc-auto-attach is missing", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const child = makeChildStub();
        const input = makeInput({
          spawn: vi.fn(() => child as unknown as ReturnType<typeof import("child_process").spawn>),
        });

        await ingestLaunchCommand(input);

        // Simulate Node's async ENOENT emission AFTER ingest returns.
        const err = Object.assign(new Error("spawn oc-auto-attach ENOENT"), { code: "ENOENT" });
        expect(() => child.emit("error", err)).not.toThrow();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("logs but does not throw on non-ENOENT async errors", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const child = makeChildStub();
        const input = makeInput({
          spawn: vi.fn(() => child as unknown as ReturnType<typeof import("child_process").spawn>),
        });

        await ingestLaunchCommand(input);

        const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
        expect(() => child.emit("error", err)).not.toThrow();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("auto-attach spawn failed (async)"),
          err,
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("logs but does not throw on synchronous spawn failures", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const input = makeInput({
          spawn: vi.fn(() => {
            throw new Error("EACCES: permission denied");
          }),
        });

        await expect(ingestLaunchCommand(input)).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("auto-attach spawn failed (sync)"),
          expect.any(Error),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("does not spawn auto-attach when sendPrompt throws", async () => {
      const spawn = vi.fn();
      const input = makeInput({
        opencodeClient: {
          healthCheck: vi.fn().mockResolvedValue(true),
          createSession: vi.fn().mockResolvedValue({ id: "sess-fail" }),
          sendPrompt: vi.fn().mockRejectedValue(new Error("send failed")),
        } as unknown as import("../src/opencode-client").OpencodeClient,
        spawn,
      });

      await ingestLaunchCommand(input);

      expect(spawn).not.toHaveBeenCalled();
    });
  });
});
