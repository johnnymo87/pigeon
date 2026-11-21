/**
 * The hint in a named topic whose coordinator moved to the other transport (bead pigeon-4ogz.22).
 *
 * After `slack-flip` re-points a coordinator's binding to its Slack channel, the old Telegram
 * topic keeps its `named_topics` row. A message typed there must point at the channel instead of
 * calling it a digest topic, and the reverse after a flip back. Slack and Telegram are fetchMocks
 * with `disableNetConnect`, so an unexpected provider call fails the test.
 */
import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import { slackChatId, slackSecretKeyForMachine, type SlackWorkspace } from "../src/chat/slack-config";
import { maybeAnswerInNamedTopic, movedTopicHintText, NAMED_TOPIC_HINT_TEXT } from "../src/named-topics";

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  slackTexts.length = 0;
  tgTexts.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fetchMock.assertNoPendingInterceptors();
  } finally {
    fetchMock.deactivate();
  }
});

let counter = 0;
const stamp = () => `${Date.now().toString(36)}${(++counter).toString(36)}`;
const TG_CHAT = "-1004232934695";
const TG_CHAT_ID = "4232934695";

function mkWs(): { machineId: string; ws: SlackWorkspace } {
  const machineId = `mh${stamp()}`.toLowerCase().slice(0, 30);
  return {
    machineId,
    ws: {
      teamId: `T${stamp()}`.toUpperCase(),
      appId: "A0APP",
      domain: "acme",
      botToken: "xoxb-bot",
      userToken: "xoxp-user",
      signingSecret: "sig",
      ownerUserId: "U0OWNER",
    },
  };
}

function envFor(...on: Array<{ machineId: string; ws: SlackWorkspace }>): Env {
  const secrets: Record<string, string> = {};
  for (const m of on) secrets[slackSecretKeyForMachine(m.machineId)] = JSON.stringify(m.ws);
  return { ...env, TELEGRAM_TOPICS_ENABLED: "true", ...secrets } as unknown as Env;
}

async function namedTopic(chatId: string, key: string, thread: number, name: string) {
  await env.DB.prepare(
    `INSERT INTO named_topics (chat_id, topic_key, message_thread_id, name, reopen_checked_at, hint_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, 0, 0)`,
  )
    .bind(chatId, key, thread, name)
    .run();
}

async function bind(chatId: string, key: string, sessionId: string) {
  await env.DB.prepare("INSERT INTO named_topic_bindings (chat_id, topic_key, session_id, bound_at) VALUES (?, ?, ?, 0)")
    .bind(chatId, key, sessionId)
    .run();
}

/** A Slack channel with a handle, optionally a named row for `key`. */
async function slackChannel(ws: SlackWorkspace, channelId: string, key?: string, name = "📋 chat-transport"): Promise<number> {
  await env.DB.prepare("INSERT INTO slack_conversations (team_id, channel_id, created_at, owner_invited) VALUES (?, ?, ?, 1)")
    .bind(ws.teamId, channelId, Date.now())
    .run();
  const row = await env.DB.prepare("SELECT handle FROM slack_conversations WHERE team_id = ? AND channel_id = ?")
    .bind(ws.teamId, channelId)
    .first<{ handle: number }>();
  if (key) await namedTopic(slackChatId(ws), key, row!.handle, name);
  return row!.handle;
}

const slackTexts: string[] = [];
function slackPost() {
  fetchMock
    .get("https://slack.com")
    .intercept({ method: "POST", path: "/api/chat.postMessage" })
    .reply(200, (opts: { body?: unknown }) => {
      slackTexts.push(new URLSearchParams(String(opts.body)).get("text") ?? "");
      return { ok: true, ts: `1.${stamp()}` };
    });
}

const tgTexts: string[] = [];
function tgSend() {
  fetchMock
    .get("https://api.telegram.org")
    .intercept({ method: "POST", path: /\/bot.*\/sendMessage$/ })
    .reply(200, (opts: { body?: unknown }) => {
      const raw = typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body as ArrayBuffer);
      tgTexts.push(String(JSON.parse(raw).text));
      return { ok: true, result: { message_id: ++counter } };
    });
}

describe("maybeAnswerInNamedTopic: a coordinator that moved transport", () => {
  it("old Telegram topic, key now bound in Slack: names and links the channel", async () => {
    const m = mkWs();
    const key = `stallwatch:ct${stamp()}`;
    const oldThread = 23000 + counter;
    await namedTopic(TG_CHAT, key, oldThread, "📋 chat-transport");
    await slackChannel(m.ws, "C0CKM80JXD1", key);
    await bind(slackChatId(m.ws), key, `gse_${stamp()}`);

    tgSend();
    expect(await maybeAnswerInNamedTopic(env.DB, envFor(m), TG_CHAT, oldThread)).toBe(true);
    expect(tgTexts).toEqual([
      movedTopicHintText("slack", "📋 chat-transport", "https://acme.slack.com/archives/C0CKM80JXD1"),
    ]);
    expect(tgTexts[0]).toContain("moved to a Slack channel (📋 chat-transport)");
    expect(tgTexts[0]).not.toContain("digest");

    // The rate limit still holds: a second message inside the window gets no answer.
    expect(await maybeAnswerInNamedTopic(env.DB, envFor(m), TG_CHAT, oldThread)).toBe(true);
    expect(tgTexts).toHaveLength(1);
  });

  it("old Slack channel after a flip back: links the Telegram topic", async () => {
    const m = mkWs();
    const key = `stallwatch:back${stamp()}`;
    const handle = await slackChannel(m.ws, "COLDCHAN", key);
    const thread = 24000 + counter;
    await namedTopic(TG_CHAT, key, thread, "📋 back");
    await bind(TG_CHAT, key, `gse_${stamp()}`);

    slackPost();
    expect(await maybeAnswerInNamedTopic(env.DB, envFor(m), slackChatId(m.ws), handle)).toBe(true);
    expect(slackTexts).toHaveLength(1);
    expect(slackTexts[0]).toContain("moved to a Telegram topic (📋 back)");
    expect(slackTexts[0]).toContain(`https://t.me/c/${TG_CHAT_ID}/${thread}`);
  });

  it("no workspace secret for the Slack row: still says where, without a link", async () => {
    const m = mkWs();
    const key = `stallwatch:nows${stamp()}`;
    const oldThread = 25000 + counter;
    await namedTopic(TG_CHAT, key, oldThread, "📋 x");
    await slackChannel(m.ws, "CNOSECRET", key, "📋 x");
    await bind(slackChatId(m.ws), key, `gse_${stamp()}`);

    tgSend();
    expect(await maybeAnswerInNamedTopic(env.DB, envFor(), TG_CHAT, oldThread)).toBe(true);
    expect(tgTexts).toEqual([movedTopicHintText("slack", "📋 x", null)]);
  });

  it("key bound in two Slack workspaces: picks the coordinator that posted here, else the stock hint", async () => {
    const a = mkWs();
    const b = mkWs();
    const key = `stallwatch:two${stamp()}`;
    const oldThread = 26000 + counter;
    await namedTopic(TG_CHAT, key, oldThread, "📋 two");
    await slackChannel(a.ws, "CAAA", key);
    await slackChannel(b.ws, "CBBB", key);
    const sa = `gse_${stamp()}`;
    await bind(slackChatId(a.ws), key, sa);
    await bind(slackChatId(b.ws), key, `gse_${stamp()}`);

    tgSend();
    expect(await maybeAnswerInNamedTopic(env.DB, envFor(a, b), TG_CHAT, oldThread)).toBe(true);
    expect(tgTexts).toEqual([NAMED_TOPIC_HINT_TEXT]);

    await env.DB.prepare(
      "INSERT INTO messages (chat_id, message_id, session_id, token, created_at) VALUES (?, ?, ?, 'tok', 0)",
    )
      .bind(TG_CHAT, 900000 + counter, sa)
      .run();
    await env.DB.prepare("UPDATE named_topics SET hint_at = NULL WHERE chat_id = ? AND topic_key = ?").bind(TG_CHAT, key).run();
    tgSend();
    expect(await maybeAnswerInNamedTopic(env.DB, envFor(a, b), TG_CHAT, oldThread)).toBe(true);
    expect(tgTexts[1]).toContain("https://acme.slack.com/archives/CAAA");
  });

  it("key bound only in another Telegram chat (same transport): the stock hint", async () => {
    const key = `stallwatch:same${stamp()}`;
    const oldThread = 27000 + counter;
    await namedTopic(TG_CHAT, key, oldThread, "📋 same");
    await namedTopic("-1003983501132", key, 5, "📋 same");
    await bind("-1003983501132", key, `gse_${stamp()}`);

    tgSend();
    expect(await maybeAnswerInNamedTopic(env.DB, envFor(), TG_CHAT, oldThread)).toBe(true);
    expect(tgTexts).toEqual([NAMED_TOPIC_HINT_TEXT]);
  });

  it("key still bound in this chat (session row gone): the stock hint, not a redirect", async () => {
    const m = mkWs();
    const key = `stallwatch:here${stamp()}`;
    const oldThread = 28000 + counter;
    await namedTopic(TG_CHAT, key, oldThread, "📋 here");
    await bind(TG_CHAT, key, `gse_${stamp()}`);
    await slackChannel(m.ws, "CHERE", key);
    await bind(slackChatId(m.ws), key, `gse_${stamp()}`);

    tgSend();
    expect(await maybeAnswerInNamedTopic(env.DB, envFor(m), TG_CHAT, oldThread)).toBe(true);
    expect(tgTexts).toEqual([NAMED_TOPIC_HINT_TEXT]);
  });
});
