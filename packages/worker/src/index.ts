import { handleNamedTopicRehome } from "./named-topic-rehome";
import { handleSendMessage } from "./messages";
import { handleSessionRequest, handleSessionOwner } from "./sessions";
import { handleSendNotification, handleEditNotification } from "./notifications";
import { handleSlackRequest, sweepSlackSeenEvents, type SlackEndpoint } from "./slack-inbound";
import { handleMediaUpload, handleMediaGet, cleanupExpiredMedia } from "./media";
import { handlePollNext, handleAckCommand } from "./poll";
import { cleanupCommands, checkSessionHighWaterAlert, sweepStaleSessions } from "./d1-ops";
import { runTopicReaper, shouldCloseOrphans } from "./topic-reaper";
import { handleTopicLookup } from "./topic-lookup";
import { handleTopicRename } from "./topic-rename";
import { handleWhoami } from "./credentials";
import { handleRelay, handleRelayAck, handleRelayFail, runRelayExpiry } from "./relay";
import { handleLaunchRelay, handleLaunchRelayAck, runLaunchExpiry } from "./remote-launch";
import { handleRemoteSessions } from "./remote-sessions";
import { sweepSlackPosts } from "./chat/slack-posts";
import { hasSlackWorkspaceSecret } from "./chat/slack-config";
import { handleNamedTopic, handleNamedTopicBind, handleNamedTopicUnbind } from "./named-topics";

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
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
        if (path === "/launch/relay/ack" && method === "POST") {
          return handleLaunchRelayAck(db, env, request);
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

        // Topics
        if (path === "/topics/lookup" && method === "POST") {
          return handleTopicLookup(db, env, request);
        }
        if (path === "/topics/rename" && method === "POST") {
          return handleTopicRename(db, env, request);
        }
        if (path === "/topics/named" && method === "POST") {
          return handleNamedTopic(db, env, request);
        }
        if (path === "/topics/named/bind" && method === "POST") {
          return handleNamedTopicBind(db, env, request);
        }
        if (path === "/topics/named/rehome" && method === "POST") {
          return handleNamedTopicRehome(db, env, request);
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

        // Session-free sends (chat-transport, pigeon-lenr.1)
        if (path === "/messages/send" && method === "POST") {
          return handleSendMessage(env, request);
        }

        // Slack ingress (pigeon-4ogz.4). A machine with no SLACK_WORKSPACE_<MACHINE> secret gets
        // this router's ordinary 404.
        const slackMatch = path.match(/^\/slack\/([a-z0-9_-]{1,64})\/(events|commands|interactivity)$/);
        if (slackMatch && method === "POST") {
          return handleSlackRequest(
            db,
            env,
            request,
            slackMatch[1]!,
            slackMatch[2] as SlackEndpoint,
            ctx ? (work) => ctx.waitUntil(work) : undefined,
          );
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
      const launch = await runLaunchExpiry(env.DB);
      if (launch.expired > 0 || launch.pruned > 0) console.log("[remote-launch] expiry", launch);
    } catch (err) {
      console.error("Launch expiry failed:", err);
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
    // Only a worker with a Slack workspace secret has Slack tables to tidy: without one this must
    // not touch D1 at all (the schema may not even be applied), so a worker with no workspace stays as it was.
    if (hasSlackWorkspaceSecret(env)) {
      try {
        // Best-effort on its own (a missing table is a quiet log line, any other D1 error is
        // logged inside), so it needs no wrapper to protect the jobs around it.
        const swept = await sweepSlackPosts(env.DB);
        if (swept > 0) console.log("[slack] slack_posts retention", { swept });
        const seen = await sweepSlackSeenEvents(env.DB);
        if (seen > 0) console.log("[slack] slack_seen_events retention", { swept: seen });
      } catch (err) {
        console.error("Slack post retention failed:", err);
      }
    }
    try {
      // The orphan-closer is gated to a daily window (pigeon-4890) because each close posts a
      // service message that marks the topic unread; the reap half still runs every tick.
      // `scheduledTime` is the cron tick's own timestamp, so the gate cannot drift with however
      // long the jobs above took.
      await runTopicReaper(env.DB, {
        closeOrphans: shouldCloseOrphans(controller.scheduledTime),
        env,
      });
    } catch (err) {
      console.error("Topic reaper failed:", err);
    }
  },
} satisfies ExportedHandler<Env>;
