import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { makeDirectoryResolver } from "../../src/routing/directory-resolver";
import type { RouteResult } from "../../src/routing/types";

describe("makeDirectoryResolver", () => {
  let fakeA: { server: Server; url: string; receivedIds: string[] } | null = null;

  beforeAll(async () => {
    const receivedIds: string[] = [];
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/session/")) {
        const parts = req.url.split("/");
        const id = parts[parts.length - 1] || "";
        receivedIds.push(id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id, directory: `/resolved-dir-${id}` }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "string" ? 0 : addr?.port;
        fakeA = { server, url: `http://127.0.0.1:${port}`, receivedIds };
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (fakeA) {
      await new Promise<void>((res) => fakeA!.server.close(() => res()));
    }
  });

  it("uses fallbackBaseUrl when resolveRoute returns null", async () => {
    const mockRouter = {
      resolveRoute: (): RouteResult | null => null,
    };
    const resolver = makeDirectoryResolver({
      ingressRouter: mockRouter,
      fallbackBaseUrl: fakeA!.url,
    });

    const dir = await resolver("session-fallback");
    expect(dir).toBe("/resolved-dir-session-fallback");
    expect(fakeA!.receivedIds).toContain("session-fallback");
  });

  it("returns undefined when resolveRoute returns null and no fallback is provided", async () => {
    const mockRouter = {
      resolveRoute: (): RouteResult | null => null,
    };
    const resolver = makeDirectoryResolver({
      ingressRouter: mockRouter,
      fallbackBaseUrl: undefined,
    });

    const dir = await resolver("session-no-fallback");
    expect(dir).toBeUndefined();
  });

  it("queries the resolved apiBase when resolveRoute returns an apiBase", async () => {
    const mockRouter = {
      resolveRoute: (sessionId: string): RouteResult | null => {
        if (sessionId === "session-routed") {
          return {
            sessionId,
            serveId: "serve-0",
            instanceUuid: "uuid-0",
            ownerGeneration: 1,
            apiBase: fakeA!.url,
            eventUrl: `${fakeA!.url}/event`,
            expiresAt: Date.now() + 5000,
          };
        }
        return null;
      },
    };

    const resolver = makeDirectoryResolver({
      ingressRouter: mockRouter,
    });

    const dir = await resolver("session-routed");
    expect(dir).toBe("/resolved-dir-session-routed");
  });
});
