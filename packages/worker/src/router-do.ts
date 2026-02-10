import { DurableObject } from "cloudflare:workers";
import { handleSessionRequest } from "./sessions";
import { handleSendNotification } from "./notifications";
import { handleTelegramWebhook } from "./webhook";

export class RouterDurableObject extends DurableObject<Env> {
  sql: SqlStorage;

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
        session_id TEXT NOT NULL,
        command TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        next_retry_at INTEGER NOT NULL,
        acked_at INTEGER
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
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

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
      return handleTelegramWebhook(this.sql, this.env, request);
    }

    // TODO: websocket
    return new Response(`Not found: ${url.pathname}`, { status: 404 });
  }
}
