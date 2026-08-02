import { handleSessionRequest } from "./sessions";
import { handleSendNotification, handleEditNotification } from "./notifications";
import { handleTelegramWebhook } from "./webhook";
import { handleMediaUpload, handleMediaGet, cleanupExpiredMedia } from "./media";
import { handlePollNext, handleAckCommand } from "./poll";
import { cleanupCommands, cleanupSeenUpdates, checkSessionHighWaterAlert, sweepStaleSessions } from "./d1-ops";
import { runTopicReaper } from "./topic-reaper";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      const response = await (async (): Promise<Response> => {
        const db = env.DB;

        // Health
        if (path === "/health") {
          return new Response("ok");
        }

        // Poll: GET /machines/:id/next
        const pollMatch = path.match(/^\/machines\/([^/]+)\/next$/);
        if (pollMatch && method === "GET") {
          return handlePollNext(db, env, request, pollMatch[1]!);
        }

        // Ack: POST /commands/:id/ack
        const ackMatch = path.match(/^\/commands\/([^/]+)\/ack$/);
        if (ackMatch && method === "POST") {
          return handleAckCommand(db, env, request, ackMatch[1]!);
        }

        // Sessions
        if (path === "/sessions" && method === "GET") {
          return handleSessionRequest(db, env, request, "list");
        }
        if (path === "/sessions/register" && method === "POST") {
          return handleSessionRequest(db, env, request, "register");
        }
        if (path === "/sessions/unregister" && method === "POST") {
          return handleSessionRequest(db, env, request, "unregister");
        }

        // Media
        if (path === "/media/upload" && method === "POST") {
          return handleMediaUpload(env, request);
        }
        if (path.startsWith("/media/") && method === "GET") {
          const key = decodeURIComponent(path.slice("/media/".length));
          return handleMediaGet(env, request, key);
        }

        // Notifications
        if (path === "/notifications/send" && method === "POST") {
          return handleSendNotification(db, env, request);
        }
        if (path === "/notifications/edit" && method === "POST") {
          return handleEditNotification(db, env, request);
        }

        // Telegram webhook
        if (path.startsWith("/webhook/telegram") && method === "POST") {
          return handleTelegramWebhook(db, env, request);
        }

        return Response.json({ error: "Not found" }, { status: 404 });
      })();

      if (response.status >= 400 && path !== "/health") {
        console.error("[worker] request outcome", {
          path,
          method,
          status: response.status,
        });
      }

      return response;
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;

      console.error("[worker] unhandled error", {
        path,
        method,
        error,
        stack,
      });

      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Every step is individually wrapped. These are independent janitorial jobs, and one
    // of them throwing is not a reason to skip the rest — before this, a throw in the
    // very first would have silently cancelled the session sweep, the capacity alert and
    // the topic reaper for that tick.
    try {
      await cleanupExpiredMedia(env);
    } catch (err) {
      console.error("Media cleanup failed:", err);
    }
    try {
      await cleanupCommands(env.DB);
    } catch (err) {
      console.error("Command cleanup failed:", err);
    }
    try {
      await cleanupSeenUpdates(env.DB);
    } catch (err) {
      console.error("Seen-updates cleanup failed:", err);
    }
    // Order is load-bearing, twice over.
    //
    // The sweep runs BEFORE the high-water alert so the alert reports what actually
    // survives cleanup. Measuring first would nag about rows that are about to be
    // deleted in this same tick, training the reader to ignore the alert.
    //
    // The sweep also runs BEFORE the topic reaper so that topics orphaned by the sweep
    // start draining immediately rather than waiting an hour. Note "start": the reaper
    // closes at most DEFAULT_ORPHAN_CAP (5) orphans per tick, so a bulk sweep's topics
    // drain over several hours, not in this one.
    try {
      await sweepStaleSessions(env.DB);
    } catch (err) {
      console.error("Stale session sweep failed:", err);
    }
    try {
      await checkSessionHighWaterAlert(env.DB, env);
    } catch (err) {
      console.error("Session high-water alert failed:", err);
    }
    try {
      await runTopicReaper(env.DB, env);
    } catch (err) {
      console.error("Topic reaper failed:", err);
    }
  },
} satisfies ExportedHandler<Env>;
