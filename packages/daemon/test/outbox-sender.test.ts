import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStorageDb } from "../src/storage/database";
import type { StorageDb } from "../src/storage/database";
import { OutboxSender } from "../src/worker/outbox-sender";
import type { SendNotificationFn } from "../src/worker/outbox-sender";

const BASE_OUTBOX_INPUT = {
  notificationId: "notif-1",
  sessionId: "sess-1",
  requestId: "req-1",
  kind: "question",
  payload: JSON.stringify({ text: "Which option?", replyMarkup: { inline_keyboard: [] }, notificationId: "notif-1" }),
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
    expect(sendNotification).toHaveBeenCalledWith(
      "sess-1",
      "chat-123",
      "Which option?",
      { inline_keyboard: [] },
      undefined,
      "notif-1",
    );

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("sent");
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

  it("sends multiple messages for payload with texts array", async () => {
    // Upsert an outbox entry with texts array
    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      payload: JSON.stringify({
        texts: ["Message 1", "Message 2", "Message 3"],
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
    expect((calls[0] as any)[3]).toEqual({ inline_keyboard: [] });
    expect((calls[1] as any)[3]).toEqual({ inline_keyboard: [] });
    // Last call has the real replyMarkup
    expect((calls[2] as any)[3]).toEqual({ inline_keyboard: [[{ text: "OK", callback_data: "cmd:tok:q0" }]] });
    // Text content
    expect((calls[0] as any)[2]).toBe("Message 1");
    expect((calls[1] as any)[2]).toBe("Message 2");
    expect((calls[2] as any)[2]).toBe("Message 3");

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
});
