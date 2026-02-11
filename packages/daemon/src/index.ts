import { createApp } from "./app";
import { loadConfig } from "./config";
import { TelegramNotificationService } from "./notification-service";
import { startServer } from "./server";
import { openStorageDb } from "./storage/database";

const config = loadConfig();
const storage = openStorageDb(config.dbPath);

const notifier = config.telegramBotToken && config.telegramChatId
  ? new TelegramNotificationService(storage, config.telegramBotToken, config.telegramChatId)
  : undefined;

const server = startServer(config, createApp(storage, { notifier }));

console.log(`[pigeon-daemon] listening on http://127.0.0.1:${server.port}`);
