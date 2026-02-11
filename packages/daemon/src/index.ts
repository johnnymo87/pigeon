import { createApp } from "./app";
import { loadConfig } from "./config";
import { startServer } from "./server";
import { openStorageDb } from "./storage/database";

const config = loadConfig();
const storage = openStorageDb(config.dbPath);
const server = startServer(config, createApp(storage));

console.log(`[pigeon-daemon] listening on http://127.0.0.1:${server.port}`);
