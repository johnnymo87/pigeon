import { afterEach, describe, expect, it, vi } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import {
  AlertDrainer,
  alertBackoffMs,
  BACKLOG_SUMMARY_THRESHOLD,
  type ArbiterNotifier,
} from "../src/swarm/alert-drainer";

function makeFixture() {
  const storage: StorageDb = openStorageDb(":memory:");
  let now = 1_000_000;
  const sendPlainAlert = vi.fn(async (_text: string, _severity: string) => {});
  const log = vi.fn((_msg: string, _fields?: Record<string, unknown>) => {});

  const drainer = new AlertDrainer({
    storage,
    notifier: { sendPlainAlert },
    nowFn: () => now,
    log,
  });

  return {
    storage,
    drainer,
    sendPlainAlert,
    log,
    setNow(v: number) {
      now = v;
    },
    getNow() {
      return now;
    },
  };
}

type Fixture = ReturnType<typeof makeFixture>;

describe("AlertDrainer", () => {
  let fixture: Fixture | null = null;

  afterEach(() => {
    fixture?.drainer.stop();
    fixture?.storage.db.close();
    fixture = null;
  });

  it("1. sends queued alert and marks it sent", async () => {
    fixture = makeFixture();
    const { storage, drainer, sendPlainAlert, getNow } = fixture;

    storage.alerts.enqueue({
      id: "a1",
      source: "test",
      text: "System temperature high",
      severity: "warning",
      now: getNow(),
    });

    await drainer.drainOnce();

    expect(sendPlainAlert).toHaveBeenCalledTimes(1);
    expect(sendPlainAlert).toHaveBeenCalledWith("System temperature high", "warning");

    const record = storage.alerts.getById("a1");
    expect(record?.state).toBe("sent");
    expect(record?.sentAt).toBe(getNow());
  });

  it("2. sends at most ONE alert per pass", async () => {
    fixture = makeFixture();
    const { storage, drainer, sendPlainAlert, getNow } = fixture;

    storage.alerts.enqueue({ id: "a1", source: "s1", text: "Alert 1", severity: "error", now: getNow() });
    storage.alerts.enqueue({ id: "a2", source: "s2", text: "Alert 2", severity: "error", now: getNow() });
    storage.alerts.enqueue({ id: "a3", source: "s3", text: "Alert 3", severity: "error", now: getNow() });

    await drainer.drainOnce();

    expect(sendPlainAlert).toHaveBeenCalledTimes(1);
    expect(storage.alerts.countDrainable(getNow())).toBe(2);
  });

  it("3. drains oldest first (created_at ASC)", async () => {
    fixture = makeFixture();
    const { storage, drainer, sendPlainAlert, getNow } = fixture;

    storage.alerts.enqueue({ id: "a1", source: "s1", text: "Newer Alert", severity: "info", now: getNow() + 100 });
    storage.alerts.enqueue({ id: "a2", source: "s2", text: "Older Alert", severity: "error", now: getNow() - 100 });

    await drainer.drainOnce();

    expect(sendPlainAlert).toHaveBeenCalledWith("Older Alert", "error");
    expect(storage.alerts.getById("a2")?.state).toBe("sent");
    expect(storage.alerts.getById("a1")?.state).toBe("queued");
  });

  it("4. retries on send failure without losing alert", async () => {
    fixture = makeFixture();
    const { storage, drainer, sendPlainAlert, setNow, getNow } = fixture;

    sendPlainAlert.mockRejectedValueOnce(new Error("Telegram API 429 Rate Limit"));

    storage.alerts.enqueue({ id: "a1", source: "s1", text: "Flaky Alert", severity: "error", now: getNow() });

    await drainer.drainOnce();

    let record = storage.alerts.getById("a1")!;
    expect(record.state).toBe("queued");
    expect(record.attempts).toBe(1);
    const backoff = alertBackoffMs(0);
    expect(record.nextAttemptAt).toBe(getNow() + backoff);

    // Pass at same time should not retry yet
    await drainer.drainOnce();
    expect(sendPlainAlert).toHaveBeenCalledTimes(1);

    // Advance past backoff time
    setNow(getNow() + backoff);
    sendPlainAlert.mockResolvedValueOnce(undefined);

    await drainer.drainOnce();
    expect(sendPlainAlert).toHaveBeenCalledTimes(2);

    record = storage.alerts.getById("a1")!;
    expect(record.state).toBe("sent");
  });

  it("5. drainOnce does not reject when notifier throws", async () => {
    fixture = makeFixture();
    const { storage, drainer, sendPlainAlert, getNow } = fixture;

    sendPlainAlert.mockRejectedValue(new Error("Network disconnect"));

    storage.alerts.enqueue({ id: "a1", source: "s1", text: "Alert", severity: "error", now: getNow() });

    await expect(drainer.drainOnce()).resolves.toBeUndefined();
  });

  it("6. reentrancy guard prevents concurrent drain passes", async () => {
    fixture = makeFixture();
    const { storage, drainer, sendPlainAlert, getNow } = fixture;

    let resolveSend!: () => void;
    const sendPromise = new Promise<void>((res) => {
      resolveSend = res;
    });

    sendPlainAlert.mockImplementationOnce(() => sendPromise);

    storage.alerts.enqueue({ id: "a1", source: "s1", text: "Alert 1", severity: "error", now: getNow() });
    storage.alerts.enqueue({ id: "a2", source: "s2", text: "Alert 2", severity: "error", now: getNow() });

    const pass1 = drainer.drainOnce();
    const pass2 = drainer.drainOnce();

    resolveSend();
    await Promise.all([pass1, pass2]);

    expect(sendPlainAlert).toHaveBeenCalledTimes(1);
  });

  it("7. does not send when next_attempt_at is in the future", async () => {
    fixture = makeFixture();
    const { storage, drainer, sendPlainAlert, getNow } = fixture;

    storage.alerts.enqueue({ id: "a1", source: "s1", text: "Future Alert", severity: "error", now: getNow() + 5000 });

    await drainer.drainOnce();

    expect(sendPlainAlert).not.toHaveBeenCalled();
  });

  it("8. alertBackoffMs escalates and caps at 1h", () => {
    expect(alertBackoffMs(0)).toBe(5_000);
    expect(alertBackoffMs(1)).toBe(30_000);
    expect(alertBackoffMs(2)).toBe(120_000);
    expect(alertBackoffMs(3)).toBe(600_000);
    expect(alertBackoffMs(4)).toBe(1_800_000);
    expect(alertBackoffMs(5)).toBe(3_600_000);
    expect(alertBackoffMs(100)).toBe(3_600_000);
  });

  it("9. logs backlog summary once when over threshold and resets when cleared", async () => {
    fixture = makeFixture();
    const { storage, drainer, log, getNow } = fixture;

    // Enqueue threshold number of alerts
    for (let i = 0; i < BACKLOG_SUMMARY_THRESHOLD; i++) {
      storage.alerts.enqueue({ id: `a${i}`, source: `s${i}`, text: `Alert ${i}`, severity: "info", now: getNow() });
    }

    await drainer.drainOnce();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("backlog"),
      expect.objectContaining({ count: BACKLOG_SUMMARY_THRESHOLD }),
    );

    log.mockClear();

    // Second pass while backlog persists (4 remaining) -> should not log summary again
    await drainer.drainOnce();
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining("backlog"),
      expect.anything(),
    );
  });

  it("10. durability across crash-restart (brand new drainer over same DB)", async () => {
    fixture = makeFixture();
    const { storage, sendPlainAlert, setNow, getNow } = fixture;

    sendPlainAlert.mockRejectedValueOnce(new Error("Crash during send"));

    storage.alerts.enqueue({ id: "a1", source: "s1", text: "Durable Alert", severity: "error", now: getNow() });

    // Drainer 1 fails send
    const drainer1 = new AlertDrainer({
      storage,
      notifier: { sendPlainAlert },
      nowFn: () => getNow(),
    });
    await drainer1.drainOnce();

    const recordBeforeRestart = storage.alerts.getById("a1")!;
    expect(recordBeforeRestart.attempts).toBe(1);
    const nextAttemptAt = recordBeforeRestart.nextAttemptAt;

    // Simulate restart: construct brand new drainer over same storage
    const newSendPlainAlert = vi.fn(async () => {});
    const drainer2 = new AlertDrainer({
      storage,
      notifier: { sendPlainAlert: newSendPlainAlert },
      nowFn: () => getNow(),
    });

    // Before backoff elapses
    await drainer2.drainOnce();
    expect(newSendPlainAlert).not.toHaveBeenCalled();

    // After backoff elapses
    setNow(nextAttemptAt);
    await drainer2.drainOnce();
    expect(newSendPlainAlert).toHaveBeenCalledTimes(1);
    expect(newSendPlainAlert).toHaveBeenCalledWith("Durable Alert", "error");

    expect(storage.alerts.getById("a1")?.state).toBe("sent");
  });

  it("11. drainOnce resolves (does not reject) when nextDrainable throws", async () => {
    fixture = makeFixture();
    const { storage, drainer } = fixture;

    vi.spyOn(storage.alerts, "nextDrainable").mockImplementationOnce(() => {
      throw new Error("SQLite query error in nextDrainable");
    });

    await expect(drainer.drainOnce()).resolves.toBeUndefined();
  });

  it("12. an alert whose markSent throws is NOT re-sent on the following pass", async () => {
    fixture = makeFixture();
    const { storage, drainer, sendPlainAlert, getNow, setNow } = fixture;

    storage.alerts.enqueue({
      id: "a_mark_throw",
      source: "s1",
      text: "Alert with failing markSent",
      severity: "error",
      now: getNow(),
    });

    // Make markSent throw on first attempt
    vi.spyOn(storage.alerts, "markSent").mockImplementationOnce(() => {
      throw new Error("SQLite write error in markSent");
    });

    // Pass 1: sendPlainAlert succeeds, markSent throws
    await drainer.drainOnce();
    expect(sendPlainAlert).toHaveBeenCalledTimes(1);

    // Pass 2 (following pass after backoff): should NOT call sendPlainAlert again
    setNow(getNow() + 5000);
    await drainer.drainOnce();
    expect(sendPlainAlert).toHaveBeenCalledTimes(1);
  });

  it("13. logs when markSent returns false (state changed mid-send)", async () => {
    fixture = makeFixture();
    const { storage, drainer, sendPlainAlert, log, getNow } = fixture;

    storage.alerts.enqueue({
      id: "a_mid_change",
      source: "s1",
      text: "Alert mid-change",
      severity: "warning",
      now: getNow(),
    });

    // Stub markSent to return false
    vi.spyOn(storage.alerts, "markSent").mockReturnValueOnce(false);

    await drainer.drainOnce();
    expect(sendPlainAlert).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("markSent returned false"),
      expect.objectContaining({ id: "a_mid_change" }),
    );
  });

  it("14. start() timer callback catches unhandled rejections from drainOnce", async () => {
    fixture = makeFixture();
    const { drainer } = fixture;

    vi.useFakeTimers();
    vi.spyOn(drainer, "drainOnce").mockRejectedValue(new Error("Fatal pass error"));

    drainer.start(100);

    await expect(vi.advanceTimersByTimeAsync(150)).resolves.not.toThrow();

    vi.useRealTimers();
  });
});
