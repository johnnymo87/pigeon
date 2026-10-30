import { describe, expect, it, vi } from "vitest";
import {
  ingestLaunchCommand,
  startSession,
  autoAttach,
  applyTag,
  type LaunchCommandInput,
  type LaunchStartInput,
  type LaunchStartOutcome,
} from "../src/worker/launch-ingest";
import { OpencodeHttpError, type OpencodeClient } from "../src/opencode-client";
import { RequestTimeoutError, TransportError } from "../src/routing/serve-outcome";

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
    it("reports session started with unconfirmed prompt warning instead of 'Failed to launch'", async () => {
      const input = makeInput({
        opencodeClient: {
          healthCheck: vi.fn().mockResolvedValue(true),
          createSession: vi.fn().mockResolvedValue({ id: "sess-xyz" }),
          sendPrompt: vi.fn().mockRejectedValue(new Error("sendPrompt failed: 500 Internal Server Error")),
        } as unknown as OpencodeClient,
      });

      await ingestLaunchCommand(input);

      const [chatId, text] = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
      expect(chatId).toBe("42");
      expect(text).toContain("Session started:");
      expect(text).toContain("sess-xyz");
      expect(text).toContain("⚠️ Its prompt may not have arrived: sendPrompt failed: 500 Internal Server Error");
      expect(text).toContain("The pigeon plugin will notify you when the session stops or has questions.");
      expect(text).not.toContain("Failed to launch session");
    });
  });

  describe("unconfirmed outcomes", () => {
    it("reports 'Launch may or may not have started' when createSession times out without id", async () => {
      const input = makeInput({
        opencodeClient: {
          healthCheck: vi.fn().mockResolvedValue(true),
          createSession: vi.fn().mockRejectedValue(new RequestTimeoutError(30000, "http://localhost:4096/session")),
          sendPrompt: vi.fn(),
        } as unknown as OpencodeClient,
      });

      await ingestLaunchCommand(input);

      expect(input.sendTelegramReply).toHaveBeenCalledWith(
        "42",
        "Launch may or may not have started: request timed out after 30000ms: http://localhost:4096/session",
      );
    });

    it("reports machine label when createSession times out without id", async () => {
      const input = makeInput({
        machineId: "devbox",
        opencodeClient: {
          healthCheck: vi.fn().mockResolvedValue(true),
          createSession: vi.fn().mockRejectedValue(new RequestTimeoutError(30000, "http://localhost:4096/session")),
          sendPrompt: vi.fn(),
        } as unknown as OpencodeClient,
      });

      await ingestLaunchCommand(input);

      expect(input.sendTelegramReply).toHaveBeenCalledWith(
        "42",
        "Launch on devbox may or may not have started: request timed out after 30000ms: http://localhost:4096/session",
      );
    });
  });

  describe("post-start failure resilience", () => {
    it("still sends 'Session started' when tag step throws after launch", async () => {
      const runOcTags = vi.fn().mockRejectedValue(new Error("tags.db is locked"));
      const input = makeInput({
        tag: "my-tag",
        runOcTags,
      });

      await ingestLaunchCommand(input);

      expect(input.sendTelegramReply).toHaveBeenCalledWith(
        "42",
        expect.stringContaining("Session started"),
        expect.anything(),
      );
      const text = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(text).not.toContain("Failed to launch session");
      expect(text).toContain("sess-123");
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

    it("does not spawn auto-attach when sendPrompt is refused", async () => {
      const spawn = vi.fn();
      const input = makeInput({
        opencodeClient: {
          healthCheck: vi.fn().mockResolvedValue(true),
          createSession: vi.fn().mockResolvedValue({ id: "sess-fail" }),
          sendPrompt: vi.fn().mockRejectedValue(new OpencodeHttpError(400, "Bad Request", "send failed")),
          deleteSession: vi.fn().mockResolvedValue(undefined),
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

    it("announces the tag so a cache warmed before it can be refetched", async () => {
      // The session registers (and warms its tag cache) before the tag is
      // written, so without this its first notification shows no tag right
      // after Telegram said the tag was applied.
      const onTagged = vi.fn();
      const runOcTags = vi.fn().mockResolvedValue({ code: 0, stdout: "Tagged\n", stderr: "" });

      await ingestLaunchCommand(makeInput({ tag: "fbm", runOcTags, onTagged }));

      expect(onTagged).toHaveBeenCalledWith("sess-123");
    });

    it("does not announce a tag oc-tags refused", async () => {
      const onTagged = vi.fn();
      const runOcTags = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "Error: nope\n" });

      await ingestLaunchCommand(makeInput({ tag: "fbm", runOcTags, onTagged }));

      expect(onTagged).not.toHaveBeenCalled();
    });

    it("still confirms the launch when the announcement throws", async () => {
      const runOcTags = vi.fn().mockResolvedValue({ code: 0, stdout: "Tagged\n", stderr: "" });
      const input = makeInput({
        tag: "fbm",
        runOcTags,
        onTagged: () => { throw new Error("boom"); },
      });

      await ingestLaunchCommand(input);

      expect(lastReply(input)).toContain("sess-123");
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

    it("never spawns for a non-string tag off the wire", async () => {
      // metadata_json is JSON from a D1 row; TypeScript's `tag?: string` is a
      // claim about it, not a guarantee. isValidTag's typeof guard is what
      // keeps a number or an object away from the process spawner.
      for (const bogus of [5, {}, [], true]) {
        const runOcTags = vi.fn();
        const input = makeInput({ tag: bogus as unknown as string, runOcTags });

        await ingestLaunchCommand(input);

        expect(runOcTags).not.toHaveBeenCalled();
        expect(input.opencodeClient.sendPrompt).toHaveBeenCalled();
        expect(lastReply(input)).toContain("invalid tag");
      }
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

  // ─── tag inheritance (inheritFromSessionId) ───────────────────────────────
  describe("tag inheritance", () => {
    const PARENT = "ses_parent01AbC";

    function lastReply(input: LaunchCommandInput): string {
      const calls = (input.sendTelegramReply as ReturnType<typeof vi.fn>).mock.calls;
      return calls[calls.length - 1]![1] as string;
    }

    function whichOut(stdout: string) {
      return vi.fn().mockResolvedValue({ code: 0, stdout, stderr: "" });
    }

    function setRunner() {
      return vi.fn().mockResolvedValue({ code: 0, stdout: "Tagged session 'sess-123' as 'billing'\n", stderr: "" });
    }

    it("copies the parent's tag when oc-tags says it is an explicit session tag", async () => {
      const runOcTagsWhich = whichOut(`billing\tmanual\t${PARENT}\tsession\n`);
      const runOcTags = setRunner();
      const onTagged = vi.fn();
      const input = makeInput({ inheritFromSessionId: PARENT, runOcTagsWhich, runOcTags, onTagged });

      await ingestLaunchCommand(input);

      expect(runOcTagsWhich).toHaveBeenCalledWith(["which", PARENT]);
      expect(runOcTags).toHaveBeenCalledWith(["set", "billing", "sess-123"]);
      expect(onTagged).toHaveBeenCalledWith("sess-123");
      const reply = lastReply(input);
      expect(reply).toContain("sess-123");
      expect(reply).toContain(`🏷 Tagged session 'sess-123' as 'billing' (inherited from ${PARENT})`);
    });

    it("names the root session as the source when the context session is a subagent", async () => {
      const ROOT = "ses_root01XyZ";
      const input = makeInput({
        inheritFromSessionId: PARENT,
        runOcTagsWhich: whichOut(`billing\tmanual\t${ROOT}\tsession\n`),
        runOcTags: setRunner(),
      });

      await ingestLaunchCommand(input);

      expect(lastReply(input)).toContain(`(inherited from ${ROOT})`);
    });

    it("runs which only after the session is created and prompted", async () => {
      const order: string[] = [];
      const opencodeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn(async () => { order.push("create"); return { id: "sess-123" }; }),
        sendPrompt: vi.fn(async () => { order.push("prompt"); }),
      } as unknown as OpencodeClient;
      const runOcTagsWhich = vi.fn(async () => { order.push("which"); return { code: 0, stdout: `b\tmanual\t${PARENT}\tsession\n`, stderr: "" }; });

      await ingestLaunchCommand(makeInput({ inheritFromSessionId: PARENT, runOcTagsWhich, runOcTags: setRunner(), opencodeClient }));

      expect(order).toEqual(["create", "prompt", "which"]);
    });

    it.each([
      ["a legacy dir rule", `mono\tmanual\t${PARENT}\tdir\n`],
      ["the auto: fallback", `auto:pigeon\tauto\t${PARENT}\tauto\n`],
    ])("does not inherit a tag that comes from %s", async (_label, stdout) => {
      const runOcTags = setRunner();
      const input = makeInput({ inheritFromSessionId: PARENT, runOcTagsWhich: whichOut(stdout), runOcTags });

      await ingestLaunchCommand(input);

      expect(runOcTags).not.toHaveBeenCalled();
      expect(lastReply(input)).toContain("sess-123");
      expect(lastReply(input)).toContain(`No tag inherited: ${PARENT} has no session tag`);
    });

    it("does not inherit from an older oc-tags that prints only three columns", async () => {
      // Column 2 says `manual` for a session tag AND a legacy dir rule; without
      // column 4 there is no way to tell them apart, so nothing is copied.
      const runOcTags = setRunner();
      const input = makeInput({
        inheritFromSessionId: PARENT,
        runOcTagsWhich: whichOut(`billing\tmanual\t${PARENT}\n`),
        runOcTags,
      });

      await ingestLaunchCommand(input);

      expect(runOcTags).not.toHaveBeenCalled();
      expect(lastReply(input)).toContain("too old");
    });

    it("never runs which for an invalid session id", async () => {
      for (const bogus of ["-rf", "--help", "", "ses x", 5 as unknown as string]) {
        const runOcTagsWhich = vi.fn();
        const runOcTags = vi.fn();
        const input = makeInput({ inheritFromSessionId: bogus, runOcTagsWhich, runOcTags });

        await ingestLaunchCommand(input);

        expect(runOcTagsWhich).not.toHaveBeenCalled();
        expect(runOcTags).not.toHaveBeenCalled();
        expect(input.opencodeClient.sendPrompt).toHaveBeenCalled();
        expect(lastReply(input)).toContain("sess-123");
        expect(lastReply(input)).toContain("Tag not inherited: invalid session id");
      }
    });

    it("reports a which timeout without throwing, and applies no tag", async () => {
      // The runner REJECTS on timeout; a throw out of ingestLaunchCommand would
      // skip the ack and redeliver the launch as a duplicate session.
      const runOcTagsWhich = vi.fn().mockRejectedValue(
        Object.assign(new Error(`Command failed: oc-tags which ${PARENT}`), { code: null, killed: true, signal: "SIGTERM" }),
      );
      const runOcTags = setRunner();
      const input = makeInput({ inheritFromSessionId: PARENT, runOcTagsWhich, runOcTags });

      await expect(ingestLaunchCommand(input)).resolves.toBeUndefined();

      expect(runOcTags).not.toHaveBeenCalled();
      expect(lastReply(input)).toContain("sess-123");
      expect(lastReply(input)).toContain("timed out after 3s");
    });

    it("never throws, however the which runner misbehaves", async () => {
      const runners = [
        vi.fn().mockRejectedValue(new Error("boom")),
        vi.fn(() => { throw new Error("sync boom"); }),
        vi.fn().mockResolvedValue(undefined),
        vi.fn().mockResolvedValue({ code: 0 }),
        vi.fn().mockResolvedValue({ code: 2, stdout: "", stderr: "Error: no such session\n" }),
      ];
      for (const runOcTagsWhich of runners) {
        const runOcTags = setRunner();
        const input = makeInput({
          inheritFromSessionId: PARENT,
          runOcTagsWhich: runOcTagsWhich as unknown as LaunchCommandInput["runOcTagsWhich"],
          runOcTags,
        });
        await expect(ingestLaunchCommand(input)).resolves.toBeUndefined();
        expect(runOcTags).not.toHaveBeenCalled();
        expect(lastReply(input)).toContain("sess-123");
        expect(lastReply(input)).toContain("Tag not inherited");
      }
    });

    it("an explicit tag wins: which is never run", async () => {
      const runOcTagsWhich = vi.fn();
      const runOcTags = setRunner();
      const input = makeInput({ tag: "fbm", inheritFromSessionId: PARENT, runOcTagsWhich, runOcTags });

      await ingestLaunchCommand(input);

      expect(runOcTagsWhich).not.toHaveBeenCalled();
      expect(runOcTags).toHaveBeenCalledWith(["set", "fbm", "sess-123"]);
      expect(lastReply(input)).not.toContain("inherit");
    });

    it("says nothing about inheritance when no candidate was sent (old worker, General /launch)", async () => {
      const runOcTagsWhich = vi.fn();
      const input = makeInput({ runOcTagsWhich, runOcTags: setRunner() });

      await ingestLaunchCommand(input);

      expect(runOcTagsWhich).not.toHaveBeenCalled();
      expect(lastReply(input)).not.toContain("🏷");
    });

    it("says why when oc-tags is not installed", async () => {
      const input = makeInput({ inheritFromSessionId: PARENT, runOcTagsWhich: null, runOcTags: null });

      await ingestLaunchCommand(input);

      expect(lastReply(input)).toContain("sess-123");
      expect(lastReply(input)).toContain("Tag not inherited: oc-tags is not installed");
    });

    it("names the parent when the set of an inherited tag fails", async () => {
      const runOcTags = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "sqlite3.OperationalError: database is locked\n" });
      const onTagged = vi.fn();
      const input = makeInput({
        inheritFromSessionId: PARENT,
        runOcTagsWhich: whichOut(`billing\tmanual\t${PARENT}\tsession\n`),
        runOcTags,
        onTagged,
      });

      await ingestLaunchCommand(input);

      expect(onTagged).not.toHaveBeenCalled();
      expect(lastReply(input)).toContain(`Tag not applied: sqlite3.OperationalError: database is locked (inheriting from ${PARENT})`);
    });
  });
});

describe("startSession", () => {
  function makeTransportError(code?: string, msg = "fetch failed"): TransportError {
    const cause = new Error(msg);
    if (code) {
      (cause as unknown as { cause: { code: string } }).cause = { code };
    }
    return new TransportError(cause);
  }

  it("returns refused serve_unavailable when healthCheck returns false", async () => {
    const fakeClient = {
      healthCheck: vi.fn().mockResolvedValue(false),
      createSession: vi.fn(),
      sendPrompt: vi.fn(),
      deleteSession: vi.fn(),
    } as unknown as OpencodeClient;

    const outcome = await startSession({
      directory: "/home/user/project",
      prompt: "hello",
      opencodeClient: fakeClient,
    });

    expect(outcome).toEqual({
      outcome: "refused",
      reason: "serve_unavailable",
      detail: "opencode serve is not running",
    });
    expect(fakeClient.createSession).not.toHaveBeenCalled();
  });

  describe("createSession classification", () => {
    it("RequestTimeoutError -> unconfirmed with null id", async () => {
      const fakeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockRejectedValue(new RequestTimeoutError(15000, "http://serve/session")),
        sendPrompt: vi.fn(),
        deleteSession: vi.fn(),
      } as unknown as OpencodeClient;

      const outcome = await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: fakeClient,
      });

      expect(outcome).toEqual({
        outcome: "unconfirmed",
        sessionId: null,
        detail: "request timed out after 15000ms: http://serve/session",
      });
      expect(fakeClient.sendPrompt).not.toHaveBeenCalled();
    });

    it("TransportError with ECONNREFUSED -> refused serve_unreachable", async () => {
      const fakeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockRejectedValue(makeTransportError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:4096")),
        sendPrompt: vi.fn(),
        deleteSession: vi.fn(),
      } as unknown as OpencodeClient;

      const outcome = await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: fakeClient,
      });

      expect(outcome).toEqual({
        outcome: "refused",
        reason: "serve_unreachable",
        detail: "Transport error: connect ECONNREFUSED 127.0.0.1:4096",
      });
      expect(fakeClient.sendPrompt).not.toHaveBeenCalled();
    });

    it("TransportError with other code (e.g. ECONNRESET) -> unconfirmed with null id", async () => {
      const fakeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockRejectedValue(makeTransportError("ECONNRESET", "socket hang up")),
        sendPrompt: vi.fn(),
        deleteSession: vi.fn(),
      } as unknown as OpencodeClient;

      const outcome = await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: fakeClient,
      });

      expect(outcome).toEqual({
        outcome: "unconfirmed",
        sessionId: null,
        detail: "Transport error: socket hang up",
      });
      expect(fakeClient.sendPrompt).not.toHaveBeenCalled();
    });

    it("any other error (e.g. HTTP non-ok or bad body) -> refused create_failed", async () => {
      const fakeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockRejectedValue(new Error("createSession failed: 500 Internal Server Error")),
        sendPrompt: vi.fn(),
        deleteSession: vi.fn(),
      } as unknown as OpencodeClient;

      const outcome = await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: fakeClient,
      });

      expect(outcome).toEqual({
        outcome: "refused",
        reason: "create_failed",
        detail: "createSession failed: 500 Internal Server Error",
      });
      expect(fakeClient.sendPrompt).not.toHaveBeenCalled();
    });
  });

  describe("sendPrompt classification", () => {
    it("ok -> launched", async () => {
      const fakeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        sendPrompt: vi.fn().mockResolvedValue(undefined),
        deleteSession: vi.fn(),
      } as unknown as OpencodeClient;

      const outcome = await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: fakeClient,
      });

      expect(outcome).toEqual({
        outcome: "launched",
        sessionId: "sess-1",
      });
      expect(fakeClient.deleteSession).not.toHaveBeenCalled();
    });

    it("OpencodeHttpError with 4xx status -> refused prompt_rejected and deleteSession called", async () => {
      const fakeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        sendPrompt: vi.fn().mockRejectedValue(new OpencodeHttpError(400, "Bad Request", "prompt rejected: prompt too large")),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      } as unknown as OpencodeClient;

      const outcome = await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: fakeClient,
      });

      expect(outcome).toEqual({
        outcome: "refused",
        reason: "prompt_rejected",
        detail: "prompt rejected: prompt too large",
      });
      expect(fakeClient.deleteSession).toHaveBeenCalledWith("sess-1");
    });

    it("TransportError with ECONNREFUSED -> refused prompt_unreachable and deleteSession called", async () => {
      const fakeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        sendPrompt: vi.fn().mockRejectedValue(makeTransportError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:4096")),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      } as unknown as OpencodeClient;

      const outcome = await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: fakeClient,
      });

      expect(outcome).toEqual({
        outcome: "refused",
        reason: "prompt_unreachable",
        detail: "Transport error: connect ECONNREFUSED 127.0.0.1:4096",
      });
      expect(fakeClient.deleteSession).toHaveBeenCalledWith("sess-1");
    });

    it("swallows errors from deleteSession when sendPrompt was refused", async () => {
      const fakeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        sendPrompt: vi.fn().mockRejectedValue(new OpencodeHttpError(404, "Not Found", "session not found")),
        deleteSession: vi.fn().mockRejectedValue(new Error("deleteSession failed: 500")),
      } as unknown as OpencodeClient;

      const outcome = await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: fakeClient,
      });

      expect(outcome).toEqual({
        outcome: "refused",
        reason: "prompt_rejected",
        detail: "session not found",
      });
      expect(fakeClient.deleteSession).toHaveBeenCalledWith("sess-1");
    });

    it("RequestTimeoutError -> unconfirmed with id and deleteSession not called", async () => {
      const fakeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        sendPrompt: vi.fn().mockRejectedValue(new RequestTimeoutError(20000, "http://serve/prompt")),
        deleteSession: vi.fn(),
      } as unknown as OpencodeClient;

      const outcome = await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: fakeClient,
      });

      expect(outcome).toEqual({
        outcome: "unconfirmed",
        sessionId: "sess-1",
        detail: "request timed out after 20000ms: http://serve/prompt",
      });
      expect(fakeClient.deleteSession).not.toHaveBeenCalled();
    });

    it("OpencodeHttpError with 5xx status -> unconfirmed with id and deleteSession not called", async () => {
      const fakeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        sendPrompt: vi.fn().mockRejectedValue(new OpencodeHttpError(502, "Bad Gateway", "serve crashed")),
        deleteSession: vi.fn(),
      } as unknown as OpencodeClient;

      const outcome = await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: fakeClient,
      });

      expect(outcome).toEqual({
        outcome: "unconfirmed",
        sessionId: "sess-1",
        detail: "serve crashed",
      });
      expect(fakeClient.deleteSession).not.toHaveBeenCalled();
    });

    it("TransportError with other code (e.g. ECONNRESET) -> unconfirmed with id and deleteSession not called", async () => {
      const fakeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        sendPrompt: vi.fn().mockRejectedValue(makeTransportError("ECONNRESET", "socket hang up")),
        deleteSession: vi.fn(),
      } as unknown as OpencodeClient;

      const outcome = await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: fakeClient,
      });

      expect(outcome).toEqual({
        outcome: "unconfirmed",
        sessionId: "sess-1",
        detail: "Transport error: socket hang up",
      });
      expect(fakeClient.deleteSession).not.toHaveBeenCalled();
    });

    it("generic Error -> unconfirmed with id and deleteSession not called", async () => {
      const fakeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        sendPrompt: vi.fn().mockRejectedValue(new Error("unexpected error")),
        deleteSession: vi.fn(),
      } as unknown as OpencodeClient;

      const outcome = await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: fakeClient,
      });

      expect(outcome).toEqual({
        outcome: "unconfirmed",
        sessionId: "sess-1",
        detail: "unexpected error",
      });
      expect(fakeClient.deleteSession).not.toHaveBeenCalled();
    });
  });

  describe("onCreated hook", () => {
    it("calls onCreated with sessionId right after createSession and before sendPrompt", async () => {
      const callOrder: string[] = [];
      const fakeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockImplementation(async () => {
          callOrder.push("createSession");
          return { id: "sess-hook" };
        }),
        sendPrompt: vi.fn().mockImplementation(async () => {
          callOrder.push("sendPrompt");
        }),
        deleteSession: vi.fn(),
      } as unknown as OpencodeClient;

      const onCreated = vi.fn().mockImplementation((id: string) => {
        callOrder.push(`onCreated:${id}`);
      });

      const outcome = await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: fakeClient,
        onCreated,
      });

      expect(outcome).toEqual({ outcome: "launched", sessionId: "sess-hook" });
      expect(callOrder).toEqual(["createSession", "onCreated:sess-hook", "sendPrompt"]);
      expect(onCreated).toHaveBeenCalledWith("sess-hook");
    });

    it("onCreated throwing does not change the outcome", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fakeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockResolvedValue({ id: "sess-hook-err" }),
        sendPrompt: vi.fn().mockResolvedValue(undefined),
        deleteSession: vi.fn(),
      } as unknown as OpencodeClient;

      const onCreated = vi.fn().mockImplementation(() => {
        throw new Error("hook exploded");
      });

      const outcome = await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: fakeClient,
        onCreated,
      });

      expect(outcome).toEqual({ outcome: "launched", sessionId: "sess-hook-err" });
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("budgets option", () => {
    it("passes budgets to healthCheck, createSession, and sendPrompt", async () => {
      const fakeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockResolvedValue({ id: "sess-budgets" }),
        sendPrompt: vi.fn().mockResolvedValue(undefined),
        deleteSession: vi.fn(),
      } as unknown as OpencodeClient;

      await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: fakeClient,
        budgets: { healthMs: 5000, createMs: 15000, promptMs: 20000 },
      });

      expect(fakeClient.healthCheck).toHaveBeenCalledWith({ timeoutMs: 5000 });
      expect(fakeClient.createSession).toHaveBeenCalledWith("/home/user/project", { timeoutMs: 15000 });
      expect(fakeClient.sendPrompt).toHaveBeenCalledWith("sess-budgets", "/home/user/project", "hello", { timeoutMs: 20000 });
    });

    it("calls client methods without timeout options when budgets is not provided", async () => {
      const fakeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockResolvedValue({ id: "sess-nobudgets" }),
        sendPrompt: vi.fn().mockResolvedValue(undefined),
        deleteSession: vi.fn(),
      } as unknown as OpencodeClient;

      await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: fakeClient,
      });

      expect(fakeClient.healthCheck).toHaveBeenCalledWith();
      expect(fakeClient.createSession).toHaveBeenCalledWith("/home/user/project");
      expect(fakeClient.sendPrompt).toHaveBeenCalledWith("sess-nobudgets", "/home/user/project", "hello");
    });
  });

  describe("resolveOwnerClient", () => {
    it("sends prompt and deletes on owner client when provided", async () => {
      const createClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockResolvedValue({ id: "sess-owner" }),
        sendPrompt: vi.fn(),
        deleteSession: vi.fn(),
      } as unknown as OpencodeClient;

      const ownerClient = {
        sendPrompt: vi.fn().mockRejectedValue(new OpencodeHttpError(400, "Bad Request", "rejected on owner")),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      } as unknown as OpencodeClient;

      const resolveOwnerClient = vi.fn().mockReturnValue(ownerClient);

      const outcome = await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: createClient,
        resolveOwnerClient,
      });

      expect(resolveOwnerClient).toHaveBeenCalledWith("sess-owner");
      expect(ownerClient.sendPrompt).toHaveBeenCalledWith("sess-owner", "/home/user/project", "hello");
      expect(ownerClient.deleteSession).toHaveBeenCalledWith("sess-owner");
      expect(outcome).toEqual({
        outcome: "refused",
        reason: "prompt_rejected",
        detail: "rejected on owner",
      });
    });
  });

  describe("detail truncation", () => {
    it("truncates error messages longer than 300 characters", async () => {
      const longMessage = "E".repeat(500);
      const fakeClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockRejectedValue(new Error(longMessage)),
        sendPrompt: vi.fn(),
        deleteSession: vi.fn(),
      } as unknown as OpencodeClient;

      const outcome = await startSession({
        directory: "/home/user/project",
        prompt: "hello",
        opencodeClient: fakeClient,
      });

      expect(outcome.outcome).toBe("refused");
      if (outcome.outcome === "refused") {
        expect(outcome.detail.length).toBe(300);
        expect(outcome.detail.endsWith("…")).toBe(true);
      }
    });
  });
});

describe("autoAttach export", () => {
  it("exports autoAttach and spawns oc-auto-attach with sessionId", () => {
    const unref = vi.fn();
    const spawnFn = vi.fn(() => ({
      unref,
      on: vi.fn(),
    } as unknown as ReturnType<typeof import("child_process").spawn>));

    autoAttach("sess-auto", spawnFn);

    expect(spawnFn).toHaveBeenCalledWith(
      expect.stringContaining("oc-auto-attach"),
      ["sess-auto"],
      expect.objectContaining({ detached: true }),
    );
  });
});

describe("applyTag export", () => {
  it("exports applyTag and tags a session", async () => {
    const runOcTags = vi.fn().mockResolvedValue({ code: 0, stdout: "tagged fbm\n", stderr: "" });
    const line = await applyTag("fbm", "sess-1", runOcTags, "");
    expect(line).toBe("tagged fbm");
    expect(runOcTags).toHaveBeenCalledWith(["set", "fbm", "sess-1"]);
  });
});
