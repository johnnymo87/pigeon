import type { DaemonConfig } from "./config";

export function startServer(
  config: DaemonConfig,
  fetchHandler: (request: Request) => Promise<Response>,
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: config.port,
    fetch: fetchHandler,
  });
}
