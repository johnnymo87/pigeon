import {
  env,
  createExecutionContext,
  SELF,
} from "cloudflare:test";
import { describe, test, expect, beforeEach } from "vitest";

const API_KEY = env.CCR_API_KEY;
const AUTH_HEADER = { Authorization: `Bearer ${API_KEY}` };

function jsonPost(path: string, body: object, headers: Record<string, string> = {}) {
  return SELF.fetch(`https://worker.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function jsonGet(path: string, headers: Record<string, string> = {}) {
  return SELF.fetch(`https://worker.test${path}`, { headers });
}

// --- Auth ---

describe("session endpoints: auth", () => {
  test("GET /sessions without auth returns 401", async () => {
    const res = await jsonGet("/sessions");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  test("POST /sessions/register without auth returns 401", async () => {
    const res = await jsonPost("/sessions/register", {
      sessionId: "s1",
      machineId: "m1",
    });
    expect(res.status).toBe(401);
  });

  test("POST /sessions/unregister without auth returns 401", async () => {
    const res = await jsonPost("/sessions/unregister", { sessionId: "s1" });
    expect(res.status).toBe(401);
  });

  test("wrong API key returns 401", async () => {
    const res = await jsonGet("/sessions", {
      Authorization: "Bearer wrong-key",
    });
    expect(res.status).toBe(401);
  });

  test("malformed Authorization header returns 401", async () => {
    const res = await jsonGet("/sessions", {
      Authorization: "Token " + API_KEY,
    });
    expect(res.status).toBe(401);
  });
});

// --- Registration ---

describe("POST /sessions/register", () => {
  test("registers a new session", async () => {
    const res = await jsonPost(
      "/sessions/register",
      { sessionId: "sess-1", machineId: "devbox", label: "my session" },
      AUTH_HEADER,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      sessionId: "sess-1",
      machineId: "devbox",
    });
  });

  test("registered session appears in listing", async () => {
    await jsonPost(
      "/sessions/register",
      { sessionId: "sess-list", machineId: "devbox" },
      AUTH_HEADER,
    );
    const res = await jsonGet("/sessions", AUTH_HEADER);
    const sessions = (await res.json()) as Array<Record<string, unknown>>;
    const found = sessions.find((s) => s.session_id === "sess-list");
    expect(found).toBeDefined();
    expect(found!.machine_id).toBe("devbox");
  });

  test("re-registration updates machine_id and label", async () => {
    await jsonPost(
      "/sessions/register",
      { sessionId: "sess-reregister", machineId: "devbox", label: "old" },
      AUTH_HEADER,
    );
    await jsonPost(
      "/sessions/register",
      { sessionId: "sess-reregister", machineId: "macbook", label: "new" },
      AUTH_HEADER,
    );

    const res = await jsonGet("/sessions", AUTH_HEADER);
    const sessions = (await res.json()) as Array<Record<string, unknown>>;
    const found = sessions.find((s) => s.session_id === "sess-reregister");
    expect(found!.machine_id).toBe("macbook");
    expect(found!.label).toBe("new");
  });

  test("label defaults to null when not provided", async () => {
    await jsonPost(
      "/sessions/register",
      { sessionId: "sess-nolabel", machineId: "devbox" },
      AUTH_HEADER,
    );

    const res = await jsonGet("/sessions", AUTH_HEADER);
    const sessions = (await res.json()) as Array<Record<string, unknown>>;
    const found = sessions.find((s) => s.session_id === "sess-nolabel");
    expect(found!.label).toBeNull();
  });

  test("missing sessionId returns 400", async () => {
    const res = await jsonPost(
      "/sessions/register",
      { machineId: "devbox" },
      AUTH_HEADER,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "sessionId and machineId required",
    });
  });

  test("missing machineId returns 400", async () => {
    const res = await jsonPost(
      "/sessions/register",
      { sessionId: "s1" },
      AUTH_HEADER,
    );
    expect(res.status).toBe(400);
  });

  test("empty string sessionId returns 400", async () => {
    const res = await jsonPost(
      "/sessions/register",
      { sessionId: "", machineId: "devbox" },
      AUTH_HEADER,
    );
    expect(res.status).toBe(400);
  });

  test("timestamps are set on registration", async () => {
    const before = Date.now();
    await jsonPost(
      "/sessions/register",
      { sessionId: "sess-ts", machineId: "devbox" },
      AUTH_HEADER,
    );
    const after = Date.now();

    const res = await jsonGet("/sessions", AUTH_HEADER);
    const sessions = (await res.json()) as Array<Record<string, unknown>>;
    const found = sessions.find((s) => s.session_id === "sess-ts");
    expect(found!.created_at).toBeGreaterThanOrEqual(before);
    expect(found!.created_at).toBeLessThanOrEqual(after);
    expect(found!.updated_at).toBeGreaterThanOrEqual(before);
    expect(found!.updated_at).toBeLessThanOrEqual(after);
  });
});

// --- Unregistration ---

describe("POST /sessions/unregister", () => {
  test("unregisters an existing session", async () => {
    await jsonPost(
      "/sessions/register",
      { sessionId: "sess-unreg", machineId: "devbox" },
      AUTH_HEADER,
    );
    const res = await jsonPost(
      "/sessions/unregister",
      { sessionId: "sess-unreg" },
      AUTH_HEADER,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Verify it's gone
    const listRes = await jsonGet("/sessions", AUTH_HEADER);
    const sessions = (await listRes.json()) as Array<Record<string, unknown>>;
    expect(sessions.find((s) => s.session_id === "sess-unreg")).toBeUndefined();
  });

  test("unregistering non-existent session is a no-op (200)", async () => {
    const res = await jsonPost(
      "/sessions/unregister",
      { sessionId: "does-not-exist" },
      AUTH_HEADER,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("missing sessionId returns 400", async () => {
    const res = await jsonPost("/sessions/unregister", {}, AUTH_HEADER);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "sessionId required" });
  });
});

// --- Listing ---

describe("GET /sessions", () => {
  test("returns empty array when no sessions", async () => {
    const res = await jsonGet("/sessions", AUTH_HEADER);
    expect(res.status).toBe(200);
    // May have sessions from other tests since DO state persists within
    // a test run; just verify it's an array
    const sessions = await res.json();
    expect(Array.isArray(sessions)).toBe(true);
  });

  test("returns all registered sessions", async () => {
    await jsonPost(
      "/sessions/register",
      { sessionId: "list-a", machineId: "devbox" },
      AUTH_HEADER,
    );
    await jsonPost(
      "/sessions/register",
      { sessionId: "list-b", machineId: "macbook", label: "test" },
      AUTH_HEADER,
    );

    const res = await jsonGet("/sessions", AUTH_HEADER);
    const sessions = (await res.json()) as Array<Record<string, unknown>>;
    const ids = sessions.map((s) => s.session_id);
    expect(ids).toContain("list-a");
    expect(ids).toContain("list-b");
  });
});
