/**
 * Slack ingress (bead pigeon-4ogz.4; spec docs/plans/2026-11-20-slack-transport-design.md §5 and
 * its "Verification" list). Requests go through `worker.fetch`, signed with the workspace's
 * signing secret, so routing, the signature check and the handlers are exercised together. Slack
 * is a fetchMock with `disableNetConnect` and `assertNoPendingInterceptors`, so a missing OR an
 * unexpected Slack call fails the test. Every test uses its own machine, team and session ids:
 * the D1 tables are shared by the whole file.
 */
import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import worker from "../src/index";
import { slackChatId, slackSecretKeyForMachine, type SlackWorkspace } from "../src/chat/slack-config";
import { slackSignature, verifySlackSignature } from "../src/chat/slack-verify";
import { finalize, reserve } from "../src/topics";
import { MAX_COMMAND_LENGTH } from "../src/chat/limits";
import { handleSlackRequest, pickSlackFile, SLACK_APP_COMMANDS, slackTextToPlain, sweepSlackSeenEvents } from "../src/slack-inbound";
import manifestRaw from "../slack/manifest.template.json?raw";

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  slackCalls.length = 0;
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

let counter = 0;
const stamp = () => `${Date.now().toString(36)}${(++counter).toString(36)}`;

const OWNER = "U0OWNER";

interface Box {
  machineId: string;
  ws: SlackWorkspace;
  chat: string;
  env: Env;
}

async function mkBox(opts: { online?: boolean } = {}): Promise<Box> {
  const machineId = `si${stamp()}`.toLowerCase().slice(0, 30);
  const ws: SlackWorkspace = {
    teamId: `T${stamp()}`.toUpperCase(),
    appId: "A0APP",
    domain: "acme",
    botToken: "xoxb-bot",
    userToken: "xoxp-user",
    signingSecret: `sig-${machineId}`,
    ownerUserId: OWNER,
  };
  if (opts.online !== false) {
    await env.DB.prepare("INSERT OR REPLACE INTO machines (machine_id, last_poll_at) VALUES (?, ?)")
      .bind(machineId, Date.now())
      .run();
  }
  const boxEnv = {
    ...env,
    [slackSecretKeyForMachine(machineId)]: JSON.stringify(ws),
  } as unknown as Env;
  return { machineId, ws, chat: slackChatId(ws), env: boxEnv };
}

async function seedSession(machineId: string, sessionId?: string): Promise<string> {
  const id = sessionId ?? `ses_${String(++counter).padStart(4, "0")}in${Date.now().toString(36)}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, machineId, "inbound", now, now)
    .run();
  return id;
}

async function seedChannel(ws: SlackWorkspace, channelId = `C${stamp()}`.toUpperCase()) {
  await env.DB.prepare("INSERT INTO slack_conversations (team_id, channel_id, created_at, owner_invited) VALUES (?, ?, ?, 1)")
    .bind(ws.teamId, channelId, Date.now())
    .run();
  const row = await env.DB.prepare("SELECT handle FROM slack_conversations WHERE team_id = ? AND channel_id = ?")
    .bind(ws.teamId, channelId)
    .first<{ handle: number }>();
  return { channelId, handle: row!.handle };
}

/** A session with its own Slack channel (a `topics` row under slack:<team>). */
async function seedSessionChannel(box: Box) {
  const sessionId = await seedSession(box.machineId);
  const ch = await seedChannel(box.ws);
  await reserve(env.DB, { sessionId, machineId: box.machineId, chatId: box.chat, name: "title · ~/proj" });
  await finalize(env.DB, { sessionId, chatId: box.chat, messageThreadId: ch.handle, name: "title · ~/proj", provisional: false });
  return { sessionId, ...ch };
}

async function seedNamedChannel(box: Box, key: string) {
  const ch = await seedChannel(box.ws);
  await env.DB.prepare(
    `INSERT INTO named_topics (chat_id, topic_key, message_thread_id, name, reopen_checked_at, hint_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, 0, 0)`,
  )
    .bind(box.chat, key, ch.handle, key)
    .run();
  return ch;
}

/** A post the worker made, with its `messages` row when it belongs to a session. */
async function seedPost(
  box: Box,
  channelId: string,
  ts: string,
  text: string,
  session?: { sessionId: string; notificationId?: string; token?: string },
) {
  await env.DB.prepare("INSERT INTO slack_posts (team_id, channel_id, ts, text, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(box.ws.teamId, channelId, ts, text, Date.now())
    .run();
  const row = await env.DB.prepare("SELECT handle FROM slack_posts WHERE team_id = ? AND channel_id = ? AND ts = ?")
    .bind(box.ws.teamId, channelId, ts)
    .first<{ handle: number }>();
  if (session) {
    await env.DB.prepare(
      "INSERT INTO messages (chat_id, message_id, session_id, token, notification_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(box.chat, row!.handle, session.sessionId, session.token ?? `tok${stamp()}`, session.notificationId ?? null, Date.now())
      .run();
  }
  return row!.handle;
}

interface SlackCall {
  method: string;
  params: URLSearchParams;
}
const slackCalls: SlackCall[] = [];

function slack(method: string, reply: Record<string, unknown>) {
  fetchMock
    .get("https://slack.com")
    .intercept({ method: "POST", path: `/api/${method}` })
    .reply(200, (opts: { body?: unknown }) => {
      slackCalls.push({ method, params: new URLSearchParams(String(opts.body)) });
      return reply;
    });
}
const slackOf = (method: string) => slackCalls.filter((c) => c.method === method);

async function signed(
  box: Box,
  endpoint: string,
  body: string,
  contentType: string,
  opts: { secret?: string; ts?: number; signature?: string; machine?: string } = {},
): Promise<Request> {
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = opts.signature ?? (await slackSignature(opts.secret ?? box.ws.signingSecret, ts, body));
  return new Request(`https://worker/slack/${opts.machine ?? box.machineId}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": contentType, "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig },
    body,
  });
}

type Waits = Promise<unknown>[];

async function call(box: Box, req: Request, waits?: Waits): Promise<Response> {
  if (!waits) return worker.fetch(req, box.env);
  const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;
  return worker.fetch(req, box.env, ctx);
}

function eventBody(box: Box, event: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "event_callback",
    team_id: box.ws.teamId,
    api_app_id: box.ws.appId,
    event_id: `Ev${stamp()}`,
    event: { type: "message", user: OWNER, ts: `${1700000000 + ++counter}.000100`, ...event },
    ...extra,
  });
}

async function sendEvent(box: Box, event: Record<string, unknown>, extra: Record<string, unknown> = {}, waits?: Waits) {
  return call(box, await signed(box, "events", eventBody(box, event, extra), "application/json"), waits);
}

async function sendCommand(box: Box, command: string, text: string, channelId: string, user = OWNER) {
  const form = new URLSearchParams({
    team_id: box.ws.teamId,
    api_app_id: box.ws.appId,
    user_id: user,
    channel_id: channelId,
    command,
    text,
    response_url: "https://example.invalid/r",
  }).toString();
  return call(box, await signed(box, "commands", form, "application/x-www-form-urlencoded"));
}

async function sendAction(box: Box, channelId: string, action: Record<string, unknown>, user = OWNER) {
  const payload = {
    type: "block_actions",
    api_app_id: box.ws.appId,
    team: { id: box.ws.teamId },
    user: { id: user },
    channel: { id: channelId },
    container: { channel_id: channelId, message_ts: "1.1" },
    actions: [{ action_id: "b0_0", type: "button", ...action }],
  };
  const form = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  return call(box, await signed(box, "interactivity", form, "application/x-www-form-urlencoded"));
}

interface CommandRow {
  command_id: string;
  machine_id: string;
  session_id: string | null;
  command_type: string;
  command: string;
  chat_id: string;
  message_thread_id: number | null;
  metadata_json: string | null;
  media_json: string | null;
  directory: string | null;
}

async function commandsFor(machineId: string): Promise<CommandRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM commands WHERE machine_id = ? ORDER BY created_at")
    .bind(machineId)
    .all<CommandRow>();
  return results ?? [];
}

async function json(res: Response) {
  return (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ─── signature, routing, team check ────────────────────────────────────────

describe("signature and routing", () => {
  it("verifySlackSignature: good, bad, stale, missing", async () => {
    const now = 1_700_000_000_000;
    const ts = String(now / 1000);
    const good = await slackSignature("s3cret", ts, "body");
    const h = (sig: string | null, t: string | null = ts) => {
      const headers = new Headers();
      if (sig !== null) headers.set("x-slack-signature", sig);
      if (t !== null) headers.set("x-slack-request-timestamp", t);
      return headers;
    };
    expect(await verifySlackSignature(h(good), "body", "s3cret", now)).toEqual({ ok: true });
    expect(await verifySlackSignature(h(good), "body!", "s3cret", now)).toEqual({ ok: false, reason: "mismatch" });
    expect(await verifySlackSignature(h(good), "body", "other", now)).toEqual({ ok: false, reason: "mismatch" });
    expect(await verifySlackSignature(h(good), "body", "s3cret", now + 301_000)).toEqual({ ok: false, reason: "stale" });
    expect(await verifySlackSignature(h(good), "body", "s3cret", now - 301_000)).toEqual({ ok: false, reason: "stale" });
    expect(await verifySlackSignature(h(null), "body", "s3cret", now)).toEqual({ ok: false, reason: "missing" });
    expect(await verifySlackSignature(h(good, null), "body", "s3cret", now)).toEqual({ ok: false, reason: "missing" });
  });

  it("with no workspace secret for the path's machine, every endpoint is the router's ordinary 404", async () => {
    const box = await mkBox();
    for (const endpoint of ["events", "commands", "interactivity"]) {
      const req = await signed(box, endpoint, "{}", "application/json", { machine: "nosuchmachine" });
      const res = await call(box, req);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
    const plain = await worker.fetch(new Request("https://worker/slack/x/events", { method: "POST", body: "{}" }), env);
    expect(plain.status).toBe(404);
    expect(await plain.json()).toEqual({ error: "Not found" });
  });

  it("refuses a bad, a stale and another workspace's signature on all three endpoints", async () => {
    const box = await mkBox();
    const other = await mkBox();
    for (const endpoint of ["events", "commands", "interactivity"]) {
      const bad = await call(box, await signed(box, endpoint, "{}", "application/json", { signature: "v0=00" }));
      expect(bad.status).toBe(401);
      const stale = await call(
        box,
        await signed(box, endpoint, "{}", "application/json", { ts: Math.floor(Date.now() / 1000) - 600 }),
      );
      expect(stale.status).toBe(401);
      // Signed with the other machine's (valid) secret, sent to this machine's path.
      const crossed = await call(box, await signed(box, endpoint, "{}", "application/json", { secret: other.ws.signingSecret }));
      expect(crossed.status).toBe(401);
    }
  });

  it("answers url_verification with its challenge, without a team or app id", async () => {
    const box = await mkBox();
    const body = JSON.stringify({ token: "legacy", challenge: "chal-123", type: "url_verification" });
    const res = await call(box, await signed(box, "events", body, "application/json"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "chal-123" });
  });

  it("refuses an event, a command and an interaction whose team_id or api_app_id is not the workspace's", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    expect((await sendEvent(box, { channel: ch.channelId, text: "x" }, { team_id: "TOTHER" })).status).toBe(403);
    expect((await sendEvent(box, { channel: ch.channelId, text: "x" }, { api_app_id: "AOTHER" })).status).toBe(403);
    const form = new URLSearchParams({ team_id: "TOTHER", api_app_id: box.ws.appId, user_id: OWNER, command: "/kill", channel_id: ch.channelId });
    expect((await call(box, await signed(box, "commands", form.toString(), "application/x-www-form-urlencoded"))).status).toBe(403);
    const payload = new URLSearchParams({
      payload: JSON.stringify({ type: "block_actions", team: { id: box.ws.teamId }, api_app_id: "AOTHER", user: { id: OWNER } }),
    });
    expect((await call(box, await signed(box, "interactivity", payload.toString(), "application/x-www-form-urlencoded"))).status).toBe(403);
    expect(await commandsFor(box.machineId)).toEqual([]);
  });
});

// ─── events ────────────────────────────────────────────────────────────────

describe("events", () => {
  it("a message in a session's channel queues an execute command for it, addressed to the channel", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    const res = await sendEvent(box, { channel: ch.channelId, text: "fix the &lt;b&gt; tag &amp; see <https://x.io/a|x.io/a>" });
    expect(res.status).toBe(200);
    const rows = await commandsFor(box.machineId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: ch.sessionId,
      command_type: "execute",
      command: "fix the <b> tag & see https://x.io/a",
      chat_id: box.chat,
      message_thread_id: ch.handle,
    });
    expect(JSON.parse(rows[0]!.metadata_json!)).toEqual({ senderId: OWNER });
  });

  it("Slack's in-channel echo of one of our slash commands is not injected as a prompt", async () => {
    // A command answered `in_channel` makes Slack post the typed command as an ordinary owner
    // message, which arrives as a message event. The command itself already ran.
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    for (const text of ["/retitle Live check retitled", "/kill", "/launch devbox pigeon hi", "/tag  x", "/Retitle Mixed"]) {
      expect((await sendEvent(box, { channel: ch.channelId, text })).status).toBe(200);
    }
    expect(await commandsFor(box.machineId)).toEqual([]);
    // Text that merely starts with a slash is still a prompt.
    await sendEvent(box, { channel: ch.channelId, text: "/tmp/x is full" });
    await sendEvent(box, { channel: ch.channelId, text: "/launchpad is broken" });
    expect((await commandsFor(box.machineId)).map((r) => r.command)).toEqual(["/tmp/x is full", "/launchpad is broken"]);
  });

  it("a retried event (same event_id) queues once", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    const body = eventBody(box, { channel: ch.channelId, text: "once" });
    expect((await call(box, await signed(box, "events", body, "application/json"))).status).toBe(200);
    expect((await call(box, await signed(box, "events", body, "application/json"))).status).toBe(200);
    expect(await commandsFor(box.machineId)).toHaveLength(1);
  });

  it("a D1 failure in the inline batch is a 5xx (Slack retries) and leaves nothing behind", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    const body = eventBody(box, { channel: ch.channelId, text: "boom" });
    const failing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") return () => Promise.reject(new Error("D1_ERROR: network lost"));
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    await expect(
      handleSlackRequest(failing, box.env, await signed(box, "events", body, "application/json"), box.machineId, "events"),
    ).rejects.toThrow(/network lost/);
    // The retry then succeeds: the failed batch recorded no seen-event row.
    expect((await call(box, await signed(box, "events", body, "application/json"))).status).toBe(200);
    expect(await commandsFor(box.machineId)).toHaveLength(1);
  });

  it("drops bots, other users and subtypes other than none / file_share / thread_broadcast", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    await sendEvent(box, { channel: ch.channelId, text: "bot", bot_id: "B1" });
    await sendEvent(box, { channel: ch.channelId, text: "stranger", user: "UOTHER" });
    await sendEvent(box, { channel: ch.channelId, text: "edit", subtype: "message_changed" });
    await sendEvent(box, { channel: ch.channelId, text: "joined", subtype: "channel_join" });
    await sendEvent(box, { channel: ch.channelId, text: "x", user: undefined });
    expect(await commandsFor(box.machineId)).toEqual([]);
    await sendEvent(box, { channel: ch.channelId, text: "broadcast", subtype: "thread_broadcast", thread_ts: "1.0" });
    expect((await commandsFor(box.machineId)).map((r) => r.command)).toEqual(["broadcast"]);
  });

  it("a thread reply to a quiet question in #alerts goes to the question's session, with its id and text", async () => {
    const box = await mkBox();
    const sessionId = await seedSession(box.machineId);
    const alerts = await seedNamedChannel(box, "_alerts");
    await seedPost(box, alerts.channelId, "1700000001.000100", "Which branch?", {
      sessionId,
      notificationId: `q:${sessionId}:req-7#c0`,
    });
    await sendEvent(box, { channel: alerts.channelId, text: "main", thread_ts: "1700000001.000100" });
    const rows = await commandsFor(box.machineId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: sessionId, command: "main", message_thread_id: alerts.handle });
    expect(JSON.parse(rows[0]!.metadata_json!)).toEqual({
      questionRequestId: "req-7",
      senderId: OWNER,
      inReplyTo: "Which branch?",
    });
  });

  it("the thread wins over the channel: a reply to another session's post goes to that session", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    const other = await seedSession(box.machineId);
    await seedPost(box, ch.channelId, "1700000002.000100", "from other", { sessionId: other });
    await sendEvent(box, { channel: ch.channelId, text: "hi", thread_ts: "1700000002.000100" });
    expect((await commandsFor(box.machineId))[0]?.session_id).toBe(other);
  });

  it("a thread reply to a digest in a bound named channel goes to the bound session with the digest as context", async () => {
    const box = await mkBox();
    const sessionId = await seedSession(box.machineId);
    const named = await seedNamedChannel(box, "stallwatch:prog");
    await env.DB.prepare("INSERT INTO named_topic_bindings (chat_id, topic_key, session_id, bound_at) VALUES (?, ?, ?, ?)")
      .bind(box.chat, "stallwatch:prog", sessionId, Date.now())
      .run();
    await seedPost(box, named.channelId, "1700000003.000100", "Digest: 3 workers idle");
    await sendEvent(box, { channel: named.channelId, text: "restart them", thread_ts: "1700000003.000100" });
    const rows = await commandsFor(box.machineId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: sessionId, message_thread_id: named.handle });
    expect(JSON.parse(rows[0]!.metadata_json!).inReplyTo).toBe("Digest: 3 workers idle");
  });

  it("an unrecorded parent is fetched with conversations.replies, and used only when it is our app's post", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    slack("conversations.replies", {
      ok: true,
      messages: [{ ts: "1700000004.000100", bot_id: "B1", app_id: box.ws.appId, text: "Old &amp; gone" }],
    });
    await sendEvent(box, { channel: ch.channelId, text: "a", thread_ts: "1700000004.000100" });
    slack("conversations.replies", {
      ok: true,
      messages: [{ ts: "1700000005.000100", bot_id: "B2", app_id: "AOTHERAPP", text: "someone else's bot" }],
    });
    await sendEvent(box, { channel: ch.channelId, text: "b", thread_ts: "1700000005.000100" });
    slack("conversations.replies", { ok: true, messages: [{ ts: "1700000006.000100", user: OWNER, text: "mine" }] });
    await sendEvent(box, { channel: ch.channelId, text: "c", thread_ts: "1700000006.000100" });
    const rows = await commandsFor(box.machineId);
    expect(rows.map((r) => JSON.parse(r.metadata_json!).inReplyTo)).toEqual(["Old & gone", undefined, undefined]);
    expect(slackOf("conversations.replies")[0]!.params.get("ts")).toBe("1700000004.000100");
  });

  it("a failed parent fetch still queues the message, without inReplyTo", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    slack("conversations.replies", { ok: false, error: "channel_not_found" });
    await sendEvent(box, { channel: ch.channelId, text: "still here", thread_ts: "1700000007.000100" });
    const rows = await commandsFor(box.machineId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.metadata_json!)).toEqual({ senderId: OWNER });
  });

  it("a shared (forwarded) message is marked forwarded", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    await sendEvent(box, { channel: ch.channelId, text: "look", attachments: [{ is_share: true, text: "orig" }] });
    expect(JSON.parse((await commandsFor(box.machineId))[0]!.metadata_json!).forwarded).toBe(true);
  });

  it("a message in an unbound named channel gets the rate-limited hint and queues nothing", async () => {
    const box = await mkBox();
    const named = await seedNamedChannel(box, "digest:x");
    slack("chat.postMessage", { ok: true, ts: "1700000008.000100", channel: named.channelId });
    await sendEvent(box, { channel: named.channelId, text: "hello?" });
    await sendEvent(box, { channel: named.channelId, text: "anyone?" }); // inside the hint window: silent
    expect(slackOf("chat.postMessage")).toHaveLength(1);
    expect(slackOf("chat.postMessage")[0]!.params.get("channel")).toBe(named.channelId);
    expect(await commandsFor(box.machineId)).toEqual([]);
  });

  it("a channel pigeon never addressed is ignored silently", async () => {
    const box = await mkBox();
    const res = await sendEvent(box, { channel: "CUNKNOWN1", text: "hi" });
    expect(res.status).toBe(200);
    expect(await commandsFor(box.machineId)).toEqual([]);
  });

  it("an empty message is answered in the channel, once per event", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    slack("chat.postMessage", { ok: true, ts: "1700000009.000100", channel: ch.channelId });
    const body = eventBody(box, { channel: ch.channelId, text: "   " });
    await call(box, await signed(box, "events", body, "application/json"));
    await call(box, await signed(box, "events", body, "application/json"));
    expect(slackOf("chat.postMessage")).toHaveLength(1);
    expect(await commandsFor(box.machineId)).toEqual([]);
  });

  it("a file is downloaded with the bot token into R2 after the ack, then queued with its MediaRef", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    let auth: string | undefined;
    fetchMock
      .get("https://files.slack.com")
      .intercept({ method: "GET", path: "/files-pri/T1-F1/download/notes.txt" })
      .reply(200, (opts: { headers?: Record<string, string> }) => {
        const headers = opts.headers ?? {};
        auth = headers["authorization"] ?? headers["Authorization"];
        return "file bytes";
      }, { headers: { "content-type": "text/plain" } });
    const waits: Waits = [];
    const res = await sendEvent(
      box,
      {
        channel: ch.channelId,
        subtype: "file_share",
        text: "see attached",
        files: [
          {
            id: "F1",
            name: "notes.txt",
            mimetype: "text/plain",
            size: 10,
            url_private_download: "https://files.slack.com/files-pri/T1-F1/download/notes.txt",
          },
        ],
      },
      {},
      waits,
    );
    expect(res.status).toBe(200);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(auth).toBe("Bearer xoxb-bot");
    const rows = await commandsFor(box.machineId);
    expect(rows).toHaveLength(1);
    const media = JSON.parse(rows[0]!.media_json!);
    expect(media).toMatchObject({ mime: "text/plain", filename: "notes.txt", size: 10 });
    expect(rows[0]!.command).toBe("see attached");
    const obj = await env.MEDIA.get(media.key);
    expect(await obj!.text()).toBe("file bytes");
  });

  it("a file whose URL is not files.slack.com is never fetched (the bot token would go with it)", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    slack("chat.postMessage", { ok: true, ts: "1700000010.000100", channel: ch.channelId });
    await sendEvent(box, {
      channel: ch.channelId,
      subtype: "file_share",
      text: "x",
      files: [{ id: "F2", name: "a.txt", mimetype: "text/plain", size: 1, url_private_download: "https://evil.example/a.txt" }],
    });
    expect(slackOf("chat.postMessage")[0]!.params.get("text")).toContain("Could not download a.txt from Slack");
    // The text is not lost with the file.
    const rows = await commandsFor(box.machineId);
    expect(rows.map((r) => [r.command, r.media_json])).toEqual([["x", null]]);
  });

  it("a file over 20MB is refused in the channel", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    slack("chat.postMessage", { ok: true, ts: "1700000011.000100", channel: ch.channelId });
    await sendEvent(box, {
      channel: ch.channelId,
      subtype: "file_share",
      files: [{ id: "F3", name: "big.bin", size: 21 * 1024 * 1024, url_private_download: "https://files.slack.com/x" }],
    });
    expect(slackOf("chat.postMessage")[0]!.params.get("text")).toContain("big.bin: file too large");
    expect(await commandsFor(box.machineId)).toEqual([]);
  });

  it("several files queue one command each, in order, the text riding on the first; a retry fetches nothing", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    for (const n of ["a", "b"]) {
      fetchMock
        .get("https://files.slack.com")
        .intercept({ method: "GET", path: `/f/${n}.png` })
        .reply(200, `bytes-${n}`, { headers: { "content-type": "image/png" } });
    }
    const mk = (n: string) => ({
      id: `F${n}`,
      name: `${n}.png`,
      mimetype: "image/png",
      size: 7,
      original_w: 10,
      original_h: 10,
      url_private_download: `https://files.slack.com/f/${n}.png`,
    });
    const body = eventBody(box, { channel: ch.channelId, subtype: "file_share", text: "what's wrong", files: [mk("a"), mk("b")] });
    const waits: Waits = [];
    await call(box, await signed(box, "events", body, "application/json"), waits);
    await Promise.all(waits);
    // The retry: already seen, so no download is attempted (an unexpected fetch would fail the test).
    const again: Waits = [];
    await call(box, await signed(box, "events", body, "application/json"), again);
    expect(again).toEqual([]);
    const rows = await commandsFor(box.machineId);
    expect(rows.map((r) => [r.command, JSON.parse(r.media_json!).filename])).toEqual([
      ["what's wrong", "a.png"],
      ["", "b.png"],
    ]);
  });

  it("a failed download is reported in the channel", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    fetchMock.get("https://files.slack.com").intercept({ method: "GET", path: "/f/gone" }).reply(404, "no");
    slack("chat.postMessage", { ok: true, ts: "1700000012.000100", channel: ch.channelId });
    await sendEvent(box, {
      channel: ch.channelId,
      subtype: "file_share",
      text: "",
      files: [{ id: "F9", name: "gone.txt", mimetype: "text/plain", size: 3, url_private_download: "https://files.slack.com/f/gone" }],
    });
    expect(slackOf("chat.postMessage")[0]!.params.get("text")).toContain("Could not download gone.txt from Slack");
    expect(await commandsFor(box.machineId)).toEqual([]);
  });

  it("pickSlackFile: a large photo uses the largest thumbnail within 1568px", () => {
    expect(
      pickSlackFile({
        id: "F",
        name: "p.jpg",
        mimetype: "image/jpeg",
        size: 9_000_000,
        original_w: 4000,
        original_h: 3000,
        url_private_download: "https://files.slack.com/orig",
        thumb_720: "https://files.slack.com/t720",
        thumb_1024: "https://files.slack.com/t1024",
        thumb_1024_w: 1024,
      }),
    ).toEqual({ url: "https://files.slack.com/t1024", mime: "image/jpeg", filename: "p.jpg", size: 0, original: false });
    expect(
      pickSlackFile({ id: "F", name: "s.png", mimetype: "image/png", size: 5, original_w: 100, original_h: 80, url_private_download: "https://files.slack.com/o" }),
    ).toMatchObject({ url: "https://files.slack.com/o", original: true });
  });

  it("SLACK_APP_COMMANDS is exactly the manifest's slash commands", () => {
    const manifest = JSON.parse(manifestRaw) as { features: { slash_commands: Array<{ command: string }> } };
    expect([...SLACK_APP_COMMANDS].sort()).toEqual(manifest.features.slash_commands.map((c) => c.command).sort());
  });

  it("slackTextToPlain decodes Slack markup", () => {
    expect(slackTextToPlain("a &lt; b &amp;&amp; c &gt; d")).toBe("a < b && c > d");
    expect(slackTextToPlain("<https://example.com|example.com> and <https://x.io/p>")).toBe("https://example.com and https://x.io/p");
    expect(slackTextToPlain("<https://x.io|the docs>")).toBe("the docs (https://x.io)");
    expect(slackTextToPlain("mail <mailto:a@b.c|a@b.c>, <@U123>, <#C1|general>, <!here>")).toBe("mail a@b.c, @U123, #general, @here");
    expect(slackTextToPlain("&amp;lt;")).toBe("&lt;");
  });

  it("sweepSlackSeenEvents drops rows past 48 h", async () => {
    const now = Date.now();
    await env.DB.prepare("INSERT INTO slack_seen_events (event_id, created_at) VALUES (?, ?), (?, ?)")
      .bind("EvOLD" + stamp(), now - 49 * 3600_000, "EvNEW" + stamp(), now)
      .run();
    expect(await sweepSlackSeenEvents(env.DB, now)).toBeGreaterThanOrEqual(1);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM slack_seen_events WHERE created_at < ?")
      .bind(now - 48 * 3600_000)
      .first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});

// ─── slash commands ────────────────────────────────────────────────────────

describe("slash commands", () => {
  it("/kill in a session's channel queues a kill and answers in the channel", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    const res = await sendCommand(box, "/kill", "", ch.channelId);
    const body = await json(res);
    expect(body.response_type).toBe("in_channel");
    expect(body.text).toContain(`Killing session \`${ch.sessionId}\` on ${box.machineId}`);
    const rows = await commandsFor(box.machineId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ command_type: "kill", session_id: ch.sessionId, chat_id: box.chat, message_thread_id: ch.handle });
  });

  it("/kill <prefix> works in #alerts, which has no session; an ambiguous prefix is refused", async () => {
    const box = await mkBox();
    const alerts = await seedNamedChannel(box, "_alerts");
    const base = `ses_zz${stamp()}`;
    const one = await seedSession(box.machineId, `${base}aaaa`);
    const res = await sendCommand(box, "/kill", base.slice(0, 12), alerts.channelId);
    expect((await json(res)).response_type).toBe("in_channel");
    expect((await commandsFor(box.machineId))[0]).toMatchObject({ command_type: "kill", session_id: one, message_thread_id: alerts.handle });

    await seedSession(box.machineId, `${base}bbbb`);
    const amb = await json(await sendCommand(box, "/kill", base, alerts.channelId));
    expect(amb.response_type).toBe("ephemeral");
    expect(amb.text).toContain("is ambiguous; nothing was done");
    expect(await commandsFor(box.machineId)).toHaveLength(1);
  });

  it("/kill with no session in the channel and no id is refused; malformed args answer with usage", async () => {
    const box = await mkBox();
    const alerts = await seedNamedChannel(box, "_alerts");
    const none = await json(await sendCommand(box, "/kill", "", alerts.channelId));
    expect(none.response_type).toBe("ephemeral");
    expect(none.text).toContain("This channel has no session");
    const usage = await json(await sendCommand(box, "/kill", "now", alerts.channelId));
    expect(usage.text).toContain("Usage (the session id is optional");
    expect(await commandsFor(box.machineId)).toEqual([]);
  });

  it("/kill in a coordinator's bound named channel does not follow the binding: no kill is queued", async () => {
    const box = await mkBox();
    const coord = await seedSession(box.machineId);
    const named = await seedNamedChannel(box, "stallwatch:prog3");
    await env.DB.prepare("INSERT INTO named_topic_bindings (chat_id, topic_key, session_id, bound_at) VALUES (?, ?, ?, ?)")
      .bind(box.chat, "stallwatch:prog3", coord, Date.now())
      .run();
    const body = await json(await sendCommand(box, "/kill", "", named.channelId));
    expect(body.response_type).toBe("ephemeral");
    expect(body.text).toContain("This channel has no session");
    expect(await commandsFor(box.machineId)).toEqual([]);
  });

  it("a command typed in a channel with no handle mints one, so the daemon's reply lands there", async () => {
    const box = await mkBox();
    const sessionId = await seedSession(box.machineId);
    await sendCommand(box, "/model", sessionId, "CFRESH01");
    const row = (await commandsFor(box.machineId))[0]!;
    expect(row.command_type).toBe("model_list");
    const conv = await env.DB.prepare("SELECT handle FROM slack_conversations WHERE team_id = ? AND channel_id = ?")
      .bind(box.ws.teamId, "CFRESH01")
      .first<{ handle: number }>();
    expect(row.message_thread_id).toBe(conv!.handle);
  });

  it("/mcp and /model parse their arguments like Telegram", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    await sendCommand(box, "/mcp", "enable slack", ch.channelId);
    await sendCommand(box, "/model", "anthropic/claude", ch.channelId);
    expect((await commandsFor(box.machineId)).map((r) => [r.command_type, r.command])).toEqual([
      ["mcp_enable", "slack"],
      ["model_set", "anthropic/claude"],
    ]);
  });

  it("/launch queues a launch with the channel's session as tag inheritance", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    const body = await json(await sendCommand(box, "/launch", `${box.machineId} pigeon say hello`, ch.channelId));
    expect(body.response_type).toBe("in_channel");
    expect(body.text).toContain(`Launching on ${box.machineId} in pigeon`);
    const row = (await commandsFor(box.machineId))[0]!;
    expect(row).toMatchObject({ command_type: "launch", command: "say hello", chat_id: box.chat, message_thread_id: ch.handle });
    expect(JSON.parse(row.metadata_json!)).toEqual({ inheritFromSessionId: ch.sessionId });
  });

  it("slash-command text is taken as typed: Slack does not escape it (should_escape false), so <, > and & survive", async () => {
    // Live check pigeon-4ogz.8: `/launch ... a<b && "q" > c` arrived raw, and decoding it as
    // message markup ate `<b && "q" >` as if it were a link.
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    await sendCommand(box, "/launch", `${box.machineId} pigeon echo a<b && "q" > c &lt;kept&gt;`, ch.channelId);
    expect((await commandsFor(box.machineId))[0]).toMatchObject({ command: 'echo a<b && "q" > c &lt;kept&gt;' });
  });

  it("/launch in a coordinator's bound channel inherits from the coordinator", async () => {
    const box = await mkBox();
    const coord = await seedSession(box.machineId);
    const named = await seedNamedChannel(box, "stallwatch:prog2");
    await env.DB.prepare("INSERT INTO named_topic_bindings (chat_id, topic_key, session_id, bound_at) VALUES (?, ?, ?, ?)")
      .bind(box.chat, "stallwatch:prog2", coord, Date.now())
      .run();
    await sendCommand(box, "/launch", `${box.machineId} pigeon go`, named.channelId);
    const row = (await commandsFor(box.machineId))[0]!;
    expect(JSON.parse(row.metadata_json!)).toEqual({ inheritFromSessionId: coord });
  });

  it("a command from a DM gets no handle (its reply goes to #alerts); ssl_check is a plain 200", async () => {
    const box = await mkBox();
    const sessionId = await seedSession(box.machineId);
    await sendCommand(box, "/kill", sessionId, "D0SELFDM");
    expect((await commandsFor(box.machineId))[0]!.message_thread_id).toBeNull();
    const ssl = new URLSearchParams({ ssl_check: "1", token: "legacy" }).toString();
    const res = await call(box, await signed(box, "commands", ssl, "application/x-www-form-urlencoded"));
    expect(res.status).toBe(200);
  });

  it("/launch to a machine not recently seen is refused; a malformed one answers with usage", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    const off = await json(await sendCommand(box, "/launch", "nosuchbox pigeon hi", ch.channelId));
    expect(off.text).toContain("nosuchbox is not recently seen");
    const usage = await json(await sendCommand(box, "/launch", "", ch.channelId));
    expect(usage.response_type).toBe("ephemeral");
    expect(await commandsFor(box.machineId)).toEqual([]);
  });

  it("/retitle renames the channel and topic, keeping the directory", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    slack("conversations.info", { ok: true, channel: { id: ch.channelId, name: "old", topic: { value: "old" } } });
    slack("conversations.rename", { ok: true, channel: { id: ch.channelId, name: "new" } });
    slack("conversations.setTopic", { ok: true });
    const body = await json(await sendCommand(box, "/retitle", "Better name", ch.channelId));
    expect(body.response_type).toBe("in_channel");
    expect(body.text).toContain('to "Better name · ~/proj"');
    expect(slackOf("conversations.rename")[0]!.params.get("name")).toMatch(/^better-name-/);
    const label = await env.DB.prepare("SELECT label FROM sessions WHERE session_id = ?").bind(ch.sessionId).first<{ label: string }>();
    expect(label!.label).toBe("Better name · ~/proj");
    const usage = await json(await sendCommand(box, "/retitle", "", ch.channelId));
    // Escaped for Slack mrkdwn: a bare <...> would be read as a link.
    expect(usage.text).toContain("Usage: /retitle &lt;new title&gt;");
  });

  it("/tag <session-id> <tag> works in #alerts; other /tag forms there are refused", async () => {
    const box = await mkBox();
    const alerts = await seedNamedChannel(box, "_alerts");
    const sessionId = await seedSession(box.machineId);
    const ok = await json(await sendCommand(box, "/tag", `${sessionId} my-program`, alerts.channelId));
    expect(ok.response_type).toBe("in_channel");
    const row = (await commandsFor(box.machineId))[0]!;
    expect(row).toMatchObject({ command_type: "tag_set", command: "my-program", session_id: sessionId });
    expect(JSON.parse(row.metadata_json!)).toEqual({ targetSessionId: sessionId });
    const top = await json(await sendCommand(box, "/tag", "", alerts.channelId));
    expect(top.response_type).toBe("ephemeral");
    expect(await commandsFor(box.machineId)).toHaveLength(1);
  });

  it("/tag in a session's channel lists that machine's backlog", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    await sendCommand(box, "/tag", "list", ch.channelId);
    expect((await commandsFor(box.machineId))[0]).toMatchObject({ command_type: "tag_list", session_id: ch.sessionId });
  });

  it("a command from anyone but the owner is dropped silently", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    const res = await sendCommand(box, "/kill", "", ch.channelId, "UOTHER");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(await commandsFor(box.machineId)).toEqual([]);
  });

  it("a machine not recently seen refuses a session command", async () => {
    const box = await mkBox({ online: false });
    const ch = await seedSessionChannel(box);
    const body = await json(await sendCommand(box, "/kill", "", ch.channelId));
    expect(body.text).toContain(`${box.machineId} is not recently seen`);
    expect(await commandsFor(box.machineId)).toEqual([]);
  });
});

// ─── interactivity ─────────────────────────────────────────────────────────

describe("interactivity", () => {
  it("a button's value is read as callback_data: token -> session, with the question id", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    await seedPost(box, ch.channelId, "1700000020.000100", "Pick one", {
      sessionId: ch.sessionId,
      notificationId: `q:${ch.sessionId}:req-9`,
      token: "TOKQ1",
    });
    const res = await sendAction(box, ch.channelId, { value: "cmd:TOKQ1:v2:q0" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    const rows = await commandsFor(box.machineId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: ch.sessionId, command_type: "execute", command: "v2:q0", chat_id: box.chat });
    expect(JSON.parse(rows[0]!.metadata_json!)).toEqual({ questionRequestId: "req-9" });
  });

  it("a URL button and a non-owner press are acked and ignored", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    await seedPost(box, ch.channelId, "1700000021.000100", "x", { sessionId: ch.sessionId, token: "TOKQ2" });
    expect((await sendAction(box, ch.channelId, { url: "https://acme.slack.com/archives/C1" })).status).toBe(200);
    expect((await sendAction(box, ch.channelId, { value: "cmd:TOKQ2:q0" }, "UOTHER")).status).toBe(200);
    expect(await commandsFor(box.machineId)).toEqual([]);
  });

  it("an unknown token says so ephemerally", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    slack("chat.postEphemeral", { ok: true });
    await sendAction(box, ch.channelId, { value: "cmd:NOPE:q0" });
    expect(slackOf("chat.postEphemeral")[0]!.params.get("text")).toBe("Session expired");
    expect(slackOf("chat.postEphemeral")[0]!.params.get("user")).toBe(OWNER);
    expect(await commandsFor(box.machineId)).toEqual([]);
  });
});

// ─── behaviour the Telegram webhook suite used to cover (pigeon-4ogz.13) ───
//
// The Telegram ingress was deleted. What its tests checked that is not Telegram's own shape (the
// route-level queueing, metadata, refusals) is kept here against the Slack ingress, which shares
// `parseChatCommand`, `resolveSessionRef` and the command queue with it.

describe("events: refusals and bound channels", () => {
  it("a plain (non-thread) message in a bound named channel goes to the bound session, with the sender", async () => {
    const box = await mkBox();
    const sessionId = await seedSession(box.machineId);
    const named = await seedNamedChannel(box, "stallwatch:plain");
    await env.DB.prepare("INSERT INTO named_topic_bindings (chat_id, topic_key, session_id, bound_at) VALUES (?, ?, ?, ?)")
      .bind(box.chat, "stallwatch:plain", sessionId, Date.now())
      .run();
    await sendEvent(box, { channel: named.channelId, text: "status?" });
    const rows = await commandsFor(box.machineId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: sessionId, command: "status?", command_type: "execute", message_thread_id: named.handle });
    expect(JSON.parse(rows[0]!.metadata_json!)).toEqual({ senderId: OWNER });
  });

  it("a bound channel whose session row is gone is inert: the digest hint, not 'Session not found'", async () => {
    const box = await mkBox();
    const sessionId = await seedSession(box.machineId);
    const named = await seedNamedChannel(box, "stallwatch:gone");
    await env.DB.prepare("INSERT INTO named_topic_bindings (chat_id, topic_key, session_id, bound_at) VALUES (?, ?, ?, ?)")
      .bind(box.chat, "stallwatch:gone", sessionId, Date.now())
      .run();
    await env.DB.prepare("DELETE FROM sessions WHERE session_id = ?").bind(sessionId).run();
    slack("chat.postMessage", { ok: true, ts: "1700000030.000100", channel: named.channelId });
    await sendEvent(box, { channel: named.channelId, text: "anyone?" });
    expect(slackOf("chat.postMessage")).toHaveLength(1);
    expect(slackOf("chat.postMessage")[0]!.params.get("text")).not.toContain("Session not found");
    expect(await commandsFor(box.machineId)).toEqual([]);
  });

  it("a session's channel whose session row is gone answers 'Session not found' and queues nothing", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    await env.DB.prepare("DELETE FROM sessions WHERE session_id = ?").bind(ch.sessionId).run();
    slack("chat.postMessage", { ok: true, ts: "1700000031.000100", channel: ch.channelId });
    await sendEvent(box, { channel: ch.channelId, text: "hello" });
    expect(slackOf("chat.postMessage")[0]!.params.get("text")).toBe("Session not found");
    expect(await commandsFor(box.machineId)).toEqual([]);
  });

  it("a command over the length limit is refused in the channel and queues nothing", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    slack("chat.postMessage", { ok: true, ts: "1700000032.000100", channel: ch.channelId });
    await sendEvent(box, { channel: ch.channelId, text: "x".repeat(MAX_COMMAND_LENGTH + 1) });
    expect(slackOf("chat.postMessage")[0]!.params.get("text")).toContain("Command too long");
    expect(await commandsFor(box.machineId)).toEqual([]);
  });
});

describe("slash commands: queueing and refusals", () => {
  it("/interrupt and /compact queue for the channel's session", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    const a = await json(await sendCommand(box, "/interrupt", "", ch.channelId));
    const b = await json(await sendCommand(box, "/compact", "", ch.channelId));
    expect(a.response_type).toBe("in_channel");
    expect(b.response_type).toBe("in_channel");
    expect((await commandsFor(box.machineId)).map((r) => [r.command_type, r.session_id, r.message_thread_id])).toEqual([
      ["interrupt", ch.sessionId, ch.handle],
      ["compact", ch.sessionId, ch.handle],
    ]);
  });

  it("a session command in a channel whose session row is gone says so and queues nothing", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    await env.DB.prepare("DELETE FROM sessions WHERE session_id = ?").bind(ch.sessionId).run();
    const body = await json(await sendCommand(box, "/compact", "", ch.channelId));
    expect(body.response_type).toBe("ephemeral");
    expect(body.text).toContain(`Session \`${ch.sessionId}\` not found.`);
    expect(await commandsFor(box.machineId)).toEqual([]);
  });

  it("an unknown session id is refused, and an explicit id wins over the channel's session", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    const none = await json(await sendCommand(box, "/kill", "ses_nosuchsession00", ch.channelId));
    expect(none.response_type).toBe("ephemeral");
    expect(none.text).toMatch(/No session matches/);
    expect(await commandsFor(box.machineId)).toEqual([]);

    const target = await seedSession(box.machineId);
    await sendCommand(box, "/mcp", `${target} enable slack`, ch.channelId);
    await sendCommand(box, "/model", `${target} anthropic/opus`, ch.channelId);
    expect((await commandsFor(box.machineId)).map((r) => [r.command_type, r.command, r.session_id])).toEqual([
      ["mcp_enable", "slack", target],
      ["model_set", "anthropic/opus", target],
    ]);
  });

  it("a named target on a machine not recently seen is refused", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    const stale = await mkBox({ online: false });
    const target = await seedSession(stale.machineId);
    const body = await json(await sendCommand(box, "/compact", target, ch.channelId));
    expect(body.text).toBe(`${stale.machineId} is not recently seen.`);
    expect(await commandsFor(stale.machineId)).toEqual([]);
  });

  it("/mcp list, /mcp disable and /model (list) map to their command types", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    await sendCommand(box, "/mcp", "list", ch.channelId);
    await sendCommand(box, "/mcp", "disable slack", ch.channelId);
    await sendCommand(box, "/model", "", ch.channelId);
    expect((await commandsFor(box.machineId)).map((r) => [r.command_type, r.command])).toEqual([
      ["mcp_list", ""],
      ["mcp_disable", "slack"],
      ["model_list", ""],
    ]);
  });

  it("/launch --tag keeps the prompt in command and the tag in metadata; no flag and no inheritance queues no metadata", async () => {
    const box = await mkBox();
    const alerts = await seedNamedChannel(box, "_alerts");
    const tagged = await json(await sendCommand(box, "/launch", `${box.machineId} pigeon --tag my-prog fix the bug`, alerts.channelId));
    expect(tagged.text).toContain(", tag my-prog");
    await sendCommand(box, "/launch", `${box.machineId} pigeon plain prompt`, alerts.channelId);
    const rows = await commandsFor(box.machineId);
    expect(rows[0]).toMatchObject({ command_type: "launch", command: "fix the bug", directory: "pigeon" });
    expect(JSON.parse(rows[0]!.metadata_json!)).toEqual({ tag: "my-prog" });
    expect(rows[1]).toMatchObject({ command: "plain prompt" });
    expect(rows[1]!.metadata_json).toBeNull();
  });

  it("/launch with an invalid tag answers usage and queues nothing", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    const body = await json(await sendCommand(box, "/launch", `${box.machineId} pigeon --tag auto:x go`, ch.channelId));
    expect(body.response_type).toBe("ephemeral");
    expect(await commandsFor(box.machineId)).toEqual([]);
  });

  it("/launch --backend goose carries the backend, with --tag or with inheritance, but never inherits over --tag", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    await sendCommand(box, "/launch", `${box.machineId} pigeon --backend goose --tag prog go`, ch.channelId);
    await sendCommand(box, "/launch", `${box.machineId} pigeon --backend goose go`, ch.channelId);
    const rows = await commandsFor(box.machineId);
    expect(JSON.parse(rows[0]!.metadata_json!)).toEqual({ tag: "prog", backend: "goose" });
    expect(JSON.parse(rows[1]!.metadata_json!)).toEqual({ backend: "goose", inheritFromSessionId: ch.sessionId });
  });

  it("/launch does not inherit from a channel whose session is on another machine", async () => {
    const box = await mkBox();
    const other = await mkBox();
    const ch = await seedSessionChannel(other);
    // Same workspace team as `other`, so the channel is known; the target machine is `box`.
    box.ws.teamId = other.ws.teamId;
    await env.DB.prepare("INSERT OR REPLACE INTO machines (machine_id, last_poll_at) VALUES (?, ?)").bind(box.machineId, Date.now()).run();
    const boxEnv = { ...box.env, [slackSecretKeyForMachine(box.machineId)]: JSON.stringify(box.ws) } as unknown as Env;
    const res = await call({ ...box, env: boxEnv }, await signed({ ...box, env: boxEnv }, "commands", new URLSearchParams({
      team_id: box.ws.teamId, api_app_id: box.ws.appId, user_id: OWNER, channel_id: ch.channelId,
      command: "/launch", text: `${box.machineId} pigeon go`, response_url: "https://example.invalid/r",
    }).toString(), "application/x-www-form-urlencoded"));
    expect(res.status).toBe(200);
    const row = (await commandsFor(box.machineId))[0]!;
    expect(row.command_type).toBe("launch");
    expect(row.metadata_json).toBeNull();
  });

  it("/tag: a malformed form answers usage, an auto: tag is refused, and nothing is queued", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    const usage = await json(await sendCommand(box, "/tag", "a b c", ch.channelId));
    expect(usage.response_type).toBe("ephemeral");
    const auto = await json(await sendCommand(box, "/tag", "auto:x", ch.channelId));
    expect(auto.response_type).toBe("ephemeral");
    const dir = await json(await sendCommand(box, "/tag", "dir", ch.channelId));
    expect(dir.response_type).toBe("ephemeral");
    expect(await commandsFor(box.machineId)).toEqual([]);
  });

  it("/tag <tag> and /tag <other-session> <tag>: the channel's session routes, the target is tagged", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    const other = await seedSession(box.machineId);
    await sendCommand(box, "/tag", "mine", ch.channelId);
    await sendCommand(box, "/tag", `${other} theirs`, ch.channelId);
    const rows = await commandsFor(box.machineId);
    expect(rows.map((r) => [r.command_type, r.command, r.session_id, JSON.parse(r.metadata_json!).targetSessionId])).toEqual([
      ["tag_set", "mine", ch.sessionId, ch.sessionId],
      ["tag_set", "theirs", ch.sessionId, other],
    ]);
  });

  it("/retitle: when the channel edit fails nothing is written and the refusal names the session", async () => {
    const box = await mkBox();
    const ch = await seedSessionChannel(box);
    slack("conversations.info", { ok: false, error: "channel_not_found" });
    const body = await json(await sendCommand(box, "/retitle", "Never applied", ch.channelId));
    expect(body.response_type).toBe("ephemeral");
    expect(body.text).toContain(`Failed to rename the channel of session \`${ch.sessionId}\``);
    const label = await env.DB.prepare("SELECT label FROM sessions WHERE session_id = ?").bind(ch.sessionId).first<{ label: string }>();
    expect(label!.label).toBe("inbound");
  });
});
