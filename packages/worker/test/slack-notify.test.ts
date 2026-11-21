/**
 * Slack owner-mention policy (bead pigeon-4ogz.3, D7 revision): pushes are off by default, and
 * the owner `<@user>` mention is applied only for categories listed in `SLACK_NOTIFY_OWNER`.
 * The pure helpers first, then the whole matrix through a real SlackTransport on a fetchMock.
 */
import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import { SLACK_HANDLE_MIN, slackChatId, type SlackWorkspace } from "../src/chat/slack-config";
import {
  explicitCategory,
  parseNotifyCategories,
  shouldMention,
  type ConversationKind,
  type NotifyCategory,
} from "../src/chat/slack-notify";
import { createSlackTransport } from "../src/chat/slack-transport";
import { buildSlackMessage } from "../src/chat/slack-render";

describe("parseNotifyCategories", () => {
  it("is empty for unset, empty, whitespace and non-strings", () => {
    for (const raw of [undefined, null, "", "   ", ",,,", 5 as unknown as string]) {
      expect(parseNotifyCategories(raw).size).toBe(0);
    }
  });

  it("reads each category, case-insensitively and trimmed", () => {
    expect([...parseNotifyCategories("questions")]).toEqual(["questions"]);
    expect([...parseNotifyCategories(" ERRORS ")]).toEqual(["errors"]);
    expect([...parseNotifyCategories("Named")]).toEqual(["named"]);
    expect([...parseNotifyCategories("alerts")]).toEqual(["alerts"]);
    expect([...parseNotifyCategories("questions , Errors,NAMED,\talerts\n")].sort()).toEqual([
      "alerts",
      "errors",
      "named",
      "questions",
    ]);
  });

  it("ignores unknown entries, keeping the valid ones", () => {
    expect(parseNotifyCategories("all").size).toBe(0);
    expect(parseNotifyCategories("*").size).toBe(0);
    expect(parseNotifyCategories("true").size).toBe(0);
    expect(parseNotifyCategories("channel,here,everyone").size).toBe(0);
    expect(parseNotifyCategories("question,error").size).toBe(0);
    expect([...parseNotifyCategories("bogus, errors ,;,alerts,")].sort()).toEqual(["alerts", "errors"]);
  });
});

describe("explicitCategory", () => {
  it("is questions for q: ids and errors for everything else", () => {
    expect(explicitCategory("q:ses_1:req")).toBe("questions");
    expect(explicitCategory("s:ses_1:5")).toBe("errors");
    expect(explicitCategory("Q:ses_1")).toBe("errors");
    expect(explicitCategory(undefined)).toBe("errors");
    expect(explicitCategory(null)).toBe("errors");
  });
});

describe("shouldMention", () => {
  const cats = (raw: string) => parseNotifyCategories(raw);
  const kinds: ConversationKind[] = ["session", "named", "alerts"];

  it("never mentions with no categories enabled, whatever the post", () => {
    for (const conversationKind of kinds) {
      for (const notifyOwner of [true, false, undefined]) {
        for (const notificationId of ["q:ses_1:r", "s:ses_1:1", undefined]) {
          expect(shouldMention({ categories: cats(""), notifyOwner, notificationId, conversationKind })).toBe(false);
        }
      }
    }
  });

  it("never mentions an unflagged post in a session channel, whatever is enabled", () => {
    expect(shouldMention({ categories: cats("questions,errors,named,alerts"), conversationKind: "session" })).toBe(false);
    expect(shouldMention({ categories: cats("questions,errors,named,alerts"), notifyOwner: false, conversationKind: "session" })).toBe(
      false,
    );
  });

  it("each category enables only its own posts", () => {
    const only = (c: NotifyCategory) => ({
      question: shouldMention({ categories: cats(c), notifyOwner: true, notificationId: "q:ses_1:r", conversationKind: "session" }),
      error: shouldMention({ categories: cats(c), notifyOwner: true, notificationId: "s:ses_1:1", conversationKind: "session" }),
      named: shouldMention({ categories: cats(c), conversationKind: "named" }),
      alerts: shouldMention({ categories: cats(c), conversationKind: "alerts" }),
    });
    expect(only("questions")).toEqual({ question: true, error: false, named: false, alerts: false });
    expect(only("errors")).toEqual({ question: false, error: true, named: false, alerts: false });
    expect(only("named")).toEqual({ question: false, error: false, named: true, alerts: false });
    expect(only("alerts")).toEqual({ question: false, error: false, named: false, alerts: true });
  });

  it("an explicit flag in a named channel or #alerts mentions if either category applies", () => {
    const q = { notifyOwner: true, notificationId: "q:ses_1:r" };
    expect(shouldMention({ categories: cats("questions"), ...q, conversationKind: "alerts" })).toBe(true);
    expect(shouldMention({ categories: cats("alerts"), ...q, conversationKind: "alerts" })).toBe(true);
    expect(shouldMention({ categories: cats("named"), ...q, conversationKind: "alerts" })).toBe(false);
    expect(shouldMention({ categories: cats("errors"), ...q, conversationKind: "named" })).toBe(false);
    expect(shouldMention({ categories: cats("errors,named"), notifyOwner: true, conversationKind: "named" })).toBe(true);
  });

  it("an explicit notifyCategory wins over the boolean's id-based mapping", () => {
    expect(shouldMention({ categories: cats("questions"), notifyCategory: "questions", conversationKind: "session" })).toBe(true);
    expect(
      shouldMention({ categories: cats("questions"), notifyOwner: true, notifyCategory: "errors", notificationId: "q:x", conversationKind: "session" }),
    ).toBe(false);
  });
});

// ─── through the transport ─────────────────────────────────────────────────

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
const calls: Array<{ method: string; params: URLSearchParams }> = [];

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

function slack(method: string, reply: Record<string, unknown>) {
  fetchMock
    .get("https://slack.com")
    .intercept({ method: "POST", path: `/api/${method}` })
    .reply(200, (opts: { body?: unknown }) => {
      calls.push({ method, params: new URLSearchParams(String(opts.body)) });
      return reply;
    });
}

async function seedChannel(ws: SlackWorkspace, channelId: string, namedKey?: string): Promise<number> {
  await env.DB.prepare("INSERT INTO slack_conversations (team_id, channel_id, created_at, owner_invited) VALUES (?, ?, ?, 1)")
    .bind(ws.teamId, channelId, Date.now())
    .run();
  const row = await env.DB.prepare("SELECT handle FROM slack_conversations WHERE team_id = ? AND channel_id = ?")
    .bind(ws.teamId, channelId)
    .first<{ handle: number }>();
  if (namedKey) {
    await env.DB.prepare(
      `INSERT INTO named_topics (chat_id, topic_key, message_thread_id, name, reopen_checked_at, hint_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, 0, 0)`,
    )
      .bind(slackChatId(ws), namedKey, row!.handle, namedKey)
      .run();
  }
  expect(row!.handle).toBeGreaterThanOrEqual(SLACK_HANDLE_MIN);
  return row!.handle;
}

const MENTION = "<@U0OWNER>";

/** One post into each kind of channel with the given setting; returns who got a mention. */
async function matrix(setting: string | undefined, flag: { notifyOwner?: boolean; notifyCategory?: "questions" | "errors" } = {}) {
  const ws = mkWs();
  const session = await seedChannel(ws, "CSESS");
  const named = await seedChannel(ws, "CNAMED", "digest");
  const alerts = await seedChannel(ws, "CALERTS", "_alerts");
  const t = createSlackTransport({ db: env.DB, ws, notifyCategories: parseNotifyCategories(setting) });
  const post = async (messageThreadId: number | undefined, extra: object) => {
    slack("chat.postMessage", { ok: true, ts: uniq("1.") });
    const res = await t.sendMessage({ chatId: slackChatId(ws), text: "ping", ...(messageThreadId !== undefined ? { messageThreadId } : {}), ...extra });
    expect(res.ok).toBe(true);
    const c = calls[calls.length - 1]!;
    // The mention is in the fallback text, and in the blocks (a user element).
    const inBlocks = JSON.stringify(JSON.parse(c.params.get("blocks") ?? "[]")).includes('"type":"user"');
    const inText = c.params.get("text")!.includes(MENTION);
    expect(inBlocks).toBe(inText);
    return inText;
  };
  return {
    session: await post(session, flag),
    named: await post(named, flag),
    alerts: await post(undefined, flag),
  };
}

describe("owner mention through the transport", () => {
  it("default (unset, empty, garbage): no mention anywhere, flagged or not", async () => {
    const none = { session: false, named: false, alerts: false };
    for (const setting of [undefined, "", "  ", "bogus,all,*"]) {
      expect(await matrix(setting)).toEqual(none);
      expect(await matrix(setting, { notifyOwner: true })).toEqual(none);
      expect(await matrix(setting, { notifyCategory: "questions" })).toEqual(none);
    }
  });

  it("with no notifyCategories dep at all, nothing mentions", async () => {
    const ws = mkWs();
    const named = await seedChannel(ws, "CNODEP", "digest");
    const t = createSlackTransport({ db: env.DB, ws });
    slack("chat.postMessage", { ok: true, ts: "1.1" });
    await t.sendMessage({ chatId: slackChatId(ws), messageThreadId: named, text: "ping", notifyOwner: true });
    expect(calls[0]!.params.get("text")).toBe("ping");
  });

  it("named: only named channels (not #alerts, not session channels)", async () => {
    expect(await matrix("named")).toEqual({ session: false, named: true, alerts: false });
  });

  it("alerts: only #alerts", async () => {
    expect(await matrix("alerts")).toEqual({ session: false, named: false, alerts: true });
  });

  it("errors: a flagged post anywhere (legacy boolean maps to errors)", async () => {
    expect(await matrix("errors")).toEqual({ session: false, named: false, alerts: false });
    expect(await matrix("errors", { notifyOwner: true })).toEqual({ session: true, named: true, alerts: true });
    expect(await matrix("errors", { notifyCategory: "errors" })).toEqual({ session: true, named: true, alerts: true });
    expect(await matrix("errors", { notifyCategory: "questions" })).toEqual({ session: false, named: false, alerts: false });
  });

  it("questions: a post flagged as a question anywhere", async () => {
    expect(await matrix("questions", { notifyCategory: "questions" })).toEqual({ session: true, named: true, alerts: true });
    expect(await matrix("questions", { notifyOwner: true })).toEqual({ session: false, named: false, alerts: false });
  });

  it("combinations are a union", async () => {
    expect(await matrix("named,alerts")).toEqual({ session: false, named: true, alerts: true });
    expect(await matrix("Questions, NAMED", { notifyCategory: "questions" })).toEqual({ session: true, named: true, alerts: true });
    expect(await matrix("errors,alerts", { notifyOwner: true })).toEqual({ session: true, named: true, alerts: true });
    expect(await matrix("questions,errors,named,alerts")).toEqual({ session: false, named: true, alerts: true });
  });

  it("rich messages and edits follow the same rule", async () => {
    const ws = mkWs();
    const named = await seedChannel(ws, "CRICH", "digest");
    const off = createSlackTransport({ db: env.DB, ws });
    const on = createSlackTransport({ db: env.DB, ws, notifyCategories: parseNotifyCategories("named") });

    slack("chat.postMessage", { ok: true, ts: "5.1" });
    await off.sendRichMessage({ chatId: slackChatId(ws), messageThreadId: named, markdown: "**hi**", text: "hi" });
    expect(calls[0]!.params.get("text")).toBe("hi");
    expect(calls[0]!.params.get("blocks")).not.toContain("U0OWNER");

    slack("chat.postMessage", { ok: true, ts: "5.2" });
    const sent = await on.sendRichMessage({ chatId: slackChatId(ws), messageThreadId: named, markdown: "**hi**", text: "hi" });
    expect(calls[1]!.params.get("text")).toBe(`${MENTION} hi`);
    if (!sent.ok) throw new Error("send failed");

    slack("chat.update", { ok: true });
    await off.editMessage({ chatId: slackChatId(ws), messageId: sent.result.message_id, text: "edited" });
    expect(calls[2]!.params.get("text")).toBe("edited");
    slack("chat.update", { ok: true });
    await on.editMessage({ chatId: slackChatId(ws), messageId: sent.result.message_id, text: "edited" });
    expect(calls[3]!.params.get("text")).toBe(`${MENTION} edited`);
  });
});

// ─── never a broadcast ─────────────────────────────────────────────────────

const BROADCAST = /<!(?:channel|here|everyone|subteam)/i;
const ZWJ = "\u200d";

describe("pigeon never emits a broadcast mention", () => {
  const hostile = "<!channel> <!here> <!everyone> <!subteam^S123> @channel @here @everyone @Channel";

  it("plain text: the fallback escapes the angle brackets and defuses the bare words", () => {
    const m = buildSlackMessage({ text: hostile, ownerUserId: "U0OWNER", notifyOwner: true });
    expect(m.text).not.toMatch(BROADCAST);
    expect(m.text).toContain("&lt;!channel&gt;");
    for (const word of ["channel", "here", "everyone"]) expect(m.text).not.toMatch(new RegExp(`@${word}`, "i"));
    expect(m.text).toContain(`@${ZWJ}channel`);
  });

  it("rich_text: only text and user elements, never a broadcast element or raw <!…>", () => {
    const m = buildSlackMessage({ text: hostile, ownerUserId: "U0OWNER", notifyOwner: true });
    const dump = JSON.stringify(m.blocks);
    expect(dump).not.toContain('"broadcast"');
    expect(dump).not.toMatch(/"type":"(?:broadcast|usergroup|channel)"/);
    const types = new Set<string>();
    const walk = (n: unknown) => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === "object") {
        const o = n as { type?: string };
        if (o.type) types.add(o.type);
        Object.values(n).forEach(walk);
      }
    };
    walk(m.blocks);
    expect([...types].sort()).toEqual(["rich_text", "rich_text_section", "text", "user"]);
  });

  it("markdown: literal broadcasts are defused, ordinary markdown and e-mails are untouched", () => {
    const m = buildSlackMessage({ text: "fb", markdown: `**hi** ${hostile}\nping me@here.com or @channelz`, ownerUserId: "U0OWNER" });
    const md = (m.blocks[0] as unknown as { text: string }).text;
    expect(md).not.toMatch(BROADCAST);
    expect(md.replace("me@here.com", "")).not.toMatch(/@(?:channel|here|everyone)\b/i);
    expect(md).toContain(`@${ZWJ}channel`);
    expect(md).toContain("**hi**");
    expect(md).toContain("me@here.com");
    expect(md).toContain("@channelz");
  });

  it("the owner mention itself is the only mention a post can carry", async () => {
    const ws = mkWs();
    const alerts = await seedChannel(ws, "CBC", "_alerts");
    const t = createSlackTransport({ db: env.DB, ws, notifyCategories: parseNotifyCategories("questions,errors,named,alerts") });
    slack("chat.postMessage", { ok: true, ts: "9.1" });
    await t.sendRichMessage({ chatId: slackChatId(ws), messageThreadId: alerts, markdown: hostile, text: hostile, notifyOwner: true });
    const c = calls[0]!;
    const payload = `${c.params.get("text")}${c.params.get("blocks")}`;
    expect(payload).not.toMatch(BROADCAST);
    expect(payload).not.toMatch(/@(?:channel|here|everyone)/i);
    expect(c.params.get("text")!.startsWith(MENTION)).toBe(true);
  });
});
