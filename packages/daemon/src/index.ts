import { createApp } from "./app";
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
import { WorkerHealthMonitor } from "./worker/worker-health";
import { OutboxSender } from "./worker/outbox-sender";
import { SwarmArbiter } from "./swarm/arbiter";
import { AlertDrainer, DEFAULT_DRAIN_INTERVAL_MS, type AlertDrainerNotifier } from "./swarm/alert-drainer";
import { DeliveryWatchdog } from "./swarm/delivery-watchdog";
import { makeWatchdogResolveClients } from "./swarm/watchdog-client-resolver";
import { SessionDirectoryRegistry } from "./swarm/registry";
import { ingestWorkerCommand } from "./worker/command-ingest";
import { ingestLaunchCommand } from "./worker/launch-ingest";
import { ingestKillCommand } from "./worker/kill-ingest";
import { ingestInterruptCommand } from "./worker/interrupt-ingest";
import { ingestCompactCommand } from "./worker/compact-ingest";
import { ingestMcpListCommand, ingestMcpEnableCommand, ingestMcpDisableCommand } from "./worker/mcp-ingest";
import { ingestModelListCommand, ingestModelSetCommand } from "./worker/model-ingest";
import { createTelegramReplySender } from "./worker/reply-factory";
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
// Resolve the owning-serve client for a session; falls back to the legacy single client when routing is unconfigured.
const clientForSession = (sessionId: string): OpencodeClient | undefined =>
  clientFactory ? clientFactory.forSession(sessionId) : opencodeClient;

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
      console.warn(`[pigeon-daemon] sendTelegramMessage failed: ${res.status}`);
    }
  } catch (err) {
    console.warn("[pigeon-daemon] sendTelegramMessage fetch error:", err);
  }
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
          const client = clientForSession(msg.sessionId);
          await ingestWorkerCommand(storage, msg, {
            workerUrl: config.workerUrl,
            apiKey: config.workerApiKey,
            editNotification: (nid, text, rm, entities) => poller!.editNotification(nid, text, rm as { inline_keyboard?: unknown[] }, entities as unknown[] | undefined),
            machineId: config.machineId,
            ...(client ? { opencodeClient: client } : {}),
            sendTelegramReply: createTelegramReplySender(sendTelegramMessage, msg),
            unregisterSession: async (sessionId) => { if (poller) await poller.unregisterSession(sessionId); },
          });
        },
        onLaunch: async (msg) => {
          if (!opencodeClient) {
            console.warn("[pigeon-daemon] received launch command but no opencodeClient is configured");
            return;
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
            sendTelegramReply: createTelegramReplySender(sendTelegramMessage, msg),
          });
        },
        onKill: async (msg) => {
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
          const client = clientForSession(msg.sessionId);
          if (!client) { console.warn(`[index] onModelSet: session ${msg.sessionId} not routable (no opencodeClient/healthy serve)`); return; }
          await ingestModelSetCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            model: msg.model, machineId: config.machineId, opencodeClient: client,
            storage, sendTelegramReply: createTelegramReplySender(sendTelegramMessage, msg),
            allowedProviders: config.allowedProviders,
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
    unregisterSession: (sessionId) => poller.unregisterSession(sessionId),
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

const server = startServer(config, createApp(storage, {
  notifier,
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
    if (poller) {
      // Interactive close: this fires on an explicit session delete (`/kill`, plugin session
      // teardown), where a human is watching, so the forum topic closes now rather than waiting
      // for the daily close window. Every janitorial unregister deliberately omits the flag —
      // see poller.unregisterSession and worker sessions.ts (pigeon-xehy).
      await poller.unregisterSession(sessionId, { immediate: true });
    }
  },
}));

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

  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
