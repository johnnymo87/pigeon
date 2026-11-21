import { describe, expect, it, vi } from "vitest";
import { WorkerMessageClient } from "../src/worker/worker-message-client";

const URL_BASE = "https://worker.example";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function client(fetchFn: typeof fetch) {
  return new WorkerMessageClient({ workerUrl: URL_BASE, apiKey: "k1", fetchFn });
}

function call(fetchMock: ReturnType<typeof vi.fn>, i = 0): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

describe("WorkerMessageClient.sendMessage", () => {
  it("POSTs /messages/send with the bearer and only the fields given", async () => {
    const f = vi.fn(async () => json({ ok: true, messageId: 7 }));
    const out = await client(f as unknown as typeof fetch).sendMessage({ chatId: "-100", text: "hi" }, { timeoutMs: 5_000 });
    expect(out).toEqual({ kind: "sent", messageId: 7 });
    const { url, init, body } = call(f);
    expect(url).toBe(`${URL_BASE}/messages/send`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k1");
    expect(body).toEqual({ chatId: "-100", text: "hi" });
  });

  it("sends no chatId when it has none (the machine's #alerts), and still sends a worker-supplied one", async () => {
    const f = vi.fn(async () => json({ ok: true, messageId: 1 }));
    await client(f as unknown as typeof fetch).sendMessage({ text: "hi" }, { timeoutMs: 5_000 });
    expect(call(f).body).toEqual({ text: "hi" });
    await client(f as unknown as typeof fetch).sendMessage({ chatId: "slack:T1", text: "hi" }, { timeoutMs: 5_000 });
    expect(call(f, 1).body).toEqual({ chatId: "slack:T1", text: "hi" });
  });

  it("passes entities, thread, buttons and the worker-side timeoutMs through", async () => {
    const f = vi.fn(async () => json({ ok: true, messageId: 1 }));
    const urlButtons = [[{ text: "a", url: "https://t.me/c/1/2" }]];
    await client(f as unknown as typeof fetch).sendMessage(
      { chatId: "-100", text: "hi", entities: [{ type: "bold", offset: 0, length: 2 }], messageThreadId: 9, urlButtons, timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    );
    expect(call(f).body).toEqual({
      chatId: "-100",
      text: "hi",
      entities: [{ type: "bold", offset: 0, length: 2 }],
      messageThreadId: 9,
      urlButtons,
      timeoutMs: 30_000,
    });
  });

  it("drops empty entities from the body", async () => {
    const f = vi.fn(async () => json({ ok: true, messageId: 1 }));
    await client(f as unknown as typeof fetch).sendMessage({ chatId: "-100", text: "hi", entities: [] }, { timeoutMs: 5_000 });
    expect(call(f).body).toEqual({ chatId: "-100", text: "hi" });
  });

  it("200 ok:false with a Telegram 400 is telegram_rejected with the description", async () => {
    const f = vi.fn(async () => json({ ok: false, telegram: { status: 400, description: "Bad Request: message thread not found" } }));
    const out = await client(f as unknown as typeof fetch).sendMessage({ chatId: "-100", text: "hi" }, { timeoutMs: 5_000 });
    expect(out).toEqual({ kind: "telegram_rejected", status: 400, description: "Bad Request: message thread not found" });
  });

  it("200 ok:false with a Telegram 429 is telegram_rejected carrying retryAfter", async () => {
    const f = vi.fn(async () => json({ ok: false, telegram: { status: 429, retryAfter: 3, description: "Too Many Requests" } }));
    const out = await client(f as unknown as typeof fetch).sendMessage({ chatId: "-100", text: "hi" }, { timeoutMs: 5_000 });
    expect(out).toEqual({ kind: "telegram_rejected", status: 429, retryAfter: 3, description: "Too Many Requests" });
  });

  it("200 ok:false with any other Telegram status is a worker failure, not a rejection", async () => {
    const f = vi.fn(async () => json({ ok: false, telegram: { status: 401, description: "Unauthorized" } }));
    const out = await client(f as unknown as typeof fetch).sendMessage({ chatId: "-100", text: "hi" }, { timeoutMs: 5_000 });
    expect(out.kind).toBe("worker_failed");
  });

  it("502 relaying a Telegram 401 names both", async () => {
    const f = vi.fn(async () => json({ error: "telegram_error", telegram: { status: 401, description: "Unauthorized" } }, 502));
    const out = await client(f as unknown as typeof fetch).sendMessage({ chatId: "-100", text: "hi" }, { timeoutMs: 5_000 });
    expect(out).toMatchObject({ kind: "worker_failed", status: 502, key: "http502:tg401" });
    if (out.kind === "worker_failed") expect(out.reason).toContain("Telegram 401");
  });

  it("502 with no Telegram status (the worker's own Telegram abort) keeps the worker's error text and its own key", async () => {
    const f = vi.fn(async () => json({ ok: false, error: "telegram call timed out after 4000ms" }, 502));
    const out = await client(f as unknown as typeof fetch).sendMessage({ chatId: "-100", text: "hi" }, { timeoutMs: 5_000 });
    expect(out).toMatchObject({ kind: "worker_failed", status: 502, key: "http502:telegram_unreachable", cause: "telegram_unreachable" });
    if (out.kind === "worker_failed") expect(out.reason).toContain("telegram call timed out after 4000ms");
  });

  it("a worker's own failures are cause worker", async () => {
    const f = vi.fn(async () => new Response("", { status: 500 }));
    const out = await client(f as unknown as typeof fetch).sendMessage({ chatId: "-100", text: "hi" }, { timeoutMs: 5_000 });
    expect(out).toMatchObject({ kind: "worker_failed", cause: "worker" });
  });

  it("403 chat_not_allowed is a worker failure keyed by its error", async () => {
    const f = vi.fn(async () => json({ error: "chat_not_allowed" }, 403));
    const out = await client(f as unknown as typeof fetch).sendMessage({ chatId: "-100", text: "hi" }, { timeoutMs: 5_000 });
    expect(out).toMatchObject({ kind: "worker_failed", status: 403, key: "http403:chat_not_allowed" });
  });

  it("404 (route not deployed) is a worker failure", async () => {
    const f = vi.fn(async () => new Response("Not found", { status: 404 }));
    const out = await client(f as unknown as typeof fetch).sendMessage({ chatId: "-100", text: "hi" }, { timeoutMs: 5_000 });
    expect(out).toMatchObject({ kind: "worker_failed", status: 404, key: "http404" });
  });

  it("a 200 that is not JSON, or not the documented shape, is a worker failure", async () => {
    for (const res of [new Response("<html>", { status: 200 }), json({ hello: 1 }), json(null)]) {
      const f = vi.fn(async () => res);
      const out = await client(f as unknown as typeof fetch).sendMessage({ chatId: "-100", text: "hi" }, { timeoutMs: 5_000 });
      expect(out).toMatchObject({ kind: "worker_failed", key: "bad_body" });
    }
  });

  it("a transport throw is a worker failure", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const out = await client(f as unknown as typeof fetch).sendMessage({ chatId: "-100", text: "hi" }, { timeoutMs: 5_000 });
    expect(out).toMatchObject({ kind: "worker_failed", key: "transport" });
  });

  it("a hung worker (even one ignoring the abort) settles at timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn(() => new Promise<Response>(() => {}));
      const p = client(f as unknown as typeof fetch).sendMessage({ chatId: "-100", text: "hi" }, { timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      const out = await p;
      expect(out).toMatchObject({ kind: "worker_failed", key: "timeout" });
      if (out.kind === "worker_failed") expect(out.reason).toContain("5000ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a body that stalls after the headers also settles at timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const stalled = new Response(new ReadableStream({ start() {} }), { status: 200 });
      const f = vi.fn(async () => stalled);
      const p = client(f as unknown as typeof fetch).sendMessage({ chatId: "-100", text: "hi" }, { timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await p).toMatchObject({ kind: "worker_failed", key: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});
