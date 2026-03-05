import { randomUUID } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { startDirectChannelServer } from "../../opencode-plugin/src/direct-channel";

type Json = Record<string, unknown>;
type ParityMode = "direct" | "nvim";

const PROJECT_ROOT = resolve(import.meta.dirname, "../../..");

function envRequired(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // daemon not up yet
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for daemon health: ${url}`);
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
  const response = await fetch(url, init);
  const body = (await response.json()) as Json;
  return { status: response.status, body };
}

function parseWorkerSessions(body: Json): Array<Record<string, unknown>> {
  const asUnknown = body as unknown;
  if (Array.isArray(asUnknown)) {
    return asUnknown.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  }

  const container = body.sessions;
  if (Array.isArray(container)) {
    return container.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  }

  return [];
}

function inboxCommandStatus(dbPath: string, marker: string): { total: number; done: number; statuses: string[] } {
  const db = new BetterSqlite3(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT status, payload FROM inbox ORDER BY received_at DESC")
      .all() as Array<{ status: string; payload: string }>;

    const matching = rows.filter((row) => {
      try {
        const payload = JSON.parse(row.payload) as { command?: unknown };
        return typeof payload.command === "string" && payload.command.includes(marker);
      } catch {
        return false;
      }
    });

    return {
      total: matching.length,
      done: matching.filter((row) => row.status === "done").length,
      statuses: matching.map((row) => row.status),
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Common interface for mode-specific resources
// ---------------------------------------------------------------------------

interface ParityResources {
  mode: ParityMode;
  buildSessionStartBody(sessionId: string): Record<string, unknown>;
  waitForInjection(daemonDbPath: string, marker: string, timeoutMs?: number): Promise<void>;
  verifyInjection(marker: string): void;
  cleanup(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Direct-channel session setup / verification / cleanup
// ---------------------------------------------------------------------------

interface DirectResources extends ParityResources {
  mode: "direct";
  server: { endpoint: string; authToken: string; close: () => Promise<void> };
  receivedCommands: string[];
}

async function setupDirectResources(): Promise<DirectResources> {
  const receivedCommands: string[] = [];
  const server = await startDirectChannelServer({
    onExecute: async (req) => {
      receivedCommands.push(req.command);
      return { success: true, exitCode: 0, output: `executed: ${req.command}` };
    },
  });

  return {
    mode: "direct",
    server,
    receivedCommands,

    buildSessionStartBody(sessionId: string): Record<string, unknown> {
      return {
        session_id: sessionId,
        notify: true,
        label: "Parity Harness Session (direct)",
        backend_kind: "opencode-plugin-direct",
        backend_protocol_version: 1,
        backend_endpoint: server.endpoint,
        backend_auth_token: server.authToken,
      };
    },

    async waitForInjection(daemonDbPath: string, marker: string, timeoutMs = 20_000): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const inbox = inboxCommandStatus(daemonDbPath, marker);
        if (inbox.done > 0) return;

        if (receivedCommands.some((cmd) => cmd.includes(marker))) return;

        await sleep(250);
      }

      const inbox = inboxCommandStatus(daemonDbPath, marker);
      throw new Error(
        `Timed out waiting for direct-channel command delivery (inbox total=${inbox.total}, done=${inbox.done}, statuses=${inbox.statuses.join(",")}, receivedCommands=${receivedCommands.length})`,
      );
    },

    verifyInjection(marker: string): void {
      const markerMatch = receivedCommands.find((cmd) => cmd.includes(marker));
      if (!markerMatch) {
        throw new Error(
          `direct-channel: marker command not received by plugin server (got ${receivedCommands.length} commands: ${JSON.stringify(receivedCommands)})`,
        );
      }
      console.log(`[parity] direct-channel verified: received ${receivedCommands.length} command(s)`);
    },

    async cleanup(): Promise<void> {
      await server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Nvim session setup / verification / cleanup
// ---------------------------------------------------------------------------

interface NvimResources extends ParityResources {
  mode: "nvim";
  nvimProcess: ChildProcess;
  socketPath: string;
  ptyPath: string;
}

/**
 * Send a pigeon.lua RPC dispatch call to the headless nvim instance.
 * Returns the parsed JSON response from pigeon.dispatch.
 */
function nvimRpcDispatch(socketPath: string, payload: Record<string, unknown>): Record<string, unknown> {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  const expr = `luaeval('require("pigeon").dispatch(_A)', '${encoded}')`;
  const stdout = execFileSync("nvim", [
    "--headless",
    "--server", socketPath,
    "--remote-expr", expr,
  ], { timeout: 10_000, encoding: "utf-8" }).trim();

  if (!stdout) {
    throw new Error("nvim RPC returned empty response");
  }

  // pigeon.dispatch returns base64-encoded JSON
  let decoded: string;
  try {
    decoded = Buffer.from(stdout, "base64").toString("utf-8");
  } catch {
    throw new Error(`nvim RPC returned non-base64 response: ${stdout.slice(0, 200)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error(`nvim RPC returned invalid JSON: ${decoded.slice(0, 200)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`nvim RPC returned non-object: ${decoded.slice(0, 200)}`);
  }

  return parsed as Record<string, unknown>;
}

async function setupNvimResources(runId: string): Promise<NvimResources> {
  const socketPath = `/tmp/pigeon-parity-nvim-${runId}.sock`;
  const nvimPluginDir = resolve(PROJECT_ROOT, "packages/nvim-plugin");

  // Clean up stale socket if it exists
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  // Start headless nvim with pigeon.lua loaded
  const nvimProcess = spawn("nvim", [
    "--headless",
    "--listen", socketPath,
    "--cmd", `set runtimepath+=${nvimPluginDir}`,
    "-c", `lua require("pigeon").setup()`,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  nvimProcess.on("error", (error) => {
    console.error(`[nvim] failed to spawn: ${error.message}`);
  });

  nvimProcess.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[nvim] ${chunk}`);
  });
  nvimProcess.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[nvim] ${chunk}`);
  });

  // Wait for the nvim socket to appear
  const socketStart = Date.now();
  while (Date.now() - socketStart < 10_000) {
    if (existsSync(socketPath)) break;
    await sleep(100);
  }
  if (!existsSync(socketPath)) {
    nvimProcess.kill("SIGTERM");
    throw new Error(`nvim socket never appeared at ${socketPath}`);
  }
  // Extra grace period for nvim to finish initialization
  await sleep(500);

  // Open a terminal buffer in nvim — this creates a PTY that pigeon.lua auto-registers
  execFileSync("nvim", [
    "--headless",
    "--server", socketPath,
    "--remote-send", ":terminal<CR>",
  ], { timeout: 5_000 });

  // Wait for the terminal buffer to be created and auto-registered
  await sleep(1500);

  // Query pigeon.lua for the registered PTY via the list RPC
  const listResp = nvimRpcDispatch(socketPath, { type: "list" });
  if (!listResp.ok) {
    nvimProcess.kill("SIGTERM");
    throw new Error(`nvim pigeon list failed: ${JSON.stringify(listResp)}`);
  }

  const instances = listResp.instances;
  if (!Array.isArray(instances) || instances.length === 0) {
    nvimProcess.kill("SIGTERM");
    throw new Error("nvim pigeon has no registered instances after opening terminal buffer");
  }

  // Find the instance — auto-registered instances use the PTY path as their name
  const instance = instances[0] as Record<string, unknown>;
  const ptyPath = String(instance.name || "");
  if (!ptyPath || !ptyPath.startsWith("/dev/")) {
    nvimProcess.kill("SIGTERM");
    throw new Error(`nvim pigeon instance has unexpected name (expected PTY path): ${JSON.stringify(instance)}`);
  }

  console.log(`[parity] nvim: socket=${socketPath} pty=${ptyPath}`);

  return {
    mode: "nvim",
    nvimProcess,
    socketPath,
    ptyPath,

    buildSessionStartBody(sessionId: string): Record<string, unknown> {
      return {
        session_id: sessionId,
        notify: true,
        label: "Parity Harness Session (nvim)",
        nvim_socket: socketPath,
        tty: ptyPath,
      };
    },

    async waitForInjection(daemonDbPath: string, marker: string, timeoutMs = 20_000): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const inbox = inboxCommandStatus(daemonDbPath, marker);
        if (inbox.done > 0) return;
        await sleep(250);
      }

      const inbox = inboxCommandStatus(daemonDbPath, marker);
      throw new Error(
        `Timed out waiting for nvim command delivery (inbox total=${inbox.total}, done=${inbox.done}, statuses=${inbox.statuses.join(",")})`,
      );
    },

    verifyInjection(marker: string): void {
      // Verify via list that pigeon.lua is still live
      const listResult = nvimRpcDispatch(socketPath, { type: "list" });
      if (!listResult.ok) {
        throw new Error(`nvim pigeon list failed during verify: ${JSON.stringify(listResult)}`);
      }
      const verifyInstances = listResult.instances;
      if (!Array.isArray(verifyInstances) || verifyInstances.length === 0) {
        throw new Error("nvim pigeon has no registered instances during verify");
      }

      // Use tail RPC to check the terminal buffer output for the marker
      const tailResult = nvimRpcDispatch(socketPath, { type: "tail", name: ptyPath, lines: 100 });
      if (!tailResult.ok) {
        throw new Error(`nvim pigeon tail failed: ${JSON.stringify(tailResult)}`);
      }
      const output = String(tailResult.output || "");
      if (!output.includes(marker)) {
        throw new Error(
          `nvim: marker not found in terminal buffer output (got ${output.length} chars). Last 200 chars: ${output.slice(-200)}`,
        );
      }
      console.log("[parity] nvim verified: marker found in terminal buffer output via pigeon tail RPC");
    },

    async cleanup(): Promise<void> {
      nvimProcess.kill("SIGTERM");
      // Give nvim a moment to exit
      await sleep(500);
      if (existsSync(socketPath)) {
        try { unlinkSync(socketPath); } catch { /* ignore */ }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Main harness
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const workerUrl = envRequired("CCR_WORKER_URL");
  const workerApiKey = envRequired("CCR_API_KEY");
  const webhookSecret = envRequired("TELEGRAM_WEBHOOK_SECRET");
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() || process.env.TELEGRAM_GROUP_ID?.trim();
  if (!chatId) {
    throw new Error("Missing TELEGRAM_CHAT_ID or TELEGRAM_GROUP_ID for parity harness");
  }

  const mode: ParityMode = (process.env.PARITY_MODE?.trim() as ParityMode) || "direct";
  if (mode !== "direct" && mode !== "nvim") {
    throw new Error(`Invalid PARITY_MODE: ${mode} (expected "direct" or "nvim")`);
  }

  console.log(`[parity] mode=${mode}`);

  const runId = randomUUID().slice(0, 8);
  const machineId = `pigeon-parity-${runId}`;
  const daemonPort = 4800 + Math.floor(Math.random() * 400);
  const daemonBase = `http://127.0.0.1:${daemonPort}`;
  const workerBase = workerUrl.replace(/\/$/, "");
  const sessionId = `parity-session-${runId}`;
  const marker = `__PIGEON_PARITY_${runId}__`;

  const resources: ParityResources = mode === "direct"
    ? await setupDirectResources()
    : await setupNvimResources(runId);

  const daemonEnv = {
    ...process.env,
    PIGEON_DAEMON_PORT: String(daemonPort),
    PIGEON_DAEMON_DB_PATH: `/tmp/pigeon-daemon-parity-${runId}.db`,
    CCR_WORKER_URL: workerBase,
    CCR_API_KEY: workerApiKey,
    CCR_MACHINE_ID: machineId,
    TELEGRAM_CHAT_ID: chatId,
  };
  const daemonDbPath = String(daemonEnv.PIGEON_DAEMON_DB_PATH);

  const daemon = spawn("tsx", ["src/index.ts"], {
    cwd: "/home/dev/projects/pigeon/packages/daemon",
    env: daemonEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  daemon.on("error", (error) => {
    console.error(`[daemon] failed to spawn: ${error.message}`);
  });

  daemon.stdout.on("data", (chunk) => {
    process.stdout.write(`[daemon] ${chunk}`);
  });
  daemon.stderr.on("data", (chunk) => {
    process.stderr.write(`[daemon] ${chunk}`);
  });

  try {
    await waitForHealth(`${daemonBase}/health`);

    // --- Session registration ---
    const startResp = await fetchJson(`${daemonBase}/session-start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(resources.buildSessionStartBody(sessionId)),
    });
    if (startResp.status !== 200) {
      throw new Error(`session-start failed: ${startResp.status} ${JSON.stringify(startResp.body)}`);
    }

    // --- Verify worker registration ---
    await sleep(1200);
    const sessionsResp = await fetchJson(`${workerBase}/sessions`, {
      headers: { Authorization: `Bearer ${workerApiKey}` },
    });
    if (sessionsResp.status !== 200) {
      throw new Error(`worker /sessions failed: ${sessionsResp.status}`);
    }
    const sessions = parseWorkerSessions(sessionsResp.body);
    const found = sessions.some((s) => s.sessionId === sessionId || s.session_id === sessionId);
    if (!found) {
      throw new Error("session not registered in worker after session-start");
    }

    // --- Stop notification ---
    const stopResp = await fetchJson(`${daemonBase}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        event: "Stop",
        message: `Parity stop ${runId}`,
      }),
    });
    if (stopResp.status !== 200 || stopResp.body.notified !== true) {
      throw new Error(`/stop failed parity expectation: ${stopResp.status} ${JSON.stringify(stopResp.body)}`);
    }

    // --- Send notification via worker ---
    const notifyResp = await fetchJson(`${workerBase}/notifications/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${workerApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId,
        chatId,
        text: `Parity injection test ${runId}`,
        replyMarkup: {
          inline_keyboard: [],
        },
      }),
    });

    if (notifyResp.status !== 200 || notifyResp.body.ok !== true) {
      throw new Error(`worker notifications/send failed: ${notifyResp.status} ${JSON.stringify(notifyResp.body)}`);
    }

    const messageId = Number(notifyResp.body.messageId);
    const token = String(notifyResp.body.token || "");
    if (!messageId || !token) {
      throw new Error(`worker notifications/send missing messageId/token: ${JSON.stringify(notifyResp.body)}`);
    }

    // --- Simulate Telegram text reply webhook ---
    const replyUpdateId = Number(`91${Date.now().toString().slice(-8)}`);
    const replyResp = await fetch(`${workerBase}/webhook/telegram/parity-harness`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
      },
      body: JSON.stringify({
        update_id: replyUpdateId,
        message: {
          message_id: 700001,
          from: { id: Number(chatId) },
          chat: { id: Number(chatId) },
          text: marker,
          reply_to_message: { message_id: messageId },
        },
      }),
    });
    if (replyResp.status !== 200) {
      throw new Error(`reply webhook failed: HTTP ${replyResp.status}`);
    }

    // --- Simulate Telegram callback query webhook ---
    const callbackResp = await fetch(`${workerBase}/webhook/telegram/parity-harness`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
      },
      body: JSON.stringify({
        update_id: replyUpdateId + 1,
        callback_query: {
          id: `cb-${runId}`,
          from: { id: Number(chatId) },
          data: `cmd:${token}:continue`,
          message: {
            message_id: messageId,
            chat: { id: Number(chatId) },
          },
        },
      }),
    });
    if (callbackResp.status !== 200) {
      throw new Error(`callback webhook failed: HTTP ${callbackResp.status}`);
    }

    // --- Wait for injection ---
    await resources.waitForInjection(daemonDbPath, marker);

    // --- Verify the command was actually received ---
    resources.verifyInjection(marker);

    // --- Session cleanup ---
    const unregisterResp = await fetchJson(`${daemonBase}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    if (unregisterResp.status !== 200) {
      throw new Error(`daemon session delete failed: ${unregisterResp.status}`);
    }

    await sleep(1000);
    const sessionsAfterResp = await fetchJson(`${workerBase}/sessions`, {
      headers: { Authorization: `Bearer ${workerApiKey}` },
    });
    const sessionsAfter = parseWorkerSessions(sessionsAfterResp.body);
    const stillPresent = sessionsAfter.some((s) => s.sessionId === sessionId || s.session_id === sessionId);
    if (stillPresent) {
      throw new Error("session still present in worker after daemon delete/unregister");
    }

    console.log(`[parity] PASS: end-to-end daemon parity harness (mode=${mode}) completed successfully`);
  } finally {
    daemon.kill("SIGTERM");
    await resources.cleanup();
  }
}

main().catch((error) => {
  console.error(`[parity] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
