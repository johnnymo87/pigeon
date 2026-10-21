/**
 * Per-machine worker credentials (pigeon-k0qn.8). Requests go through the real router
 * (`worker.fetch`) so routing, auth and the handlers are exercised together; `env` is
 * spread per test where a var (`SHARED_KEY_REFUSED_MACHINES`) needs a different value.
 */
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import worker from "../src/index";
import {
  authenticate,
  clearCredentialCache,
  sha256Hex,
  MACHINE_KEY_PATTERN,
  CREDENTIAL_CACHE_TTL_MS,
} from "../src/credentials";
import { REGISTER_TAKEOVER_STALE_MS } from "../src/sessions";

const SHARED = "test-api-key";
// Two well-formed keys: `pgk_` + 43 base64url chars.
const KEY_A = "pgk_" + "A".repeat(43);
const KEY_B = "pgk_" + "B".repeat(43);
const KEY_REVOKED = "pgk_" + "C".repeat(43);
const M_A = "cred-alpha";
const M_B = "cred-beta";

async function call(
  path: string,
  key: string | null,
  init: { method?: string; body?: unknown; envOverride?: Partial<Env> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  const request = new Request(`https://worker${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return worker.fetch(request, { ...env, ...(init.envOverride ?? {}) } as Env);
}

async function addKey(key: string, machineId: string, revoked = false): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO machine_credentials (key_sha256, machine_id, created_at, revoked_at, note)
     VALUES (?, ?, ?, ?, 'test')`,
  )
    .bind(await sha256Hex(key), machineId, Date.now(), revoked ? Date.now() : null)
    .run();
}

async function seedCommand(commandId: string, machineId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO commands (command_id, machine_id, session_id, command_type, command,
                                      chat_id, status, created_at)
     VALUES (?, ?, NULL, 'execute', 'x', '8248645256', 'leased', ?)`,
  )
    .bind(commandId, machineId, Date.now())
    .run();
}

async function ownerOf(sessionId: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT machine_id FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<{ machine_id: string }>();
  return row?.machine_id;
}

async function lastPoll(machineId: string): Promise<number | undefined> {
  const row = await env.DB.prepare("SELECT last_poll_at FROM machines WHERE machine_id = ?")
    .bind(machineId)
    .first<{ last_poll_at: number }>();
  return row?.last_poll_at;
}

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  clearCredentialCache();
  await env.DB.prepare("DELETE FROM machine_credentials").run();
  await env.DB.prepare("DELETE FROM sessions WHERE session_id LIKE 'ses_cred%'").run();
  await env.DB.prepare("DELETE FROM commands WHERE command_id LIKE 'cred-%'").run();
  await env.DB.prepare("DELETE FROM machines WHERE machine_id LIKE 'cred-%'").run();
  await addKey(KEY_A, M_A);
  await addKey(KEY_B, M_B);
  await addKey(KEY_REVOKED, M_A, true);
});

describe("authenticate", () => {
  const req = (key: string) =>
    new Request("https://worker/x", { headers: { Authorization: `Bearer ${key}` } });

  it("resolves the shared key without touching machine_credentials", async () => {
    expect(await authenticate(req(SHARED), env)).toEqual({ kind: "shared" });
  });

  it("resolves a registered per-machine key to its machine", async () => {
    expect(await authenticate(req(KEY_A), env)).toEqual({ kind: "machine", machineId: M_A });
  });

  it("refuses a revoked key, an unknown key, a malformed key and no header", async () => {
    expect(await authenticate(req(KEY_REVOKED), env)).toBeNull();
    expect(await authenticate(req("pgk_" + "Z".repeat(43)), env)).toBeNull();
    expect(await authenticate(req("not-a-key"), env)).toBeNull();
    expect(await authenticate(new Request("https://worker/x"), env)).toBeNull();
  });

  it("hashes exactly as the mint script does (hex SHA-256 of the UTF-8 key)", async () => {
    // Computed with node:crypto, which is what scripts/machine-key.mjs uses.
    expect(await sha256Hex(KEY_A)).toBe(
      "fcde8ecc157cac6f713440e6a57385f96b909d55b9f8a4f386df731e861d749b",
    );
  });

  it("the key shape it accepts is the one the mint script produces", () => {
    expect(MACHINE_KEY_PATTERN.test(KEY_A)).toBe(true);
    expect(MACHINE_KEY_PATTERN.test(KEY_A + "x")).toBe(false);
  });

  it("caches a hit, so revocation takes effect within the TTL, not instantly", async () => {
    const now = 1_000_000;
    expect(await authenticate(req(KEY_A), env, now)).toEqual({ kind: "machine", machineId: M_A });
    await addKey(KEY_A, M_A, true);
    expect(await authenticate(req(KEY_A), env, now + 1)).toEqual({ kind: "machine", machineId: M_A });
    expect(await authenticate(req(KEY_A), env, now + CREDENTIAL_CACHE_TTL_MS + 1)).toBeNull();
  });

  it("never caches a miss, so a newly registered key works at once", async () => {
    const fresh = "pgk_" + "D".repeat(43);
    expect(await authenticate(req(fresh), env)).toBeNull();
    await addKey(fresh, M_B);
    expect(await authenticate(req(fresh), env)).toEqual({ kind: "machine", machineId: M_B });
  });

  it("reads a missing table as no per-machine keys", async () => {
    const broken = {
      ...env,
      DB: {
        prepare: () => ({
          bind: () => ({ first: async () => { throw new Error("D1_ERROR: no such table: machine_credentials"); } }),
        }),
      },
    } as unknown as Env;
    expect(await authenticate(req(KEY_A), broken)).toBeNull();
    expect(await authenticate(req(SHARED), broken)).toEqual({ kind: "shared" });
  });

  it("throws on any other D1 failure instead of answering 401", async () => {
    const broken = {
      ...env,
      DB: {
        prepare: () => ({
          bind: () => ({ first: async () => { throw new Error("D1_ERROR: network connection lost"); } }),
        }),
      },
    } as unknown as Env;
    await expect(authenticate(req(KEY_A), broken)).rejects.toThrow(/network connection lost/);
  });

  it("refuses the shared key everywhere when SHARED_KEY_REFUSED_MACHINES is *", async () => {
    const retired = { ...env, SHARED_KEY_REFUSED_MACHINES: "*" } as Env;
    expect(await authenticate(req(SHARED), retired)).toBeNull();
    expect(await authenticate(req(KEY_A), retired)).toEqual({ kind: "machine", machineId: M_A });
  });
});

describe("GET /whoami", () => {
  it("names the machine for a per-machine key", async () => {
    const res = await call("/whoami", KEY_A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ credential: "machine", machine_id: M_A });
  });

  it("says shared for the shared key", async () => {
    const res = await call("/whoami", SHARED);
    expect(await res.json()).toEqual({ credential: "shared", machine_id: null });
  });

  it("401s otherwise", async () => {
    expect((await call("/whoami", null)).status).toBe(401);
    expect((await call("/whoami", KEY_REVOKED)).status).toBe(401);
  });
});

describe("GET /machines/:id/next", () => {
  it("lets a machine key poll as its own machine", async () => {
    const res = await call(`/machines/${M_A}/next`, KEY_A);
    expect(res.status).toBe(204);
    expect(await lastPoll(M_A)).toBeTypeOf("number");
  });

  it("refuses a machine key polling as another machine, without marking that machine online", async () => {
    const res = await call(`/machines/${M_B}/next`, KEY_A);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "machine_mismatch" });
    expect(await lastPoll(M_B)).toBeUndefined();
  });

  it("does not hand a machine key another machine's command", async () => {
    await seedCommand("cred-cmd-1", M_B);
    await env.DB.prepare("UPDATE commands SET status = 'pending' WHERE command_id = 'cred-cmd-1'").run();
    expect((await call(`/machines/${M_B}/next`, KEY_A)).status).toBe(403);
    const row = await env.DB.prepare("SELECT status FROM commands WHERE command_id = 'cred-cmd-1'")
      .first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("keeps the shared key working for any machine until it is retired", async () => {
    expect((await call(`/machines/${M_B}/next`, SHARED)).status).toBe(204);
  });

  it("refuses the shared key for a machine it has been retired for, and only that one", async () => {
    const envOverride = { SHARED_KEY_REFUSED_MACHINES: `other, ${M_A}` };
    expect((await call(`/machines/${M_A}/next`, SHARED, { envOverride })).status).toBe(401);
    expect(await lastPoll(M_A)).toBeUndefined();
    expect((await call(`/machines/${M_B}/next`, SHARED, { envOverride })).status).toBe(204);
    expect((await call(`/machines/${M_A}/next`, KEY_A, { envOverride })).status).toBe(204);
  });
});

describe("POST /commands/:id/ack", () => {
  it("acks a command addressed to the key's machine", async () => {
    await seedCommand("cred-ack-1", M_A);
    const res = await call("/commands/cred-ack-1/ack", KEY_A, { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("refuses to ack another machine's command and leaves it unacked", async () => {
    await seedCommand("cred-ack-2", M_B);
    const res = await call("/commands/cred-ack-2/ack", KEY_A, { method: "POST" });
    expect(res.status).toBe(403);
    const row = await env.DB.prepare("SELECT status FROM commands WHERE command_id = 'cred-ack-2'")
      .first<{ status: string }>();
    expect(row?.status).toBe("leased");
  });

  it("404s an unknown command for a machine key", async () => {
    expect((await call("/commands/cred-nope/ack", KEY_A, { method: "POST" })).status).toBe(404);
  });

  it("refuses the shared key acking a retired machine's command", async () => {
    await seedCommand("cred-ack-3", M_A);
    const envOverride = { SHARED_KEY_REFUSED_MACHINES: M_A };
    expect((await call("/commands/cred-ack-3/ack", SHARED, { method: "POST", envOverride })).status).toBe(401);
    expect((await call("/commands/cred-ack-3/ack", SHARED, { method: "POST" })).status).toBe(200);
  });
});

describe("POST /sessions/register", () => {
  const reg = (key: string, sessionId: string, machineId: string, envOverride?: Partial<Env>) =>
    call("/sessions/register", key, {
      method: "POST",
      body: { sessionId, machineId },
      ...(envOverride ? { envOverride } : {}),
    });

  it("registers a session for the key's own machine", async () => {
    expect((await reg(KEY_A, "ses_cred1", M_A)).status).toBe(200);
    expect(await ownerOf("ses_cred1")).toBe(M_A);
  });

  it("refuses registering as another machine", async () => {
    const res = await reg(KEY_A, "ses_cred2", M_B);
    expect(res.status).toBe(403);
    expect(await ownerOf("ses_cred2")).toBeUndefined();
  });

  it("refuses taking over a live session another machine holds", async () => {
    expect((await reg(KEY_B, "ses_cred3", M_B)).status).toBe(200);
    const res = await reg(KEY_A, "ses_cred3", M_A);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "owned_by_other_machine" });
    expect(await ownerOf("ses_cred3")).toBe(M_B);
  });

  it("allows taking over a session idle past the reaper TTL", async () => {
    expect((await reg(KEY_B, "ses_cred4", M_B)).status).toBe(200);
    await env.DB.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = 'ses_cred4'")
      .bind(Date.now() - REGISTER_TAKEOVER_STALE_MS - 1000)
      .run();
    expect((await reg(KEY_A, "ses_cred4", M_A)).status).toBe(200);
    expect(await ownerOf("ses_cred4")).toBe(M_A);
  });

  it("keeps last-registrant-wins for the shared key", async () => {
    expect((await reg(KEY_B, "ses_cred5", M_B)).status).toBe(200);
    expect((await reg(SHARED, "ses_cred5", M_A)).status).toBe(200);
    expect(await ownerOf("ses_cred5")).toBe(M_A);
  });

  it("refuses the shared key moving a session away from a retired machine, or onto one", async () => {
    const envOverride = { SHARED_KEY_REFUSED_MACHINES: M_B };
    expect((await reg(KEY_B, "ses_cred6", M_B)).status).toBe(200);
    expect((await reg(SHARED, "ses_cred6", M_A, envOverride)).status).toBe(401);
    expect(await ownerOf("ses_cred6")).toBe(M_B);
    expect((await reg(SHARED, "ses_cred7", M_B, envOverride)).status).toBe(401);
    expect((await reg(SHARED, "ses_cred7", M_A, envOverride)).status).toBe(200);
  });
});

describe("POST /sessions/unregister", () => {
  const unreg = (key: string, sessionId: string, envOverride?: Partial<Env>) =>
    call("/sessions/unregister", key, {
      method: "POST",
      body: { sessionId },
      ...(envOverride ? { envOverride } : {}),
    });

  it("lets the owner unregister its session", async () => {
    await call("/sessions/register", KEY_A, { method: "POST", body: { sessionId: "ses_cred8", machineId: M_A } });
    expect((await unreg(KEY_A, "ses_cred8")).status).toBe(200);
    expect(await ownerOf("ses_cred8")).toBeUndefined();
  });

  it("leaves another machine's session alone and answers 200 skipped", async () => {
    await call("/sessions/register", KEY_B, { method: "POST", body: { sessionId: "ses_cred9", machineId: M_B } });
    const res = await unreg(KEY_A, "ses_cred9");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "not_owner" });
    expect(await ownerOf("ses_cred9")).toBe(M_B);
  });

  it("refuses the shared key unregistering a retired machine's session", async () => {
    await call("/sessions/register", KEY_B, { method: "POST", body: { sessionId: "ses_cred10", machineId: M_B } });
    expect((await unreg(SHARED, "ses_cred10", { SHARED_KEY_REFUSED_MACHINES: M_B })).status).toBe(401);
    expect(await ownerOf("ses_cred10")).toBe(M_B);
    expect((await unreg(SHARED, "ses_cred10")).status).toBe(200);
    expect(await ownerOf("ses_cred10")).toBeUndefined();
  });
});

describe("other routes accept a per-machine key", () => {
  it("GET /sessions/:id/owner", async () => {
    await call("/sessions/register", KEY_A, { method: "POST", body: { sessionId: "ses_cred11", machineId: M_A } });
    const res = await call("/sessions/ses_cred11/owner", KEY_B);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ machine_id: M_A });
  });

  it("POST /topics/lookup", async () => {
    const res = await call("/topics/lookup", KEY_A, { method: "POST", body: { sessionIds: [] } });
    expect(res.status).not.toBe(401);
  });
});
