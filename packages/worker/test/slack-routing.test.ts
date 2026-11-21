/**
 * Slack address routing and authorization (bead pigeon-4ogz.3, task 3), and what a numeric
 * (Telegram-era) address now gets (pigeon-4ogz.13). Plan: docs/plans/2026-11-20-slack-outbound-plan.md
 * ("Address resolution and authorization", "/notifications/send changes", "Named topics") and its
 * review deltas; docs/plans/2026-11-21-delete-telegram-plan.md decision 3.
 *
 * Handlers are called directly with `{...env, SLACK_WORKSPACE_<MACHINE>: <json>}` and per-machine
 * credentials inserted into `machine_credentials`, so the principal is real. Slack is a fetchMock,
 * with `disableNetConnect` and `assertNoPendingInterceptors`, so a missing OR an unexpected
 * provider call fails the test. Every test uses its own machine, team and session ids: the D1
 * tables are shared by the whole file.
 */
import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import { sha256Hex } from "../src/credentials";
import { SLACK_HANDLE_MIN, slackChatId, slackSecretKeyForMachine, type SlackWorkspace } from "../src/chat/slack-config";
import { handleEditNotification, handleSendNotification } from "../src/notifications";
import { handleSendMessage } from "../src/messages";
import { handleNamedTopic, handleNamedTopicBind } from "../src/named-topics";
import { resolveTopic } from "../src/topic-manager";
import { finalize, getBySession, reserve } from "../src/topics";
import { fakeTransport } from "./slack-harness";
import { authorizeStoredAddress, resolveWorkerTarget } from "../src/chat/address";
import type { Principal } from "../src/credentials";

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

const ALLOWED = "8248645256"; // a numeric chat id of the Telegram days, as an old daemon still sends it
const SHARED = "test-api-key";

let counter = 0;
const stamp = () => `${Date.now().toString(36)}${(++counter).toString(36)}`;

interface Machine {
  machineId: string;
  key: string;
  ws: SlackWorkspace | null;
}

/** A machine with a real credential; `slack` gives it (and its team) a workspace secret. */
async function mkMachine(opts: { slack?: boolean; teamId?: string } = {}): Promise<Machine> {
  const machineId = `sr${stamp()}`.toLowerCase().slice(0, 30);
  const key = ("pgk_" + machineId + "x".repeat(43)).slice(0, 47);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO machine_credentials (key_sha256, machine_id, created_at, revoked_at, note)
     VALUES (?, ?, ?, NULL, 'test')`,
  )
    .bind(await sha256Hex(key), machineId, Date.now())
    .run();
  const ws: SlackWorkspace | null = opts.slack
    ? {
        teamId: opts.teamId ?? `T${stamp()}`.toUpperCase(),
        appId: "A0APP",
        domain: "acme",
        botToken: "xoxb-bot",
        userToken: "xoxp-user",
        signingSecret: "sig",
        ownerUserId: "U0OWNER",
      }
    : null;
  return { machineId, key, ws };
}

function envFor(machines: Machine[], extra: Record<string, unknown> = {}): Env {
  const secrets: Record<string, string> = {};
  for (const m of machines) if (m.ws) secrets[slackSecretKeyForMachine(m.machineId)] = JSON.stringify(m.ws);
  return { ...env, ...secrets, ...extra } as unknown as Env;
}

function request(path: string, key: string, body: unknown): Request {
  return new Request(`https://worker${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

async function seedSession(machineId: string, label = "routing"): Promise<string> {
  const sessionId = `ses_${String(++counter).padStart(4, "0")}zq${Date.now().toString(36)}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(sessionId, machineId, label, now, now)
    .run();
  return sessionId;
}

const sid8 = (sessionId: string) => sessionId.replace(/^ses_/, "").toLowerCase().slice(0, 8);

interface SlackCall {
  method: string;
  params: URLSearchParams;
}
const slackCalls: SlackCall[] = [];

type Reply = Record<string, unknown> | ((params: URLSearchParams) => Record<string, unknown>);

/** One expected Slack Web API call, answered with `reply`. */
function slack(method: string, reply: Reply, status = 200, headers?: Record<string, string>) {
  fetchMock
    .get("https://slack.com")
    .intercept({ method: "POST", path: `/api/${method}` })
    .reply(
      status,
      (opts: { body?: unknown }) => {
        const params = new URLSearchParams(String(opts.body));
        slackCalls.push({ method, params });
        return typeof reply === "function" ? reply(params) : reply;
      },
      headers ? { headers } : undefined,
    );
}

const slackOf = (method: string) => slackCalls.filter((c) => c.method === method);
const slackJson = (c: SlackCall | undefined, key: string) => JSON.parse(c?.params.get(key) ?? "null");

/** A conversation this team already has, returning its handle. */
async function seedChannel(teamId: string, channelId: string): Promise<number> {
  await env.DB.prepare("INSERT INTO slack_conversations (team_id, channel_id, created_at, owner_invited) VALUES (?, ?, ?, 1)")
    .bind(teamId, channelId, Date.now())
    .run();
  const row = await env.DB.prepare("SELECT handle FROM slack_conversations WHERE team_id = ? AND channel_id = ?")
    .bind(teamId, channelId)
    .first<{ handle: number }>();
  return row!.handle;
}

/** The workspace's `#alerts`, already known, so an unthreaded post is one chat.postMessage. */
async function seedAlerts(ws: SlackWorkspace): Promise<string> {
  const channelId = `CALERTS${stamp()}`.toUpperCase();
  const handle = await seedChannel(ws.teamId, channelId);
  await env.DB.prepare(
    `INSERT INTO named_topics (chat_id, topic_key, message_thread_id, name, reopen_checked_at, hint_at, created_at, updated_at)
     VALUES (?, '_alerts', ?, 'alerts', NULL, NULL, 0, 0)`,
  )
    .bind(slackChatId(ws), handle)
    .run();
  return channelId;
}

/** A session whose topic row already lives in Slack. */
async function seedSlackTopic(sessionId: string, machineId: string, ws: SlackWorkspace) {
  const channelId = `CSESS${stamp()}`.toUpperCase();
  const handle = await seedChannel(ws.teamId, channelId);
  await reserve(env.DB, { sessionId, machineId, chatId: slackChatId(ws), name: "s" });
  await finalize(env.DB, {
    sessionId,
    chatId: slackChatId(ws),
    messageThreadId: handle,
    name: "s",
    provisional: false,
  });
  return { channelId, handle };
}

/** A topic row of the Telegram days: a numeric chat id. `thread: null` is an unfinalized reservation. */
async function seedNumericTopic(sessionId: string, machineId: string, chatId: string, thread: number | null) {
  await reserve(env.DB, { sessionId, machineId, chatId, name: "tg" });
  if (thread !== null) await finalize(env.DB, { sessionId, chatId, messageThreadId: thread, name: "tg", provisional: false });
}

async function messageRow(chatId: string, messageId: number) {
  return env.DB.prepare("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?")
    .bind(chatId, messageId)
    .first<{ chat_id: string; message_id: number; notification_id: string | null }>();
}

const posted = (channel = "C1", ts = "1700000000.000100") => ({ ok: true, ts, channel });

/** The calls a brand-new Slack session conversation costs: create, invite, set topic. */
function slackCreate(channelId: string, name = "chan") {
  slack("conversations.create", { ok: true, channel: { id: channelId, name } });
  slack("conversations.invite", { ok: true });
  slack("conversations.setTopic", { ok: true });
}

function sendBody(sessionId: string, extra: Record<string, unknown> = {}) {
  return { sessionId, text: "hello", dir: "/home/dev/proj", title: "My title", notificationId: `s:${sessionId}:1`, ...extra };
}

// ─── /notifications/send: where it goes ────────────────────────────────────

describe("/notifications/send routing", () => {
  it("a Slack machine's first notification creates a channel, posts, and records under slack:<team>", async () => {
    const m = await mkMachine({ slack: true });
    const sessionId = await seedSession(m.machineId);
    slackCreate("CNEW1", "my-title");
    slack("chat.postMessage", posted("CNEW1"));

    // A stale numeric chat id (not even allowlisted) is simply ignored for a Slack machine.
    const res = await handleSendNotification(
      env.DB,
      envFor([m]),
      request("/notifications/send", m.key, sendBody(sessionId, { chatId: "999999" })),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; messageId: number; token: string };
    expect(body.ok).toBe(true);
    expect(body.messageId).toBeGreaterThanOrEqual(SLACK_HANDLE_MIN);

    const chat = slackChatId(m.ws!);
    const topic = await getBySession(env.DB, sessionId);
    expect(topic?.chat_id).toBe(chat);
    expect(topic?.message_thread_id).toBeGreaterThanOrEqual(SLACK_HANDLE_MIN);
    expect((await messageRow(chat, body.messageId))?.chat_id).toBe(chat);
    expect(slackOf("conversations.create")[0]?.params.get("name")).toBe(`my-title-${sid8(sessionId)}`);
    expect(slackOf("chat.postMessage")[0]?.params.get("channel")).toBe("CNEW1");
  });

  it("a Slack machine needs no chatId at all", async () => {
    const m = await mkMachine({ slack: true });
    const sessionId = await seedSession(m.machineId);
    const { channelId } = await seedSlackTopic(sessionId, m.machineId, m.ws!);
    slack("chat.postMessage", posted(channelId));
    const res = await handleSendNotification(env.DB, envFor([m]), request("/notifications/send", m.key, sendBody(sessionId)));
    expect(res.status).toBe(200);
  });

  it("the daemon's stale numeric chatId is ignored: the post still goes to the session's Slack channel", async () => {
    const m = await mkMachine({ slack: true });
    const sessionId = await seedSession(m.machineId);
    const { channelId, handle } = await seedSlackTopic(sessionId, m.machineId, m.ws!);
    slack("chat.postMessage", posted(channelId));

    const res = await handleSendNotification(
      env.DB,
      envFor([m]),
      request("/notifications/send", m.key, sendBody(sessionId, { chatId: ALLOWED })),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messageId: number };
    expect((await messageRow(slackChatId(m.ws!), body.messageId))?.chat_id).toBe(slackChatId(m.ws!));
    expect((await getBySession(env.DB, sessionId))?.message_thread_id).toBe(handle);
  });

  it("a machine with no workspace gets 503 no_transport, with no retryAfter and no provider call", async () => {
    const m = await mkMachine();
    const sessionId = await seedSession(m.machineId);
    const res = await handleSendNotification(
      env.DB,
      envFor([m]),
      request("/notifications/send", m.key, sendBody(sessionId, { chatId: ALLOWED })),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "no_transport" });
    // ...and with no chatId at all (a machine needs none), the same answer, not a 400.
    const bare = await handleSendNotification(env.DB, envFor([m]), request("/notifications/send", m.key, sendBody(sessionId)));
    expect(bare.status).toBe(503);
    expect(await bare.json()).toEqual({ error: "no_transport" });
    expect(slackCalls).toHaveLength(0);
  });

  it("the shared key can post nowhere: 403 chat_not_allowed, 400 when it names no chat", async () => {
    const m = await mkMachine({ slack: true });
    const sessionId = await seedSession(m.machineId);
    const e = envFor([m]);
    const numeric = await handleSendNotification(env.DB, e, request("/notifications/send", SHARED, sendBody(sessionId, { chatId: ALLOWED })));
    expect(numeric.status).toBe(403);
    expect(await numeric.json()).toEqual({ error: "Chat ID not allowed" });
    const slackAddr = await handleSendNotification(
      env.DB,
      e,
      request("/notifications/send", SHARED, sendBody(sessionId, { chatId: slackChatId(m.ws!) })),
    );
    expect(slackAddr.status).toBe(403);
    expect((await handleSendNotification(env.DB, e, request("/notifications/send", SHARED, sendBody(sessionId)))).status).toBe(400);
    expect(slackCalls).toHaveLength(0);
  });

  it("notifyOwner reaches a Slack post as a mention only for an enabled category", async () => {
    const m = await mkMachine({ slack: true });
    const sessionId = await seedSession(m.machineId);
    const { channelId } = await seedSlackTopic(sessionId, m.machineId, m.ws!);
    const send = async (extraEnv: Record<string, unknown>, extra: Record<string, unknown>) => {
      slack("chat.postMessage", posted(channelId, `1.${stamp()}`));
      const res = await handleSendNotification(
        env.DB,
        envFor([m], extraEnv),
        request("/notifications/send", m.key, sendBody(sessionId, { notificationId: `s:${sessionId}:${stamp()}`, ...extra })),
      );
      expect(res.status).toBe(200);
      const calls = slackOf("chat.postMessage");
      return calls[calls.length - 1]?.params.get("text") ?? "";
    };

    // Default: off, even when the daemon flags the post.
    expect(await send({}, { notifyOwner: true })).not.toContain("<@U0OWNER>");
    expect(await send({ SLACK_NOTIFY_OWNER: "" }, { notifyOwner: true })).not.toContain("<@U0OWNER>");
    // An error-severity flag needs `errors`; `questions` alone does not cover it.
    expect(await send({ SLACK_NOTIFY_OWNER: "questions" }, { notifyOwner: true })).not.toContain("<@U0OWNER>");
    expect(await send({ SLACK_NOTIFY_OWNER: " Errors " }, { notifyOwner: true })).toContain("<@U0OWNER>");
    // A flagged `q:` notification is a question.
    const q = { notifyOwner: true, notificationId: `q:${sessionId}:req1` };
    expect(await send({ SLACK_NOTIFY_OWNER: "errors" }, q)).not.toContain("<@U0OWNER>");
    expect(await send({ SLACK_NOTIFY_OWNER: "QUESTIONS" }, { ...q, notificationId: `q:${sessionId}:req2` })).toContain("<@U0OWNER>");
    // No flag: a session channel never mentions.
    expect(await send({ SLACK_NOTIFY_OWNER: "questions,errors,named,alerts" }, {})).not.toContain("<@U0OWNER>");
  });
});

// ─── numeric (Telegram-era) topic rows ─────────────────────────────────────

describe("a session's topic row in a numeric chat is treated as absent", () => {
  it("/notifications/send: the row is deleted without a close call, and the channel is created (no age guard)", async () => {
    const m = await mkMachine({ slack: true });
    const sessionId = await seedSession(m.machineId);
    await seedNumericTopic(sessionId, m.machineId, ALLOWED, 77); // created just now
    slackCreate("CNUM1");
    slack("chat.postMessage", posted("CNUM1"));

    const res = await handleSendNotification(env.DB, envFor([m]), request("/notifications/send", m.key, sendBody(sessionId)));
    expect(res.status).toBe(200);
    expect(slackCalls.map((c) => c.method)).toEqual([
      "conversations.create",
      "conversations.invite",
      "conversations.setTopic",
      "chat.postMessage",
    ]);
    const row = await getBySession(env.DB, sessionId);
    expect(row?.chat_id).toBe(slackChatId(m.ws!));
    expect(row?.message_thread_id).toBeGreaterThanOrEqual(SLACK_HANDLE_MIN);
  });

  it("an unfinalized numeric reservation too: purged, one create, no close or delete", async () => {
    const sessionId = await seedSession("devbox");
    await seedNumericTopic(sessionId, "devbox", ALLOWED, null);
    const { client, calls } = fakeTransport();
    const res = await resolveTopic(env.DB, {
      sessionId,
      machineId: "devbox",
      chatId: "slack:TNUMRES",
      dir: "~/p",
      title: "T",
      transport: client,
    });
    expect(res).toEqual({ ok: true, messageThreadId: 1 });
    expect(calls.createForumTopic).toHaveLength(1);
    expect(calls.closeForumTopic).toHaveLength(0);
    expect(calls.deleteForumTopic).toHaveLength(0);
    expect((await getBySession(env.DB, sessionId))?.chat_id).toBe("slack:TNUMRES");
  });

  /** A D1 that lets the numeric row land right after the first row lookup. */
  function racingDb(onFirstLookup: () => Promise<void>): D1Database {
    let lookups = 0;
    return new Proxy(env.DB, {
      get(target, prop) {
        if (prop !== "prepare") {
          const v = Reflect.get(target, prop, target);
          return typeof v === "function" ? v.bind(target) : v;
        }
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (sql !== "SELECT * FROM topics WHERE session_id = ?") return stmt;
          return {
            bind: (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return {
                first: async () => {
                  const row = await bound.first();
                  if (++lookups === 1) await onFirstLookup();
                  return row;
                },
              };
            },
          };
        };
      },
    }) as unknown as D1Database;
  }

  it("loser path: the reserve is lost to a numeric row, which is purged and reserved again", async () => {
    const sessionId = await seedSession("devbox");
    const { client, calls } = fakeTransport({
      createForumTopic: (o) => ({ ok: true, result: { message_thread_id: 4242, name: o.name, icon_color: 0 } }),
    });
    const res = await resolveTopic(
      racingDb(() => seedNumericTopic(sessionId, "devbox", ALLOWED, 5)),
      { sessionId, machineId: "devbox", chatId: "slack:TNUMLOSE", dir: "~/p", title: "T", transport: client },
    );
    expect(res).toEqual({ ok: true, messageThreadId: 4242 });
    expect(calls.createForumTopic).toHaveLength(1);
    expect(calls.closeForumTopic).toHaveLength(0);
    const row = await getBySession(env.DB, sessionId);
    expect(row?.chat_id).toBe("slack:TNUMLOSE");
    expect(row?.message_thread_id).toBe(4242);
  });

  it("poll path: a numeric row that shows up while polling is purged the same way", async () => {
    const sessionId = await seedSession("devbox");
    // A rival's unfinalized reservation in OUR chat: step 1 and the loser path wait on it.
    await reserve(env.DB, { sessionId, machineId: "devbox", chatId: "slack:TNUMPOLL", name: "rival" });
    let polls = 0;
    const { client, calls } = fakeTransport({
      createForumTopic: (o) => ({ ok: true, result: { message_thread_id: 4243, name: o.name, icon_color: 0 } }),
    });
    const res = await resolveTopic(env.DB, {
      sessionId,
      machineId: "devbox",
      chatId: "slack:TNUMPOLL",
      dir: "~/p",
      title: "T",
      transport: client,
      delayFn: async () => {
        if (++polls !== 1) return;
        // The rival gave up and a numeric row took its place.
        await env.DB.prepare("DELETE FROM topics WHERE session_id = ?").bind(sessionId).run();
        await seedNumericTopic(sessionId, "devbox", ALLOWED, 6);
      },
    });
    expect(res).toEqual({ ok: true, messageThreadId: 4243 });
    expect(calls.createForumTopic).toHaveLength(1);
    expect((await getBySession(env.DB, sessionId))?.chat_id).toBe("slack:TNUMPOLL");
  });

  it("a numeric chat address with no injected transport is a permanent no_transport create failure, never a throw", async () => {
    const sessionId = await seedSession("devbox");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await resolveTopic(env.DB, { sessionId, machineId: "devbox", chatId: ALLOWED, dir: "~/p", title: "T" });
    expect(res).toMatchObject({ ok: true, messageThreadId: null, reason: "create_failed", transient: false });
    expect(JSON.stringify(res)).not.toContain("error_code");
    expect(await getBySession(env.DB, sessionId)).toBeNull();
  });
});

describe("another workspace's row is never touched", () => {
  it("resolveTopic: the row in another team's chat answers topic_in_other_chat, nothing created or closed", async () => {
    const sessionId = await seedSession("devbox");
    await reserve(env.DB, { sessionId, machineId: "devbox", chatId: "slack:TROWA", name: "a" });
    await finalize(env.DB, { sessionId, chatId: "slack:TROWA", messageThreadId: SLACK_HANDLE_MIN + 11, name: "a", provisional: false });
    const { client, calls } = fakeTransport();
    const res = await resolveTopic(env.DB, { sessionId, machineId: "devbox", chatId: "slack:TROWB", dir: "~/p", title: "T", transport: client });
    expect(res).toMatchObject({ ok: true, messageThreadId: null, reason: "topic_in_other_chat", transient: false });
    expect(Object.values(calls).flat()).toEqual([]);
    expect((await getBySession(env.DB, sessionId))?.chat_id).toBe("slack:TROWA");
  });

  it("a foreign machine on its own workspace gets topic_in_other_chat: unthreaded, the owner's row untouched", async () => {
    const owner = await mkMachine({ slack: true });
    const foreign = await mkMachine({ slack: true });
    const sessionId = await seedSession(owner.machineId);
    const { handle } = await seedSlackTopic(sessionId, owner.machineId, owner.ws!);
    const alerts = await seedAlerts(foreign.ws!);
    slack("chat.postMessage", posted(alerts));
    slack("chat.postMessage", posted(alerts)); // the relocation alert
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await handleSendNotification(
      env.DB,
      envFor([owner, foreign]),
      request("/notifications/send", foreign.key, sendBody(sessionId)),
    );
    expect(res.status).toBe(200);
    expect(slackOf("chat.postMessage").map((c) => c.params.get("channel"))).toEqual([alerts, alerts]);
    const row = await getBySession(env.DB, sessionId);
    expect(row?.chat_id).toBe(slackChatId(owner.ws!));
    expect(row?.message_thread_id).toBe(handle);
  });

  it("a create that finishes after the row moved to another chat does not touch that row (chat-scoped finalize)", async () => {
    const sessionId = await seedSession("devbox");
    const deleted: number[] = [];
    const { client } = fakeTransport({
      createForumTopic: async (o) => {
        // While the create is in flight, the row moves to another workspace.
        await env.DB.prepare("DELETE FROM topics WHERE session_id = ?").bind(sessionId).run();
        await reserve(env.DB, { sessionId, machineId: "devbox", chatId: "slack:TLATEB", name: "other row" });
        return { ok: true, result: { message_thread_id: 9100, name: o.name, icon_color: 0 } };
      },
      deleteForumTopic: (o) => {
        deleted.push(o.messageThreadId);
        return { ok: true, result: true };
      },
    });
    const res = await resolveTopic(env.DB, { sessionId, machineId: "devbox", chatId: "slack:TLATEA", dir: "~/p", title: "T", transport: client });
    const row = await getBySession(env.DB, sessionId);
    expect(row?.chat_id).toBe("slack:TLATEB");
    expect(row?.message_thread_id).toBeNull();
    expect(deleted).toEqual([9100]);
    expect(res).toMatchObject({ ok: true, messageThreadId: null, reason: "topic_in_other_chat" });
  });
});

// ─── rich dialect ──────────────────────────────────────────────────────────

describe("rich dialect matrix", () => {
  const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |";

  async function slackSession() {
    const m = await mkMachine({ slack: true });
    const sessionId = await seedSession(m.machineId);
    const { channelId } = await seedSlackTopic(sessionId, m.machineId, m.ws!);
    return { m, sessionId, channelId };
  }
  const blockTypes = (c: SlackCall | undefined): string[] =>
    (slackJson(c, "blocks") as Array<{ type: string }>).map((b) => b.type);

  it("dialect slack on a Slack target sends one markdown block, with the plain chunk as the notification text", async () => {
    const { m, sessionId, channelId } = await slackSession();
    slack("chat.postMessage", posted(channelId));
    const res = await handleSendNotification(
      env.DB,
      envFor([m]),
      request("/notifications/send", m.key, sendBody(sessionId, { text: "plain chunk 0", rich: { markdown: TABLE, dialect: "slack" } })),
    );
    const body = (await res.json()) as { rich: string; messageId: number };
    expect(body.rich).toBe("sent");
    const call = slackOf("chat.postMessage")[0];
    expect(blockTypes(call)).toContain("markdown");
    expect(call?.params.get("text")).toContain("plain chunk 0");
    expect((await messageRow(slackChatId(m.ws!), body.messageId))?.notification_id).toBe(`s:${sessionId}:1#rich`);
  });

  it("dialect-less rich goes plain (an old daemon's markdown is not Slack's)", async () => {
    const { m, sessionId, channelId } = await slackSession();
    slack("chat.postMessage", posted(channelId));
    const res = await handleSendNotification(
      env.DB,
      envFor([m]),
      request("/notifications/send", m.key, sendBody(sessionId, { rich: { markdown: TABLE } })),
    );
    expect(((await res.json()) as { rich: string }).rich).toBe("fallback");
    expect(blockTypes(slackOf("chat.postMessage")[0])).not.toContain("markdown");
  });

  it("SLACK_MARKDOWN_BLOCKS=off sends plain", async () => {
    const { m, sessionId, channelId } = await slackSession();
    slack("chat.postMessage", posted(channelId));
    const res = await handleSendNotification(
      env.DB,
      envFor([m], { SLACK_MARKDOWN_BLOCKS: "off" }),
      request("/notifications/send", m.key, sendBody(sessionId, { rich: { markdown: TABLE, dialect: "slack" } })),
    );
    expect(((await res.json()) as { rich: string }).rich).toBe("fallback");
    expect(blockTypes(slackOf("chat.postMessage")[0])).not.toContain("markdown");
  });

  it("markdown over Slack's limit goes plain", async () => {
    const { m, sessionId, channelId } = await slackSession();
    slack("chat.postMessage", posted(channelId));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await handleSendNotification(
      env.DB,
      envFor([m]),
      request("/notifications/send", m.key, sendBody(sessionId, { rich: { markdown: "x".repeat(12001), dialect: "slack" } })),
    );
    expect(((await res.json()) as { rich: string }).rich).toBe("fallback");
    expect(blockTypes(slackOf("chat.postMessage")[0])).not.toContain("markdown");
  });

  it("Slack refusing the markdown block falls back to plain once, reporting richError", async () => {
    const { m, sessionId, channelId } = await slackSession();
    slack("chat.postMessage", { ok: false, error: "invalid_blocks" });
    slack("chat.postMessage", posted(channelId));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await handleSendNotification(
      env.DB,
      envFor([m]),
      request("/notifications/send", m.key, sendBody(sessionId, { rich: { markdown: TABLE, dialect: "slack" } })),
    );
    const body = (await res.json()) as { rich: string; richError: { errorClass: string } };
    expect(body.rich).toBe("fallback");
    expect(body.richError.errorClass).toBe("rejected_format");
    expect(blockTypes(slackOf("chat.postMessage")[1])).not.toContain("markdown");
  });
});

// ─── errors ────────────────────────────────────────────────────────────────

describe("errorClass on Slack failures", () => {
  async function slackSession() {
    const m = await mkMachine({ slack: true });
    const sessionId = await seedSession(m.machineId);
    const { channelId } = await seedSlackTopic(sessionId, m.machineId, m.ws!);
    return { m, sessionId, channelId };
  }

  it("an upstream failure is a 502 with errorClass at top level and in details", async () => {
    const { m, sessionId } = await slackSession();
    slack("chat.postMessage", { ok: false, error: "invalid_auth" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await handleSendNotification(env.DB, envFor([m]), request("/notifications/send", m.key, sendBody(sessionId)));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { errorClass: string; details: { errorClass: string; error_code: number } };
    expect(body.errorClass).toBe("upstream");
    expect(body.details.errorClass).toBe("upstream");
    expect(body.details.error_code).toBe(502);
  });

  it("a rate limit is a 429 with retryAfter and errorClass", async () => {
    const { m, sessionId } = await slackSession();
    slack("chat.postMessage", { ok: false, error: "ratelimited" }, 429, { "retry-after": "7" });
    const res = await handleSendNotification(env.DB, envFor([m]), request("/notifications/send", m.key, sendBody(sessionId)));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited", retryAfter: 7, errorClass: "rate_limited" });
  });

  it("a payload Slack rejects (also after relocating to #alerts) is a 502 rejected_format", async () => {
    const { m, sessionId } = await slackSession();
    await seedAlerts(m.ws!);
    // Each post is tried with blocks and then once as plain text; both fail here, in the
    // session channel and again after relocating to #alerts.
    for (let i = 0; i < 4; i++) slack("chat.postMessage", { ok: false, error: "invalid_blocks" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await handleSendNotification(env.DB, envFor([m]), request("/notifications/send", m.key, sendBody(sessionId)));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { errorClass: string }).errorClass).toBe("rejected_format");
  });

  it("a 429 on conversations.create is a topic_unavailable hold with errorClass, never retryAfter", async () => {
    const m = await mkMachine({ slack: true });
    const sessionId = await seedSession(m.machineId);
    slack("conversations.create", { ok: false, error: "ratelimited" }, 429, { "retry-after": "30" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await handleSendNotification(
      env.DB,
      envFor([m]),
      request("/notifications/send", m.key, sendBody(sessionId, { onTopicUnavailable: "retry" })),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "topic_unavailable", reason: "create_failed", errorClass: "upstream" });
    expect(body.retryAfter).toBeUndefined();
    expect(await getBySession(env.DB, sessionId)).toBeNull();
  });
});

// ─── /messages/send ──────────────────────────────────────

describe("/messages/send authorization", () => {
  const send = (e: Env, key: string, body: Record<string, unknown>) =>
    handleSendMessage(e, request("/messages/send", key, { text: "reply", ...body }));

  it("refuses the shared key for any slack: address", async () => {
    const m = await mkMachine({ slack: true });
    const res = await send(envFor([m]), SHARED, { chatId: slackChatId(m.ws!), messageThreadId: 5 });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "chat_not_allowed" });
  });

  it("lets a machine post into its own team, returning the resolved chatId", async () => {
    const m = await mkMachine({ slack: true });
    const handle = await seedChannel(m.ws!.teamId, "COWN1");
    slack("chat.postMessage", posted("COWN1"));
    const res = await send(envFor([m]), m.key, { chatId: slackChatId(m.ws!), messageThreadId: handle });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; messageId: number; chatId: string };
    expect(body).toMatchObject({ ok: true, chatId: slackChatId(m.ws!) });
    expect(body.messageId).toBeGreaterThanOrEqual(SLACK_HANDLE_MIN);
    expect(slackOf("chat.postMessage")[0]?.params.get("channel")).toBe("COWN1");
  });

  it("another team's conversation needs a thread AND a commands row for this machine", async () => {
    const owner = await mkMachine({ slack: true });
    const other = await mkMachine(); // a machine with no workspace
    const e = envFor([owner, other]);
    const chat = slackChatId(owner.ws!);
    const handle = await seedChannel(owner.ws!.teamId, "CXTEAM1");

    // no thread
    expect((await send(e, other.key, { chatId: chat })).status).toBe(403);
    // thread, no commands row
    expect((await send(e, other.key, { chatId: chat, messageThreadId: handle })).status).toBe(403);
    // a row for a different machine does not count
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, message_thread_id, status, created_at)
       VALUES (?, ?, NULL, 'execute', 'x', ?, ?, 'acked', ?)`,
    )
      .bind(`cmd-${stamp()}`, owner.machineId, chat, handle, Date.now())
      .run();
    expect((await send(e, other.key, { chatId: chat, messageThreadId: handle })).status).toBe(403);
    // this machine's own row does
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, message_thread_id, status, created_at)
       VALUES (?, ?, NULL, 'execute', 'x', ?, ?, 'acked', ?)`,
    )
      .bind(`cmd-${stamp()}`, other.machineId, chat, handle, Date.now())
      .run();
    slack("chat.postMessage", posted("CXTEAM1"));
    const ok = await send(e, other.key, { chatId: chat, messageThreadId: handle });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { chatId: string }).chatId).toBe(chat);
  });

  it("notifyOwner on a Slack send mentions the owner only under the errors category", async () => {
    const m = await mkMachine({ slack: true });
    const handle = await seedChannel(m.ws!.teamId, "CNOTIFY1");
    const textOf = async (extra: Record<string, unknown>, body: Record<string, unknown>) => {
      slackCalls.length = 0;
      slack("chat.postMessage", posted("CNOTIFY1"));
      const res = await send(envFor([m], extra), m.key, { chatId: slackChatId(m.ws!), messageThreadId: handle, ...body });
      expect(res.status).toBe(200);
      return slackOf("chat.postMessage")[0]?.params.get("text") ?? "";
    };
    expect(await textOf({}, { notifyOwner: true })).not.toContain("<@U0OWNER>");
    expect(await textOf({ SLACK_NOTIFY_OWNER: "questions" }, { notifyOwner: true })).not.toContain("<@U0OWNER>");
    expect(await textOf({ SLACK_NOTIFY_OWNER: "errors" }, { notifyOwner: true })).toContain("<@U0OWNER>");
    expect(await textOf({ SLACK_NOTIFY_OWNER: "errors" }, {})).not.toContain("<@U0OWNER>");
  });

  it("a team with no configured workspace is 403, even with a commands row", async () => {
    const m = await mkMachine({ slack: true });
    const chat = "slack:TNOWORKSPACE";
    await env.DB.prepare(
      `INSERT INTO commands (command_id, machine_id, session_id, command_type, command, chat_id, message_thread_id, status, created_at)
       VALUES (?, ?, NULL, 'execute', 'x', ?, 424242, 'acked', ?)`,
    )
      .bind(`cmd-${stamp()}`, m.machineId, chat, Date.now())
      .run();
    const res = await send(envFor([m]), m.key, { chatId: chat, messageThreadId: 424242 });
    expect(res.status).toBe(403);
  });

  // pigeon-4ogz.25: the numeric-chatId mapping is gone. Every daemon >= 7f4554f omits chatId or
  // echoes a command's `slack:` one, so a numeric address from a Slack machine is refused like
  // any other unknown address, with no provider call.
  it("a numeric chatId from a Slack machine is 403, with or without a thread, and no provider call", async () => {
    const m = await mkMachine({ slack: true });
    const handle = await seedChannel(m.ws!.teamId, "CHANDLE1");
    for (const body of [{ chatId: "123456" }, { chatId: ALLOWED, messageThreadId: handle }, { chatId: ALLOWED, messageThreadId: 55 }]) {
      const res = await send(envFor([m]), m.key, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "chat_not_allowed" });
    }
    expect(slackCalls).toHaveLength(0);
  });

  it("a machine with no workspace, and the shared key, are refused for a numeric chatId", async () => {
    const m = await mkMachine();
    expect((await send(envFor([m]), m.key, { chatId: ALLOWED })).status).toBe(403);
    expect((await send(envFor([m]), m.key, { chatId: "slack:TX" })).status).toBe(403);
    expect((await send(envFor([m]), SHARED, { chatId: ALLOWED })).status).toBe(403);
    expect(slackCalls).toHaveLength(0);
  });

  it("no chatId at all: a Slack machine posts to its own #alerts", async () => {
    const m = await mkMachine({ slack: true });
    const alerts = await seedAlerts(m.ws!);
    slack("chat.postMessage", posted(alerts));
    const res = await send(envFor([m]), m.key, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, chatId: slackChatId(m.ws!) });
    expect(slackOf("chat.postMessage")[0]?.params.get("channel")).toBe(alerts);
  });

  it("no chatId, with a Slack handle: that conversation in its own workspace; a smaller thread is 403", async () => {
    const m = await mkMachine({ slack: true });
    const handle = await seedChannel(m.ws!.teamId, "CNOCHAT1");
    slack("chat.postMessage", posted("CNOCHAT1"));
    const ok = await send(envFor([m]), m.key, { messageThreadId: handle });
    expect(ok.status).toBe(200);
    expect(slackOf("chat.postMessage")[0]?.params.get("channel")).toBe("CNOCHAT1");
    expect((await send(envFor([m]), m.key, { messageThreadId: 55 })).status).toBe(403);
  });

  it("no chatId from a machine with no workspace or from the shared key is 403; a malformed chatId is 400", async () => {
    const bare = await mkMachine();
    const m = await mkMachine({ slack: true });
    expect((await send(envFor([bare]), bare.key, {})).status).toBe(403);
    expect((await send(envFor([m]), SHARED, {})).status).toBe(403);
    expect((await send(envFor([m]), m.key, { chatId: { not: "a chat" } })).status).toBe(400);
    expect((await send(envFor([m]), m.key, { chatId: "" })).status).toBe(400);
    expect(slackCalls).toHaveLength(0);
  });

  it("maps Slack results onto the Telegram-shaped contract, each with errorClass", async () => {
    const m = await mkMachine({ slack: true });
    const handle = await seedChannel(m.ws!.teamId, "CMAP1");
    const e = envFor([m]);
    const chat = slackChatId(m.ws!);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // unknown handle -> thread_not_found -> 200 {ok:false, provider:{status:400}}
    const unknown = await send(e, m.key, { chatId: chat, messageThreadId: handle + 100000 });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ ok: false, provider: { status: 400 }, errorClass: "conversation_gone" });

    // rate limited -> 200 status 429
    slack("chat.postMessage", { ok: false, error: "ratelimited" }, 429, { "retry-after": "3" });
    const limited = await send(e, m.key, { chatId: chat, messageThreadId: handle });
    expect(limited.status).toBe(200);
    expect(await limited.json()).toMatchObject({ ok: false, provider: { status: 429, retryAfter: 3 }, errorClass: "rate_limited" });

    // rejected -> 200 status 400
    slack("chat.postMessage", { ok: false, error: "msg_too_long" });
    slack("chat.postMessage", { ok: false, error: "msg_too_long" }); // the plain retry
    const rejected = await send(e, m.key, { chatId: chat, messageThreadId: handle });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({ ok: false, provider: { status: 400 }, errorClass: "rejected_format" });

    // upstream -> 502
    slack("chat.postMessage", { ok: false, error: "internal_error" });
    const upstream = await send(e, m.key, { chatId: chat, messageThreadId: handle });
    expect(upstream.status).toBe(502);
    expect(await upstream.json()).toMatchObject({ ok: false, error: expect.stringMatching(/^provider_(error|unparseable)$/), errorClass: "upstream" });
  });
});

// ─── /notifications/edit ───────────────────────────────────────────────────

describe("/notifications/edit routing", () => {
  async function slackQuestion(ws: SlackWorkspace) {
    const channelId = `CEDIT${stamp()}`.toUpperCase();
    const ts = "1700000001.000200";
    await env.DB.prepare("INSERT INTO slack_posts (team_id, channel_id, ts, text, created_at) VALUES (?, ?, ?, 'q', ?)")
      .bind(ws.teamId, channelId, ts, Date.now())
      .run();
    const post = await env.DB.prepare("SELECT handle FROM slack_posts WHERE team_id = ? AND channel_id = ? AND ts = ?")
      .bind(ws.teamId, channelId, ts)
      .first<{ handle: number }>();
    const notificationId = `q:edit:${stamp()}`;
    await env.DB.prepare(
      "INSERT INTO messages (chat_id, message_id, session_id, token, notification_id, created_at) VALUES (?, ?, 'ses_edit', 't', ?, ?)",
    )
      .bind(slackChatId(ws), post!.handle, notificationId, Date.now())
      .run();
    return { notificationId, channelId, ts };
  }
  const edit = (e: Env, key: string, body: Record<string, unknown>) =>
    handleEditNotification(env.DB, e, request("/notifications/edit", key, { text: "edited", ...body }));

  it("is routed by the stored chat and needs a machine of the row's team", async () => {
    const owner = await mkMachine({ slack: true });
    const otherTeam = await mkMachine({ slack: true });
    const telegramMachine = await mkMachine();
    const e = envFor([owner, otherTeam, telegramMachine]);
    const { notificationId, channelId, ts } = await slackQuestion(owner.ws!);

    for (const key of [SHARED, otherTeam.key, telegramMachine.key]) {
      const res = await edit(e, key, { notificationId });
      expect(res.status).toBe(403);
    }
    expect(slackCalls).toHaveLength(0);

    slack("chat.update", { ok: true, ts, channel: channelId });
    // notifyOwner is not part of an edit: a session channel's edit never mentions.
    const ok = await edit(e, owner.key, { notificationId, notifyOwner: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const call = slackOf("chat.update")[0];
    expect(call?.params.get("channel")).toBe(channelId);
    expect(call?.params.get("ts")).toBe(ts);
    expect(call?.params.get("text")).not.toContain("<@U0OWNER>");
  });

  it("a row in a numeric chat (a Telegram-era post) is the existing 404 not-found, with no provider call", async () => {
    const m = await mkMachine({ slack: true });
    const notificationId = `q:numeric:${stamp()}`;
    await env.DB.prepare(
      "INSERT INTO messages (chat_id, message_id, session_id, token, notification_id, created_at) VALUES (?, ?, 'ses_edit', 't', ?, ?)",
    )
      .bind(ALLOWED, 424242 + counter, notificationId, Date.now())
      .run();
    for (const key of [m.key, SHARED]) {
      const res = await edit(envFor([m]), key, { notificationId });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Message not found for notificationId" });
    }
    expect(slackCalls).toHaveLength(0);
  });

  it("a post whose team has no configured workspace is not a 403: it is a transient failure with no provider call", async () => {
    const owner = await mkMachine({ slack: true });
    const { notificationId } = await slackQuestion(owner.ws!);
    const bare = await mkMachine(); // a machine with no workspace, and the team's secret is gone from env
    for (const key of [bare.key, SHARED]) {
      const res = await edit(envFor([bare]), key, { notificationId });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { errorClass: string }).errorClass).toBe("upstream");
    }
    expect(slackCalls).toHaveLength(0);
  });

  it("a Slack failure is a 502 carrying errorClass", async () => {
    const owner = await mkMachine({ slack: true });
    const { notificationId } = await slackQuestion(owner.ws!);
    slack("chat.update", { ok: false, error: "invalid_blocks" });
    const res = await edit(envFor([owner]), owner.key, { notificationId });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { errorClass: string }).errorClass).toBe("rejected_format");
  });
});

// ─── named topics ──────────────────────────────────────────────────────────

describe("named topics on Slack", () => {
  const named = (e: Env, key: string, body: Record<string, unknown>) =>
    handleNamedTopic(env.DB, e, request("/topics/named", key, body));

  it("a Slack machine needs no chatId, ignores a stale one, and gets its slack chatId back", async () => {
    const m = await mkMachine({ slack: true });
    slack("conversations.create", { ok: true, channel: { id: "CNAMED1", name: "digest-one" } });
    slack("conversations.invite", { ok: true });
    slack("conversations.setTopic", { ok: true });

    const res = await named(envFor([m]), m.key, { chatId: "999999", key: "digest:one", name: "The Digest" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chatId: string; messageThreadId: number; created: boolean };
    expect(body.chatId).toBe(slackChatId(m.ws!));
    expect(body.created).toBe(true);
    expect(body.messageThreadId).toBeGreaterThanOrEqual(SLACK_HANDLE_MIN);
    expect(slackOf("conversations.create")[0]?.params.get("name")).toBe("digest-one");
    expect(slackOf("conversations.setTopic")[0]?.params.get("topic")).toBe("The Digest");
    const row = await env.DB.prepare("SELECT message_thread_id FROM named_topics WHERE chat_id = ? AND topic_key = ?")
      .bind(slackChatId(m.ws!), "digest:one")
      .first<{ message_thread_id: number }>();
    expect(row?.message_thread_id).toBe(body.messageThreadId);

    // and with no chatId in the body
    const again = await named(envFor([m]), m.key, { key: "digest:one", name: "The Digest" });
    expect(await again.json()).toMatchObject({ chatId: slackChatId(m.ws!), created: false });
  });

  it("refuses a _-prefixed key (reserved for the worker's own, like _alerts)", async () => {
    const slackM = await mkMachine({ slack: true });
    const refused = await named(envFor([slackM]), slackM.key, { key: "_alerts", name: "x" });
    expect(refused.status).toBe(400);
    expect(slackCalls).toHaveLength(0);
  });

  it("a machine with no workspace and the shared key have nowhere to put one: 403, whatever chatId they send", async () => {
    const m = await mkMachine();
    const slackM = await mkMachine({ slack: true });
    const e = envFor([m, slackM]);
    for (const key of [m.key, SHARED]) {
      expect((await named(e, key, { key: "k", name: "x" })).status).toBe(403);
      expect((await named(e, key, { chatId: ALLOWED, key: "k", name: "x" })).status).toBe(403);
      expect((await named(e, key, { chatId: slackChatId(slackM.ws!), key: "k", name: "x" })).status).toBe(403);
    }
    expect((await named(e, m.key, { name: "x" })).status).toBe(400); // no key
    expect(slackCalls).toHaveLength(0);
  });

  it("bind writes the binding under the resolved Slack chat id", async () => {
    const m = await mkMachine({ slack: true });
    const sessionId = await seedSession(m.machineId);
    slack("conversations.create", { ok: true, channel: { id: "CBIND1", name: "digest-two" } });
    slack("conversations.invite", { ok: true });
    slack("conversations.setTopic", { ok: true });

    const res = await handleNamedTopicBind(
      env.DB,
      envFor([m]),
      request("/topics/named/bind", m.key, { chatId: ALLOWED, key: "digest:two", name: "Two", sessionId }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ chatId: slackChatId(m.ws!), bound: true, sessionId });
    const binding = await env.DB.prepare("SELECT chat_id FROM named_topic_bindings WHERE session_id = ?")
      .bind(sessionId)
      .first<{ chat_id: string }>();
    expect(binding?.chat_id).toBe(slackChatId(m.ws!));

    const bad = await handleNamedTopicBind(
      env.DB,
      envFor([m]),
      request("/topics/named/bind", m.key, { key: "_x", name: "x", sessionId }),
    );
    expect(bad.status).toBe(400);
  });
});

// ─── the helpers themselves ────────────────────────────────────────────────

describe("address helpers", () => {
  it("resolveWorkerTarget: a machine's target is its own workspace, whatever it sent; nobody else has one", async () => {
    const m = await mkMachine({ slack: true });
    const bare = await mkMachine();
    const e = envFor([m, bare]);
    expect(resolveWorkerTarget(e, { kind: "machine", machineId: m.machineId })).toEqual({
      ok: true,
      chatId: slackChatId(m.ws!),
      slack: true,
    });
    expect(resolveWorkerTarget(e, { kind: "machine", machineId: bare.machineId })).toEqual({ ok: false });
    expect(resolveWorkerTarget(e, { kind: "shared" })).toEqual({ ok: false });
  });

  it("authorizeStoredAddress: a slack: address with no team id is refused", async () => {
    const m = await mkMachine({ slack: true });
    const res = await authorizeStoredAddress(envFor([m]), env.DB, { kind: "machine", machineId: m.machineId }, "slack:", 5);
    expect(res.ok).toBe(false);
  });
});
