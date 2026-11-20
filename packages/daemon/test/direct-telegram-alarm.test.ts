import { describe, expect, it, vi } from "vitest";
import { DirectTelegramAlarm } from "../src/direct-telegram-alarm";
import { TelegramSendError } from "../src/notification-service";

describe("DirectTelegramAlarm", () => {
  it("sends plain alert with severity prefix", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const service = new DirectTelegramAlarm("bot-token", "8248645256", fetchMock);

    await service.sendPlainAlert("Server error", "error");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(options.body)) as Record<string, unknown>;
    expect(payload.chat_id).toBe("8248645256");
    expect(payload.text).toBe("❌ Server error");
  });
});

describe("DirectTelegramAlarm.sendPlainAlert replyMarkup", () => {
  function okFetch() {
    return vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
    ) as unknown as typeof fetch;
  }
  function bodyOf(fetchMock: typeof fetch): Record<string, unknown> {
    const [, options] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    return JSON.parse(String(options.body)) as Record<string, unknown>;
  }

  it("without options the request body is exactly {chat_id, text}", async () => {
    const fetchMock = okFetch();
    const service = new DirectTelegramAlarm("t", "-1001234567890", fetchMock);
    await service.sendPlainAlert("hi", "info");
    expect(bodyOf(fetchMock)).toEqual({ chat_id: "-1001234567890", text: "hi" });
  });

  it("attaches reply_markup to the same chat when given", async () => {
    const fetchMock = okFetch();
    const service = new DirectTelegramAlarm("t", "-1001234567890", fetchMock);
    const replyMarkup = { inline_keyboard: [[{ text: "a", url: "https://t.me/c/1234567890/5" }]] };
    await service.sendPlainAlert("hi", "info", { replyMarkup });
    expect(bodyOf(fetchMock)).toEqual({ chat_id: "-1001234567890", text: "hi", reply_markup: replyMarkup });
  });

  it("honours a shorter timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
      const service = new DirectTelegramAlarm("t", "-1001234567890", fetchMock);
      const settled = service.sendPlainAlert("hi", "info", { timeoutMs: 3_000 }).then(
        () => "resolved",
        (err: unknown) => String(err),
      );
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await settled).toContain("timed out after 3000ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends message_thread_id when given", async () => {
    const fetchMock = okFetch();
    const service = new DirectTelegramAlarm("t", "-1001234567890", fetchMock);
    await service.sendPlainAlert("hi", "info", { messageThreadId: 12 });
    expect(bodyOf(fetchMock)).toEqual({ chat_id: "-1001234567890", text: "hi", message_thread_id: 12 });
  });

  it("a non-2xx carries Telegram's description", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, description: "Bad Request: message thread not found" }), { status: 400 }),
    ) as unknown as typeof fetch;
    const service = new DirectTelegramAlarm("t", "-1001234567890", fetchMock);
    const err = (await service.sendPlainAlert("hi", "info").catch((e: unknown) => e)) as TelegramSendError;
    expect(err.description).toBe("Bad Request: message thread not found");
  });

  it("a non-2xx throws a TelegramSendError carrying the status", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, description: "Bad Request: BUTTON_URL_INVALID" }), { status: 400 }),
    ) as unknown as typeof fetch;
    const service = new DirectTelegramAlarm("t", "-1001234567890", fetchMock);
    const err = await service.sendPlainAlert("hi", "info").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramSendError);
    expect((err as TelegramSendError).status).toBe(400);
    expect(String(err)).toContain("returned 400");
  });
});

describe("DirectTelegramAlarm.sendPlainAlert timeout", () => {
  it("rejects rather than hanging forever when the socket stalls", async () => {
    // Regression guard. SwarmArbiter awaits this while holding the target's
    // `inflight` slot, which is released in a `.finally()`. A promise that
    // never settles therefore wedges ALL swarm delivery to that session
    // permanently -- no rejection means no retry, and silence reads as
    // success. DeliveryWatchdog awaits it under its `processing` guard, so the
    // same stalled socket would also freeze the overdue alarm whose whole job
    // is to notice that delivery has stalled.
    //
    // A try/catch cannot help: the failure mode is a promise that never
    // settles, not one that rejects. Only a bound does.
    //
    // Same hazard and same fix as pigeon-h21 in opencode-client.ts.
    vi.useFakeTimers();
    try {
      // Never resolves on its own; only the AbortSignal can end it.
      const fetchMock = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ) as unknown as typeof fetch;

      const service = new DirectTelegramAlarm("bot-token", "8248645256", fetchMock);

      const pending = service.sendPlainAlert("hello", "error");
      // Surface the rejection immediately so the runtime cannot flag it as an
      // unhandled rejection while we advance the clock.
      const settled = pending.then(
        () => "resolved",
        (err: unknown) => String(err),
      );

      await vi.advanceTimersByTimeAsync(10_000);

      expect(await settled).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  // pigeon-wfj1. The test above proves the bound only for a fetch that HONOURS
  // the AbortSignal. A signal-ignoring fetch -- a stubbed transport, a patched
  // global, a future dispatcher -- was still unbounded, and this await sits
  // inside the DeliveryWatchdog cycle under the `processing` guard, so a hang
  // here wedges the watchdog exactly like the body-read hang did.
  it("rejects even when the fetch IGNORES the abort signal", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        () => new Promise<Response>(() => {}),
      ) as unknown as typeof fetch;

      const service = new DirectTelegramAlarm("bot-token", "8248645256", fetchMock);

      const settled = service.sendPlainAlert("hello", "error").then(
        () => "resolved",
        (err: unknown) => String(err),
      );

      await vi.advanceTimersByTimeAsync(10_000);

      expect(await settled).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });
});
