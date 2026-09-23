import { createApp } from "./app";
import type { SessionRecord } from "./storage/types";
import { loadConfig } from "./config";
import {
  TelegramNotificationService,
  generateToken,
  type StopNotifier,
} from "./notification-service";
import { OpencodeClient } from "./opencode-client";
import { startServer } from "./server";
import { openStorageDb } from "./storage/database";
import { OUTBOX_RETENTION_MS, FAILED_RETENTION_MS } from "./storage/schema";
import { SWARM_RETENTION_MS } from "./storage/swarm-schema";
import { SESSION_EVENTS_RETENTION_MS } from "./storage/session-events-schema";
import { Poller } from "./worker/poller";
import { advertisedBackends, checkLaunchServable } from "./worker/backends";
import { WorkerHealthMonitor } from "./worker/worker-health";
import { OutboxSender } from "./worker/outbox-sender";
import { SwarmArbiter } from "./swarm/arbiter";
import { AlertDrainer, DEFAULT_DRAIN_INTERVAL_MS, type AlertDrainerNotifier } from "./swarm/alert-drainer";
import { DeliveryWatchdog } from "./swarm/delivery-watchdog";
import { makeWatchdogResolveClients } from "./swarm/watchdog-client-resolver";
import { SessionDirectoryRegistry } from "./swarm/registry";
import { ingestWorkerCommand } from "./worker/command-ingest";
import { ingestLaunchCommand, INHERIT_WHICH_TIMEOUT_MS } from "./worker/launch-ingest";
import { ingestKillCommand } from "./worker/kill-ingest";
import { ingestInterruptCommand } from "./worker/interrupt-ingest";
import { ingestCompactCommand } from "./worker/compact-ingest";
import { ingestMcpListCommand, ingestMcpEnableCommand, ingestMcpDisableCommand } from "./worker/mcp-ingest";
import { ingestModelListCommand, ingestModelSetCommand } from "./worker/model-ingest";
import {
  ingestTagListCommand,
  ingestTagSetCommand,
  ingestTagSetDirCommand,
  ingestTagTopCommand,
} from "./worker/tag-ingest";
import { createOcTagsRunner, resolveOcTagsBin } from "./worker/oc-tags";
import { SessionTagResolver } from "./tag-resolver";
import { createTelegramReplySender } from "./worker/reply-factory";
import { GOOSE_BACKEND_KIND } from "./goose/backend-kind.js";
import { gooseControlVerdict } from "./goose/control-guard.js";
import { GooseAcpClient } from "./goose/acp-client.js";
import { webSocketTransport } from "./goose/ws-transport.js";
import { ingestGooseLaunchCommand } from "./goose/launch-ingest.js";
import { GooseRunnerRegistry, GooseSessionRunner } from "./goose/session-runner.js";
import { startSessionReaper } from "./session-reaper";
import type { TgEntity } from "./telegram-message";
import { IngressRouter } from "./routing/router";
import { seedServes } from "./routing/serve-registry";
import { ServeEndpointReconciler } from "./routing/endpoint-reconciler";
import { HealthTransitionObserver } from "./routing/health-transition-observer";
import {
  FlapDetector,
  DEFAULT_WINDOW_MS,
  DEFAULT_PER_SESSION_MOVES,
  DEFAULT_BREADTH_SESSIONS,
  DEFAULT_BREADTH_MOVES_EACH,
  DEFAULT_SLOW_BURN_MOVES,
  DEFAULT_SUMMARY_MS,
} from "./routing/flap-detector";
import { ServeHealthPoller } from "./routing/serve-health-poller";
import { OpencodeClientFactory } from "./routing/client-factory";
import { ServeOutcomeSensor } from "./routing/serve-outcome";
import { makeDirectoryResolver } from "./routing/directory-resolver";

const ALERT_ABANDON_MS = 72 * 60 * 60 * 1000;
const ALERT_SENT_RETENTION_MS = 1 * 60 * 60 * 1000;
// Retention for abandoned alerts measured from created_at (age since creation, not since abandonment).
const ALERT_ABANDONED_CREATED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const config = loadConfig();
const storage = openStorageDb(config.dbPath);

const ingressRouter = config.serveEndpoints.length > 0
  ? new IngressRouter(storage, {
      leaseTtlMs: config.leaseTtlMs,
      staleServeMs: config.staleServeMs,
      idleMigrateMs: config.idleMigrateMs,
      dormantTtlMs: config.dormantTtlMs,
      activeTurnCap: config.activeTurnCap,
    })
  : undefined;

let healthPoller: ServeHealthPoller | undefined;
if (ingressRouter) {
  seedServes(storage.serves, config.serveEndpoints, Date.now());
  ingressRouter.rebuildFromDb();
  const serveHealthLog = (msg: string, fields?: Record<string, unknown>) =>
    console.warn(`[serve-health] ${msg}`, fields ? JSON.stringify(fields) : "");
  if (config.serveLiveness === "self") {
    const poller = new ServeHealthPoller(storage.serves, ingressRouter, {
      healthPollMs: config.healthPollMs,
      log: serveHealthLog,
    });
    const selfLivenessTimer = setInterval(() => {
      poller.sweepStale(Date.now(), config.staleServeMs);
    }, config.healthPollMs);
    selfLivenessTimer.unref?.();
    console.log(`[pigeon-daemon] ingress router started with self-heartbeat liveness sweep (serves=${config.serveEndpoints.length})`);
  } else {
    healthPoller = new ServeHealthPoller(storage.serves, ingressRouter, {
      healthPollMs: config.healthPollMs,
      log: serveHealthLog,
    });
    healthPoller.start();
    console.log(`[pigeon-daemon] ingress router started with HTTP polling liveness (serves=${config.serveEndpoints.length})`);
  }
  const sweepTimer = setInterval(() => ingressRouter.sweep(Date.now()), config.healthPollMs);
  sweepTimer.unref?.();
} else {
  console.log("[pigeon-daemon] ingress router NOT started (no serveEndpoints)");
}

const opencodeClient = config.opencodeUrl
  ? new OpencodeClient({ baseUrl: config.opencodeUrl, injectedPrompts: storage.injectedPrompts })
  : undefined;

// Shadow-mode serve outcome sensor (bead pigeon-f2a) — the sensor for the
// verdict that lands in pigeon-886, shipped ahead of it and wired to nothing
// that decides anything.
//
// It exists because increment 2 needs a threshold ("N serve-directed failures in
// a window means suspect") and nobody can pick N honestly today: no base rate for
// refused/5xx on a HEALTHY serve has ever been recorded. Enforcing a blind guess
// against live routing gets you either a useless alert or an outage.
//
// Attribution is resolved HERE, at record time, against the live registry rather
// than captured when a client was constructed — a restarted serve keeps its
// endpoint but gets a fresh instance_uuid. An endpoint absent from the registry
// resolves to undefined and is dropped, which is exactly how the plugin's
// ephemeral direct-channel port stays out of the signal (design 5.1 B): its
// failures mean the plugin died, not the serve, and counting them would mark the
// whole pool suspect every morning after the nightly workspace reset.
const outcomeSensor = ingressRouter
  ? new ServeOutcomeSensor({
      resolve: (endpoint) => {
        const row = storage.serves.all().find((s) => s.endpoint === endpoint);
        return row ? { serveId: row.serveId, instanceUuid: row.instanceUuid } : undefined;
      },
      log: (msg, fields) =>
        console.log(`[serve-outcome] ${msg}`, fields ? JSON.stringify(fields) : ""),
    })
  : undefined;

const clientFactory = ingressRouter
  ? new OpencodeClientFactory(
      ingressRouter,
      Date.now,
      outcomeSensor ? (endpoint, obs) => outcomeSensor.record(endpoint, obs) : undefined,
      storage.injectedPrompts,
    )
  : undefined;
/**
 * Resolve the owning-serve client for a session; falls back to the legacy single
 * client when routing is unconfigured.
 *
 * A goose session resolves to `undefined` HERE, at the choke point, rather than
 * at each call site. `forSession` -> `ensureRouted` -> `placeSession` does not
 * decline an id it has never seen: it writes a `session_assignment` row AND
 * acquires a live lease, and live leases are counted against `activeTurnCap`,
 * so a goose id would narrow placement for real opencode sessions -- damage to
 * OTHER sessions, which is what makes it hard to attribute afterwards.
 *
 * Guarding the nine control handlers individually was the first attempt and it
 * was not enough: this function is ALSO handed whole to the swarm arbiter
 * (below) and to `/launch`'s owner resolution, so a `/swarm/send` aimed at a
 * goose id would still have minted the lease. One guard here covers every
 * present and future caller.
 *
 * The handlers still ask `handleGooseControl` first, because returning
 * `undefined` here only makes them log "not routable" and go quiet, and a
 * silent non-answer is exactly what the honest replies exist to avoid.
 */
const clientForSession = (sessionId: string): OpencodeClient | undefined => {
  if (isGooseSession(sessionId)) return undefined;
  return clientFactory ? clientFactory.forSession(sessionId) : opencodeClient;
};

/**
 * The app's own request handler, bound once it exists.
 *
 * Late-bound on purpose: the goose runners are constructed here but the app is
 * built at the bottom of this file, and the runners need to call the app's /stop
 * route rather than reimplement it. A function reference resolved at call time
 * is the smallest thing that bridges that ordering.
 */
let appHandler: ((request: Request) => Promise<Response>) | undefined;

/**
 * Long-lived goose turn runners, one per session.
 *
 * Absent when no goose endpoint is configured, and that absence is load-bearing:
 * `selectAdapter` hands back no adapter without it, so a goose session on a
 * daemon with no goose is cleanly unroutable instead of being dropped into the
 * opencode machinery that deletes sessions on connection errors.
 */
const gooseRunners = config.gooseAcpUrl
  ? new GooseRunnerRegistry({
      createRunner: (session) =>
        new GooseSessionRunner({
          session,
          client: new GooseAcpClient({
            url: session.backendEndpoint ?? config.gooseAcpUrl!,
            transportFactory: webSocketTransport(session.backendAuthToken ?? config.gooseAcpToken),
            // Approved by the human for the daily-driver MVP on the stated basis
            // that their opencode config already allows every tool, so this
            // surrenders no gate they currently hold. It is NOT a claim that
            // unattended auto-approval is safe in general: an unanswered
            // permission request parks a goose turn forever, and there is no
            // cancel to recover with, so the alternative is a session that
            // wedges rather than one that asks.
            permissionPolicy: (params) => params.options[0]?.optionId,
            log: (m, f) => console.log(`[goose] ${m}`, f ?? ""),
            // `sessionId` here is GOOSE's, off the socket -- not pigeon's, which
            // is what `peek` takes. They differ for every session launched
            // through pigeon (see SessionRecord.backendSessionId), so peeking by
            // the wrong one silently routes no updates at all: the turn would
            // run to completion with the human seeing none of it.
            onSessionUpdate: (backendSessionId, update) =>
              gooseRunners?.peekByBackendId(backendSessionId)?.onUpdate(update),
          }),
          postStop: async (body) => {
            // Reuses the daemon's own /stop route rather than reimplementing
            // notification idempotency, notify policy, formatting, splitting,
            // the scroll anchor and last_seen touching -- all of which live
            // between reading that body and enqueueing the outbox row.
            if (!appHandler) throw new Error("daemon app is not ready to accept /stop yet");
            const res = await appHandler(
              new Request(`http://127.0.0.1:${config.port}/stop`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  // Auth is ENABLED on the live daemon, and `/stop` is not on the
                  // anonymous allowlist (only GET /health and GET /outbox/stats
                  // are). Without this header every goose turn would finish, get
                  // a 401 here, and be swallowed by the catch in finishTurn -- so
                  // the human would hear nothing, forever, with the only trace a
                  // log line. Found in review; the probe could not see it because
                  // it fakes postStop.
                  ...(config.authToken ? { authorization: `Bearer ${config.authToken}` } : {}),
                },
                body: JSON.stringify(body),
              }),
            );
            if (!res.ok) {
              const detail = await res.text().catch(() => "");
              throw new Error(`/stop returned ${res.status} ${detail.slice(0, 200)}`);
            }
          },
          touch: (sessionId) => storage.sessions.touch(sessionId, Date.now()),
          log: (m, f) => console.log(`[goose] ${m}`, f ?? ""),
        }),
    })
  : undefined;

/**
 * Whether this daemon can CREATE a goose session, as opposed to drive one.
 *
 * A single constant on purpose. It feeds both the capability advertised on
 * every poll and the guard the launch handler checks, and those two are the
 * halves of one claim: advertise without the guard and the worker hands over a
 * command this daemon refuses; guard without advertising and the worker refuses
 * before the daemon is ever asked. Two literals here drifted apart once
 * already -- they were `false` in both places, deliberately, for exactly as
 * long as the launch path did not exist.
 */
const canLaunchGoose = Boolean(gooseRunners && config.gooseAcpUrl);

/** True for sessions this daemon speaks to over goose's ACP rather than opencode. */
const isGooseSession = (sessionId: string): boolean =>
  storage.sessions.get(sessionId)?.backendKind === GOOSE_BACKEND_KIND;

/**
 * Intercepts a control command aimed at a goose session BEFORE it can reach
 * `clientForSession`. Returns true when the command was handled here.
 *
 * See src/goose/control-guard.ts for why reaching the router at all is harmful
 * and why /interrupt answers the way it does.
 */
async function handleGooseControl(
  command: "kill" | "interrupt" | "compact" | "mcp" | "model",
  msg: { sessionId: string; commandId: string; chatId: string; messageThreadId?: number | null },
): Promise<boolean> {
  const verdict = gooseControlVerdict(command, msg.sessionId, {
    backendKindOf: (id) => storage.sessions.get(id)?.backendKind,
    gooseBackendKind: GOOSE_BACKEND_KIND,
  });
  if (verdict.kind === "not-goose") return false;

  const send = createTelegramReplySender(sendTelegramMessage, msg);
  const reply = (text: string) => send(msg.chatId, text);
  if (verdict.kind === "kill") {
    // goose has no cancel, so a /kill cannot stop an in-flight turn server-side.
    // What it CAN do honestly is drop pigeon's side of the session, which is
    // what the human is asking for: stop routing this to me.
    gooseRunners?.drop(msg.sessionId);
    storage.sessions.delete(msg.sessionId);
    storage.assignments.delete(msg.sessionId);
    if (poller) {
      try {
        await poller.unregisterSession(msg.sessionId);
      } catch (err) {
        console.warn(`[index] onKill: goose session unregister failed for ${msg.sessionId}:`, err);
      }
    }
    await reply(
      "Session closed. Note that goose has no cancel, so a turn already running "
      + "will finish on the goose side; pigeon has stopped tracking it.",
    );
    return true;
  }

  await reply(verdict.reply);
  return true;
}

async function sendTelegramMessage(
  chatId: string,
  text: string,
  opts: { entities?: TgEntity[]; messageThreadId: number | undefined },
): Promise<void> {
  if (!config.telegramBotToken) return;
  try {
    const apiBase = `https://api.telegram.org/bot${config.telegramBotToken}`;
    const payload: Record<string, unknown> = { chat_id: chatId, text };
    if (opts.entities && opts.entities.length > 0) {
      payload.entities = opts.entities;
    }
    if (opts.messageThreadId !== undefined) {
      payload.message_thread_id = opts.messageThreadId;
    }
    const res = await fetch(`${apiBase}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // The body, not just the status. Telegram answers an over-long message, a
      // bad entity offset or invalid UTF-8 with an indistinguishable 400, and a
      // command reply that vanishes between the worker's ack and the user's
      // screen leaves a bare "400" as the only trace. That dead end is what made
      // the surrogate-pair bug in the /tag backlog hard to find.
      const detail = await res.text().catch(() => "");
      console.warn(`[pigeon-daemon] sendTelegramMessage failed: ${res.status} ${detail.slice(0, 500)}`);
    }
  } catch (err) {
    console.warn("[pigeon-daemon] sendTelegramMessage fetch error:", err);
  }
}

/**
 * Builds the dependencies for a /tag command.
 *
 * Unlike every other slash command, /tag needs no opencode client: it talks to the
 * oc-tags binary, not to a session. So it keeps working when the session's serve is
 * unhealthy — which matters, because clearing the tagging backlog from a phone is
 * exactly the kind of thing done while nothing else is running.
 *
 * The binary is resolved per command rather than once at startup, so installing
 * oc-tags does not also require restarting the daemon.
 */
function resolveRunOcTags(timeoutMs?: number) {
  const bin = resolveOcTagsBin({ configured: config.ocTagsBin });
  return bin ? createOcTagsRunner(bin, timeoutMs) : null;
}

/**
 * Caches each session's oc-tags tag for the notification footer.
 *
 * Its runner resolves the binary per call, for the same reason `/tag` does:
 * installing oc-tags should not also require restarting the daemon. A machine
 * without it throws here on every refresh, which the resolver turns into one
 * warning and a cached null — the footer simply omits the line.
 *
 * The 3s timeout is deliberately far below the 20s a `/tag` command gets:
 * `oc-tags which` never reads the message table, so a slow one means a
 * contended DB, and a notification should not wait on a decoration.
 */
const tagResolver = new SessionTagResolver({
  runner: async (args) => {
    const bin = resolveOcTagsBin({ configured: config.ocTagsBin });
    if (!bin) throw new Error("oc-tags is not installed on this machine");
    return createOcTagsRunner(bin, 3_000)(args);
  },
});

function tagDeps(msg: { commandId: string; chatId: string; messageThreadId?: number | null }) {
  return {
    commandId: msg.commandId,
    chatId: msg.chatId,
    machineId: config.machineId,
    runOcTags: resolveRunOcTags(),
    sendTelegramReply: createTelegramReplySender(sendTelegramMessage, msg),
  };
}

/**
 * Watches the outcome of our two worker write routes and alerts on a sustained failure
 * (pigeon-n4v). Constructed unconditionally rather than gated on a plain-alert notifier:
 * the alert row and the journal line are worth having on a host that cannot deliver them,
 * since the absence of any durable record is exactly what made the 2026-07-14 outage
 * undiagnosable sixteen days later. Undeliverable rows are retired by the hourly
 * abandonOlderThan sweep, the same as every other alert on such a host.
 */
const workerHealthMonitor = new WorkerHealthMonitor({
  alerts: storage.alerts,
  log: (msg, fields) =>
    console.warn(`[worker-health] ${msg}`, fields ? JSON.stringify(fields) : ""),
});

const poller = config.workerUrl && config.workerApiKey && config.machineId
  ? new Poller(
      {
        workerUrl: config.workerUrl,
        apiKey: config.workerApiKey,
        machineId: config.machineId,
        chatId: config.telegramChatId,
        // Derived from the SAME values the launch handler checks below, so the
        // advertisement cannot drift from what this daemon will actually do.
        // Configuration, never health -- see backends.ts.
        //
        // Read from the SAME constant the launch handler branches on, so the
        // advertisement cannot claim a backend this daemon would then refuse.
        // This capability means "I can LAUNCH this": until the launch path
        // existed it was hardcoded false even where goose was configured,
        // because a runner registry only means an existing session can be
        // DRIVEN. The launch path exists now, so the honest answer is the
        // configuration.
        backends: advertisedBackends({
          opencode: Boolean(opencodeClient),
          goose: canLaunchGoose,
        }),
      },
      {
        // Any inbound action on a session means the user is looking at it, so the
        // unread badge clears. This is the single boundary every Telegram-originated
        // command crosses -- a typed reply and a question-card callback both arrive
        // here as execute commands -- which is why it lives at dispatch rather than
        // in the reply handler.
        onInboundForSession: (sessionId) => {
          storage.sessionEvents.markAllRead(sessionId, Date.now());
        },
        onCommand: async (msg) => {
          // Resolve the target session's owning-serve client so the plugin-free
          // revive fallback (getSession + sendPrompt in revive-and-deliver) hits
          // the serve that actually owns this session in a pool, not a fixed
          // :4096. Mirrors the clientForSession resolution the other handlers use
          // (zao4.10). The primary DirectChannelAdapter path is already pool-aware
          // via the session's per-serve backendEndpoint. When unroutable, omit the
          // client to preserve command-ingest's "no client -> delete dead session"
          // fallback.
          // Returns undefined for a goose session (see clientForSession), which
          // is safe ONLY because the goose adapter declares
          // failurePolicy:"surface": that gates out the whole connection-error
          // block, including the no-client branch that would otherwise DELETE
          // the session unconditionally.
          const client = clientForSession(msg.sessionId);
          await ingestWorkerCommand(storage, msg, {
            workerUrl: config.workerUrl,
            apiKey: config.workerApiKey,
            editNotification: (nid, text, rm, entities) => poller!.editNotification(nid, text, rm as { inline_keyboard?: unknown[] }, entities as unknown[] | undefined),
            machineId: config.machineId,
            ...(client ? { opencodeClient: client } : {}),
            sendTelegramReply: createTelegramReplySender(sendTelegramMessage, msg),
            tagLookup: tagResolver,
            unregisterSession: async (sessionId) => { if (poller) await poller.unregisterSession(sessionId); },
            ...(gooseRunners ? { gooseRunnerFor: (s: SessionRecord) => gooseRunners.get(s) } : {}),
          });
        },
        onLaunch: async (msg) => {
          const reply = createTelegramReplySender(sendTelegramMessage, msg);

          // Deliberately redundant with the worker's capability gate; see
          // checkLaunchServable. Previously the no-opencodeClient case warned
          // and RETURNED, which the poller reads as success and then acks -- so
          // the command was consumed and destroyed with the human hearing
          // nothing at all.
          // Same capabilities as the advertisement above, so what this daemon
          // claims and what it does cannot disagree.
          const servable = checkLaunchServable(msg.backend, {
            opencode: Boolean(opencodeClient),
            goose: canLaunchGoose,
          });
          if (!servable.ok) {
            console.warn(`[pigeon-daemon] refusing launch commandId=${msg.commandId} backend=${msg.backend ?? "opencode"}: ${servable.message}`);
            await reply(msg.chatId, servable.message);
            return;
          }

          if (servable.backend === "goose" && gooseRunners && config.gooseAcpUrl) {
            await ingestGooseLaunchCommand({
              commandId: msg.commandId,
              directory: msg.directory,
              prompt: msg.prompt,
              chatId: msg.chatId,
              machineId: config.machineId,
              acpUrl: config.gooseAcpUrl,
              ...(config.gooseAcpToken ? { acpToken: config.gooseAcpToken } : {}),
              sessions: storage.sessions,
              runnerFor: (session) => gooseRunners.get(session),
              // A short-lived client purely to open the session: the runner is
              // per-session and builds its own, so there is none to borrow
              // before the session exists.
              createMintClient: (url, token) =>
                new GooseAcpClient({
                  url,
                  transportFactory: webSocketTransport(token),
                  log: (m, f) => console.log(`[goose-launch] ${m}`, f ?? ""),
                }),
              onSessionStart: async (sessionId) => {
                if (poller) await poller.registerSession(sessionId);
              },
              sendTelegramReply: reply,
            });
            return;
          }

          // Unreachable for a correctly-wired daemon: checkLaunchServable has
          // already refused every backend this daemon cannot launch, and the
          // branches above handle the ones it can.
          //
          // THROWS rather than returns, and the difference is the whole point.
          // A clean return reads as success to the poller, which then acks --
          // destroying the command with the human hearing nothing, which is the
          // bug this commit exists to remove. Throwing makes the poller skip
          // the ack, so the command retries and the failure is visible. If a
          // new servable backend is ever added to checkLaunchServable without a
          // branch here, this is what says so.
          if (servable.backend !== "opencode" || !opencodeClient) {
            throw new Error(`onLaunch has no branch for servable backend ${servable.backend}`);
          }

          await ingestLaunchCommand({
            commandId: msg.commandId,
            directory: msg.directory,
            prompt: msg.prompt,
            chatId: msg.chatId,
            machineId: config.machineId,
            opencodeClient,
            // Create on serve-0 (opencodeClient) but run the agent loop on the
            // serve pigeon HRW-assigns: clientForSession resolves (and places)
            // the owner. Unconfigured pool => clientForSession returns the
            // serve-0 client, i.e. today's behavior.
            resolveOwnerClient: clientForSession,
            // /launch --tag: bookkeeping applied AFTER the session is prompted,
            // and resolved per command so installing oc-tags does not also
            // require restarting the daemon.
            ...(msg.tag !== undefined ? { tag: msg.tag } : {}),
            // Tag inheritance from the /launch's topic or swipe-reply session.
            // Its `oc-tags which` gets the short budget; the `set` that may
            // follow uses the ordinary runner.
            ...(msg.inheritFromSessionId !== undefined ? { inheritFromSessionId: msg.inheritFromSessionId } : {}),
            runOcTags: resolveRunOcTags(),
            runOcTagsWhich: resolveRunOcTags(INHERIT_WHICH_TIMEOUT_MS),
            // The session registers (and warms its tag cache) before the tag is
            // written, so without this its FIRST notification would show no tag
            // right after Telegram said the tag had been applied.
            onTagged: (sessionId: string) => tagResolver.refreshNow(sessionId),
            sendTelegramReply: reply,
          });
        },
        onKill: async (msg) => {
          if (await handleGooseControl("kill", msg)) return;
          const client = clientForSession(msg.sessionId);
          if (!client) {
            console.warn(`[index] onKill: session ${msg.sessionId} not routable (no opencodeClient/healthy serve)`);
            return;
          }
          await ingestKillCommand({
            commandId: msg.commandId,
            sessionId: msg.sessionId,
            chatId: msg.chatId,
            machineId: config.machineId,
            opencodeClient: client,
            sendTelegramReply: createTelegramReplySender(sendTelegramMessage, msg),
          });
        },
        onInterrupt: async (msg) => {
          if (await handleGooseControl("interrupt", msg)) return;
          const client = clientForSession(msg.sessionId);
          if (!client) {
            console.warn(`[index] onInterrupt: session ${msg.sessionId} not routable (no opencodeClient/healthy serve)`);
            return;
          }
          await ingestInterruptCommand({
            commandId: msg.commandId,
            sessionId: msg.sessionId,
            chatId: msg.chatId,
            machineId: config.machineId,
            opencodeClient: client,
            sendTelegramReply: createTelegramReplySender(sendTelegramMessage, msg),
          });
        },
        onCompact: async (msg) => {
          if (await handleGooseControl("compact", msg)) return;
          const client = clientForSession(msg.sessionId);
          if (!client) {
            console.warn(`[index] onCompact: session ${msg.sessionId} not routable (no opencodeClient/healthy serve)`);
            return;
          }
          await ingestCompactCommand({
            commandId: msg.commandId,
            sessionId: msg.sessionId,
            chatId: msg.chatId,
            machineId: config.machineId,
            opencodeClient: client,
            sendTelegramReply: createTelegramReplySender(sendTelegramMessage, msg),
          });
        },
        onMcpList: async (msg) => {
          if (await handleGooseControl("mcp", msg)) return;
          const client = clientForSession(msg.sessionId);
          if (!client) { console.warn(`[index] onMcpList: session ${msg.sessionId} not routable (no opencodeClient/healthy serve)`); return; }
          const directory = storage.sessions.get(msg.sessionId)?.cwd ?? undefined;
          await ingestMcpListCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            directory, machineId: config.machineId, opencodeClient: client,
            sendTelegramReply: createTelegramReplySender(sendTelegramMessage, msg),
          });
        },
        onMcpEnable: async (msg) => {
          if (await handleGooseControl("mcp", msg)) return;
          const client = clientForSession(msg.sessionId);
          if (!client) { console.warn(`[index] onMcpEnable: session ${msg.sessionId} not routable (no opencodeClient/healthy serve)`); return; }
          const directory = storage.sessions.get(msg.sessionId)?.cwd ?? undefined;
          await ingestMcpEnableCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            serverName: msg.serverName, directory, machineId: config.machineId, opencodeClient: client,
            sendTelegramReply: createTelegramReplySender(sendTelegramMessage, msg),
          });
        },
        onMcpDisable: async (msg) => {
          if (await handleGooseControl("mcp", msg)) return;
          const client = clientForSession(msg.sessionId);
          if (!client) { console.warn(`[index] onMcpDisable: session ${msg.sessionId} not routable (no opencodeClient/healthy serve)`); return; }
          const directory = storage.sessions.get(msg.sessionId)?.cwd ?? undefined;
          await ingestMcpDisableCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            serverName: msg.serverName, directory, machineId: config.machineId, opencodeClient: client,
            sendTelegramReply: createTelegramReplySender(sendTelegramMessage, msg),
          });
        },
        onModelList: async (msg) => {
          if (await handleGooseControl("model", msg)) return;
          const client = clientForSession(msg.sessionId);
          if (!client) { console.warn(`[index] onModelList: session ${msg.sessionId} not routable (no opencodeClient/healthy serve)`); return; }
          await ingestModelListCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            machineId: config.machineId, opencodeClient: client,
            sendTelegramReply: createTelegramReplySender(sendTelegramMessage, msg),
            allowedProviders: config.allowedProviders,
          });
        },
        onModelSet: async (msg) => {
          if (await handleGooseControl("model", msg)) return;
          const client = clientForSession(msg.sessionId);
          if (!client) { console.warn(`[index] onModelSet: session ${msg.sessionId} not routable (no opencodeClient/healthy serve)`); return; }
          await ingestModelSetCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            model: msg.model, machineId: config.machineId, opencodeClient: client,
            storage, sendTelegramReply: createTelegramReplySender(sendTelegramMessage, msg),
            allowedProviders: config.allowedProviders,
          });
        },
        onTagTop: async (msg) => {
          await ingestTagTopCommand(tagDeps(msg));
        },
        onTagList: async (msg) => {
          await ingestTagListCommand(tagDeps(msg));
        },
        onTagSet: async (msg) => {
          await ingestTagSetCommand({
            ...tagDeps(msg),
            targetSessionId: msg.targetSessionId,
            tag: msg.tag,
            // Without this the footer keeps showing the old tag (or nothing)
            // until the cache entry ages out, which reads as the command having
            // failed.
            onTagged: () => tagResolver.refreshNow(msg.targetSessionId),
          });
        },
        onTagSetDir: async (msg) => {
          await ingestTagSetDirCommand({
            ...tagDeps(msg),
            pattern: msg.pattern,
            tag: msg.tag,
            // A directory glob is retroactive and names no session, so there is
            // no smaller set to invalidate than everything.
            onTagged: () => tagResolver.clear(),
          });
        },
      },
      { healthMonitor: workerHealthMonitor },
    )
  : undefined;

if (poller) {
  poller.start();
}

const outboxSender = poller && config.telegramChatId
  ? new OutboxSender({
      storage,
      // The arrow wrapper is required: passing `poller.sendNotification` directly
      // detaches `this`, and the method dereferences `this.fetchFn`/`this.config`,
      // so it would throw at runtime. Do not "simplify" this to a bare reference.
      sendNotification: (input) => poller.sendNotification(input),
      registerSession: (sessionId, label) => poller.registerSession(sessionId, label),
      unregisterSession: (sessionId) => poller.unregisterSession(sessionId),
      chatId: config.telegramChatId,
      log: (msg, data) => console.log(`[outbox] ${msg}`, data ? JSON.stringify(data) : ""),
    })
  : undefined;

if (outboxSender) {
  outboxSender.start(5_000);
}

const telegramNotifier = config.telegramBotToken && config.telegramChatId
  ? new TelegramNotificationService(storage, config.telegramBotToken, config.telegramChatId, Date.now, fetch, config.machineId)
  : undefined;

const notifier: StopNotifier | undefined = telegramNotifier;

// Swarm IPC: per-target arbiter that delivers swarm_messages to opencode
// serve via prompt_async with at-most-one in-flight per target session.
// Requires opencode-client or ingress router.
const directoryForSession = makeDirectoryResolver({ ingressRouter, fallbackBaseUrl: config.opencodeUrl });

const swarmArbiter = (config.opencodeUrl || ingressRouter)
  ? new SwarmArbiter({
      storage,
      clientForSession,
      directoryForSession,
      log: (msg, fields) =>
        console.log(`[swarm-arbiter] ${msg}`, fields ? JSON.stringify(fields) : ""),
    })
  : undefined;

if (swarmArbiter) {
  swarmArbiter.start(500);
  console.log("[pigeon-daemon] swarm arbiter started (interval=500ms)");
} else {
  console.log("[pigeon-daemon] swarm arbiter NOT started (no opencodeUrl in config)");
}

// Operational alert drainer: sends queued operational alerts to Telegram.
// Note on notifier capability gate: sendPlainAlert is optional on StopNotifier. On a host
// with no TELEGRAM_BOT_TOKEN, there is no plain-alert notifier. Alerts are still enqueued in DB
// as an honest record of events; they are simply never drained. Do NOT mark them sent when no
// notifier exists — that would record a configuration fact as a delivery fact.
const alertDrainer = notifier?.sendPlainAlert
  ? new AlertDrainer({
      storage,
      notifier: notifier as AlertDrainerNotifier,
      log: (msg, fields) =>
        console.log(`[alert-drainer] ${msg}`, fields ? JSON.stringify(fields) : ""),
    })
  : undefined;

if (alertDrainer) {
  alertDrainer.start(DEFAULT_DRAIN_INTERVAL_MS);
  console.log(`[pigeon-daemon] alert drainer started (interval=${DEFAULT_DRAIN_INTERVAL_MS}ms)`);
} else {
  console.log(
    "[pigeon-daemon] alert drainer NOT started (no plain-alert notifier on this host; operational alerts recorded in DB, GET /swarm/scheduled is only channel)",
  );
}

// Cleanup terminal outbox entries and operational alerts every hour.
// Ordering property: abandonment MUST happen before cleanup in the same tick.
// A queued alert must never be deleted directly by cleanupOlderThan — only
// abandonOlderThan may retire it to 'abandoned', which is a recorded state change,
// not a deletion.
setInterval(() => {
  const now = Date.now();
  const sentCutoff = now - OUTBOX_RETENTION_MS;
  const failedCutoff = now - FAILED_RETENTION_MS;
  const cleaned = storage.outbox.cleanupOlderThan(sentCutoff, failedCutoff);
  if (cleaned > 0) console.log(`[outbox] cleaned ${cleaned} old entries`);

  const alertAbandonCutoff = now - ALERT_ABANDON_MS;
  const alertSentCutoff = now - ALERT_SENT_RETENTION_MS;
  const alertAbandonedCutoff = now - ALERT_ABANDONED_CREATED_RETENTION_MS;

  const abandoned = storage.alerts.abandonOlderThan(alertAbandonCutoff, now);
  if (abandoned > 0) console.warn(`[alerts] abandoned ${abandoned} unsent alerts older than 72h`);

  const alertsCleaned = storage.alerts.cleanupOlderThan(alertSentCutoff, alertAbandonedCutoff);
  if (alertsCleaned > 0) console.log(`[alerts] cleaned ${alertsCleaned} old entries`);

  const swarmCleaned = storage.swarm.cleanupOlderThan(now - SWARM_RETENTION_MS);
  if (swarmCleaned > 0) console.log(`[swarm] cleaned ${swarmCleaned} old messages`);

  // Unlike the swarm cleanup above, which spares 'queued' rows, every ledger row is
  // prunable: a row exists only because delivery already succeeded, so there is no
  // in-flight state to protect. session_reads is deliberately NOT pruned -- a
  // watermark is one row per session and outliving its events is exactly what
  // AUTOINCREMENT makes safe.
  const eventsCleaned = storage.sessionEvents.pruneOlderThan(now - SESSION_EVENTS_RETENTION_MS);
  if (eventsCleaned > 0) console.log(`[session-events] cleaned ${eventsCleaned} old rows`);
}, 60 * 60 * 1000);

// Reap stale Pigeon registry entries every hour. This must not delete opencode
// session history; opencode-serve is restarted separately for process hygiene.
if (poller) {
  startSessionReaper({
    storage,
    unregisterSession: async (sessionId) => {
      // A reaped goose session's runner still holds a websocket. Dropping the
      // row without the runner leaks the socket and leaves any turn reporting
      // into a session that no longer exists.
      gooseRunners?.drop(sessionId);
      return poller.unregisterSession(sessionId);
    },
    log: (msg) => console.log(`[reaper] ${msg}`),
  });
}

// Registry endpoint fencing (bead pigeon-13p). PIGEON_SERVE_ENDPOINTS is the
// authority for a pool slot's endpoint; the registry row is not. Any process that
// inherits OPENCODE_SERVE_ID + OPENCODE_ROUTING_DB can rewrite
// serve_instance.endpoint via registerSelf, and nothing else in the system can
// ever correct it: the real serve keeps the row's heartbeat fresh and healthy, and
// seedServes uses ON CONFLICT DO NOTHING so even a daemon restart won't repair it.
// On 2026-07-25 that routed 76 sessions at a closed port until it was fixed by
// hand. This reasserts the configured endpoint (that column ONLY) every tick, and
// the reassert firing is the alert.
//
// Deliberately NOT inside the `serveLiveness === "self"` branch above: that branch
// is host-dependent, and a repair that silently doesn't exist on `http` hosts is
// the failure mode this whole bead is about.
//
// NOTE on alert delivery: `StopNotifier.sendPlainAlert` is OPTIONAL
// (notification-service.ts), so on a host with no TELEGRAM_BOT_TOKEN there is no
// plain-alert notifier at all and drift alerts are dropped. The repair still happens.
// The startup line below states which of the two it is, so an undeliverable alert
// is visible once rather than invisible forever. Cannot use the durable outbox here:
// the worker's POST /notifications/send 404s unless `sessionId` exists in its
// sessions table, and an operational alert has no session — it would retry 10x and
// be marked failed with no user-visible signal.
const endpointReconciler = ingressRouter
  ? new ServeEndpointReconciler({
      serves: storage.serves,
      endpoints: config.serveEndpoints,
      notifier,
      machineId: config.machineId,
      log: (msg, fields) =>
        console.warn(`[endpoint-reconciler] ${msg}`, fields ? JSON.stringify(fields) : ""),
    })
  : undefined;

if (endpointReconciler) {
  // Repair once at boot (so a restart is still a cure) and then continuously.
  void endpointReconciler.safeTick();
  endpointReconciler.start(config.healthPollMs);
  console.log("[pigeon-daemon] serve endpoint reconciler started", JSON.stringify({
    intervalMs: config.healthPollMs,
    serves: config.serveEndpoints.length,
    alertDelivery: notifier?.sendPlainAlert ? "telegram" : "UNAVAILABLE (no plain-alert notifier)",
  }));
}

// Serve health transition observer (bead pigeon-f02) — records baseline and
// health state diffs across ticks.
//
// Wired OUTSIDE the `serveLiveness === "self"` branch above for the same reason
// as the endpoint reconciler: a monitoring signal that silently doesn't exist
// on `http` hosts is a trap during local testing or non-self deployments.
const healthTransitionObserver = ingressRouter
  ? new HealthTransitionObserver({
      serves: storage.serves,
      log: (msg, fields) =>
        console.warn(`[serve-health] ${msg}`, fields ? JSON.stringify(fields) : ""),
    })
  : undefined;

if (healthTransitionObserver) {
  void healthTransitionObserver.safeTick();
  healthTransitionObserver.start(config.healthPollMs);
  console.log("[pigeon-daemon] serve health transition observer started", JSON.stringify({
    intervalMs: config.healthPollMs,
    serves: config.serveEndpoints.length,
  }));
}

// Flap detector (bead pigeon-f2a) — increment 1 of the serve-serviceability arc.
//
// Ships BEFORE the verdict in pigeon-886 on purpose: that change introduces new
// health transitions, and a flapping slot is the failure mode that makes routing
// bugs unreproducible. June 2026 flapped for weeks — 2634 cumulative moves, one
// session moved 24 times, four in-flight turns killed — and was found by
// root-causing dead turns, never by an alert, because nothing on the path logged
// anything. The recorder in `placeSession` and this detector close that.
//
// Ticked far slower than the reconciler: the window is 15 minutes, so a 60s tick
// is ample, and it keeps three indexed queries plus a prune off the 5s path.
const FLAP_TICK_MS = 60_000;
const flapDetector = ingressRouter
  ? new FlapDetector({
      reassignments: storage.reassignments,
      notifier,
      machineId: config.machineId,
      log: (msg, fields) =>
        console.warn(`[flap-detector] ${msg}`, fields ? JSON.stringify(fields) : ""),
    })
  : undefined;

// Hourly is plenty: this is a base-rate estimate for threshold selection, not a
// monitoring signal. Emitting it more often would bury the flap alerts.
const OUTCOME_REPORT_MS = 60 * 60 * 1000;
if (outcomeSensor) {
  outcomeSensor.start(OUTCOME_REPORT_MS);
  console.log("[pigeon-daemon] serve outcome sensor started (SHADOW MODE)", JSON.stringify({
    reportIntervalMs: OUTCOME_REPORT_MS,
    note: "records refused/5xx per serve to calibrate pigeon-886; routing is NOT affected",
    excluded: "timeouts (design 5.1 C), 4xx, and the plugin direct channel",
  }));
}

if (flapDetector) {
  flapDetector.start(FLAP_TICK_MS);
  // Emit one summary immediately so a restart always leaves a positive record of
  // the current base rate, rather than a gap until the first hourly tick.
  flapDetector.reportNow();
  console.log("[pigeon-daemon] flap detector started", JSON.stringify({
    intervalMs: FLAP_TICK_MS,
    summaryIntervalMs: DEFAULT_SUMMARY_MS,
    windowMs: DEFAULT_WINDOW_MS,
    // Three arms, every one restart-invariant: a pool restart moves each session
    // exactly once, so no floor here can be reached by a deploy. Totals are never
    // a trigger — a totals rule fires on every deploy and gets muted.
    //
    // All PROVISIONAL and stated as such: no base rate for reassignment churn has
    // ever been recorded, which is why the sensor ships before the fix. The
    // original "5 is far below June's 24" argument was a category error (24 was
    // cumulative over WEEKS, ~1.3 moves per 15min window fleet-wide), which is
    // what the 24h slow-burn arm exists to cover. Re-tune under pigeon-u1u.3.
    arms: {
      burst: `${DEFAULT_PER_SESSION_MOVES} moves by one session / 15m (PROVISIONAL)`,
      breadth: `${DEFAULT_BREADTH_SESSIONS} sessions x ${DEFAULT_BREADTH_MOVES_EACH} moves / 15m (PROVISIONAL)`,
      slowBurn: `${DEFAULT_SLOW_BURN_MOVES} moves by one session / 24h (PROVISIONAL)`,
    },
    alertDelivery: notifier?.sendPlainAlert ? "telegram" : "UNAVAILABLE (no plain-alert notifier)",
  }));
}

// Delivery watchdog: periodically re-checks handed-off swarm messages that
// haven't verified an assistant run actually started, escalating alert ->
// abort+redeliver -> terminal. Gated the same way as the swarm arbiter
// (opencode-client or ingress router required) — no swarm delivery, nothing
// to watch.
const watchdogResolveClients = makeWatchdogResolveClients({
  ingressRouter,
  serveRegistry: storage.serves,
  routingMeta: storage.meta,
  clientFactory,
  staleServeMs: config.staleServeMs,
  singleClient: opencodeClient,
});

const deliveryWatchdog = (config.opencodeUrl || ingressRouter)
  ? new DeliveryWatchdog({
      storage,
      resolveClients: watchdogResolveClients,
      directoryForSession,
      notifier,
      intervalMs: config.watchdogIntervalMs,
      verifyAfterMs: config.verifyAfterMs,
      stuckAlertMs: config.stuckAlertMs,
      stuckAbortSilenceMs: config.stuckAbortSilenceMs,
      maxRequeues: config.maxRequeues,
      log: (msg, fields) =>
        console.log(`[delivery-watchdog] ${msg}`, fields ? JSON.stringify(fields) : ""),
    })
  : undefined;

if (deliveryWatchdog) {
  deliveryWatchdog.start(config.watchdogIntervalMs);
  console.log("[pigeon-daemon] delivery watchdog started", JSON.stringify({
    intervalMs: config.watchdogIntervalMs,
    verifyAfterMs: config.verifyAfterMs,
    stuckAlertMs: config.stuckAlertMs,
    stuckAbortSilenceMs: config.stuckAbortSilenceMs,
    maxRequeues: config.maxRequeues,
  }));
} else {
  console.log("[pigeon-daemon] delivery watchdog NOT started (no opencodeUrl in config)");
}

const app = createApp(storage, {
  notifier,
  tagLookup: tagResolver,
  chatId: config.telegramChatId,
  machineId: config.machineId,
  router: ingressRouter,
  authToken: config.authToken,
  isSchedulerRunning: () => swarmArbiter !== undefined,
  onSessionStart: async (sessionId, notify, label) => {
    if (notify && poller) {
      await poller.registerSession(sessionId, label ?? undefined);
    }
  },
  onSessionDelete: async (sessionId) => {
    // Drop the routing assignment so a deleted session can't yield a prospective
    // /route 200 (workstation-boi9).
    storage.assignments.delete(sessionId);
    // A goose session's runner holds a websocket; dropping the row without
    // dropping the runner would leak the socket and leave a turn reporting into
    // a session that no longer exists.
    gooseRunners?.drop(sessionId);
    if (poller) {
      // Interactive close: this fires on an explicit session delete (`/kill`, plugin session
      // teardown), where a human is watching, so the forum topic closes now rather than waiting
      // for the daily close window. Every janitorial unregister deliberately omits the flag —
      // see poller.unregisterSession and worker sessions.ts (pigeon-xehy).
      await poller.unregisterSession(sessionId, { immediate: true });
    }
  },
});
appHandler = app;

const server = startServer(config, app);

console.log(`[pigeon-daemon] listening on http://127.0.0.1:${server.port}`);
console.log(`[pigeon-daemon] auth: ${config.authToken ? "enabled" : "disabled"}`);

/**
 * Graceful shutdown (pigeon-8aob).
 *
 * The arbiter awaits `sendPrompt` and only THEN commits `markHandedOff`. Dying
 * in that window leaves the row `queued`, so the next daemon redelivers and the
 * target session is woken TWICE. Until this handler existed there was no signal
 * handling at all, which meant EVERY deploy was an abrupt kill and every deploy
 * rolled that dice.
 *
 * Scope, stated so nobody reads more into it: this closes the restarts WE
 * initiate. A hard crash (OOM, SIGKILL, power loss) runs no handler and is
 * unaffected, and duplicate-on-ambiguity remains deliberate policy on the
 * timeout path (see `isOutageFailure` in swarm/delivery-policy.ts). Delivery is
 * still at-least-once, by design.
 *
 * BUDGET ARITHMETIC, and why it is not a round number. The budget must EXCEED
 * the longest an in-flight iteration can legitimately take, or the drain gives
 * up on a send that was about to succeed -- exiting with the row still
 * `queued` and duplicating it anyway, which is the worst of both (we waited AND
 * duplicated). One iteration is bounded by a directory lookup
 * (DEFAULT_REGISTRY_TIMEOUT_MS, 10s) plus the prompt itself
 * (DEFAULT_REQUEST_TIMEOUT_MS in opencode-client.ts, 30s) = 40s. 45s leaves
 * margin. Targets drain concurrently, so this is wall-clock, not per-target.
 *
 * At 45s every in-flight promise settles by construction, so the deadline race
 * is a backstop rather than the mechanism: a send that succeeds commits
 * `markHandedOff`, and one that wedges resolves as RequestTimeoutError and
 * commits a COUNTED `markRetry` -- a recorded state either way, never an
 * ambiguous `queued`.
 *
 * Headroom: systemd TimeoutStopSec is 90s for this unit (verified on the live
 * unit, but it is defined in the workstation repo -- if it is ever lowered
 * below ~60s, lower this to match or we trade a clean drain for a SIGKILL
 * mid-write, the exact failure this exists to avoid).
 *
 * Cost, stated plainly: for up to 45s after SIGTERM the daemon is still fully
 * live -- it accepts new /swarm/send, and the poller still ingests. All of
 * that is durable, but the window is real and grows with this number.
 */
const SHUTDOWN_DRAIN_MS = 45_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  // A second Ctrl-C / SIGTERM must not start a second drain.
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[pigeon-daemon] ${signal} received, draining swarm arbiter...`);

  if (swarmArbiter) {
    try {
      const { drained, pending } = await swarmArbiter.drain(SHUTDOWN_DRAIN_MS);
      if (drained) {
        console.log("[pigeon-daemon] swarm arbiter drained cleanly");
      } else {
        // Not fatal, but it means we are exiting in the very window this
        // handler exists to avoid, so say so plainly rather than exiting 0 in
        // silence: the next process may redeliver those rows.
        console.warn(
          `[pigeon-daemon] swarm arbiter drain TIMED OUT after ${SHUTDOWN_DRAIN_MS}ms ` +
            `with ${pending} delivery(ies) still in flight; those rows may be redelivered`,
        );
      }
    } catch (err) {
      console.error("[pigeon-daemon] error while draining swarm arbiter", err);
    }
  }

  // Goose turns outlive this process. There is no cancel on goose's ACP surface
  // and a turn survives a client disconnect, so a turn in flight right now WILL
  // finish -- but its receipt arrives on a socket that is about to close, so
  // nobody will ever report it. Telling the human beats their message appearing
  // to vanish, which is indistinguishable from a bug in the adapter.
  const busy = gooseRunners?.busySessionIds() ?? [];
  if (busy.length > 0 && config.telegramChatId) {
    console.warn(`[pigeon-daemon] ${busy.length} goose turn(s) in flight at shutdown: ${busy.join(", ")}`);
    for (const sessionId of busy) {
      try {
        await sendTelegramMessage(
          config.telegramChatId,
          `pigeon is restarting while a goose turn was running on ${sessionId}. `
            + `goose cannot be interrupted, so the turn will finish on its side, but its `
            + `result will not be reported here. Send /status or ask again once it is done.`,
          { messageThreadId: undefined },
        );
      } catch (err) {
        console.warn(`[pigeon-daemon] could not warn about in-flight goose turn ${sessionId}:`, err);
      }
    }
  }
  gooseRunners?.closeAll();

  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
