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
  LAUNCH_LEASE_MS,
  LAUNCH_MAX_LEASES,
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
  const key = machineId === A ? KEY_A : machineId === B ? KEY_B : KEY_C;
  await poll(key, machineId, `accept=rl-a; launch=${acceptCsv}; failures=1`);
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

function ack(
  key: string | null,
  items: unknown,
  envOverride?: Partial<Env>,
): Promise<Response> {
  return call("/launch/relay/ack", key, {
    method: "POST",
    body: Array.isArray(items) ? { items } : items,
    envOverride,
  });
}

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
  await env.DB.prepare("DELETE FROM machine_credentials WHERE note = 'remote-launch-test'").run();
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

  it("valid non-null tag is accepted and stored in body_json", async () => {
    const res = await launch(KEY_A, { launch_id: "launch_with_tag", tag: "my-valid-tag" });
    expect(res.status).toBe(202);
    const r = await row(A, "launch_with_tag");
    expect(r).not.toBeNull();
    const bodyJson = JSON.parse(String(r!.body_json));
    expect(bodyJson.tag).toBe("my-valid-tag");
  });

  it("body from_machine mismatch -> 403, and from registered to caller A succeeds", async () => {
    const resMismatch = await launch(KEY_A, { from_machine: B });
    expect(resMismatch.status).toBe(403);
    expect(await resMismatch.json()).toMatchObject({
      error: "machine_mismatch",
    });

    await seedSession("ses_rlOnA0001", A);
    const resRegistered = await launch(KEY_A, { launch_id: "launch_reg_a", from: "ses_rlOnA0001" });
    expect(resRegistered.status).toBe(202);
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

describe("hand-out on GET /machines/:id/next", () => {
  it("poll with launch=rl-a writes the accept set; a poll without the token clears it; a poll with no header clears it; unchanged header does not rewrite (check updated_at)", async () => {
    // 1. poll with launch=rl-a writes the accept set
    const res1 = await poll(KEY_B, B, `launch=${A}`);
    expect(res1.status).toBe(204);
    const row1 = await env.DB.prepare("SELECT * FROM machine_launch_accept WHERE machine_id = ?").bind(B).first<{ accept_csv: string; updated_at: number }>();
    expect(row1).not.toBeNull();
    expect(row1!.accept_csv).toBe(A);
    const t1 = row1!.updated_at;

    // 2. unchanged header does not rewrite (check updated_at)
    await new Promise((r) => setTimeout(r, 5));
    const res2 = await poll(KEY_B, B, `launch=${A}`);
    expect(res2.status).toBe(204);
    const row2 = await env.DB.prepare("SELECT * FROM machine_launch_accept WHERE machine_id = ?").bind(B).first<{ accept_csv: string; updated_at: number }>();
    expect(row2!.updated_at).toBe(t1);

    // 3. poll without the token clears it
    const res3 = await poll(KEY_B, B, `accept=${A}; failures=1`);
    expect(res3.status).toBe(204);
    const row3 = await env.DB.prepare("SELECT * FROM machine_launch_accept WHERE machine_id = ?").bind(B).first<{ accept_csv: string; updated_at: number }>();
    expect(row3!.accept_csv).toBe("");

    // Set it again, then poll with no header clears it
    await poll(KEY_B, B, `launch=${A}`);
    const rowSet = await env.DB.prepare("SELECT * FROM machine_launch_accept WHERE machine_id = ?").bind(B).first<{ accept_csv: string }>();
    expect(rowSet!.accept_csv).toBe(A);

    // 4. poll with no header clears it
    const res4 = await poll(KEY_B, B); // no header
    expect(res4.status).toBe(204);
    const row4 = await env.DB.prepare("SELECT * FROM machine_launch_accept WHERE machine_id = ?").bind(B).first<{ accept_csv: string }>();
    expect(row4!.accept_csv).toBe("");
  });

  it("queued launch is handed out once in launches with the contract shape; a second poll within the lease gets nothing; after the lease lapses it is handed out again; after 3 leases never again", async () => {
    await launch(KEY_A);
    const res1 = await poll(KEY_B, B, `launch=${A}; failures=1`);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { launches: Array<Record<string, unknown>> };
    expect(body1.launches).toHaveLength(1);
    expect(body1.launches[0]).toMatchObject({
      item: "launch",
      from_machine: A,
      launch_id: "launch_rl_0001",
      from: SENDER,
      directory: "~/projects/pigeon",
      prompt: "say hello",
      tag: null,
    });
    expect(typeof body1.launches[0].expires_at).toBe("number");

    // Second poll within lease gets nothing (204)
    const res2 = await poll(KEY_B, B, `launch=${A}; failures=1`);
    expect(res2.status).toBe(204);

    // Age leased_at past lease
    await env.DB.prepare("UPDATE remote_launch SET leased_at = ? WHERE launch_id = ?")
      .bind(Date.now() - LAUNCH_LEASE_MS - 1000, "launch_rl_0001")
      .run();

    // Handed out again (lease 2)
    const res3 = await poll(KEY_B, B, `launch=${A}; failures=1`);
    expect(res3.status).toBe(200);
    expect(((await res3.json()) as { launches: unknown[] }).launches).toHaveLength(1);

    // Age leased_at again
    await env.DB.prepare("UPDATE remote_launch SET leased_at = ? WHERE launch_id = ?")
      .bind(Date.now() - LAUNCH_LEASE_MS - 1000, "launch_rl_0001")
      .run();

    // Handed out again (lease 3)
    const res4 = await poll(KEY_B, B, `launch=${A}; failures=1`);
    expect(res4.status).toBe(200);
    expect(((await res4.json()) as { launches: unknown[] }).launches).toHaveLength(1);

    // Age leased_at again
    await env.DB.prepare("UPDATE remote_launch SET leased_at = ? WHERE launch_id = ?")
      .bind(Date.now() - LAUNCH_LEASE_MS - 1000, "launch_rl_0001")
      .run();

    // After 3 leases never again (status is leased with lease_count = 3 >= LAUNCH_MAX_LEASES)
    const res5 = await poll(KEY_B, B, `launch=${A}; failures=1`);
    expect(res5.status).toBe(204);
  });

  it("only 1 launch per poll even with 3 queued; oldest first", async () => {
    await launch(KEY_A, { launch_id: "launch_1", prompt: "first" });
    await new Promise((r) => setTimeout(r, 5));
    await launch(KEY_A, { launch_id: "launch_2", prompt: "second" });
    await new Promise((r) => setTimeout(r, 5));
    await launch(KEY_A, { launch_id: "launch_3", prompt: "third" });

    const res = await poll(KEY_B, B, `launch=${A}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { launches: Array<{ launch_id: string }> };
    expect(body.launches).toHaveLength(1);
    expect(body.launches[0].launch_id).toBe("launch_1");
  });

  it("a launch with < 60 s of life left is not handed out", async () => {
    await launch(KEY_A);
    // Age expires_at so less than 60s of life remains
    await env.DB.prepare("UPDATE remote_launch SET expires_at = ? WHERE launch_id = ?")
      .bind(Date.now() + 50_000, "launch_rl_0001")
      .run();

    const res = await poll(KEY_B, B, `launch=${A}`);
    expect(res.status).toBe(204);
  });

  it("launch from a machine not in B's launch= list is not handed out", async () => {
    await launch(KEY_A);
    // B polls only accepting launches from C
    const res1 = await poll(KEY_B, B, `launch=${C}`);
    expect(res1.status).toBe(204);

    // B polls accepting from A
    const res2 = await poll(KEY_B, B, `launch=${A}`);
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as { launches: unknown[] }).launches).toHaveLength(1);
  });

  it("poll response with both relay items and launches carries both arrays; a command plus launches carries the command fields plus launches", async () => {
    // 1. Relay item + launch
    await env.DB.prepare(
      `INSERT INTO swarm_relay (from_machine, msg_id, item_kind, to_machine, to_session, from_session, body_json, payload_sha256, status, created_at, expires_at)
       VALUES (?, 'msg_test_01', 'message', ?, 'ses_rlTarget01', ?, '{}', 'hash', 'queued', ?, ?)`,
    )
      .bind(A, B, SENDER, Date.now(), Date.now() + 100_000)
      .run();
    await launch(KEY_A);

    const resBoth = await poll(KEY_B, B, `accept=${A}; launch=${A}; failures=1`);
    expect(resBoth.status).toBe(200);
    const bodyBoth = (await resBoth.json()) as { swarm?: unknown[]; launches?: unknown[] };
    expect(bodyBoth.swarm).toHaveLength(1);
    expect(bodyBoth.launches).toHaveLength(1);

    // 2. Command + launch
    await launch(KEY_A, { launch_id: "launch_cmd_test" });
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES ('cmd_rl_01', ?, ?, 'execute', 'echo hello', '12345', 'pending', ?)`,
    )
      .bind(B, "ses_rlTarget01", Date.now())
      .run();

    const resCmd = await poll(KEY_B, B, `launch=${A}`);
    expect(resCmd.status).toBe(200);
    const bodyCmd = (await resCmd.json()) as Record<string, unknown>;
    expect(bodyCmd.commandId).toBe("cmd_rl_01");
    expect(bodyCmd.command).toBe("echo hello");
    expect((bodyCmd.launches as unknown[])).toHaveLength(1);
  });
});

describe("POST /launch/relay/ack", () => {
  it("ack launched -> row launched, result row r:<id> queued for A; A's poll with failures=1 gets launch_result; A's poll without failures=1 gets nothing", async () => {
    await launch(KEY_A);
    const pollRes = await poll(KEY_B, B, `launch=${A}; failures=1`);
    expect(pollRes.status).toBe(200);

    const ackRes = await ack(KEY_B, [
      {
        kind: "launch",
        from_machine: A,
        launch_id: "launch_rl_0001",
        outcome: "launched",
        session_id: "ses_rlTargetSession01",
      },
    ]);
    expect(ackRes.status).toBe(200);
    expect(await ackRes.json()).toEqual({
      ok: true,
      results: [
        {
          kind: "launch",
          from_machine: A,
          launch_id: "launch_rl_0001",
          result: "ok",
        },
      ],
    });

    const r = await row(A, "launch_rl_0001");
    expect(r).toMatchObject({
      status: "launched",
      session_id: "ses_rlTargetSession01",
    });

    const resNoFailures = await poll(KEY_A, A, `accept=${B}`);
    expect(resNoFailures.status).toBe(204);

    const resWithFailures = await poll(KEY_A, A, `accept=${B}; failures=1`);
    expect(resWithFailures.status).toBe(200);
    const body = (await resWithFailures.json()) as { launches: Array<Record<string, unknown>> };
    expect(body.launches).toHaveLength(1);
    expect(body.launches[0]).toMatchObject({
      item: "launch_result",
      from_machine: A,
      result_id: "r:launch_rl_0001",
      launch_id: "launch_rl_0001",
      machine: B,
      outcome: "launched",
      session_id: "ses_rlTargetSession01",
      reason: null,
    });
  });

  it("ack refused reason no_such_directory -> result refused with that reason", async () => {
    await launch(KEY_A);
    await poll(KEY_B, B, `launch=${A}`);

    const ackRes = await ack(KEY_B, [
      {
        kind: "launch",
        from_machine: A,
        launch_id: "launch_rl_0001",
        outcome: "refused",
        reason: "no_such_directory",
      },
    ]);
    expect(ackRes.status).toBe(200);

    const r = await row(A, "launch_rl_0001");
    expect(r).toMatchObject({
      status: "refused",
      reason: "no_such_directory",
    });

    const resPoll = await poll(KEY_A, A, `failures=1`);
    expect(resPoll.status).toBe(200);
    const body = (await resPoll.json()) as { launches: Array<Record<string, unknown>> };
    expect(body.launches).toHaveLength(1);
    expect(body.launches[0]).toMatchObject({
      item: "launch_result",
      from_machine: A,
      result_id: "r:launch_rl_0001",
      launch_id: "launch_rl_0001",
      machine: B,
      outcome: "refused",
      session_id: null,
      reason: "no_such_directory",
    });
  });

  it("ack unconfirmed with session id -> launch row expired/unconfirmed, result carries the id", async () => {
    await launch(KEY_A);
    await poll(KEY_B, B, `launch=${A}`);

    const ackRes = await ack(KEY_B, [
      {
        kind: "launch",
        from_machine: A,
        launch_id: "launch_rl_0001",
        outcome: "unconfirmed",
        session_id: "ses_rlUnconfirmed01",
      },
    ]);
    expect(ackRes.status).toBe(200);

    const r = await row(A, "launch_rl_0001");
    expect(r).toMatchObject({
      status: "expired",
      reason: "unconfirmed",
      session_id: "ses_rlUnconfirmed01",
    });

    const resPoll = await poll(KEY_A, A, `failures=1`);
    expect(resPoll.status).toBe(200);
    const body = (await resPoll.json()) as { launches: Array<Record<string, unknown>> };
    expect(body.launches).toHaveLength(1);
    expect(body.launches[0]).toMatchObject({
      item: "launch_result",
      from_machine: A,
      result_id: "r:launch_rl_0001",
      launch_id: "launch_rl_0001",
      machine: B,
      outcome: "unconfirmed",
      session_id: "ses_rlUnconfirmed01",
      reason: "unconfirmed",
    });
  });

  it("ack by C -> not_yours; unknown id -> not_found; launched without session_id -> 400; refused without reason -> 400; reason 'Bad Reason' -> 400; 101 items -> 400", async () => {
    await launch(KEY_A);

    // Ack by C -> not_yours
    const ackC = await ack(KEY_C, [
      {
        kind: "launch",
        from_machine: A,
        launch_id: "launch_rl_0001",
        outcome: "refused",
        reason: "bad_dir",
      },
    ]);
    expect(ackC.status).toBe(200);
    expect(await ackC.json()).toEqual({
      ok: true,
      results: [
        {
          kind: "launch",
          from_machine: A,
          launch_id: "launch_rl_0001",
          result: "not_yours",
        },
      ],
    });

    // Unknown id -> not_found
    const ackUnknown = await ack(KEY_B, [
      {
        kind: "launch",
        from_machine: A,
        launch_id: "launch_non_existent",
        outcome: "refused",
        reason: "bad_dir",
      },
    ]);
    expect(ackUnknown.status).toBe(200);
    expect(await ackUnknown.json()).toEqual({
      ok: true,
      results: [
        {
          kind: "launch",
          from_machine: A,
          launch_id: "launch_non_existent",
          result: "not_found",
        },
      ],
    });

    // launched without session_id -> 400
    const ackNoSession = await ack(KEY_B, [
      {
        kind: "launch",
        from_machine: A,
        launch_id: "launch_rl_0001",
        outcome: "launched",
      },
    ]);
    expect(ackNoSession.status).toBe(400);

    // refused without reason -> 400
    const ackNoReason = await ack(KEY_B, [
      {
        kind: "launch",
        from_machine: A,
        launch_id: "launch_rl_0001",
        outcome: "refused",
      },
    ]);
    expect(ackNoReason.status).toBe(400);

    // reason "Bad Reason" -> 400
    const ackBadReason = await ack(KEY_B, [
      {
        kind: "launch",
        from_machine: A,
        launch_id: "launch_rl_0001",
        outcome: "refused",
        reason: "Bad Reason",
      },
    ]);
    expect(ackBadReason.status).toBe(400);

    // 101 items -> 400
    const items101 = Array.from({ length: 101 }, (_, i) => ({
      kind: "launch",
      from_machine: A,
      launch_id: `launch_${i}`,
      outcome: "refused",
      reason: "fail",
    }));
    const ack101 = await ack(KEY_B, items101);
    expect(ack101.status).toBe(400);
  });

  it("correction while r:<id> still queued: set the launch row expired/unconfirmed and insert a queued r:<id> directly (or via the unconfirmed ack), then ack launched -> still exactly one result row for that launch, body now launched with the session id", async () => {
    await launch(KEY_A);
    await poll(KEY_B, B, `launch=${A}`);

    await ack(KEY_B, [
      {
        kind: "launch",
        from_machine: A,
        launch_id: "launch_rl_0001",
        outcome: "unconfirmed",
      },
    ]);

    const r1 = await row(A, "launch_rl_0001");
    expect(r1!.status).toBe("expired");
    const resRow1 = await row(A, "r:launch_rl_0001");
    expect(resRow1!.status).toBe("queued");

    const ackCorrect = await ack(KEY_B, [
      {
        kind: "launch",
        from_machine: A,
        launch_id: "launch_rl_0001",
        outcome: "launched",
        session_id: "ses_rlCorrected01",
      },
    ]);
    expect(ackCorrect.status).toBe(200);

    const resultRows = await env.DB.prepare(
      "SELECT * FROM remote_launch WHERE from_machine = ? AND item_kind = 'result'",
    )
      .bind(A)
      .all<Record<string, unknown>>();
    expect(resultRows.results).toHaveLength(1);
    expect(resultRows.results[0].launch_id).toBe("r:launch_rl_0001");

    const bodyJson = JSON.parse(String(resultRows.results[0].body_json));
    expect(bodyJson).toMatchObject({
      launch_id: "launch_rl_0001",
      outcome: "launched",
      session_id: "ses_rlCorrected01",
    });
  });

  it("correction after r:<id> was collected (leased by A's poll): ack launched -> new row r:<id>:launched; A's next poll gets it", async () => {
    await launch(KEY_A);
    await poll(KEY_B, B, `launch=${A}`);

    await ack(KEY_B, [
      {
        kind: "launch",
        from_machine: A,
        launch_id: "launch_rl_0001",
        outcome: "unconfirmed",
      },
    ]);

    // A collects r:launch_rl_0001 (leased)
    const pollA1 = await poll(KEY_A, A, "failures=1");
    expect(pollA1.status).toBe(200);
    const body1 = (await pollA1.json()) as { launches: Array<{ result_id: string; outcome: string }> };
    expect(body1.launches[0].result_id).toBe("r:launch_rl_0001");
    expect(body1.launches[0].outcome).toBe("unconfirmed");

    // B acks launched -> correction after r:<id> collected
    const ackCorrect = await ack(KEY_B, [
      {
        kind: "launch",
        from_machine: A,
        launch_id: "launch_rl_0001",
        outcome: "launched",
        session_id: "ses_rlCorrectedLate01",
      },
    ]);
    expect(ackCorrect.status).toBe(200);

    const rNew = await row(A, "r:launch_rl_0001:launched");
    expect(rNew).not.toBeNull();
    expect(rNew!.status).toBe("queued");

    const pollA2 = await poll(KEY_A, A, "failures=1");
    expect(pollA2.status).toBe(200);
    const body2 = (await pollA2.json()) as { launches: Array<{ result_id: string; outcome: string }> };
    expect(body2.launches).toHaveLength(1);
    expect(body2.launches[0].result_id).toBe("r:launch_rl_0001:launched");
    expect(body2.launches[0].outcome).toBe("launched");
  });

  it("ack refused on a launched row -> ok, row unchanged, no new result row", async () => {
    await launch(KEY_A);
    await poll(KEY_B, B, `launch=${A}`);

    await ack(KEY_B, [
      {
        kind: "launch",
        from_machine: A,
        launch_id: "launch_rl_0001",
        outcome: "launched",
        session_id: "ses_rlLaunched01",
      },
    ]);

    const ackRefused = await ack(KEY_B, [
      {
        kind: "launch",
        from_machine: A,
        launch_id: "launch_rl_0001",
        outcome: "refused",
        reason: "late_refusal",
      },
    ]);
    expect(ackRefused.status).toBe(200);
    expect(await ackRefused.json()).toEqual({
      ok: true,
      results: [
        {
          kind: "launch",
          from_machine: A,
          launch_id: "launch_rl_0001",
          result: "ok",
        },
      ],
    });

    const r = await row(A, "launch_rl_0001");
    expect(r!.status).toBe("launched");
    expect(r!.session_id).toBe("ses_rlLaunched01");

    const count = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM remote_launch WHERE from_machine = ? AND item_kind = 'result'",
    )
      .bind(A)
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("A acks result delivered -> result row delivered, not handed out again", async () => {
    await launch(KEY_A);
    await poll(KEY_B, B, `launch=${A}`);
    await ack(KEY_B, [
      {
        kind: "launch",
        from_machine: A,
        launch_id: "launch_rl_0001",
        outcome: "launched",
        session_id: "ses_rlDelivered01",
      },
    ]);

    const pollA1 = await poll(KEY_A, A, "failures=1");
    expect(pollA1.status).toBe(200);

    const ackRes = await ack(KEY_A, [
      {
        kind: "result",
        from_machine: A,
        result_id: "r:launch_rl_0001",
        outcome: "delivered",
      },
    ]);
    expect(ackRes.status).toBe(200);
    expect(await ackRes.json()).toEqual({
      ok: true,
      results: [
        {
          kind: "result",
          from_machine: A,
          result_id: "r:launch_rl_0001",
          result: "ok",
        },
      ],
    });

    const resRow = await row(A, "r:launch_rl_0001");
    expect(resRow!.status).toBe("delivered");

    await env.DB.prepare("UPDATE remote_launch SET leased_at = ? WHERE launch_id = ?")
      .bind(Date.now() - LAUNCH_LEASE_MS - 1000, "r:launch_rl_0001")
      .run();

    const pollA2 = await poll(KEY_A, A, "failures=1");
    expect(pollA2.status).toBe(204);
  });

  it("A acks result refused -> result row settled as refused with reason", async () => {
    await launch(KEY_A);
    await poll(KEY_B, B, `launch=${A}`);
    await ack(KEY_B, [
      {
        kind: "launch",
        from_machine: A,
        launch_id: "launch_rl_0001",
        outcome: "launched",
        session_id: "ses_rlDelivered02",
      },
    ]);

    const pollA1 = await poll(KEY_A, A, "failures=1");
    expect(pollA1.status).toBe(200);

    const ackRes = await ack(KEY_A, [
      {
        kind: "result",
        from_machine: A,
        result_id: "r:launch_rl_0001",
        outcome: "refused",
        reason: "sender_gone",
      },
    ]);
    expect(ackRes.status).toBe(200);
    expect(await ackRes.json()).toEqual({
      ok: true,
      results: [
        {
          kind: "result",
          from_machine: A,
          result_id: "r:launch_rl_0001",
          result: "ok",
        },
      ],
    });

    const resRow = await row(A, "r:launch_rl_0001");
    expect(resRow!.status).toBe("refused");
    expect(resRow!.reason).toBe("sender_gone");
  });

  it("shared key and no key -> 401 on ack", async () => {
    const item = [{ kind: "launch", from_machine: A, launch_id: "launch_rl_0001", outcome: "refused", reason: "no_dir" }];
    expect((await ack(SHARED, item, { SHARED_KEY_REFUSED_MACHINES: "" })).status).toBe(401);
    expect((await ack(null, item)).status).toBe(401);
  });

  it("kind/item_kind mismatch -> not_found", async () => {
    // Seed a result row with a launch_id that has no colon
    await env.DB.prepare(
      `INSERT INTO remote_launch (from_machine, launch_id, item_kind, to_machine, from_session, body_json, body_sha256, status, created_at, expires_at)
       VALUES (?, 'result_no_colon', 'result', ?, ?, '{}', '', 'queued', ?, ?)`,
    )
      .bind(A, B, SENDER, Date.now(), Date.now() + 100_000)
      .run();

    // Acker tries to ack it with kind: "launch"
    const ackRes = await ack(KEY_B, [
      {
        kind: "launch",
        from_machine: A,
        launch_id: "result_no_colon",
        outcome: "refused",
        reason: "fail",
      },
    ]);
    expect(ackRes.status).toBe(200);
    expect(await ackRes.json()).toEqual({
      ok: true,
      results: [
        {
          kind: "launch",
          from_machine: A,
          launch_id: "result_no_colon",
          result: "not_found",
        },
      ],
    });
  });

  it("tables dropped -> 503 launch_unavailable on ack", async () => {
    await env.DB.prepare("ALTER TABLE remote_launch RENAME TO remote_launch_hidden").run();
    try {
      const res = await ack(KEY_B, [
        {
          kind: "launch",
          from_machine: A,
          launch_id: "launch_rl_0001",
          outcome: "refused",
          reason: "no_dir",
        },
      ]);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "launch_unavailable" });
    } finally {
      await env.DB.prepare("ALTER TABLE remote_launch_hidden RENAME TO remote_launch").run();
    }
  });
});
