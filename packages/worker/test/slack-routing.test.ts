/**
 * Slack address routing, authorization and supersede (bead pigeon-4ogz.3, task 3). Plan:
 * docs/plans/2026-11-20-slack-outbound-plan.md ("Address resolution and authorization",
 * "/notifications/send changes", "resolveTopic supersede", "Named topics") and its review deltas.
 *
 * Handlers are called directly with `{...env, SLACK_WORKSPACE_<MACHINE>: <json>}` and per-machine
 * credentials inserted into `machine_credentials`, so the principal is real. Slack and Telegram
 * are fetchMocks, with `disableNetConnect` and `assertNoPendingInterceptors`, so a missing OR an
 * unexpected provider call fails the test. Every test uses its own machine, team and session ids:
 * the D1 tables are shared by the whole file.
 */
import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import { sha256Hex } from "../src/credentials";
import { SLACK_HANDLE_MIN, slackChatId, slackSecretKeyForMachine, type SlackWorkspace } from "../src/chat/slack-config";
import { handleEditNotification, handleSendNotification } from "../src/notifications";
import { handleSendMessage, handleUnpinTopic } from "../src/messages";
import { handleNamedTopic, handleNamedTopicBind } from "../src/named-topics";
import { resolveTopic, SUPERSEDE_CLOSE_BOUND_MS, SUPERSEDE_MIN_AGE_MS } from "../src/topic-manager";
import { finalize, getBySession, reserve } from "../src/topics";
import { createTelegramClient } from "../src/telegram";
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
  return { ...env, TELEGRAM_TOPICS_ENABLED: "true", ...secrets, ...extra } as unknown as Env;
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

interface TgCall {
  method: string;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const tgCalls: TgCall[] = [];

/** One expected Telegram Bot API call. */
function tg(method: string, result: unknown, status = 200, delayMs?: number) {
  const interceptor = fetchMock
    .get("https://api.telegram.org")
    .intercept({ method: "POST", path: new RegExp(`/bot.*/${method}$`) })
    .reply(status, (opts: { body?: unknown }) => {
      const raw = typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body as ArrayBuffer);
      tgCalls.push({ method, body: JSON.parse(raw) });
      return status === 200 ? { ok: true, result } : (result as Record<string, unknown>);
    });
  if (delayMs !== undefined) interceptor.delay(delayMs);
}
const tgOf = (method: string) => tgCalls.filter((c) => c.method === method);

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
/**
 * Topic rows are seeded as OLD (10 minutes) so a supersede is allowed to replace them: a row
 * younger than SUPERSEDE_MIN_AGE_MS is deliberately left alone. `ageMs: 0` seeds a fresh one.
 */
const OLD_ROW_MS = 10 * 60_000;
async function ageTopic(sessionId: string, ageMs: number) {
  await env.DB.prepare("UPDATE topics SET created_at = ? WHERE session_id = ?")
    .bind(Date.now() - ageMs, sessionId)
    .run();
}

async function seedSlackTopic(sessionId: string, machineId: string, ws: SlackWorkspace, ageMs = OLD_ROW_MS) {
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
  await ageTopic(sessionId, ageMs);
  return { channelId, handle };
}

async function seedTelegramTopic(sessionId: string, machineId: string, chatId: string, thread: number, ageMs = OLD_ROW_MS) {
  await reserve(env.DB, { sessionId, machineId, chatId, name: "tg" });
  await finalize(env.DB, { sessionId, chatId, messageThreadId: thread, name: "tg", provisional: false });
  await ageTopic(sessionId, ageMs);
}

async function messageRow(chatId: string, messageId: number) {
  return env.DB.prepare("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?")
    .bind(chatId, messageId)
    .first<{ chat_id: string; message_id: number; notification_id: string | null }>();
}

/** Telegram message ids must be unique per chat (the messages table keys on them). */
const mid = () => 1_000_000 + ++counter;

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

  it("the daemon's stale (even allowlisted) numeric chatId cannot pull a Slack session back to Telegram", async () => {
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
    expect(tgCalls).toHaveLength(0);
    expect((await messageRow(slackChatId(m.ws!), body.messageId))?.chat_id).toBe(slackChatId(m.ws!));
    expect((await getBySession(env.DB, sessionId))?.message_thread_id).toBe(handle);
  });

  it("with no Slack secret nothing changes: Telegram, the same response body, and a slack: chatId is refused", async () => {
    const m = await mkMachine();
    const sessionId = await seedSession(m.machineId);
    const id = mid();
    tg("sendMessage", { message_id: id });
    const res = await handleSendNotification(
      env.DB,
      envFor([m], { TELEGRAM_TOPICS_ENABLED: "false" }),
      request("/notifications/send", m.key, sendBody(sessionId, { chatId: ALLOWED })),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["messageId", "ok", "token"]);
    expect(body.messageId).toBe(id);
    expect(tgCalls[0]?.body.chat_id).toBe(ALLOWED);

    const refused = await handleSendNotification(
      env.DB,
      envFor([m]),
      request("/notifications/send", m.key, sendBody(sessionId, { chatId: "slack:TANY" })),
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "Chat ID not allowed" });

    const missing = await handleSendNotification(env.DB, envFor([m]), request("/notifications/send", m.key, sendBody(sessionId)));
    expect(missing.status).toBe(400);
  });

  it("notifyOwner reaches a Slack post as a mention only for an enabled category, and is not sent to Telegram", async () => {
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

// ─── supersede ─────────────────────────────────────────────────────────────

describe("supersede", () => {
  it("Telegram -> Slack: the owner's row is replaced, the old topic closed, a channel created", async () => {
    const m = await mkMachine({ slack: true });
    const sessionId = await seedSession(m.machineId);
    await seedTelegramTopic(sessionId, m.machineId, ALLOWED, 77);
    tg("closeForumTopic", true);
    slackCreate("CSUP1");
    slack("chat.postMessage", posted("CSUP1"));

    const res = await handleSendNotification(env.DB, envFor([m]), request("/notifications/send", m.key, sendBody(sessionId)));
    expect(res.status).toBe(200);
    expect(tgOf("closeForumTopic")[0]?.body).toMatchObject({ chat_id: ALLOWED, message_thread_id: 77 });
    const row = await getBySession(env.DB, sessionId);
    expect(row?.chat_id).toBe(slackChatId(m.ws!));
    expect(row?.message_thread_id).toBeGreaterThanOrEqual(SLACK_HANDLE_MIN);
  });

  it("Slack -> Telegram: the owner (now on Telegram) replaces the Slack row and archives its channel", async () => {
    // Team T stays configured under another machine's secret; the owner has none.
    const holder = await mkMachine({ slack: true });
    const owner = await mkMachine();
    const sessionId = await seedSession(owner.machineId);
    const { channelId } = await seedSlackTopic(sessionId, owner.machineId, holder.ws!);
    slack("conversations.archive", { ok: true });
    tg("createForumTopic", { message_thread_id: 321, name: "n", icon_color: 1 });
    tg("sendMessage", { message_id: mid() });
    tg("unpinAllForumTopicMessages", true);

    const res = await handleSendNotification(
      env.DB,
      envFor([holder, owner]),
      request("/notifications/send", owner.key, sendBody(sessionId, { chatId: ALLOWED })),
    );
    expect(res.status).toBe(200);
    expect(slackOf("conversations.archive")[0]?.params.get("channel")).toBe(channelId);
    const row = await getBySession(env.DB, sessionId);
    expect(row?.chat_id).toBe(ALLOWED);
    expect(row?.message_thread_id).toBe(321);
    expect(tgOf("sendMessage")[0]?.body).toMatchObject({ chat_id: ALLOWED, message_thread_id: 321 });
  });

  describe("hysteresis: a row younger than SUPERSEDE_MIN_AGE_MS is not superseded", () => {
    const run = async (rowAgeMs: number, thread: number) => {
      const m = await mkMachine({ slack: true });
      const sessionId = await seedSession(m.machineId);
      const seeded = await seedSlackTopic(sessionId, m.machineId, m.ws!, rowAgeMs);
      const created: number[] = [];
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await resolveTopic(env.DB, {
        sessionId,
        machineId: m.machineId,
        chatId: ALLOWED,
        dir: "~/p",
        title: "T",
        botToken: "unused",
        supersede: true,
        env: envFor([m]),
        tgClient: {
          ...createTelegramClient("unused"),
          createForumTopic: async (o: { name: string }) => {
            created.push(thread);
            return { ok: true as const, result: { message_thread_id: thread, name: o.name, icon_color: 0 } };
          },
        },
      });
      warn.mockRestore();
      return { res, sessionId, seeded, created, m };
    };

    it("is five minutes", () => {
      expect(SUPERSEDE_MIN_AGE_MS).toBe(5 * 60_000);
    });

    it("just under the floor: topic_in_other_chat, the Slack row untouched, nothing created or closed", async () => {
      const { res, sessionId, seeded, created, m } = await run(SUPERSEDE_MIN_AGE_MS - 5000, 5100);
      expect(res).toMatchObject({ ok: true, messageThreadId: null, reason: "topic_in_other_chat" });
      expect(created).toEqual([]);
      const row = await getBySession(env.DB, sessionId);
      expect(row?.chat_id).toBe(slackChatId(m.ws!));
      expect(row?.message_thread_id).toBe(seeded.handle);
      expect(slackOf("conversations.archive")).toHaveLength(0);
    });

    it("just over the floor: superseded as before", async () => {
      // The archive of the old channel is the Slack call a supersede makes.
      slack("conversations.archive", { ok: true });
      const { res, sessionId, created } = await run(SUPERSEDE_MIN_AGE_MS + 5000, 5101);
      expect(res).toMatchObject({ ok: true, messageThreadId: 5101, created: true });
      expect(created).toEqual([5101]);
      expect((await getBySession(env.DB, sessionId))?.chat_id).toBe(ALLOWED);
      expect(slackOf("conversations.archive")).toHaveLength(1);
    });
  });

  it("a close that outlasts the 3 s bound is logged and does not hold the notification", async () => {
    expect(SUPERSEDE_CLOSE_BOUND_MS).toBe(3000);
    const m = await mkMachine({ slack: true });
    const sessionId = await seedSession(m.machineId);
    await seedTelegramTopic(sessionId, m.machineId, ALLOWED, 78);
    tg("closeForumTopic", true, 200, 5000);
    slackCreate("CSUP2");
    slack("chat.postMessage", posted("CSUP2"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const started = Date.now();
    const res = await handleSendNotification(env.DB, envFor([m]), request("/notifications/send", m.key, sendBody(sessionId)));
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(4800);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("closing the superseded conversation timed out"))).toBe(true);
  }, 15_000);

  it.each([
    ["a foreign machine", "machine"],
    ["the shared key", "shared"],
  ])("%s gets topic_in_other_chat: unthreaded, the Slack row untouched", async (_name, kind) => {
    const owner = await mkMachine({ slack: true });
    const foreign = await mkMachine();
    const sessionId = await seedSession(owner.machineId);
    const { handle } = await seedSlackTopic(sessionId, owner.machineId, owner.ws!);
    tg("sendMessage", { message_id: mid() });
    tg("sendMessage", { message_id: mid() }); // the relocation alert

    const key = kind === "shared" ? SHARED : foreign.key;
    const res = await handleSendNotification(
      env.DB,
      envFor([owner, foreign]),
      request("/notifications/send", key, sendBody(sessionId, { chatId: ALLOWED })),
    );
    expect(res.status).toBe(200);
    expect(tgOf("sendMessage")[0]?.body.message_thread_id).toBeUndefined();
    const row = await getBySession(env.DB, sessionId);
    expect(row?.chat_id).toBe(slackChatId(owner.ws!));
    expect(row?.message_thread_id).toBe(handle);
  });

  it("the same transport's other chat is never superseded, even for the owner", async () => {
    const sessionId = await seedSession("devbox");
    await seedTelegramTopic(sessionId, "devbox", "-100111", 5);
    const never = createTelegramClient("unused");
    const res = await resolveTopic(env.DB, {
      sessionId,
      machineId: "devbox",
      chatId: "-100222",
      dir: "~/p",
      title: "T",
      botToken: "unused",
      supersede: true,
      tgClient: {
        ...never,
        createForumTopic: async () => {
          throw new Error("must not create");
        },
        closeForumTopic: async () => {
          throw new Error("must not close");
        },
      },
    });
    expect(res).toMatchObject({ ok: true, messageThreadId: null, reason: "topic_in_other_chat" });
    expect((await getBySession(env.DB, sessionId))?.chat_id).toBe("-100111");
  });

  describe("a row that appears while resolveTopic is already running", () => {
    const FOREIGN_CREATE = (created: number[], thread: number) => ({
      ...createTelegramClient("unused"),
      createForumTopic: async (o: { name: string }) => {
        created.push(created.length + 1);
        return { ok: true as const, result: { message_thread_id: thread, name: o.name, icon_color: 0 } };
      },
    });

    it("loser path: the reserve is lost to the other transport's row, which is superseded and reserved again", async () => {
      const m = await mkMachine({ slack: true });
      const e = envFor([m]);
      const sessionId = await seedSession(m.machineId);
      let seeded: { channelId: string } | undefined;
      // The first lookup (step 1) sees nothing; the Slack row lands right after it, so the
      // reserve loses and the loser-path re-read is what finds the foreign row.
      let lookups = 0;
      const racing = new Proxy(env.DB, {
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
                    if (++lookups === 1) seeded = await seedSlackTopic(sessionId, m.machineId, m.ws!);
                    return row;
                  },
                };
              },
            };
          };
        },
      }) as unknown as D1Database;
      slack("conversations.archive", { ok: true });
      const created: number[] = [];

      const res = await resolveTopic(racing, {
        sessionId,
        machineId: m.machineId,
        chatId: ALLOWED,
        dir: "~/p",
        title: "T",
        botToken: "unused",
        supersede: true,
        env: e,
        tgClient: FOREIGN_CREATE(created, 4242),
      });
      expect(res).toMatchObject({ ok: true, messageThreadId: 4242, created: true });
      expect(slackOf("conversations.archive")[0]?.params.get("channel")).toBe(seeded?.channelId);
      expect(created).toHaveLength(1);
      const row = await getBySession(env.DB, sessionId);
      expect(row?.chat_id).toBe(ALLOWED);
      expect(row?.message_thread_id).toBe(4242);
    });

    it("poll path: a foreign row that shows up while polling is superseded the same way", async () => {
      const m = await mkMachine({ slack: true });
      const e = envFor([m]);
      const sessionId = await seedSession(m.machineId);
      // A rival's unfinalized reservation in OUR chat: step 1 and the loser path wait on it.
      await reserve(env.DB, { sessionId, machineId: m.machineId, chatId: ALLOWED, name: "rival" });
      let seeded: { channelId: string } | undefined;
      let polls = 0;
      slack("conversations.archive", { ok: true });
      const created: number[] = [];

      const res = await resolveTopic(env.DB, {
        sessionId,
        machineId: m.machineId,
        chatId: ALLOWED,
        dir: "~/p",
        title: "T",
        botToken: "unused",
        supersede: true,
        env: e,
        tgClient: FOREIGN_CREATE(created, 4243),
        delayFn: async () => {
          if (++polls !== 1) return;
          // The rival gave up and the machine's other-transport row took its place.
          await env.DB.prepare("DELETE FROM topics WHERE session_id = ?").bind(sessionId).run();
          seeded = await seedSlackTopic(sessionId, m.machineId, m.ws!);
        },
      });
      expect(res).toMatchObject({ ok: true, messageThreadId: 4243, created: true });
      expect(slackOf("conversations.archive")[0]?.params.get("channel")).toBe(seeded?.channelId);
      expect(created).toHaveLength(1);
      expect((await getBySession(env.DB, sessionId))?.chat_id).toBe(ALLOWED);
    });
  });

  it("a Telegram create that finishes after a supersede does not touch the Slack row (chat-scoped finalize)", async () => {
    const m = await mkMachine({ slack: true });
    const sessionId = await seedSession(m.machineId);
    const slackChat = slackChatId(m.ws!);
    const deleted: number[] = [];
    const res = await resolveTopic(env.DB, {
      sessionId,
      machineId: m.machineId,
      chatId: ALLOWED,
      dir: "~/p",
      title: "T",
      botToken: "unused",
      supersede: true,
      tgClient: {
        ...createTelegramClient("unused"),
        createForumTopic: async (o) => {
          // While the 57 s create is in flight, the row moves to Slack.
          await env.DB.prepare("DELETE FROM topics WHERE session_id = ?").bind(sessionId).run();
          await reserve(env.DB, { sessionId, machineId: m.machineId, chatId: slackChat, name: "slack row" });
          return { ok: true, result: { message_thread_id: 9100, name: o.name, icon_color: 0 } };
        },
        deleteForumTopic: async (o) => {
          deleted.push(o.messageThreadId);
          return { ok: true, result: true };
        },
      },
    });
    const row = await getBySession(env.DB, sessionId);
    expect(row?.chat_id).toBe(slackChat);
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

  it("dialect-less rich on a Slack target goes plain (Telegram markdown is not Slack's)", async () => {
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

  it("dialect slack on a Telegram target goes plain, with no sendRichMessage", async () => {
    const m = await mkMachine();
    const sessionId = await seedSession(m.machineId);
    tg("sendMessage", { message_id: mid() });
    const res = await handleSendNotification(
      env.DB,
      envFor([m]),
      request("/notifications/send", m.key, sendBody(sessionId, { chatId: ALLOWED, threaded: false, rich: { markdown: TABLE, dialect: "slack" } })),
    );
    expect(((await res.json()) as { rich: string }).rich).toBe("fallback");
    expect(tgOf("sendRichMessage")).toHaveLength(0);
  });

  it("dialect-less rich on a Telegram target is still sent rich", async () => {
    const m = await mkMachine();
    const sessionId = await seedSession(m.machineId);
    tg("sendRichMessage", { message_id: mid() });
    const res = await handleSendNotification(
      env.DB,
      envFor([m]),
      request("/notifications/send", m.key, sendBody(sessionId, { chatId: ALLOWED, threaded: false, rich: { markdown: TABLE } })),
    );
    expect(((await res.json()) as { rich: string }).rich).toBe("sent");
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

  it("a Telegram failure has no errorClass (responses unchanged)", async () => {
    const m = await mkMachine();
    const sessionId = await seedSession(m.machineId);
    tg("sendMessage", { ok: false, error_code: 500, description: "boom" }, 500);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await handleSendNotification(
      env.DB,
      envFor([m]),
      request("/notifications/send", m.key, sendBody(sessionId, { chatId: ALLOWED, threaded: false })),
    );
    expect(res.status).toBe(502);
    expect(Object.keys((await res.json()) as object).sort()).toEqual(["details", "error"]);
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

// ─── /messages/send and /topics/unpin ──────────────────────────────────────

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
    const other = await mkMachine(); // a Telegram machine
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

  it("a numeric chatId with no thread from a Slack machine posts to its #alerts", async () => {
    const m = await mkMachine({ slack: true });
    const alerts = await seedAlerts(m.ws!);
    slack("chat.postMessage", posted(alerts));
    const res = await send(envFor([m]), m.key, { chatId: "123456" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { chatId: string }).chatId).toBe(slackChatId(m.ws!));
    expect(slackOf("chat.postMessage")[0]?.params.get("channel")).toBe(alerts);
  });

  it("a numeric chatId with a Slack handle (>= 2^40) goes to that conversation in its own workspace", async () => {
    const m = await mkMachine({ slack: true });
    const handle = await seedChannel(m.ws!.teamId, "CHANDLE1");
    slack("chat.postMessage", posted("CHANDLE1"));
    const res = await send(envFor([m]), m.key, { chatId: ALLOWED, messageThreadId: handle });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { chatId: string }).chatId).toBe(slackChatId(m.ws!));
  });

  it("a Telegram thread from a Slack machine still takes the Telegram path, with the old response", async () => {
    const m = await mkMachine({ slack: true });
    const id = mid();
    tg("sendMessage", { message_id: id });
    const res = await send(envFor([m]), m.key, { chatId: ALLOWED, messageThreadId: 55 });
    expect(await res.json()).toEqual({ ok: true, messageId: id });
    expect(tgCalls[0]?.body).toMatchObject({ chat_id: ALLOWED, message_thread_id: 55 });
  });

  it("with no Slack secret the response is exactly as before (no chatId)", async () => {
    const m = await mkMachine();
    const id = mid();
    tg("sendMessage", { message_id: id });
    const res = await send(envFor([m]), m.key, { chatId: ALLOWED });
    expect(await res.json()).toEqual({ ok: true, messageId: id });
    expect((await send(envFor([m]), m.key, { chatId: "slack:TX" })).status).toBe(403);
  });

  it("maps Slack results onto the Telegram-shaped contract, each with errorClass", async () => {
    const m = await mkMachine({ slack: true });
    const handle = await seedChannel(m.ws!.teamId, "CMAP1");
    const e = envFor([m]);
    const chat = slackChatId(m.ws!);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // unknown handle -> thread_not_found -> 200 {ok:false, telegram:{status:400}}
    const unknown = await send(e, m.key, { chatId: chat, messageThreadId: handle + 100000 });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ ok: false, telegram: { status: 400 }, errorClass: "conversation_gone" });

    // rate limited -> 200 status 429
    slack("chat.postMessage", { ok: false, error: "ratelimited" }, 429, { "retry-after": "3" });
    const limited = await send(e, m.key, { chatId: chat, messageThreadId: handle });
    expect(limited.status).toBe(200);
    expect(await limited.json()).toMatchObject({ ok: false, telegram: { status: 429, retryAfter: 3 }, errorClass: "rate_limited" });

    // rejected -> 200 status 400
    slack("chat.postMessage", { ok: false, error: "msg_too_long" });
    slack("chat.postMessage", { ok: false, error: "msg_too_long" }); // the plain retry
    const rejected = await send(e, m.key, { chatId: chat, messageThreadId: handle });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({ ok: false, telegram: { status: 400 }, errorClass: "rejected_format" });

    // upstream -> 502
    slack("chat.postMessage", { ok: false, error: "internal_error" });
    const upstream = await send(e, m.key, { chatId: chat, messageThreadId: handle });
    expect(upstream.status).toBe(502);
    expect(await upstream.json()).toMatchObject({ ok: false, errorClass: "upstream" });
  });
});

describe("/topics/unpin", () => {
  const unpin = (e: Env, key: string, body: Record<string, unknown>) => handleUnpinTopic(e, request("/topics/unpin", key, body));

  it("is {ok:true} with no provider call on Slack, and refused for the shared key", async () => {
    const m = await mkMachine({ slack: true });
    const e = envFor([m]);
    const chat = slackChatId(m.ws!);
    const res = await unpin(e, m.key, { chatId: chat, messageThreadId: 99 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The numeric-address-with-a-handle form from an old daemon is Slack too.
    const viaNumeric = await unpin(e, m.key, { chatId: ALLOWED, messageThreadId: SLACK_HANDLE_MIN + 5 });
    expect(await viaNumeric.json()).toEqual({ ok: true });
    expect((await unpin(e, SHARED, { chatId: chat, messageThreadId: 99 })).status).toBe(403);
    expect(slackCalls).toHaveLength(0);
  });

  it("is unchanged on Telegram", async () => {
    const m = await mkMachine();
    tg("unpinAllForumTopicMessages", true);
    const res = await unpin(envFor([m]), m.key, { chatId: ALLOWED, messageThreadId: 12 });
    expect(await res.json()).toEqual({ ok: true });
    expect(tgCalls[0]?.body).toMatchObject({ chat_id: ALLOWED, message_thread_id: 12 });
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

  it("a post whose team has no configured workspace is not a 403: it is a transient failure with no provider call", async () => {
    const owner = await mkMachine({ slack: true });
    const { notificationId } = await slackQuestion(owner.ws!);
    const bare = await mkMachine(); // a Telegram machine, and the team's secret is gone from env
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

  it("refuses a _-prefixed key on Slack only", async () => {
    const slackM = await mkMachine({ slack: true });
    const refused = await named(envFor([slackM]), slackM.key, { key: "_alerts", name: "x" });
    expect(refused.status).toBe(400);
    expect(slackCalls).toHaveLength(0);

    const tgM = await mkMachine();
    tg("createForumTopic", { message_thread_id: 654, name: "x", icon_color: 1 });
    const ok = await named(envFor([tgM]), tgM.key, { chatId: ALLOWED, key: "_private", name: "x" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ chatId: ALLOWED, messageThreadId: 654, created: true });
  });

  it("Telegram machines still need an allowlisted chatId, and cannot name a slack: chat", async () => {
    const m = await mkMachine();
    const e = envFor([m]);
    expect((await named(e, m.key, { key: "k", name: "x" })).status).toBe(400);
    expect((await named(e, m.key, { chatId: "555", key: "k", name: "x" })).status).toBe(403);
    expect((await named(e, m.key, { chatId: "slack:TX", key: "k", name: "x" })).status).toBe(403);
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
  it("resolveWorkerTarget: Telegram targets keep the caller's raw chatId", async () => {
    const m = await mkMachine();
    const e = envFor([m]);
    const principal: Principal = { kind: "machine", machineId: m.machineId };
    expect(resolveWorkerTarget(e, principal, ALLOWED)).toEqual({ ok: true, chatId: ALLOWED, slack: false });
    expect(resolveWorkerTarget(e, principal, Number(ALLOWED))).toEqual({ ok: true, chatId: Number(ALLOWED), slack: false });
    expect(resolveWorkerTarget(e, principal, undefined)).toEqual({ ok: false });
    expect(resolveWorkerTarget(e, { kind: "shared" }, "slack:T1")).toEqual({ ok: false });
  });

  it("authorizeStoredAddress: a slack: address with no team id is refused", async () => {
    const m = await mkMachine({ slack: true });
    const res = await authorizeStoredAddress(envFor([m]), env.DB, { kind: "machine", machineId: m.machineId }, "slack:", 5);
    expect(res.ok).toBe(false);
  });
});
