import type { DaemonConfig } from "./config";
import { handleRequest } from "./app";

export function startServer(config: DaemonConfig): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: config.port,
    fetch: handleRequest,
  });
}
