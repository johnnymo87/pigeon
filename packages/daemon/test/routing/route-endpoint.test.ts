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

  it("Placed session: GET returns 200 with route details", async () => {
    const fixedNow = 1000;
    const { app, router, storage: db } = setupRouterAndApp(fixedNow);

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

    // The session was legitimately placed by an in-process path (e.g. a
    // control command or swarm message via forSession -> ensureRouted).
    router!.placeSession("ses_abc123", fixedNow);

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

  it("Idle session, single serve unhealthy, no live lease -> 404 (empty healthy pool)", async () => {
    // With a SECOND healthy serve this same scenario returns a prospective re-pick
    // (see the "200 prospective re-pick" test above). With only one, unhealthy serve
    // the healthy pool is empty so prospective also yields null -> 404 -> consumer
    // falls back to the default serve.
    const t0 = 1000;
    const { app, storage: db } = setupRouterAndApp(t0);
    db.serves.upsert({ serveId: "serve-0", instanceUuid: "u0", endpoint: "http://127.0.0.1:4096", binaryEpoch: 0, healthState: "unhealthy", heartbeatAt: t0, draining: false });
    db.assignments.upsert({ sessionId: "ses_abc", directoryKey: null, desiredServeId: "serve-0", ownerGeneration: 1, state: "dormant", lastPlacedAt: t0, updatedAt: t0 });
    const res = await app(new Request("http://localhost/route?session_id=ses_abc", { method: "GET" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session not routed" });
  });

  it("Idempotent: two GETs for the same placed session return the same serveId + ownerGeneration", async () => {
    const fixedNow = 1000;
    const { app, router, storage: db } = setupRouterAndApp(fixedNow);

    db.serves.upsert({
      serveId: "serve-0",
      instanceUuid: "u0",
      endpoint: "http://127.0.0.1:4096",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: fixedNow,
      draining: false,
    });
    router!.placeSession("ses_abc", fixedNow);

    const res1 = await app(new Request("http://localhost/route?session_id=ses_abc", { method: "GET" }));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();

    const res2 = await app(new Request("http://localhost/route?session_id=ses_abc", { method: "GET" }));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();

    expect(body1).toEqual(body2);
    expect(body1.ownerGeneration).toBe(1);
  });

  it("Phantom-write regression: GET /route for an unplaced session returns 404 and creates NO assignment/lease", async () => {
    const fixedNow = 1000;
    const { app, storage: db } = setupRouterAndApp(fixedNow);

    // A healthy serve exists, but the session has NEVER been placed.
    db.serves.upsert({
      serveId: "serve-0",
      instanceUuid: "u0",
      endpoint: "http://127.0.0.1:4096",
      binaryEpoch: 0,
      healthState: "healthy",
      heartbeatAt: fixedNow,
      draining: false,
    });

    const sid = "ses_phantom999";
    const res = await app(new Request(`http://localhost/route?session_id=${sid}`, { method: "GET" }));

    // A read endpoint must NOT manufacture a route for a session that doesn't exist.
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "session not routed" });

    // And it must leave NO durable routing state behind.
    expect(db.assignments.get(sid)).toBeNull();
    expect(db.leases.get(sid)).toBeNull();
  });

  it("Idle real session (dormant assignment, no lease) -> 200 prospective", async () => {
    const t0 = 1000;
    const { app, storage: db } = setupRouterAndApp(t0);
    db.serves.upsert({ serveId: "serve-0", instanceUuid: "u0", endpoint: "http://127.0.0.1:4096", binaryEpoch: 0, healthState: "healthy", heartbeatAt: t0, draining: false });
    db.assignments.upsert({ sessionId: "ses_idle1", directoryKey: null, desiredServeId: "serve-0", ownerGeneration: 1, state: "dormant", lastPlacedAt: t0, updatedAt: t0 });
    const res = await app(new Request("http://localhost/route?session_id=ses_idle1", { method: "GET" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apiBase).toBe("http://127.0.0.1:4096");
    expect(body.prospective).toBe(true);
    expect(db.leases.get("ses_idle1")).toBeNull();
  });

  it("Idle, assigned serve dead + a second healthy serve -> 200 prospective re-pick", async () => {
    const t0 = 1000;
    const { app, storage: db } = setupRouterAndApp(t0);
    db.serves.upsert({ serveId: "serve-0", instanceUuid: "u0", endpoint: "http://127.0.0.1:4096", binaryEpoch: 0, healthState: "unhealthy", heartbeatAt: t0, draining: false });
    db.serves.upsert({ serveId: "serve-1", instanceUuid: "u1", endpoint: "http://127.0.0.1:4097", binaryEpoch: 0, healthState: "healthy", heartbeatAt: t0, draining: false });
    db.assignments.upsert({ sessionId: "ses_idle2", directoryKey: null, desiredServeId: "serve-0", ownerGeneration: 1, state: "dormant", lastPlacedAt: t0, updatedAt: t0 });
    const res = await app(new Request("http://localhost/route?session_id=ses_idle2", { method: "GET" }));
    expect(res.status).toBe(200);
    expect((await res.json()).serveId).toBe("serve-1");
  });

  it("Deleted session (assignment removed) -> 404", async () => {
    const t0 = 1000;
    const { app, storage: db } = setupRouterAndApp(t0);
    db.serves.upsert({ serveId: "serve-0", instanceUuid: "u0", endpoint: "http://127.0.0.1:4096", binaryEpoch: 0, healthState: "healthy", heartbeatAt: t0, draining: false });
    db.assignments.upsert({ sessionId: "ses_del", directoryKey: null, desiredServeId: "serve-0", ownerGeneration: 1, state: "dormant", lastPlacedAt: t0, updatedAt: t0 });
    db.assignments.delete("ses_del");
    const res = await app(new Request("http://localhost/route?session_id=ses_del", { method: "GET" }));
    expect(res.status).toBe(404);
  });

  describe("POST /place endpoint", () => {
    it("places an unplaced session -> returns a serve_id + api_base; an assignment row now exists", async () => {
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

      const res = await app(new Request("http://localhost/place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "ses_unplaced1" }),
      }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        ok: true,
        session_id: "ses_unplaced1",
        serve_id: "serve-0",
        api_base: "http://127.0.0.1:4096",
        event_url: "http://127.0.0.1:4096/event?session_ids=ses_unplaced1",
        owner_generation: 1,
        instance_uuid: "u0",
        expires_at: fixedNow + 30000,
      });

      const assignment = db.assignments.get("ses_unplaced1");
      expect(assignment).not.toBeNull();
      expect(assignment!.desiredServeId).toBe("serve-0");
    });

    it("IDEMPOTENT: calling /place twice for the same session returns the SAME serve_id", async () => {
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

      const res1 = await app(new Request("http://localhost/place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "ses_idempotent" }),
      }));
      expect(res1.status).toBe(200);
      const body1 = await res1.json();

      const res2 = await app(new Request("http://localhost/place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "ses_idempotent" }),
      }));
      expect(res2.status).toBe(200);
      const body2 = await res2.json();

      expect(body1).toEqual(body2);
      expect(body1.serve_id).toBe("serve-0");
    });

    it("400 when session_id missing", async () => {
      const { app } = setupRouterAndApp(1000);
      const res = await app(new Request("http://localhost/place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({ error: "session_id is required" });
    });

    it("spreads across multiple healthy serves when placing many distinct session ids (HRW)", async () => {
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
      db.serves.upsert({
        serveId: "serve-1",
        instanceUuid: "u1",
        endpoint: "http://127.0.0.1:4097",
        binaryEpoch: 0,
        healthState: "healthy",
        heartbeatAt: fixedNow,
        draining: false,
      });

      const serveIds = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const res = await app(new Request("http://localhost/place", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: `ses_test_${i}` }),
        }));
        expect(res.status).toBe(200);
        const body = await res.json();
        serveIds.add(body.serve_id);
      }

      // Assert that we used both serves (i.e. we spread them and didn't land all on one)
      expect(serveIds.size).toBe(2);
      expect(serveIds.has("serve-0")).toBe(true);
      expect(serveIds.has("serve-1")).toBe(true);
    });

    it("503 when no healthy serve", async () => {
      const { app } = setupRouterAndApp(1000);
      // We do not seed any healthy serves!
      const res = await app(new Request("http://localhost/place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "ses_no_healthy" }),
      }));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ error: "no healthy serve" });
    });
  });
});
