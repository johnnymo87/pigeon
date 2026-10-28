/**
 * `GET /sessions/remote` (pigeon-k0qn.9): swarm_list's remote discovery. Through the real
 * router, like relay.test.ts. Storage is shared across files (singleWorker, no isolation), so
 * assertions look only at this file's own `ses_rmt*` rows and `rmt-*` machines.
 */
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import worker from "../src/index";
import { clearCredentialCache, sha256Hex } from "../src/credentials";
import { RELAY_ONLINE_MS } from "../src/relay";
import { REGISTER_TAKEOVER_STALE_MS } from "../src/sessions";

const SHARED = "test-api-key";
const KEY_A = "pgk_" + "R".repeat(43);
const A = "rmt-a";
const B = "rmt-b";
const C = "rmt-c";
const D = "rmt-d";
const RETIRED: Partial<Env> = { SHARED_KEY_REFUSED_MACHINES: `${A},${B},${C}` };

interface Listing {
  machine_id: string;
  sessions: Array<{ session_id: string; machine_id: string; label: string | null; updated_at: number }>;
  machines: Array<{ machine_id: string; relay: string; last_poll_at: number | null }>;
  truncated: boolean;
}

async function call(path: string, key: string | null, envOverride: Partial<Env> = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  return worker.fetch(new Request(`https://worker${path}`, { headers }), { ...env, ...RETIRED, ...envOverride } as Env);
}

async function list(query = "", envOverride: Partial<Env> = {}): Promise<Listing> {
  const res = await call(`/sessions/remote${query}`, KEY_A, envOverride);
  expect(res.status).toBe(200);
  return (await res.json()) as Listing;
}

const mine = (l: Listing) => l.sessions.filter((s) => s.session_id.startsWith("ses_rmt"));
const machine = (l: Listing, id: string) => l.machines.find((m) => m.machine_id === id);

async function seedSession(sessionId: string, machineId: string, updatedAt = Date.now(), label: string | null = null) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(sessionId, machineId, label, updatedAt, updatedAt)
    .run();
}

async function seedPoll(machineId: string, at: number) {
  await env.DB.prepare("INSERT OR REPLACE INTO machines (machine_id, last_poll_at) VALUES (?, ?)").bind(machineId, at).run();
}

async function seedAccept(machineId: string, csv: string) {
  await env.DB.prepare("INSERT OR REPLACE INTO machine_relay_accept (machine_id, accept_csv, updated_at) VALUES (?, ?, ?)")
    .bind(machineId, csv, Date.now())
    .run();
}

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  clearCredentialCache();
  await env.DB.prepare("DELETE FROM sessions WHERE session_id LIKE 'ses_rmt%' OR session_id LIKE 'gse_rmt%'").run();
  await env.DB.prepare("DELETE FROM machines WHERE machine_id LIKE 'rmt-%'").run();
  await env.DB.prepare("DELETE FROM machine_relay_accept WHERE machine_id LIKE 'rmt-%'").run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO machine_credentials (key_sha256, machine_id, created_at, revoked_at, note)
     VALUES (?, ?, ?, NULL, 'remote-list-test')`,
  )
    .bind(await sha256Hex(KEY_A), A, Date.now())
    .run();
});

describe("GET /sessions/remote", () => {
  it("lists other machines' recent ses_ sessions, newest first, and never the caller's own", async () => {
    // In the future, so other files' rows (shared storage) cannot push these past the limit.
    const now = Date.now() + 600_000;
    await seedSession("ses_rmtOnB_older", B, now - 60_000, "older on b");
    await seedSession("ses_rmtOnB_newer", B, now - 1_000, "newer on b");
    await seedSession("ses_rmtOnC_one01", C, now - 30_000);
    await seedSession("ses_rmtOnA_local", A, now);

    const l = await list();
    expect(l.machine_id).toBe(A);
    expect(mine(l).map((s) => s.session_id)).toEqual(["ses_rmtOnB_newer", "ses_rmtOnC_one01", "ses_rmtOnB_older"]);
    expect(mine(l)[0]).toEqual({ session_id: "ses_rmtOnB_newer", machine_id: B, label: "newer on b", updated_at: now - 1_000 });
    expect(l.sessions.some((s) => s.machine_id === A)).toBe(false);
  });

  it("leaves out rows idle past the 7-day horizon and goose (gse_) sessions", async () => {
    const now = Date.now();
    await seedSession("ses_rmtStaleOnB", B, now - REGISTER_TAKEOVER_STALE_MS - 1_000);
    await seedSession("gse_rmtGooseOnB", B, now);
    await seedSession("ses_rmtFreshOnB", B, now);
    const ids = (await list()).sessions.map((s) => s.session_id);
    expect(ids).toContain("ses_rmtFreshOnB");
    expect(ids).not.toContain("ses_rmtStaleOnB");
    expect(ids).not.toContain("gse_rmtGooseOnB");
  });

  it("honours limit, clamps it, and reports truncation", async () => {
    const now = Date.now();
    await seedSession("ses_rmtLimit_0001", B, now + 2_000);
    await seedSession("ses_rmtLimit_0002", B, now + 1_000);
    const l = await list("?limit=1");
    expect(l.sessions).toHaveLength(1);
    expect(l.sessions[0]!.session_id).toBe("ses_rmtLimit_0001");
    expect(l.truncated).toBe(true);

    expect((await call("/sessions/remote?limit=0", KEY_A)).status).toBe(400);
    expect((await call("/sessions/remote?limit=abc", KEY_A)).status).toBe(400);
    expect((await call("/sessions/remote?limit=100000", KEY_A)).status).toBe(200);
  });

  it("is read-only: listing does not bump updated_at", async () => {
    const at = Date.now() - 5_000;
    await seedSession("ses_rmtReadOnly01", B, at);
    await list();
    const row = await env.DB.prepare("SELECT updated_at FROM sessions WHERE session_id = ?")
      .bind("ses_rmtReadOnly01")
      .first<{ updated_at: number }>();
    expect(row!.updated_at).toBe(at);
  });

  it("reports per machine what POST /swarm/relay would answer, in the relay route's check order", async () => {
    const now = Date.now();
    // B: retired, accepts A, polling -> available.
    await seedSession("ses_rmtStatusOnB", B, now);
    await seedAccept(B, `${C},${A}`);
    await seedPoll(B, now);
    // C: retired, accepts A, but not polling -> offline.
    await seedSession("ses_rmtStatusOnC", C, now);
    await seedAccept(C, A);
    await seedPoll(C, now - RELAY_ONLINE_MS - 1_000);
    // D: not retired from the shared key -> not_retired, whatever else holds.
    await seedSession("ses_rmtStatusOnD", D, now);
    await seedAccept(D, A);
    await seedPoll(D, now);

    let l = await list();
    expect(machine(l, B)).toEqual({ machine_id: B, relay: "available", last_poll_at: now });
    expect(machine(l, C)).toMatchObject({ relay: "offline" });
    expect(machine(l, D)).toMatchObject({ relay: "not_retired" });

    // B stops accepting A -> not_accepted (checked before liveness, as in the relay route).
    await seedAccept(B, C);
    await seedPoll(B, now - RELAY_ONLINE_MS - 1_000);
    l = await list();
    expect(machine(l, B)).toMatchObject({ relay: "not_accepted" });
  });

  it("answers not_accepted for a machine with no accept row and offline for one that never polled", async () => {
    await seedSession("ses_rmtNeverOnB", B, Date.now());
    let l = await list();
    expect(machine(l, B)).toEqual({ machine_id: B, relay: "not_accepted", last_poll_at: null });
    await seedAccept(B, A);
    l = await list();
    expect(machine(l, B)).toEqual({ machine_id: B, relay: "offline", last_poll_at: null });
  });

  it("lists machines only for the sessions it returns", async () => {
    await seedSession("ses_rmtOnlyOnB01", B, Date.now());
    const l = await list();
    expect(machine(l, B)).toBeDefined();
    expect(machine(l, C)).toBeUndefined();
    expect(machine(l, A)).toBeUndefined();
  });

  it("refuses the shared key and no key: 'other than the caller' needs a machine credential", async () => {
    const shared = await call("/sessions/remote", SHARED, { SHARED_KEY_REFUSED_MACHINES: "" });
    expect(shared.status).toBe(401);
    expect(await shared.json()).toMatchObject({ error: "machine_credential_required" });
    expect((await call("/sessions/remote", null)).status).toBe(401);
  });

  it("still lists, with relay 'unknown', when the relay schema has not been applied", async () => {
    await seedSession("ses_rmtNoSchemaB1", B, Date.now());
    await env.DB.prepare("DROP TABLE machine_relay_accept").run();
    try {
      const l = await list();
      expect(mine(l).map((s) => s.session_id)).toEqual(["ses_rmtNoSchemaB1"]);
      expect(machine(l, B)).toMatchObject({ relay: "unknown" });
    } finally {
      for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
        await env.DB.prepare(statement).run();
      }
    }
  });
});
