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
import { ingestWorkerCommand } from "./worker/command-ingest";
import { ingestLaunchCommand } from "./worker/launch-ingest";
import { ingestKillCommand } from "./worker/kill-ingest";
import { ingestCompactCommand } from "./worker/compact-ingest";
import { ingestMcpListCommand, ingestMcpEnableCommand, ingestMcpDisableCommand } from "./worker/mcp-ingest";
import { ingestModelListCommand, ingestModelSetCommand } from "./worker/model-ingest";
import { startSessionReaper } from "./session-reaper";

const config = loadConfig();
const storage = openStorageDb(config.dbPath);

const opencodeClient = config.opencodeUrl
  ? new OpencodeClient({ baseUrl: config.opencodeUrl })
  : undefined;

async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  if (!config.telegramBotToken) return;
  try {
    const apiBase = `https://api.telegram.org/bot${config.telegramBotToken}`;
    const res = await fetch(`${apiBase}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
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
          await ingestWorkerCommand(storage, msg, {
            workerUrl: config.workerUrl,
            apiKey: config.workerApiKey,
            editNotification: (nid, text, rm) => poller!.editNotification(nid, text, rm as { inline_keyboard?: unknown[] }),
            machineId: config.machineId,
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
            sendTelegramReply: sendTelegramMessage,
          });
        },
        onKill: async (msg) => {
          if (!opencodeClient) {
            console.warn("[pigeon-daemon] received kill command but no opencodeClient is configured");
            return;
          }
          await ingestKillCommand({
            commandId: msg.commandId,
            sessionId: msg.sessionId,
            chatId: msg.chatId,
            machineId: config.machineId,
            opencodeClient,
            sendTelegramReply: sendTelegramMessage,
          });
        },
        onCompact: async (msg) => {
          if (!opencodeClient) {
            console.warn("[pigeon-daemon] received compact command but no opencodeClient is configured");
            return;
          }
          await ingestCompactCommand({
            commandId: msg.commandId,
            sessionId: msg.sessionId,
            chatId: msg.chatId,
            machineId: config.machineId,
            opencodeClient,
            sendTelegramReply: sendTelegramMessage,
          });
        },
        onMcpList: async (msg) => {
          if (!opencodeClient) { console.warn("[index] onMcpList: no opencodeClient configured"); return; }
          await ingestMcpListCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            machineId: config.machineId, opencodeClient, sendTelegramReply: sendTelegramMessage,
          });
        },
        onMcpEnable: async (msg) => {
          if (!opencodeClient) { console.warn("[index] onMcpEnable: no opencodeClient configured"); return; }
          await ingestMcpEnableCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            serverName: msg.serverName, machineId: config.machineId, opencodeClient,
            sendTelegramReply: sendTelegramMessage,
          });
        },
        onMcpDisable: async (msg) => {
          if (!opencodeClient) { console.warn("[index] onMcpDisable: no opencodeClient configured"); return; }
          await ingestMcpDisableCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            serverName: msg.serverName, machineId: config.machineId, opencodeClient,
            sendTelegramReply: sendTelegramMessage,
          });
        },
        onModelList: async (msg) => {
          if (!opencodeClient) { console.warn("[index] onModelList: no opencodeClient configured"); return; }
          await ingestModelListCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            machineId: config.machineId, opencodeClient, sendTelegramReply: sendTelegramMessage,
          });
        },
        onModelSet: async (msg) => {
          if (!opencodeClient) { console.warn("[index] onModelSet: no opencodeClient configured"); return; }
          await ingestModelSetCommand({
            commandId: msg.commandId, sessionId: msg.sessionId, chatId: msg.chatId,
            model: msg.model, machineId: config.machineId, opencodeClient,
            storage, sendTelegramReply: sendTelegramMessage,
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

// Cleanup terminal outbox entries every hour
setInterval(() => {
  const cutoff = Date.now() - OUTBOX_RETENTION_MS;
  const cleaned = storage.outbox.cleanupOlderThan(cutoff);
  if (cleaned > 0) console.log(`[outbox] cleaned ${cleaned} old entries`);
}, 60 * 60 * 1000);

// Reap stale sessions every hour
if (opencodeClient && poller) {
  startSessionReaper({
    storage,
    deleteSession: (sessionId) => opencodeClient.deleteSession(sessionId),
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
