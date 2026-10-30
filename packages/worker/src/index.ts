import { handleSessionRequest, handleSessionOwner } from "./sessions";
import { handleSendNotification, handleEditNotification } from "./notifications";
import { handleTelegramWebhook } from "./webhook";
import { handleMediaUpload, handleMediaGet, cleanupExpiredMedia } from "./media";
import { handlePollNext, handleAckCommand } from "./poll";
import { cleanupCommands, cleanupSeenUpdates, checkSessionHighWaterAlert, sweepStaleSessions } from "./d1-ops";
import { runTopicReaper, shouldCloseOrphans } from "./topic-reaper";
import { handleTopicLookup } from "./topic-lookup";
import { handleWhoami } from "./credentials";
import { handleRelay, handleRelayAck, handleRelayFail, runRelayExpiry } from "./relay";
import { handleLaunchRelay } from "./remote-launch";
import { handleRemoteSessions } from "./remote-sessions";
import { handleNamedTopic, handleNamedTopicBind, handleNamedTopicUnbind } from "./named-topics";

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

        // Which principal this request's credential resolves to (pigeon-k0qn.8)
        if (path === "/whoami" && method === "GET") {
          return handleWhoami(request, env);
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

        // Cross-machine swarm relay (pigeon-k0qn.5). Machine credentials only.
        if (path === "/swarm/relay" && method === "POST") {
          return handleRelay(db, env, request);
        }
        if (path === "/swarm/relay/ack" && method === "POST") {
          return handleRelayAck(db, env, request);
        }
        if (path === "/swarm/relay/fail" && method === "POST") {
          return handleRelayFail(db, env, request);
        }

        // Remote launch (pigeon-k0qn.17). Machine credentials only.
        if (path === "/launch/relay" && method === "POST") {
          return handleLaunchRelay(db, env, request);
        }

        // Sessions
        if (path === "/sessions" && method === "GET") {
          return handleSessionRequest(db, env, request, "list");
        }
        // swarm_list remote discovery (pigeon-k0qn.9). Machine credentials only.
        if (path === "/sessions/remote" && method === "GET") {
          return handleRemoteSessions(db, env, request);
        }
        if (path === "/sessions/register" && method === "POST") {
          return handleSessionRequest(db, env, request, "register");
        }
        if (path === "/sessions/unregister" && method === "POST") {
          return handleSessionRequest(db, env, request, "unregister");
        }
        const ownerMatch = path.match(/^\/sessions\/([^/]+)\/owner$/);
        if (ownerMatch && method === "GET") {
          let sessionId: string;
          try {
            sessionId = decodeURIComponent(ownerMatch[1]!);
          } catch {
            return Response.json({ error: "invalid session id" }, { status: 400 });
          }
          return handleSessionOwner(db, env, request, sessionId);
        }

        // Topics (read-only)
        if (path === "/topics/lookup" && method === "POST") {
          return handleTopicLookup(db, env, request);
        }
        if (path === "/topics/named" && method === "POST") {
          return handleNamedTopic(db, env, request);
        }
        if (path === "/topics/named/bind" && method === "POST") {
          return handleNamedTopicBind(db, env, request);
        }
        if (path === "/topics/named/unbind" && method === "POST") {
          return handleNamedTopicUnbind(db, env, request);
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

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
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
    // The sweep also runs BEFORE the topic reaper so that topics orphaned by the sweep are
    // visible to it on this same tick. Note that the orphan half only acts during the daily
    // close window (see shouldCloseOrphans), and closes at most DEFAULT_ORPHAN_CAP (30) per
    // tick, so a bulk sweep's topics beyond the cap drain on following days' ticks.
    try {
      // Expired relays become failure items for their senders; settled rows past retention go.
      const relay = await runRelayExpiry(env.DB);
      if (relay.expired > 0) console.log("[relay] expiry", relay);
    } catch (err) {
      console.error("Relay expiry failed:", err);
    }
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
      // The orphan-closer is gated to a daily window (pigeon-4890) because each close posts a
      // service message that marks the topic unread; the reap half still runs every tick.
      // `scheduledTime` is the cron tick's own timestamp, so the gate cannot drift with however
      // long the jobs above took.
      await runTopicReaper(env.DB, env, {
        closeOrphans: shouldCloseOrphans(controller.scheduledTime),
      });
    } catch (err) {
      console.error("Topic reaper failed:", err);
    }
  },
} satisfies ExportedHandler<Env>;
