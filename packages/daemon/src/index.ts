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
import { MachineAgent } from "./worker/machine-agent";

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

const machineAgent = config.workerUrl && config.workerApiKey && config.machineId
  ? new MachineAgent(
      {
        workerUrl: config.workerUrl,
        apiKey: config.workerApiKey,
        machineId: config.machineId,
        chatId: config.telegramChatId,
      },
      storage,
      {
        opencodeClient,
        sendTelegramMessage,
      },
    )
  : undefined;

if (machineAgent) {
  machineAgent.connect();
}

const workerNotifier = machineAgent && config.telegramChatId
  ? new WorkerNotificationService(storage, machineAgent, config.telegramChatId)
  : undefined;

const telegramNotifier = config.telegramBotToken && config.telegramChatId
  ? new TelegramNotificationService(storage, config.telegramBotToken, config.telegramChatId)
  : undefined;

const notifier = workerNotifier && telegramNotifier
  ? new FallbackStopNotifier(workerNotifier, telegramNotifier)
  : (workerNotifier ?? telegramNotifier);

const server = startServer(config, createApp(storage, {
  notifier,
  onSessionStart: async (sessionId, notify, label) => {
    if (notify && machineAgent) {
      await machineAgent.registerSession(sessionId, label ?? undefined);
    }
  },
  onSessionDelete: async (sessionId) => {
    if (machineAgent) {
      await machineAgent.unregisterSession(sessionId);
    }
  },
}));

console.log(`[pigeon-daemon] listening on http://127.0.0.1:${server.port}`);
