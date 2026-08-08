import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";

describe("Daemon Auth", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(authToken?: string) {
    storage = openStorageDb(":memory:");
    return createApp(storage, {
      nowFn: () => 1_000,
      authToken,
    });
  }

  it("1. Disabled (back-compat): createApp WITHOUT authToken -> normal non-401 status", async () => {
    const app = newApp();
    const cleanup = await app(new Request("http://localhost/cleanup", { method: "POST" }));
    expect(cleanup.status).not.toBe(401);
    expect(cleanup.status).toBe(200);

    const health = await app(new Request("http://localhost/health"));
    expect(health.status).toBe(200);

    const sessions = await app(new Request("http://localhost/sessions"));
    expect(sessions.status).not.toBe(401);

    const sessionDetail = await app(new Request("http://localhost/sessions/ses_123"));
    expect(sessionDetail.status).not.toBe(401);

    const swarmInbox = await app(new Request("http://localhost/swarm/inbox?session=ses_123"));
    expect(swarmInbox.status).not.toBe(401);

    const route = await app(new Request("http://localhost/route?session_id=ses_x"));
    expect(route.status).not.toBe(401);

    const place = await app(new Request("http://localhost/place", { method: "POST" }));
    expect(place.status).not.toBe(401);
  });

  it("2. Enabled, missing header: token set -> GET /sessions, GET /sessions/:id, GET /swarm/inbox, GET /route, POST /place, POST /cleanup -> ALL 401", async () => {
    const app = newApp("secret");

    const targets = [
      new Request("http://localhost/sessions"),
      new Request("http://localhost/sessions/ses_123"),
      new Request("http://localhost/swarm/inbox?session=ses_123"),
      new Request("http://localhost/route?session_id=ses_x"),
      new Request("http://localhost/place", { method: "POST" }),
      new Request("http://localhost/cleanup", { method: "POST" }),
      new Request("http://localhost/session-origin?session_id=ses_123", { method: "DELETE" }),
    ];

    for (const req of targets) {
      const res = await app(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("unauthorized");
      // The hint is the actionable half: it must name the token path and the
      // stale-client cause, or it is not doing its job.
      expect(body.hint).toContain("/run/secrets/pigeon_daemon_auth_token");
      expect(body.hint).toContain("restarted");
    }
  });

  it("3. Enabled, correct header: token set + Bearer secret -> all routes NOT 401", async () => {
    const app = newApp("secret");
    const headers = { "Authorization": "Bearer secret" };

    const cleanup = await app(new Request("http://localhost/cleanup", { method: "POST", headers }));
    expect(cleanup.status).not.toBe(401);

    const sessions = await app(new Request("http://localhost/sessions", { headers }));
    expect(sessions.status).not.toBe(401);

    const sessionDetail = await app(new Request("http://localhost/sessions/ses_123", { headers }));
    expect(sessionDetail.status).not.toBe(401);

    const swarmInbox = await app(new Request("http://localhost/swarm/inbox?session=ses_123", { headers }));
    expect(swarmInbox.status).not.toBe(401);

    const route = await app(new Request("http://localhost/route?session_id=ses_x", { headers }));
    expect(route.status).not.toBe(401);

    const place = await app(new Request("http://localhost/place", { method: "POST", headers }));
    expect(place.status).not.toBe(401);
  });

  it("4. Enabled, wrong header: token set + Bearer nope -> 401", async () => {
    const app = newApp("secret");
    const headers = { "Authorization": "Bearer nope" };

    for (const path of ["/sessions", "/swarm/inbox?session=ses_123", "/cleanup"]) {
      const res = await app(new Request(`http://localhost${path}`, {
        method: path === "/cleanup" ? "POST" : "GET",
        headers,
      }));
      expect(res.status).toBe(401);
    }
  });

  it("5. Health open anonymously with token set: GET /health -> 200", async () => {
    const app = newApp("secret");
    const response = await app(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, service: "pigeon-daemon" });
  });

  it("10. Outbox stats open anonymously with token set: GET /outbox/stats -> 200", async () => {
    const app = newApp("secret");
    const response = await app(new Request("http://localhost/outbox/stats"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      states: { queued: 0, sending: 0, sent: 0, failed: 0 },
      failedReasons: {},
      oldestQueuedAgeMs: null,
    });
  });

  it("6. Control route protected: GET /route?session_id=ses_x with token set + no header -> 401; with correct header -> not 401", async () => {
    const app = newApp("secret");
    
    // No header
    const response1 = await app(new Request("http://localhost/route?session_id=ses_x"));
    expect(response1.status).toBe(401);

    // Correct header
    const response2 = await app(new Request("http://localhost/route?session_id=ses_x", {
      headers: { "Authorization": "Bearer secret" },
    }));
    expect(response2.status).not.toBe(401);
  });

  it("7. Read route protected: GET /sessions with token set + no header -> 401", async () => {
    const app = newApp("secret");
    const response = await app(new Request("http://localhost/sessions"));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("unauthorized");
  });

  it("8. Unmatched/unknown path behavior when token set: missing bearer -> 401; correct bearer -> 404", async () => {
    const app = newApp("secret");

    // Without bearer: returns 401 (deny-by-default before routing hides route existence)
    const resNoAuth = await app(new Request("http://localhost/nonexistent"));
    expect(resNoAuth.status).toBe(401);

    // With correct bearer: passes auth check and hits 404 handler
    const resWithAuth = await app(new Request("http://localhost/nonexistent", {
      headers: { "Authorization": "Bearer secret" },
    }));
    expect(resWithAuth.status).toBe(404);
  });

  it("9. OPTIONS/HEAD requests behavior when token set: missing bearer -> 401; correct bearer -> NOT 401", async () => {
    const app = newApp("secret");

    // OPTIONS without bearer -> 401
    const resOptionsNoAuth = await app(new Request("http://localhost/sessions", { method: "OPTIONS" }));
    expect(resOptionsNoAuth.status).toBe(401);

    // HEAD without bearer -> 401
    const resHeadNoAuth = await app(new Request("http://localhost/sessions", { method: "HEAD" }));
    expect(resHeadNoAuth.status).toBe(401);

    // OPTIONS with correct bearer -> NOT 401 (passes auth check)
    const resOptionsAuth = await app(new Request("http://localhost/sessions", {
      method: "OPTIONS",
      headers: { "Authorization": "Bearer secret" },
    }));
    expect(resOptionsAuth.status).not.toBe(401);

    // HEAD with correct bearer -> NOT 401 (passes auth check)
    const resHeadAuth = await app(new Request("http://localhost/sessions", {
      method: "HEAD",
      headers: { "Authorization": "Bearer secret" },
    }));
    expect(resHeadAuth.status).not.toBe(401);
  });
});
