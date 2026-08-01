import { afterEach, describe, expect, it } from "vitest";
import { openStorageDb } from "../src/storage/database";
import type { StorageDb } from "../src/storage/database";

function createStorage(): StorageDb {
  return openStorageDb(":memory:");
}

const BASE_INPUT = {
  notificationId: "notif-1",
  sessionId: "sess-1",
  requestId: "req-1",
  kind: "question",
  payload: '{"text":"Which option?"}',
  token: "tok-abc",
};

describe("OutboxRepository", () => {
  afterEach(() => {
    // in-memory databases are dropped when closed.
  });

  it("stores and retrieves an outbox entry", () => {
    const storage = createStorage();

    storage.outbox.upsert(BASE_INPUT, 1_000);

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record).not.toBeNull();
    expect(record!.notificationId).toBe("notif-1");
    expect(record!.sessionId).toBe("sess-1");
    expect(record!.requestId).toBe("req-1");
    expect(record!.kind).toBe("question");
    expect(record!.state).toBe("queued");
    expect(record!.payload).toBe('{"text":"Which option?"}');
    expect(record!.token).toBe("tok-abc");
    expect(record!.attempts).toBe(0);
    expect(record!.retryCount).toBe(0);
    expect(record!.nextRetryAt).toBeNull();
    expect(record!.createdAt).toBe(1_000);
    expect(record!.updatedAt).toBe(1_000);

    storage.db.close();
  });

  it("upserts idempotently on same notificationId when already queued", () => {
    const storage = createStorage();

    storage.outbox.upsert(BASE_INPUT, 1_000);
    // Second upsert with same notificationId should be a no-op (still queued)
    storage.outbox.upsert({ ...BASE_INPUT, token: "tok-different" }, 2_000);

    const record = storage.outbox.getByNotificationId("notif-1");
    // Should still have original token and timestamps
    expect(record!.token).toBe("tok-abc");
    expect(record!.createdAt).toBe(1_000);
    expect(record!.state).toBe("queued");

    storage.db.close();
  });

  it("upserts idempotently when state is sending", () => {
    const storage = createStorage();

    storage.outbox.upsert(BASE_INPUT, 1_000);
    // Simulate sending state
    storage.db.prepare("UPDATE outbox SET state = 'sending' WHERE notification_id = ?").run("notif-1");

    // Second upsert should not reset sending state or update created_at
    storage.outbox.upsert(BASE_INPUT, 2_000);

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("sending");
    expect(record!.createdAt).toBe(1_000);

    storage.db.close();
  });

  it("upserts idempotently when state is sent", () => {
    const storage = createStorage();

    storage.outbox.upsert(BASE_INPUT, 1_000);
    storage.outbox.markSent("notif-1", 2_000);

    // Second upsert should not reset sent state or update created_at
    storage.outbox.upsert(BASE_INPUT, 3_000);

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("sent");
    expect(record!.createdAt).toBe(1_000);

    storage.db.close();
  });

  it("marks sent on success", () => {
    const storage = createStorage();

    storage.outbox.upsert(BASE_INPUT, 1_000);
    storage.outbox.markSent("notif-1", 2_000);

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("sent");
    expect(record!.nextRetryAt).toBeNull();
    expect(record!.updatedAt).toBe(2_000);

    storage.db.close();
  });

  it("schedules retry with backoff and is not ready before next_retry_at", () => {
    const storage = createStorage();
    const now = 10_000;
    const backoffMs = 5_000;

    storage.outbox.upsert(BASE_INPUT, now);
    storage.outbox.markRetry("notif-1", now, backoffMs);

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("queued");
    expect(record!.attempts).toBe(1);
    expect(record!.nextRetryAt).toBe(now + backoffMs); // 15_000

    // Not ready yet (current time is before next_retry_at)
    const notReady = storage.outbox.getReady(14_999, 10);
    expect(notReady).toHaveLength(0);

    // Ready at exactly next_retry_at
    const ready = storage.outbox.getReady(15_000, 10);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.notificationId).toBe("notif-1");

    storage.db.close();
  });

  it("is ready immediately when no backoff has been set yet", () => {
    const storage = createStorage();

    storage.outbox.upsert(BASE_INPUT, 1_000);

    const ready = storage.outbox.getReady(1_000, 10);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.notificationId).toBe("notif-1");

    storage.db.close();
  });

  it("marks terminal failure with reason and last_error", () => {
    const storage = createStorage();

    storage.outbox.upsert(BASE_INPUT, 1_000);
    storage.outbox.markFailed("notif-1", 2_000, "budget_exhausted", "Max attempts reached");

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("failed");
    expect(record!.nextRetryAt).toBeNull();
    expect(record!.updatedAt).toBe(2_000);
    expect(record!.failedReason).toBe("budget_exhausted");
    expect(record!.lastError).toBe("Max attempts reached");

    // Failed entries are not returned by getReady
    const ready = storage.outbox.getReady(2_000, 10);
    expect(ready).toHaveLength(0);

    storage.db.close();
  });

  it("markRetry records last_error and preserves it on subsequent markRetry if omitted", () => {
    const storage = createStorage();
    const now = 10_000;

    storage.outbox.upsert(BASE_INPUT, now);
    storage.outbox.markRetry("notif-1", now, 5_000, "HTTP 500 Server Error");

    let record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.attempts).toBe(1);
    expect(record!.lastError).toBe("HTTP 500 Server Error");

    // Second retry without passing lastError preserves previous lastError
    storage.outbox.markRetry("notif-1", now + 5_000, 10_000);
    record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.attempts).toBe(2);
    expect(record!.lastError).toBe("HTTP 500 Server Error");

    storage.db.close();
  });

  it("markRetry with countAttempt = false updates retry time without incrementing attempts", () => {
    const storage = createStorage();
    const now = 10_000;
    const backoffMs = 5_000;

    storage.outbox.upsert(BASE_INPUT, now);
    storage.outbox.markRetry("notif-1", now, backoffMs, "transport_error", false);

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("queued");
    expect(record!.attempts).toBe(0);
    expect(record!.nextRetryAt).toBe(now + backoffMs);
    expect(record!.lastError).toBe("transport_error");

    storage.db.close();
  });

  it("resets failed entries (including failedReason and lastError) to queued on re-upsert and updates created_at", () => {
    const storage = createStorage();

    const initialTime = 1_000;
    const failTime = 2_000;
    const resurrectTime = 1_000 + 20 * 60 * 1000; // 20 minutes later (past 15m expiration)

    storage.outbox.upsert(BASE_INPUT, initialTime);
    storage.outbox.markRetry("notif-1", initialTime, 5_000, "HTTP 500", false);
    storage.outbox.markFailed("notif-1", failTime, "budget_exhausted", "HTTP 500");

    // Re-upsert of a failed notification should reset to queued, retry_count=0, and update created_at
    storage.outbox.upsert(BASE_INPUT, resurrectTime);

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("queued");
    expect(record!.attempts).toBe(0);
    expect(record!.retryCount).toBe(0);
    expect(record!.nextRetryAt).toBeNull();
    expect(record!.failedReason).toBeNull();
    expect(record!.lastError).toBeNull();
    expect(record!.createdAt).toBe(resurrectTime);
    expect(record!.updatedAt).toBe(resurrectTime);

    // Should now be ready at resurrectTime
    const ready = storage.outbox.getReady(resurrectTime, 10);
    expect(ready).toHaveLength(1);

    storage.db.close();
  });

  it("resurrected entry sorts to back of ready list based on refreshed created_at", () => {
    const storage = createStorage();

    // Entry 1 created at t=1000
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "notif-1" }, 1_000);
    // Entry 2 created at t=2000
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "notif-2" }, 2_000);

    // Entry 1 fails at t=3000
    storage.outbox.markFailed("notif-1", 3_000, "budget_exhausted");

    // Entry 1 is resurrected at t=4000
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "notif-1" }, 4_000);

    // ready order should now be notif-2 (created at 2000), then notif-1 (created at 4000)
    const ready = storage.outbox.getReady(5_000, 10);
    expect(ready.map((r) => r.notificationId)).toEqual(["notif-2", "notif-1"]);

    storage.db.close();
  });

  it("cleans up old terminal entries with split retention (sent=1h, failed=7d)", () => {
    const storage = createStorage();
    const now = 10_000_000;
    const ONE_HOUR = 60 * 60 * 1000;
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

    // sent 2 hours ago (> 1 hour)
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "sent-old" }, now - 2 * ONE_HOUR);
    storage.outbox.markSent("sent-old", now - 2 * ONE_HOUR);

    // sent 30 mins ago (< 1 hour)
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "sent-fresh" }, now - 30 * 60 * 1000);
    storage.outbox.markSent("sent-fresh", now - 30 * 60 * 1000);

    // failed 2 hours ago (> 1 hour, < 7 days) -> SHOULD SURVIVE
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "failed-2h" }, now - 2 * ONE_HOUR);
    storage.outbox.markFailed("failed-2h", now - 2 * ONE_HOUR, "budget_exhausted");

    // failed 8 days ago (> 7 days) -> SHOULD BE DELETED
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "failed-8d" }, now - 8 * 24 * ONE_HOUR);
    storage.outbox.markFailed("failed-8d", now - 8 * 24 * ONE_HOUR, "budget_exhausted");

    const sentCutoff = now - ONE_HOUR;
    const failedCutoff = now - SEVEN_DAYS;

    const deleted = storage.outbox.cleanupOlderThan(sentCutoff, failedCutoff);
    expect(deleted).toBe(2); // sent-old and failed-8d

    expect(storage.outbox.getByNotificationId("sent-old")).toBeNull();
    expect(storage.outbox.getByNotificationId("failed-8d")).toBeNull();

    expect(storage.outbox.getByNotificationId("sent-fresh")).not.toBeNull();
    expect(storage.outbox.getByNotificationId("failed-2h")).not.toBeNull();

    storage.db.close();
  });

  it("cleans up old terminal entries", () => {
    const storage = createStorage();
    const now = 100_000;

    // Add entries in various states
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "notif-sent" }, now - 10_000);
    storage.outbox.markSent("notif-sent", now - 5_000);

    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "notif-failed" }, now - 10_000);
    storage.outbox.markFailed("notif-failed", now - 5_000);

    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "notif-queued" }, now - 10_000);

    // Cleanup older than now - 3_000 (so entries updated at now - 5_000 are cleaned)
    const deleted = storage.outbox.cleanupOlderThan(now - 3_000);
    expect(deleted).toBe(2); // notif-sent and notif-failed

    // Queued entry should still be there
    expect(storage.outbox.getByNotificationId("notif-queued")).not.toBeNull();
    expect(storage.outbox.getByNotificationId("notif-sent")).toBeNull();
    expect(storage.outbox.getByNotificationId("notif-failed")).toBeNull();

    storage.db.close();
  });

  it("getReady respects limit", () => {
    const storage = createStorage();
    const now = 1_000;

    for (let i = 0; i < 5; i++) {
      storage.outbox.upsert({ ...BASE_INPUT, notificationId: `notif-${i}` }, now + i);
    }

    const ready = storage.outbox.getReady(now + 10, 3);
    expect(ready).toHaveLength(3);

    storage.db.close();
  });

  it("getReady returns entries ordered by created_at", () => {
    const storage = createStorage();

    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "notif-b" }, 2_000);
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "notif-a" }, 1_000);
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "notif-c" }, 3_000);

    const ready = storage.outbox.getReady(5_000, 10);
    expect(ready.map((r) => r.notificationId)).toEqual(["notif-a", "notif-b", "notif-c"]);

    storage.db.close();
  });

  it("getReady orders by message-class priority FIRST (question before stop before card)", () => {
    const storage = createStorage();

    // Insert a card at t=1000 (oldest)
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "card-old", kind: "card" }, 1_000);
    // Insert a stop at t=1500
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "stop-mid", kind: "stop" }, 1_500);
    // Insert a question at t=2000 (newest question)
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "q-new", kind: "question" }, 2_000);
    // Insert a card at t=2500
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "card-new", kind: "card" }, 2_500);

    const ready = storage.outbox.getReady(5_000, 10);
    expect(ready.map((r) => r.notificationId)).toEqual([
      "q-new",      // question first despite being newer than card-old/stop-mid
      "stop-mid",   // stop second
      "card-old",   // card third, ordered by created_at
      "card-new",
    ]);

    storage.db.close();
  });

  it("getReady uses rowid tiebreaker when created_at is identical", () => {
    const storage = createStorage();

    // Three cards enqueued at identical created_at timestamp
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "card-1", kind: "card" }, 1_000);
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "card-2", kind: "card" }, 1_000);
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "card-3", kind: "card" }, 1_000);

    const ready = storage.outbox.getReady(5_000, 10);
    expect(ready.map((r) => r.notificationId)).toEqual(["card-1", "card-2", "card-3"]);

    storage.db.close();
  });

  it("updatePayload updates payload and updated_at without touching state, attempts, or next_retry_at", () => {
    const storage = createStorage();

    storage.outbox.upsert(BASE_INPUT, 1_000);
    storage.outbox.markRetry("notif-1", 1_000, 5_000);

    const before = storage.outbox.getByNotificationId("notif-1")!;
    expect(before.payload).toBe('{"text":"Which option?"}');
    expect(before.attempts).toBe(1);
    expect(before.nextRetryAt).toBe(6_000);
    expect(before.state).toBe("queued");

    const newPayload = '{"text":"Which option? (stripped)"}';
    storage.outbox.updatePayload("notif-1", newPayload, 2_000);

    const after = storage.outbox.getByNotificationId("notif-1")!;
    expect(after.payload).toBe(newPayload);
    expect(after.updatedAt).toBe(2_000);
    expect(after.attempts).toBe(1);
    expect(after.nextRetryAt).toBe(6_000);
    expect(after.state).toBe("queued");

    storage.db.close();
  });

  it("getStats returns aggregate counts by state, failed_reason breakdown, and oldestQueuedAgeMs", () => {
    const storage = createStorage();
    const now = 10_000;

    // Initially empty
    expect(storage.outbox.getStats(now)).toEqual({
      states: { queued: 0, sending: 0, sent: 0, failed: 0 },
      failedReasons: {},
      oldestQueuedAgeMs: null,
    });

    // Enqueue entries
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "notif-1" }, 2_000);
    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "notif-2" }, 4_000);

    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "notif-3" }, 3_000);
    storage.outbox.markSent("notif-3", 3_500);

    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "notif-4" }, 5_000);
    storage.outbox.markFailed("notif-4", 5_500, "expired");

    storage.outbox.upsert({ ...BASE_INPUT, notificationId: "notif-5" }, 6_000);
    storage.outbox.markFailed("notif-5", 6_500, "attempts_exhausted");

    const stats = storage.outbox.getStats(now);
    expect(stats).toEqual({
      states: {
        queued: 2,
        sending: 0,
        sent: 1,
        failed: 2,
      },
      failedReasons: {
        expired: 1,
        attempts_exhausted: 1,
      },
      oldestQueuedAgeMs: 8_000,
    });

    storage.db.close();
  });
});
