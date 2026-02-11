import type { DaemonConfig } from "./config";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const host = req.headers.host ?? "127.0.0.1";
  const url = `http://${host}${req.url ?? "/"}`;
  const method = req.method ?? "GET";

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  return new Request(url, { method, headers, body });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

export interface StartedServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export function startServer(
  config: DaemonConfig,
  fetchHandler: (request: Request) => Promise<Response>,
): StartedServer {
  const server = createServer(async (req, res) => {
    try {
      const request = await toRequest(req);
      const response = await fetchHandler(request);
      await writeResponse(res, response);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      const message = error instanceof Error ? error.message : String(error);
      res.end(JSON.stringify({ error: message }));
    }
  });

  server.listen(config.port);

  return {
    server,
    port: config.port,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
  };
}
