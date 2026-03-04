import { DurableObject } from "cloudflare:workers";
import { handleSessionRequest } from "./sessions";
import { handleSendNotification } from "./notifications";
import { handleTelegramWebhook } from "./webhook";
import {
  cleanupCommandQueue,
  flushCommandQueue,
  markCommandAcked,
  retrySentCommands,
  type CommandWsLike,
} from "./command-queue";
import { verifyApiKeyFromProtocols } from "./auth";

export class RouterDurableObject extends DurableObject<Env> {
  sql: SqlStorage;
  private static readonly MAX_WS_MESSAGE_BYTES = 65536;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_machine
        ON sessions(machine_id);

      CREATE TABLE IF NOT EXISTS messages (
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_created
        ON messages(created_at);

      CREATE INDEX IF NOT EXISTS idx_messages_token_chat
        ON messages(token, chat_id);

      CREATE TABLE IF NOT EXISTS command_queue (
        command_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        session_id TEXT,
        command TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        next_retry_at INTEGER,
        acked_at INTEGER,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_command_queue_machine_status
        ON command_queue(machine_id, status);

      CREATE INDEX IF NOT EXISTS idx_command_queue_retry
        ON command_queue(status, next_retry_at);

      CREATE TABLE IF NOT EXISTS seen_updates (
        update_id INTEGER PRIMARY KEY,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_seen_updates_created
        ON seen_updates(created_at);
    `);

    // Migrations: add new columns to existing tables (ignore "duplicate column" errors).
    const addColumnMigrations = [
      `ALTER TABLE command_queue ADD COLUMN command_type TEXT NOT NULL DEFAULT 'execute'`,
      `ALTER TABLE command_queue ADD COLUMN directory TEXT`,
    ];
    for (const migration of addColumnMigrations) {
      try {
        this.sql.exec(migration);
      } catch {
        // Column already exists — ignore.
      }
    }

    // Migration: make session_id nullable (needed for launch commands which have no session yet).
    // The original table was created with session_id TEXT NOT NULL, but CREATE TABLE IF NOT EXISTS
    // won't update an existing table. SQLite doesn't support ALTER COLUMN, so we recreate the table.
    this.migrateSessionIdNullable();
  }

  private migrateSessionIdNullable(): void {
    const columns = this.sql.exec("PRAGMA table_info(command_queue)").toArray() as Array<{
      name: string;
      notnull: number;
      [key: string]: SqlStorageValue;
    }>;
    const sessionIdCol = columns.find((c) => c.name === "session_id");
    if (!sessionIdCol || sessionIdCol.notnull !== 1) {
      return; // Already nullable or column doesn't exist.
    }

    // Recreate table with session_id as nullable.
    this.sql.exec("DROP TABLE IF EXISTS command_queue_v2");
    this.sql.exec(`
      CREATE TABLE command_queue_v2 (
        command_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        session_id TEXT,
        command TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        next_retry_at INTEGER,
        acked_at INTEGER,
        last_error TEXT,
        command_type TEXT NOT NULL DEFAULT 'execute',
        directory TEXT
      )
    `);
    this.sql.exec("INSERT INTO command_queue_v2 SELECT * FROM command_queue");
    this.sql.exec("DROP TABLE command_queue");
    this.sql.exec("ALTER TABLE command_queue_v2 RENAME TO command_queue");
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_command_queue_machine_status
        ON command_queue(machine_id, status)
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_command_queue_retry
        ON command_queue(status, next_retry_at)
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    if (url.pathname === "/ws" && request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    // Session management
    if (url.pathname === "/sessions" && method === "GET") {
      return handleSessionRequest(this.sql, this.env, request, "list");
    }
    if (url.pathname === "/sessions/register" && method === "POST") {
      return handleSessionRequest(this.sql, this.env, request, "register");
    }
    if (url.pathname === "/sessions/unregister" && method === "POST") {
      return handleSessionRequest(this.sql, this.env, request, "unregister");
    }

    // Notifications
    if (url.pathname === "/notifications/send" && method === "POST") {
      return handleSendNotification(this.sql, this.env, request);
    }

    // Telegram webhook
    if (url.pathname.startsWith("/webhook/telegram") && method === "POST") {
      return handleTelegramWebhook(
        this.sql,
        this.env,
        request,
        (machineId) => {
          const ws = this.getMachineWebSocket(machineId);
          if (ws) {
            flushCommandQueue(this.sql, machineId, ws);
          }
        },
        (machineId) => this.getMachineWebSocket(machineId) !== null,
      );
    }

    // TODO: websocket
    return new Response(`Not found: ${url.pathname}`, { status: 404 });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const machineId = url.searchParams.get("machineId");

    if (!machineId || machineId.length > 64 || !/^[a-zA-Z0-9-]+$/.test(machineId)) {
      return new Response("Invalid machine ID", { status: 400 });
    }

    const protocols = request.headers.get("Sec-WebSocket-Protocol");
    if (!verifyApiKeyFromProtocols(protocols, this.env.CCR_API_KEY)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const existing = this.getMachineWebSocket(machineId);
    if (existing) {
      try {
        existing.close(4000, "Replaced by new connection");
      } catch {
        // Best-effort close.
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server, [machineId]);
    server.serializeAttachment({ machineId });

    flushCommandQueue(this.sql, machineId, server);

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: {
        "Sec-WebSocket-Protocol": "ccr",
      },
    });
  }

  private getMachineWebSocket(machineId: string): (WebSocket & CommandWsLike) | null {
    const sockets = this.ctx.getWebSockets(machineId);
    const ws = sockets[0] as (WebSocket & CommandWsLike) | undefined;
    return ws ?? null;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const machineId = this.getMachineIdFromSocket(ws);
    if (!machineId) {
      return;
    }

    const size = typeof message === "string" ? message.length : message.byteLength;
    if (size > RouterDurableObject.MAX_WS_MESSAGE_BYTES) {
      return;
    }

    let payload: unknown;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      payload = JSON.parse(text);
    } catch {
      return;
    }

    if (!payload || typeof payload !== "object") {
      return;
    }

    const msg = payload as Record<string, unknown>;
    const type = msg.type;

    if (type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (type === "ack") {
      const commandId = msg.commandId;
      if (typeof commandId !== "string" || commandId.length > 64) {
        return;
      }

      const acked = markCommandAcked(this.sql, commandId, machineId);
      if (acked) {
        flushCommandQueue(this.sql, machineId, ws as WebSocket & CommandWsLike);
      }
      return;
    }

    if (type === "commandResult") {
      const success = msg.success;
      const chatId = msg.chatId;
      const error = msg.error;
      if (success === false && (typeof chatId === "string" || typeof chatId === "number")) {
        const errorText = typeof error === "string" ? error : "Unknown error";
        await this.sendTelegramMessage(String(chatId), `Command failed: ${errorText}`);
      }
    }
  }

  webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    // No explicit cleanup needed; Durable Object tracks sockets by tag.
  }

  webSocketError(_ws: WebSocket, _error: unknown): void {
    // Keep alive; machine agent should reconnect.
  }

  private getMachineIdFromSocket(ws: WebSocket): string | null {
    const attachment = ws.deserializeAttachment() as { machineId?: unknown } | null;
    const machineId = attachment?.machineId;
    return typeof machineId === "string" ? machineId : null;
  }

  private async sendTelegramMessage(chatId: string, text: string): Promise<void> {
    const botToken = this.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return;
    }

    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  }

  async alarm(): Promise<void> {
    cleanupCommandQueue(this.sql);
    retrySentCommands(this.sql, (machineId) => this.getMachineWebSocket(machineId));

    await this.ctx.storage.setAlarm(Date.now() + (60 * 60 * 1000));
  }
}
