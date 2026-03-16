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

    // Second upsert should not reset sending state
    storage.outbox.upsert(BASE_INPUT, 2_000);

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("sending");

    storage.db.close();
  });

  it("upserts idempotently when state is sent", () => {
    const storage = createStorage();

    storage.outbox.upsert(BASE_INPUT, 1_000);
    storage.outbox.markSent("notif-1", 2_000);

    // Second upsert should not reset sent state
    storage.outbox.upsert(BASE_INPUT, 3_000);

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("sent");

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

  it("marks terminal failure", () => {
    const storage = createStorage();

    storage.outbox.upsert(BASE_INPUT, 1_000);
    storage.outbox.markFailed("notif-1", 2_000);

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("failed");
    expect(record!.nextRetryAt).toBeNull();
    expect(record!.updatedAt).toBe(2_000);

    // Failed entries are not returned by getReady
    const ready = storage.outbox.getReady(2_000, 10);
    expect(ready).toHaveLength(0);

    storage.db.close();
  });

  it("resets failed entries to queued on re-upsert", () => {
    const storage = createStorage();

    storage.outbox.upsert(BASE_INPUT, 1_000);
    storage.outbox.markFailed("notif-1", 2_000);

    // Re-upsert of a failed notification should reset to queued
    storage.outbox.upsert(BASE_INPUT, 3_000);

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record!.state).toBe("queued");
    expect(record!.attempts).toBe(0);
    expect(record!.nextRetryAt).toBeNull();
    expect(record!.updatedAt).toBe(3_000);

    // Should now be ready
    const ready = storage.outbox.getReady(3_000, 10);
    expect(ready).toHaveLength(1);

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
});
