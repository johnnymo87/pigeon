import { execFile } from "child_process";
import type { SessionRecord } from "../storage/types";
import type { CommandDeliveryAdapter, CommandDeliveryResult } from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface NvimRpcAdapterDeps {
  /** Override for testing — runs the nvim subprocess and returns { stdout, stderr, exitCode } */
  exec?: (
    args: string[],
    timeoutMs: number,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  timeoutMs?: number;
}

function defaultExec(
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = execFile("nvim", args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error && "killed" in error && error.killed) {
        resolve({ stdout: "", stderr: "", exitCode: null });
        return;
      }
      const exitCode = error && "code" in error && typeof error.code === "number"
        ? error.code
        : child.exitCode;
      resolve({
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
        exitCode: exitCode ?? (error ? 1 : 0),
      });
    });
  });
}

export class NvimRpcAdapter implements CommandDeliveryAdapter {
  readonly name = "nvim-rpc";

  private readonly exec: NvimRpcAdapterDeps["exec"];
  private readonly timeoutMs: number;

  constructor(deps: NvimRpcAdapterDeps = {}) {
    this.exec = deps.exec ?? defaultExec;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async deliverCommand(
    session: SessionRecord,
    command: string,
    context: { commandId: string; chatId?: string | number },
  ): Promise<CommandDeliveryResult> {
    if (!session.nvimSocket) {
      return { ok: false, error: "Session missing nvimSocket" };
    }
    if (!session.ptyPath) {
      return { ok: false, error: "Session missing ptyPath" };
    }

    const payload = JSON.stringify({
      type: "send",
      name: session.ptyPath,
      command,
    });
    const encoded = Buffer.from(payload).toString("base64");

    const expr = `luaeval('require("pigeon").dispatch(_A)', '${encoded}')`;
    const args = [
      "--headless",
      "--server",
      session.nvimSocket,
      "--remote-expr",
      expr,
    ];

    let result: { stdout: string; stderr: string; exitCode: number | null };
    try {
      result = await this.exec!(args, this.timeoutMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `nvim exec failed: ${message}` };
    }

    // null exitCode means process was killed (timeout)
    if (result.exitCode === null) {
      return { ok: false, error: "nvim RPC timed out" };
    }

    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
      return { ok: false, error: `nvim exited with code ${result.exitCode}: ${detail}` };
    }

    // pigeon.lua dispatch returns base64-encoded JSON
    const raw = result.stdout.trim();
    if (!raw) {
      return { ok: false, error: "nvim returned empty response" };
    }

    let decoded: string;
    try {
      decoded = Buffer.from(raw, "base64").toString("utf-8");
    } catch {
      decoded = raw; // fall through to JSON.parse which will give a clear error
    }

    let response: unknown;
    try {
      response = JSON.parse(decoded);
    } catch {
      return { ok: false, error: `nvim returned invalid JSON: ${raw.slice(0, 200)}` };
    }

    if (
      typeof response === "object"
      && response !== null
      && "ok" in response
    ) {
      const r = response as { ok: boolean; error?: string };
      return {
        ok: r.ok,
        ...(r.error ? { error: r.error } : {}),
        meta: { nvimSocket: session.nvimSocket, ptyPath: session.ptyPath },
      };
    }

    return { ok: false, error: `Unexpected nvim response shape: ${raw.slice(0, 200)}` };
  }
}
