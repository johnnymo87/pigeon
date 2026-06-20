import { describe, expect, it, afterEach } from "vitest";
import { createApp } from "../../src/app";
import { openStorageDb, type StorageDb } from "../../src/storage/database";
import { IngressRouter } from "../../src/routing/router";

describe("GET /route endpoint", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function setupRouterAndApp(now: number, withRouter = true) {
    storage = openStorageDb(":memory:");
    
    const router = withRouter ? new IngressRouter(storage, {
      leaseTtlMs: 30000,
      staleServeMs: 10000,
      idleMigrateMs: 60000,
      dormantTtlMs: 120000,
      activeTurnCap: 10,
    }) : undefined;

    const app = createApp(storage, {
      nowFn: () => now,
      router,
    });

    return { app, router, storage };
  }

  it("Valid: session_id=ses_abc123 returns 200 with route details", async () => {
    const fixedNow = 1000;
    const { app, storage: db } = setupRouterAndApp(fixedNow);

    // seed ONE healthy serve
    db.serves.upsert({
      serveId: "serve-0",
      instanceUuid: "u0",
      endpoint: "http://127.0.0.1:4096",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: fixedNow,
      draining: false,
    });

    const res = await app(new Request("http://localhost/route?session_id=ses_abc123", { method: "GET" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      sessionId: "ses_abc123",
      serveId: "serve-0",
      instanceUuid: "u0",
      ownerGeneration: 1,
      apiBase: "http://127.0.0.1:4096",
      eventUrl: "http://127.0.0.1:4096/event?session_ids=ses_abc123",
      expiresAt: fixedNow + 30000,
    });
  });

  it("Bad id: session_id=garbage returns 400", async () => {
    const { app } = setupRouterAndApp(1000);
    const res = await app(new Request("http://localhost/route?session_id=garbage", { method: "GET" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "invalid session_id" });
  });

  it("Missing id: no session_id param returns 400", async () => {
    const { app } = setupRouterAndApp(1000);
    const res = await app(new Request("http://localhost/route", { method: "GET" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "invalid session_id" });
  });

  it("No router: createApp WITHOUT router option returns 503", async () => {
    const { app } = setupRouterAndApp(1000, false);
    const res = await app(new Request("http://localhost/route?session_id=ses_abc", { method: "GET" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "routing not configured" });
  });

  it("No healthy serve: router over storage with NO healthy serve returns 503 with Retry-After", async () => {
    const fixedNow = 1000;
    const { app, storage: db } = setupRouterAndApp(fixedNow);

    // seed ONE unhealthy/stale serve
    db.serves.upsert({
      serveId: "serve-0",
      instanceUuid: "u0",
      endpoint: "http://127.0.0.1:4096",
      binaryEpoch: 0,
      healthState: "unhealthy",
      heartbeatAt: fixedNow,
      draining: false,
    });

    const res = await app(new Request("http://localhost/route?session_id=ses_abc", { method: "GET" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "no healthy serve", retryAfter: 5 });
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("Idempotent: two GETs for the same session return the same serveId + ownerGeneration", async () => {
    const fixedNow = 1000;
    const { app, storage: db } = setupRouterAndApp(fixedNow);

    db.serves.upsert({
      serveId: "serve-0",
      instanceUuid: "u0",
      endpoint: "http://127.0.0.1:4096",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: fixedNow,
      draining: false,
    });

    const res1 = await app(new Request("http://localhost/route?session_id=ses_abc", { method: "GET" }));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();

    const res2 = await app(new Request("http://localhost/route?session_id=ses_abc", { method: "GET" }));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();

    expect(body1).toEqual(body2);
    expect(body1.ownerGeneration).toBe(1);
  });
});
