import { env, SELF, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import d1Schema from "../src/d1-schema.sql?raw";
import { handleSendNotification } from "../src/notifications";

/**
 * POST /notifications/send with `rich: {markdown}` (pigeon-p909): the worker tries Telegram's
 * sendRichMessage and, on a rejection, sends the plain text it was given — once, loudly.
 */

const authHeaders = { "Content-Type": "application/json", Authorization: "Bearer test-api-key" };
const SENDER = "ses_richsender000000000000000";
const ALLOWED_CHAT = "8248645256";
const MENTIONED = "ses_e71285defffe4WBGXJlfV2dBZ2";
const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |";

beforeAll(async () => {
  for (const statement of d1Schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  const now = Date.now();
  await env.DB.prepare("DELETE FROM topics").run();
  await env.DB.prepare("DELETE FROM named_topic_bindings").run();
  await env.DB.prepare("DELETE FROM messages").run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO sessions (session_id, machine_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(SENDER, "machine-1", "rich", now, now)
    .run();
});

afterEach(() => {
  fetchMock.deactivate();
  vi.restoreAllMocks();
});

type Reply = { status: number; body: unknown };

function capture(method: "sendMessage" | "sendRichMessage", replies: Reply[]): any[] {
  const sent: any[] = [];
  for (const r of replies) {
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: new RegExp(`/bot.*/${method}$`) })
      .reply(r.status, (opts: any) => {
        const raw = typeof opts.body === "string" ? opts.body : new TextDecoder().decode(opts.body);
        sent.push(JSON.parse(raw));
        return r.body as any;
      });
  }
  return sent;
}

const ok = (id: number): Reply => ({ status: 200, body: { ok: true, result: { message_id: id } } });
const badRequest: Reply = {
  status: 400,
  body: { ok: false, error_code: 400, description: "Bad Request: can't parse rich message" },
};

function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: SENDER,
    chatId: ALLOWED_CHAT,
    threaded: false,
    text: "plain chunk 0",
    notificationId: "s:rich:1",
    rich: { markdown: TABLE },
    ...extra,
  };
}

function send(extra: Record<string, unknown> = {}): Promise<Response> {
  return SELF.fetch("https://worker/notifications/send", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(body(extra)),
  });
}

describe("POST /notifications/send with rich", () => {
  it("sends one rich message, records it for reply routing, and reports rich: sent", async () => {
    const rich = capture("sendRichMessage", [ok(701)]);
    const res = await send();
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ ok: true, messageId: 701, rich: "sent" });

    expect(rich).toHaveLength(1);
    expect(rich[0].chat_id).toBe(ALLOWED_CHAT);
    expect(rich[0].rich_message).toEqual({ markdown: TABLE });
    expect(rich[0].message_thread_id).toBeUndefined();

    const row = await env.DB.prepare("SELECT session_id, notification_id FROM messages WHERE message_id = 701").first<any>();
    expect(row).toEqual({ session_id: SENDER, notification_id: "s:rich:1" });
  });

  it("falls back to the plain text once on a 400, and says so", async () => {
    const warn = vi.spyOn(console, "warn");
    const rich = capture("sendRichMessage", [badRequest]);
    const plain = capture("sendMessage", [ok(702)]);
    const res = await send();
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ ok: true, messageId: 702, rich: "fallback" });
    expect(json.richError).toMatchObject({ error_code: 400 });

    expect(rich).toHaveLength(1);
    expect(plain).toHaveLength(1);
    expect(plain[0].text).toBe("plain chunk 0");
    expect(warn).toHaveBeenCalledWith(
      "[worker] rich message rejected, sending plain",
      expect.objectContaining({ sessionId: SENDER }),
    );
  });

  it("does not fall back on a 5xx: the outbox retries the rich send", async () => {
    capture("sendRichMessage", [{ status: 500, body: { ok: false, error_code: 500, description: "Internal" } }]);
    const res = await send();
    expect(res.status).toBe(502);
  });

  it("passes a 429 through as a rate limit", async () => {
    capture("sendRichMessage", [
      { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } } },
    ]);
    const res = await send();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited", retryAfter: 7 });
  });

  it("sends plain and adds no rich field when the request has no rich", async () => {
    const plain = capture("sendMessage", [ok(703)]);
    const res = await send({ rich: undefined });
    const json = (await res.json()) as any;
    expect(plain).toHaveLength(1);
    expect(json).not.toHaveProperty("rich");
  });

  it("ignores a malformed rich field", async () => {
    const plain = capture("sendMessage", [ok(704)]);
    const res = await send({ rich: { markdown: 5 } });
    expect(plain).toHaveLength(1);
    expect(await res.json()).not.toHaveProperty("rich");
  });

  it("skips rich for markdown over Telegram's 32768-character limit", async () => {
    const plain = capture("sendMessage", [ok(705)]);
    const res = await send({ rich: { markdown: TABLE + "x".repeat(32768) } });
    expect(plain).toHaveLength(1);
    expect(await res.json()).toMatchObject({ rich: "fallback" });
  });

  it("is disabled by TELEGRAM_RICH_MESSAGES=off", async () => {
    const plain = capture("sendMessage", [ok(706)]);
    const offEnv = { ...env, TELEGRAM_RICH_MESSAGES: "off" } as Env;
    const res = await handleSendNotification(
      env.DB,
      offEnv,
      new Request("https://worker/notifications/send", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(body()),
      }),
    );
    expect(plain).toHaveLength(1);
    expect(await res.json()).toMatchObject({ rich: "fallback" });
  });

  it("builds mention buttons from the markdown for rich, and from the plain text for the fallback", async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO topics (session_id, machine_id, chat_id, message_thread_id, name, state, created_at, updated_at)
       VALUES (?, 'm1', '-1001234567890', 77, 'Worker A', 'open', 1, 1)`,
    )
      .bind(MENTIONED)
      .run();
    const rich = capture("sendRichMessage", [badRequest]);
    const plain = capture("sendMessage", [ok(707)]);
    await send({ rich: { markdown: `${TABLE}\n\nsee ses_e71285de` } });
    expect(rich[0].reply_markup?.inline_keyboard?.[0]?.[0]?.text).toBe("Worker A");
    expect(plain[0].reply_markup).toBeUndefined();
  });

  describe("in a forum topic", () => {
    const CHAT_ID = ALLOWED_CHAT;
    const topicsEnv = () => ({ ...env, TELEGRAM_TOPICS_ENABLED: "true" }) as Env;

    async function bind(threadId: number): Promise<void> {
      const now = Date.now();
      const key = `rich:${threadId}`;
      await env.DB.prepare(
        "INSERT OR REPLACE INTO named_topics (chat_id, topic_key, message_thread_id, name, created_at, updated_at) VALUES (?, ?, ?, 'T', ?, ?)",
      ).bind(CHAT_ID, key, threadId, now, now).run();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO named_topic_bindings (chat_id, topic_key, session_id, bound_at) VALUES (?, ?, ?, ?)",
      ).bind(CHAT_ID, key, SENDER, now).run();
    }

    function sendThreaded(): Promise<Response> {
      return handleSendNotification(
        env.DB,
        topicsEnv(),
        new Request("https://worker/notifications/send", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(body({ threaded: true })),
        }),
      );
    }

    it("routes the rich message into the topic", async () => {
      await bind(4401);
      const rich = capture("sendRichMessage", [ok(708)]);
      const res = await sendThreaded();
      expect(res.status).toBe(200);
      expect(rich[0].message_thread_id).toBe(4401);
    });

    it("keeps the topic for the plain fallback", async () => {
      await bind(4402);
      capture("sendRichMessage", [badRequest]);
      const plain = capture("sendMessage", [ok(709)]);
      await sendThreaded();
      expect(plain[0].message_thread_id).toBe(4402);
    });

    it("treats thread-not-found as a topic problem, not a rich rejection", async () => {
      await bind(4403);
      const rich = capture("sendRichMessage", [
        { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: message thread not found" } },
        ok(710),
      ]);
      const res = await sendThreaded();
      expect(await res.json()).toMatchObject({ rich: "sent" });
      // Bound sessions relocate to General rather than recreate: still rich.
      expect(rich).toHaveLength(2);
      expect(rich[1].message_thread_id).toBeUndefined();
    });
  });
});
