import { describe, expect, it, vi } from "vitest";
import { buildWorkerWebSocketUrl, MachineAgent } from "../src/worker/machine-agent";
import { openStorageDb } from "../src/storage/database";

describe("buildWorkerWebSocketUrl", () => {
  it("converts http worker URL to ws URL", () => {
    expect(buildWorkerWebSocketUrl("http://localhost:8787", "devbox-1")).toBe(
      "ws://localhost:8787/ws?machineId=devbox-1",
    );
  });

  it("converts https worker URL to wss URL and encodes machine id", () => {
    expect(buildWorkerWebSocketUrl("https://worker.example.com", "machine alpha")).toBe(
      "wss://worker.example.com/ws?machineId=machine%20alpha",
    );
  });
});

describe("MachineAgent.uploadMedia", () => {
  it("POSTs to /media/upload with multipart form and returns key on success", async () => {
    const storage = openStorageDb(":memory:");
    let capturedRequest: Request | null = null;

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedRequest = new Request(url instanceof URL ? url.toString() : url, init);
      return new Response(JSON.stringify({ ok: true, key: "outbound/123-abc/photo.png" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const agent = new MachineAgent(
      { workerUrl: "http://localhost:8787", apiKey: "test-key", machineId: "devbox" },
      storage,
      { fetchFn: fetchMock },
    );

    const data = new ArrayBuffer(8);
    const result = await agent.uploadMedia("outbound/123-abc/photo.png", data, "image/png", "photo.png");

    expect(result.ok).toBe(true);
    expect(result.key).toBe("outbound/123-abc/photo.png");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Verify the URL
    const call = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("http://localhost:8787/media/upload");

    // Verify Authorization header
    expect(call[1].headers).toMatchObject({ Authorization: "Bearer test-key" });

    storage.db.close();
  });

  it("returns { ok: false, key: '' } on fetch error", async () => {
    const storage = openStorageDb(":memory:");

    const fetchMock = vi.fn(async () => {
      throw new Error("Network error");
    }) as unknown as typeof fetch;

    const agent = new MachineAgent(
      { workerUrl: "http://localhost:8787", apiKey: "test-key", machineId: "devbox" },
      storage,
      { fetchFn: fetchMock },
    );

    const result = await agent.uploadMedia("key", new ArrayBuffer(4), "image/jpeg", "test.jpg");
    expect(result.ok).toBe(false);
    expect(result.key).toBe("");

    storage.db.close();
  });
});

describe("MachineAgent.sendNotification", () => {
  it("POSTs to /notifications/send with sessionId, chatId, text, replyMarkup", async () => {
    const storage = openStorageDb(":memory:");

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const agent = new MachineAgent(
      { workerUrl: "http://localhost:8787", apiKey: "test-key", machineId: "devbox" },
      storage,
      { fetchFn: fetchMock },
    );

    const result = await agent.sendNotification("sess-1", "chat-123", "Hello!", { inline_keyboard: [] });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8787/notifications/send");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.sessionId).toBe("sess-1");
    expect(body.chatId).toBe("chat-123");
    expect(body.text).toBe("Hello!");
    expect(body.media).toBeUndefined();

    storage.db.close();
  });

  it("includes media array in POST body when provided", async () => {
    const storage = openStorageDb(":memory:");

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const agent = new MachineAgent(
      { workerUrl: "http://localhost:8787", apiKey: "test-key", machineId: "devbox" },
      storage,
      { fetchFn: fetchMock },
    );

    const media = [{ key: "outbound/123/photo.png", mime: "image/png", filename: "photo.png" }];
    await agent.sendNotification("sess-2", "chat-456", "With media!", { inline_keyboard: [] }, media);

    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.media).toEqual(media);

    storage.db.close();
  });

  it("omits media field when media array is empty", async () => {
    const storage = openStorageDb(":memory:");

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const agent = new MachineAgent(
      { workerUrl: "http://localhost:8787", apiKey: "test-key", machineId: "devbox" },
      storage,
      { fetchFn: fetchMock },
    );

    await agent.sendNotification("sess-3", "chat-789", "Empty media!", { inline_keyboard: [] }, []);

    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.media).toBeUndefined();

    storage.db.close();
  });
});

describe("MachineAgent.handleMessage", () => {
  it("updates lastPongAt on pong message", async () => {
    const storage = openStorageDb(":memory:");

    const agent = new MachineAgent(
      { workerUrl: "http://localhost:8787", apiKey: "key", machineId: "test" },
      storage,
      { now: () => 5000 },
    );

    // handleMessage is public — verify pong is handled without error
    await agent.handleMessage(JSON.stringify({ type: "pong" }));

    expect((agent as unknown as { lastPongAt: number }).lastPongAt).toBe(5000);

    storage.db.close();
  });
});

describe("MachineAgent boot ID tracking", () => {
  it("stores bootId from boot message", async () => {
    const storage = openStorageDb(":memory:");

    const agent = new MachineAgent(
      { workerUrl: "http://localhost:8787", apiKey: "key", machineId: "test" },
      storage,
      { now: () => 5000 },
    );

    await agent.handleMessage(JSON.stringify({ type: "boot", bootId: "abc12345" }));
    expect((agent as unknown as { bootId: string | null }).bootId).toBe("abc12345");

    storage.db.close();
  });
});

describe("MachineAgent commandResult buffering", () => {
  it("buffers commandResult when WS is closed and replays on reconnect", async () => {
    const storage = openStorageDb(":memory:");

    let wsOpenCallback: (() => void) | undefined;
    const sendMock = vi.fn();

    const mockWs = {
      get readyState() {
        return WebSocket.CLOSED;
      },
      send: sendMock,
      addEventListener: vi.fn((event: string, callback: () => void) => {
        if (event === "open") wsOpenCallback = callback;
      }),
      close: vi.fn(),
    } as unknown as WebSocket;

    const createWebSocket = vi.fn(() => mockWs);

    const agent = new MachineAgent(
      { workerUrl: "http://localhost:8787", apiKey: "key", machineId: "test" },
      storage,
      { createWebSocket },
    );

    // Initial connect to set up listeners
    agent.connect();

    const resultMessage = {
      type: "commandResult",
      commandId: "cmd-123",
      success: false,
      error: "Plugin offline",
    };

    // Cast to access private send method
    const testAgent = agent as unknown as { send: (payload: unknown) => void };
    
    // Send while closed
    testAgent.send(resultMessage);
    
    // Should not have sent yet
    expect(sendMock).not.toHaveBeenCalled();

    // Simulate WS opening
    Object.defineProperty(mockWs, "readyState", { value: WebSocket.OPEN });
    if (wsOpenCallback) wsOpenCallback();

    // Should replay the buffered message
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(JSON.stringify(resultMessage));

    storage.db.close();
  });

  it("sends commandResult immediately when WS is open", async () => {
    const storage = openStorageDb(":memory:");

    const sendMock = vi.fn();

    const mockWs = {
      readyState: WebSocket.OPEN,
      send: sendMock,
      addEventListener: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    const createWebSocket = vi.fn(() => mockWs);

    const agent = new MachineAgent(
      { workerUrl: "http://localhost:8787", apiKey: "key", machineId: "test" },
      storage,
      { createWebSocket },
    );

    agent.connect();

    const resultMessage = {
      type: "commandResult",
      commandId: "cmd-456",
      success: true,
      error: null,
    };

    const testAgent = agent as unknown as { send: (payload: unknown) => void };
    testAgent.send(resultMessage);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(JSON.stringify(resultMessage));

    storage.db.close();
  });

  it("limits buffer to prevent memory leaks", async () => {
    const storage = openStorageDb(":memory:");

    const sendMock = vi.fn();
    let wsOpenCallback: (() => void) | undefined;

    const mockWs = {
      get readyState() {
        return WebSocket.CLOSED;
      },
      send: sendMock,
      addEventListener: vi.fn((event: string, callback: () => void) => {
        if (event === "open") wsOpenCallback = callback;
      }),
      close: vi.fn(),
    } as unknown as WebSocket;

    const createWebSocket = vi.fn(() => mockWs);

    const agent = new MachineAgent(
      { workerUrl: "http://localhost:8787", apiKey: "key", machineId: "test" },
      storage,
      { createWebSocket },
    );

    agent.connect();

    const testAgent = agent as unknown as { send: (payload: unknown) => void };

    // Send 105 messages (MAX_PENDING_RESULTS is 100)
    for (let i = 0; i < 105; i++) {
      testAgent.send({
        type: "commandResult",
        commandId: `cmd-${i}`,
        success: true,
        error: null,
      });
    }

    expect(sendMock).not.toHaveBeenCalled();

    Object.defineProperty(mockWs, "readyState", { value: WebSocket.OPEN });
    if (wsOpenCallback) wsOpenCallback();

    // Should only send the last 100 messages
    expect(sendMock).toHaveBeenCalledTimes(100);
    
    // First message sent should be cmd-5
    const firstCall = JSON.parse(sendMock.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(firstCall.commandId).toBe("cmd-5");

    // Last message sent should be cmd-104
    const lastCall = JSON.parse(sendMock.mock.calls[99]?.[0] as string) as Record<string, unknown>;
    expect(lastCall.commandId).toBe("cmd-104");

    storage.db.close();
  });
});
