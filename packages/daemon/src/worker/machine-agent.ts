import type { StorageDb } from "../storage/database";
import { ingestWorkerCommand, type WorkerCommandMessage } from "./command-ingest";

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
}

export function buildWorkerWebSocketUrl(workerUrl: string, machineId: string): string {
  return `${workerUrl.replace(/^http/, "ws")}/ws?machineId=${encodeURIComponent(machineId)}`;
}

export class MachineAgent {
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly createWebSocket: (url: string, protocols: string[]) => WebSocket;

  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_BASE_MS;
  private stopped = false;
  private lastPongAt = 0;

  constructor(
    private readonly config: MachineAgentConfig,
    private readonly storage: StorageDb,
    deps: MachineAgentDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.createWebSocket = deps.createWebSocket ?? ((url, protocols) => new WebSocket(url, protocols));
  }

  connect(): void {
    this.stopped = false;
    this.openWebSocket();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close();
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
      this.reconnectDelayMs = RECONNECT_BASE_MS;
      this.lastPongAt = this.now();
      this.startPing();
      this.replayUnfinishedCommands();
    });

    ws.addEventListener("message", async (event) => {
      await this.handleMessage(event.data);
    });

    ws.addEventListener("error", () => {
      this.clearTimers();
      this.ws?.close();
    });

    ws.addEventListener("close", () => {
      this.clearTimers();
      this.ws = null;
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
        this.ws.close();
      }
    }, PING_INTERVAL_MS);

    this.pongTimer = setInterval(() => {
      if (this.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
        this.ws?.close();
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

    if (record.type !== "command") {
      return;
    }

    await ingestWorkerCommand(this.storage, record as unknown as WorkerCommandMessage, {
      send: (payload) => this.send(payload),
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
      return Boolean(payload.ok);
    } catch {
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
      return Boolean(payload.ok);
    } catch {
      return false;
    }
  }

  async sendNotification(
    sessionId: string,
    chatId: string,
    text: string,
    replyMarkup: { inline_keyboard?: unknown[] },
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
        });
      } catch {
        // Ignore malformed payload rows.
      }
    }

    this.storage.inbox.cleanupDone();
  }
}
