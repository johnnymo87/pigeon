import { describe, expect, it } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";

function createStorage(): StorageDb {
  return openStorageDb(":memory:");
}

describe("AlertRepository", () => {
  it("enqueue inserts a queued row with attempts=0 and next_attempt_at = now", () => {
    const storage = createStorage();
    const now = 10_000;

    const inserted = storage.alerts.enqueue({
      id: "alert-1",
      source: "test-source",
      refMsgId: "msg-1",
      text: "Something happened",
      severity: "warning",
      now,
    });

    expect(inserted).toBe(true);

    const record = storage.alerts.getById("alert-1");
    expect(record).toBeDefined();
    expect(record!.id).toBe("alert-1");
    expect(record!.source).toBe("test-source");
    expect(record!.refMsgId).toBe("msg-1");
    expect(record!.text).toBe("Something happened");
    expect(record!.severity).toBe("warning");
    expect(record!.state).toBe("queued");
    expect(record!.attempts).toBe(0);
    expect(record!.nextAttemptAt).toBe(now);
    expect(record!.createdAt).toBe(now);
    expect(record!.sentAt).toBeNull();

    storage.db.close();
  });

  it("dedupes on refMsgId and second enqueue returns false", () => {
    const storage = createStorage();
    const now = 10_000;

    const first = storage.alerts.enqueue({
      id: "alert-1",
      source: "service-a",
      refMsgId: "msg-123",
      text: "First alert",
      severity: "info",
      now,
    });
    const second = storage.alerts.enqueue({
      id: "alert-2",
      source: "service-a",
      refMsgId: "msg-123",
      text: "Duplicate alert",
      severity: "error",
      now: now + 1000,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);

    expect(storage.alerts.getById("alert-1")).toBeDefined();
    expect(storage.alerts.getById("alert-2")).toBeUndefined();

    storage.db.close();
  });

  it("dedupes across different source labels when refMsgId is identical", () => {
    const storage = createStorage();
    const now = 10_000;

    const first = storage.alerts.enqueue({
      id: "alert-1",
      source: "wake-expired",
      refMsgId: "msg-123",
      text: "First alert from sweepExpired",
      severity: "error",
      now,
    });
    const second = storage.alerts.enqueue({
      id: "alert-2",
      source: "wake-permanent",
      refMsgId: "msg-123",
      text: "Second alert from permanent failure",
      severity: "error",
      now: now + 1000,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);

    const alerts = storage.db.prepare("SELECT * FROM operational_alerts").all();
    expect(alerts).toHaveLength(1);
    expect(storage.alerts.getById("alert-1")).toBeDefined();
    expect(storage.alerts.getById("alert-2")).toBeUndefined();

    storage.db.close();
  });

  it("dedupe is bounded by row lifetime: cleaning a sent alert frees its refMsgId slot", () => {
    // The schema comment used to claim this index enforces "one alert per
    // swarm row, EVER". It does not, and nothing in the code ever did: the
    // hourly maintenance sweep DELETES sent alerts older than
    // ALERT_SENT_RETENTION_MS (1h), and deleting the row frees the unique
    // slot. Dedupe therefore lasts as long as the ALERT ROW exists, not
    // forever. Pinned here because a comment asserting a property the code
    // does not enforce is precisely the defect class this project keeps
    // finding, and because pigeon-fww's namespacing decision was reasoned
    // about partly in terms of how long a slot stays occupied.
    const storage = createStorage();
    const now = 10_000;

    expect(
      storage.alerts.enqueue({ id: "a1", source: "s", refMsgId: "msg-1", text: "first", severity: "error", now }),
    ).toBe(true);
    expect(
      storage.alerts.enqueue({ id: "a2", source: "s", refMsgId: "msg-1", text: "second", severity: "error", now }),
    ).toBe(false);

    // Send it, then let the retention sweep collect it.
    storage.alerts.markSent("a1", now);
    const cleaned = storage.alerts.cleanupOlderThan(now + 1, now + 1);
    expect(cleaned).toBe(1);

    // Same refMsgId is now insertable again.
    expect(
      storage.alerts.enqueue({ id: "a3", source: "s", refMsgId: "msg-1", text: "third", severity: "error", now: now + 2 }),
    ).toBe(true);

    storage.db.close();
  });

  it("a QUEUED alert still holds its slot against the retention sweep", () => {
    // The complement of the test above, and the property that actually makes
    // the durable channel safe: an alert that has NOT been sent yet is never
    // deleted by cleanup (only abandonOlderThan may retire it, as a recorded
    // state change), so its dedupe slot cannot be freed out from under a
    // pending send.
    const storage = createStorage();
    const now = 10_000;

    storage.alerts.enqueue({ id: "q1", source: "s", refMsgId: "msg-q", text: "queued", severity: "error", now });
    expect(storage.alerts.cleanupOlderThan(now + 1_000_000, now + 1_000_000)).toBe(0);
    expect(storage.alerts.getById("q1")).toBeDefined();
    expect(
      storage.alerts.enqueue({ id: "q2", source: "s", refMsgId: "msg-q", text: "dup", severity: "error", now }),
    ).toBe(false);

    storage.db.close();
  });

  it("does NOT dedupe when refMsgId is null", () => {
    const storage = createStorage();
    const now = 10_000;

    const first = storage.alerts.enqueue({
      id: "alert-1",
      source: "service-a",
      refMsgId: null,
      text: "Alert without refMsgId 1",
      severity: "info",
      now,
    });
    const second = storage.alerts.enqueue({
      id: "alert-2",
      source: "service-a",
      refMsgId: null,
      text: "Alert without refMsgId 2",
      severity: "info",
      now: now + 100,
    });

    expect(first).toBe(true);
    expect(second).toBe(true);

    expect(storage.alerts.getById("alert-1")).toBeDefined();
    expect(storage.alerts.getById("alert-2")).toBeDefined();

    storage.db.close();
  });

  it("nextDrainable returns nothing when next_attempt_at > now, and returns row once now reaches it", () => {
    const storage = createStorage();
    const now = 10_000;

    storage.alerts.enqueue({
      id: "alert-1",
      source: "service-a",
      text: "Alert text",
      severity: "error",
      now,
    });

    // Before time reached
    expect(storage.alerts.nextDrainable(now - 1)).toBeUndefined();
    expect(storage.alerts.countDrainable(now - 1)).toBe(0);

    // Exactly at time reached
    const drainable = storage.alerts.nextDrainable(now);
    expect(drainable).toBeDefined();
    expect(drainable!.id).toBe("alert-1");
    expect(storage.alerts.countDrainable(now)).toBe(1);

    storage.db.close();
  });

  it("nextDrainable returns oldest created_at first when several are due", () => {
    const storage = createStorage();

    storage.alerts.enqueue({
      id: "alert-b",
      source: "src-b",
      text: "Alert B",
      severity: "info",
      now: 20_000,
    });
    storage.alerts.enqueue({
      id: "alert-a",
      source: "src-a",
      text: "Alert A",
      severity: "info",
      now: 10_000,
    });
    storage.alerts.enqueue({
      id: "alert-c",
      source: "src-c",
      text: "Alert C",
      severity: "info",
      now: 30_000,
    });

    expect(storage.alerts.countDrainable(50_000)).toBe(3);

    const first = storage.alerts.nextDrainable(50_000);
    expect(first).toBeDefined();
    expect(first!.id).toBe("alert-a");

    storage.db.close();
  });

  it("markSent transitions queued->sent and returns true; second markSent returns false", () => {
    const storage = createStorage();
    const now = 10_000;

    storage.alerts.enqueue({
      id: "alert-1",
      source: "src-a",
      text: "Test alert",
      severity: "info",
      now,
    });

    const firstMark = storage.alerts.markSent("alert-1", now + 500);
    expect(firstMark).toBe(true);

    const record = storage.alerts.getById("alert-1")!;
    expect(record.state).toBe("sent");
    expect(record.sentAt).toBe(now + 500);

    const secondMark = storage.alerts.markSent("alert-1", now + 1000);
    expect(secondMark).toBe(false);

    storage.db.close();
  });

  it("markRetry increments attempts and pushes next_attempt_at", () => {
    const storage = createStorage();
    const now = 10_000;

    storage.alerts.enqueue({
      id: "alert-1",
      source: "src-a",
      text: "Test alert",
      severity: "warning",
      now,
    });

    const retrySuccess = storage.alerts.markRetry("alert-1", now + 5_000);
    expect(retrySuccess).toBe(true);

    const record = storage.alerts.getById("alert-1")!;
    expect(record.attempts).toBe(1);
    expect(record.nextAttemptAt).toBe(now + 5_000);
    expect(record.state).toBe("queued");

    // Not drainable at now + 4000
    expect(storage.alerts.nextDrainable(now + 4_000)).toBeUndefined();
    // Drainable at now + 5000
    expect(storage.alerts.nextDrainable(now + 5_000)).toBeDefined();

    storage.db.close();
  });

  it("markSent and markRetry return false for an abandoned row", () => {
    const storage = createStorage();
    const now = 10_000;

    storage.alerts.enqueue({
      id: "alert-1",
      source: "src-a",
      text: "Test alert",
      severity: "error",
      now,
    });

    storage.alerts.abandonOlderThan(now + 100, now + 200);
    expect(storage.alerts.getById("alert-1")!.state).toBe("abandoned");

    expect(storage.alerts.markSent("alert-1", now + 300)).toBe(false);
    expect(storage.alerts.markRetry("alert-1", now + 400)).toBe(false);

    storage.db.close();
  });

  it("abandonOlderThan only touches queued rows older than cutoff and leaves sent rows alone", () => {
    const storage = createStorage();
    const now = 10_000;

    // Queued, old (created_at = 1000)
    storage.alerts.enqueue({
      id: "alert-old-queued",
      source: "src-1",
      text: "Old queued alert",
      severity: "info",
      now: 1_000,
    });

    // Queued, new (created_at = 8000)
    storage.alerts.enqueue({
      id: "alert-new-queued",
      source: "src-2",
      text: "New queued alert",
      severity: "info",
      now: 8_000,
    });

    // Sent, old (created_at = 1000)
    storage.alerts.enqueue({
      id: "alert-old-sent",
      source: "src-3",
      text: "Old sent alert",
      severity: "info",
      now: 1_000,
    });
    storage.alerts.markSent("alert-old-sent", 2_000);

    const cutoff = 5_000;
    const abandonedCount = storage.alerts.abandonOlderThan(cutoff, now);
    expect(abandonedCount).toBe(1);

    expect(storage.alerts.getById("alert-old-queued")!.state).toBe("abandoned");
    expect(storage.alerts.getById("alert-new-queued")!.state).toBe("queued");
    expect(storage.alerts.getById("alert-old-sent")!.state).toBe("sent");

    storage.db.close();
  });

  it("cleanupOlderThan deletes old sent and old abandoned rows but never queued rows", () => {
    const storage = createStorage();
    const now = 100_000;

    // Queued row created at 20,000 (after abandon cutoff of 15,000, so it remains queued)
    storage.alerts.enqueue({
      id: "alert-queued-old",
      source: "src-1",
      text: "Old queued",
      severity: "info",
      now: 20_000,
    });

    // Sent row, sent_at = 20,000
    storage.alerts.enqueue({
      id: "alert-sent-old",
      source: "src-2",
      text: "Old sent",
      severity: "info",
      now: 10_000,
    });
    storage.alerts.markSent("alert-sent-old", 20_000);

    // Abandoned row, created_at = 10,000
    storage.alerts.enqueue({
      id: "alert-abandoned-old",
      source: "src-3",
      text: "Old abandoned",
      severity: "info",
      now: 10_000,
    });
    storage.alerts.abandonOlderThan(15_000, now);

    // Fresh sent row, sent_at = 90,000
    storage.alerts.enqueue({
      id: "alert-sent-fresh",
      source: "src-4",
      text: "Fresh sent",
      severity: "info",
      now: 80_000,
    });
    storage.alerts.markSent("alert-sent-fresh", 90_000);

    const sentCutoff = 50_000;
    const abandonedCutoff = 50_000;

    const cleaned = storage.alerts.cleanupOlderThan(sentCutoff, abandonedCutoff);
    expect(cleaned).toBe(2); // alert-sent-old and alert-abandoned-old

    expect(storage.alerts.getById("alert-sent-old")).toBeUndefined();
    expect(storage.alerts.getById("alert-abandoned-old")).toBeUndefined();

    // Queued row survives regardless of cutoff
    expect(storage.alerts.getById("alert-queued-old")).toBeDefined();
    expect(storage.alerts.getById("alert-queued-old")!.state).toBe("queued");

    // Fresh sent row survives
    expect(storage.alerts.getById("alert-sent-fresh")).toBeDefined();

    storage.db.close();
  });

  it("enqueue inside transaction rolls back atomically if transaction throws", () => {
    const storage = createStorage();

    expect(() => {
      storage.db.transaction(() => {
        storage.alerts.enqueue({
          id: "alert-tx",
          source: "src-tx",
          text: "Transactional alert",
          severity: "error",
          now: 10_000,
        });
        throw new Error("Deliberate failure inside transaction");
      })();
    }).toThrow("Deliberate failure inside transaction");

    expect(storage.alerts.getById("alert-tx")).toBeUndefined();

    storage.db.close();
  });
});
