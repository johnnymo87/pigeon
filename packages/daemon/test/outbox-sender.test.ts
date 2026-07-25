import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStorageDb } from "../src/storage/database";
import type { StorageDb } from "../src/storage/database";
import { chunkNotificationId, OutboxSender } from "../src/worker/outbox-sender";
import type { SendNotificationFn } from "../src/worker/outbox-sender";
import type { SendNotificationInput } from "../src/worker/poller";

const BASE_OUTBOX_INPUT = {
  notificationId: "notif-1",
  sessionId: "sess-1",
  requestId: "req-1",
  kind: "question",
  payload: JSON.stringify({ message: { text: "Which option?", entities: [{ offset: 0, length: 5, type: "bold" }] }, replyMarkup: { inline_keyboard: [] }, notificationId: "notif-1" }),
  token: "tok-abc",
};

function makeSendNotification(result: { ok: boolean } = { ok: true }): ReturnType<typeof vi.fn> & SendNotificationFn {
  return vi.fn().mockResolvedValue(result) as ReturnType<typeof vi.fn> & SendNotificationFn;
}

describe("OutboxSender.processOnce()", () => {
  let storage: StorageDb;

  beforeEach(() => {
    storage = openStorageDb(":memory:");
  });

  afterEach(() => {
    storage.db.close();
  });

  it("sends queued entries and marks sent on success", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith({
      sessionId: "sess-1",
      chatId: "chat-123",
      text: "Which option?",
      replyMarkup: { inline_keyboard: [] },
      notificationId: "notif-1",
      entities: [{ offset: 0, length: 5, type: "bold" }],
    });

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("sent");
  });

  it("forwards entities through index poller closure when processing outbox entry", async () => {
    const entities = [{ offset: 0, length: 5, type: "bold" }];
    storage.outbox.upsert({
      notificationId: "notif-entities-1",
      sessionId: "sess-1",
      requestId: "req-1",
      kind: "question",
      payload: JSON.stringify({
        message: { text: "Hello formatted", entities },
        replyMarkup: { inline_keyboard: [] },
        notificationId: "notif-entities-1",
      }),
      token: "tok-abc",
    }, 1_000);

    const pollerSendNotification = vi.fn().mockResolvedValue({ ok: true });
    const fakePoller = { sendNotification: pollerSendNotification };

    // This closure matches src/index.ts:275-276 after refactoring
    const sendNotificationClosure: SendNotificationFn = (input) =>
      fakePoller.sendNotification(input);

    const sender = new OutboxSender({
      storage,
      sendNotification: sendNotificationClosure,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(pollerSendNotification).toHaveBeenCalledWith({
      sessionId: "sess-1",
      chatId: "chat-123",
      text: "Hello formatted",
      replyMarkup: { inline_keyboard: [] },
      notificationId: "notif-entities-1",
      entities,
    });
  });

  it("retries on transient failure with backoff (ok: false)", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = makeSendNotification({ ok: false });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(sendNotification).toHaveBeenCalledTimes(1);

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("queued");
    expect(record!.attempts).toBe(1);
    // First backoff is 5000ms; nextRetryAt = 5_000 + 5_000 = 10_000
    expect(record!.nextRetryAt).toBe(10_000);
  });

  it("retries on thrown error with backoff", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockRejectedValue(new Error("Network error")) as unknown as SendNotificationFn;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("queued");
    expect(record!.attempts).toBe(1);
    expect(record!.nextRetryAt).toBe(10_000);
  });

  it("marks terminal failure after max attempts", async () => {
    const now = 5_000;
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    // Simulate 10 prior attempts via markRetry calls
    for (let i = 0; i < 10; i++) {
      storage.outbox.markRetry("notif-1", now, 0);
    }

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.attempts).toBe(10);

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    await sender.processOnce();

    // Should NOT call sendNotification when max attempts reached
    expect(sendNotification).not.toHaveBeenCalled();

    const afterRecord = storage.outbox.getByNotificationId("notif-1");
    expect(afterRecord!.state).toBe("failed");
  });

  it("marks terminal failure after max age (15+ minutes)", async () => {
    const createdAt = 1_000;
    const now = createdAt + 15 * 60 * 1000 + 1; // just past 15 minutes

    storage.outbox.upsert(BASE_OUTBOX_INPUT, createdAt);

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    await sender.processOnce();

    expect(sendNotification).not.toHaveBeenCalled();

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("failed");
  });

  it("skips entries not yet ready for retry (next_retry_at in future)", async () => {
    const now = 5_000;
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);
    // Set a retry time in the future
    storage.outbox.markRetry("notif-1", now, 60_000); // nextRetryAt = 65_000

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now, // still 5_000, before 65_000
    });

    await sender.processOnce();

    // Nothing should be processed — entry is not ready
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("processes up to 5 entries per batch", async () => {
    const now = 1_000;
    for (let i = 0; i < 7; i++) {
      storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, notificationId: `notif-${i}` }, now + i);
    }

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 10_000,
    });

    await sender.processOnce();

    // Only 5 entries should be processed (the batch limit)
    expect(sendNotification).toHaveBeenCalledTimes(5);
  });

  it("sends multiple messages for payload with messages array", async () => {
    // Upsert an outbox entry with messages array
    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      payload: JSON.stringify({
        messages: [
          { text: "Message 1", entities: [] },
          { text: "Message 2", entities: [] },
          { text: "Message 3", entities: [{ offset: 0, length: 7, type: "bold" }] },
        ],
        replyMarkup: { inline_keyboard: [[{ text: "OK", callback_data: "cmd:tok:q0" }]] },
        notificationId: "notif-1",
      }),
    }, 1_000);

    const sendFn = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification: sendFn,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(sendFn).toHaveBeenCalledTimes(3);
    const calls = (sendFn as ReturnType<typeof vi.fn>).mock.calls;
    // First two calls have empty replyMarkup
    expect((calls[0] as any)[0].replyMarkup).toEqual({ inline_keyboard: [] });
    expect((calls[1] as any)[0].replyMarkup).toEqual({ inline_keyboard: [] });
    // Last call has the real replyMarkup
    expect((calls[2] as any)[0].replyMarkup).toEqual({ inline_keyboard: [[{ text: "OK", callback_data: "cmd:tok:q0" }]] });
    // Text content
    expect((calls[0] as any)[0].text).toBe("Message 1");
    expect((calls[1] as any)[0].text).toBe("Message 2");
    expect((calls[2] as any)[0].text).toBe("Message 3");

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record?.state).toBe("sent");
  });

  it("does not call sendNotification when chatId is not configured", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      // no chatId
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    // No chatId means can't send, entry should not be processed
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("prevents overlapping processOnce runs", async () => {
    let resolveFirst!: () => void;
    let callCount = 0;

    const sendNotification = vi.fn(async () => {
      callCount++;
      await new Promise<void>((resolve) => { resolveFirst = resolve; });
      return { ok: true };
    }) as unknown as SendNotificationFn;

    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    // Start first run but don't await it
    const firstRun = sender.processOnce();
    // Try to start a second run while first is still processing
    const secondRun = sender.processOnce();

    // Resolve the first run
    resolveFirst();
    await firstRun;
    await secondRun;

    // Second run should have been skipped (guard flag)
    expect(callCount).toBe(1);
  });

  it("gives every chunk a stable idempotency key so the worker can dedup retries", async () => {
    const ids: Array<string | undefined> = [];
    let failChunk2 = true;
    const sendNotification = vi.fn(async (input: SendNotificationInput) => {
      const text = input.text;
      const notificationId = input.notificationId;
      ids.push(notificationId);
      if (failChunk2 && text === "chunk-2") {
        failChunk2 = false;
        return { ok: false };
      }
      return { ok: true };
    });

    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      payload: JSON.stringify({
        messages: [
          { text: "chunk-1", entities: [] },
          { text: "chunk-2", entities: [] },
          { text: "chunk-3", entities: [] },
        ],
        replyMarkup: { inline_keyboard: [] },
        notificationId: "notif-123",
      }),
    }, 1_000);

    let now = 5_000;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    // Attempt 1: chunk-1 succeeds, chunk-2 fails -> entry marked retry
    await sender.processOnce();
    expect(ids).toEqual(["notif-123#c0", "notif-123#c1"]);

    // Advance time past 5s backoff
    now += 6_000;

    // Attempt 2: chunk-1 succeeds, chunk-2 succeeds, chunk-3 succeeds -> entry sent
    await sender.processOnce();
    expect(ids).toEqual([
      "notif-123#c0",
      "notif-123#c1",
      "notif-123#c0",
      "notif-123#c1",
      "notif-123",
    ]);

    // Every chunk got a defined notificationId
    expect(ids.every((id) => id !== undefined)).toBe(true);

    // Chunk 0's id is identical on both attempts
    expect(ids[0]).toBe(ids[2]);
    // Chunk 1's id is identical on both attempts
    expect(ids[1]).toBe(ids[3]);
  });

  it("preserves bare notificationId for single-chunk entries", async () => {
    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      notificationId: "single-notif-1",
      payload: JSON.stringify({
        messages: [{ text: "Only chunk", entities: [] }],
        replyMarkup: { inline_keyboard: [] },
        notificationId: "single-notif-1",
      }),
    }, 1_000);

    const sendFn = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification: sendFn,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect((sendFn as ReturnType<typeof vi.fn>).mock.calls[0]![0].notificationId).toBe("single-notif-1");
  });

  it("preserves bare notificationId for the last chunk in a multi-chunk entry", async () => {
    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      notificationId: "multi-notif-1",
      payload: JSON.stringify({
        messages: [
          { text: "chunk 1" },
          { text: "chunk 2" },
        ],
        replyMarkup: { inline_keyboard: [] },
        notificationId: "multi-notif-1",
      }),
    }, 1_000);

    const sendFn = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification: sendFn,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(sendFn).toHaveBeenCalledTimes(2);
    const calls = (sendFn as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0].notificationId).toBe("multi-notif-1#c0");
    expect(calls[1]![0].notificationId).toBe("multi-notif-1");
  });

  it("passes undefined notificationId for all chunks when notificationId is missing", async () => {
    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      notificationId: "no-id-notif",
      payload: JSON.stringify({
        messages: [{ text: "chunk 1" }, { text: "chunk 2" }],
        replyMarkup: { inline_keyboard: [] },
        // notificationId omitted
      }),
    }, 1_000);

    const sendFn = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification: sendFn,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(sendFn).toHaveBeenCalledTimes(2);
    const calls = (sendFn as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0].notificationId).toBeUndefined();
    expect(calls[1]![0].notificationId).toBeUndefined();
  });
});

describe("chunkNotificationId unit tests", () => {
  it("returns undefined when notificationId is undefined", () => {
    expect(chunkNotificationId(undefined, 0, false)).toBeUndefined();
    expect(chunkNotificationId(undefined, 0, true)).toBeUndefined();
  });

  it("returns bare notificationId when isLast is true", () => {
    expect(chunkNotificationId("notif-1", 0, true)).toBe("notif-1");
    expect(chunkNotificationId("notif-1", 2, true)).toBe("notif-1");
  });

  it("returns #c{index} suffix when isLast is false", () => {
    expect(chunkNotificationId("notif-1", 0, false)).toBe("notif-1#c0");
    expect(chunkNotificationId("notif-1", 1, false)).toBe("notif-1#c1");
  });
});

describe("OutboxSender start/stop", () => {
  let storage: StorageDb;

  beforeEach(() => {
    vi.useFakeTimers();
    storage = openStorageDb(":memory:");
  });

  afterEach(() => {
    vi.useRealTimers();
    storage.db.close();
  });

  it("starts interval and calls processOnce periodically", async () => {
    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    const processOnceSpy = vi.spyOn(sender, "processOnce").mockResolvedValue(undefined);

    sender.start(1_000);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(processOnceSpy).toHaveBeenCalledTimes(3);

    sender.stop();
  });

  it("stop() clears the interval", async () => {
    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    const processOnceSpy = vi.spyOn(sender, "processOnce").mockResolvedValue(undefined);

    sender.start(1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    sender.stop();

    const callsBeforeStop = processOnceSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(processOnceSpy).toHaveBeenCalledTimes(callsBeforeStop);
  });

  it("pauses the whole outbox when a send reports retryAfter", async () => {
    storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, notificationId: "notif-1" }, 1_000);
    storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, notificationId: "notif-2" }, 1_000);
    storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, notificationId: "notif-3" }, 1_000);

    const sendNotification = vi.fn().mockImplementation(async (input: SendNotificationInput) => {
      if (input.notificationId === "notif-1") {
        return { ok: false, retryAfter: 30 };
      }
      return { ok: true };
    }) as SendNotificationFn;

    let now = 5_000;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    await sender.processOnce();
    expect(sendNotification).toHaveBeenCalledTimes(1); // not 3

    now += 29_000;
    await sender.processOnce();
    expect(sendNotification).toHaveBeenCalledTimes(1); // still paused

    now += 2_000;
    await sender.processOnce();
    expect(sendNotification).toHaveBeenCalledTimes(2); // resumed
  });

  it("does not pause the outbox on ordinary (non-rate-limit) failure", async () => {
    storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, notificationId: "notif-1" }, 1_000);
    storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, notificationId: "notif-2" }, 1_000);
    storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, notificationId: "notif-3" }, 1_000);

    const sendNotification = vi.fn().mockImplementation(async (input: SendNotificationInput) => {
      if (input.notificationId === "notif-1") {
        return { ok: false };
      }
      return { ok: true };
    }) as SendNotificationFn;

    let now = 5_000;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    await sender.processOnce();
    expect(sendNotification).toHaveBeenCalledTimes(3);
  });

  it("clamps pause duration to MAX_PAUSE_MS (300s) when retryAfter is far above ceiling", async () => {
    storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, notificationId: "notif-1" }, 1_000);
    storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, notificationId: "notif-2" }, 1_000);

    const sendNotification = vi.fn().mockImplementation(async (input: SendNotificationInput) => {
      if (input.notificationId === "notif-1") {
        return { ok: false, retryAfter: 3600 };
      }
      return { ok: true };
    }) as SendNotificationFn;

    let now = 5_000;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    await sender.processOnce();
    expect(sendNotification).toHaveBeenCalledTimes(1);

    now += 299_000;
    await sender.processOnce();
    expect(sendNotification).toHaveBeenCalledTimes(1); // still paused at +299s

    now += 2_000;
    await sender.processOnce();
    expect(sendNotification).toHaveBeenCalledTimes(2); // resumed at +301s (300s max pause)
  });

  it("pauses for exact duration when retryAfter is below MAX_PAUSE_MS ceiling", async () => {
    storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, notificationId: "notif-1" }, 1_000);
    storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, notificationId: "notif-2" }, 1_000);

    const sendNotification = vi.fn().mockImplementation(async (input: SendNotificationInput) => {
      if (input.notificationId === "notif-1") {
        return { ok: false, retryAfter: 30 };
      }
      return { ok: true };
    }) as SendNotificationFn;

    let now = 5_000;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    await sender.processOnce();
    expect(sendNotification).toHaveBeenCalledTimes(1);

    now += 29_000;
    await sender.processOnce();
    expect(sendNotification).toHaveBeenCalledTimes(1);

    now += 2_000;
    await sender.processOnce();
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it("does not pause or corrupt state on garbage retryAfter values", async () => {
    const garbageValues = [NaN, -5, 0, "30" as any, undefined, null as any, Infinity];

    for (const garbage of garbageValues) {
      const id1 = `notif-g1-${String(garbage)}`;
      const id2 = `notif-g2-${String(garbage)}`;
      storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, notificationId: id1 }, 1_000);
      storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, notificationId: id2 }, 1_000);

      const sendNotification = vi.fn().mockImplementation(async (input: SendNotificationInput) => {
        if (input.notificationId === id1) {
          return { ok: false, retryAfter: garbage };
        }
        return { ok: true };
      }) as SendNotificationFn;

      let now = 5_000;
      const sender = new OutboxSender({
        storage,
        sendNotification,
        chatId: "chat-123",
        nowFn: () => now,
      });

      await sender.processOnce();
      expect(sendNotification).toHaveBeenCalledTimes(2);
    }
  });
});
