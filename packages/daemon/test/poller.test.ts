import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Poller, type PollerCallbacks, type PollerConfig, type ExecuteMessage, type LaunchMessage, type KillMessage } from "../src/worker/poller";

const BASE_CONFIG: PollerConfig = {
  workerUrl: "http://localhost:8787",
  apiKey: "test-key",
  machineId: "devbox",
  chatId: "chat-42",
};

function makeExecuteMsg(overrides?: Partial<ExecuteMessage>): ExecuteMessage {
  return {
    commandId: "cmd-1",
    commandType: "execute",
    sessionId: "sess-1",
    command: "ls",
    chatId: "chat-1",
    ...overrides,
  };
}

function makeLaunchMsg(overrides?: Partial<LaunchMessage>): LaunchMessage {
  return {
    commandId: "cmd-2",
    commandType: "launch",
    directory: "/home/user/project",
    prompt: "Hello world",
    chatId: "chat-1",
    ...overrides,
  };
}

function makeKillMsg(overrides?: Partial<KillMessage>): KillMessage {
  return {
    commandId: "cmd-3",
    commandType: "kill",
    sessionId: "sess-1",
    chatId: "chat-1",
    ...overrides,
  };
}

function makeCallbacks(overrides?: Partial<PollerCallbacks>): PollerCallbacks {
  return {
    onCommand: vi.fn().mockResolvedValue(undefined),
    onLaunch: vi.fn().mockResolvedValue(undefined),
    onKill: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeFetch(responses: Array<() => Response>): typeof fetch {
  let idx = 0;
  return vi.fn(async (_url: unknown, _init?: unknown) => {
    const next = responses[idx++];
    if (!next) {
      // Default: 204 no content
      return new Response(null, { status: 204 });
    }
    return next();
  }) as unknown as typeof fetch;
}

function json200(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function ackOk(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ============================================================
// poll()
// ============================================================

describe("Poller.poll()", () => {
  it("sends GET to the correct URL with auth header", async () => {
    const fetchFn = vi.fn().mockResolvedValue(noContent()) as unknown as typeof fetch;
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn });

    await poller.poll();

    expect(fetchFn).toHaveBeenCalledWith(
      "http://localhost:8787/machines/devbox/next",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-key" }) }),
    );
  });

  it("returns null on 204", async () => {
    const fetchFn = vi.fn().mockResolvedValue(noContent()) as unknown as typeof fetch;
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn });

    const result = await poller.poll();
    expect(result).toBeNull();
  });

  it("returns the parsed message on 200", async () => {
    const msg = makeExecuteMsg();
    const fetchFn = vi.fn().mockResolvedValue(json200(msg)) as unknown as typeof fetch;
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn });

    const result = await poller.poll();
    expect(result).toEqual(msg);
  });

  it("URL-encodes the machineId", async () => {
    const fetchFn = vi.fn().mockResolvedValue(noContent()) as unknown as typeof fetch;
    const poller = new Poller(
      { ...BASE_CONFIG, machineId: "machine alpha" },
      makeCallbacks(),
      { fetchFn },
    );

    await poller.poll();

    const [url] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("http://localhost:8787/machines/machine%20alpha/next");
  });

  it("throws on non-200/204 status", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("error", { status: 500 })) as unknown as typeof fetch;
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn });

    await expect(poller.poll()).rejects.toThrow("Poll failed: 500");
  });
});

// ============================================================
// ack()
// ============================================================

describe("Poller.ack()", () => {
  it("sends POST to the correct ack URL with auth header", async () => {
    const fetchFn = vi.fn().mockResolvedValue(ackOk()) as unknown as typeof fetch;
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn });

    await poller.ack("cmd-123");

    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8787/commands/cmd-123/ack");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(init.method).toBe("POST");
  });
});

// ============================================================
// start() / stop() — use fake timers
// ============================================================

describe("Poller start/stop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls immediately on start (does not wait for first interval)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(noContent()) as unknown as typeof fetch;
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn });

    poller.start();
    // Let the immediate tick microtasks flush (no timer advance needed)
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("dispatches execute commands to onCommand callback", async () => {
    const msg = makeExecuteMsg();
    const callbacks = makeCallbacks();
    // First call: return execute message; second (ack) returns ok; rest: 204
    const fetchFn = makeFetch([
      () => json200(msg),
      () => ackOk(),
    ]);
    const poller = new Poller(BASE_CONFIG, callbacks, { fetchFn });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onCommand).toHaveBeenCalledWith(msg);
    expect(callbacks.onLaunch).not.toHaveBeenCalled();
    expect(callbacks.onKill).not.toHaveBeenCalled();
    poller.stop();
  });

  it("dispatches launch commands to onLaunch callback", async () => {
    const msg = makeLaunchMsg();
    const callbacks = makeCallbacks();
    const fetchFn = makeFetch([
      () => json200(msg),
      () => ackOk(),
    ]);
    const poller = new Poller(BASE_CONFIG, callbacks, { fetchFn });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onLaunch).toHaveBeenCalledWith(msg);
    expect(callbacks.onCommand).not.toHaveBeenCalled();
    expect(callbacks.onKill).not.toHaveBeenCalled();
    poller.stop();
  });

  it("dispatches kill commands to onKill callback", async () => {
    const msg = makeKillMsg();
    const callbacks = makeCallbacks();
    const fetchFn = makeFetch([
      () => json200(msg),
      () => ackOk(),
    ]);
    const poller = new Poller(BASE_CONFIG, callbacks, { fetchFn });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onKill).toHaveBeenCalledWith(msg);
    expect(callbacks.onCommand).not.toHaveBeenCalled();
    expect(callbacks.onLaunch).not.toHaveBeenCalled();
    poller.stop();
  });

  it("acks after successful dispatch", async () => {
    const msg = makeExecuteMsg();
    const callbacks = makeCallbacks();
    const fetchFn = makeFetch([
      () => json200(msg),
      () => ackOk(),
    ]);
    const poller = new Poller(BASE_CONFIG, callbacks, { fetchFn });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    // Second call should be the ack
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]).toBe(`http://localhost:8787/commands/${msg.commandId}/ack`);
    poller.stop();
  });

  it("does not ack when dispatch throws", async () => {
    const msg = makeExecuteMsg();
    const callbacks = makeCallbacks({
      onCommand: vi.fn().mockRejectedValue(new Error("delivery failed")),
    });
    const fetchFn = makeFetch([
      () => json200(msg),
      () => ackOk(),
    ]);
    const poller = new Poller(BASE_CONFIG, callbacks, { fetchFn });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    // Only the poll call should have been made, not the ack
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("http://localhost:8787/machines/devbox/next");
    poller.stop();
  });

  it("stop() clears the polling interval", async () => {
    const fetchFn = vi.fn().mockResolvedValue(noContent()) as unknown as typeof fetch;
    const poller = new Poller({ ...BASE_CONFIG, pollIntervalMs: 1000 }, makeCallbacks(), { fetchFn });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    const callsBeforeStop = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    poller.stop();

    // Advance timers — no more polls should fire
    await vi.advanceTimersByTimeAsync(5000);
    const callsAfterStop = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterStop).toBe(callsBeforeStop);
  });

  it("prevents overlapping polls", async () => {
    const resolvers: Array<() => void> = [];
    let pollCallCount = 0;

    const fetchFn = vi.fn(async () => {
      pollCallCount++;
      // Each call hangs until resolved
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      return noContent();
    }) as unknown as typeof fetch;

    const poller = new Poller({ ...BASE_CONFIG, pollIntervalMs: 100 }, makeCallbacks(), { fetchFn });

    poller.start();
    // Let first tick start (immediate)
    await vi.advanceTimersByTimeAsync(0);
    // Trigger 3 intervals while first tick is still pending
    await vi.advanceTimersByTimeAsync(300);

    // Only one poll should have started (the first one, still pending)
    expect(pollCallCount).toBe(1);

    // Unblock the first poll and stop before more ticks fire
    poller.stop();
    resolvers[0]?.();
    await vi.advanceTimersByTimeAsync(0);
  });
});

// ============================================================
// HTTP methods
// ============================================================

describe("Poller.registerSession()", () => {
  it("sends POST to /sessions/register with correct body", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn });

    await poller.registerSession("sess-abc", "My Session");

    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8787/sessions/register");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.sessionId).toBe("sess-abc");
    expect(body.machineId).toBe("devbox");
    expect(body.label).toBe("My Session");
  });

  it("omits label when not provided", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn });

    await poller.registerSession("sess-no-label");

    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.label).toBeUndefined();
  });
});

describe("Poller.sendNotification()", () => {
  it("sends POST to /notifications/send with correct body", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn });

    const result = await poller.sendNotification("sess-1", "chat-123", "Hello!", { inline_keyboard: [] });

    expect(result.ok).toBe(true);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8787/notifications/send");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.sessionId).toBe("sess-1");
    expect(body.chatId).toBe("chat-123");
    expect(body.text).toBe("Hello!");
    expect(body.media).toBeUndefined();
  });

  it("includes media array in POST body when provided", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn });

    const media = [{ key: "outbound/123/photo.png", mime: "image/png", filename: "photo.png" }];
    await poller.sendNotification("sess-2", "chat-456", "With media!", { inline_keyboard: [] }, media);

    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.media).toEqual(media);
  });

  it("omits media field when media array is empty", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn });

    await poller.sendNotification("sess-3", "chat-789", "No media!", { inline_keyboard: [] }, []);

    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.media).toBeUndefined();
  });
});

describe("Poller.uploadMedia()", () => {
  it("sends multipart form to /media/upload", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, key: "outbound/123-abc/photo.png" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn });

    const data = new ArrayBuffer(8);
    const result = await poller.uploadMedia("outbound/123-abc/photo.png", data, "image/png", "photo.png");

    expect(result.ok).toBe(true);
    expect(result.key).toBe("outbound/123-abc/photo.png");

    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8787/media/upload");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    // body is FormData
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("returns { ok: false, key: '' } on fetch error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("Network error")) as unknown as typeof fetch;
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn });

    const result = await poller.uploadMedia("key", new ArrayBuffer(4), "image/jpeg", "test.jpg");
    expect(result.ok).toBe(false);
    expect(result.key).toBe("");
  });
});

// ============================================================
// getConfiguredChatId
// ============================================================

describe("Poller.getConfiguredChatId()", () => {
  it("returns chatId from config", () => {
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), {});
    expect(poller.getConfiguredChatId()).toBe("chat-42");
  });

  it("returns undefined when chatId not provided", () => {
    const { chatId: _chatId, ...configWithoutChatId } = BASE_CONFIG;
    const poller = new Poller(configWithoutChatId, makeCallbacks(), {});
    expect(poller.getConfiguredChatId()).toBeUndefined();
  });
});
