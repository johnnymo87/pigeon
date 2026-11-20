import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { PLAIN_ALERT_TIMEOUT_MS, TelegramSendError } from "../src/notification-service";
import {
  createAlertNotifier,
  describeAlertDelivery,
  FALLBACK_ALERT_THROTTLE_MS,
  TELEGRAM_MAX_TEXT,
} from "../src/alert-notifier";
import { DirectTelegramAlarm } from "../src/direct-telegram-alarm";
import { WorkerMessageClient } from "../src/worker/worker-message-client";
import { AlertDrainer } from "../src/swarm/alert-drainer";

const WORKER = "https://worker.example";
const CHAT = "-1001234567890";

type Handler = (body: Record<string, unknown>, url: string) => Response | Promise<Response>;

/**
 * One mocked fetch for both legs, routed by URL, so these tests exercise the REAL composed
 * notifier (worker client + direct alarm), not a mock of it.
 */
function makeFetch(handlers: { worker?: Handler; unpin?: Handler; direct?: Handler }) {
  const calls: Array<{ leg: "worker" | "unpin" | "direct"; url: string; body: Record<string, unknown> }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    let leg: "worker" | "unpin" | "direct";
    if (url === `${WORKER}/messages/send`) leg = "worker";
    else if (url === `${WORKER}/topics/unpin`) leg = "unpin";
    else if (url.startsWith("https://api.telegram.org/")) leg = "direct";
    else throw new Error(`unexpected url ${url}`);
    calls.push({ leg, url, body });
    const h = handlers[leg];
    if (!h) throw new Error(`no handler for ${leg}`);
    return h(body, url);
  });
  return { fetch: fn as unknown as typeof fetch, calls, fn };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const workerOk: Handler = () => json({ ok: true, messageId: 1 });
const directOk: Handler = () => json({ ok: true, result: { message_id: 2 } });
const hang: Handler = () => new Promise<Response>(() => {});

function build(
  fetchFn: typeof fetch,
  opts: { worker?: boolean; direct?: boolean; storage?: StorageDb; machineId?: string } = {},
) {
  const worker = opts.worker === false ? undefined : new WorkerMessageClient({ workerUrl: WORKER, apiKey: "k", fetchFn });
  const direct = opts.direct === false ? undefined : new DirectTelegramAlarm("tok", CHAT, fetchFn);
  return createAlertNotifier({
    chatId: CHAT,
    worker,
    direct,
    alerts: opts.storage?.alerts,
    machineId: opts.machineId,
    log: () => {},
  });
}

let storage: StorageDb;
beforeEach(() => {
  storage = openStorageDb(":memory:");
});
afterEach(() => {
  vi.useRealTimers();
  storage.db.close();
});

function healthAlerts() {
  return storage.db
    .prepare("SELECT * FROM operational_alerts WHERE source = 'worker-health-fallback'")
    .all() as Array<{ ref_msg_id: string; text: string }>;
}

describe("createAlertNotifier: mode", () => {
  it("describes the four startup states", () => {
    expect(describeAlertDelivery({ worker: true, direct: true })).toBe("worker+direct-fallback");
    expect(describeAlertDelivery({ worker: true, direct: false })).toBe("worker-only");
    expect(describeAlertDelivery({ worker: false, direct: true })).toBe("direct-only");
    expect(describeAlertDelivery({ worker: false, direct: false })).toBe("UNAVAILABLE");
  });

  it("is undefined with neither path", () => {
    expect(createAlertNotifier({ chatId: CHAT })).toBeUndefined();
  });
});

describe("AlertNotifier.sendPlainAlert", () => {
  it("worker 200 ok: one worker post with the severity prefix, nothing direct", async () => {
    const f = makeFetch({ worker: workerOk });
    await build(f.fetch, { storage })!.sendPlainAlert!("boom", "error");
    expect(f.calls.map((c) => c.leg)).toEqual(["worker"]);
    expect(f.calls[0]!.body).toEqual({ chatId: CHAT, text: "❌ boom" });
    expect(healthAlerts()).toHaveLength(0);
  });

  it("carries the thread and the url buttons to the worker", async () => {
    const f = makeFetch({ worker: workerOk });
    const replyMarkup = { inline_keyboard: [[{ text: "a", url: "https://t.me/c/1/2" }]] };
    await build(f.fetch)!.sendPlainAlert!("x", "info", { messageThreadId: 7, replyMarkup });
    expect(f.calls[0]!.body).toEqual({ chatId: CHAT, text: "x", messageThreadId: 7, urlButtons: replyMarkup.inline_keyboard });
  });

  it("Telegram 400 relayed by the worker throws TelegramSendError(400) with the description and does NOT go direct", async () => {
    const f = makeFetch({
      worker: () => json({ ok: false, telegram: { status: 400, description: "Bad Request: message thread not found" } }),
      direct: directOk,
    });
    const err = await build(f.fetch, { storage })!.sendPlainAlert!("x", "info").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramSendError);
    expect((err as TelegramSendError).status).toBe(400);
    expect((err as TelegramSendError).description).toBe("Bad Request: message thread not found");
    expect(f.calls.map((c) => c.leg)).toEqual(["worker"]);
    expect(healthAlerts()).toHaveLength(0);
  });

  it("Telegram 429 relayed by the worker throws TelegramSendError(429) and does NOT go direct", async () => {
    const f = makeFetch({
      worker: () => json({ ok: false, telegram: { status: 429, retryAfter: 5, description: "Too Many Requests" } }),
      direct: directOk,
    });
    const err = await build(f.fetch)!.sendPlainAlert!("x", "info").catch((e: unknown) => e);
    expect((err as TelegramSendError).status).toBe(429);
    expect(f.calls.map((c) => c.leg)).toEqual(["worker"]);
  });

  for (const [name, handler, reasonPart] of [
    ["worker 404 (route not deployed)", () => new Response("not found", { status: 404 }), "HTTP 404"],
    ["worker 502 relaying a Telegram 401", () => json({ error: "telegram_error", telegram: { status: 401, description: "Unauthorized" } }, 502), "Telegram 401"],
    ["worker 200 with a non-JSON body", () => new Response("<html>", { status: 200 }), "non-JSON"],
    ["worker 403 chat_not_allowed", () => json({ error: "chat_not_allowed" }, 403), "chat_not_allowed"],
    ["worker transport error", () => { throw new TypeError("fetch failed"); }, "transport"],
  ] as Array<[string, Handler, string]>) {
    it(`${name}: falls back direct, with a visible suffix, and records one health alert`, async () => {
      const f = makeFetch({ worker: handler, direct: directOk });
      await build(f.fetch, { storage })!.sendPlainAlert!("boom", "warning");
      expect(f.calls.map((c) => c.leg)).toEqual(["worker", "direct"]);
      const text = String(f.calls[1]!.body.text);
      expect(text.startsWith("⚠️ boom · sent direct; worker: ")).toBe(true);
      expect(text).toContain(reasonPart);
      expect(f.calls[1]!.body.chat_id).toBe(CHAT);
      expect(healthAlerts()).toHaveLength(1);
    });
  }

  it("a direct-leg Telegram 400 still throws TelegramSendError(400) for the /alert ladder", async () => {
    const f = makeFetch({
      worker: () => new Response("", { status: 404 }),
      direct: () => json({ ok: false, description: "Bad Request: message thread not found" }, 400),
    });
    const err = await build(f.fetch)!.sendPlainAlert!("x", "info", { messageThreadId: 3 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramSendError);
    expect((err as TelegramSendError).description).toContain("thread not found");
    expect(f.calls[1]!.body.message_thread_id).toBe(3);
  });

  it("hung worker: gives up at 5s and lands direct within PLAIN_ALERT_TIMEOUT_MS overall", async () => {
    vi.useFakeTimers();
    const f = makeFetch({ worker: hang, direct: directOk });
    const started = Date.now();
    const p = build(f.fetch)!.sendPlainAlert!("x", "info");
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
    expect(Date.now() - started).toBeLessThanOrEqual(PLAIN_ALERT_TIMEOUT_MS);
    expect(f.calls.map((c) => c.leg)).toEqual(["worker", "direct"]);
    expect(String(f.calls[1]!.body.text)).toContain("worker: timed out after 5000ms");
  });

  it("hung worker AND hung direct: the whole call settles within PLAIN_ALERT_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const f = makeFetch({ worker: hang, direct: hang });
    const settled = build(f.fetch)!.sendPlainAlert!("x", "info").then(() => "resolved", (e: unknown) => String(e));
    await vi.advanceTimersByTimeAsync(PLAIN_ALERT_TIMEOUT_MS);
    expect(await settled).toContain("timed out");
  });

  it("a short caller budget shrinks the worker leg so the direct leg still has time", async () => {
    vi.useFakeTimers();
    const f = makeFetch({ worker: hang, direct: directOk });
    const p = build(f.fetch)!.sendPlainAlert!("x", "info", { timeoutMs: 3_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    await p;
    expect(f.calls.map((c) => c.leg)).toEqual(["worker", "direct"]);
  });

  it("under 2s of budget with a direct path: direct only, worker not tried", async () => {
    const f = makeFetch({ worker: workerOk, direct: directOk });
    await build(f.fetch, { storage })!.sendPlainAlert!("x", "info", { timeoutMs: 1_500 });
    expect(f.calls.map((c) => c.leg)).toEqual(["direct"]);
    expect(String(f.calls[0]!.body.text)).toContain("sent direct; worker: not tried");
    expect(healthAlerts()).toHaveLength(0);
  });

  it("worker-only host: under 2s still tries the worker with what is left", async () => {
    const f = makeFetch({ worker: workerOk });
    await build(f.fetch, { direct: false })!.sendPlainAlert!("x", "info", { timeoutMs: 1_500 });
    expect(f.calls.map((c) => c.leg)).toEqual(["worker"]);
  });

  it("worker-only host: a broken worker throws, and is still recorded once", async () => {
    const f = makeFetch({ worker: () => new Response("", { status: 503 }) });
    const n = build(f.fetch, { direct: false, storage })!;
    await expect(n.sendPlainAlert!("x", "info")).rejects.toThrow(/messages\/send.*503/);
    await expect(n.sendPlainAlert!("y", "info")).rejects.toThrow();
    expect(healthAlerts()).toHaveLength(1);
    expect(healthAlerts()[0]!.text).toMatch(/no direct Telegram path/);
  });

  it("direct-only host: posts direct with no suffix (nothing is broken)", async () => {
    const f = makeFetch({ direct: directOk });
    await build(f.fetch, { worker: false, storage })!.sendPlainAlert!("x", "error");
    expect(f.calls.map((c) => c.leg)).toEqual(["direct"]);
    expect(f.calls[0]!.body.text).toBe("❌ x");
    expect(healthAlerts()).toHaveLength(0);
  });

  it("truncates the body so text + suffix stays within Telegram's 4096", async () => {
    const f = makeFetch({ worker: () => new Response("", { status: 404 }), direct: directOk });
    await build(f.fetch)!.sendPlainAlert!("a".repeat(5_000), "error");
    const text = String(f.calls[1]!.body.text);
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
    expect(text).toMatch(/… · sent direct; worker: HTTP 404$/);
  });

  it("truncation never splits a surrogate pair", async () => {
    const f = makeFetch({ worker: () => new Response("", { status: 404 }), direct: directOk });
    await build(f.fetch)!.sendPlainAlert!("😀".repeat(3_000), "info");
    const text = String(f.calls[1]!.body.text);
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("AlertNotifier: the fallback health alert cannot loop", () => {
  it("a worker broken for a window yields at most one health alert per reason, even when draining that alert itself", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const f = makeFetch({ worker: () => new Response("", { status: 404 }), direct: directOk });
    const notifier = build(f.fetch, { storage })!;
    const drainer = new AlertDrainer({ storage, notifier: notifier as Required<typeof notifier>, nowFn: () => Date.now() });

    storage.alerts.enqueue({ source: "test", text: "first", severity: "info" });
    for (let i = 0; i < 40; i++) {
      await drainer.drainOnce();
      await vi.advanceTimersByTimeAsync(30_000); // 20 minutes in total
    }
    expect(healthAlerts()).toHaveLength(1);
    // The health alert itself was drained, through the same broken worker, direct.
    const directTexts = f.calls.filter((c) => c.leg === "direct").map((c) => String(c.body.text));
    expect(directTexts.some((t) => t.includes("POST /messages/send"))).toBe(true);
    expect(storage.alerts.countDrainable(Date.now())).toBe(0);
  });

  it("a different reason gets its own alert; the same reason re-alerts only after the throttle window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000_000);
    let status = 404;
    const f = makeFetch({ worker: () => new Response("", { status }), direct: directOk });
    const n = build(f.fetch, { storage })!;
    await n.sendPlainAlert!("a", "info");
    await n.sendPlainAlert!("b", "info");
    expect(healthAlerts()).toHaveLength(1);
    status = 503;
    await n.sendPlainAlert!("c", "info");
    expect(healthAlerts()).toHaveLength(2);
    status = 404;
    vi.setSystemTime(50_000_000 + FALLBACK_ALERT_THROTTLE_MS + 1);
    await n.sendPlainAlert!("d", "info");
    expect(healthAlerts()).toHaveLength(3);
  });

  it("a Telegram stall behind a healthy worker is reported as Telegram being slow, not as a broken worker", async () => {
    const f = makeFetch({ worker: () => json({ ok: false, error: "telegram call timed out after 4000ms" }, 502), direct: directOk });
    await build(f.fetch, { storage })!.sendPlainAlert!("a", "info");
    expect(String(f.calls[1]!.body.text)).toContain("telegram call timed out after 4000ms");
    const [row] = healthAlerts();
    expect(row!.text).toMatch(/could not get a reply from Telegram/);
    expect(row!.text).not.toMatch(/bypassing the worker/);
  });

  it("a worker leg starved of budget that times out records no health alert (it proves nothing)", async () => {
    vi.useFakeTimers();
    const f = makeFetch({ worker: hang, direct: directOk });
    const p = build(f.fetch, { storage })!.sendPlainAlert!("x", "info", { timeoutMs: 2_500 });
    await vi.advanceTimersByTimeAsync(2_500);
    await p;
    expect(f.calls.map((c) => c.leg)).toEqual(["worker", "direct"]);
    expect(healthAlerts()).toHaveLength(0);
  });

  it("a worker leg starved of budget that gets a definite 404 still records it", async () => {
    const f = makeFetch({ worker: () => new Response("", { status: 404 }), direct: directOk });
    await build(f.fetch, { storage })!.sendPlainAlert!("x", "info", { timeoutMs: 2_500 });
    expect(healthAlerts()).toHaveLength(1);
  });

  it("worker-only host: one health alert per outage, not one per hour, re-armed by a success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000_000);
    let status = 503;
    const f = makeFetch({ worker: () => (status === 200 ? json({ ok: true, messageId: 1 }) : new Response("", { status })) });
    const n = build(f.fetch, { storage, direct: false })!;
    await n.sendPlainAlert!("a", "info").catch(() => {});
    vi.setSystemTime(80_000_000 + 3 * FALLBACK_ALERT_THROTTLE_MS);
    await n.sendPlainAlert!("b", "info").catch(() => {});
    expect(healthAlerts()).toHaveLength(1);
    status = 200;
    await n.sendPlainAlert!("c", "info");
    status = 503;
    await n.sendPlainAlert!("d", "info").catch(() => {});
    expect(healthAlerts()).toHaveLength(2);
  });

  it("names the machine when given one", async () => {
    const f = makeFetch({ worker: () => new Response("", { status: 404 }), direct: directOk });
    await build(f.fetch, { storage, machineId: "devbox" })!.sendPlainAlert!("a", "info");
    expect(healthAlerts()[0]!.text).toContain("devbox");
  });
});

describe("AlertNotifier.unpinTopic", () => {
  it("goes through the worker only", async () => {
    const f = makeFetch({ unpin: () => json({ ok: true }), direct: directOk });
    await build(f.fetch)!.unpinTopic!(12);
    expect(f.calls).toEqual([{ leg: "unpin", url: `${WORKER}/topics/unpin`, body: { chatId: CHAT, messageThreadId: 12 } }]);
  });

  it("a failure rejects and does not fall back direct", async () => {
    const f = makeFetch({ unpin: () => json({ error: "x" }, 502), direct: directOk });
    await expect(build(f.fetch)!.unpinTopic!(12)).rejects.toThrow();
    expect(f.calls.map((c) => c.leg)).toEqual(["unpin"]);
  });

  it("is absent on a direct-only host", () => {
    const f = makeFetch({ direct: directOk });
    expect(build(f.fetch, { worker: false })!.unpinTopic).toBeUndefined();
  });
});

describe("POST /alert ladder against the real composed notifier", () => {
  function post(app: ReturnType<typeof createApp>, body: unknown) {
    return app(new Request("http://localhost/alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
  }

  it("thread not found from the worker: recreate, then a second send into the new topic", async () => {
    let n = 0;
    const f = makeFetch({
      worker: () => (n++ === 0
        ? json({ ok: false, telegram: { status: 400, description: "Bad Request: message thread not found" } })
        : json({ ok: true, messageId: 5 })),
      unpin: () => json({ ok: true }),
      direct: directOk,
    });
    const resolveNamedTopic = vi.fn()
      .mockResolvedValueOnce({ messageThreadId: 77, created: false })
      .mockResolvedValueOnce({ messageThreadId: 78, created: true });
    const app = createApp(storage, { nowFn: () => 1000, notifier: build(f.fetch, { storage }), resolveNamedTopic });
    expect((await post(app, { text: "x", topic: { key: "k" } })).status).toBe(204);
    await new Promise((r) => setTimeout(r, 0));
    const workerCalls = f.calls.filter((c) => c.leg === "worker");
    expect(workerCalls.map((c) => c.body.messageThreadId)).toEqual([77, 78]);
    expect(f.calls.some((c) => c.leg === "direct")).toBe(false);
    expect(f.calls.filter((c) => c.leg === "unpin").map((c) => c.body.messageThreadId)).toEqual([78]);
  });

  it("Telegram 401 via the worker: lands direct with the suffix, 204", async () => {
    const f = makeFetch({
      worker: () => json({ error: "telegram_error", telegram: { status: 401, description: "Unauthorized" } }, 502),
      direct: directOk,
    });
    const app = createApp(storage, { nowFn: () => 1000, notifier: build(f.fetch, { storage }) });
    expect((await post(app, { text: "hello" })).status).toBe(204);
    expect(String(f.calls.find((c) => c.leg === "direct")!.body.text)).toMatch(/^hello · sent direct; worker: HTTP 502 \(Telegram 401/);
  });

  it("worker 200 non-JSON: direct, 204", async () => {
    const f = makeFetch({ worker: () => new Response("oops", { status: 200 }), direct: directOk });
    const app = createApp(storage, { nowFn: () => 1000, notifier: build(f.fetch) });
    expect((await post(app, { text: "hello" })).status).toBe(204);
    expect(f.calls.map((c) => c.leg)).toEqual(["worker", "direct"]);
  });

  it("worker 404: direct, 204", async () => {
    const f = makeFetch({ worker: () => new Response("", { status: 404 }), direct: directOk });
    const app = createApp(storage, { nowFn: () => 1000, notifier: build(f.fetch) });
    expect((await post(app, { text: "hello" })).status).toBe(204);
    expect(f.calls.map((c) => c.leg)).toEqual(["worker", "direct"]);
  });

  it("hung worker: direct, and /alert answers within PLAIN_ALERT_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const f = makeFetch({ worker: hang, direct: directOk });
    const app = createApp(storage, { nowFn: () => 1000, notifier: build(f.fetch) });
    const started = Date.now();
    const p = post(app, { text: "hello" });
    await vi.advanceTimersByTimeAsync(PLAIN_ALERT_TIMEOUT_MS);
    expect((await p).status).toBe(204);
    expect(Date.now() - started).toBeLessThanOrEqual(PLAIN_ALERT_TIMEOUT_MS);
    expect(f.calls.map((c) => c.leg)).toEqual(["worker", "direct"]);
  });

  it("a topic alert whose worker leg is broken still runs the ladder on the direct leg's 400s", async () => {
    const f = makeFetch({
      worker: () => new Response("", { status: 404 }),
      direct: (body) => (body.message_thread_id === 77
        ? json({ ok: false, description: "Bad Request: something" }, 400)
        : directOk(body, "")),
    });
    const resolveNamedTopic = vi.fn().mockResolvedValue({ messageThreadId: 77, created: false });
    const app = createApp(storage, { nowFn: () => 1000, notifier: build(f.fetch), resolveNamedTopic });
    expect((await post(app, { text: "x", topic: { key: "k" } })).status).toBe(204);
    const direct = f.calls.filter((c) => c.leg === "direct");
    expect(direct.at(-1)!.body).not.toHaveProperty("message_thread_id");
  });
});
