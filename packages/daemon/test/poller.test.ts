import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Poller, type PollerCallbacks, type PollerConfig, type ExecuteMessage, type LaunchMessage, type KillMessage, type InterruptMessage, type CompactMessage, type McpListMessage, type McpEnableMessage, type McpDisableMessage, type ModelListMessage, type ModelSetMessage } from "../src/worker/poller";

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

function makeInterruptMsg(overrides?: Partial<InterruptMessage>): InterruptMessage {
  return {
    commandId: "cmd-interrupt",
    commandType: "interrupt",
    sessionId: "sess-1",
    chatId: "chat-1",
    ...overrides,
  };
}

function makeCompactMsg(overrides?: Partial<CompactMessage>): CompactMessage {
  return {
    commandId: "cmd-4",
    commandType: "compact",
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
    onInterrupt: vi.fn().mockResolvedValue(undefined),
    onCompact: vi.fn().mockResolvedValue(undefined),
    onMcpList: vi.fn().mockResolvedValue(undefined),
    onMcpEnable: vi.fn().mockResolvedValue(undefined),
    onMcpDisable: vi.fn().mockResolvedValue(undefined),
    onModelList: vi.fn().mockResolvedValue(undefined),
    onModelSet: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeMcpListMsg(overrides?: Partial<McpListMessage>): McpListMessage {
  return {
    commandId: "cmd-5",
    commandType: "mcp_list",
    sessionId: "sess-1",
    chatId: "chat-1",
    ...overrides,
  };
}

function makeMcpEnableMsg(overrides?: Partial<McpEnableMessage>): McpEnableMessage {
  return {
    commandId: "cmd-6",
    commandType: "mcp_enable",
    sessionId: "sess-1",
    chatId: "chat-1",
    serverName: "filesystem",
    ...overrides,
  };
}

function makeMcpDisableMsg(overrides?: Partial<McpDisableMessage>): McpDisableMessage {
  return {
    commandId: "cmd-7",
    commandType: "mcp_disable",
    sessionId: "sess-1",
    chatId: "chat-1",
    serverName: "filesystem",
    ...overrides,
  };
}

function makeModelListMsg(overrides?: Partial<ModelListMessage>): ModelListMessage {
  return {
    commandId: "cmd-8",
    commandType: "model_list",
    sessionId: "sess-1",
    chatId: "chat-1",
    ...overrides,
  };
}

function makeModelSetMsg(overrides?: Partial<ModelSetMessage>): ModelSetMessage {
  return {
    commandId: "cmd-9",
    commandType: "model_set",
    sessionId: "sess-1",
    chatId: "chat-1",
    model: "anthropic/claude-3-5-sonnet",
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

  it("dispatches interrupt commands to onInterrupt callback", async () => {
    const msg = makeInterruptMsg();
    const callbacks = makeCallbacks();
    const fetchFn = makeFetch([
      () => json200(msg),
      () => ackOk(),
    ]);
    const poller = new Poller(BASE_CONFIG, callbacks, { fetchFn });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onInterrupt).toHaveBeenCalledWith(msg);
    expect(callbacks.onCommand).not.toHaveBeenCalled();
    expect(callbacks.onKill).not.toHaveBeenCalled();
    poller.stop();
  });

  it("dispatches compact commands to onCompact callback", async () => {
    const msg = makeCompactMsg();
    const callbacks = makeCallbacks();
    const fetchFn = makeFetch([
      () => json200(msg),
      () => ackOk(),
    ]);
    const poller = new Poller(BASE_CONFIG, callbacks, { fetchFn });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onCompact).toHaveBeenCalledWith(msg);
    expect(callbacks.onCommand).not.toHaveBeenCalled();
    expect(callbacks.onLaunch).not.toHaveBeenCalled();
    expect(callbacks.onKill).not.toHaveBeenCalled();
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

  it("parses messageThreadId off poll response and passes it to callbacks for execute, launch, and mcp_list", async () => {
    const callbacks = makeCallbacks();

    // 1. Execute message with messageThreadId
    const execMsg = { ...makeExecuteMsg(), messageThreadId: 101 };
    const fetchFn1 = makeFetch([() => json200(execMsg), () => ackOk()]);
    const poller1 = new Poller(BASE_CONFIG, callbacks, { fetchFn: fetchFn1 });
    poller1.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandType: "execute",
      messageThreadId: 101,
    }));
    poller1.stop();

    // 2. Launch message with messageThreadId
    const launchMsg = { ...makeLaunchMsg(), messageThreadId: 102 };
    const fetchFn2 = makeFetch([() => json200(launchMsg), () => ackOk()]);
    const poller2 = new Poller(BASE_CONFIG, callbacks, { fetchFn: fetchFn2 });
    poller2.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onLaunch).toHaveBeenCalledWith(expect.objectContaining({
      commandType: "launch",
      messageThreadId: 102,
    }));
    poller2.stop();

    // 3. McpList message with messageThreadId
    const mcpMsg = { ...makeMcpListMsg(), messageThreadId: 103 };
    const fetchFn3 = makeFetch([() => json200(mcpMsg), () => ackOk()]);
    const poller3 = new Poller(BASE_CONFIG, callbacks, { fetchFn: fetchFn3 });
    poller3.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onMcpList).toHaveBeenCalledWith(expect.objectContaining({
      commandType: "mcp_list",
      messageThreadId: 103,
    }));
    poller3.stop();
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

    const result = await poller.sendNotification({ sessionId: "sess-1", chatId: "chat-123", text: "Hello!", replyMarkup: { inline_keyboard: [] } });

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
    await poller.sendNotification({ sessionId: "sess-2", chatId: "chat-456", text: "With media!", replyMarkup: { inline_keyboard: [] }, media });

    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.media).toEqual(media);
  });

  it("omits media field when media array is empty", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn });

    await poller.sendNotification({ sessionId: "sess-3", chatId: "chat-789", text: "No media!", replyMarkup: { inline_keyboard: [] }, media: [] });

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
// editNotification
// ============================================================

describe("Poller.editNotification()", () => {
  it("editNotification calls worker /notifications/edit", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn });

    const result = await poller.editNotification("q:sess:req", "new text", { inline_keyboard: [] });

    expect(result.ok).toBe(true);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8787/notifications/edit");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain('"notificationId":"q:sess:req"');
  });

  it("editNotification sends correct body fields", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn });

    await poller.editNotification("notif-id", "updated text", { inline_keyboard: [[]] });

    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.notificationId).toBe("notif-id");
    expect(body.text).toBe("updated text");
    expect(body.replyMarkup).toEqual({ inline_keyboard: [[]] });
  });

  it("editNotification returns ok:false on network error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network error")) as unknown as typeof fetch;
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn });

    const result = await poller.editNotification("q:sess:req", "text", { inline_keyboard: [] });
    expect(result.ok).toBe(false);
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

// ============================================================
// New message type dispatch tests (MCP/Model)
// ============================================================

describe("Poller dispatch — mcp_list", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches mcp_list commands to onMcpList callback", async () => {
    const msg = makeMcpListMsg();
    const callbacks = makeCallbacks();
    const fetchFn = makeFetch([
      () => json200(msg),
      () => ackOk(),
    ]);
    const poller = new Poller(BASE_CONFIG, callbacks, { fetchFn });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onMcpList).toHaveBeenCalledWith(msg);
    expect(callbacks.onCommand).not.toHaveBeenCalled();
    expect(callbacks.onLaunch).not.toHaveBeenCalled();
    expect(callbacks.onKill).not.toHaveBeenCalled();
    expect(callbacks.onCompact).not.toHaveBeenCalled();
    poller.stop();
  });
});

describe("Poller dispatch — mcp_enable", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches mcp_enable commands to onMcpEnable callback", async () => {
    const msg = makeMcpEnableMsg();
    const callbacks = makeCallbacks();
    const fetchFn = makeFetch([
      () => json200(msg),
      () => ackOk(),
    ]);
    const poller = new Poller(BASE_CONFIG, callbacks, { fetchFn });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onMcpEnable).toHaveBeenCalledWith(msg);
    expect(callbacks.onCommand).not.toHaveBeenCalled();
    expect(callbacks.onLaunch).not.toHaveBeenCalled();
    poller.stop();
  });
});

describe("Poller dispatch — mcp_disable", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches mcp_disable commands to onMcpDisable callback", async () => {
    const msg = makeMcpDisableMsg();
    const callbacks = makeCallbacks();
    const fetchFn = makeFetch([
      () => json200(msg),
      () => ackOk(),
    ]);
    const poller = new Poller(BASE_CONFIG, callbacks, { fetchFn });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onMcpDisable).toHaveBeenCalledWith(msg);
    expect(callbacks.onCommand).not.toHaveBeenCalled();
    expect(callbacks.onMcpEnable).not.toHaveBeenCalled();
    poller.stop();
  });
});

describe("Poller dispatch — model_list", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches model_list commands to onModelList callback", async () => {
    const msg = makeModelListMsg();
    const callbacks = makeCallbacks();
    const fetchFn = makeFetch([
      () => json200(msg),
      () => ackOk(),
    ]);
    const poller = new Poller(BASE_CONFIG, callbacks, { fetchFn });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onModelList).toHaveBeenCalledWith(msg);
    expect(callbacks.onCommand).not.toHaveBeenCalled();
    expect(callbacks.onMcpList).not.toHaveBeenCalled();
    poller.stop();
  });
});

describe("Poller dispatch — model_set", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches model_set commands to onModelSet callback", async () => {
    const msg = makeModelSetMsg();
    const callbacks = makeCallbacks();
    const fetchFn = makeFetch([
      () => json200(msg),
      () => ackOk(),
    ]);
    const poller = new Poller(BASE_CONFIG, callbacks, { fetchFn });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onModelSet).toHaveBeenCalledWith(msg);
    expect(callbacks.onCommand).not.toHaveBeenCalled();
    expect(callbacks.onModelList).not.toHaveBeenCalled();
    poller.stop();
  });
});

describe("Poller.sendNotification() rate limits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sendNotification returns ok: false and retryAfter on rate limit (429)", async () => {
    const poller = new Poller(BASE_CONFIG, makeCallbacks());
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "rate_limited", retryAfter: 17 }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    );
    (poller as unknown as { fetchFn: typeof fetch }).fetchFn = fetchMock as unknown as typeof fetch;

    const res = await poller.sendNotification({ sessionId: "sess-1", chatId: "chat-1", text: "hello", replyMarkup: { inline_keyboard: [] } });
    expect(res).toEqual({
      ok: false,
      kind: "http_error",
      status: 429,
      body: { error: "rate_limited", retryAfter: 17 },
      retryAfter: 17,
    });
  });

  it("strips garbage retryAfter from 429 response body", async () => {
    const poller = new Poller(BASE_CONFIG, makeCallbacks());
    
    const garbagePayloads = [
      { error: "rate_limited", retryAfter: "30" },
      { error: "rate_limited", retryAfter: -5 },
      { error: "rate_limited", retryAfter: 0 },
      { error: "rate_limited", retryAfter: null },
      { error: "rate_limited" },
    ];

    for (const payload of garbagePayloads) {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
      );
      (poller as unknown as { fetchFn: typeof fetch }).fetchFn = fetchMock as unknown as typeof fetch;

      const res = await poller.sendNotification({ sessionId: "sess-1", chatId: "chat-1", text: "hello", replyMarkup: { inline_keyboard: [] } });
      expect(res).toEqual({
        ok: false,
        kind: "http_error",
        status: 429,
        body: payload,
      });
    }
  });
});

describe("Poller.sendNotification() structured results", () => {
  it("returns transport_error when fetch throws", async () => {
    const cause = new Error("ECONNREFUSED");
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause }));
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn: fetchMock as unknown as typeof fetch });

    const res = await poller.sendNotification({ sessionId: "sess-1", chatId: "chat-1", text: "hi", replyMarkup: {} });
    expect(res).toEqual({
      ok: false,
      kind: "transport_error",
      error: "fetch failed",
      cause,
    });
  });

  it("returns http_error with status and parsed body for non-2xx with JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn: fetchMock as unknown as typeof fetch });

    const res = await poller.sendNotification({ sessionId: "sess-1", chatId: "chat-1", text: "hi", replyMarkup: {} });
    expect(res).toEqual({
      ok: false,
      kind: "http_error",
      status: 401,
      body: { ok: false, error: "Unauthorized" },
    });
  });

  it("returns http_error for non-2xx with NON-JSON body without throwing or misreporting as transport_error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn: fetchMock as unknown as typeof fetch });

    const res = await poller.sendNotification({ sessionId: "sess-1", chatId: "chat-1", text: "hi", replyMarkup: {} });
    expect(res).toEqual({
      ok: false,
      kind: "http_error",
      status: 502,
      body: "<html>502 Bad Gateway</html>",
    });
  });

  it("returns app_rejection for 2xx response where payload ok is false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "Chat not found" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn: fetchMock as unknown as typeof fetch });

    const res = await poller.sendNotification({ sessionId: "sess-1", chatId: "chat-1", text: "hi", replyMarkup: {} });
    expect(res).toEqual({
      ok: false,
      kind: "app_rejection",
      status: 200,
      body: { ok: false, error: "Chat not found" },
    });
  });

  it("returns success with retryAfter on 2xx with ok=true and retryAfter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, retryAfter: 15 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn: fetchMock as unknown as typeof fetch });

    const res = await poller.sendNotification({ sessionId: "sess-1", chatId: "chat-1", text: "hi", replyMarkup: {} });
    expect(res).toEqual({
      ok: true,
      kind: "success",
      status: 200,
      body: { ok: true, retryAfter: 15 },
      retryAfter: 15,
    });
  });

  it("returns success on 2xx response with ok=true", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, messageId: 100 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn: fetchMock as unknown as typeof fetch });

    const res = await poller.sendNotification({ sessionId: "sess-1", chatId: "chat-1", text: "hi", replyMarkup: {} });
    expect(res).toEqual({
      ok: true,
      kind: "success",
      status: 200,
      body: { ok: true, messageId: 100 },
    });
  });
});

describe("Poller.registerSession() structured results", () => {
  it("returns success result on 200 ok=true", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn: fetchMock as unknown as typeof fetch });

    const res = await poller.registerSession("sess-1", "Label");
    expect(res).toEqual({
      ok: true,
      kind: "success",
      status: 200,
      body: { ok: true },
    });
  });

  it("returns transport_error when fetch throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("DNS failure"));
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn: fetchMock as unknown as typeof fetch });

    const res = await poller.registerSession("sess-1");
    expect(res).toEqual({
      ok: false,
      kind: "transport_error",
      error: "DNS failure",
    });
  });

  it("returns http_error on non-2xx status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("Internal Error", { status: 500 }),
    );
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn: fetchMock as unknown as typeof fetch });

    const res = await poller.registerSession("sess-1");
    expect(res).toEqual({
      ok: false,
      kind: "http_error",
      status: 500,
      body: "Internal Error",
    });
  });

  it("returns app_rejection on 200 status with ok=false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "invalid session" }), { status: 200 }),
    );
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), { fetchFn: fetchMock as unknown as typeof fetch });

    const res = await poller.registerSession("sess-1");
    expect(res).toEqual({
      ok: false,
      kind: "app_rejection",
      status: 200,
      body: { ok: false, error: "invalid session" },
    });
  });
});

describe("Poller — worker health instrumentation", () => {
  function makeMonitor() {
    const seen: Array<{ endpoint: string; kind: string; status?: number }> = [];
    return {
      seen,
      record(endpoint: "register" | "send", result: { kind: string; status?: number }) {
        seen.push({
          endpoint,
          kind: result.kind,
          ...(typeof result.status === "number" ? { status: result.status } : {}),
        });
      },
    };
  }

  it("reports a registerSession 5xx to the health monitor", async () => {
    const monitor = makeMonitor();
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), {
      fetchFn: fetchMock as unknown as typeof fetch,
      healthMonitor: monitor,
    });

    await poller.registerSession("sess-1");

    expect(monitor.seen).toEqual([{ endpoint: "register", kind: "http_error", status: 503 }]);
  });

  it("reports a sendNotification 5xx to the health monitor", async () => {
    const monitor = makeMonitor();
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), {
      fetchFn: fetchMock as unknown as typeof fetch,
      healthMonitor: monitor,
    });

    await poller.sendNotification({
      sessionId: "sess-1",
      chatId: "chat-1",
      text: "hi",
      replyMarkup: {},
    });

    expect(monitor.seen).toEqual([{ endpoint: "send", kind: "http_error", status: 500 }]);
  });

  it("reports successes too, since only a success can clear an episode", async () => {
    const monitor = makeMonitor();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), {
      fetchFn: fetchMock as unknown as typeof fetch,
      healthMonitor: monitor,
    });

    await poller.registerSession("sess-1");
    await poller.sendNotification({
      sessionId: "sess-1",
      chatId: "chat-1",
      text: "hi",
      replyMarkup: {},
    });

    expect(monitor.seen).toEqual([
      { endpoint: "register", kind: "success", status: 200 },
      { endpoint: "send", kind: "success", status: 200 },
    ]);
  });

  it("still returns the result to the caller when a monitor is wired", async () => {
    const monitor = makeMonitor();
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), {
      fetchFn: fetchMock as unknown as typeof fetch,
      healthMonitor: monitor,
    });

    const res = await poller.sendNotification({
      sessionId: "sess-1",
      chatId: "chat-1",
      text: "hi",
      replyMarkup: {},
    });

    expect(res).toEqual({ ok: false, kind: "http_error", status: 503, body: "boom" });
  });

  it("does NOT report unregisterSession — it is not one of the two watched routes", async () => {
    const monitor = makeMonitor();
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), {
      fetchFn: fetchMock as unknown as typeof fetch,
      healthMonitor: monitor,
    });

    await poller.unregisterSession("sess-1");

    expect(monitor.seen).toEqual([]);
  });

  it("works with no monitor wired at all", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    const poller = new Poller(BASE_CONFIG, makeCallbacks(), {
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    await expect(poller.registerSession("sess-1")).resolves.toMatchObject({ status: 503 });
  });
});

describe("Poller: inbound action clears unread", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function driveWith(msg: unknown, overrides?: Record<string, unknown>) {
    const seen: string[] = [];
    const callbacks = makeCallbacks({
      onInboundForSession: (id: string) => seen.push(id),
      ...overrides,
    } as Partial<PollerCallbacks>);
    const fetchFn = makeFetch([() => json200(msg), () => ackOk()]);
    const poller = new Poller(BASE_CONFIG, callbacks, { fetchFn });
    return { seen, callbacks, poller };
  }

  // Answering a question card is a CALLBACK, not a reply -- but it reaches the
  // daemon as an execute command, exactly like a typed reply. Clearing at dispatch
  // rather than in the reply handler is what keeps the badge from contradicting the
  // needs-you pin after the most common interaction of all. Slash commands,
  // interrupts and compactions are user actions on a session too.
  it.each([
    ["execute", makeExecuteMsg({ sessionId: "s1" })],
    ["interrupt", { commandId: "c2", commandType: "interrupt", sessionId: "s2", chatId: "c" }],
    ["compact", { commandId: "c3", commandType: "compact", sessionId: "s3", chatId: "c" }],
    ["kill", { commandId: "c4", commandType: "kill", sessionId: "s4", chatId: "c" }],
    ["model_set", { commandId: "c5", commandType: "model_set", sessionId: "s5", chatId: "c", model: "m" }],
  ])("clears on an inbound %s command", async (_label, msg) => {
    const { seen, poller } = driveWith(msg);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([(msg as { sessionId: string }).sessionId]);
  });

  // A launch has no session yet -- it creates one. Nothing to clear, and reaching
  // for an absent sessionId must not throw inside dispatch.
  it("does not clear for a launch, which carries no session", async () => {
    const { seen, poller } = driveWith(makeLaunchMsg());
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
  });

  it("clears even when the handler throws, because the user still acted", async () => {
    const { seen, poller } = driveWith(makeExecuteMsg({ sessionId: "s7" }), {
      onCommand: vi.fn().mockRejectedValue(new Error("boom")),
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["s7"]);
  });

  // A badge is never worth dropping a command for.
  it("still dispatches when the clear hook itself throws", async () => {
    const callbacks = makeCallbacks({
      onInboundForSession: () => { throw new Error("db gone"); },
    } as Partial<PollerCallbacks>);
    const fetchFn = makeFetch([() => json200(makeExecuteMsg()), () => ackOk()]);
    const poller = new Poller(BASE_CONFIG, callbacks, { fetchFn });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onCommand).toHaveBeenCalledTimes(1);
  });

  // Version skew -- the worker deploying a new command type before the daemon knows
  // it -- produces an unrecognised message that warns and returns WITHOUT acking, so
  // it is redelivered until the worker's 24h cleanup. Clearing there would re-clear
  // on every retry, silently marking read whatever arrived in between.
  it("does not clear for an unrecognised command type", async () => {
    const { seen, poller } = driveWith({
      commandId: "c9",
      commandType: "teleport",
      sessionId: "s9",
      chatId: "c",
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
  });

  it("is optional -- a poller wired without it still dispatches", async () => {
    const callbacks = makeCallbacks();
    const fetchFn = makeFetch([() => json200(makeExecuteMsg()), () => ackOk()]);
    const poller = new Poller(BASE_CONFIG, callbacks, { fetchFn });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onCommand).toHaveBeenCalledTimes(1);
  });
});
