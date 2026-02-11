import { createApp } from "./app";
import { loadConfig } from "./config";
import {
  FallbackStopNotifier,
  TelegramNotificationService,
  WorkerNotificationService,
} from "./notification-service";
import { startServer } from "./server";
import { openStorageDb } from "./storage/database";
import { MachineAgent } from "./worker/machine-agent";

const config = loadConfig();
const storage = openStorageDb(config.dbPath);

const machineAgent = config.workerUrl && config.workerApiKey && config.machineId
  ? new MachineAgent(
      {
        workerUrl: config.workerUrl,
        apiKey: config.workerApiKey,
        machineId: config.machineId,
        chatId: config.telegramChatId,
      },
      storage,
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
