/**
 * Cross-machine swarm relay, worker side (pigeon-k0qn.5). Through the real router, like
 * credentials.test.ts. Machine ids here are retired from the shared key per request via
 * `SHARED_KEY_REFUSED_MACHINES`, because the relay refuses to queue for a machine that is not.
 */
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import worker from "../src/index";
import { clearCredentialCache, sha256Hex } from "../src/credentials";
import {
  RELAY_HANDOUT_LIMIT,
  RELAY_LEASE_MS,
  RELAY_MAX_LEASES,
  RELAY_MAX_TTL_MS,
  RELAY_QUEUE_CAP,
  RELAY_RETENTION_MS,
  SWARM_RELAY_HEADER,
  parseRelayHeader,
  runRelayExpiry,
} from "../src/relay";

const SHARED = "test-api-key";
const KEY_A = "pgk_" + "D".repeat(43);
const KEY_B = "pgk_" + "E".repeat(43);
const KEY_C = "pgk_" + "F".repeat(43);
const A = "rly-a";
const B = "rly-b";
const C = "rly-c";
const RETIRED: Partial<Env> = { SHARED_KEY_REFUSED_MACHINES: `${A},${B},${C}` };

const S_ON_B = "ses_rlyTargetOnB01";
const S_ON_A = "ses_rlyTargetOnA01";
const SENDER = "ses_rlySenderOnA01";

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
     VALUES (?, ?, ?, NULL, 'relay-test')`,
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

function relayBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    msg_id: "msg_rly_0001",
    from: SENDER,
    to: S_ON_B,
    kind: "chat",
    priority: "normal",
    reply_to: null,
    payload: "hello from A",
    deliver_at: null,
    expires_at: null,
    ref: null,
    from_label: "sender label",
    ...over,
  };
}

const relay = (key: string, over: Record<string, unknown> = {}, envOverride?: Partial<Env>) =>
  call("/swarm/relay", key, { method: "POST", body: relayBody(over), envOverride });

async function row(fromMachine: string, msgId: string) {
  return env.DB.prepare("SELECT * FROM swarm_relay WHERE from_machine = ? AND msg_id = ?")
    .bind(fromMachine, msgId)
    .first<Record<string, unknown>>();
}

async function swarmOf(res: Response): Promise<Array<Record<string, unknown>>> {
  if (res.status === 204) return [];
  const body = (await res.json()) as { swarm?: Array<Record<string, unknown>> };
  return body.swarm ?? [];
}

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  clearCredentialCache();
  await env.DB.prepare("DELETE FROM swarm_relay").run();
  await env.DB.prepare("DELETE FROM machine_relay_accept").run();
  await env.DB.prepare("DELETE FROM sessions WHERE session_id LIKE 'ses_rly%'").run();
  await env.DB.prepare("DELETE FROM commands WHERE machine_id LIKE 'rly-%'").run();
  await env.DB.prepare("DELETE FROM machines WHERE machine_id LIKE 'rly-%'").run();
  await addKey(KEY_A, A);
  await addKey(KEY_B, B);
  await addKey(KEY_C, C);
  await seedSession(S_ON_B, B);
  await seedSession(S_ON_A, A);
  // B is online and accepts relays from A.
  expect((await poll(KEY_B, B, `accept=${A}`)).status).toBe(204);
});

describe("parseRelayHeader", () => {
  it("parses accept and failures, drops malformed machine ids, and treats absence as null", () => {
    expect(parseRelayHeader(null)).toBeNull();
    expect(parseRelayHeader("accept=b,a, a ,BAD!; failures=1")).toEqual({ accept: ["a", "b"], failures: true });
    expect(parseRelayHeader("failures=1")).toEqual({ accept: [], failures: true });
    expect(parseRelayHeader("")).toEqual({ accept: [], failures: false });
  });
});

describe("POST /swarm/relay", () => {
  it("stores a valid relay for the owning machine and answers 202", async () => {
    const res = await relay(KEY_A);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true, to_machine: B });
    const r = await row(A, "msg_rly_0001");
    expect(r).toMatchObject({ item_kind: "message", to_machine: B, to_session: S_ON_B, from_session: SENDER, status: "queued" });
  });

  it("refuses the shared key and no key: from_machine must come from a machine credential", async () => {
    expect((await relay(SHARED, {}, { SHARED_KEY_REFUSED_MACHINES: "" })).status).toBe(401);
    const res = await call("/swarm/relay", null, { method: "POST", body: relayBody() });
    expect(res.status).toBe(401);
  });

  it("refuses a body naming a different from_machine", async () => {
    const res = await relay(KEY_A, { from_machine: C });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "machine_mismatch" });
  });

  it.each([
    ["a msg_id with a colon", { msg_id: "f:x" }],
    ["from='pigeon'", { from: "pigeon" }],
    ["a gse_ sender", { from: "gse_rlySenderOnA01" }],
    ["a target that is not a session id", { to: "foo" }],
    ["a bad priority", { priority: "high" }],
    ["a missing deliver_at", { deliver_at: undefined }],
    ["a missing ref", { ref: undefined }],
    ["a payload over the bound", { payload: "x".repeat(64 * 1024 + 1) }],
  ])("answers 400 for %s", async (_label, over) => {
    const body = relayBody(over);
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete body[k];
    const res = await call("/swarm/relay", KEY_A, { method: "POST", body });
    expect(res.status).toBe(400);
  });

  it("answers 410 expired, not 400, for an expires_at that has passed", async () => {
    const res = await relay(KEY_A, { expires_at: Date.now() - 1 });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: "expired" });
  });

  it("refuses a from registered to another machine, and lets an unregistered from through", async () => {
    await seedSession("ses_rlySenderOnC01", C);
    const res = await relay(KEY_A, { from: "ses_rlySenderOnC01" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "sender_not_yours" });
    // A session local to the receiver, too.
    expect((await relay(KEY_A, { from: S_ON_B })).status).toBe(403);
    await seedSession(SENDER, A);
    expect((await relay(KEY_A)).status).toBe(202);
  });

  it("is idempotent for an identical retry, even with a changed label, and 409s a different message on the same id", async () => {
    expect((await relay(KEY_A)).status).toBe(202);
    const retry = await relay(KEY_A, { from_label: "renamed" });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ duplicate: true });
    const clash = await relay(KEY_A, { payload: "something else" });
    expect(clash.status).toBe(409);
    expect(await clash.json()).toMatchObject({ error: "msg_id_conflict" });
  });

  it("keys on the sending machine, so another machine may reuse a msg_id", async () => {
    await call(`/machines/${B}/next`, KEY_B, { headers: { [SWARM_RELAY_HEADER]: `accept=${A},${C}` } });
    expect((await relay(KEY_A)).status).toBe(202);
    expect((await relay(KEY_C, { payload: "different" })).status).toBe(202);
  });

  it("answers 404 unknown_session for an unregistered target", async () => {
    const res = await relay(KEY_A, { to: "ses_rlyNobodyHas01" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "unknown_session" });
  });

  it("answers 409 same_machine when D1 says the target is the sender's", async () => {
    const res = await relay(KEY_A, { to: S_ON_A });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "same_machine" });
  });

  it("refuses a receiver that the shared key is not retired for (rule 1)", async () => {
    const res = await relay(KEY_A, {}, { SHARED_KEY_REFUSED_MACHINES: `${A}` });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "receiver_not_retired" });
    // `*` retires every machine, so the receiver counts as retired.
    expect((await relay(KEY_A, {}, { SHARED_KEY_REFUSED_MACHINES: "*" })).status).toBe(202);
  });

  it("answers 403 not_accepted when the owner does not list the sender", async () => {
    const res = await relay(KEY_C, { from: "ses_rlySenderOnC01" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_accepted" });
  });

  it("answers 503 target_offline when the owner has not polled within the online window", async () => {
    await env.DB.prepare("UPDATE machines SET last_poll_at = ? WHERE machine_id = ?")
      .bind(Date.now() - 61_000, B)
      .run();
    const res = await relay(KEY_A);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "target_offline" });
  });

  it("answers 429 once the owner has the cap of messages waiting", async () => {
    for (let i = 0; i < RELAY_QUEUE_CAP; i++) {
      expect((await relay(KEY_A, { msg_id: `msg_cap_${i}` })).status).toBe(202);
    }
    expect((await relay(KEY_A, { msg_id: "msg_cap_over" })).status).toBe(429);
  });

  it("caps the worker's deadline at 24h but hands the receiver the sender's own expires_at, null included", async () => {
    const far = Date.now() + 10 * RELAY_MAX_TTL_MS;
    await relay(KEY_A, { expires_at: far });
    const r = await row(A, "msg_rly_0001");
    expect(Number(r!.expires_at)).toBeLessThanOrEqual(Date.now() + RELAY_MAX_TTL_MS);
    const body = JSON.parse(String(r!.body_json));
    expect(body.expires_at).toBe(far);
    expect(body.relay_expires_at).toBe(r!.expires_at);

    await relay(KEY_A, { msg_id: "msg_null_exp" });
    const items = await swarmOf(await poll(KEY_B, B, `accept=${A}`));
    const nullOne = items.find((i) => i.msg_id === "msg_null_exp")!;
    expect(nullOne.expires_at).toBeNull();
    expect(typeof nullOne.relay_expires_at).toBe("number");
  });

  it("answers 503 relay_unavailable before the schema is applied", async () => {
    await env.DB.prepare("ALTER TABLE swarm_relay RENAME TO swarm_relay_hidden").run();
    try {
      const res = await relay(KEY_A);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "relay_unavailable" });
      // ...and the poll still works, without a swarm field.
      const p = await poll(KEY_B, B, `accept=${A}`);
      expect(p.status).toBe(204);
    } finally {
      await env.DB.prepare("ALTER TABLE swarm_relay_hidden RENAME TO swarm_relay").run();
    }
  });
});

describe("hand-out on GET /machines/:id/next", () => {
  it("hands queued items to the owner as a 200 with only swarm, with every field the receiver needs", async () => {
    await relay(KEY_A, { deliver_at: 123, ref: "bd:x", reply_to: "msg_parent" });
    const res = await poll(KEY_B, B, `accept=${A}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.commandId).toBeUndefined();
    expect(body.swarm).toEqual([
      expect.objectContaining({
        item: "message",
        from_machine: A,
        msg_id: "msg_rly_0001",
        from: SENDER,
        to: S_ON_B,
        kind: "chat",
        priority: "normal",
        reply_to: "msg_parent",
        payload: "hello from A",
        deliver_at: 123,
        ref: "bd:x",
        from_label: "sender label",
      }),
    ]);
    expect(await row(A, "msg_rly_0001")).toMatchObject({ status: "leased", lease_count: 1 });
  });

  it("attaches swarm to a command response without changing the command", async () => {
    await relay(KEY_A);
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, status, created_at)
       VALUES ('rly-cmd-1', ?, ?, 'execute', 'do it', '8248645256', 'pending', ?)`,
    )
      .bind(B, S_ON_B, Date.now())
      .run();
    const res = await poll(KEY_B, B, `accept=${A}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ commandId: "rly-cmd-1", command: "do it" });
    expect((body.swarm as unknown[]).length).toBe(1);
  });

  it("gives nothing to a poll without the header, or from a sender not in the request's list", async () => {
    await relay(KEY_A);
    expect((await poll(KEY_B, B)).status).toBe(204);
    expect((await poll(KEY_B, B, `accept=${C}`)).status).toBe(204);
  });

  it("does not hand an item out twice inside the lease, and does again after it lapses", async () => {
    await relay(KEY_A);
    expect(await swarmOf(await poll(KEY_B, B, `accept=${A}`))).toHaveLength(1);
    expect(await swarmOf(await poll(KEY_B, B, `accept=${A}`))).toHaveLength(0);
    await env.DB.prepare("UPDATE swarm_relay SET leased_at = ?").bind(Date.now() - RELAY_LEASE_MS - 1).run();
    expect(await swarmOf(await poll(KEY_B, B, `accept=${A}`))).toHaveLength(1);
  });

  it("stops offering an item after the lease limit", async () => {
    await relay(KEY_A);
    await env.DB.prepare("UPDATE swarm_relay SET status = 'leased', lease_count = ?, leased_at = ?")
      .bind(RELAY_MAX_LEASES, Date.now() - RELAY_LEASE_MS - 1)
      .run();
    expect(await swarmOf(await poll(KEY_B, B, `accept=${A}`))).toHaveLength(0);
  });

  it("skips expired items", async () => {
    await relay(KEY_A);
    await env.DB.prepare("UPDATE swarm_relay SET expires_at = ?").bind(Date.now() - 1).run();
    expect(await swarmOf(await poll(KEY_B, B, `accept=${A}`))).toHaveLength(0);
  });

  it("hands out at most the limit per poll, oldest first", async () => {
    for (let i = 0; i < RELAY_HANDOUT_LIMIT + 3; i++) {
      await relay(KEY_A, { msg_id: `msg_lim_${String(i).padStart(2, "0")}` });
      await env.DB.prepare("UPDATE swarm_relay SET created_at = ? WHERE msg_id = ?")
        .bind(1_000 + i, `msg_lim_${String(i).padStart(2, "0")}`)
        .run();
    }
    const items = await swarmOf(await poll(KEY_B, B, `accept=${A}`));
    expect(items).toHaveLength(RELAY_HANDOUT_LIMIT);
    expect(items[0]!.msg_id).toBe("msg_lim_00");
    expect(items.at(-1)!.msg_id).toBe(`msg_lim_${RELAY_HANDOUT_LIMIT - 1}`);
  });

  it("never hands items to the shared key", async () => {
    await relay(KEY_A);
    const res = await poll(SHARED, B, `accept=${A}`, { SHARED_KEY_REFUSED_MACHINES: `${A},${C}` });
    expect(res.status).toBe(204);
    expect(await row(A, "msg_rly_0001")).toMatchObject({ status: "queued" });
  });

  it("records the accept set only when it changes, and clears it on a header-less poll", async () => {
    const accept = () =>
      env.DB.prepare("SELECT accept_csv, updated_at FROM machine_relay_accept WHERE machine_id = ?")
        .bind(B)
        .first<{ accept_csv: string; updated_at: number }>();
    const first = await accept();
    expect(first!.accept_csv).toBe(A);
    await env.DB.prepare("UPDATE machine_relay_accept SET updated_at = 1 WHERE machine_id = ?").bind(B).run();
    await poll(KEY_B, B, `accept=${A}`);
    expect((await accept())!.updated_at).toBe(1);
    await poll(KEY_B, B);
    expect((await accept())!.accept_csv).toBe("");
    const res = await relay(KEY_A);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_accepted" });
  });
});

describe("ack, refusal and failure items", () => {
  async function relayAndLease(): Promise<void> {
    expect((await relay(KEY_A)).status).toBe(202);
    expect(await swarmOf(await poll(KEY_B, B, `accept=${A}`))).toHaveLength(1);
  }
  const ack = (key: string, items: unknown[]) => call("/swarm/relay/ack", key, { method: "POST", body: { items } });

  it("settles a delivered item, idempotently", async () => {
    await relayAndLease();
    const item = { from_machine: A, msg_id: "msg_rly_0001", outcome: "delivered" };
    const res = await ack(KEY_B, [item]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ results: [{ result: "ok" }] });
    expect(await row(A, "msg_rly_0001")).toMatchObject({ status: "delivered" });
    expect((await ack(KEY_B, [item])).status).toBe(200);
    expect(await row(A, "f:msg_rly_0001")).toBeNull();
  });

  it("only the receiving machine may ack, and never with the shared key", async () => {
    await relayAndLease();
    const res = await ack(KEY_C, [{ from_machine: A, msg_id: "msg_rly_0001", outcome: "delivered" }]);
    expect(await res.json()).toMatchObject({ results: [{ result: "not_yours" }] });
    expect(await row(A, "msg_rly_0001")).toMatchObject({ status: "leased" });
    expect((await ack(SHARED, [{ from_machine: A, msg_id: "msg_rly_0001", outcome: "delivered" }])).status).toBe(401);
  });

  it("turns a refusal into one failure item for the sender, handed out only with failures=1", async () => {
    await relayAndLease();
    await ack(KEY_B, [{ from_machine: A, msg_id: "msg_rly_0001", outcome: "refused", reason: "payload_too_large" }]);
    expect(await row(A, "msg_rly_0001")).toMatchObject({ status: "refused", reason: "payload_too_large" });
    expect(await row(A, "f:msg_rly_0001")).toMatchObject({ item_kind: "failure", to_machine: A, status: "queued" });

    expect(await swarmOf(await poll(KEY_A, A, ""))).toHaveLength(0);
    const items = await swarmOf(await poll(KEY_A, A, "failures=1"));
    expect(items).toEqual([
      {
        item: "failure",
        from_machine: A,
        msg_id: "f:msg_rly_0001",
        original_msg_id: "msg_rly_0001",
        from: SENDER,
        to: S_ON_B,
        reason: "payload_too_large",
        machine: B,
      },
    ]);
    // A failure item that is itself refused is dropped, never answered.
    await ack(KEY_A, [{ from_machine: A, msg_id: "f:msg_rly_0001", outcome: "refused", reason: "no_such_row" }]);
    expect(await row(A, "f:f:msg_rly_0001")).toBeNull();
  });

  it("requires a reason code for a refusal", async () => {
    await relayAndLease();
    const res = await ack(KEY_B, [{ from_machine: A, msg_id: "msg_rly_0001", outcome: "refused" }]);
    expect(res.status).toBe(400);
  });

  it("POST /swarm/relay/fail mints a failure item for a delivered message, once", async () => {
    await relayAndLease();
    await ack(KEY_B, [{ from_machine: A, msg_id: "msg_rly_0001", outcome: "delivered" }]);
    const fail = (key: string) =>
      call("/swarm/relay/fail", key, { method: "POST", body: { from_machine: A, msg_id: "msg_rly_0001", reason: "retries_exhausted" } });
    expect((await fail(KEY_C)).status).toBe(403);
    expect(await row(A, "f:msg_rly_0001")).toBeNull();
    expect((await fail(KEY_B)).status).toBe(200);
    expect((await fail(KEY_B)).status).toBe(200);
    const f = await row(A, "f:msg_rly_0001");
    expect(JSON.parse(String(f!.body_json))).toMatchObject({ reason: "retries_exhausted", machine: B });
    const unknown = await call("/swarm/relay/fail", KEY_B, {
      method: "POST",
      body: { from_machine: A, msg_id: "msg_never", reason: "retries_exhausted" },
    });
    expect(await unknown.json()).toEqual({ ok: true, noop: true });
  });
});

describe("runRelayExpiry", () => {
  it("expires a queued message as never_collected and a leased one as unconfirmed, each with a failure item", async () => {
    await relay(KEY_A, { msg_id: "msg_q" });
    await relay(KEY_A, { msg_id: "msg_l" });
    await env.DB.prepare("UPDATE swarm_relay SET status = 'leased', leased_at = ? WHERE msg_id = 'msg_l'").bind(Date.now()).run();
    const later = Date.now() + RELAY_MAX_TTL_MS + 1;
    const out = await runRelayExpiry(env.DB, later);
    expect(out.expired).toBe(2);
    expect(JSON.parse(String((await row(A, "f:msg_q"))!.body_json)).reason).toBe("never_collected");
    expect(JSON.parse(String((await row(A, "f:msg_l"))!.body_json)).reason).toBe("unconfirmed");
    expect(await row(A, "msg_q")).toMatchObject({ status: "expired" });
  });

  it("expires an item that hit the lease limit, and drops expired failure items without answering them", async () => {
    await relay(KEY_A);
    await env.DB.prepare("UPDATE swarm_relay SET status = 'leased', lease_count = ?, leased_at = ?")
      .bind(RELAY_MAX_LEASES, Date.now() - RELAY_LEASE_MS - 1)
      .run();
    await runRelayExpiry(env.DB);
    expect(await row(A, "f:msg_rly_0001")).toMatchObject({ status: "queued" });
    await runRelayExpiry(env.DB, Date.now() + RELAY_MAX_TTL_MS + 1);
    expect(await row(A, "f:msg_rly_0001")).toMatchObject({ status: "expired" });
    expect(await row(A, "f:f:msg_rly_0001")).toBeNull();
  });

  it("prunes settled rows past retention and keeps live ones", async () => {
    await relay(KEY_A, { msg_id: "msg_old" });
    await relay(KEY_A, { msg_id: "msg_live" });
    await env.DB.prepare("UPDATE swarm_relay SET status = 'delivered', created_at = 1 WHERE msg_id = 'msg_old'").run();
    const out = await runRelayExpiry(env.DB, Date.now() + 1);
    expect(out.pruned).toBe(1);
    expect(await row(A, "msg_old")).toBeNull();
    expect(await row(A, "msg_live")).not.toBeNull();
    expect(RELAY_RETENTION_MS).toBeGreaterThan(RELAY_MAX_TTL_MS);
  });
});
