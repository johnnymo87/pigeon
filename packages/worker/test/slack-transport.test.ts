/**
 * The Slack ChatTransport (bead pigeon-4ogz.3, task 2): handles, posting and its recoveries,
 * files, channel lifecycle, #alerts, and `transportForChat` routing. Plan:
 * docs/plans/2026-11-20-slack-outbound-plan.md, "SlackTransport" and the review deltas.
 *
 * Slack is a fetchMock on https://slack.com (and the upload host). Every test gets its own team
 * id, so the D1 tables (shared by the whole file) never leak state between tests, and
 * `disableNetConnect` plus `assertNoPendingInterceptors` make a missing OR an extra call fail.
 */
import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import { transportForChat } from "../src/chat";
import { SLACK_HANDLE_MIN, slackChatId, type SlackWorkspace } from "../src/chat/slack-config";
import { parseNotifyCategories } from "../src/chat/slack-notify";
import { createSlackTransport, slugify } from "../src/chat/slack-transport";
import type { ChatTransport } from "../src/chat";
import { createTelegramClient } from "../src/telegram";

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  calls.length = 0;
});

afterEach(() => {
  try {
    fetchMock.assertNoPendingInterceptors();
  } finally {
    fetchMock.deactivate();
  }
});

let counter = 0;
const uniq = (p: string) => `${p}${Date.now().toString(36)}${(++counter).toString(36)}`.toUpperCase();

interface Call {
  method: string;
  params: URLSearchParams;
  auth: string;
}
const calls: Call[] = [];

function mkWs(): SlackWorkspace {
  return {
    teamId: uniq("T"),
    appId: "A0APP",
    domain: "acme",
    botToken: "xoxb-bot",
    userToken: "xoxp-user",
    signingSecret: "sig",
    ownerUserId: "U0OWNER",
  };
}

type Reply = Record<string, unknown> | ((params: URLSearchParams) => Record<string, unknown>);

/** One expected Slack Web API call, answered with 200 and `reply`. Calls are recorded in order. */
function slack(method: string, reply: Reply, status = 200, headers?: Record<string, string>) {
  fetchMock
    .get("https://slack.com")
    .intercept({ method: "POST", path: `/api/${method}` })
    .reply(
      status,
      (opts: { body?: unknown; headers?: unknown }) => {
        const params = new URLSearchParams(String(opts.body));
        const h = Object.fromEntries(
          Object.entries((opts.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
        );
        calls.push({ method, params, auth: h.authorization ?? "" });
        return typeof reply === "function" ? reply(params) : reply;
      },
      headers ? { headers } : undefined,
    );
}

const methods = () => calls.map((c) => c.method);
const json = (c: Call | undefined, key: string) => JSON.parse(c?.params.get(key) ?? "null");

/** A channel the transport already knows, returning its handle. */
async function seedChannel(ws: SlackWorkspace, channelId: string): Promise<number> {
  await env.DB.prepare("INSERT INTO slack_conversations (team_id, channel_id, created_at) VALUES (?, ?, ?)")
    .bind(ws.teamId, channelId, Date.now())
    .run();
  const row = await env.DB.prepare("SELECT handle FROM slack_conversations WHERE team_id = ? AND channel_id = ?")
    .bind(ws.teamId, channelId)
    .first<{ handle: number }>();
  return row!.handle;
}

async function seedNamed(ws: SlackWorkspace, key: string, handle: number) {
  await env.DB.prepare(
    `INSERT INTO named_topics (chat_id, topic_key, message_thread_id, name, reopen_checked_at, hint_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, 0, 0)`,
  )
    .bind(slackChatId(ws), key, handle, key)
    .run();
}

function transport(ws: SlackWorkspace, notify = ""): ChatTransport {
  return createSlackTransport({ db: env.DB, ws, notifyCategories: parseNotifyCategories(notify) });
}

const posted = { ok: true, ts: "1700000000.000100", channel: "C1" };

// ─── names ─────────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("folds accents, lower-cases, collapses and trims", () => {
    expect(slugify("  Café Déjà-vu!! / Tést  ")).toBe("cafe-deja-vu-test");
    expect(slugify("---a___b---")).toBe("a-b");
    expect(slugify("日本語")).toBe("");
  });
});

// ─── unknown handles ───────────────────────────────────────────────────────

describe("handles", () => {
  it("answers thread_not_found for a handle this team does not know, on every method that takes one", async () => {
    const ws = mkWs();
    const other = mkWs();
    const foreign = await seedChannel(other, "CFOREIGN");
    const t = transport(ws);
    const chatId = slackChatId(ws);
    for (const handle of [424242, foreign]) {
      const results = await Promise.all([
        t.sendMessage({ chatId, text: "x", messageThreadId: handle }),
        t.sendRichMessage({ chatId, markdown: "x", messageThreadId: handle }),
        t.sendDocument({ chatId, document: new Blob(["a"]), filename: "a.txt", messageThreadId: handle }),
        t.editForumTopic({ chatId, messageThreadId: handle, name: "n" }),
        t.closeForumTopic({ chatId, messageThreadId: handle }),
        t.reopenForumTopic({ chatId, messageThreadId: handle }),
        t.deleteForumTopic({ chatId, messageThreadId: handle }),
        t.editMessageText({ chatId, messageId: handle, text: "x" }),
      ]);
      for (const r of results) {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.kind).toBe("thread_not_found");
      }
    }
    expect(calls).toEqual([]);
  });
});

// ─── createForumTopic ──────────────────────────────────────────────────────

describe("createForumTopic", () => {
  it("names the channel <title-slug>-<sid8>, invites the owner, sets the topic, and returns a handle", async () => {
    const ws = mkWs();
    slack("conversations.create", { ok: true, channel: { id: "CNEW1", name: "fix-flaky-test-abcdef12" } });
    slack("conversations.invite", { ok: true });
    slack("conversations.setTopic", { ok: true });
    const name = "Fix flaky test · ~/projects/pigeon";
    const res = await transport(ws).createForumTopic({
      chatId: slackChatId(ws),
      name,
      iconColor: 7322096,
      sessionId: "ses_ABCDEF1234567890",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.message_thread_id).toBeGreaterThanOrEqual(SLACK_HANDLE_MIN);
    expect(res.result.name).toBe("fix-flaky-test-abcdef12");
    expect(res.result.icon_color).toBe(0);

    expect(methods()).toEqual(["conversations.create", "conversations.invite", "conversations.setTopic"]);
    expect(calls[0]!.params.get("name")).toBe("fix-flaky-test-abcdef12");
    expect(calls[0]!.params.get("is_private")).toBe("false");
    expect(calls[0]!.auth).toBe("Bearer xoxb-bot");
    expect(calls[1]!.params.get("channel")).toBe("CNEW1");
    expect(calls[1]!.params.get("users")).toBe("U0OWNER");
    expect(calls[2]!.params.get("topic")).toBe(`${name} · 🆔 ses_ABCDEF1234567890`);

    const row = await env.DB.prepare("SELECT channel_id FROM slack_conversations WHERE handle = ? AND team_id = ?")
      .bind(res.result.message_thread_id, ws.teamId)
      .first<{ channel_id: string }>();
    expect(row?.channel_id).toBe("CNEW1");
  });

  it("uses the directory basename when the name has no title, and the whole name when there is no session id", async () => {
    const ws = mkWs();
    const t = transport(ws);
    const create = async (opts: Record<string, unknown>, expectName: string) => {
      slack("conversations.create", (p) => ({ ok: true, channel: { id: uniq("C"), name: p.get("name") } }));
      slack("conversations.invite", { ok: true });
      slack("conversations.setTopic", { ok: true });
      const res = await t.createForumTopic({ chatId: slackChatId(ws), name: "x", ...opts });
      expect(res.ok).toBe(true);
      expect(calls[calls.length - 3]!.params.get("name")).toBe(expectName);
    };
    await create({ name: "~/projects/pigeon", sessionId: "gse_0123456789ab" }, "pigeon-01234567");
    // The LAST " · " whose remainder is a path separates the title; earlier ones belong to it.
    await create({ name: "A · B · ~/x/y", sessionId: "ses_ffffffffff" }, "a-b-ffffffff");
    // A trailing " · foo" that is not a path is part of the title.
    await create({ name: "Title · notapath", sessionId: "ses_00000000aa" }, "title-notapath-00000000");
    await create({ name: "Weekly Digest!" }, "weekly-digest");
    await create({ name: "日本語", sessionId: "ses_12345678zz" }, "session-12345678");
    await create({ name: "日本語" }, "session");
  });

  it("names a named channel after its key, with the caller's topic line", async () => {
    const ws = mkWs();
    slack("conversations.create", { ok: true, channel: { id: "CKEY", name: "stall-watch-digest" } });
    slack("conversations.invite", { ok: true });
    slack("conversations.setTopic", { ok: true });
    const res = await transport(ws).createForumTopic({
      chatId: slackChatId(ws),
      name: "Stall watch digest",
      channelKey: "stall-watch:Digest",
      topic: "Daily stall-watch digest",
    });
    expect(res.ok).toBe(true);
    expect(calls[0]!.params.get("name")).toBe("stall-watch-digest");
    expect(calls[2]!.params.get("topic")).toBe("Daily stall-watch digest");
  });

  it("keeps the channel name within 80 characters, sid suffix and collision suffix included", async () => {
    const ws = mkWs();
    const long = `${"word ".repeat(40)}· ~/p`;
    slack("conversations.create", { ok: false, error: "name_taken" });
    slack("conversations.create", (p) => ({ ok: true, channel: { id: "CLONG", name: p.get("name") } }));
    slack("conversations.invite", { ok: true });
    slack("conversations.setTopic", { ok: true });
    const res = await transport(ws).createForumTopic({ chatId: slackChatId(ws), name: long, sessionId: "ses_abcdef12xyz" });
    expect(res.ok).toBe(true);
    const first = calls[0]!.params.get("name")!;
    const second = calls[1]!.params.get("name")!;
    expect(first.length).toBeLessThanOrEqual(80);
    expect(second.length).toBeLessThanOrEqual(80);
    expect(first.endsWith("-abcdef12")).toBe(true);
    expect(second).toBe(`${first}-2`);
  });

  it("truncates the topic line to 250 code points, keeping the session id", async () => {
    const ws = mkWs();
    slack("conversations.create", { ok: true, channel: { id: "CTOP", name: "x" } });
    slack("conversations.invite", { ok: true });
    slack("conversations.setTopic", { ok: true });
    await transport(ws).createForumTopic({ chatId: slackChatId(ws), name: "😀".repeat(400), sessionId: "ses_abcdef12xyz" });
    const topic = calls[2]!.params.get("topic")!;
    expect([...topic].length).toBeLessThanOrEqual(250);
    expect(topic.endsWith(" · 🆔 ses_abcdef12xyz")).toBe(true);
  });

  it("retries name_taken as -2, -3, … and gives up with create_failed after -9", async () => {
    const ws = mkWs();
    slack("conversations.create", { ok: false, error: "name_taken" });
    slack("conversations.create", { ok: false, error: "name_taken" });
    slack("conversations.create", (p) => ({ ok: true, channel: { id: "C3", name: p.get("name") } }));
    slack("conversations.invite", { ok: true });
    slack("conversations.setTopic", { ok: true });
    const res = await transport(ws).createForumTopic({ chatId: slackChatId(ws), name: "dup" });
    expect(res.ok).toBe(true);
    expect(calls.slice(0, 3).map((c) => c.params.get("name"))).toEqual(["dup", "dup-2", "dup-3"]);
    if (res.ok) expect(res.result.name).toBe("dup-3");

    calls.length = 0;
    for (let i = 0; i < 9; i++) slack("conversations.create", { ok: false, error: "name_taken" });
    const failed = await transport(ws).createForumTopic({ chatId: slackChatId(ws), name: "dup" });
    expect(failed.ok).toBe(false);
    if (!failed.ok && failed.kind === "error") {
      expect(failed.errorCode).toBe(400);
      expect(failed.description).toContain("create_failed");
      expect((failed.response as { errorClass: string }).errorClass).toBe("rejected_format");
    } else {
      throw new Error("expected create_failed");
    }
    expect(calls.map((c) => c.params.get("name"))).toEqual(
      ["dup", ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `dup-${n}`)],
    );
  });

  it("treats already_in_channel as fine and an invite or setTopic failure as a warning only", async () => {
    const ws = mkWs();
    slack("conversations.create", { ok: true, channel: { id: "CW1", name: "a" } });
    slack("conversations.invite", { ok: false, error: "already_in_channel" });
    slack("conversations.setTopic", { ok: true });
    expect((await transport(ws).createForumTopic({ chatId: slackChatId(ws), name: "a" })).ok).toBe(true);

    slack("conversations.create", { ok: true, channel: { id: "CW2", name: "b" } });
    slack("conversations.invite", { ok: false, error: "user_not_found" });
    slack("conversations.setTopic", { ok: false, error: "restricted_action" });
    const res = await transport(ws).createForumTopic({ chatId: slackChatId(ws), name: "b" });
    expect(res.ok).toBe(true);
    // The mapping is durable even though the cosmetic steps failed.
    if (res.ok) {
      const row = await env.DB.prepare("SELECT channel_id FROM slack_conversations WHERE handle = ?")
        .bind(res.result.message_thread_id)
        .first<{ channel_id: string }>();
      expect(row?.channel_id).toBe("CW2");
    }
  });

  it("maps a conversations.create 429 to a transient 503, never an outbox-wide rate limit", async () => {
    const ws = mkWs();
    slack("conversations.create", { ok: false, error: "ratelimited" }, 429, { "retry-after": "30" });
    const res = await transport(ws).createForumTopic({ chatId: slackChatId(ws), name: "a" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("error");
      if (res.kind === "error") expect(res.errorCode).toBe(503);
    }
  });
});

// ─── sendMessage / sendRichMessage ─────────────────────────────────────────

describe("sendMessage", () => {
  it("posts blocks and a fallback text with unfurling off, top-level, and returns the post handle", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CS1");
    slack("chat.postMessage", posted);
    const res = await transport(ws).sendMessage({
      chatId: slackChatId(ws),
      messageThreadId: handle,
      text: "Hello <world> & co",
      entities: [{ type: "bold", offset: 0, length: 5 }],
      replyMarkup: { inline_keyboard: [[{ text: "Yes", callback_data: "cmd:T:v1:q0:0" }]] },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.message_id).toBeGreaterThanOrEqual(SLACK_HANDLE_MIN);

    const c = calls[0]!;
    expect(c.auth).toBe("Bearer xoxb-bot");
    expect(c.params.get("channel")).toBe("CS1");
    expect(c.params.get("text")).toBe("Hello &lt;world&gt; &amp; co");
    expect(c.params.get("unfurl_links")).toBe("false");
    expect(c.params.get("unfurl_media")).toBe("false");
    expect(c.params.has("thread_ts")).toBe(false);
    const blocks = json(c, "blocks") as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["rich_text", "actions"]);

    const post = await env.DB.prepare("SELECT channel_id, ts, text FROM slack_posts WHERE handle = ? AND team_id = ?")
      .bind(res.result.message_id, ws.teamId)
      .first<{ channel_id: string; ts: string; text: string }>();
    expect(post).toEqual({ channel_id: "CS1", ts: posted.ts, text: "Hello <world> & co" });
  });

  it("records at most 500 code points of the text", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CS2");
    slack("chat.postMessage", posted);
    const res = await transport(ws).sendMessage({ chatId: slackChatId(ws), messageThreadId: handle, text: "😀".repeat(600) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const post = await env.DB.prepare("SELECT text FROM slack_posts WHERE handle = ?")
      .bind(res.result.message_id)
      .first<{ text: string }>();
    expect([...post!.text].length).toBe(500);
  });

  it("with every category on: mentions when flagged, in a named channel and in #alerts, never in an unflagged session channel", async () => {
    const ws = mkWs();
    const session = await seedChannel(ws, "CPLAIN");
    const named = await seedChannel(ws, "CNAMED");
    await seedNamed(ws, "digest", named);
    const alerts = await seedChannel(ws, "CALERTS");
    await seedNamed(ws, "_alerts", alerts);
    const t = transport(ws, "questions,errors,named,alerts");
    const chatId = slackChatId(ws);

    const send = async (opts: { messageThreadId?: number; notifyOwner?: boolean }, expected: string) => {
      slack("chat.postMessage", { ok: true, ts: uniq("1.") });
      const res = await t.sendMessage({ chatId, text: "ping", ...opts });
      expect(res.ok).toBe(true);
      const c = calls[calls.length - 1]!;
      expect(c.params.get("channel")).toBe(expected);
      return c.params.get("text")!;
    };

    expect(await send({ messageThreadId: session }, "CPLAIN")).toBe("ping");
    expect(await send({ messageThreadId: session, notifyOwner: false }, "CPLAIN")).toBe("ping");
    expect(await send({ messageThreadId: session, notifyOwner: true }, "CPLAIN")).toBe("<@U0OWNER> ping");
    expect(await send({ messageThreadId: named }, "CNAMED")).toBe("<@U0OWNER> ping");
    expect(await send({}, "CALERTS")).toBe("<@U0OWNER> ping");
    const blocks = json(calls[calls.length - 1], "blocks") as Array<{ elements: Array<{ elements: Array<{ type: string }> }> }>;
    expect(blocks[0]!.elements[0]!.elements[0]!.type).toBe("user");
  });

  it("joins and retries once on not_in_channel", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CJOIN");
    slack("chat.postMessage", { ok: false, error: "not_in_channel" });
    slack("conversations.join", { ok: true });
    slack("chat.postMessage", posted);
    const res = await transport(ws).sendMessage({ chatId: slackChatId(ws), messageThreadId: handle, text: "hi" });
    expect(res.ok).toBe(true);
    expect(methods()).toEqual(["chat.postMessage", "conversations.join", "chat.postMessage"]);
    expect(calls[1]!.params.get("channel")).toBe("CJOIN");
    expect(calls[1]!.auth).toBe("Bearer xoxb-bot");
  });

  it("retries only once: a second not_in_channel is returned as it is", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CJOIN2");
    slack("chat.postMessage", { ok: false, error: "not_in_channel" });
    slack("conversations.join", { ok: true });
    slack("chat.postMessage", { ok: false, error: "not_in_channel" });
    const res = await transport(ws).sendMessage({ chatId: slackChatId(ws), messageThreadId: handle, text: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("error");
  });

  it("unarchives with the user token, joins, then retries once on is_archived", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CARCH");
    slack("chat.postMessage", { ok: false, error: "is_archived" });
    slack("conversations.unarchive", { ok: true });
    slack("conversations.join", { ok: true });
    slack("chat.postMessage", posted);
    const res = await transport(ws).sendMessage({ chatId: slackChatId(ws), messageThreadId: handle, text: "hi" });
    expect(res.ok).toBe(true);
    expect(methods()).toEqual(["chat.postMessage", "conversations.unarchive", "conversations.join", "chat.postMessage"]);
    expect(calls[1]!.auth).toBe("Bearer xoxp-user");
    expect(calls[2]!.auth).toBe("Bearer xoxb-bot");
  });

  it("returns the unarchive's own mapped error when it fails, a 429 there being a transient 503", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CARCH2");
    slack("chat.postMessage", { ok: false, error: "is_archived" });
    slack("conversations.unarchive", { ok: false, error: "ratelimited" }, 429, { "retry-after": "9" });
    const res = await transport(ws).sendMessage({ chatId: slackChatId(ws), messageThreadId: handle, text: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok && res.kind === "error") expect(res.errorCode).toBe(503);
    else throw new Error("expected a transient 503");
  });

  it("passes a conversation that is truly gone through as thread_not_found", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CGONE");
    slack("chat.postMessage", { ok: false, error: "channel_not_found" });
    const res = await transport(ws).sendMessage({ chatId: slackChatId(ws), messageThreadId: handle, text: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("thread_not_found");
  });

  it("sendRichMessage posts a markdown block and records the markdown", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CRICH");
    slack("chat.postMessage", posted);
    const res = await transport(ws).sendRichMessage({
      chatId: slackChatId(ws),
      messageThreadId: handle,
      markdown: "| a | b |\n|---|---|\n| 1 | 2 |",
    });
    expect(res.ok).toBe(true);
    const blocks = json(calls[0], "blocks") as Array<{ type: string; text?: string }>;
    expect(blocks[0]).toEqual({ type: "markdown", text: "| a | b |\n|---|---|\n| 1 | 2 |" });
    expect(calls[0]!.params.get("unfurl_links")).toBe("false");
  });
});

// ─── #alerts ───────────────────────────────────────────────────────────────

describe("#alerts", () => {
  const alertsRow = (ws: SlackWorkspace) =>
    env.DB.prepare(
      `SELECT t.name AS name, c.channel_id AS channel_id FROM named_topics t
       JOIN slack_conversations c ON c.handle = t.message_thread_id
       WHERE t.chat_id = ? AND t.topic_key = '_alerts'`,
    )
      .bind(slackChatId(ws))
      .first<{ name: string; channel_id: string }>();

  it("posts an unthreaded send into the stored alerts channel without any discovery call", async () => {
    const ws = mkWs();
    await seedNamed(ws, "_alerts", await seedChannel(ws, "CAL1"));
    slack("chat.postMessage", posted);
    const res = await transport(ws).sendMessage({ chatId: slackChatId(ws), text: "boom" });
    expect(res.ok).toBe(true);
    expect(methods()).toEqual(["chat.postMessage"]);
    expect(calls[0]!.params.get("channel")).toBe("CAL1");
  });

  it("finds an existing #alerts by listing (across pages), joins it and remembers it", async () => {
    const ws = mkWs();
    const t = transport(ws);
    slack("conversations.list", { ok: true, channels: [{ id: "C0", name: "general" }], response_metadata: { next_cursor: "page2" } });
    slack("conversations.list", { ok: true, channels: [{ id: "CFOUND", name: "alerts" }], response_metadata: { next_cursor: "" } });
    slack("conversations.join", { ok: true });
    slack("chat.postMessage", posted);
    const res = await t.sendMessage({ chatId: slackChatId(ws), text: "boom" });
    expect(res.ok).toBe(true);
    expect(methods()).toEqual(["conversations.list", "conversations.list", "conversations.join", "chat.postMessage"]);
    expect(calls[0]!.params.get("types")).toBe("public_channel");
    expect(calls[0]!.params.get("exclude_archived")).toBe("false");
    expect(calls[0]!.params.get("limit")).toBe("200");
    expect(calls[1]!.params.get("cursor")).toBe("page2");
    expect(calls[2]!.params.get("channel")).toBe("CFOUND");
    expect(calls[3]!.params.get("channel")).toBe("CFOUND");
    expect(await alertsRow(ws)).toEqual({ name: "alerts", channel_id: "CFOUND" });

    // The next send needs no discovery.
    slack("chat.postMessage", { ok: true, ts: "2.2" });
    expect((await t.sendMessage({ chatId: slackChatId(ws), text: "again" })).ok).toBe(true);
    expect(methods().slice(4)).toEqual(["chat.postMessage"]);
  });

  it("creates #alerts and invites the owner when none exists", async () => {
    const ws = mkWs();
    slack("conversations.list", { ok: true, channels: [{ id: "C0", name: "general" }] });
    slack("conversations.create", { ok: true, channel: { id: "CMADE", name: "alerts" } });
    slack("conversations.invite", { ok: true });
    slack("chat.postMessage", posted);
    const res = await transport(ws).sendMessage({ chatId: slackChatId(ws), text: "boom" });
    expect(res.ok).toBe(true);
    expect(methods()).toEqual(["conversations.list", "conversations.create", "conversations.invite", "chat.postMessage"]);
    expect(calls[1]!.params.get("name")).toBe("alerts");
    expect(calls[2]!.params.get("users")).toBe("U0OWNER");
    expect(calls[3]!.params.get("channel")).toBe("CMADE");
    expect(await alertsRow(ws)).toEqual({ name: "alerts", channel_id: "CMADE" });
  });

  it("stops listing after five pages", async () => {
    const ws = mkWs();
    for (let i = 0; i < 5; i++) {
      slack("conversations.list", { ok: true, channels: [], response_metadata: { next_cursor: `p${i + 1}` } });
    }
    slack("conversations.create", { ok: true, channel: { id: "CP5", name: "alerts" } });
    slack("conversations.invite", { ok: true });
    slack("chat.postMessage", posted);
    expect((await transport(ws).sendMessage({ chatId: slackChatId(ws), text: "x" })).ok).toBe(true);
    expect(methods().filter((m) => m === "conversations.list")).toHaveLength(5);
  });

  it("returns a listing failure as the mapped error and creates nothing", async () => {
    const ws = mkWs();
    slack("conversations.list", { ok: false, error: "missing_scope" });
    const res = await transport(ws).sendMessage({ chatId: slackChatId(ws), text: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok && res.kind === "error") expect(res.errorCode).toBe(502);
    expect(await alertsRow(ws)).toBeNull();
  });

  it("drops the _alerts row on channel_not_found and re-resolves once", async () => {
    const ws = mkWs();
    await seedNamed(ws, "_alerts", await seedChannel(ws, "CDEAD"));
    slack("chat.postMessage", { ok: false, error: "channel_not_found" });
    slack("conversations.list", { ok: true, channels: [{ id: "CNEW", name: "alerts" }] });
    slack("conversations.join", { ok: true });
    slack("chat.postMessage", posted);
    const res = await transport(ws).sendMessage({ chatId: slackChatId(ws), text: "boom" });
    expect(res.ok).toBe(true);
    expect(methods()).toEqual(["chat.postMessage", "conversations.list", "conversations.join", "chat.postMessage"]);
    expect(calls[0]!.params.get("channel")).toBe("CDEAD");
    expect(calls[3]!.params.get("channel")).toBe("CNEW");
    expect(await alertsRow(ws)).toEqual({ name: "alerts", channel_id: "CNEW" });
  });

  it("re-resolves only once: a second channel_not_found is returned", async () => {
    const ws = mkWs();
    await seedNamed(ws, "_alerts", await seedChannel(ws, "CDEAD2"));
    slack("chat.postMessage", { ok: false, error: "channel_not_found" });
    slack("conversations.list", { ok: true, channels: [{ id: "CNEW2", name: "alerts" }] });
    slack("conversations.join", { ok: true });
    slack("chat.postMessage", { ok: false, error: "channel_not_found" });
    const res = await transport(ws).sendMessage({ chatId: slackChatId(ws), text: "boom" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("thread_not_found");
  });

  it("does not drop the _alerts row for a channel_not_found on an explicit handle", async () => {
    const ws = mkWs();
    const alerts = await seedChannel(ws, "CKEEP");
    await seedNamed(ws, "_alerts", alerts);
    const other = await seedChannel(ws, "CGONE2");
    slack("chat.postMessage", { ok: false, error: "channel_not_found" });
    const res = await transport(ws).sendMessage({ chatId: slackChatId(ws), messageThreadId: other, text: "x" });
    expect(res.ok).toBe(false);
    expect(await alertsRow(ws)).toEqual({ name: "_alerts", channel_id: "CKEEP" });
  });

  it("an unthreaded file goes to #alerts too", async () => {
    const ws = mkWs();
    await seedNamed(ws, "_alerts", await seedChannel(ws, "CALF"));
    slack("files.getUploadURLExternal", { ok: true, upload_url: "https://files.slack.com/upload/v1/ALF", file_id: "FALF" });
    fetchMock.get("https://files.slack.com").intercept({ method: "POST", path: "/upload/v1/ALF" }).reply(200, "OK - 1");
    slack("files.completeUploadExternal", { ok: true, files: [{ id: "FALF" }] });
    const res = await transport(ws).sendPhoto({ chatId: slackChatId(ws), photo: new Blob(["a"]), filename: "p.png" });
    expect(res.ok).toBe(true);
    expect(calls[1]!.params.get("channel_id")).toBe("CALF");
  });
});

// ─── editMessageText ───────────────────────────────────────────────────────

describe("editMessageText", () => {
  it("updates the recorded post in place", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CED");
    const t = transport(ws);
    slack("chat.postMessage", { ok: true, ts: "9.1" });
    const sent = await t.sendMessage({ chatId: slackChatId(ws), messageThreadId: handle, text: "Q?" });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    slack("chat.update", { ok: true });
    const res = await t.editMessageText({
      chatId: slackChatId(ws),
      messageId: sent.result.message_id,
      text: "Q? (answered)",
      entities: [{ type: "italic", offset: 0, length: 2 }],
      replyMarkup: { inline_keyboard: [] },
    });
    expect(res.ok).toBe(true);
    const c = calls[1]!;
    expect(c.method).toBe("chat.update");
    expect(c.params.get("channel")).toBe("CED");
    expect(c.params.get("ts")).toBe("9.1");
    expect(c.params.get("text")).toBe("Q? (answered)");
    expect((json(c, "blocks") as unknown[]).length).toBe(1);
    const post = await env.DB.prepare("SELECT text FROM slack_posts WHERE handle = ?")
      .bind(sent.result.message_id)
      .first<{ text: string }>();
    expect(post?.text).toBe("Q? (answered)");
  });

  it("answers thread_not_found for an unknown post and refuses to edit a file post", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CED2");
    await env.DB.prepare("INSERT INTO slack_posts (team_id, channel_id, ts, text, created_at) VALUES (?, ?, ?, NULL, 0)")
      .bind(ws.teamId, "CED2", "file:F9")
      .run();
    const filePost = await env.DB.prepare("SELECT handle FROM slack_posts WHERE team_id = ? AND ts = 'file:F9'")
      .bind(ws.teamId)
      .first<{ handle: number }>();
    const t = transport(ws);
    const missing = await t.editMessageText({ chatId: slackChatId(ws), messageId: 777, text: "x" });
    expect(!missing.ok && missing.kind).toBe("thread_not_found");
    const file = await t.editMessageText({ chatId: slackChatId(ws), messageId: filePost!.handle, text: "x" });
    expect(!file.ok && file.kind).toBe("error");
    expect(handle).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  it("keeps the owner mention on an edit in a named channel when `named` is enabled, and drops it otherwise", async () => {
    const ws = mkWs();
    const named = await seedChannel(ws, "CEDN");
    await seedNamed(ws, "wiz", named);
    const off = transport(ws);
    slack("chat.postMessage", { ok: true, ts: "8.0" });
    const sentOff = await off.sendMessage({ chatId: slackChatId(ws), messageThreadId: named, text: "Q?" });
    if (!sentOff.ok) throw new Error("send failed");
    slack("chat.update", { ok: true });
    await off.editMessageText({ chatId: slackChatId(ws), messageId: sentOff.result.message_id, text: "Q2" });
    expect(calls[1]!.params.get("text")).toBe("Q2");
    calls.length = 0;
    const t = transport(ws, "named");
    slack("chat.postMessage", { ok: true, ts: "8.1" });
    const sent = await t.sendMessage({ chatId: slackChatId(ws), messageThreadId: named, text: "Q?" });
    if (!sent.ok) throw new Error("send failed");
    slack("chat.update", { ok: true });
    await t.editMessageText({ chatId: slackChatId(ws), messageId: sent.result.message_id, text: "Q2" });
    expect(calls[1]!.params.get("text")).toBe("<@U0OWNER> Q2");
  });
});

// ─── files ─────────────────────────────────────────────────────────────────

describe("sendDocument / sendPhoto", () => {
  it("runs the files v2 flow, threading under the replied-to post, and records a file: post", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CFILE");
    const t = transport(ws);
    slack("chat.postMessage", { ok: true, ts: "5.5" });
    const sent = await t.sendMessage({ chatId: slackChatId(ws), messageThreadId: handle, text: "see file" });
    if (!sent.ok) throw new Error("send failed");

    let uploaded: unknown;
    slack("files.getUploadURLExternal", { ok: true, upload_url: "https://files.slack.com/upload/v1/ABC", file_id: "F1" });
    fetchMock
      .get("https://files.slack.com")
      .intercept({ method: "POST", path: "/upload/v1/ABC" })
      .reply(200, (opts: { body?: unknown }) => {
        uploaded = opts.body;
        return "OK - 5";
      });
    slack("files.completeUploadExternal", { ok: true, files: [{ id: "F1" }] });

    const res = await t.sendDocument({
      chatId: slackChatId(ws),
      messageThreadId: handle,
      document: new Blob(["hello"]),
      filename: "notes.txt",
      replyToMessageId: sent.result.message_id,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(uploaded).toBeDefined();

    expect(calls[1]!.method).toBe("files.getUploadURLExternal");
    expect(calls[1]!.params.get("filename")).toBe("notes.txt");
    expect(calls[1]!.params.get("length")).toBe("5");
    const complete = calls[2]!;
    expect(complete.params.get("channel_id")).toBe("CFILE");
    expect(complete.params.get("thread_ts")).toBe("5.5");
    expect(json(complete, "files")).toEqual([{ id: "F1", title: "notes.txt" }]);

    const post = await env.DB.prepare("SELECT channel_id, ts FROM slack_posts WHERE handle = ? AND team_id = ?")
      .bind(res.result.message_id, ws.teamId)
      .first<{ channel_id: string; ts: string }>();
    expect(post).toEqual({ channel_id: "CFILE", ts: "file:F1" });
  });

  it("sends no thread_ts without a replyToMessageId, or when the replied-to post is unknown", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CFILE2");
    const t = transport(ws);
    for (const reply of [undefined, 99999999]) {
      calls.length = 0;
      slack("files.getUploadURLExternal", { ok: true, upload_url: "https://files.slack.com/upload/v1/XYZ", file_id: uniq("F") });
      fetchMock.get("https://files.slack.com").intercept({ method: "POST", path: "/upload/v1/XYZ" }).reply(200, "OK - 1");
      slack("files.completeUploadExternal", { ok: true, files: [] });
      const res = await t.sendPhoto({
        chatId: slackChatId(ws),
        messageThreadId: handle,
        photo: new Blob(["x"]),
        filename: "p.png",
        ...(reply !== undefined ? { replyToMessageId: reply } : {}),
      });
      expect(res.ok).toBe(true);
      expect(calls[1]!.params.has("thread_ts")).toBe(false);
    }
  });

  it("joins and retries the completion on not_in_channel, and surfaces an upload failure", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CFILE3");
    const t = transport(ws);
    slack("files.getUploadURLExternal", { ok: true, upload_url: "https://files.slack.com/upload/v1/J", file_id: "FJ" });
    fetchMock.get("https://files.slack.com").intercept({ method: "POST", path: "/upload/v1/J" }).reply(200, "OK - 1");
    slack("files.completeUploadExternal", { ok: false, error: "not_in_channel" });
    slack("conversations.join", { ok: true });
    slack("files.completeUploadExternal", { ok: true, files: [{ id: "FJ" }] });
    expect(
      (await t.sendDocument({ chatId: slackChatId(ws), messageThreadId: handle, document: new Blob(["x"]), filename: "a" })).ok,
    ).toBe(true);

    slack("files.getUploadURLExternal", { ok: true, upload_url: "https://files.slack.com/upload/v1/K", file_id: "FK" });
    fetchMock.get("https://files.slack.com").intercept({ method: "POST", path: "/upload/v1/K" }).reply(500, "boom");
    const failed = await t.sendDocument({ chatId: slackChatId(ws), messageThreadId: handle, document: new Blob(["x"]), filename: "a" });
    expect(failed.ok).toBe(false);
    if (!failed.ok && failed.kind === "error") expect(failed.errorCode).toBe(502);
  });
});

// ─── editForumTopic ────────────────────────────────────────────────────────

describe("editForumTopic", () => {
  const NAME = "New title · ~/projects/pigeon";
  const SID = "ses_abcdef1234";

  it("renames and re-topics when both differ", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CEF1");
    slack("conversations.info", { ok: true, channel: { name: "old-title-abcdef12", topic: { value: "Old" } } });
    slack("conversations.rename", { ok: true });
    slack("conversations.setTopic", { ok: true });
    const res = await transport(ws).editForumTopic({
      chatId: slackChatId(ws),
      messageThreadId: handle,
      name: NAME,
      sessionId: SID,
    });
    expect(res.ok).toBe(true);
    expect(methods()).toEqual(["conversations.info", "conversations.rename", "conversations.setTopic"]);
    expect(calls[0]!.params.get("channel")).toBe("CEF1");
    expect(calls[1]!.params.get("name")).toBe("new-title-abcdef12");
    expect(calls[2]!.params.get("topic")).toBe(`${NAME} · 🆔 ${SID}`);
  });

  it("skips rename when the name is unchanged and setTopic when the topic is unchanged", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CEF2");
    slack("conversations.info", { ok: true, channel: { name: "new-title-abcdef12", topic: { value: `${NAME} · 🆔 ${SID}` } } });
    const res = await transport(ws).editForumTopic({ chatId: slackChatId(ws), messageThreadId: handle, name: NAME, sessionId: SID });
    expect(res.ok).toBe(true);
    expect(methods()).toEqual(["conversations.info"]);
  });

  it("treats a channel that already carries a collision suffix as unchanged, and only re-topics", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CEF3");
    slack("conversations.info", { ok: true, channel: { name: "new-title-abcdef12-3", topic: { value: "stale" } } });
    slack("conversations.setTopic", { ok: true });
    const res = await transport(ws).editForumTopic({ chatId: slackChatId(ws), messageThreadId: handle, name: NAME, sessionId: SID });
    expect(res.ok).toBe(true);
    expect(methods()).toEqual(["conversations.info", "conversations.setTopic"]);
  });

  it("retries rename on name_taken with a suffix", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CEF4");
    slack("conversations.info", { ok: true, channel: { name: "other", topic: { value: "" } } });
    slack("conversations.rename", { ok: false, error: "name_taken" });
    slack("conversations.rename", { ok: true });
    slack("conversations.setTopic", { ok: true });
    const res = await transport(ws).editForumTopic({ chatId: slackChatId(ws), messageThreadId: handle, name: NAME, sessionId: SID });
    expect(res.ok).toBe(true);
    expect(calls.filter((c) => c.method === "conversations.rename").map((c) => c.params.get("name"))).toEqual([
      "new-title-abcdef12",
      "new-title-abcdef12-2",
    ]);
  });

  it("uses an explicit topic instead of deriving one, and makes no call with nothing to change", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CEF5");
    slack("conversations.info", { ok: true, channel: { name: "x", topic: { value: "" } } });
    slack("conversations.setTopic", { ok: true });
    expect(
      (await transport(ws).editForumTopic({ chatId: slackChatId(ws), messageThreadId: handle, topic: "Just this" })).ok,
    ).toBe(true);
    expect(calls[1]!.params.get("topic")).toBe("Just this");
    expect(methods()).not.toContain("conversations.rename");

    calls.length = 0;
    expect((await transport(ws).editForumTopic({ chatId: slackChatId(ws), messageThreadId: handle })).ok).toBe(true);
    expect(calls).toEqual([]);
  });
});

// ─── close / reopen / delete / unpin ───────────────────────────────────────

describe("conversation lifecycle", () => {
  it("close archives, and already_archived is success", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CLC1");
    const t = transport(ws);
    slack("conversations.archive", { ok: true });
    expect((await t.closeForumTopic({ chatId: slackChatId(ws), messageThreadId: handle })).ok).toBe(true);
    expect(calls[0]!.params.get("channel")).toBe("CLC1");
    expect(calls[0]!.auth).toBe("Bearer xoxb-bot");
    slack("conversations.archive", { ok: false, error: "already_archived" });
    expect((await t.closeForumTopic({ chatId: slackChatId(ws), messageThreadId: handle })).ok).toBe(true);
  });

  it("delete archives too (bots cannot delete)", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CLC2");
    slack("conversations.archive", { ok: true });
    expect((await transport(ws).deleteForumTopic({ chatId: slackChatId(ws), messageThreadId: handle })).ok).toBe(true);
    expect(methods()).toEqual(["conversations.archive"]);
  });

  it("reopen unarchives with the user token, and not_archived is topic_not_modified", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CLC3");
    const t = transport(ws);
    slack("conversations.unarchive", { ok: true });
    expect((await t.reopenForumTopic({ chatId: slackChatId(ws), messageThreadId: handle })).ok).toBe(true);
    expect(calls[0]!.auth).toBe("Bearer xoxp-user");
    slack("conversations.unarchive", { ok: false, error: "not_archived" });
    const res = await t.reopenForumTopic({ chatId: slackChatId(ws), messageThreadId: handle });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("topic_not_modified");
  });

  it("unpinAllForumTopicMessages is a successful no-op", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CLC4");
    const res = await transport(ws).unpinAllForumTopicMessages({ chatId: slackChatId(ws), messageThreadId: handle });
    expect(res).toEqual({ ok: true, result: true });
    expect(calls).toEqual([]);
  });
});

// ─── signal ────────────────────────────────────────────────────────────────

describe("signal", () => {
  it("reaches every Slack sub-call of one operation (alerts discovery + post, and a file upload)", async () => {
    const ws = mkWs();
    const ac = new AbortController();
    const seen: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
    const answers: Record<string, unknown> = {
      "conversations.list": { ok: true, channels: [] },
      "conversations.create": { ok: true, channel: { id: "CSIG", name: "alerts" } },
      "conversations.invite": { ok: true },
      "chat.postMessage": { ok: true, ts: "3.3" },
      "files.getUploadURLExternal": { ok: true, upload_url: "https://files.slack.com/upload/v1/S", file_id: "FS" },
      "files.completeUploadExternal": { ok: true, files: [] },
    };
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, signal: init?.signal });
      if (url.startsWith("https://files.slack.com")) return new Response("OK - 1");
      const method = url.replace("https://slack.com/api/", "");
      return new Response(JSON.stringify(answers[method] ?? { ok: false, error: "unexpected" }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const t = createSlackTransport({ db: env.DB, ws, fetchFn });

    const sent = await t.sendMessage({ chatId: slackChatId(ws), text: "x", signal: ac.signal });
    expect(sent.ok).toBe(true);
    expect(seen.map((s) => s.url.replace("https://slack.com/api/", ""))).toEqual([
      "conversations.list",
      "conversations.create",
      "conversations.invite",
      "chat.postMessage",
    ]);
    for (const s of seen) expect(s.signal).toBe(ac.signal);
  });
});

// ─── transportForChat ──────────────────────────────────────────────────────

describe("transportForChat routing", () => {
  const secretKey = (team: string) => `SLACK_WORKSPACE_ROUTE_${team}`;
  const envWith = (ws: SlackWorkspace): Env =>
    ({ ...env, [secretKey(ws.teamId)]: JSON.stringify(ws) }) as unknown as Env;

  it("sends a slack address with a configured team and a slack context through Slack", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CRT1");
    slack("chat.postMessage", posted);
    const t = transportForChat(slackChatId(ws), "tg-token", undefined, { env: envWith(ws), db: env.DB });
    const res = await t.sendMessage({ chatId: slackChatId(ws), messageThreadId: handle, text: "hi" });
    expect(res.ok).toBe(true);
    expect(calls[0]!.params.get("channel")).toBe("CRT1");
  });

  it("uses an injected fetch for the slack context", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CRT2");
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(posted), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const t = transportForChat(slackChatId(ws), "tg", undefined, { env: envWith(ws), db: env.DB, fetchFn });
    expect((await t.sendMessage({ chatId: slackChatId(ws), messageThreadId: handle, text: "hi" })).ok).toBe(true);
    expect(urls).toEqual(["https://slack.com/api/chat.postMessage"]);
  });

  it("keeps the guard for a slack address with no context, or whose team has no workspace", async () => {
    const ws = mkWs();
    const stranger = mkWs();
    const cases = [
      transportForChat(slackChatId(ws), "tg"),
      transportForChat(slackChatId(ws), "tg", undefined, { env: envWith(stranger), db: env.DB }),
      transportForChat(slackChatId(ws), "tg", undefined, { env: env as unknown as Env, db: env.DB }),
      transportForChat("slack:", "tg", undefined, { env: envWith(ws), db: env.DB }),
    ];
    for (const t of cases) {
      const res = await t.sendMessage({ chatId: slackChatId(ws), text: "x" });
      expect(res.ok).toBe(false);
      if (!res.ok && res.kind === "error") {
        expect(res.errorCode).toBeUndefined();
        expect(res.description).toMatch(/slack transport not available/);
      } else {
        throw new Error("expected the SLACK_UNAVAILABLE guard");
      }
    }
    expect(calls).toEqual([]);
  });

  it("leaves numeric addresses on Telegram, ignoring a slack context, and honours an injected fake", async () => {
    const ws = mkWs();
    let path = "";
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bottok-route\/sendMessage/ })
      .reply(200, (opts: { path: string }) => {
        path = opts.path;
        return { ok: true, result: { message_id: 4 } };
      });
    const t = transportForChat("8248645256", "tok-route", undefined, { env: envWith(ws), db: env.DB });
    expect((await t.sendMessage({ chatId: "8248645256", text: "hi" })).ok).toBe(true);
    expect(path).toContain("/bottok-route/sendMessage");

    const marker = { ok: true, result: { message_id: 1 } } as const;
    const fake = { sendMessage: async () => marker } as unknown as ChatTransport;
    expect(transportForChat("8248645256", "tok", fake, { env: envWith(ws), db: env.DB })).toBe(fake);
  });
});

// ─── review fixes ──────────────────────────────────────────────────────────

describe("editForumTopic without enough to compute the channel name", () => {
  it("never renames without a sessionId or channelKey, and keeps the id on the topic line", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CRV1");
    slack("conversations.info", {
      ok: true,
      channel: { name: "old-title-abcdef12", topic: { value: "Old title · ~/p · 🆔 ses_abcdef1234" } },
    });
    slack("conversations.setTopic", { ok: true });
    const res = await transport(ws).editForumTopic({
      chatId: slackChatId(ws),
      messageThreadId: handle,
      name: "New title · ~/p",
    });
    expect(res.ok).toBe(true);
    expect(methods()).toEqual(["conversations.info", "conversations.setTopic"]);
    expect(calls[1]!.params.get("topic")).toBe("New title · ~/p · 🆔 ses_abcdef1234");
  });

  it("does not touch the topic when only the unchanged name was sent", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CRV2");
    slack("conversations.info", { ok: true, channel: { name: "x-abcdef12", topic: { value: "Same · 🆔 ses_abcdef1234" } } });
    const res = await transport(ws).editForumTopic({ chatId: slackChatId(ws), messageThreadId: handle, name: "Same" });
    expect(res.ok).toBe(true);
    expect(methods()).toEqual(["conversations.info"]);
  });

  it("a channelKey fixes the name, so a named channel is renamed to its key when it differs, and left alone when it matches", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CRV3");
    slack("conversations.info", { ok: true, channel: { name: "wrong", topic: { value: "Digest" } } });
    slack("conversations.rename", { ok: true });
    const t = transport(ws);
    const res = await t.editForumTopic({
      chatId: slackChatId(ws),
      messageThreadId: handle,
      name: "Digest",
      channelKey: "stall-watch:Digest",
    });
    expect(res.ok).toBe(true);
    expect(methods()).toEqual(["conversations.info", "conversations.rename"]);
    expect(calls[1]!.params.get("name")).toBe("stall-watch-digest");

    calls.length = 0;
    slack("conversations.info", { ok: true, channel: { name: "stall-watch-digest", topic: { value: "Digest" } } });
    expect(
      (await t.editForumTopic({ chatId: slackChatId(ws), messageThreadId: handle, name: "Digest", channelKey: "stall-watch:Digest" })).ok,
    ).toBe(true);
    expect(methods()).toEqual(["conversations.info"]);
  });

  it("does not unarchive a closed channel to edit its metadata", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CRV4");
    slack("conversations.info", { ok: false, error: "is_archived" });
    const res = await transport(ws).editForumTopic({
      chatId: slackChatId(ws),
      messageThreadId: handle,
      name: "n",
      sessionId: "ses_abcdef1234",
    });
    expect(!res.ok && res.kind).toBe("thread_not_found");
    expect(methods()).toEqual(["conversations.info"]);
  });
});

describe("#alerts discovery, review fixes", () => {
  it("re-runs discovery after name_taken and adopts the channel it finds", async () => {
    const ws = mkWs();
    slack("conversations.list", { ok: true, channels: [] });
    slack("conversations.create", { ok: false, error: "name_taken" });
    slack("conversations.list", { ok: true, channels: [{ id: "CRACE", name: "alerts", is_archived: false }] });
    slack("conversations.join", { ok: true });
    slack("chat.postMessage", posted);
    const res = await transport(ws).sendMessage({ chatId: slackChatId(ws), text: "boom" });
    expect(res.ok).toBe(true);
    expect(methods()).toEqual([
      "conversations.list",
      "conversations.create",
      "conversations.list",
      "conversations.join",
      "chat.postMessage",
    ]);
    expect(calls[3]!.params.get("channel")).toBe("CRACE");
    expect(calls[4]!.params.get("channel")).toBe("CRACE");
  });

  it("returns the name_taken error when even a second discovery finds nothing", async () => {
    const ws = mkWs();
    slack("conversations.list", { ok: true, channels: [] });
    slack("conversations.create", { ok: false, error: "name_taken" });
    slack("conversations.list", { ok: true, channels: [] });
    const res = await transport(ws).sendMessage({ chatId: slackChatId(ws), text: "boom" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect((res.response as { error: string }).error).toBe("name_taken");
  });

  it("finds an ARCHIVED #alerts, unarchives it with the user token, then joins", async () => {
    const ws = mkWs();
    slack("conversations.list", { ok: true, channels: [{ id: "CARCHALERT", name: "alerts", is_archived: true }] });
    slack("conversations.unarchive", { ok: true });
    slack("conversations.join", { ok: true });
    slack("chat.postMessage", posted);
    const res = await transport(ws).sendMessage({ chatId: slackChatId(ws), text: "boom" });
    expect(res.ok).toBe(true);
    expect(methods()).toEqual(["conversations.list", "conversations.unarchive", "conversations.join", "chat.postMessage"]);
    expect(calls[0]!.params.get("exclude_archived")).toBe("false");
    expect(calls[1]!.auth).toBe("Bearer xoxp-user");
    expect(calls[1]!.params.get("channel")).toBe("CARCHALERT");
    expect(calls[2]!.auth).toBe("Bearer xoxb-bot");
  });

  it("does not unarchive an alerts channel that is not archived", async () => {
    const ws = mkWs();
    slack("conversations.list", { ok: true, channels: [{ id: "CLIVE", name: "alerts", is_archived: false }] });
    slack("conversations.join", { ok: true });
    slack("chat.postMessage", posted);
    expect((await transport(ws).sendMessage({ chatId: slackChatId(ws), text: "x" })).ok).toBe(true);
    expect(methods()).not.toContain("conversations.unarchive");
  });
});

describe("not_in_channel recovery beyond posts", () => {
  it("joins and retries archive, info, rename and setTopic once", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CNIC");
    const t = transport(ws);

    slack("conversations.archive", { ok: false, error: "not_in_channel" });
    slack("conversations.join", { ok: true });
    slack("conversations.archive", { ok: true });
    expect((await t.closeForumTopic({ chatId: slackChatId(ws), messageThreadId: handle })).ok).toBe(true);
    expect(methods()).toEqual(["conversations.archive", "conversations.join", "conversations.archive"]);

    calls.length = 0;
    slack("conversations.info", { ok: false, error: "not_in_channel" });
    slack("conversations.join", { ok: true });
    slack("conversations.info", { ok: true, channel: { name: "old", topic: { value: "" } } });
    slack("conversations.rename", { ok: false, error: "not_in_channel" });
    slack("conversations.join", { ok: true });
    slack("conversations.rename", { ok: true });
    slack("conversations.setTopic", { ok: false, error: "not_in_channel" });
    slack("conversations.join", { ok: true });
    slack("conversations.setTopic", { ok: true });
    const res = await t.editForumTopic({
      chatId: slackChatId(ws),
      messageThreadId: handle,
      name: "New",
      sessionId: "ses_abcdef1234",
    });
    expect(res.ok).toBe(true);
    expect(methods()).toEqual([
      "conversations.info",
      "conversations.join",
      "conversations.info",
      "conversations.rename",
      "conversations.join",
      "conversations.rename",
      "conversations.setTopic",
      "conversations.join",
      "conversations.setTopic",
    ]);
  });

  it("a failed join is that join's own error", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CNIC2");
    slack("conversations.archive", { ok: false, error: "not_in_channel" });
    slack("conversations.join", { ok: false, error: "channel_not_found" });
    const res = await transport(ws).closeForumTopic({ chatId: slackChatId(ws), messageThreadId: handle });
    expect(!res.ok && res.kind).toBe("thread_not_found");
  });
});

describe("a D1 failure after Slack accepted the call", () => {
  /** A D1 whose first `failures` prepares of statements matching `pattern` throw. */
  function flakyDb(pattern: RegExp, failures: number): D1Database {
    let left = failures;
    return {
      prepare(sql: string) {
        if (pattern.test(sql) && left-- > 0) throw new Error("d1 unavailable");
        return env.DB.prepare(sql);
      },
    } as unknown as D1Database;
  }

  it("retries the post record once, so a single failure still returns a real handle", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CDB1");
    slack("chat.postMessage", posted);
    const t = createSlackTransport({ db: flakyDb(/INTO slack_posts/, 1), ws });
    const res = await t.sendMessage({ chatId: slackChatId(ws), messageThreadId: handle, text: "hi" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.message_id).toBeGreaterThanOrEqual(SLACK_HANDLE_MIN);
  });

  it("returns message_id 0 with a warning, not a thrown error, when the record keeps failing", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CDB2");
    slack("chat.postMessage", posted);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = createSlackTransport({ db: flakyDb(/INTO slack_posts/, 99), ws });
      const res = await t.sendMessage({ chatId: slackChatId(ws), messageThreadId: handle, text: "hi" });
      expect(res).toEqual({ ok: true, result: { message_id: 0 } });
      expect(warn.mock.calls.some((c) => String(c[0]).includes("not recorded"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("does the same for a file post", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CDB3");
    slack("files.getUploadURLExternal", { ok: true, upload_url: "https://files.slack.com/upload/v1/D", file_id: "FD" });
    fetchMock.get("https://files.slack.com").intercept({ method: "POST", path: "/upload/v1/D" }).reply(200, "OK - 1");
    slack("files.completeUploadExternal", { ok: true, files: [] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = createSlackTransport({ db: flakyDb(/INTO slack_posts/, 99), ws });
      const res = await t.sendDocument({ chatId: slackChatId(ws), messageThreadId: handle, document: new Blob(["x"]), filename: "a" });
      expect(res).toEqual({ ok: true, result: { message_id: 0 } });
    } finally {
      warn.mockRestore();
    }
  });

  it("an edit whose stored-text update fails is still a success", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CDB4");
    slack("chat.postMessage", posted);
    const sent = await transport(ws).sendMessage({ chatId: slackChatId(ws), messageThreadId: handle, text: "q" });
    if (!sent.ok) throw new Error("send failed");
    slack("chat.update", { ok: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = createSlackTransport({ db: flakyDb(/UPDATE slack_posts/, 99), ws });
      const res = await t.editMessageText({ chatId: slackChatId(ws), messageId: sent.result.message_id, text: "q2" });
      expect(res.ok).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("a created channel whose handle cannot be recorded is a transient failure that names the channel in the log, not a throw", async () => {
    const ws = mkWs();
    slack("conversations.create", { ok: true, channel: { id: "CORPHAN", name: "x" } });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const t = createSlackTransport({ db: flakyDb(/INTO slack_conversations/, 99), ws });
      const res = await t.createForumTopic({ chatId: slackChatId(ws), name: "x" });
      expect(res.ok).toBe(false);
      if (!res.ok && res.kind === "error") expect(res.errorCode).toBe(502);
      else throw new Error("expected a 502 failure");
      expect(JSON.stringify(err.mock.calls)).toContain("CORPHAN");
    } finally {
      err.mockRestore();
    }
  });

  it("the same for a newly created #alerts", async () => {
    const ws = mkWs();
    slack("conversations.list", { ok: true, channels: [] });
    slack("conversations.create", { ok: true, channel: { id: "CAORPHAN", name: "alerts" } });
    slack("conversations.invite", { ok: true });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const t = createSlackTransport({ db: flakyDb(/INTO slack_conversations/, 99), ws });
      const res = await t.sendMessage({ chatId: slackChatId(ws), text: "x" });
      expect(res.ok).toBe(false);
    } finally {
      err.mockRestore();
    }
  });
});

describe("sendRichMessage fallback text", () => {
  it("uses the caller's plain text as the notification text, and keeps the markdown block", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CRT");
    slack("chat.postMessage", posted);
    const res = await transport(ws).sendRichMessage({
      chatId: slackChatId(ws),
      messageThreadId: handle,
      markdown: "**Done** — see `a.ts`",
      text: "Done — see a.ts",
    });
    expect(res.ok).toBe(true);
    expect(calls[0]!.params.get("text")).toBe("Done — see a.ts");
    expect((json(calls[0], "blocks") as Array<{ type: string; text: string }>)[0]).toEqual({
      type: "markdown",
      text: "**Done** — see `a.ts`",
    });
    const post = await env.DB.prepare("SELECT text FROM slack_posts WHERE handle = ?")
      .bind((res as { result: { message_id: number } }).result.message_id)
      .first<{ text: string }>();
    expect(post?.text).toBe("Done — see a.ts");
  });

  it("falls back to the markdown source when no text is given", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CRT2");
    slack("chat.postMessage", posted);
    await transport(ws).sendRichMessage({ chatId: slackChatId(ws), messageThreadId: handle, markdown: "# Hi" });
    expect(calls[0]!.params.get("text")).toBe("# Hi");
  });
});

describe("signal on every operation that carries one", () => {
  const signalFetch = () => {
    const seen: Array<{ method: string; signal: AbortSignal | null | undefined }> = [];
    const answers: Record<string, unknown> = {
      "chat.postMessage": { ok: true, ts: "4.4" },
      "chat.update": { ok: true },
      "files.getUploadURLExternal": { ok: true, upload_url: "https://files.slack.com/upload/v1/SG", file_id: "FSG" },
      "files.completeUploadExternal": { ok: true, files: [] },
    };
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const method = url.startsWith("https://files.slack.com") ? "upload" : url.replace("https://slack.com/api/", "");
      seen.push({ method, signal: init?.signal });
      if (method === "upload") return new Response("OK - 1");
      return new Response(JSON.stringify(answers[method] ?? { ok: false, error: "unexpected" }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { seen, fetchFn };
  };

  it("sendRichMessage, editMessageText, sendPhoto and sendDocument pass it to each Slack call", async () => {
    const ws = mkWs();
    const handle = await seedChannel(ws, "CSG");
    const ac = new AbortController();
    const { seen, fetchFn } = signalFetch();
    const t = createSlackTransport({ db: env.DB, ws, fetchFn });
    const chatId = slackChatId(ws);

    const rich = await t.sendRichMessage({ chatId, messageThreadId: handle, markdown: "m", signal: ac.signal });
    expect(rich.ok).toBe(true);
    if (!rich.ok) return;
    expect((await t.editMessageText({ chatId, messageId: rich.result.message_id, text: "e", signal: ac.signal })).ok).toBe(true);
    expect((await t.sendPhoto({ chatId, messageThreadId: handle, photo: new Blob(["p"]), filename: "p.png", signal: ac.signal })).ok).toBe(true);
    expect((await t.sendDocument({ chatId, messageThreadId: handle, document: new Blob(["d"]), filename: "d.txt", signal: ac.signal })).ok).toBe(true);

    expect(seen.map((s) => s.method)).toEqual([
      "chat.postMessage",
      "chat.update",
      "files.getUploadURLExternal",
      "upload",
      "files.completeUploadExternal",
      "files.getUploadURLExternal",
      "upload",
      "files.completeUploadExternal",
    ]);
    for (const s of seen) expect(s.signal).toBe(ac.signal);
  });
});

describe("Telegram requests are unchanged by the new option fields", () => {
  it("sends byte-identical bodies with or without signal / notifyOwner (and text on a rich message)", async () => {
    const bodies: Array<{ method: string; body: unknown }> = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
      const body = init?.body;
      bodies.push({
        method: String(url).split("/").pop()!,
        body:
          body instanceof FormData
            ? [...body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `file:${(v as File).name}:${(v as File).size}`])
            : body,
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }) as typeof fetch);
    try {
      const tg = createTelegramClient("tok-byte");
      const ac = new AbortController();
      const run = async (extra: Record<string, unknown>, richExtra: Record<string, unknown> = {}) => {
        bodies.length = 0;
        await tg.sendRichMessage({ chatId: "1", markdown: "m", messageThreadId: 5, replyMarkup: { a: 1 }, ...extra, ...richExtra });
        await tg.editMessageText({ chatId: "1", messageId: 2, text: "t", entities: [{ type: "bold" }], ...extra });
        await tg.sendPhoto({ chatId: "1", photo: new Blob(["abc"]), filename: "p.png", messageThreadId: 5, replyToMessageId: 3, ...extra });
        await tg.sendDocument({ chatId: "1", document: new Blob(["abc"]), filename: "d.txt", ...extra });
        await tg.sendMessage({ chatId: "1", text: "t", ...extra });
        return structuredClone(bodies);
      };
      const plain = await run({});
      const extended = await run({ signal: ac.signal, notifyOwner: true }, { text: "plain" });
      expect(extended).toEqual(plain);
      expect(plain).toHaveLength(5);
    } finally {
      spy.mockRestore();
    }
  });
});
