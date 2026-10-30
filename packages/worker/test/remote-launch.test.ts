/**
 * Remote launch, worker side (pigeon-k0qn.17).
 *
 * Test harness modeled on test/relay.test.ts. Machine ids are rl-a, rl-b, rl-c,
 * session ids ses_rl... so cleanup cannot touch relay tests.
 */
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import worker from "../src/index";
import { clearCredentialCache, sha256Hex } from "../src/credentials";
import { SWARM_RELAY_HEADER } from "../src/relay";
import {
  LAUNCH_TTL_MS,
  LAUNCH_ONLINE_MS,
  LAUNCH_QUEUE_CAP,
  LAUNCH_RATE_PER_HOUR,
} from "../src/remote-launch";

const SHARED = "test-api-key";
const KEY_A = "pgk_" + "A".repeat(43);
const KEY_B = "pgk_" + "B".repeat(43);
const KEY_C = "pgk_" + "C".repeat(43);
const A = "rl-a";
const B = "rl-b";
const C = "rl-c";
const RETIRED: Partial<Env> = { SHARED_KEY_REFUSED_MACHINES: `${A},${B},${C}` };

const SENDER = "ses_rlSenderOnA01";

async function call(
  path: string,
  key: string | null,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; envOverride?: Partial<Env> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers ?? {}) };
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  const request = new Request(`https://worker${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return worker.fetch(request, { ...env, ...RETIRED, ...(init.envOverride ?? {}) } as Env);
}

async function addKey(key: string, machineId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO machine_credentials (key_sha256, machine_id, created_at, revoked_at, note)
     VALUES (?, ?, ?, NULL, 'remote-launch-test')`,
  )
    .bind(await sha256Hex(key), machineId, Date.now())
    .run();
}

async function seedSession(sessionId: string, machineId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO sessions (session_id, machine_id, label, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?)`,
  )
    .bind(sessionId, machineId, Date.now(), Date.now())
    .run();
}

function poll(key: string, machineId: string, header?: string, envOverride?: Partial<Env>): Promise<Response> {
  return call(`/machines/${machineId}/next`, key, {
    headers: header === undefined ? {} : { [SWARM_RELAY_HEADER]: header },
    envOverride,
  });
}

async function setLaunchAccept(machineId: string, acceptCsv: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO machine_launch_accept (machine_id, accept_csv, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(machine_id) DO UPDATE SET accept_csv = excluded.accept_csv, updated_at = excluded.updated_at`,
  )
    .bind(machineId, acceptCsv, Date.now())
    .run();
}

function launchBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    launch_id: "launch_rl_0001",
    from: SENDER,
    machine: B,
    directory: "~/projects/pigeon",
    prompt: "say hello",
    tag: null,
    ...over,
  };
}

const launch = (key: string | null, over: Record<string, unknown> = {}, envOverride?: Partial<Env>) =>
  call("/launch/relay", key, { method: "POST", body: launchBody(over), envOverride });

async function row(fromMachine: string, launchId: string) {
  return env.DB.prepare("SELECT * FROM remote_launch WHERE from_machine = ? AND launch_id = ?")
    .bind(fromMachine, launchId)
    .first<Record<string, unknown>>();
}

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  clearCredentialCache();
  await env.DB.prepare("DELETE FROM remote_launch").run();
  await env.DB.prepare("DELETE FROM machine_launch_accept").run();
  await env.DB.prepare("DELETE FROM swarm_relay").run();
  await env.DB.prepare("DELETE FROM machine_relay_accept").run();
  await env.DB.prepare("DELETE FROM sessions WHERE session_id LIKE 'ses_rl%'").run();
  await env.DB.prepare("DELETE FROM commands WHERE machine_id LIKE 'rl-%'").run();
  await env.DB.prepare("DELETE FROM machines WHERE machine_id LIKE 'rl-%'").run();
  await addKey(KEY_A, A);
  await addKey(KEY_B, B);
  await addKey(KEY_C, C);
  // Default happy-path fixture:
  // B polled recently with relay header accept=rl-a; failures=1
  expect((await poll(KEY_B, B, `accept=${A}; failures=1`)).status).toBe(204);
  // A polled recently with accept=rl-b; failures=1
  expect((await poll(KEY_A, A, `accept=${B}; failures=1`)).status).toBe(204);
  // machine_launch_accept for B = 'rl-a'
  await setLaunchAccept(B, A);
});

describe("POST /launch/relay", () => {
  it("valid request -> 202, row queued, to_machine B, expires_at = created_at + LAUNCH_TTL_MS", async () => {
    const res = await launch(KEY_A);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, launch_id: "launch_rl_0001", to_machine: B });
    const r = await row(A, "launch_rl_0001");
    expect(r).toMatchObject({
      from_machine: A,
      launch_id: "launch_rl_0001",
      item_kind: "launch",
      to_machine: B,
      from_session: SENDER,
      status: "queued",
      lease_count: 0,
    });
    expect(Number(r!.expires_at)).toBe(Number(r!.created_at) + LAUNCH_TTL_MS);
    const bodyJson = JSON.parse(String(r!.body_json));
    expect(bodyJson).toEqual({
      from: SENDER,
      directory: "~/projects/pigeon",
      prompt: "say hello",
      tag: null,
    });
  });

  it("shared key -> 401", async () => {
    expect((await launch(SHARED, {}, { SHARED_KEY_REFUSED_MACHINES: "" })).status).toBe(401);
    expect((await launch(null)).status).toBe(401);
  });

  it("each validation failure -> 400", async () => {
    // bad launch_id with ':'
    expect((await launch(KEY_A, { launch_id: "launch:001" })).status).toBe(400);
    // non-ses_ from
    expect((await launch(KEY_A, { from: "gse_12345678" })).status).toBe(400);
    expect((await launch(KEY_A, { from: "pigeon" })).status).toBe(400);
    expect((await launch(KEY_A, { from: "not_a_session" })).status).toBe(400);
    // 513-char directory
    expect((await launch(KEY_A, { directory: "a".repeat(513) })).status).toBe(400);
    // directory with '\n'
    expect((await launch(KEY_A, { directory: "/home/dev\n" })).status).toBe(400);
    // empty prompt
    expect((await launch(KEY_A, { prompt: "" })).status).toBe(400);
    // 16001-code-point prompt (astral char: 🚀 is 1 code point, 2 UTF-16 units)
    expect((await launch(KEY_A, { prompt: "🚀".repeat(16001) })).status).toBe(400);
    // show 16000 astral chars is accepted
    const res16k = await launch(KEY_A, { launch_id: "launch_astral_16k", prompt: "🚀".repeat(16000) });
    expect(res16k.status).toBe(202);
    // invalid tag
    expect((await launch(KEY_A, { tag: "auto:mono" })).status).toBe(400);
    expect((await launch(KEY_A, { tag: "-invalid-tag" })).status).toBe(400);
  });

  it("same launch_id, same body -> 202 duplicate even after B goes offline", async () => {
    const res1 = await launch(KEY_A);
    expect(res1.status).toBe(202);
    expect((await res1.json()) as Record<string, unknown>).toMatchObject({
      accepted: true,
      launch_id: "launch_rl_0001",
      to_machine: B,
    });

    // Age B's last_poll_at so B is offline (> 60s)
    await env.DB.prepare("UPDATE machines SET last_poll_at = ? WHERE machine_id = ?")
      .bind(Date.now() - 120_000, B)
      .run();

    const res2 = await launch(KEY_A);
    expect(res2.status).toBe(202);
    expect(await res2.json()).toMatchObject({
      accepted: true,
      duplicate: true,
      launch_id: "launch_rl_0001",
      to_machine: B,
    });
  });

  it("same launch_id, different prompt -> 409 launch_id_conflict", async () => {
    const res1 = await launch(KEY_A);
    expect(res1.status).toBe(202);

    const res2 = await launch(KEY_A, { prompt: "different prompt" });
    expect(res2.status).toBe(409);
    expect(await res2.json()).toMatchObject({ error: "launch_id_conflict" });
  });

  it("from registered to C -> 403 sender_not_yours; unregistered from passes", async () => {
    await seedSession("ses_rlOnC0001", C);
    const res1 = await launch(KEY_A, { from: "ses_rlOnC0001" });
    expect(res1.status).toBe(403);
    expect(await res1.json()).toMatchObject({ error: "sender_not_yours" });

    // Unregistered from passes
    const res2 = await launch(KEY_A, { from: "ses_rlUnregistered01", launch_id: "launch_unreg" });
    expect(res2.status).toBe(202);
  });

  it("machine = caller -> 409 same_machine", async () => {
    const res = await launch(KEY_A, { machine: A });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "same_machine" });
  });

  it("B not in SHARED_KEY_REFUSED_MACHINES -> 403 receiver_not_retired", async () => {
    const res = await launch(KEY_A, {}, { SHARED_KEY_REFUSED_MACHINES: `${A},${C}` });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "receiver_not_retired" });
  });

  it("B's launch accept lacks A -> 403 not_accepted", async () => {
    await setLaunchAccept(B, C);
    const res = await launch(KEY_A);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_accepted" });
  });

  it("B offline -> 503 target_offline", async () => {
    await env.DB.prepare("UPDATE machines SET last_poll_at = ? WHERE machine_id = ?")
      .bind(Date.now() - (LAUNCH_ONLINE_MS + 5_000), B)
      .run();
    const res = await launch(KEY_A);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "target_offline" });
  });

  it("return path missing (B accepts launches from A, but A's relay accept lacks B) -> 409 no_return_path; with A polled as accept=rl-b; failures=1 -> 202", async () => {
    // Clear A's relay accept of B by polling with accept=rl-c
    expect((await poll(KEY_A, A, `accept=${C}; failures=1`)).status).toBe(204);
    const res1 = await launch(KEY_A);
    expect(res1.status).toBe(409);
    expect(await res1.json()).toMatchObject({ error: "no_return_path" });

    // Re-poll A with accept=rl-b
    expect((await poll(KEY_A, A, `accept=${B}; failures=1`)).status).toBe(204);
    const res2 = await launch(KEY_A);
    expect(res2.status).toBe(202);
  });

  it("10 queued for B -> 429 queue_full; 30 created by A within the hour (to B and C) -> 429 rate_limited", async () => {
    // 10 queued for B
    for (let i = 0; i < LAUNCH_QUEUE_CAP; i++) {
      await env.DB.prepare(
        `INSERT INTO remote_launch (from_machine, launch_id, item_kind, to_machine, from_session, body_json, body_sha256, status, lease_count, created_at, expires_at)
         VALUES (?, ?, 'launch', ?, ?, '{}', 'hash', 'queued', 0, ?, ?)`,
      )
        .bind(C, `seed_queue_${i}`, B, SENDER, Date.now(), Date.now() + LAUNCH_TTL_MS)
        .run();
    }
    const resQueueFull = await launch(KEY_A);
    expect(resQueueFull.status).toBe(429);
    expect(await resQueueFull.json()).toMatchObject({ error: "queue_full" });

    // Clean up B's queue
    await env.DB.prepare("DELETE FROM remote_launch WHERE to_machine = ?").bind(B).run();

    // 30 created by A within the hour
    for (let i = 0; i < LAUNCH_RATE_PER_HOUR; i++) {
      await env.DB.prepare(
        `INSERT INTO remote_launch (from_machine, launch_id, item_kind, to_machine, from_session, body_json, body_sha256, status, lease_count, created_at, expires_at)
         VALUES (?, ?, 'launch', ?, ?, '{}', 'hash', 'launched', 0, ?, ?)`,
      )
        .bind(A, `seed_rate_${i}`, i % 2 === 0 ? B : C, SENDER, Date.now() - 10_000, Date.now() + LAUNCH_TTL_MS)
        .run();
    }
    const resRateLimited = await launch(KEY_A);
    expect(resRateLimited.status).toBe(429);
    expect(await resRateLimited.json()).toMatchObject({ error: "rate_limited" });
  });

  it("tables dropped -> 503 launch_unavailable", async () => {
    await env.DB.prepare("ALTER TABLE remote_launch RENAME TO remote_launch_hidden").run();
    try {
      const res = await launch(KEY_A);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "launch_unavailable" });
    } finally {
      await env.DB.prepare("ALTER TABLE remote_launch_hidden RENAME TO remote_launch").run();
    }
  });
});
