import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";
import { startDirectChannelServer } from "../../opencode-plugin/src/direct-channel";

type ParityMode = "legacy" | "direct";
type Json = Record<string, unknown>;

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

function ensureTmuxInstalled(): void {
  const check = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (check.status !== 0) {
    throw new Error("tmux is required for parity harness but was not found");
  }
}

function createTmuxSession(sessionName: string): { paneId: string } {
  const create = spawnSync("tmux", ["new-session", "-d", "-s", sessionName], { encoding: "utf8" });
  if (create.status !== 0) {
    throw new Error(`Failed to create tmux session: ${create.stderr || create.stdout}`);
  }

  const pane = spawnSync("tmux", ["list-panes", "-t", sessionName, "-F", "#{pane_id}"], { encoding: "utf8" });
  if (pane.status !== 0) {
    throw new Error(`Failed to resolve tmux pane: ${pane.stderr || pane.stdout}`);
  }

  const paneId = pane.stdout.trim().split("\n")[0]?.trim();
  if (!paneId) {
    throw new Error("Could not determine tmux pane id");
  }

  return { paneId };
}

function destroyTmuxSession(sessionName: string): void {
  spawnSync("tmux", ["kill-session", "-t", sessionName], { encoding: "utf8" });
}

function paneContains(sessionOrPane: string, needle: string): boolean {
  const out = spawnSync("tmux", ["capture-pane", "-pt", sessionOrPane], { encoding: "utf8" });
  if (out.status !== 0) return false;
  return out.stdout.includes(needle);
}

async function waitForPaneOutput(sessionOrPane: string, needle: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (paneContains(sessionOrPane, needle)) {
      return;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for tmux output marker: ${needle}`);
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
// Mode-specific session setup / verification / cleanup
// ---------------------------------------------------------------------------

interface LegacyResources {
  mode: "legacy";
  tmuxSession: string;
  paneId: string;
}

interface DirectResources {
  mode: "direct";
  server: { endpoint: string; authToken: string; close: () => Promise<void> };
  receivedCommands: string[];
}

type ModeResources = LegacyResources | DirectResources;

function setupLegacyResources(runId: string): LegacyResources {
  ensureTmuxInstalled();
  const tmuxSession = `pigeon-parity-${runId}`;
  const { paneId } = createTmuxSession(tmuxSession);
  return { mode: "legacy", tmuxSession, paneId };
}

async function setupDirectResources(): Promise<DirectResources> {
  const receivedCommands: string[] = [];
  const server = await startDirectChannelServer({
    onExecute: async (req) => {
      receivedCommands.push(req.command);
      return { success: true, exitCode: 0, output: `executed: ${req.command}` };
    },
  });
  return { mode: "direct", server, receivedCommands };
}

function buildSessionStartBody(
  sessionId: string,
  resources: ModeResources,
): Record<string, unknown> {
  const base = { session_id: sessionId, notify: true, label: "Parity Harness Session" };
  if (resources.mode === "legacy") {
    return { ...base, tmux_session: resources.tmuxSession, tmux_pane: resources.tmuxSession };
  }
  return {
    ...base,
    backend_kind: "opencode-plugin-direct",
    backend_protocol_version: 1,
    backend_endpoint: resources.server.endpoint,
    backend_auth_token: resources.server.authToken,
  };
}

async function waitForInjection(
  resources: ModeResources,
  daemonDbPath: string,
  marker: string,
  timeoutMs = 20_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Both modes: check inbox status in daemon DB
    const inbox = inboxCommandStatus(daemonDbPath, marker);
    if (inbox.done > 0) return;

    if (resources.mode === "legacy") {
      if (paneContains(resources.paneId, marker)) return;
    } else {
      if (resources.receivedCommands.some((cmd) => cmd.includes(marker))) return;
    }

    await sleep(250);
  }

  // Timeout — build diagnostic error
  const inbox = inboxCommandStatus(daemonDbPath, marker);
  if (resources.mode === "direct") {
    throw new Error(
      `Timed out waiting for direct-channel command delivery (inbox total=${inbox.total}, done=${inbox.done}, statuses=${inbox.statuses.join(",")}, receivedCommands=${resources.receivedCommands.length})`,
    );
  }
  throw new Error(
    `Timed out waiting for local injection completion (inbox total=${inbox.total}, done=${inbox.done}, statuses=${inbox.statuses.join(",")})`,
  );
}

async function cleanupResources(resources: ModeResources): Promise<void> {
  if (resources.mode === "legacy") {
    destroyTmuxSession(resources.tmuxSession);
  } else {
    await resources.server.close();
  }
}

// ---------------------------------------------------------------------------
// Main harness
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mode: ParityMode = (process.env.PARITY_MODE?.trim() as ParityMode) || "legacy";
  if (mode !== "legacy" && mode !== "direct") {
    throw new Error(`Invalid PARITY_MODE: ${mode} (expected "legacy" or "direct")`);
  }

  const workerUrl = envRequired("CCR_WORKER_URL");
  const workerApiKey = envRequired("CCR_API_KEY");
  const webhookSecret = envRequired("TELEGRAM_WEBHOOK_SECRET");
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() || process.env.TELEGRAM_GROUP_ID?.trim();
  if (!chatId) {
    throw new Error("Missing TELEGRAM_CHAT_ID or TELEGRAM_GROUP_ID for parity harness");
  }

  console.log(`[parity] mode=${mode}`);

  const runId = randomUUID().slice(0, 8);
  const machineId = `pigeon-parity-${runId}`;
  const daemonPort = 4800 + Math.floor(Math.random() * 400);
  const daemonBase = `http://127.0.0.1:${daemonPort}`;
  const workerBase = workerUrl.replace(/\/$/, "");
  const sessionId = `parity-session-${runId}`;
  const marker = `__PIGEON_PARITY_${runId}__`;

  const resources =
    mode === "direct"
      ? await setupDirectResources()
      : setupLegacyResources(runId);

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

    // --- Session registration (mode-specific body) ---
    const startResp = await fetchJson(`${daemonBase}/session-start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildSessionStartBody(sessionId, resources)),
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
    const replyCommand = mode === "direct" ? marker : `printf '${marker}\\n'`;

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
          inline_keyboard: [[{ text: "Continue", callback_data: "cmd:dummy:continue" }]],
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
          text: replyCommand,
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

    // --- Wait for injection (mode-specific verification) ---
    await waitForInjection(resources, daemonDbPath, marker);

    // --- Direct-channel: verify the command was actually received ---
    if (resources.mode === "direct") {
      const markerMatch = resources.receivedCommands.find((cmd) => cmd.includes(marker));
      if (!markerMatch) {
        throw new Error(
          `direct-channel: marker command not received by plugin server (got ${resources.receivedCommands.length} commands: ${JSON.stringify(resources.receivedCommands)})`,
        );
      }
      console.log(`[parity] direct-channel verified: received ${resources.receivedCommands.length} command(s)`);
    }

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

    console.log(`[parity] PASS: end-to-end daemon parity harness completed successfully (mode=${mode})`);
  } finally {
    daemon.kill("SIGTERM");
    await cleanupResources(resources);
  }
}

main().catch((error) => {
  console.error(`[parity] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
