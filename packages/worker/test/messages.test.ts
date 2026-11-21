/**
 * Session-free sends (chat-transport phase 1, bead pigeon-lenr.1; design
 * docs/plans/2026-11-20-telegram-single-egress-design.md, "Worker PR").
 *
 * The result contract is what the daemon's fallback hinges on: a Telegram 400 or 429 rides in a
 * 200 body ("Telegram said no" -- do not fall back), everything else that is not a clean post is
 * a 502 or a 403 ("worker cannot deliver" -- fall back direct). Through the real router.
 */
import { env, fetchMock } from "cloudflare:test";
import { describe, test, expect, beforeAll, beforeEach, afterEach } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import worker from "../src/index";
import { MESSAGES_SEND_MAX_TIMEOUT_MS } from "../src/messages";
import { SLACK_HANDLE_MIN, slackChatId } from "../src/chat/slack-config";
import {
  envWith,
  mkSlackMachine,
  posted,
  resetSlackCalls,
  seedAlerts,
  seedChannel,
  slack,
  slackCalls,
  stamp,
  type SlackMachine,
} from "./slack-harness";

const CHAT = "8248645256";

/** Through the real router, against `e` (the test env, or one carrying a Slack workspace). */
async function callWith(e: Env, path: string, body: unknown, key: string | null = "test-api-key"): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  return worker.fetch(
    new Request(`https://worker${path}`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    e,
  );
}

async function call(
  path: string,
  body: unknown,
  key: string | null = "test-api-key",
  envOverride: Partial<Env> = {},
): Promise<Response> {
  return callWith({ ...env, ...envOverride } as Env, path, body, key);
}

/** Intercept one Telegram method; returns the parsed request bodies it received. */
function onTelegram(
  method: string,
  reply: { status?: number; data: unknown; raw?: boolean },
  delayMs = 0,
): any[] {
  const calls: any[] = [];
  const interceptor = fetchMock
    .get("https://api.telegram.org")
    .intercept({ method: "POST", path: new RegExp(`/bot.*/${method}$`) })
    .reply((opts: any) => {
      calls.push(JSON.parse(opts.body as string));
      return {
        statusCode: reply.status ?? 200,
        data: reply.raw ? (reply.data as string) : JSON.stringify(reply.data),
        responseOptions: { headers: { "Content-Type": "application/json" } },
      };
    });
  if (delayMs > 0) interceptor.delay(delayMs);
  interceptor.persist();
  return calls;
}

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((x) => x.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  resetSlackCalls();
});
afterEach(() => {
  fetchMock.get("https://api.telegram.org").cleanMocks();
  fetchMock.get("https://slack.com").cleanMocks();
  fetchMock.deactivate();
});

// ─── the route contract, on Slack ──────────────────────────────────────────

describe("POST /messages/send (Slack)", () => {
  let m: SlackMachine;
  let e: Env;
  let CH: string;
  let alertsChannel: string;
  let threadChannel: string;
  let thread: number;

  beforeEach(async () => {
    m = await mkSlackMachine();
    e = envWith([m]);
    CH = slackChatId(m.ws);
    alertsChannel = await seedAlerts(m.ws);
    threadChannel = `CT${stamp()}`.toUpperCase();
    thread = await seedChannel(m.ws.teamId, threadChannel);
  });

  const send = (body: unknown, key: string | null = m.key) => callWith(e, "/messages/send", body, key);
  const slackRaw = (reply: { status?: number; data: string; delayMs?: number }) => {
    const interceptor = fetchMock
      .get("https://slack.com")
      .intercept({ method: "POST", path: "/api/chat.postMessage" })
      .reply(reply.status ?? 200, reply.data, { headers: { "Content-Type": "application/json" } });
    if (reply.delayMs) interceptor.delay(reply.delayMs);
  };
  const blocksOf = (i = 0) => JSON.parse(slackCalls[i]!.params.get("blocks") ?? "[]") as Array<Record<string, any>>;

  test("requires auth", async () => {
    expect((await send({ chatId: CH, text: "x" }, null)).status).toBe(401);
    expect((await send({ chatId: CH, text: "x" }, "wrong")).status).toBe(401);
  });

  test("rejects a malformed body with 400", async () => {
    expect((await send("not json")).status).toBe(400);
    expect((await send({ chatId: CH })).status).toBe(400);
    expect((await send({ text: "x" })).status).toBe(400);
    expect((await send({ chatId: CH, text: "x", messageThreadId: "7" })).status).toBe(400);
    expect((await send({ chatId: CH, text: "x", urlButtons: [[{ text: "a" }]] })).status).toBe(400);
    expect((await send({ chatId: CH, text: "x", timeoutMs: -1 })).status).toBe(400);
  });

  test("the shared key and a chat of an unconfigured team are 403 chat_not_allowed and call nothing", async () => {
    const shared = await send({ chatId: CH, text: "x" }, "test-api-key");
    expect(shared.status).toBe(403);
    expect(await shared.json()).toEqual({ error: "chat_not_allowed" });
    const stranger = await send({ chatId: "slack:TNOSUCHTEAM", text: "x" });
    expect(stranger.status).toBe(403);
    expect(await stranger.json()).toEqual({ error: "chat_not_allowed" });
    expect(slackCalls).toHaveLength(0);
  });

  test("posts and answers ok with the message handle, passing the thread and URL buttons through", async () => {
    slack("chat.postMessage", posted(threadChannel));
    const urlButtons = [[{ text: "PR", url: "https://github.com/x/y/pull/1" }]];
    const entities = [{ type: "bold", offset: 0, length: 2 }];
    const res = await send({ chatId: CH, text: "hi there", entities, messageThreadId: thread, urlButtons });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; messageId: number; chatId: string };
    expect(body).toMatchObject({ ok: true, chatId: CH });
    expect(body.messageId).toBeGreaterThanOrEqual(SLACK_HANDLE_MIN);
    expect(slackCalls[0]!.params.get("channel")).toBe(threadChannel);
    expect(slackCalls[0]!.params.get("text")).toContain("hi there");
    expect(blocksOf().filter((b) => b.type === "actions")).toMatchObject([
      { elements: [{ type: "button", url: "https://github.com/x/y/pull/1" }] },
    ]);
  });

  test("a send with no thread goes to the workspace's #alerts", async () => {
    slack("chat.postMessage", posted(alertsChannel));
    const res = await send({ chatId: CH, text: "plain" });
    expect(res.status).toBe(200);
    expect(slackCalls[0]!.params.get("channel")).toBe(alertsChannel);
    expect(slackCalls[0]!.params.get("text")).toBe("plain");
  });

  test("a vanished conversation rides in a 200 with its description and class", async () => {
    slack("chat.postMessage", { ok: false, error: "channel_not_found" });
    const res = await send({ chatId: CH, text: "x", messageThreadId: thread });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      telegram: { status: 400, description: "thread not found: channel_not_found" },
      errorClass: "conversation_gone",
    });
  });

  test("a rate limit rides in a 200 with retryAfter", async () => {
    slack("chat.postMessage", { ok: false, error: "ratelimited" }, 429, { "retry-after": "7" });
    const res = await send({ chatId: CH, text: "x" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      telegram: { status: 429, retryAfter: 7, description: "slack rate limited: ratelimited" },
      errorClass: "rate_limited",
    });
  });

  test.each([500, 502, 503])("an upstream %i is a 502 (the worker cannot deliver; the daemon falls back)", async (status) => {
    slack("chat.postMessage", { ok: false, error: "fatal_error" }, status);
    const res = await send({ chatId: CH, text: "x" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.telegram).toMatchObject({ status: 502 });
    expect(body.errorClass).toBe("upstream");
  });

  test("an unparseable 200 is a 502, never a 400 (the send may have happened)", async () => {
    slackRaw({ data: "{not json" });
    const res = await send({ chatId: CH, text: "x" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).ok).toBe(false);
  });

  test("a call slower than timeoutMs is aborted and answered 502", async () => {
    slackRaw({ data: JSON.stringify(posted(alertsChannel)), delayMs: 2_000 });
    const started = Date.now();
    const res = await send({ chatId: CH, text: "x", timeoutMs: 100 });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toMatch(/timed out|abort/i);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("a transport failure is a 502, not an unhandled 500", async () => {
    fetchMock
      .get("https://slack.com")
      .intercept({ method: "POST", path: "/api/chat.postMessage" })
      .replyWithError(new Error("socket hang up"));
    const res = await send({ chatId: CH, text: "x" });
    expect(res.status).toBe(502);
  });

  test("explicit null optional fields mean absent, not a 400 (a 400 would make the daemon fall back)", async () => {
    slack("chat.postMessage", posted(alertsChannel));
    const res = await send({
      chatId: CH,
      text: "x",
      messageThreadId: null,
      entities: null,
      urlButtons: null,
      timeoutMs: null,
    });
    expect(res.status).toBe(200);
    expect(slackCalls[0]!.params.get("channel")).toBe(alertsChannel);
    expect(blocksOf().filter((b) => b.type === "actions")).toEqual([]);
  });

  test("a non-JSON HTTP 400 (not Slack speaking) is a 502, not 'the provider said no'", async () => {
    slackRaw({ status: 400, data: "<html>bad gateway-ish</html>" });
    const res = await send({ chatId: CH, text: "x" });
    expect(res.status).toBe(502);
  });

  test("URL buttons are rebuilt as {text, url}; extra keys never reach the provider", async () => {
    slack("chat.postMessage", posted(alertsChannel));
    await send({
      chatId: CH,
      text: "x",
      urlButtons: [[{ text: "a", url: "https://e.x/1", callback_data: "cmd:T:x" }]],
    });
    const buttons = blocksOf().filter((b) => b.type === "actions").flatMap((b) => b.elements);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatchObject({ url: "https://e.x/1" });
    expect(buttons[0]).not.toHaveProperty("value");
  });

  test("timeoutMs above the cap is rejected", async () => {
    const res = await send({ chatId: CH, text: "x", timeoutMs: MESSAGES_SEND_MAX_TIMEOUT_MS + 1 });
    expect(res.status).toBe(400);
  });
});

describe("POST /topics/unpin (Slack)", () => {
  test("requires auth, a machine of that workspace and a thread; answers ok without calling Slack", async () => {
    const m = await mkSlackMachine();
    const e = envWith([m]);
    const CH = slackChatId(m.ws);
    expect((await callWith(e, "/topics/unpin", { chatId: CH, messageThreadId: 3 }, null)).status).toBe(401);
    expect((await callWith(e, "/topics/unpin", { chatId: CH, messageThreadId: 3 }, "test-api-key")).status).toBe(403);
    expect((await callWith(e, "/topics/unpin", { chatId: CH }, m.key)).status).toBe(400);
    const res = await callWith(e, "/topics/unpin", { chatId: CH, messageThreadId: 31 }, m.key);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(slackCalls).toHaveLength(0);
  });
});

// ─── Telegram-only: left for the deletion of the Telegram client ───────────

describe("POST /messages/send (Telegram)", () => {
  test("requires auth", async () => {
    expect((await call("/messages/send", { chatId: CHAT, text: "x" }, null)).status).toBe(401);
    expect((await call("/messages/send", { chatId: CHAT, text: "x" }, "wrong")).status).toBe(401);
  });

  test("rejects a malformed body with 400", async () => {
    expect((await call("/messages/send", "not json")).status).toBe(400);
    expect((await call("/messages/send", { chatId: CHAT })).status).toBe(400);
    expect((await call("/messages/send", { text: "x" })).status).toBe(400);
    expect((await call("/messages/send", { chatId: CHAT, text: "x", messageThreadId: "7" })).status).toBe(400);
    expect((await call("/messages/send", { chatId: CHAT, text: "x", urlButtons: [[{ text: "a" }]] })).status).toBe(400);
    expect((await call("/messages/send", { chatId: CHAT, text: "x", timeoutMs: -1 })).status).toBe(400);
  });

  test("a chat outside ALLOWED_CHAT_IDS is 403 chat_not_allowed and calls nothing", async () => {
    const sends = onTelegram("sendMessage", { data: { ok: true, result: { message_id: 1 } } });
    const res = await call("/messages/send", { chatId: "-1009999", text: "x" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "chat_not_allowed" });
    expect(sends).toHaveLength(0);
  });

  test("posts and answers ok with the message id, passing entities, thread and URL buttons through", async () => {
    const sends = onTelegram("sendMessage", { data: { ok: true, result: { message_id: 4242 } } });
    const entities = [{ type: "bold", offset: 0, length: 2 }];
    const urlButtons = [[{ text: "PR", url: "https://github.com/x/y/pull/1" }]];
    const res = await call("/messages/send", { chatId: CHAT, text: "hi there", entities, messageThreadId: 77, urlButtons });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, messageId: 4242 });
    expect(sends).toEqual([
      {
        chat_id: CHAT,
        text: "hi there",
        entities,
        message_thread_id: 77,
        reply_markup: { inline_keyboard: urlButtons },
      },
    ]);
  });

  test("passes messageThreadId through even with topics disabled", async () => {
    const sends = onTelegram("sendMessage", { data: { ok: true, result: { message_id: 1 } } });
    await call("/messages/send", { chatId: CHAT, text: "x", messageThreadId: 9 }, "test-api-key", {
      TELEGRAM_TOPICS_ENABLED: "false",
    });
    expect(sends[0].message_thread_id).toBe(9);
  });

  test("a minimal send carries no optional fields", async () => {
    const sends = onTelegram("sendMessage", { data: { ok: true, result: { message_id: 1 } } });
    await call("/messages/send", { chatId: CHAT, text: "plain" });
    expect(sends).toEqual([{ chat_id: CHAT, text: "plain" }]);
  });

  test("Telegram 400 rides in a 200 with its description (thread not found included)", async () => {
    onTelegram("sendMessage", { status: 400, data: { ok: false, error_code: 400, description: "Bad Request: message thread not found" } });
    const res = await call("/messages/send", { chatId: CHAT, text: "x", messageThreadId: 5 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      telegram: { status: 400, description: "Bad Request: message thread not found" },
    });
  });

  test("Telegram 429 rides in a 200 with retryAfter", async () => {
    onTelegram("sendMessage", {
      status: 429,
      data: { ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7 } },
    });
    const res = await call("/messages/send", { chatId: CHAT, text: "x" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      telegram: { status: 429, retryAfter: 7, description: "Too Many Requests: retry after 7" },
    });
  });

  test.each([401, 403, 404, 500])("Telegram %i is a 502 (the worker cannot deliver; the daemon falls back)", async (status) => {
    onTelegram("sendMessage", { status, data: { ok: false, error_code: status, description: `err ${status}` } });
    const res = await call("/messages/send", { chatId: CHAT, text: "x" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.telegram).toEqual({ status, description: `err ${status}` });
  });

  test("an unparseable Telegram 200 is a 502, never a 400 (the send may have happened)", async () => {
    onTelegram("sendMessage", { status: 200, data: "{not json", raw: true });
    const res = await call("/messages/send", { chatId: CHAT, text: "x" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).ok).toBe(false);
  });

  test("a Telegram call slower than timeoutMs is aborted and answered 502", async () => {
    onTelegram("sendMessage", { data: { ok: true, result: { message_id: 1 } } }, 2_000);
    const started = Date.now();
    const res = await call("/messages/send", { chatId: CHAT, text: "x", timeoutMs: 100 });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toMatch(/timed out|abort/i);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("a transport failure is a 502, not an unhandled 500", async () => {
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: /\/bot.*\/sendMessage$/ })
      .replyWithError(new Error("socket hang up"));
    const res = await call("/messages/send", { chatId: CHAT, text: "x" });
    expect(res.status).toBe(502);
  });

  test("explicit null optional fields mean absent, not a 400 (a 400 would make the daemon fall back)", async () => {
    const sends = onTelegram("sendMessage", { data: { ok: true, result: { message_id: 3 } } });
    const res = await call("/messages/send", {
      chatId: CHAT,
      text: "x",
      messageThreadId: null,
      entities: null,
      urlButtons: null,
      timeoutMs: null,
    });
    expect(res.status).toBe(200);
    expect(sends).toEqual([{ chat_id: CHAT, text: "x" }]);
  });

  test("a non-JSON HTTP 400 (not Telegram speaking) is a 502, not 'Telegram said no'", async () => {
    onTelegram("sendMessage", { status: 400, data: "<html>bad gateway-ish</html>", raw: true });
    const res = await call("/messages/send", { chatId: CHAT, text: "x" });
    expect(res.status).toBe(502);
  });

  test("URL buttons are rebuilt as {text, url}; extra keys never reach Telegram", async () => {
    const sends = onTelegram("sendMessage", { data: { ok: true, result: { message_id: 1 } } });
    await call("/messages/send", {
      chatId: CHAT,
      text: "x",
      urlButtons: [[{ text: "a", url: "https://e.x/1", callback_data: "cmd:T:x" }]],
    });
    expect(sends[0].reply_markup).toEqual({ inline_keyboard: [[{ text: "a", url: "https://e.x/1" }]] });
  });

  test("timeoutMs above the cap is rejected", async () => {
    const res = await call("/messages/send", { chatId: CHAT, text: "x", timeoutMs: MESSAGES_SEND_MAX_TIMEOUT_MS + 1 });
    expect(res.status).toBe(400);
  });
});

describe("POST /topics/unpin (Telegram)", () => {
  test("requires auth and an allowed chat", async () => {
    expect((await call("/topics/unpin", { chatId: CHAT, messageThreadId: 3 }, null)).status).toBe(401);
    expect((await call("/topics/unpin", { chatId: "-1009999", messageThreadId: 3 })).status).toBe(403);
    expect((await call("/topics/unpin", { chatId: CHAT })).status).toBe(400);
  });

  test("unpins and answers ok", async () => {
    const calls = onTelegram("unpinAllForumTopicMessages", { data: { ok: true, result: true } });
    const res = await call("/topics/unpin", { chatId: CHAT, messageThreadId: 31 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual([{ chat_id: CHAT, message_thread_id: 31 }]);
  });

  test("a Telegram 400 rides in a 200; anything else is a 502", async () => {
    onTelegram("unpinAllForumTopicMessages", { status: 400, data: { ok: false, error_code: 400, description: "Bad Request: not enough rights" } });
    const res = await call("/topics/unpin", { chatId: CHAT, messageThreadId: 31 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, telegram: { status: 400, description: "Bad Request: not enough rights" } });
  });
});
