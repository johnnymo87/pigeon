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
