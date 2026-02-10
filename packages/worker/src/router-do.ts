import { DurableObject } from "cloudflare:workers";
import { handleSessionRequest } from "./sessions";

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
        message_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS command_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        acked_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS seen_updates (
        update_id INTEGER PRIMARY KEY,
        seen_at INTEGER NOT NULL
      );
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

    // TODO: webhook, notifications, websocket
    return new Response(`Not found: ${url.pathname}`, { status: 404 });
  }
}
