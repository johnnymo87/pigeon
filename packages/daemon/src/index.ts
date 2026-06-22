import { createApp } from "./app";
import { loadConfig } from "./config";
import {
  FallbackStopNotifier,
  TelegramNotificationService,
  WorkerNotificationService,
} from "./notification-service";
import { OpencodeClient } from "./opencode-client";
import { startServer } from "./server";
import { openStorageDb } from "./storage/database";
import { OUTBOX_RETENTION_MS } from "./storage/schema";
import { Poller } from "./worker/poller";
import { OutboxSender } from "./worker/outbox-sender";
import { SwarmArbiter } from "./swarm/arbiter";
import { SessionDirectoryRegistry } from "./swarm/registry";
import { ingestWorkerCommand } from "./worker/command-ingest";
import { ingestLaunchCommand } from "./worker/launch-ingest";
import { ingestKillCommand } from "./worker/kill-ingest";
import { ingestInterruptCommand } from "./worker/interrupt-ingest";
import { ingestCompactCommand } from "./worker/compact-ingest";
import { ingestMcpListCommand, ingestMcpEnableCommand, ingestMcpDisableCommand } from "./worker/mcp-ingest";
import { ingestModelListCommand, ingestModelSetCommand } from "./worker/model-ingest";
import { ingestCurrentStateCommand } from "./worker/current-state-ingest";
import { resolveMainSessionSids, makeLiveDeps } from "./main-session-allowlist";
import { startSessionReaper } from "./session-reaper";
import type { TgEntity } from "./telegram-message";
import { IngressRouter } from "./routing/router";
import { seedServes } from "./routing/serve-registry";
import { ServeHealthPoller } from "./routing/serve-health-poller";
import { OpencodeClientFactory } from "./routing/client-factory";
import { makeDirectoryResolver } from "./routing/directory-resolver";

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
  if (config.serveLiveness === "self") {
    const poller = new ServeHealthPoller(storage.serves, ingressRouter, { healthPollMs: config.healthPollMs });
    const selfLivenessTimer = setInterval(() => {
      poller.sweepStale(Date.now(), config.staleServeMs);
    }, config.healthPollMs);
    selfLivenessTimer.unref?.();
    console.log(`[pigeon-daemon] ingress router started with self-heartbeat liveness sweep (serves=${config.serveEndpoints.length})`);
  } else {
    healthPoller = new ServeHealthPoller(storage.serves, ingressRouter, { healthPollMs: config.healthPollMs });
    healthPoller.start();
    console.log(`[pigeon-daemon] ingress router started with HTTP polling liveness (serves=${config.serveEndpoints.length})`);
  }
  const sweepTimer = setInterval(() => ingressRouter.sweep(Date.now()), config.healthPollMs);
  sweepTimer.unref?.();
} else {
  console.log("[pigeon-daemon] ingress router NOT started (no serveEndpoints)");
}

const opencodeClient = config.opencodeUrl
  ? new OpencodeClient({ baseUrl: config.opencodeUrl })
  : undefined;

const clientFactory = ingressRouter ? new OpencodeClientFactory(ingressRouter) : undefined;
// Resolve the owning-serve client for a session; falls back to the legacy single client when routing is unconfigured.
const clientForSession = (sessionId: string): OpencodeClient | undefined =>
  clientFactory ? clientFactory.forSession(sessionId) : opencodeClient;

async function sendTelegramMessage(chatId: string, text: string, entities?: TgEntity[]): Promise<void> {
  if (!config.telegramBotToken) return;
  try {
    const apiBase = `https://api.telegram.org/bot${config.telegramBotToken}`;
    const payload: Record<string, unknown> = { chat_id: chatId, text };
    if (entities && entities.length > 0) {
      payload.entities = entities;
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

const poller = config.workerUrl && config.workerApiKey && config.machineId
  ? new Poller(
      {
        workerUrl: config.workerUrl,
        apiKey: config.workerApiKey,
        machineId: config.machineId,
        chatId: config.telegramChatId,
      },
      {
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
            sendTelegramReply: sendTelegramMessage,
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
            sendTelegramReply: sendTelegramMessage,
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
            sendTelegramReply: sendTelegramMessage,
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
            sendTelegramReply: sendTelegramMessage,
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
            sendTelegramReply: sendTelegramMessage,
          });
        },
        onMcpList: async (msg) => {
          const client = clientForSession(msg.sessionId);
          if (!client) { console.warn(`[index] onMcpList: session ${msg.sessionId} not routable (no opencodeClient/healthy serve)`); return; }
          const directory = storage.sessions.get(msg.sessionId)?.cwd ?? undefined;
          await ingestMcpListCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            directory, machineId: config.machineId, opencodeClient: client, sendTelegramReply: sendTelegramMessage,
          });
        },
        onMcpEnable: async (msg) => {
          const client = clientForSession(msg.sessionId);
          if (!client) { console.warn(`[index] onMcpEnable: session ${msg.sessionId} not routable (no opencodeClient/healthy serve)`); return; }
          const directory = storage.sessions.get(msg.sessionId)?.cwd ?? undefined;
          await ingestMcpEnableCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            serverName: msg.serverName, directory, machineId: config.machineId, opencodeClient: client,
            sendTelegramReply: sendTelegramMessage,
          });
        },
        onMcpDisable: async (msg) => {
          const client = clientForSession(msg.sessionId);
          if (!client) { console.warn(`[index] onMcpDisable: session ${msg.sessionId} not routable (no opencodeClient/healthy serve)`); return; }
          const directory = storage.sessions.get(msg.sessionId)?.cwd ?? undefined;
          await ingestMcpDisableCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            serverName: msg.serverName, directory, machineId: config.machineId, opencodeClient: client,
            sendTelegramReply: sendTelegramMessage,
          });
        },
        onModelList: async (msg) => {
          const client = clientForSession(msg.sessionId);
          if (!client) { console.warn(`[index] onModelList: session ${msg.sessionId} not routable (no opencodeClient/healthy serve)`); return; }
          await ingestModelListCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            machineId: config.machineId, opencodeClient: client, sendTelegramReply: sendTelegramMessage,
            allowedProviders: config.allowedProviders,
          });
        },
        onModelSet: async (msg) => {
          const client = clientForSession(msg.sessionId);
          if (!client) { console.warn(`[index] onModelSet: session ${msg.sessionId} not routable (no opencodeClient/healthy serve)`); return; }
          await ingestModelSetCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            model: msg.model, machineId: config.machineId, opencodeClient: client,
            storage, sendTelegramReply: sendTelegramMessage,
            allowedProviders: config.allowedProviders,
          });
        },
        onCurrentState: async (msg) => {
          if (!opencodeClient) { console.warn("[index] onCurrentState: no opencodeClient configured"); return; }
          await ingestCurrentStateCommand({
            commandId: msg.commandId,
            chatId: msg.chatId,
            machineId: config.machineId!,
            opencodeClient,
            enumerate: () => resolveMainSessionSids(
              makeLiveDeps(),
              () => storage.sessions.list({ active: true }).map(s => ({ sessionId: s.sessionId, pid: s.pid, lastSeen: s.lastSeen })),
            ),
            registerSession: (sid, label) => poller!.registerSession(sid, label),
            sendCard: (sid, text, entities) =>
              poller!.sendNotification(sid, msg.chatId, text, { inline_keyboard: [] }, undefined, undefined, entities)
                .then((res) => {
                  if (!res.ok) {
                    throw new Error("sendNotification returned ok=false");
                  }
                }),
            sendPlainText: (text, entities) => sendTelegramMessage(msg.chatId, text, entities),
          });
        },
      },
    )
  : undefined;

if (poller) {
  poller.start();
}

const outboxSender = poller && config.telegramChatId
  ? new OutboxSender({
      storage,
      sendNotification: (sessionId, chatId, text, replyMarkup, media, notificationId) =>
        poller.sendNotification(sessionId, chatId, text, replyMarkup as { inline_keyboard?: unknown[] }, media as Array<{ key: string; mime: string; filename: string }> | undefined, notificationId),
      chatId: config.telegramChatId,
      log: (msg, data) => console.log(`[outbox] ${msg}`, data ? JSON.stringify(data) : ""),
    })
  : undefined;

if (outboxSender) {
  outboxSender.start(5_000);
}

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

// Cleanup terminal outbox entries every hour
setInterval(() => {
  const cutoff = Date.now() - OUTBOX_RETENTION_MS;
  const cleaned = storage.outbox.cleanupOlderThan(cutoff);
  if (cleaned > 0) console.log(`[outbox] cleaned ${cleaned} old entries`);
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

const workerNotifier = poller && config.telegramChatId
  ? new WorkerNotificationService(storage, poller, config.telegramChatId, Date.now, config.machineId)
  : undefined;

const telegramNotifier = config.telegramBotToken && config.telegramChatId
  ? new TelegramNotificationService(storage, config.telegramBotToken, config.telegramChatId, Date.now, fetch, config.machineId)
  : undefined;

const notifier = workerNotifier && telegramNotifier
  ? new FallbackStopNotifier(workerNotifier, telegramNotifier)
  : (workerNotifier ?? telegramNotifier);

const server = startServer(config, createApp(storage, {
  notifier,
  chatId: config.telegramChatId,
  machineId: config.machineId,
  router: ingressRouter,
  authToken: config.authToken,
  onSessionStart: async (sessionId, notify, label) => {
    if (notify && poller) {
      await poller.registerSession(sessionId, label ?? undefined);
    }
  },
  onSessionDelete: async (sessionId) => {
    if (poller) {
      await poller.unregisterSession(sessionId);
    }
  },
}));

console.log(`[pigeon-daemon] listening on http://127.0.0.1:${server.port}`);
