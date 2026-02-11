import { loadConfig } from "./config";
import { startServer } from "./server";

const config = loadConfig();
const server = startServer(config);

console.log(`[pigeon-daemon] listening on http://127.0.0.1:${server.port}`);
