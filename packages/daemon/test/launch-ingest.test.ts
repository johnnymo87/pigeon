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

    it("expands a single word directory to ~/projects/<word> on Linux, or ~/Code/<word> on macOS", async () => {
      const input = makeInput({ directory: "pigeon" });

      await ingestLaunchCommand(input);

      const homeDir = require("os").homedir();
      const isDarwin = require("os").platform() === "darwin";
      const expectedPrefix = isDarwin ? "Code" : "projects";
      expect(input.opencodeClient.createSession).toHaveBeenCalledWith(`${homeDir}/${expectedPrefix}/pigeon`);
      expect(input.opencodeClient.sendPrompt).toHaveBeenCalledWith(
        "sess-123",
        `${homeDir}/${expectedPrefix}/pigeon`,
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

    it("sends the prompt to the routed owner serve, not the create serve", async () => {
      // In a K-serve pool the session is CREATED on serve-0 (a row in the
      // shared opencode.db) but its agent loop must run on the serve pigeon
      // HRW-assigns. resolveOwnerClient(sessionId) returns that owner's client.
      const ownerClient = {
        sendPrompt: vi.fn().mockResolvedValue(undefined),
      } as unknown as OpencodeClient;
      const resolveOwnerClient = vi.fn().mockReturnValue(ownerClient);
      const input = makeInput({ resolveOwnerClient });

      await ingestLaunchCommand(input);

      // Session is created on serve-0 (the create client).
      expect(input.opencodeClient.createSession).toHaveBeenCalledWith("/home/user/project");
      // Owner resolved for the created session id (this is what HRW-places it).
      expect(resolveOwnerClient).toHaveBeenCalledWith("sess-123");
      // Prompt goes to the OWNER, not the create client.
      expect(ownerClient.sendPrompt).toHaveBeenCalledWith(
        "sess-123",
        "/home/user/project",
        "Write a hello world program",
      );
      expect(input.opencodeClient.sendPrompt).not.toHaveBeenCalled();
    });

    it("falls back to the create serve when no owner can be resolved (no healthy pool serve)", async () => {
      const resolveOwnerClient = vi.fn().mockReturnValue(undefined);
      const input = makeInput({ resolveOwnerClient });

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
      const prev = process.env.OC_AUTO_ATTACH_BIN;
      delete process.env.OC_AUTO_ATTACH_BIN;
      try {
        const spawnFn = vi.fn(() => makeChildStub() as unknown as ReturnType<typeof import("child_process").spawn>);
        const input = makeInput({ spawn: spawnFn });

        await ingestLaunchCommand(input);

        expect(spawnFn).toHaveBeenCalledWith(
          "oc-auto-attach",
          ["sess-123"],
          expect.objectContaining({ detached: true }),
        );
      } finally {
        if (prev === undefined) delete process.env.OC_AUTO_ATTACH_BIN;
        else process.env.OC_AUTO_ATTACH_BIN = prev;
      }
    });

    it("uses OC_AUTO_ATTACH_BIN env var when set (so systemd services with locked-down PATH can pin an absolute path)", async () => {
      const prev = process.env.OC_AUTO_ATTACH_BIN;
      process.env.OC_AUTO_ATTACH_BIN = "/nix/store/abc-oc-auto-attach/bin/oc-auto-attach";
      try {
        const spawnFn = vi.fn(() => makeChildStub() as unknown as ReturnType<typeof import("child_process").spawn>);
        const input = makeInput({ spawn: spawnFn });

        await ingestLaunchCommand(input);

        expect(spawnFn).toHaveBeenCalledWith(
          "/nix/store/abc-oc-auto-attach/bin/oc-auto-attach",
          ["sess-123"],
          expect.objectContaining({ detached: true }),
        );
      } finally {
        if (prev === undefined) delete process.env.OC_AUTO_ATTACH_BIN;
        else process.env.OC_AUTO_ATTACH_BIN = prev;
      }
    });

    it("captures child stdout and stderr into /tmp/oc-auto-attach.log so silent failures are debuggable", async () => {
      // We don't want stdio: "ignore" any more — when the daemon spawns
      // oc-auto-attach with discarded stdio, ANY internal failure of the
      // shell script (e.g. a missing tool in PATH under `set -o pipefail`)
      // is invisible. Route stdio to /tmp/oc-auto-attach.log instead, so
      // the same log file the home.base.nix wrapper writes to gets daemon
      // launches too.
      const spawnFn = vi.fn(() => makeChildStub() as unknown as ReturnType<typeof import("child_process").spawn>);
      const input = makeInput({ spawn: spawnFn });

      await ingestLaunchCommand(input);

      expect(spawnFn).toHaveBeenCalledTimes(1);
      const callArgs = spawnFn.mock.calls[0] as unknown as [string, string[], { stdio?: unknown; detached?: boolean }];
      const stdio = callArgs[2]?.stdio;
      // stdio must be an array of length 3: [stdin, stdout, stderr].
      // stdin should be discarded ("ignore"), stdout/stderr should both
      // be a numeric file descriptor pointing at the log file.
      expect(Array.isArray(stdio)).toBe(true);
      const stdioArr = stdio as Array<unknown>;
      expect(stdioArr).toHaveLength(3);
      expect(stdioArr[0]).toBe("ignore");
      expect(typeof stdioArr[1]).toBe("number");
      expect(typeof stdioArr[2]).toBe("number");
      // Same fd reused for both stdout and stderr (single open() call).
      expect(stdioArr[1]).toBe(stdioArr[2]);
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

  // ─── --tag ────────────────────────────────────────────────────────────────
  //
  // No test here spawns a real oc-tags: runOcTags is injected, so nothing
  // touches ~/.local/share/oc-tags/tags.db.
  describe("tagging", () => {
    function lastReply(input: LaunchCommandInput): string {
      const calls = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls;
      return calls[calls.length - 1]![1] as string;
    }

    it("runs oc-tags set with the tag FIRST and the session id second", async () => {
      // Reversed, oc-tags cheerfully tags a session named "fbm" and reports success.
      const runOcTags = vi.fn().mockResolvedValue({ code: 0, stdout: "Tagged session 'sess-123' as 'fbm'\n", stderr: "" });
      const input = makeInput({ tag: "fbm", runOcTags });

      await ingestLaunchCommand(input);

      expect(runOcTags).toHaveBeenCalledWith(["set", "fbm", "sess-123"]);
    });

    it("tags only after the session is created and the prompt is sent", async () => {
      const order: string[] = [];
      const opencodeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn(async () => { order.push("create"); return { id: "sess-123" }; }),
        sendPrompt: vi.fn(async () => { order.push("prompt"); }),
      } as unknown as OpencodeClient;
      const runOcTags = vi.fn(async () => { order.push("tag"); return { code: 0, stdout: "ok", stderr: "" }; });

      await ingestLaunchCommand(makeInput({ tag: "fbm", runOcTags, opencodeClient }));

      // Safe because oc-tags attribution is retroactive: report/top join costs
      // against tags.db at read time, so a tag written a second late still
      // covers every dollar the session ever spends.
      expect(order).toEqual(["create", "prompt", "tag"]);
    });

    it("reports oc-tags' own confirmation line, not one we composed", async () => {
      // oc-tags lowercases, so --tag FBM charts as fbm; a line of our own would
      // name a tag the chart never shows.
      const runOcTags = vi.fn().mockResolvedValue({ code: 0, stdout: "Tagged session 'sess-123' as 'fbm'\n", stderr: "" });
      const input = makeInput({ tag: "FBM", runOcTags });

      await ingestLaunchCommand(input);

      expect(lastReply(input)).toContain("Tagged session 'sess-123' as 'fbm'");
    });

    it("says nothing about tags when no tag was given", async () => {
      const runOcTags = vi.fn();
      const input = makeInput({ runOcTags });

      await ingestLaunchCommand(input);

      expect(runOcTags).not.toHaveBeenCalled();
      expect(lastReply(input)).not.toContain("Tag");
    });

    it("launches normally when a tag is given but oc-tags is not installed", async () => {
      const input = makeInput({ tag: "fbm", runOcTags: null });

      await ingestLaunchCommand(input);

      expect(input.opencodeClient.sendPrompt).toHaveBeenCalled();
      expect(lastReply(input)).toContain("sess-123");
      expect(lastReply(input)).toContain("not installed");
    });

    it("names the reason when oc-tags exits non-zero, using the LAST line of stderr", async () => {
      // A locked tags.db raises OperationalError, which escapes cmd_set's
      // `except ValueError` and prints a 20-line traceback. Only its last line
      // says anything.
      const stderr = [
        "Traceback (most recent call last):",
        '  File "/nix/store/x/bin/.oc-tags-wrapped", line 1200, in <module>',
        "    sys.exit(main())",
        "sqlite3.OperationalError: database is locked",
      ].join("\n");
      const runOcTags = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr });
      const input = makeInput({ tag: "fbm", runOcTags });

      await ingestLaunchCommand(input);

      const reply = lastReply(input);
      expect(reply).toContain("sess-123");
      expect(reply).toContain("database is locked");
      expect(reply).not.toContain("Traceback");
    });

    it("names the reason when oc-tags fails to run at all", async () => {
      const runOcTags = vi.fn().mockRejectedValue(
        Object.assign(new Error("Command failed: oc-tags set fbm sess-123"), { code: null, killed: true, signal: "SIGTERM" }),
      );
      const input = makeInput({ tag: "fbm", runOcTags });

      await ingestLaunchCommand(input);

      expect(lastReply(input)).toMatch(/timed out/);
    });

    it("never throws out of the tag branch, however the runner misbehaves", async () => {
      // A throw here would skip the poller ack, and a redelivered launch is a
      // DUPLICATE session -- far worse than a missing tag row.
      const runners = [
        vi.fn().mockRejectedValue(new Error("boom")),
        vi.fn(() => { throw new Error("sync boom"); }),
        vi.fn().mockResolvedValue(undefined),
        vi.fn().mockResolvedValue({ code: 0 }),
      ];
      for (const runOcTags of runners) {
        const input = makeInput({ tag: "fbm", runOcTags: runOcTags as unknown as LaunchCommandInput["runOcTags"] });
        await expect(ingestLaunchCommand(input)).resolves.toBeUndefined();
        expect(lastReply(input)).toContain("sess-123");
      }
    });

    it("launches anyway when the tag is invalid, and says so", async () => {
      // Only reachable through a tampered D1 row or regex drift between the two
      // validator copies. Whoever can write that row can already queue any
      // launch, so refusing buys nothing -- and "tagging never costs a launch"
      // is the governing rule.
      const runOcTags = vi.fn();
      const input = makeInput({ tag: "auto:pigeon", runOcTags });

      await ingestLaunchCommand(input);

      expect(runOcTags).not.toHaveBeenCalled();
      expect(input.opencodeClient.sendPrompt).toHaveBeenCalled();
      expect(lastReply(input)).toContain("invalid tag");
    });

    it("does not tag when the launch itself failed", async () => {
      const runOcTags = vi.fn();
      const input = makeInput({
        tag: "fbm",
        runOcTags,
        opencodeClient: {
          healthCheck: vi.fn().mockResolvedValue(true),
          createSession: vi.fn().mockRejectedValue(new Error("createSession failed: 500")),
          sendPrompt: vi.fn(),
        } as unknown as OpencodeClient,
      });

      await ingestLaunchCommand(input);

      expect(runOcTags).not.toHaveBeenCalled();
      expect(lastReply(input)).toContain("Failed to launch session");
    });

    it("does not tag when opencode serve is down, since no session exists", async () => {
      const runOcTags = vi.fn();
      const input = makeInput({
        tag: "fbm",
        runOcTags,
        opencodeClient: {
          healthCheck: vi.fn().mockResolvedValue(false),
          createSession: vi.fn(),
          sendPrompt: vi.fn(),
        } as unknown as OpencodeClient,
      });

      await ingestLaunchCommand(input);

      expect(runOcTags).not.toHaveBeenCalled();
    });
  });
});
