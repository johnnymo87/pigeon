/**
 * HTTP Poller — replaces MachineAgent WebSocket lifecycle.
 *
 * Polls GET /machines/:id/next every N ms, dispatches commands to
 * callbacks, and acks via POST /commands/:id/ack after successful dispatch.
 */

export interface SendNotificationInput {
  sessionId: string;
  chatId: string;
  text: string;
  replyMarkup: unknown;
  media?: Array<{ key: string; mime: string; filename: string }>;
  notificationId?: string;
  entities?: unknown[];
  title?: string;
  dir?: string;
  threaded?: boolean;
}

export type WorkerResultSuccess<T = unknown> = {
  ok: true;
  kind: "success";
  status: number;
  body: T;
  retryAfter?: number;
};

export type WorkerResultAppRejection<T = unknown> = {
  ok: false;
  kind: "app_rejection";
  status: number;
  body: T;
  retryAfter?: number;
};

export type WorkerResultHttpError = {
  ok: false;
  kind: "http_error";
  status: number;
  body?: unknown;
  retryAfter?: number;
};

export type WorkerResultTransportError = {
  ok: false;
  kind: "transport_error";
  error: string;
  cause?: unknown;
  retryAfter?: undefined;
};

export type WorkerResult<T = unknown> =
  | WorkerResultSuccess<T>
  | WorkerResultAppRejection<T>
  | WorkerResultHttpError
  | WorkerResultTransportError;

function extractRetryAfter(response: Response, body: unknown): number | undefined {
  if (body && typeof body === "object" && "retryAfter" in body) {
    const val = (body as { retryAfter?: unknown }).retryAfter;
    if (typeof val === "number" && Number.isFinite(val) && val > 0) {
      return val;
    }
  }
  const headerVal = response.headers?.get?.("retry-after");
  if (headerVal) {
    const parsed = Number(headerVal);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

async function safeExecuteWorkerFetch<T = unknown>(
  fetchCall: () => Promise<Response>,
): Promise<WorkerResult<T>> {
  let response: Response;
  try {
    response = await fetchCall();
  } catch (err) {
    return {
      ok: false,
      kind: "transport_error",
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof Error && err.cause !== undefined ? { cause: err.cause } : {}),
    };
  }

  let body: unknown;
  try {
    const rawText = await response.text();
    if (rawText.trim().length > 0) {
      try {
        body = JSON.parse(rawText);
      } catch {
        body = rawText;
      }
    }
  } catch {
    body = undefined;
  }

  const retryAfter = extractRetryAfter(response, body);

  if (response.ok) {
    if (body && typeof body === "object" && "ok" in body && (body as { ok?: boolean }).ok === false) {
      return {
        ok: false,
        kind: "app_rejection",
        status: response.status,
        body: body as T,
        ...(retryAfter !== undefined ? { retryAfter } : {}),
      };
    }
    return {
      ok: true,
      kind: "success",
      status: response.status,
      body: body as T,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    };
  }

  return {
    ok: false,
    kind: "http_error",
    status: response.status,
    ...(body !== undefined ? { body } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  };
}

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
  messageThreadId?: number;
  media?: { key: string; mime: string; filename: string; size: number };
  metadata?: { questionRequestId?: string };
}

export interface LaunchMessage {
  commandId: string;
  commandType: "launch";
  directory: string;
  prompt: string;
  chatId: string;
  messageThreadId?: number;
}

export interface KillMessage {
  commandId: string;
  commandType: "kill";
  sessionId: string;
  chatId: string;
  messageThreadId?: number;
}

export interface InterruptMessage {
  commandId: string;
  commandType: "interrupt";
  sessionId: string;
  chatId: string;
  messageThreadId?: number;
}

export interface CompactMessage {
  commandId: string;
  commandType: "compact";
  sessionId: string;
  chatId: string;
  messageThreadId?: number;
}

export interface McpListMessage {
  commandId: string;
  commandType: "mcp_list";
  sessionId: string;
  chatId: string;
  messageThreadId?: number;
}

export interface McpEnableMessage {
  commandId: string;
  commandType: "mcp_enable";
  sessionId: string;
  chatId: string;
  serverName: string;
  messageThreadId?: number;
}

export interface McpDisableMessage {
  commandId: string;
  commandType: "mcp_disable";
  sessionId: string;
  chatId: string;
  serverName: string;
  messageThreadId?: number;
}

export interface ModelListMessage {
  commandId: string;
  commandType: "model_list";
  sessionId: string;
  chatId: string;
  messageThreadId?: number;
}

export interface ModelSetMessage {
  commandId: string;
  commandType: "model_set";
  sessionId: string;
  chatId: string;
  model: string;
  messageThreadId?: number;
}

export type WorkerMessage =
  | ExecuteMessage
  | LaunchMessage
  | KillMessage
  | InterruptMessage
  | CompactMessage
  | McpListMessage
  | McpEnableMessage
  | McpDisableMessage
  | ModelListMessage
  | ModelSetMessage;

export interface PollerCallbacks {
  onCommand: (msg: ExecuteMessage) => Promise<void>;
  onLaunch: (msg: LaunchMessage) => Promise<void>;
  onKill: (msg: KillMessage) => Promise<void>;
  onInterrupt: (msg: InterruptMessage) => Promise<void>;
  onCompact: (msg: CompactMessage) => Promise<void>;
  onMcpList: (msg: McpListMessage) => Promise<void>;
  onMcpEnable: (msg: McpEnableMessage) => Promise<void>;
  onMcpDisable: (msg: McpDisableMessage) => Promise<void>;
  onModelList: (msg: ModelListMessage) => Promise<void>;
  onModelSet: (msg: ModelSetMessage) => Promise<void>;
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
      } else if (msg.commandType === "interrupt") {
        await this.callbacks.onInterrupt(msg);
      } else if (msg.commandType === "compact") {
        await this.callbacks.onCompact(msg);
      } else if (msg.commandType === "mcp_list") {
        await this.callbacks.onMcpList(msg);
      } else if (msg.commandType === "mcp_enable") {
        await this.callbacks.onMcpEnable(msg);
      } else if (msg.commandType === "mcp_disable") {
        await this.callbacks.onMcpDisable(msg);
      } else if (msg.commandType === "model_list") {
        await this.callbacks.onModelList(msg);
      } else if (msg.commandType === "model_set") {
        await this.callbacks.onModelSet(msg);
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

  async registerSession(sessionId: string, label?: string): Promise<WorkerResult> {
    const result = await safeExecuteWorkerFetch(() =>
      this.fetchFn(`${this.config.workerUrl}/sessions/register`, {
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
      }),
    );
    if (result.ok) {
      console.log(`[poller] registerSession sessionId=${sessionId} ok=true`);
    } else {
      const detail = result.kind === "transport_error" ? result.error : `status=${result.status}`;
      console.warn(`[poller] registerSession failed sessionId=${sessionId} kind=${result.kind} ${detail}`);
    }
    return result;
  }

  /**
   * Unregister a session worker-side.
   *
   * Returns a WorkerResult so callers that MUST know whether the row is really gone can check.
   * The outbox's compensating unregister is one such caller: when a lazy re-registration races the
   * reaper, the outbox has just recreated a worker row that nothing else will ever remove (the
   * reaper only unregisters sessions it still holds locally, and the worker has no session TTL
   * cron). A silently-swallowed failure there leaks that row permanently.
   *
   * Existing callers that ignore the return value keep their previous best-effort behaviour.
   */
  async unregisterSession(sessionId: string): Promise<WorkerResult> {
    const result = await safeExecuteWorkerFetch(() =>
      this.fetchFn(`${this.config.workerUrl}/sessions/unregister`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionId }),
      }),
    );
    if (result.ok) {
      console.log(`[poller] unregisterSession sessionId=${sessionId} ok=true`);
    } else {
      const detail = result.kind === "transport_error" ? result.error : `status=${result.status}`;
      console.warn(`[poller] unregisterSession failed sessionId=${sessionId} kind=${result.kind} ${detail}`);
    }
    return result;
  }

  async sendNotification(
    input: SendNotificationInput,
  ): Promise<WorkerResult> {
    const { sessionId, chatId, text, replyMarkup, media, notificationId, entities, title, dir, threaded } = input;
    return safeExecuteWorkerFetch(() =>
      this.fetchFn(`${this.config.workerUrl}/notifications/send`, {
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
          ...(entities && entities.length > 0 ? { entities } : {}),
          ...(title ? { title } : {}),
          ...(dir ? { dir } : {}),
          ...(threaded !== undefined ? { threaded } : {}),
        }),
      }),
    );
  }

  async editNotification(
    notificationId: string,
    text: string,
    replyMarkup: { inline_keyboard?: unknown[] },
    entities?: unknown[],
  ): Promise<{ ok: boolean }> {
    try {
      const response = await this.fetchFn(`${this.config.workerUrl}/notifications/edit`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          notificationId,
          text,
          replyMarkup,
          ...(entities && entities.length > 0 ? { entities } : {}),
        }),
      });
      return await response.json() as { ok: boolean };
    } catch (err) {
      console.warn(`[poller] editNotification failed notificationId=${notificationId}:`, err instanceof Error ? err.message : String(err));
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
    } catch (err) {
      console.warn(`[poller] uploadMedia failed key=${key}:`, err instanceof Error ? err.message : String(err));
      return { ok: false, key: "" };
    }
  }

  /** Returns the chatId from config. */
  getConfiguredChatId(): string | undefined {
    return this.config.chatId;
  }
}
