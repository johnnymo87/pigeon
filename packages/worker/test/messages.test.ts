/**
 * Session-free sends (chat-transport phase 1, bead pigeon-lenr.1; design
 * docs/plans/2026-11-20-telegram-single-egress-design.md, "Worker PR").
 *
 * The result contract is what the daemon's fallback hinges on: a provider 400 or 429 rides in a
 * 200 body (`provider: {status}`; a daemon reads it as "do not fall back"),
 * everything else that is not a clean post is a 502 or a 403 ("worker cannot deliver" -- fall back
 * direct). Through the real router.
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
      provider: { status: 400, description: "thread not found: channel_not_found" },
      errorClass: "conversation_gone",
    });
  });

  test("a rate limit rides in a 200 with retryAfter", async () => {
    slack("chat.postMessage", { ok: false, error: "ratelimited" }, 429, { "retry-after": "7" });
    const res = await send({ chatId: CH, text: "x" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      provider: { status: 429, retryAfter: 7, description: "slack rate limited: ratelimited" },
      errorClass: "rate_limited",
    });
  });

  test.each([500, 502, 503])("an upstream %i is a 502 (the worker cannot deliver; the daemon falls back)", async (status) => {
    slack("chat.postMessage", { ok: false, error: "fatal_error" }, status);
    const res = await send({ chatId: CH, text: "x" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.provider).toMatchObject({ status: 502 });
    expect(body.error).toBe("provider_error");
    expect(body).not.toHaveProperty("telegram");
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
    expect(((await res.json()) as any).error).toMatch(/^provider call (timed out|failed)/);
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

describe("POST /topics/unpin", () => {
  // pigeon-4ogz.25: removed; no daemon >= 7f4554f calls it.
  test("is gone: the router answers 404, with no provider call", async () => {
    const m = await mkSlackMachine();
    const res = await callWith(envWith([m]), "/topics/unpin", { chatId: slackChatId(m.ws), messageThreadId: 31 }, m.key);
    expect(res.status).toBe(404);
    expect(slackCalls).toHaveLength(0);
  });
});
