import { describe, expect, it, vi } from "vitest";
import { NvimRpcAdapter } from "../src/adapters/nvim-rpc";
import type { SessionRecord } from "../src/storage/types";

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "sess-1",
    ppid: 1234,
    pid: 5678,
    startTime: Date.now(),
    cwd: "/tmp",
    label: null,
    notify: true,
    state: "active",
    ptyPath: "/dev/pts/42",
    nvimSocket: "/tmp/nvim.sock",
    backendKind: null,
    backendProtocolVersion: null,
    backendEndpoint: null,
    backendAuthToken: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastSeen: Date.now(),
    expiresAt: Date.now() + 3600_000,
    ...overrides,
  };
}

const defaultContext = { commandId: "cmd-1", chatId: 12345 };

describe("NvimRpcAdapter", () => {
  it("returns ok true on successful command delivery", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
      exitCode: 0,
    }));
    const adapter = new NvimRpcAdapter({ exec });
    const session = makeSession();

    const result = await adapter.deliverCommand(session, "echo hello", defaultContext);

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.meta).toEqual({
      nvimSocket: "/tmp/nvim.sock",
      ptyPath: "/dev/pts/42",
    });
    expect(exec).toHaveBeenCalledOnce();
  });

  it("propagates error when nvim reports instance not found", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: false, error: "instance not found" }),
      stderr: "",
      exitCode: 0,
    }));
    const adapter = new NvimRpcAdapter({ exec });
    const session = makeSession();

    const result = await adapter.deliverCommand(session, "echo hello", defaultContext);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("instance not found");
  });

  it("returns immediate error when session is missing nvimSocket", async () => {
    const exec = vi.fn();
    const adapter = new NvimRpcAdapter({ exec });
    const session = makeSession({ nvimSocket: null });

    const result = await adapter.deliverCommand(session, "echo hello", defaultContext);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Session missing nvimSocket");
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns immediate error when session is missing ptyPath", async () => {
    const exec = vi.fn();
    const adapter = new NvimRpcAdapter({ exec });
    const session = makeSession({ ptyPath: null });

    const result = await adapter.deliverCommand(session, "echo hello", defaultContext);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Session missing ptyPath");
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns error when nvim process exits non-zero", async () => {
    const exec = vi.fn(async () => ({
      stdout: "",
      stderr: "E999: Connection refused",
      exitCode: 1,
    }));
    const adapter = new NvimRpcAdapter({ exec });
    const session = makeSession();

    const result = await adapter.deliverCommand(session, "echo hello", defaultContext);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("nvim exited with code 1");
    expect(result.error).toContain("E999: Connection refused");
  });

  it("returns timeout error when nvim process is killed (exitCode null)", async () => {
    const exec = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: null,
    }));
    const adapter = new NvimRpcAdapter({ exec, timeoutMs: 100 });
    const session = makeSession();

    const result = await adapter.deliverCommand(session, "echo hello", defaultContext);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("nvim RPC timed out");
  });

  it("returns error when nvim returns malformed JSON", async () => {
    const exec = vi.fn(async () => ({
      stdout: "this is not json at all",
      stderr: "",
      exitCode: 0,
    }));
    const adapter = new NvimRpcAdapter({ exec });
    const session = makeSession();

    const result = await adapter.deliverCommand(session, "echo hello", defaultContext);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("nvim returned invalid JSON");
    expect(result.error).toContain("this is not json at all");
  });

  it("encodes the correct base64 JSON payload with type, instance, and text", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
      exitCode: 0,
    }));
    const adapter = new NvimRpcAdapter({ exec });
    const session = makeSession({ ptyPath: "/dev/pts/99" });
    const command = "do something";

    await adapter.deliverCommand(session, command, defaultContext);

    // The exec function receives args array; the luaeval expression is the last arg
    const callArgs = exec.mock.calls[0] as unknown as [string[], number];
    const args = callArgs[0];
    const exprArg = args[args.length - 1];

    // Extract the base64 string from the luaeval expression
    const b64Match = exprArg!.match(/_A\)', '([A-Za-z0-9+/=]+)'\)/);
    expect(b64Match).not.toBeNull();
    const decoded = JSON.parse(Buffer.from(b64Match![1]!, "base64").toString("utf-8"));

    expect(decoded).toEqual({
      type: "send",
      instance: "/dev/pts/99",
      text: "do something",
    });
  });

  it("constructs the correct nvim command with --headless --server and pigeon luaeval", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
      exitCode: 0,
    }));
    const adapter = new NvimRpcAdapter({ exec });
    const session = makeSession({ nvimSocket: "/run/user/1000/nvim.sock" });

    await adapter.deliverCommand(session, "test-cmd", defaultContext);

    const callArgs = exec.mock.calls[0] as unknown as [string[], number];
    const args = callArgs[0];

    expect(args[0]).toBe("--headless");
    expect(args[1]).toBe("--server");
    expect(args[2]).toBe("/run/user/1000/nvim.sock");
    expect(args[3]).toBe("--remote-expr");
    // The expression should reference pigeon (not ccremote)
    expect(args[4]).toContain('require("pigeon")');
    expect(args[4]).toContain("luaeval");
    expect(args[4]).not.toContain("ccremote");
  });

  it("returns error when exec throws an exception", async () => {
    const exec = vi.fn(async () => {
      throw new Error("spawn ENOENT");
    });
    const adapter = new NvimRpcAdapter({ exec });
    const session = makeSession();

    const result = await adapter.deliverCommand(session, "echo hello", defaultContext);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("nvim exec failed");
    expect(result.error).toContain("spawn ENOENT");
  });

  it("returns error when nvim returns empty stdout", async () => {
    const exec = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const adapter = new NvimRpcAdapter({ exec });
    const session = makeSession();

    const result = await adapter.deliverCommand(session, "echo hello", defaultContext);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("nvim returned empty response");
  });

  it("returns error for unexpected response shape (missing ok field)", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ status: "done" }),
      stderr: "",
      exitCode: 0,
    }));
    const adapter = new NvimRpcAdapter({ exec });
    const session = makeSession();

    const result = await adapter.deliverCommand(session, "echo hello", defaultContext);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unexpected nvim response shape");
  });

  it("passes the configured timeout to exec", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
      exitCode: 0,
    }));
    const adapter = new NvimRpcAdapter({ exec, timeoutMs: 5000 });
    const session = makeSession();

    await adapter.deliverCommand(session, "echo hello", defaultContext);

    const callArgs = exec.mock.calls[0] as unknown as [string[], number];
    expect(callArgs[1]).toBe(5000);
  });

  it("uses default timeout of 10000ms when not specified", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
      exitCode: 0,
    }));
    const adapter = new NvimRpcAdapter({ exec });
    const session = makeSession();

    await adapter.deliverCommand(session, "echo hello", defaultContext);

    const callArgs = exec.mock.calls[0] as unknown as [string[], number];
    expect(callArgs[1]).toBe(10_000);
  });

  it("reports adapter name as nvim-rpc", () => {
    const adapter = new NvimRpcAdapter();
    expect(adapter.name).toBe("nvim-rpc");
  });

  it("uses exit code in error when stderr is empty", async () => {
    const exec = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 127,
    }));
    const adapter = new NvimRpcAdapter({ exec });
    const session = makeSession();

    const result = await adapter.deliverCommand(session, "echo hello", defaultContext);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("exit code 127");
  });
});
