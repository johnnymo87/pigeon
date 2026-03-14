import { handleSessionRequest } from "./sessions";
import { handleSendNotification } from "./notifications";
import { handleTelegramWebhook } from "./webhook";
import { handleMediaUpload, handleMediaGet, cleanupExpiredMedia } from "./media";
import { handlePollNext, handleAckCommand } from "./poll";
import { cleanupCommands, cleanupSeenUpdates } from "./d1-ops";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const db = env.DB;

    // Health
    if (path === "/health") {
      return new Response("ok");
    }

    // Poll: GET /machines/:id/next
    const pollMatch = path.match(/^\/machines\/([^/]+)\/next$/);
    if (pollMatch && request.method === "GET") {
      return handlePollNext(db, env, request, pollMatch[1]!);
    }

    // Ack: POST /commands/:id/ack
    const ackMatch = path.match(/^\/commands\/([^/]+)\/ack$/);
    if (ackMatch && request.method === "POST") {
      return handleAckCommand(db, env, request, ackMatch[1]!);
    }

    // Sessions
    if (path === "/sessions" && request.method === "GET") {
      return handleSessionRequest(db, env, request, "list");
    }
    if (path === "/sessions/register" && request.method === "POST") {
      return handleSessionRequest(db, env, request, "register");
    }
    if (path === "/sessions/unregister" && request.method === "POST") {
      return handleSessionRequest(db, env, request, "unregister");
    }

    // Media
    if (path === "/media/upload" && request.method === "POST") {
      return handleMediaUpload(env, request);
    }
    if (path.startsWith("/media/") && request.method === "GET") {
      const key = decodeURIComponent(path.slice("/media/".length));
      return handleMediaGet(env, request, key);
    }

    // Notifications
    if (path === "/notifications/send" && request.method === "POST") {
      return handleSendNotification(db, env, request);
    }

    // Telegram webhook
    if (path.startsWith("/webhook/telegram") && request.method === "POST") {
      return handleTelegramWebhook(db, env, request);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await cleanupExpiredMedia(env);
    await cleanupCommands(env.DB);
    await cleanupSeenUpdates(env.DB);
  },
} satisfies ExportedHandler<Env>;
