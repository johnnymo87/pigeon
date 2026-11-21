/**
 * chat-transport phase 2, step 1 (bead pigeon-4ogz.1): the worker's ChatTransport seam, the
 * chat-scoped topic CAS, the shared slash-command parsers, and the optional leading <session-id>
 * on session commands. Spec: docs/plans/2026-11-20-slack-transport-design.md §1, §5.
 */
import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import { createTelegramClient } from "../src/telegram";
import { isSlackChatId, transportForChat, type ChatTransport } from "../src/chat";
import { parseChatCommand, SESSION_REF_RE } from "../src/chat/commands";
import { resolveSessionRef } from "../src/chat/session-ref";
import { deleteBySession, finalize, getBySession, markOpen, renameProvisional, reserve } from "../src/topics";
import { resolveTopic } from "../src/topic-manager";

const TG_CHAT = "8248645256";
const SLACK_CHAT = "slack:T0SEAM";

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.deactivate();
});

let counter = 0;
const uniq = (p: string) => `${p}${Date.now().toString(36)}${(++counter).toString(36)}`;

// ─── ChatTransport routing ─────────────────────────────────────────────────

describe("transportForChat", () => {
  it("recognises slack addresses by prefix only", () => {
    expect(isSlackChatId("slack:T123")).toBe(true);
    expect(isSlackChatId("-1001234")).toBe(false);
    expect(isSlackChatId(8248645256)).toBe(false);
    expect(isSlackChatId("slackT123")).toBe(false);
  });

  it("routes a Telegram chat id to the Telegram Bot API", async () => {
    let path = "";
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bottok-seam\/sendMessage/ })
      .reply(200, (opts: { path: string }) => {
        path = opts.path;
        return { ok: true, result: { message_id: 7 } };
      });
    const res = await transportForChat(TG_CHAT, "tok-seam").sendMessage({ chatId: TG_CHAT, text: "hi" });
    expect(res.ok).toBe(true);
    expect(path).toContain("/bottok-seam/sendMessage");
  });

  it("never sends a slack address to Telegram, and reports a transient (non-4xx) failure", async () => {
    // disableNetConnect: any fetch would throw, so a resolved result proves nothing was called.
    const t = transportForChat(SLACK_CHAT, "tok-seam");
    const res = await t.sendMessage({ chatId: SLACK_CHAT, text: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok && res.kind === "error") {
      expect(res.errorCode).toBeUndefined();
      expect(res.description).toMatch(/slack/i);
    } else {
      throw new Error(`unexpected result ${JSON.stringify(res)}`);
    }
    const created = await t.createForumTopic({ chatId: SLACK_CHAT, name: "x" });
    expect(created.ok).toBe(false);
  });

  it("uses an injected Telegram transport for Telegram addresses only", async () => {
    const calls: string[] = [];
    const fake: ChatTransport = {
      ...createTelegramClient("unused"),
      sendMessage: async () => {
        calls.push("fake");
        return { ok: true, result: { message_id: 1 } };
      },
    };
    await transportForChat(TG_CHAT, "tok", fake).sendMessage({ chatId: TG_CHAT, text: "a" });
    const slackRes = await transportForChat(SLACK_CHAT, "tok", fake).sendMessage({ chatId: SLACK_CHAT, text: "b" });
    expect(calls).toEqual(["fake"]);
    expect(slackRes.ok).toBe(false);
  });
});

// ─── Chat-scoped topic CAS ─────────────────────────────────────────────────

/** What a supersede (.3) does to the row: replace it with a reservation in the other transport. */
async function supersede(sessionId: string, toChat: string): Promise<void> {
  await env.DB.prepare("DELETE FROM topics WHERE session_id = ?").bind(sessionId).run();
  await reserve(env.DB, { sessionId, machineId: "devbox", chatId: toChat, name: "slack row" });
}

describe("topic CAS scoped to chat_id", () => {
  it("finalize with a chatId does not write into a row in another chat", async () => {
    const sessionId = uniq("ses_cas_fin_");
    await reserve(env.DB, { sessionId, machineId: "devbox", chatId: SLACK_CHAT, name: "s" });
    expect(await finalize(env.DB, { sessionId, chatId: TG_CHAT, messageThreadId: 41, name: "tg" })).toBe(false);
    const row = await getBySession(env.DB, sessionId);
    expect(row?.message_thread_id).toBeNull();
    expect(row?.name).toBe("s");
    expect(await finalize(env.DB, { sessionId, chatId: SLACK_CHAT, messageThreadId: 42 })).toBe(true);
  });

  it("deleteBySession with a chatId does not delete a reservation in another chat", async () => {
    const sessionId = uniq("ses_cas_del_");
    await reserve(env.DB, { sessionId, machineId: "devbox", chatId: SLACK_CHAT, name: "s" });
    expect(await deleteBySession(env.DB, sessionId, TG_CHAT)).toBe(false);
    expect(await getBySession(env.DB, sessionId)).not.toBeNull();
    expect(await deleteBySession(env.DB, sessionId, SLACK_CHAT)).toBe(true);
  });

  it("markOpen and renameProvisional with a chatId leave another chat's row alone", async () => {
    const sessionId = uniq("ses_cas_open_");
    await reserve(env.DB, { sessionId, machineId: "devbox", chatId: SLACK_CHAT, name: "s" });
    await finalize(env.DB, { sessionId, chatId: SLACK_CHAT, messageThreadId: 43, name: "s", provisional: true });
    await env.DB.prepare("UPDATE topics SET state = 'closed', closed_at = 1 WHERE session_id = ?").bind(sessionId).run();
    await markOpen(env.DB, { sessionId, chatId: TG_CHAT });
    expect(await renameProvisional(env.DB, { sessionId, chatId: TG_CHAT, name: "other" })).toBe(false);
    const row = await getBySession(env.DB, sessionId);
    expect(row?.state).toBe("closed");
    expect(row?.name_provisional).toBe(1);
  });

  it("a Telegram create that finishes after a supersede does not touch the new row (late finalize)", async () => {
    const sessionId = uniq("ses_cas_late_");
    const deleted: number[] = [];
    const tg: ChatTransport = {
      ...createTelegramClient("unused"),
      createForumTopic: async (o) => {
        // The 57 s create (pigeon-iqpd): while it is in flight the row moves to Slack.
        await supersede(sessionId, SLACK_CHAT);
        return { ok: true, result: { message_thread_id: 9001, name: o.name, icon_color: 0 } };
      },
      deleteForumTopic: async (o) => {
        deleted.push(o.messageThreadId);
        return { ok: true, result: true };
      },
    };
    const res = await resolveTopic(env.DB, {
      sessionId,
      machineId: "devbox",
      chatId: TG_CHAT,
      dir: "~/p",
      title: "T",
      botToken: "unused",
      tgClient: tg,
    });
    const row = await getBySession(env.DB, sessionId);
    expect(row?.chat_id).toBe(SLACK_CHAT);
    expect(row?.message_thread_id).toBeNull();
    expect(row?.name).toBe("slack row");
    // The orphan Telegram topic is cleaned up, and this notification does not use the Slack row.
    expect(deleted).toEqual([9001]);
    expect(res).toMatchObject({ ok: true, messageThreadId: null, reason: "topic_in_other_chat" });
  });

  it("a failed Telegram create does not delete a reservation that moved to another chat (loser cleanup)", async () => {
    const sessionId = uniq("ses_cas_fail_");
    const tg: ChatTransport = {
      ...createTelegramClient("unused"),
      createForumTopic: async () => {
        await supersede(sessionId, SLACK_CHAT);
        return { ok: false, kind: "error", errorCode: 500, description: "boom" };
      },
    };
    await resolveTopic(env.DB, {
      sessionId,
      machineId: "devbox",
      chatId: TG_CHAT,
      dir: "~/p",
      title: "T",
      botToken: "unused",
      tgClient: tg,
    });
    const row = await getBySession(env.DB, sessionId);
    expect(row?.chat_id).toBe(SLACK_CHAT);
  });
});

// ─── Shared command parser ─────────────────────────────────────────────────

describe("parseChatCommand", () => {
  it("returns null for plain text and unknown commands", () => {
    expect(parseChatCommand("fix the test")).toBeNull();
    expect(parseChatCommand("/opencode-serve@4098 is stuck")).toBeNull();
    expect(parseChatCommand("/killall")).toBeNull();
  });

  it("parses bare session commands as before", () => {
    expect(parseChatCommand("/kill")).toEqual({ kind: "session", type: "kill", arg: "" });
    expect(parseChatCommand("/interrupt")).toEqual({ kind: "session", type: "interrupt", arg: "" });
    expect(parseChatCommand("/compact")).toEqual({ kind: "session", type: "compact", arg: "" });
    expect(parseChatCommand("/mcp list")).toEqual({ kind: "session", type: "mcp_list", arg: "" });
    expect(parseChatCommand("/mcp enable slack")).toEqual({ kind: "session", type: "mcp_enable", arg: "slack" });
    expect(parseChatCommand("/mcp disable slack")).toEqual({ kind: "session", type: "mcp_disable", arg: "slack" });
    expect(parseChatCommand("/model")).toEqual({ kind: "session", type: "model_list", arg: "" });
    expect(parseChatCommand("/model anthropic/opus")).toEqual({ kind: "session", type: "model_set", arg: "anthropic/opus" });
    // Unchanged quirk: a slash-less /model argument lists.
    expect(parseChatCommand("/model opus")).toEqual({ kind: "session", type: "model_list", arg: "" });
  });

  it("accepts an optional leading session id on session commands", () => {
    const id = "ses_e71285de";
    expect(parseChatCommand(`/kill ${id}`)).toEqual({ kind: "session", type: "kill", arg: "", target: id });
    expect(parseChatCommand(`/interrupt ${id}`)).toMatchObject({ type: "interrupt", target: id });
    expect(parseChatCommand(`/compact ${id}`)).toMatchObject({ type: "compact", target: id });
    expect(parseChatCommand(`/mcp ${id} list`)).toEqual({ kind: "session", type: "mcp_list", arg: "", target: id });
    expect(parseChatCommand(`/mcp ${id} enable slack`)).toEqual({ kind: "session", type: "mcp_enable", arg: "slack", target: id });
    expect(parseChatCommand(`/model ${id}`)).toEqual({ kind: "session", type: "model_list", arg: "", target: id });
    expect(parseChatCommand(`/model ${id} a/b`)).toEqual({ kind: "session", type: "model_set", arg: "a/b", target: id });
    const goose = "gse_72976d25-5e64-539f-8cba-433dcaa3aa4b";
    expect(parseChatCommand(`/kill ${goose}`)).toMatchObject({ type: "kill", target: goose });
  });

  it("answers a session command with unparseable arguments with usage, never as a prompt", () => {
    expect(parseChatCommand("/kill ses_abc")).toEqual({ kind: "usage", command: "kill" });
    expect(parseChatCommand("/kill now")).toEqual({ kind: "usage", command: "kill" });
    expect(parseChatCommand("/kill ses_e71285de extra")).toEqual({ kind: "usage", command: "kill" });
    expect(parseChatCommand("/interrupt Ses_e71285de")).toEqual({ kind: "usage", command: "interrupt" });
    expect(parseChatCommand("/compact please")).toEqual({ kind: "usage", command: "compact" });
    expect(parseChatCommand("/mcp")).toEqual({ kind: "usage", command: "mcp" });
    expect(parseChatCommand("/mcp ses_e71285de")).toEqual({ kind: "usage", command: "mcp" });
    expect(parseChatCommand("/killall")).toBeNull();
    expect(parseChatCommand("/mcpx list")).toBeNull();
  });

  it("parses /rename, /tag and /launch", () => {
    expect(parseChatCommand("/rename")).toEqual({ kind: "rename", title: undefined });
    expect(parseChatCommand("/rename  New title ")).toEqual({ kind: "rename", title: "New title" });
    expect(parseChatCommand("/tag")).toMatchObject({ kind: "tag", args: { kind: "top" } });
    expect(parseChatCommand("/tag list")).toMatchObject({ kind: "tag", args: { kind: "list" } });
    expect(parseChatCommand("/launch devbox pigeon hi")).toMatchObject({
      kind: "launch",
      launch: { kind: "launch", machineId: "devbox", prompt: "hi" },
    });
  });

  it("SESSION_REF_RE matches full ids and >=8-char prefixes only", () => {
    expect(SESSION_REF_RE.test("ses_e71285de")).toBe(true);
    expect(SESSION_REF_RE.test("ses_e7128")).toBe(false);
    expect(SESSION_REF_RE.test("--dir")).toBe(false);
  });
});

// ─── Session reference resolution ──────────────────────────────────────────

async function seedSession(sessionId: string, machineId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, 'lbl', ?, ?)`,
  ).bind(sessionId, machineId, now, now).run();
}

describe("resolveSessionRef", () => {
  it("resolves an exact id, then a unique prefix", async () => {
    const base = uniq("ses_ref");
    await seedSession(`${base}aaaa1`, "devbox");
    await seedSession(`${base}bbbb1`, "devbox");
    expect(await resolveSessionRef(env.DB, `${base}aaaa1`)).toMatchObject({ kind: "found", sessionId: `${base}aaaa1` });
    expect(await resolveSessionRef(env.DB, `${base}bb`)).toMatchObject({ kind: "found", sessionId: `${base}bbbb1`, machineId: "devbox" });
  });

  it("prefers the exact id even when it is also a prefix of another", async () => {
    const id = uniq("ses_refx");
    await seedSession(id, "devbox");
    await seedSession(`${id}longer`, "devbox");
    expect(await resolveSessionRef(env.DB, id)).toMatchObject({ kind: "found", sessionId: id });
  });

  it("refuses an ambiguous prefix with the candidates", async () => {
    const base = uniq("ses_amb");
    await seedSession(`${base}1`, "devbox");
    await seedSession(`${base}2`, "cloudbox");
    const res = await resolveSessionRef(env.DB, base);
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") {
      expect(res.candidates.map((c) => c.sessionId).sort()).toEqual([`${base}1`, `${base}2`]);
    }
  });

  it("treats _ literally, not as a LIKE wildcard", async () => {
    const base = uniq("ses_lit");
    await seedSession(`${base}Xtail`, "devbox");
    // `_` as a wildcard would match the X.
    expect((await resolveSessionRef(env.DB, `${base}_tail`)).kind).toBe("none");
  });

  it("reports none for an unknown id", async () => {
    expect((await resolveSessionRef(env.DB, "ses_doesnotexist0000")).kind).toBe("none");
  });
});

describe("post-provider-call topic writes are chat-scoped too", () => {
  it("markClosed and rename with a chatId leave another chat's row alone", async () => {
    const { markClosed, rename } = await import("../src/topics");
    const sessionId = uniq("ses_cas_close_");
    await reserve(env.DB, { sessionId, machineId: "devbox", chatId: SLACK_CHAT, name: "s" });
    await finalize(env.DB, { sessionId, chatId: SLACK_CHAT, messageThreadId: 44, name: "s", provisional: true });
    await markClosed(env.DB, { sessionId, chatId: TG_CHAT });
    await rename(env.DB, { sessionId, chatId: TG_CHAT, name: "renamed" });
    const row = await getBySession(env.DB, sessionId);
    expect(row?.state).toBe("open");
    expect(row?.name).toBe("s");
    await markClosed(env.DB, { sessionId, chatId: SLACK_CHAT });
    expect((await getBySession(env.DB, sessionId))?.state).toBe("closed");
  });
});
