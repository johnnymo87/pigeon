import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStorageDb } from "../src/storage/database";
import type { StorageDb } from "../src/storage/database";
import { REPLY_TOKEN_TTL_MS } from "../src/storage/schema";
import { chunkNotificationId, expiryForKind, OutboxSender, OUTBOX_RATE_LIMIT, OUTBOX_RATE_WINDOW_MS, SWARM_SUB_BUDGET } from "../src/worker/outbox-sender";
import type { RegisterSessionFn, SendNotificationFn, UnregisterSessionFn } from "../src/worker/outbox-sender";
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

  it("passes title, dir, and threaded from outbox payload to sendNotification", async () => {
    storage.outbox.upsert({
      notificationId: "notif-topic-1",
      sessionId: "sess-topic-1",
      requestId: "req-1",
      kind: "stop",
      payload: JSON.stringify({
        messages: [{ text: "Done" }],
        replyMarkup: { inline_keyboard: [] },
        notificationId: "notif-topic-1",
        title: "Fix bug",
        dir: "/home/dev/pigeon",
        threaded: true,
      }),
      token: "tok-abc",
    }, 1_000);

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(sendNotification).toHaveBeenCalledWith({
      sessionId: "sess-topic-1",
      chatId: "chat-123",
      text: "Done",
      replyMarkup: { inline_keyboard: [] },
      notificationId: "notif-topic-1",
      entities: undefined,
      title: "Fix bug",
      dir: "/home/dev/pigeon",
      threaded: true,
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

  it("headline incident test: sustained transport outage across 30 ticks does NOT increment attempts or mark entry failed", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "transport_error",
      error: "Worker unreachable",
    }) as unknown as SendNotificationFn;

    let now = 5_000;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    // Run 30 ticks (well past MAX_ATTEMPTS = 10)
    for (let tick = 0; tick < 30; tick++) {
      await sender.processOnce();
      const rec = storage.outbox.getByNotificationId("notif-1");
      now = (rec?.nextRetryAt ?? now) + 1;
    }

    expect(sendNotification).toHaveBeenCalledTimes(30);

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record).not.toBeNull();
    expect(record!.state).toBe("queued");
    expect(record!.attempts).toBe(0);
  });

  it("complementary test: genuine per-message failure (403) still reaches terminal after MAX_ATTEMPTS", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 403,
      body: { error: "Forbidden" },
    }) as unknown as SendNotificationFn;

    let now = 5_000;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    // Run 10 ticks advancing time according to backoff
    for (let tick = 0; tick < 10; tick++) {
      await sender.processOnce();
      const rec = storage.outbox.getByNotificationId("notif-1");
      now = (rec?.nextRetryAt ?? now) + 1;
    }

    const recordAfter10 = storage.outbox.getByNotificationId("notif-1");
    expect(recordAfter10!.attempts).toBe(10);

    // 11th tick: MAX_ATTEMPTS reached, entry marked failed
    await sender.processOnce();
    const recordAfter11 = storage.outbox.getByNotificationId("notif-1");
    expect(recordAfter11!.state).toBe("failed");
    expect(recordAfter11!.failedReason).toBe("attempts_exhausted");
  });

  it("429 reschedules and pauses but does NOT increment attempts", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 429,
      body: { error: "rate_limited", retryAfter: 10 },
      retryAfter: 10,
    }) as unknown as SendNotificationFn;

    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("queued");
    expect(record!.attempts).toBe(0);
  });

  it("transient re-registration failure (transport_error on registerSession) reschedules without incrementing attempts", async () => {
    storage.sessions.upsert({ sessionId: "sess-1", label: "Label" }, 1_000);
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 404,
      body: { error: "Session not found" },
    }) as unknown as SendNotificationFn;

    const registerSession = vi.fn().mockResolvedValue({
      ok: false,
      kind: "transport_error",
      error: "DNS lookup failed",
    }) as unknown as RegisterSessionFn;

    const sender = new OutboxSender({
      storage,
      sendNotification,
      registerSession,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(registerSession).toHaveBeenCalledTimes(1);
    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("queued");
    expect(record!.attempts).toBe(0);
  });

  it("catch-all delivery threw handler increments attempts conservatively", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockRejectedValue(new Error("Code bug")) as unknown as SendNotificationFn;
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
  });

  it("logs structured classification and status on delivery failure", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const logFn = vi.fn();
    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 429,
      body: { error: "rate_limited" },
      retryAfter: 30,
    }) as unknown as SendNotificationFn;

    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
      log: logFn,
    });

    await sender.processOnce();

    expect(logFn).toHaveBeenCalledWith(
      "outbox entry delivery failed, scheduling retry",
      expect.objectContaining({
        notificationId: "notif-1",
        kind: "http_error",
        status: 429,
        body: { error: "rate_limited" },
      }),
    );
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
    expect(afterRecord!.failedReason).toBe("attempts_exhausted");
  });

  it("incident test: stop entry survives a 2-hour transport outage and remains queued", async () => {
    const createdAt = 1_000;
    // 2 hours later (well past old 15m cap)
    const now = createdAt + 2 * 60 * 60 * 1000;

    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      kind: "stop",
      notificationId: "notif-stop-outage",
    }, createdAt);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "transport_error",
      error: "Worker unreachable",
    }) as unknown as SendNotificationFn;

    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    await sender.processOnce();

    const record = storage.outbox.getByNotificationId("notif-stop-outage");
    expect(record!.state).toBe("queued");
    expect(record!.attempts).toBe(0);
  });

  it("question entry expires at 4 hours with failed_reason = 'expired'", async () => {
    const createdAt = 1_000;
    const fourHoursMs = 4 * 60 * 60 * 1000;
    const now = createdAt + fourHoursMs + 1; // 4 hours + 1ms

    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      kind: "question",
      notificationId: "notif-q-expire",
    }, createdAt);

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    await sender.processOnce();

    expect(sendNotification).not.toHaveBeenCalled();
    const record = storage.outbox.getByNotificationId("notif-q-expire");
    expect(record!.state).toBe("failed");
    expect(record!.failedReason).toBe("expired");
  });

  it("stop entry expires at 24 hours with failed_reason = 'expired'", async () => {
    const createdAt = 1_000;
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    const now = createdAt + twentyFourHoursMs + 1; // 24 hours + 1ms

    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      kind: "stop",
      notificationId: "notif-stop-expire",
    }, createdAt);

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    await sender.processOnce();

    expect(sendNotification).not.toHaveBeenCalled();
    const record = storage.outbox.getByNotificationId("notif-stop-expire");
    expect(record!.state).toBe("failed");
    expect(record!.failedReason).toBe("expired");
  });

  it("question entry at 5 hours old is NOT delivered (expiry evaluated before send attempt)", async () => {
    const createdAt = 1_000;
    const fiveHoursMs = 5 * 60 * 60 * 1000;
    const now = createdAt + fiveHoursMs;

    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      kind: "question",
      notificationId: "notif-q-5h",
    }, createdAt);

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    await sender.processOnce();

    expect(sendNotification).not.toHaveBeenCalled();
    const record = storage.outbox.getByNotificationId("notif-q-5h");
    expect(record!.state).toBe("failed");
    expect(record!.failedReason).toBe("expired");
  });

  it("unknown kind falls back to 24h expiry", async () => {
    const createdAt = 1_000;
    const twentyThreeHoursMs = 23 * 60 * 60 * 1000;
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;

    // At 23h: still queued
    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      kind: "weird_kind",
      notificationId: "notif-unknown-kind",
    }, createdAt);

    const sendNotification = makeSendNotification({ ok: true });
    let now = createdAt + twentyThreeHoursMs;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    await sender.processOnce();
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(storage.outbox.getByNotificationId("notif-unknown-kind")!.state).toBe("sent");

    // Re-upsert for expiry test at 24h + 1ms
    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      kind: "weird_kind",
      notificationId: "notif-unknown-kind-2",
    }, createdAt);

    sendNotification.mockClear();
    now = createdAt + twentyFourHoursMs + 1;
    await sender.processOnce();

    expect(sendNotification).not.toHaveBeenCalled();
    const record = storage.outbox.getByNotificationId("notif-unknown-kind-2");
    expect(record!.state).toBe("failed");
    expect(record!.failedReason).toBe("expired");
  });

  it("attempts_exhausted terminates independently of age and records attempts_exhausted reason", async () => {
    const now = 5_000;
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000); // 4s old, well within 4h

    // 10 attempts
    for (let i = 0; i < 10; i++) {
      storage.outbox.markRetry("notif-1", now, 0);
    }

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
    expect(record!.failedReason).toBe("attempts_exhausted");
  });

  it("resurrected failed entry older than 15m gets fresh created_at and is actually sent instead of dropped", async () => {
    const initialCreatedAt = 1_000;
    // Entry originally created at t=1,000 and fails at t=2,000
    storage.outbox.upsert(BASE_OUTBOX_INPUT, initialCreatedAt);
    storage.outbox.markFailed("notif-1", 2_000, "budget_exhausted", "Max attempts reached");

    // 20 minutes later (past 15 min max age), entry is resurrected via upsert
    const resurrectTime = initialCreatedAt + 20 * 60 * 1000;
    storage.outbox.upsert(BASE_OUTBOX_INPUT, resurrectTime);

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => resurrectTime,
    });

    await sender.processOnce();

    // After resurrection, processOnce SHOULD attempt send rather than dropping it as expired
    expect(sendNotification).toHaveBeenCalledTimes(1);

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("sent");
    expect(record!.createdAt).toBe(resurrectTime);
  });

  it("marks terminal failure on payload JSON parse error and records reason and error", async () => {
    const now = 5_000;
    storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, payload: "invalid-json{" }, 1_000);

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
    expect(record!.failedReason).toBe("payload_parse_failed");
    expect(record!.lastError).toBeTruthy();
  });

  it("marks terminal failure on empty payload messages array", async () => {
    const now = 5_000;
    storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, payload: JSON.stringify({ messages: [] }) }, 1_000);

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
    expect(record!.failedReason).toBe("payload_empty");
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
        return { ok: false as const, kind: "http_error" as const, status: 500, body: "error" };
      }
      return { ok: true as const, kind: "success" as const, status: 200, body: { ok: true } };
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

describe("expiryForKind unit tests", () => {
  it("expires swarm after 24h and mirror after 6h", () => {
    expect(expiryForKind("swarm")).toBe(REPLY_TOKEN_TTL_MS);
    expect(expiryForKind("mirror")).toBe(6 * 60 * 60 * 1000);
  });

  it("returns PENDING_QUESTION_TTL_MS (4h) for question", () => {
    expect(expiryForKind("question")).toBe(4 * 60 * 60 * 1000);
  });

  it("returns REPLY_TOKEN_TTL_MS (24h) for stop", () => {
    expect(expiryForKind("stop")).toBe(24 * 60 * 60 * 1000);
  });

  it("returns REPLY_TOKEN_TTL_MS (24h) for card", () => {
    expect(expiryForKind("card")).toBe(24 * 60 * 60 * 1000);
  });

  it("returns REPLY_TOKEN_TTL_MS (24h) default for unknown kind", () => {
    expect(expiryForKind("unknown_kind")).toBe(24 * 60 * 60 * 1000);
    expect(expiryForKind("")).toBe(24 * 60 * 60 * 1000);
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

  it("a 429 during card drain results in retry, NOT loss (bug fix verification)", async () => {
    // Enqueue a card notification with kind 'card'
    const cardId = "cs:cmd-card-1:ses_1";
    storage.outbox.upsert({
      notificationId: cardId,
      sessionId: "ses_1",
      requestId: "cs-cs:cmd-card-1:ses_1",
      kind: "card",
      payload: JSON.stringify({
        message: { text: "🟢 active Session 1", entities: [] },
        replyMarkup: { inline_keyboard: [] },
        notificationId: cardId,
        threaded: false,
      }),
      token: "tok-card-1",
    }, 1_000);

    let sendCount = 0;
    const sendNotification = vi.fn().mockImplementation(async () => {
      sendCount++;
      if (sendCount === 1) {
        // Exactly what the worker returns when Telegram rate-limits the group:
        // HTTP 429 with a JSON body carrying retryAfter. See packages/worker/src/notifications.ts.
        return {
          ok: false,
          kind: "http_error",
          status: 429,
          body: { error: "rate_limited", retryAfter: 10 },
          retryAfter: 10,
        };
      }
      return { ok: true, kind: "success", status: 200, body: { ok: true } };
    }) as SendNotificationFn;

    let now = 5_000;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    // First attempt hits 429
    await sender.processOnce();
    expect(sendNotification).toHaveBeenCalledTimes(1);

    // Verify entry is NOT lost/failed, but remains retryable (attempts = 0 on 429 rate limit)
    const recordAfter429 = storage.outbox.getByNotificationId(cardId);
    expect(recordAfter429).not.toBeNull();
    expect(recordAfter429!.state).toBe("queued");
    expect(recordAfter429!.attempts).toBe(0);
    expect(recordAfter429!.nextRetryAt).toBeGreaterThan(now);

    // Fast-forward past pause + retry backoff (10s pause = 10,000ms)
    now += 15_000;
    await sender.processOnce();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    const recordAfterRetry = storage.outbox.getByNotificationId(cardId);
    expect(recordAfterRetry!.state).toBe("sent");
  });
});

describe("classified delivery failure actions", () => {
  let storage: StorageDb;

  beforeEach(() => {
    storage = openStorageDb(":memory:");
  });

  afterEach(() => {
    storage.db.close();
  });

  it("404 + local session present -> registerSession called with session label, markRetry, no re-send in same tick", async () => {
    storage.sessions.upsert({ sessionId: "sess-1", label: "My Session Label" }, 1_000);
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 404,
      body: { error: "Session not found" },
    }) as unknown as SendNotificationFn;

    const registerSession = vi.fn().mockResolvedValue({
      ok: true,
      kind: "success",
      status: 200,
      body: { ok: true },
    }) as unknown as RegisterSessionFn;

    const sender = new OutboxSender({
      storage,
      sendNotification,
      registerSession,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(registerSession).toHaveBeenCalledTimes(1);
    expect(registerSession).toHaveBeenCalledWith("sess-1", "My Session Label");

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("queued");
    expect(record!.attempts).toBe(1);
  });

  it("404 + local session ABSENT -> terminal, registerSession NOT called", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 404,
      body: { error: "Session not found" },
    }) as unknown as SendNotificationFn;

    const registerSession = vi.fn() as unknown as RegisterSessionFn;

    const sender = new OutboxSender({
      storage,
      sendNotification,
      registerSession,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(registerSession).not.toHaveBeenCalled();

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("failed");
    expect(record!.failedReason).toBe("Session not locally known (reaped or never existed)");
    expect(record!.lastError).toBe('HTTP 404 - {"error":"Session not found"}');
  });

  it("404 + register succeeds but local row vanished in between -> unregisterSession called and entry goes terminal", async () => {
    storage.sessions.upsert({ sessionId: "sess-1", label: "My Session Label" }, 1_000);
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 404,
      body: { error: "Session not found" },
    }) as unknown as SendNotificationFn;

    const unregisterSession = vi.fn().mockResolvedValue(undefined) as unknown as UnregisterSessionFn;

    const registerSession = vi.fn().mockImplementation(async () => {
      storage.sessions.delete("sess-1");
      return { ok: true, kind: "success", status: 200, body: { ok: true } };
    }) as unknown as RegisterSessionFn;

    const sender = new OutboxSender({
      storage,
      sendNotification,
      registerSession,
      unregisterSession,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(registerSession).toHaveBeenCalledTimes(1);
    expect(unregisterSession).toHaveBeenCalledWith("sess-1");

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("failed");
    expect(record!.failedReason).toBe("reregister_compensated");
  });

  it("404 twice on the same entry -> second time is terminal (flag consumed)", async () => {
    storage.sessions.upsert({ sessionId: "sess-1", label: "My Session Label" }, 1_000);
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 404,
      body: { error: "Session not found" },
    }) as unknown as SendNotificationFn;

    const registerSession = vi.fn().mockResolvedValue({
      ok: true,
      kind: "success",
      status: 200,
      body: { ok: true },
    }) as unknown as RegisterSessionFn;

    let now = 5_000;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      registerSession,
      chatId: "chat-123",
      nowFn: () => now,
    });

    // Tick 1: 404 -> re-registered -> markRetry
    await sender.processOnce();
    expect(registerSession).toHaveBeenCalledTimes(1);
    expect(storage.outbox.getByNotificationId("notif-1")!.state).toBe("queued");

    // Tick 2: 404 again -> alreadyReregistered is true -> terminal
    now += 6_000;
    await sender.processOnce();
    expect(registerSession).toHaveBeenCalledTimes(1);
    expect(storage.outbox.getByNotificationId("notif-1")!.state).toBe("failed");
  });

  it("404 + register fails with transport_error -> plain markRetry, and subsequent 404 attempts re-registration AGAIN", async () => {
    storage.sessions.upsert({ sessionId: "sess-1", label: "My Session Label" }, 1_000);
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 404,
      body: { error: "Session not found" },
    }) as unknown as SendNotificationFn;

    const registerSession = vi.fn().mockResolvedValue({
      ok: false,
      kind: "transport_error",
      error: "DNS lookup failed",
    }) as unknown as RegisterSessionFn;

    let now = 5_000;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      registerSession,
      chatId: "chat-123",
      nowFn: () => now,
    });

    // Tick 1: 404 -> register fails with transport_error -> plain retry
    await sender.processOnce();
    expect(registerSession).toHaveBeenCalledTimes(1);
    expect(storage.outbox.getByNotificationId("notif-1")!.state).toBe("queued");

    // Tick 2: 404 again -> attempts re-registration again because flag was not set
    now += 6_000;
    await sender.processOnce();
    expect(registerSession).toHaveBeenCalledTimes(2);
    expect(storage.outbox.getByNotificationId("notif-1")!.state).toBe("queued");
  });

  it("404 + register fails with a definitive 4xx -> terminal", async () => {
    storage.sessions.upsert({ sessionId: "sess-1", label: "My Session Label" }, 1_000);
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 404,
      body: { error: "Session not found" },
    }) as unknown as SendNotificationFn;

    const registerSession = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 400,
      body: { error: "sessionId and machineId required" },
    }) as unknown as RegisterSessionFn;

    const sender = new OutboxSender({
      storage,
      sendNotification,
      registerSession,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(registerSession).toHaveBeenCalledTimes(1);
    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("failed");
    expect(record!.failedReason).toBe("reregister_failed");
    expect(record!.lastError).toBe('HTTP 400 - {"error":"sessionId and machineId required"}');
  });

  // A register 429 is "Session limit reached" (packages/worker/src/sessions.ts:69) — a CAPACITY
  // condition that clears as other sessions are unregistered, not a property of this message.
  // Terminal here would be permanent loss; retry is bounded by the normal attempt budget.
  it("404 + register fails with 429 session-limit -> retryable, NOT terminal", async () => {
    storage.sessions.upsert({ sessionId: "sess-1", label: "My Session Label" }, 1_000);
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 404,
      body: { error: "Session not found" },
    }) as unknown as SendNotificationFn;

    const registerSession = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 429,
      body: { error: "Session limit reached" },
    }) as unknown as RegisterSessionFn;

    const sender = new OutboxSender({
      storage,
      sendNotification,
      registerSession,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(registerSession).toHaveBeenCalledTimes(1);
    expect(storage.outbox.getByNotificationId("notif-1")!.state).toBe("queued");
    // The re-register flag must NOT be consumed, and 429 transient register failure must NOT count an attempt.
    expect(storage.outbox.getByNotificationId("notif-1")!.attempts).toBe(0);
  });

  // app_rejection is HTTP 2xx carrying ok:false — inherently ambiguous, so it must retry.
  // Unreachable from /sessions/register today; pinned so it cannot regress into data loss.
  it("404 + register fails with app_rejection -> retryable, NOT terminal", async () => {
    storage.sessions.upsert({ sessionId: "sess-1", label: "My Session Label" }, 1_000);
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 404,
      body: { error: "Session not found" },
    }) as unknown as SendNotificationFn;

    const registerSession = vi.fn().mockResolvedValue({
      ok: false,
      kind: "app_rejection",
      status: 200,
      body: { ok: false },
    }) as unknown as RegisterSessionFn;

    const sender = new OutboxSender({
      storage,
      sendNotification,
      registerSession,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(registerSession).toHaveBeenCalledTimes(1);
    expect(storage.outbox.getByNotificationId("notif-1")!.state).toBe("queued");
  });

  it("403 keeps retrying and is never terminal, preserving the config-rollback window", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 403,
      body: { error: "Forbidden" },
    }) as unknown as SendNotificationFn;

    let now = 5_000;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    // Attempt 0: retry
    await sender.processOnce();
    expect(storage.outbox.getByNotificationId("notif-1")!.state).toBe("queued");
    expect(storage.outbox.getByNotificationId("notif-1")!.attempts).toBe(1);

    // Attempt 1: retry
    now += 6_000;
    await sender.processOnce();
    expect(storage.outbox.getByNotificationId("notif-1")!.state).toBe("queued");
    expect(storage.outbox.getByNotificationId("notif-1")!.attempts).toBe(2);

    // Attempt 2: STILL retrying. A 403 reflects worker config (ALLOWED_CHAT_IDS), not the
    // message, and never reaches Telegram (rejected at notifications.ts:202, before
    // createTelegramClient at :248), so it costs none of the shared 20/min group budget.
    // Killing it early would only convert a recoverable misconfiguration into permanent loss.
    now += 12_000;
    await sender.processOnce();
    expect(storage.outbox.getByNotificationId("notif-1")!.state).toBe("queued");
    expect(storage.outbox.getByNotificationId("notif-1")!.attempts).toBe(3);
  });

  it("400 -> terminal", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 400,
      body: { error: "sessionId, chatId, and text required" },
    }) as unknown as SendNotificationFn;

    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("failed");
    expect(record!.failedReason).toBe("Worker field validation failed (HTTP 400)");
    expect(record!.lastError).toBe('HTTP 400 - {"error":"sessionId, chatId, and text required"}');
  });

  it("502 with details.error_code 400 and entities -> payload rewritten WITHOUT entities and markRetry", async () => {
    const payloadWithEntities = JSON.stringify({
      messages: [
        { text: "Hello", entities: [{ type: "bold", offset: 0, length: 5 }] },
      ],
      replyMarkup: { inline_keyboard: [] },
      notificationId: "notif-1",
    });
    storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, payload: payloadWithEntities }, 1_000);

    const logFn = vi.fn();
    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 502,
      body: { details: { error_code: 400, description: "Bad Request: can't parse entities" } },
    }) as unknown as SendNotificationFn;

    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
      log: logFn,
    });

    await sender.processOnce();

    const record = storage.outbox.getByNotificationId("notif-1")!;
    expect(record.state).toBe("queued");
    expect(record.attempts).toBe(1);

    const updatedParsed = JSON.parse(record.payload);
    expect(updatedParsed.messages[0].entities).toBeUndefined();

    expect(logFn).toHaveBeenCalledWith(
      "outbox entry stripped entities, scheduling retry",
      expect.objectContaining({
        notificationId: "notif-1",
        sessionId: "sess-1",
        attempts: 1,
        nextRetryIn: 5000,
        telegramErrorCode: 400,
        telegramErrorDescription: "Bad Request: can't parse entities",
      }),
    );
  });

  // The legacy singular 'message' payload shape is still production-reachable (question
  // notifications write it), and the strip arm handles it. Adversarial
  // review noted it was only ever verified by reading the code, never by a test.
  it("502 entity-400 strips the LEGACY singular message shape too, preserving replyMarkup", async () => {
    const legacyPayload = JSON.stringify({
      message: { text: "Hello", entities: [{ type: "bold", offset: 0, length: 5 }] },
      replyMarkup: { inline_keyboard: [[{ text: "Reply", callback_data: "cmd:abc" }]] },
      notificationId: "notif-1",
    });
    storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, payload: legacyPayload }, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 502,
      body: { details: { error_code: 400, description: "Bad Request: can't parse entities" } },
    }) as unknown as SendNotificationFn;

    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    const record = storage.outbox.getByNotificationId("notif-1")!;
    expect(record.state).toBe("queued");

    const parsed = JSON.parse(record.payload);
    expect(parsed.message.entities).toBeUndefined();
    // The text must survive so it can still be delivered unformatted...
    expect(parsed.message.text).toBe("Hello");
    // ...and stripping must not collateral-damage the swipe-reply keyboard.
    expect(parsed.replyMarkup.inline_keyboard[0][0].callback_data).toBe("cmd:abc");
  });

  // A failed compensating unregister leaks a worker session row permanently: the reaper only
  // unregisters sessions it still holds locally, and the worker has no session TTL cron.
  it("logs a LEAK when the compensating unregister fails after the row vanished", async () => {
    storage.sessions.upsert({ sessionId: "sess-1", label: "Label" }, 1_000);
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 404,
      body: { error: "Session not found" },
    }) as unknown as SendNotificationFn;

    const registerSession = vi.fn().mockImplementation(async () => {
      // The reaper wins the race: the local row disappears during registration.
      storage.sessions.delete("sess-1");
      return { ok: true, kind: "success", status: 200, body: { ok: true } };
    }) as unknown as RegisterSessionFn;

    const unregisterSession = vi.fn().mockResolvedValue({
      ok: false,
      kind: "transport_error",
      error: "ECONNREFUSED",
    });

    const logged: string[] = [];
    const sender = new OutboxSender({
      storage,
      sendNotification,
      registerSession,
      unregisterSession,
      chatId: "chat-123",
      nowFn: () => 5_000,
      log: (msg) => logged.push(msg),
    });

    await sender.processOnce();

    expect(unregisterSession).toHaveBeenCalledWith("sess-1");
    expect(storage.outbox.getByNotificationId("notif-1")!.state).toBe("failed");
    expect(logged.some((m) => m.includes("LEAKED worker session row"))).toBe(true);
  });

  it("successful send marks sent and clears re-register flag", async () => {
    storage.sessions.upsert({ sessionId: "sess-1", label: "Label" }, 1_000);
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    let sendCallCount = 0;
    const sendNotification = vi.fn().mockImplementation(async () => {
      sendCallCount++;
      if (sendCallCount === 1) {
        return { ok: false, kind: "http_error", status: 404, body: {} };
      }
      return { ok: true, kind: "success", status: 200, body: {} };
    }) as SendNotificationFn;

    const registerSession = vi.fn().mockResolvedValue({
      ok: true,
      kind: "success",
      status: 200,
      body: {},
    }) as unknown as RegisterSessionFn;

    let now = 5_000;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      registerSession,
      chatId: "chat-123",
      nowFn: () => now,
    });

    // Tick 1: 404 -> re-register -> queued
    await sender.processOnce();
    expect(storage.outbox.getByNotificationId("notif-1")!.state).toBe("queued");

    // Tick 2: send succeeds -> sent and flag cleared
    now += 6_000;
    await sender.processOnce();
    expect(storage.outbox.getByNotificationId("notif-1")!.state).toBe("sent");
  });

  it("composition: 404 -> reregister -> next tick 502-entity -> strip -> next tick success", async () => {
    storage.sessions.upsert({ sessionId: "sess-1", label: "My Label" }, 1_000);
    const payload = JSON.stringify({
      messages: [{ text: "Bad [entity](link)", entities: [{ type: "text_link", offset: 4, length: 14 }] }],
      replyMarkup: { inline_keyboard: [] },
      notificationId: "notif-comp",
    });
    storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, notificationId: "notif-comp", payload }, 1_000);

    let tickCount = 0;
    const sendNotification = vi.fn().mockImplementation(async () => {
      tickCount++;
      if (tickCount === 1) {
        return { ok: false, kind: "http_error", status: 404, body: "session missing" };
      }
      if (tickCount === 2) {
        return {
          ok: false,
          kind: "http_error",
          status: 502,
          body: { details: { error_code: 400, description: "Can't parse entities" } },
        };
      }
      return { ok: true, kind: "success", status: 200, body: { ok: true } };
    }) as SendNotificationFn;

    const registerSession = vi.fn().mockResolvedValue({
      ok: true,
      kind: "success",
      status: 200,
      body: { ok: true },
    }) as unknown as RegisterSessionFn;

    let now = 5_000;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      registerSession,
      chatId: "chat-123",
      nowFn: () => now,
    });

    // Tick 1: 404 -> reregister
    await sender.processOnce();
    expect(registerSession).toHaveBeenCalledTimes(1);
    const record1 = storage.outbox.getByNotificationId("notif-comp")!;
    expect(record1.state).toBe("queued");
    expect(record1.attempts).toBe(1);

    // Tick 2: 502 entity -> strip_entities
    now += 6_000;
    await sender.processOnce();
    const record2 = storage.outbox.getByNotificationId("notif-comp")!;
    expect(record2.state).toBe("queued");
    expect(record2.attempts).toBe(2);
    expect(JSON.parse(record2.payload).messages[0].entities).toBeUndefined();

    // Tick 3: Success
    now += 12_000;
    await sender.processOnce();
    const record3 = storage.outbox.getByNotificationId("notif-comp")!;
    expect(record3.state).toBe("sent");
    expect(sendNotification).toHaveBeenCalledTimes(3);
    expect(record3.attempts).toBe(2); // 2 retries on 2 failed attempts
  });
});

describe("OutboxSender rate governor", () => {
  let storage: StorageDb;

  beforeEach(() => {
    storage = openStorageDb(":memory:");
  });

  afterEach(() => {
    storage.db.close();
  });

  it("stops sending after reaching OUTBOX_RATE_LIMIT within sliding window (a)", async () => {
    for (let i = 0; i < 15; i++) {
      storage.outbox.upsert({
        ...BASE_OUTBOX_INPUT,
        notificationId: `notif-gov-${i}`,
      }, 1_000);
    }

    const sendNotification = makeSendNotification({ ok: true });
    let now = 5_000;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    await sender.processOnce();
    await sender.processOnce();
    await sender.processOnce();

    expect(sendNotification).toHaveBeenCalledTimes(OUTBOX_RATE_LIMIT);
    const remainingCount = storage.outbox.getReady(now, 100).length;
    expect(remainingCount).toBe(3);
  });

  it("advances window and resumes delivery when nowFn moves past 60s (b)", async () => {
    for (let i = 0; i < 15; i++) {
      storage.outbox.upsert({
        ...BASE_OUTBOX_INPUT,
        notificationId: `notif-gov-${i}`,
      }, 1_000);
    }

    const sendNotification = makeSendNotification({ ok: true });
    let now = 5_000;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    await sender.processOnce();
    await sender.processOnce();
    await sender.processOnce();
    expect(sendNotification).toHaveBeenCalledTimes(12);

    now += OUTBOX_RATE_WINDOW_MS + 1_000;

    await sender.processOnce();
    expect(sendNotification).toHaveBeenCalledTimes(15);
    expect(storage.outbox.getReady(now, 100).length).toBe(0);
  });

  it("counts chunks rather than outbox entries (c)", async () => {
    for (let i = 0; i < 5; i++) {
      storage.outbox.upsert({
        ...BASE_OUTBOX_INPUT,
        notificationId: `notif-chunk3-${i}`,
        payload: JSON.stringify({
          messages: [{ text: "c1" }, { text: "c2" }, { text: "c3" }],
          replyMarkup: { inline_keyboard: [] },
          notificationId: `notif-chunk3-${i}`,
        }),
      }, 1_000);
    }

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(sendNotification).toHaveBeenCalledTimes(12);
    expect(storage.outbox.getReady(5_000, 100).length).toBe(1);
  });

  it("never tears an entry: per-entry governor check sends all chunks of a started entry (d)", async () => {
    for (let i = 0; i < 3; i++) {
      storage.outbox.upsert({
        ...BASE_OUTBOX_INPUT,
        notificationId: `notif-multichunk-${i}`,
        payload: JSON.stringify({
          messages: [{ text: "c1" }, { text: "c2" }, { text: "c3" }, { text: "c4" }, { text: "c5" }],
          replyMarkup: { inline_keyboard: [] },
          notificationId: `notif-multichunk-${i}`,
        }),
      }, 1_000);
    }

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(sendNotification).toHaveBeenCalledTimes(15);
    for (let i = 0; i < 3; i++) {
      const rec = storage.outbox.getByNotificationId(`notif-multichunk-${i}`);
      expect(rec!.state).toBe("sent");
    }
  });

  it("starvation guard: entry with more chunks than limit sends against empty window (e)", async () => {
    const messages = Array.from({ length: 15 }, (_, i) => ({ text: `msg-${i}` }));
    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      notificationId: "notif-large-1",
      payload: JSON.stringify({
        messages,
        replyMarkup: { inline_keyboard: [] },
        notificationId: "notif-large-1",
      }),
    }, 1_000);

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(sendNotification).toHaveBeenCalledTimes(15);
    const rec = storage.outbox.getByNotificationId("notif-large-1");
    expect(rec!.state).toBe("sent");
  });

  it("normal low-volume operation is completely unaffected (f)", async () => {
    storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, notificationId: "notif-low-1" }, 1_000);
    storage.outbox.upsert({ ...BASE_OUTBOX_INPUT, notificationId: "notif-low-2" }, 1_000);

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(storage.outbox.getByNotificationId("notif-low-1")!.state).toBe("sent");
    expect(storage.outbox.getByNotificationId("notif-low-2")!.state).toBe("sent");
  });

  it("never lets swarm entries take more than the sub-budget in one window", async () => {
    for (let i = 0; i < 10; i++) {
      storage.outbox.upsert({
        ...BASE_OUTBOX_INPUT,
        notificationId: `notif-swarm-${i}`,
        kind: "swarm",
        payload: JSON.stringify({
          messages: [{ text: `swarm-${i}` }],
          replyMarkup: { inline_keyboard: [] },
          notificationId: `notif-swarm-${i}`,
        }),
      }, 1_000 + i);
    }

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();
    await sender.processOnce();

    expect(sendNotification).toHaveBeenCalledTimes(SWARM_SUB_BUDGET);
  });

  it("still delivers a question while a swarm burst is saturating the sub-budget", async () => {
    for (let i = 0; i < 8; i++) {
      storage.outbox.upsert({
        ...BASE_OUTBOX_INPUT,
        notificationId: `notif-swarm-${i}`,
        kind: "swarm",
        payload: JSON.stringify({
          messages: [{ text: `swarm-${i}` }],
          replyMarkup: { inline_keyboard: [] },
          notificationId: `notif-swarm-${i}`,
        }),
      }, 1_000 + i);
    }

    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      notificationId: "notif-question-urgent",
      kind: "question",
      payload: JSON.stringify({
        messages: [{ text: "Urgent question?" }],
        replyMarkup: { inline_keyboard: [] },
        notificationId: "notif-question-urgent",
      }),
    }, 1_000);

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();
    await sender.processOnce();

    expect(storage.outbox.getByNotificationId("notif-question-urgent")!.state).toBe("sent");
  });

  it("counts chunks, not entries, against the sub-budget", async () => {
    const chunk5Msg = [{ text: "c1" }, { text: "c2" }, { text: "c3" }, { text: "c4" }, { text: "c5" }];
    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      notificationId: "swarm-5chunk-1",
      kind: "swarm",
      payload: JSON.stringify({
        messages: chunk5Msg,
        replyMarkup: { inline_keyboard: [] },
        notificationId: "swarm-5chunk-1",
      }),
    }, 1_000);

    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      notificationId: "swarm-5chunk-2",
      kind: "swarm",
      payload: JSON.stringify({
        messages: chunk5Msg,
        replyMarkup: { inline_keyboard: [] },
        notificationId: "swarm-5chunk-2",
      }),
    }, 1_001);

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();

    expect(sendNotification).toHaveBeenCalledTimes(5);
    expect(storage.outbox.getByNotificationId("swarm-5chunk-1")!.state).toBe("sent");
    expect(storage.outbox.getByNotificationId("swarm-5chunk-2")!.state).toBe("queued");
  });

  it("allows non-low-priority traffic (questions/stops/cards) to take all OUTBOX_RATE_LIMIT slots when no swarm work is queued", async () => {
    for (let i = 0; i < 15; i++) {
      storage.outbox.upsert({
        ...BASE_OUTBOX_INPUT,
        notificationId: `notif-q-${i}`,
        kind: "question",
        payload: JSON.stringify({
          messages: [{ text: `question-${i}` }],
          replyMarkup: { inline_keyboard: [] },
          notificationId: `notif-q-${i}`,
        }),
      }, 1_000 + i);
    }

    const sendNotification = makeSendNotification({ ok: true });
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
    });

    await sender.processOnce();
    await sender.processOnce();
    await sender.processOnce();

    expect(sendNotification).toHaveBeenCalledTimes(OUTBOX_RATE_LIMIT);
  });

  it("escalates backoff under sustained transport failure while attempts stays 0", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "transport_error",
      error: "connect ECONNREFUSED",
    }) as unknown as SendNotificationFn;

    let now = 10_000;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    const expectedBackoffs = [5_000, 10_000, 30_000, 60_000, 120_000, 120_000];

    for (const expectedBackoff of expectedBackoffs) {
      await sender.processOnce();
      const record = storage.outbox.getByNotificationId("notif-1")!;
      expect(record.state).toBe("queued");
      expect(record.attempts).toBe(0);
      expect(record.nextRetryAt! - now).toBe(expectedBackoff);

      now = record.nextRetryAt!;
    }
  });

  it("counting failure escalates backoff and terminates at attempts_exhausted after 10 attempts", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 403,
      body: { error: "Forbidden" },
    }) as unknown as SendNotificationFn;

    let now = 10_000;
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => now,
    });

    // 403 is a counting failure (not transport failure)
    // 10 attempts expected before terminal attempts_exhausted
    const expectedBackoffs = [5_000, 10_000, 30_000, 60_000, 120_000, 120_000, 120_000, 120_000, 120_000, 120_000];

    for (let i = 0; i <= 10; i++) {
      await sender.processOnce();
      const record = storage.outbox.getByNotificationId("notif-1")!;
      if (i < 10) {
        expect(record.state).toBe("queued");
        expect(record.attempts).toBe(i + 1);
        expect(record.nextRetryAt! - now).toBe(expectedBackoffs[i]);
        now = record.nextRetryAt!;
      } else {
        // Attempt 11 check: MAX_ATTEMPTS (10) reached, processOnce marks terminal before delivery
        expect(record.state).toBe("failed");
        expect(record.failedReason).toBe("attempts_exhausted");
        expect(record.attempts).toBe(10);
      }
    }
  });
});

describe("outbox terminal drop uniform logging", () => {
  let storage: StorageDb;

  beforeEach(() => {
    storage = openStorageDb(":memory:");
  });

  afterEach(() => {
    storage.db.close();
  });

  it("emits outbox terminal drop for attempts_exhausted", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);
    storage.db.prepare("UPDATE outbox SET attempts = 10 WHERE notification_id = 'notif-1'").run();

    const logFn = vi.fn();
    const sender = new OutboxSender({
      storage,
      sendNotification: makeSendNotification(),
      chatId: "chat-123",
      nowFn: () => 5_000,
      log: logFn,
    });

    await sender.processOnce();

    const dropCalls = logFn.mock.calls.filter(([msg]) => msg === "outbox terminal drop");
    expect(dropCalls).toHaveLength(1);
    expect(dropCalls[0]![1]).toEqual({
      notificationId: "notif-1",
      sessionId: "sess-1",
      kind: "question",
      reason: "attempts_exhausted",
      attempts: 10,
      ageMs: 4000,
    });

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record?.state).toBe("failed");
    expect(record?.failedReason).toBe("attempts_exhausted");
  });

  it("emits outbox terminal drop for expired", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const logFn = vi.fn();
    const sender = new OutboxSender({
      storage,
      sendNotification: makeSendNotification(),
      chatId: "chat-123",
      nowFn: () => 1_000 + 4 * 3600 * 1000 + 1,
      log: logFn,
    });

    await sender.processOnce();

    const dropCalls = logFn.mock.calls.filter(([msg]) => msg === "outbox terminal drop");
    expect(dropCalls).toHaveLength(1);
    expect(dropCalls[0]![1]).toEqual({
      notificationId: "notif-1",
      sessionId: "sess-1",
      kind: "question",
      reason: "expired",
      attempts: 0,
      ageMs: 14400001,
      expiryMs: 14400000,
    });

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record?.state).toBe("failed");
    expect(record?.failedReason).toBe("expired");
  });

  it("emits outbox terminal drop for payload_parse_failed", async () => {
    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      payload: "invalid-json{",
    }, 1_000);

    const logFn = vi.fn();
    const sender = new OutboxSender({
      storage,
      sendNotification: makeSendNotification(),
      chatId: "chat-123",
      nowFn: () => 5_000,
      log: logFn,
    });

    await sender.processOnce();

    const dropCalls = logFn.mock.calls.filter(([msg]) => msg === "outbox terminal drop");
    expect(dropCalls).toHaveLength(1);
    expect(dropCalls[0]![1]).toEqual({
      notificationId: "notif-1",
      sessionId: "sess-1",
      kind: "question",
      reason: "payload_parse_failed",
      attempts: 0,
      ageMs: 4000,
      lastError: expect.stringContaining("JSON"),
    });
  });

  it("emits outbox terminal drop for payload_empty (previously silent path)", async () => {
    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      payload: JSON.stringify({ messages: [] }),
    }, 1_000);

    const logFn = vi.fn();
    const sender = new OutboxSender({
      storage,
      sendNotification: makeSendNotification(),
      chatId: "chat-123",
      nowFn: () => 5_000,
      log: logFn,
    });

    await sender.processOnce();

    const dropCalls = logFn.mock.calls.filter(([msg]) => msg === "outbox terminal drop");
    expect(dropCalls).toHaveLength(1);
    expect(dropCalls[0]![1]).toEqual({
      notificationId: "notif-1",
      sessionId: "sess-1",
      kind: "question",
      reason: "payload_empty",
      attempts: 0,
      ageMs: 4000,
    });

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record?.state).toBe("failed");
    expect(record?.failedReason).toBe("payload_empty");
  });

  it("emits outbox terminal drop for delivery policy terminal action", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 400,
      body: { error: "bad request" },
    }) as unknown as SendNotificationFn;

    const logFn = vi.fn();
    const sender = new OutboxSender({
      storage,
      sendNotification,
      chatId: "chat-123",
      nowFn: () => 5_000,
      log: logFn,
    });

    await sender.processOnce();

    const dropCalls = logFn.mock.calls.filter(([msg]) => msg === "outbox terminal drop");
    expect(dropCalls).toHaveLength(1);
    expect(dropCalls[0]![1]).toEqual({
      notificationId: "notif-1",
      sessionId: "sess-1",
      kind: "question",
      reason: "Worker field validation failed (HTTP 400)",
      attempts: 0,
      ageMs: 4000,
      lastError: 'HTTP 400 - {"error":"bad request"}',
    });
  });

  it("emits outbox terminal drop for reregister_compensated", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);
    storage.sessions.upsert({
      sessionId: "sess-1",
      label: "my-session",
    });

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 404,
      body: { error: "Session not found" },
    }) as unknown as SendNotificationFn;

    const registerSession = vi.fn().mockImplementation(async () => {
      storage.db.prepare("DELETE FROM sessions WHERE session_id = 'sess-1'").run();
      return { ok: true };
    }) as unknown as RegisterSessionFn;

    const unregisterSession = vi.fn().mockResolvedValue({ ok: true }) as unknown as UnregisterSessionFn;

    const logFn = vi.fn();
    const sender = new OutboxSender({
      storage,
      sendNotification,
      registerSession,
      unregisterSession,
      chatId: "chat-123",
      nowFn: () => 5_000,
      log: logFn,
    });

    await sender.processOnce();

    const dropCalls = logFn.mock.calls.filter(([msg]) => msg === "outbox terminal drop");
    expect(dropCalls).toHaveLength(1);
    expect(dropCalls[0]![1]).toEqual({
      notificationId: "notif-1",
      sessionId: "sess-1",
      kind: "question",
      reason: "reregister_compensated",
      attempts: 0,
      ageMs: 4000,
      compensated: true,
    });
  });

  it("emits outbox terminal drop for reregister_failed", async () => {
    storage.outbox.upsert(BASE_OUTBOX_INPUT, 1_000);
    storage.sessions.upsert({
      sessionId: "sess-1",
      label: "my-session",
    });

    const sendNotification = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 404,
      body: { error: "Session not found" },
    }) as unknown as SendNotificationFn;

    const registerSession = vi.fn().mockResolvedValue({
      ok: false,
      kind: "http_error",
      status: 400,
      body: { error: "Bad registration request" },
    }) as unknown as RegisterSessionFn;

    const logFn = vi.fn();
    const sender = new OutboxSender({
      storage,
      sendNotification,
      registerSession,
      chatId: "chat-123",
      nowFn: () => 5_000,
      log: logFn,
    });

    await sender.processOnce();

    const dropCalls = logFn.mock.calls.filter(([msg]) => msg === "outbox terminal drop");
    expect(dropCalls).toHaveLength(1);
    expect(dropCalls[0]![1]).toEqual({
      notificationId: "notif-1",
      sessionId: "sess-1",
      kind: "question",
      reason: "reregister_failed",
      attempts: 0,
      ageMs: 4000,
      lastError: 'HTTP 400 - {"error":"Bad registration request"}',
    });
  });
});
