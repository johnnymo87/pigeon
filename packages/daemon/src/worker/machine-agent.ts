import type { OpencodeClient } from "../opencode-client";
import type { StorageDb } from "../storage/database";
import { ingestWorkerCommand, type WorkerCommandMessage } from "./command-ingest";
import { ingestKillCommand } from "./kill-ingest";
import { ingestLaunchCommand } from "./launch-ingest";

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 90_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface MachineAgentConfig {
  workerUrl: string;
  apiKey: string;
  machineId: string;
  chatId?: string;
}

export interface MachineAgentDeps {
  now?: () => number;
  fetchFn?: typeof fetch;
  createWebSocket?: (url: string, protocols: string[]) => WebSocket;
  opencodeClient?: OpencodeClient;
  sendTelegramMessage?: (chatId: string, text: string) => Promise<void>;
}

export function buildWorkerWebSocketUrl(workerUrl: string, machineId: string): string {
  return `${workerUrl.replace(/^http/, "ws")}/ws?machineId=${encodeURIComponent(machineId)}`;
}

export class MachineAgent {
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly createWebSocket: (url: string, protocols: string[]) => WebSocket;
  private readonly opencodeClient: OpencodeClient | undefined;
  private readonly sendTelegramMessage: ((chatId: string, text: string) => Promise<void>) | undefined;

  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_BASE_MS;
  private stopped = false;
  private lastPongAt = 0;
  private openedAt = 0;
  private closeCause: string | null = null;
  private bootId: string | null = null;

  constructor(
    private readonly config: MachineAgentConfig,
    private readonly storage: StorageDb,
    deps: MachineAgentDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.createWebSocket = deps.createWebSocket ?? ((url, protocols) => new WebSocket(url, protocols));
    this.opencodeClient = deps.opencodeClient;
    this.sendTelegramMessage = deps.sendTelegramMessage;
  }

  connect(): void {
    this.stopped = false;
    this.openWebSocket();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      this.closeCause = "stopped";
      this.ws.close();
    }
    this.ws = null;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private openWebSocket(): void {
    const wsUrl = buildWorkerWebSocketUrl(this.config.workerUrl, this.config.machineId);
    const ws = this.createWebSocket(wsUrl, ["ccr", this.config.apiKey]);
    this.ws = ws;

    ws.addEventListener("open", () => {
      console.log(`[machine-agent] connected machineId=${this.config.machineId}`);
      this.reconnectDelayMs = RECONNECT_BASE_MS;
      this.lastPongAt = this.now();
      this.openedAt = this.now();
      this.closeCause = null;
      this.startPing();
      this.replayUnfinishedCommands();
    });

    ws.addEventListener("message", async (event) => {
      await this.handleMessage(event.data);
    });

    ws.addEventListener("error", () => {
      console.warn(`[machine-agent] websocket error machineId=${this.config.machineId} ageMs=${this.now() - this.openedAt}`);
      this.clearTimers();
      this.ws?.close();
    });

    ws.addEventListener("close", (event) => {
      const ageMs = this.now() - this.openedAt;
      const lastPongAgeMs = this.now() - this.lastPongAt;
      const ev = event as { code: number; reason: string; wasClean: boolean };
      console.warn(`[machine-agent] websocket closed code=${ev.code} reason=${ev.reason} wasClean=${ev.wasClean} ageMs=${ageMs} lastPongAgeMs=${lastPongAgeMs} cause=${this.closeCause ?? "remote"} bootId=${this.bootId ?? "?"}`);
      this.clearTimers();
      this.ws = null;
      this.closeCause = null;
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
  }

  private startPing(): void {
    this.clearPingTimers();

    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      this.ws.send(JSON.stringify({ type: "ping" }));

      if (this.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
        this.closeCause = "heartbeat-timeout";
        this.ws.close(4001, "heartbeat-timeout");
      }
    }, PING_INTERVAL_MS);

    this.pongTimer = setInterval(() => {
      if (this.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
        this.closeCause = "heartbeat-timeout";
        this.ws?.close(4001, "heartbeat-timeout");
      }
    }, 5_000);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) {
        this.openWebSocket();
      }
    }, this.reconnectDelayMs);

    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
  }

  private clearTimers(): void {
    this.clearPingTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearPingTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearInterval(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }

  async handleMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "string") {
      return;
    }

    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (!msg || typeof msg !== "object") {
      return;
    }

    const record = msg as Record<string, unknown>;
    if (record.type === "pong") {
      this.lastPongAt = this.now();
      return;
    }

    if (record.type === "boot") {
      const newBootId = typeof record.bootId === "string" ? record.bootId : null;
      const changed = this.bootId !== null && this.bootId !== newBootId;
      console.log(`[machine-agent] boot bootId=${newBootId} prevBootId=${this.bootId} changed=${changed}`);
      this.bootId = newBootId;
      return;
    }

    if (record.type === "heartbeat-ack") {
      this.lastPongAt = this.now();
      return;
    }

    if (record.type === "launch") {
      const { commandId, directory, prompt, chatId } = record as Record<string, unknown>;
      if (
        typeof commandId !== "string"
        || typeof directory !== "string"
        || typeof prompt !== "string"
        || typeof chatId !== "string"
      ) {
        console.warn("[machine-agent] received malformed launch message");
        return;
      }

      if (!this.opencodeClient) {
        console.warn("[machine-agent] received launch command but no opencodeClient is configured");
        return;
      }

      console.log(`[machine-agent] received launch commandId=${commandId}`);

      await ingestLaunchCommand({
        commandId,
        directory,
        prompt,
        chatId,
        machineId: this.config.machineId,
        opencodeClient: this.opencodeClient,
        sendTelegramReply: async (replyTo, text) => {
          if (this.sendTelegramMessage) {
            await this.sendTelegramMessage(replyTo, text);
          } else {
            console.warn("[machine-agent] sendTelegramMessage not configured, cannot reply:", text);
          }
        },
        sendAck: (id) => this.send({ type: "ack", commandId: id }),
      });
      return;
    }

    if (record.type === "kill") {
      const { commandId, sessionId, chatId } = record as Record<string, unknown>;
      if (
        typeof commandId !== "string"
        || typeof sessionId !== "string"
        || typeof chatId !== "string"
      ) {
        console.warn("[machine-agent] received malformed kill message");
        return;
      }

      if (!this.opencodeClient) {
        console.warn("[machine-agent] received kill command but no opencodeClient is configured");
        return;
      }

      console.log(`[machine-agent] received kill commandId=${commandId}`);

      await ingestKillCommand({
        commandId,
        sessionId,
        chatId,
        machineId: this.config.machineId,
        opencodeClient: this.opencodeClient,
        sendTelegramReply: async (replyTo, text) => {
          if (this.sendTelegramMessage) {
            await this.sendTelegramMessage(replyTo, text);
          } else {
            console.warn("[machine-agent] sendTelegramMessage not configured, cannot reply:", text);
          }
        },
        sendAck: (id) => this.send({ type: "ack", commandId: id }),
      });
      return;
    }

    if (record.type !== "command") {
      return;
    }

    console.log(`[machine-agent] received command id=${String(record.commandId ?? record.id ?? "<none>")}`);

    await ingestWorkerCommand(this.storage, record as unknown as WorkerCommandMessage, {
      send: (payload) => this.send(payload),
    }, {
      workerUrl: this.config.workerUrl,
      apiKey: this.config.apiKey,
      fetchFn: this.fetchFn,
    });
  }

  async registerSession(sessionId: string, label?: string): Promise<boolean> {
    try {
      const response = await this.fetchFn(`${this.config.workerUrl}/sessions/register`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId,
          machineId: this.config.machineId,
          ...(label ? { label } : {}),
        }),
      });
      const payload = await response.json() as { ok?: boolean };
      const ok = Boolean(payload.ok);
      console.log(`[machine-agent] registerSession sessionId=${sessionId} ok=${ok}`);
      return ok;
    } catch {
      console.warn(`[machine-agent] registerSession failed sessionId=${sessionId}`);
      return false;
    }
  }

  async unregisterSession(sessionId: string): Promise<boolean> {
    try {
      const response = await this.fetchFn(`${this.config.workerUrl}/sessions/unregister`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionId }),
      });
      const payload = await response.json() as { ok?: boolean };
      const ok = Boolean(payload.ok);
      console.log(`[machine-agent] unregisterSession sessionId=${sessionId} ok=${ok}`);
      return ok;
    } catch {
      console.warn(`[machine-agent] unregisterSession failed sessionId=${sessionId}`);
      return false;
    }
  }

  async uploadMedia(
    key: string,
    data: ArrayBuffer,
    mime: string,
    filename: string,
  ): Promise<{ ok: boolean; key: string }> {
    try {
      const form = new FormData();
      form.append("key", key);
      form.append("mime", mime);
      form.append("filename", filename);
      form.append("file", new Blob([data], { type: mime }), filename);

      const response = await this.fetchFn(`${this.config.workerUrl}/media/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        body: form,
      });
      return await response.json() as { ok: boolean; key: string };
    } catch {
      return { ok: false, key: "" };
    }
  }

  async sendNotification(
    sessionId: string,
    chatId: string,
    text: string,
    replyMarkup: { inline_keyboard?: unknown[] },
    media?: Array<{ key: string; mime: string; filename: string }>,
  ): Promise<{ ok: boolean }> {
    try {
      const response = await this.fetchFn(`${this.config.workerUrl}/notifications/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId,
          chatId,
          text,
          replyMarkup,
          ...(media && media.length > 0 ? { media } : {}),
        }),
      });
      return await response.json() as { ok: boolean };
    } catch {
      return { ok: false };
    }
  }

  getConfiguredChatId(): string | undefined {
    return this.config.chatId;
  }

  private async replayUnfinishedCommands(): Promise<void> {
    const unfinished = this.storage.inbox.listUnfinished(100);
    for (const row of unfinished) {
      try {
        const parsed = JSON.parse(row.payload) as WorkerCommandMessage;
        await ingestWorkerCommand(this.storage, parsed, {
          send: (payload) => this.send(payload),
        }, {
          workerUrl: this.config.workerUrl,
          apiKey: this.config.apiKey,
          fetchFn: this.fetchFn,
        });
      } catch {
        // Ignore malformed payload rows.
      }
    }

    this.storage.inbox.cleanupDone();
  }
}
