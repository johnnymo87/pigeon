/**
 * HTTP Poller — replaces MachineAgent WebSocket lifecycle.
 *
 * Polls GET /machines/:id/next every N ms, dispatches commands to
 * callbacks, and acks via POST /commands/:id/ack after successful dispatch.
 */

export interface PollerConfig {
  workerUrl: string;
  apiKey: string;
  machineId: string;
  chatId?: string;
  /** Default 5000 ms */
  pollIntervalMs?: number;
}

export interface ExecuteMessage {
  commandId: string;
  commandType: "execute";
  sessionId: string;
  command: string;
  chatId: string;
  media?: { key: string; mime: string; filename: string; size: number };
}

export interface LaunchMessage {
  commandId: string;
  commandType: "launch";
  directory: string;
  prompt: string;
  chatId: string;
}

export interface KillMessage {
  commandId: string;
  commandType: "kill";
  sessionId: string;
  chatId: string;
}

export interface CompactMessage {
  commandId: string;
  commandType: "compact";
  sessionId: string;
  chatId: string;
}

export type WorkerMessage = ExecuteMessage | LaunchMessage | KillMessage | CompactMessage;

export interface PollerCallbacks {
  onCommand: (msg: ExecuteMessage) => Promise<void>;
  onLaunch: (msg: LaunchMessage) => Promise<void>;
  onKill: (msg: KillMessage) => Promise<void>;
  onCompact: (msg: CompactMessage) => Promise<void>;
}

export interface PollerDeps {
  fetchFn?: typeof fetch;
}

export class Poller {
  private readonly fetchFn: typeof fetch;
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    private readonly config: PollerConfig,
    private readonly callbacks: PollerCallbacks,
    deps: PollerDeps = {},
  ) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.pollIntervalMs = config.pollIntervalMs ?? 5000;
  }

  /** Start polling — calls tick() immediately, then every pollIntervalMs. */
  start(): void {
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  /** Stop polling and clear the interval. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Poll once — guarded against overlapping polls. */
  private async tick(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const msg = await this.poll();
      if (msg === null) {
        return;
      }
      await this.dispatch(msg);
    } catch (err) {
      console.warn("[poller] tick error:", err instanceof Error ? err.message : String(err));
    } finally {
      this.polling = false;
    }
  }

  /** Fetch the next command from the worker. Returns null on 204 (no commands). */
  async poll(): Promise<WorkerMessage | null> {
    const url = `${this.config.workerUrl}/machines/${encodeURIComponent(this.config.machineId)}/next`;
    const response = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });

    if (response.status === 204) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Poll failed: ${response.status}`);
    }

    return await response.json() as WorkerMessage;
  }

  /** Send a command ack to the worker. */
  async ack(commandId: string): Promise<void> {
    const url = `${this.config.workerUrl}/commands/${encodeURIComponent(commandId)}/ack`;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });

    if (!response.ok) {
      throw new Error(`Ack failed for ${commandId}: ${response.status}`);
    }
  }

  /** Dispatch a message to the appropriate callback and ack on success. */
  private async dispatch(msg: WorkerMessage): Promise<void> {
    try {
      if (msg.commandType === "execute") {
        await this.callbacks.onCommand(msg);
      } else if (msg.commandType === "launch") {
        await this.callbacks.onLaunch(msg);
      } else if (msg.commandType === "kill") {
        await this.callbacks.onKill(msg);
      } else if (msg.commandType === "compact") {
        await this.callbacks.onCompact(msg);
      } else {
        console.warn("[poller] unknown commandType:", (msg as WorkerMessage & { commandType: string }).commandType);
        return;
      }
    } catch (err) {
      // Callback threw — skip ack so the lease expires and command retries
      console.warn("[poller] dispatch error (skipping ack) commandId=%s:", msg.commandId, err instanceof Error ? err.message : String(err));
      return;
    }

    // Dispatch succeeded — ack
    try {
      await this.ack(msg.commandId);
    } catch (err) {
      console.warn("[poller] ack error commandId=%s:", msg.commandId, err instanceof Error ? err.message : String(err));
    }
  }

  // -------------------------------------------------------------------------
  // HTTP methods preserved from MachineAgent (already HTTP)
  // -------------------------------------------------------------------------

  async registerSession(sessionId: string, label?: string): Promise<void> {
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
      console.log(`[poller] registerSession sessionId=${sessionId} ok=${Boolean(payload.ok)}`);
    } catch {
      console.warn(`[poller] registerSession failed sessionId=${sessionId}`);
    }
  }

  async unregisterSession(sessionId: string): Promise<void> {
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
      console.log(`[poller] unregisterSession sessionId=${sessionId} ok=${Boolean(payload.ok)}`);
    } catch {
      console.warn(`[poller] unregisterSession failed sessionId=${sessionId}`);
    }
  }

  async sendNotification(
    sessionId: string,
    chatId: string,
    text: string,
    replyMarkup: { inline_keyboard?: unknown[] },
    media?: Array<{ key: string; mime: string; filename: string }>,
    notificationId?: string,
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
          ...(notificationId ? { notificationId } : {}),
        }),
      });
      return await response.json() as { ok: boolean };
    } catch {
      return { ok: false };
    }
  }

  async uploadMedia(
    key: string,
    data: Uint8Array | ArrayBuffer,
    mime: string,
    filename: string,
  ): Promise<{ ok: boolean; key: string }> {
    try {
      const form = new FormData();
      form.append("key", key);
      form.append("mime", mime);
      form.append("filename", filename);
      const buffer = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      form.append("file", new Blob([buffer], { type: mime }), filename);

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

  /** Returns the chatId from config (used by WorkerNotificationService). */
  getConfiguredChatId(): string | undefined {
    return this.config.chatId;
  }
}
