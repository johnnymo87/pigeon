import { describe, expect, it, vi } from "vitest";
import { createCommandReplySender, COMMAND_REPLY_TIMEOUT_MS } from "../src/worker/command-reply";
import { WorkerMessageClient } from "../src/worker/worker-message-client";

function setup(handler: () => Response | Promise<Response>) {
  const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => handler());
  const client = new WorkerMessageClient({ workerUrl: "https://w", apiKey: "k", fetchFn: fetchFn as unknown as typeof fetch });
  const log = { warn: vi.fn(), error: vi.fn() };
  return { fetchFn, send: createCommandReplySender(client, log), log };
}

describe("command replies via the worker", () => {
  it("posts to /messages/send with entities, thread and a long worker-side timeout", async () => {
    const { fetchFn, send, log } = setup(() => Response.json({ ok: true, messageId: 3 }));
    await send("-100", "hello", { entities: [{ type: "code", offset: 0, length: 5 }], messageThreadId: 4 });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://w/messages/send");
    expect(JSON.parse(String(init!.body))).toEqual({
      chatId: "-100",
      text: "hello",
      entities: [{ type: "code", offset: 0, length: 5 }],
      messageThreadId: 4,
      timeoutMs: COMMAND_REPLY_TIMEOUT_MS,
    });
    expect(COMMAND_REPLY_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("omits the thread when undefined", async () => {
    const { fetchFn, send } = setup(() => Response.json({ ok: true, messageId: 3 }));
    await send("-100", "hello", { messageThreadId: undefined });
    expect(JSON.parse(String(fetchFn.mock.calls[0]![1]!.body))).not.toHaveProperty("messageThreadId");
  });

  it("a worker 404 is logged as an ERROR naming the missing route", async () => {
    const { send, log } = setup(() => new Response("Not found", { status: 404 }));
    await expect(send("-100", "x", { messageThreadId: undefined })).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0]![0])).toMatch(/POST \/messages\/send/);
    expect(String(log.error.mock.calls[0]![0])).toMatch(/404/);
  });

  it("a chat rejection is a warning carrying the chat's description", async () => {
    const { send, log } = setup(() => Response.json({ ok: false, telegram: { status: 400, description: "Bad Request: can't parse entities" } }));
    await send("-100", "x", { messageThreadId: undefined });
    expect(String(log.warn.mock.calls[0]![0])).toContain("can't parse entities");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("any other worker failure is a warning and never throws (replies are best-effort)", async () => {
    const { send, log } = setup(() => {
      throw new TypeError("fetch failed");
    });
    await expect(send("-100", "x", { messageThreadId: undefined })).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("with no worker client, warns and sends nothing", async () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const send = createCommandReplySender(undefined, log);
    await send("-100", "x", { messageThreadId: undefined });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
