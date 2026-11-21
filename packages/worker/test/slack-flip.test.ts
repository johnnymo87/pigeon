/**
 * POST /topics/named/rehome: the binding half of `slack-flip` (bead pigeon-4ogz.6; spec
 * docs/plans/2026-11-20-slack-transport-design.md §3 "Flip and unflip move bindings explicitly").
 *
 * Same harness as slack-routing.test.ts: handlers called directly, real per-machine credentials,
 * Slack and Telegram as fetchMocks with `disableNetConnect` and `assertNoPendingInterceptors`, so
 * a missing or unexpected provider call fails the test. Every test uses its own ids.
 */
import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import { sha256Hex } from "../src/credentials";
import { SLACK_HANDLE_MIN, slackChatId, slackSecretKeyForMachine, type SlackWorkspace } from "../src/chat/slack-config";
import { getBindingForSession, getBoundSessionByThread } from "../src/named-topics";
import { handleNamedTopicRehome, REHOME_MAX_LIMIT, REHOME_SLACK_BACKOFF_S } from "../src/named-topic-rehome";
import { handleSendNotification } from "../src/notifications";

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  slackCalls.length = 0;
  tgCalls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fetchMock.assertNoPendingInterceptors();
  } finally {
    fetchMock.deactivate();
  }
});

// ─── fixtures ──────────────────────────────────────────────────────────────

const ALLOWED = "8248645256"; // ALLOWED_CHAT_IDS in vitest.config.ts
const SHARED = "test-api-key";

let counter = 0;
const stamp = () => `${Date.now().toString(36)}${(++counter).toString(36)}`;

interface Machine {
  machineId: string;
  key: string;
  ws: SlackWorkspace;
}

async function mkMachine(): Promise<Machine> {
  const machineId = `fl${stamp()}`.toLowerCase().slice(0, 30);
  const key = ("pgk_" + machineId + "x".repeat(43)).slice(0, 47);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO machine_credentials (key_sha256, machine_id, created_at, revoked_at, note)
     VALUES (?, ?, ?, NULL, 'test')`,
  )
    .bind(await sha256Hex(key), machineId, Date.now())
    .run();
  const ws: SlackWorkspace = {
    teamId: `T${stamp()}`.toUpperCase(),
    appId: "A0APP",
    domain: "acme",
    botToken: "xoxb-bot",
    userToken: "xoxp-user",
    signingSecret: "sig",
    ownerUserId: "U0OWNER",
  };
  return { machineId, key, ws };
}

/** `on` lists the machines whose SLACK_WORKSPACE_* secret this isolate sees. */
function envFor(on: Machine[]): Env {
  const secrets: Record<string, string> = {};
  for (const m of on) secrets[slackSecretKeyForMachine(m.machineId)] = JSON.stringify(m.ws);
  return { ...env, TELEGRAM_TOPICS_ENABLED: "true", ...secrets } as unknown as Env;
}

function request(key: string, body: unknown): Request {
  return new Request("https://worker/topics/named/rehome", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

const rehome = (e: Env, key: string, body: Record<string, unknown>) => handleNamedTopicRehome(env.DB, e, request(key, body));

async function seedSession(machineId: string): Promise<string> {
  const sessionId = `gse_${String(++counter).padStart(4, "0")}fl${Date.now().toString(36)}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, 'coord', ?, ?)",
  )
    .bind(sessionId, machineId, now, now)
    .run();
  return sessionId;
}

/** A Telegram named topic bound to `sessionId`, as a coordinator has before the flip. */
async function seedTelegramBinding(sessionId: string, key: string, thread: number, chatId = ALLOWED) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO named_topics (chat_id, topic_key, message_thread_id, name, reopen_checked_at, hint_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
    .bind(chatId, key, thread, `📋 ${key}`, now, now, now)
    .run();
  await env.DB.prepare("INSERT INTO named_topic_bindings (chat_id, topic_key, session_id, bound_at) VALUES (?, ?, ?, ?)")
    .bind(chatId, key, sessionId, now)
    .run();
}

interface SlackCall {
  method: string;
  params: URLSearchParams;
}
const slackCalls: SlackCall[] = [];

function slack(method: string, reply: Record<string, unknown>, status = 200, headers?: Record<string, string>) {
  fetchMock
    .get("https://slack.com")
    .intercept({ method: "POST", path: `/api/${method}` })
    .reply(
      status,
      (opts: { body?: unknown }) => {
        slackCalls.push({ method, params: new URLSearchParams(String(opts.body)) });
        return reply;
      },
      headers ? { headers } : undefined,
    );
}
const slackOf = (method: string) => slackCalls.filter((c) => c.method === method);

function slackCreate(channelId: string, name: string) {
  slack("conversations.create", { ok: true, channel: { id: channelId, name } });
  slack("conversations.invite", { ok: true });
  slack("conversations.setTopic", { ok: true });
}

const tgCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
function tg(method: string, result: unknown) {
  fetchMock
    .get("https://api.telegram.org")
    .intercept({ method: "POST", path: new RegExp(`/bot.*/${method}$`) })
    .reply(200, (opts: { body?: unknown }) => {
      const raw = typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body as ArrayBuffer);
      tgCalls.push({ method, body: JSON.parse(raw) });
      return { ok: true, result };
    });
}

interface RehomeBody {
  transport: string;
  pending: number;
  results: Array<{ sessionId: string; key: string; outcome: string; chatId?: string; messageThreadId?: number; reason?: string }>;
  next: string | null;
  retryAfter?: number;
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe("POST /topics/named/rehome", () => {
  it("on: creates the coordinator's Slack channel at once and re-points its binding; it then routes both ways", async () => {
    const m = await mkMachine();
    const coord = await seedSession(m.machineId);
    await seedTelegramBinding(coord, "stallwatch:chat-transport", 4101);
    slackCreate("CCOORD1", "stallwatch-chat-transport");

    const res = await rehome(envFor([m]), m.key, { machine: m.machineId, expect: "slack" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RehomeBody;
    expect(body.transport).toBe("slack");
    expect(body.next).toBeNull();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ sessionId: coord, key: "stallwatch:chat-transport", outcome: "moved" });
    expect(slackOf("conversations.create")[0]?.params.get("name")).toBe("stallwatch-chat-transport");
    // The topic line is the Telegram topic's human name, not the key.
    expect(slackOf("conversations.setTopic")[0]?.params.get("topic")).toBe("📋 stallwatch:chat-transport");

    const chat = slackChatId(m.ws);
    const binding = await getBindingForSession(env.DB, coord);
    expect(binding?.chat_id).toBe(chat);
    expect(binding!.message_thread_id).toBeGreaterThanOrEqual(SLACK_HANDLE_MIN);
    // Inbound: a message typed in the new channel reaches the coordinator.
    expect(await getBoundSessionByThread(env.DB, chat, binding!.message_thread_id)).toBe(coord);
    // The Telegram topic is left as history; nothing routes to it any more.
    expect(await getBoundSessionByThread(env.DB, ALLOWED, 4101)).toBeNull();

    // Outbound: the coordinator's next notification lands in that channel.
    slack("chat.postMessage", { ok: true, ts: "1700000000.000200", channel: "CCOORD1" });
    const sent = await handleSendNotification(
      env.DB,
      envFor([m]),
      new Request("https://worker/notifications/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${m.key}` },
        body: JSON.stringify({ sessionId: coord, chatId: ALLOWED, text: "tick", notificationId: `s:${coord}:1` }),
      }),
    );
    expect(sent.status).toBe(200);
    expect(slackOf("chat.postMessage")[0]?.params.get("channel")).toBe("CCOORD1");
  });

  it("is idempotent: a second run moves nothing and calls nothing", async () => {
    const m = await mkMachine();
    const coord = await seedSession(m.machineId);
    await seedTelegramBinding(coord, "stallwatch:idem", 4102);
    slackCreate("CIDEM1", "stallwatch-idem");
    expect((await rehome(envFor([m]), m.key, { machine: m.machineId, expect: "slack" })).status).toBe(200);

    const again = (await (await rehome(envFor([m]), m.key, { machine: m.machineId, expect: "slack" })).json()) as RehomeBody;
    expect(again).toMatchObject({ pending: 0, results: [], next: null });
    expect(slackOf("conversations.create")).toHaveLength(1);
  });

  it("only moves the named machine's bindings", async () => {
    const m = await mkMachine();
    const other = await mkMachine();
    const mine = await seedSession(m.machineId);
    const theirs = await seedSession(other.machineId);
    await seedTelegramBinding(mine, "stallwatch:mine", 4103);
    await seedTelegramBinding(theirs, "stallwatch:theirs", 4104);
    slackCreate("CMINE1", "stallwatch-mine");

    const body = (await (await rehome(envFor([m]), m.key, { machine: m.machineId, expect: "slack" })).json()) as RehomeBody;
    expect(body.results.map((r) => r.sessionId)).toEqual([mine]);
    expect((await getBindingForSession(env.DB, theirs))?.chat_id).toBe(ALLOWED);
  });

  it("refuses to move against the transport this isolate sees (409), so it is safe for any machine key", async () => {
    const m = await mkMachine();
    const coord = await seedSession(m.machineId);
    await seedTelegramBinding(coord, "stallwatch:early", 4105);

    // The secret has not reached this isolate yet.
    const early = await rehome(envFor([]), m.key, { machine: m.machineId, expect: "slack" });
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ error: "transport_mismatch", transport: "telegram" });

    // And the inverse: the secret is still visible, so nothing may move back to Telegram.
    const late = await rehome(envFor([m]), m.key, { machine: m.machineId, expect: "telegram" });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: "transport_mismatch", transport: "slack" });
    expect((await getBindingForSession(env.DB, coord))?.chat_id).toBe(ALLOWED);
  });

  it("another machine's key may run it (the flip runs on devbox for every machine); the shared key may not (401)", async () => {
    const m = await mkMachine();
    const runner = await mkMachine();
    const coord = await seedSession(m.machineId);
    await seedTelegramBinding(coord, "stallwatch:remote", 4106);

    expect((await rehome(envFor([m]), SHARED, { machine: m.machineId, expect: "slack" })).status).toBe(401);
    expect((await rehome(envFor([m]), "pgk_nope", { machine: m.machineId, expect: "slack" })).status).toBe(401);

    slackCreate("CREMOTE1", "stallwatch-remote");
    const res = await rehome(envFor([m]), runner.key, { machine: m.machineId, expect: "slack" });
    expect(res.status).toBe(200);
    expect((await getBindingForSession(env.DB, coord))?.chat_id).toBe(slackChatId(m.ws));
  });

  it("validates its body", async () => {
    const m = await mkMachine();
    const e = envFor([m]);
    expect((await rehome(e, m.key, { expect: "slack" })).status).toBe(400);
    expect((await rehome(e, m.key, { machine: "Bad Id", expect: "slack" })).status).toBe(400);
    expect((await rehome(e, m.key, { machine: m.machineId, expect: "teams" })).status).toBe(400);
    expect((await rehome(e, m.key, { machine: m.machineId, expect: "slack", limit: 0 })).status).toBe(400);
    expect((await rehome(e, m.key, { machine: m.machineId, expect: "slack", limit: REHOME_MAX_LIMIT + 1 })).status).toBe(400);
    expect((await rehome(e, m.key, { machine: m.machineId, expect: "telegram", telegramChatId: "555" })).status).toBe(400);
  });

  it("dry run lists what would move and calls no provider", async () => {
    const m = await mkMachine();
    const a = await seedSession(m.machineId);
    const b = await seedSession(m.machineId);
    await seedTelegramBinding(a, "stallwatch:dry-a", 4107);
    await seedTelegramBinding(b, "stallwatch:dry-b", 4108);

    const body = (await (await rehome(envFor([m]), m.key, { machine: m.machineId, expect: "slack", dryRun: true })).json()) as RehomeBody;
    expect(body.pending).toBe(2);
    expect(body.results.map((r) => r.outcome)).toEqual(["pending", "pending"]);
    expect((await getBindingForSession(env.DB, a))?.chat_id).toBe(ALLOWED);

    // Before the secret exists, too: the preview of a flip, against the transport it is still on.
    const before = (await (await rehome(envFor([]), m.key, { machine: m.machineId, expect: "slack", dryRun: true })).json()) as RehomeBody;
    expect(before).toMatchObject({ transport: "telegram", pending: 2 });
  });

  it("pages with a cursor, and stops at a Slack 429 without skipping the limited binding", async () => {
    const m = await mkMachine();
    const s1 = await seedSession(m.machineId);
    const s2 = await seedSession(m.machineId);
    const s3 = await seedSession(m.machineId);
    await seedTelegramBinding(s1, "stallwatch:p1", 4111);
    await seedTelegramBinding(s2, "stallwatch:p2", 4112);
    await seedTelegramBinding(s3, "stallwatch:p3", 4113);
    const e = envFor([m]);

    slackCreate("CP1", "stallwatch-p1");
    const first = (await (await rehome(e, m.key, { machine: m.machineId, expect: "slack", limit: 1 })).json()) as RehomeBody;
    expect(first.results.map((r) => [r.sessionId, r.outcome])).toEqual([[s1, "moved"]]);
    expect(first.next).toBe(s1);
    expect(first.pending).toBe(2);

    slack("conversations.create", { ok: false, error: "ratelimited" }, 429, { "Retry-After": "7" });
    const limited = (await (await rehome(e, m.key, { machine: m.machineId, expect: "slack", after: first.next })).json()) as RehomeBody;
    expect(limited.retryAfter).toBe(REHOME_SLACK_BACKOFF_S);
    expect(limited.results).toEqual([]);
    expect(limited.next).toBe(s1); // s2 is retried, not skipped

    slackCreate("CP2", "stallwatch-p2");
    slackCreate("CP3", "stallwatch-p3");
    const rest = (await (await rehome(e, m.key, { machine: m.machineId, expect: "slack", after: limited.next })).json()) as RehomeBody;
    expect(rest.results.map((r) => [r.sessionId, r.outcome])).toEqual([
      [s2, "moved"],
      [s3, "moved"],
    ]);
    expect(rest.next).toBeNull();
    expect(rest.pending).toBe(0);
  });

  it("a create failure is reported per binding and does not stop the others", async () => {
    const m = await mkMachine();
    const bad = await seedSession(m.machineId);
    const good = await seedSession(m.machineId);
    await seedTelegramBinding(bad, "stallwatch:bad", 4121);
    await seedTelegramBinding(good, "stallwatch:good", 4122);
    slack("conversations.create", { ok: false, error: "restricted_action" });
    slackCreate("CGOOD", "stallwatch-good");

    const body = (await (await rehome(envFor([m]), m.key, { machine: m.machineId, expect: "slack" })).json()) as RehomeBody;
    expect(body.results.map((r) => [r.sessionId, r.outcome])).toEqual([
      [bad, "failed"],
      [good, "moved"],
    ]);
    expect((await getBindingForSession(env.DB, bad))?.chat_id).toBe(ALLOWED);
    expect(body.pending).toBe(1);
  });

  it("off: moves the binding back to its Telegram topic, which routes again; the Slack row is left alone", async () => {
    const m = await mkMachine();
    const coord = await seedSession(m.machineId);
    await seedTelegramBinding(coord, "stallwatch:back", 4131);
    slackCreate("CBACK1", "stallwatch-back");
    expect((await rehome(envFor([m]), m.key, { machine: m.machineId, expect: "slack" })).status).toBe(200);
    const onSlack = await getBindingForSession(env.DB, coord);

    // The secret is deleted; the old Telegram topic still exists and was checked recently, so no call.
    const res = await rehome(envFor([]), m.key, { machine: m.machineId, expect: "telegram" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RehomeBody;
    expect(body.results[0]).toMatchObject({ sessionId: coord, outcome: "moved", chatId: ALLOWED, messageThreadId: 4131 });
    expect(await getBindingForSession(env.DB, coord)).toMatchObject({ chat_id: ALLOWED, message_thread_id: 4131 });
    expect(await getBoundSessionByThread(env.DB, ALLOWED, 4131)).toBe(coord);
    expect(await getBoundSessionByThread(env.DB, slackChatId(m.ws), onSlack!.message_thread_id)).toBeNull();
    expect(slackCalls).toHaveLength(3); // only the create from the flip
  });

  it("off: a binding born on Slack needs telegramChatId, and gets a topic created there", async () => {
    const m = await mkMachine();
    const coord = await seedSession(m.machineId);
    // Bound on Slack directly (after the flip), never had a Telegram topic.
    const chat = slackChatId(m.ws);
    await env.DB.prepare("INSERT INTO slack_conversations (team_id, channel_id, created_at, owner_invited) VALUES (?, 'CBORN', ?, 1)")
      .bind(m.ws.teamId, Date.now())
      .run();
    const handle = (await env.DB.prepare("SELECT handle FROM slack_conversations WHERE team_id = ? AND channel_id = 'CBORN'")
      .bind(m.ws.teamId)
      .first<{ handle: number }>())!.handle;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO named_topics (chat_id, topic_key, message_thread_id, name, reopen_checked_at, hint_at, created_at, updated_at)
       VALUES (?, 'stallwatch:born', ?, 'Born', ?, NULL, ?, ?)`,
    )
      .bind(chat, handle, now, now, now)
      .run();
    await env.DB.prepare("INSERT INTO named_topic_bindings (chat_id, topic_key, session_id, bound_at) VALUES (?, 'stallwatch:born', ?, ?)")
      .bind(chat, coord, now)
      .run();

    const unplaced = (await (await rehome(envFor([]), m.key, { machine: m.machineId, expect: "telegram" })).json()) as RehomeBody;
    expect(unplaced.results[0]).toMatchObject({ sessionId: coord, outcome: "unplaced" });
    expect((await getBindingForSession(env.DB, coord))?.chat_id).toBe(chat);

    tg("createForumTopic", { message_thread_id: 4141, name: "Born", icon_color: 1 });
    const placed = (await (
      await rehome(envFor([]), m.key, { machine: m.machineId, expect: "telegram", telegramChatId: ALLOWED })
    ).json()) as RehomeBody;
    expect(placed.results[0]).toMatchObject({ outcome: "moved", chatId: ALLOWED, messageThreadId: 4141 });
    expect(tgCalls[0]?.body.name).toBe("Born");
    expect(await getBindingForSession(env.DB, coord)).toMatchObject({ chat_id: ALLOWED, message_thread_id: 4141 });
  });

  it("off: never takes a key another machine's session holds in the target chat", async () => {
    const m = await mkMachine();
    const other = await mkMachine();
    const coord = await seedSession(m.machineId);
    const theirs = await seedSession(other.machineId);
    // The other machine's coordinator owns stallwatch:shared in ALLOWED.
    await seedTelegramBinding(theirs, "stallwatch:shared", 4151);
    // Ours was bound on Slack.
    const chat = slackChatId(m.ws);
    await env.DB.prepare("INSERT INTO slack_conversations (team_id, channel_id, created_at, owner_invited) VALUES (?, 'CSHARED', ?, 1)")
      .bind(m.ws.teamId, Date.now())
      .run();
    const handle = (await env.DB.prepare("SELECT handle FROM slack_conversations WHERE team_id = ? AND channel_id = 'CSHARED'")
      .bind(m.ws.teamId)
      .first<{ handle: number }>())!.handle;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO named_topics (chat_id, topic_key, message_thread_id, name, reopen_checked_at, hint_at, created_at, updated_at)
       VALUES (?, 'stallwatch:shared', ?, 'Shared', ?, NULL, ?, ?)`,
    )
      .bind(chat, handle, now, now, now)
      .run();
    await env.DB.prepare("INSERT INTO named_topic_bindings (chat_id, topic_key, session_id, bound_at) VALUES (?, 'stallwatch:shared', ?, ?)")
      .bind(chat, coord, now)
      .run();

    for (const body of [{}, { telegramChatId: ALLOWED }]) {
      const res = (await (await rehome(envFor([]), m.key, { machine: m.machineId, expect: "telegram", ...body })).json()) as RehomeBody;
      expect(res.results[0]).toMatchObject({ sessionId: coord, outcome: "failed" });
      expect(res.results[0]!.reason).toContain(other.machineId);
    }
    expect((await getBindingForSession(env.DB, theirs))?.chat_id).toBe(ALLOWED);
    expect(await getBoundSessionByThread(env.DB, ALLOWED, 4151)).toBe(theirs);
    expect((await getBindingForSession(env.DB, coord))?.chat_id).toBe(chat);
  });

  it("on: a _-prefixed key is never moved onto Slack (it would take over a reserved channel like #alerts)", async () => {
    const m = await mkMachine();
    const coord = await seedSession(m.machineId);
    await seedTelegramBinding(coord, "_alerts", 4161);
    const body = (await (await rehome(envFor([m]), m.key, { machine: m.machineId, expect: "slack" })).json()) as RehomeBody;
    expect(body.results[0]).toMatchObject({ sessionId: coord, outcome: "failed", reason: "reserved key" });
    expect((await getBindingForSession(env.DB, coord))?.chat_id).toBe(ALLOWED);
    expect(slackCalls).toHaveLength(0);
  });
});
