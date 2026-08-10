import { describe, expect, it, vi } from "vitest";
import {
  enqueueSwarmTelegramNotice,
  enqueueSwarmCancelNotice,
} from "../src/swarm/telegram-notice";
import type { StorageDb } from "../src/storage/database";
import { openStorageDb } from "../src/storage/database";
import type { SwarmMessageRecord } from "../src/storage/swarm-repo";
import { notifySenderOfFailure } from "../src/swarm/notify-sender";
import { DeliveryWatchdog, type WatchdogClient } from "../src/swarm/delivery-watchdog";

function makeRecord(overrides: Partial<SwarmMessageRecord> = {}): SwarmMessageRecord {
  return {
    msgId: "msg_1001",
    fromSession: "ses_sender",
    toSession: "ses_receiver",
    channel: null,
    kind: "chat",
    priority: "normal",
    replyTo: null,
    payload: "Hello receiver!",
    state: "queued",
    attempts: 0,
    nextRetryAt: null,
    createdAt: 1786363200000,
    updatedAt: 1786363200000,
    handedOffAt: null,
    verifiedAt: null,
    requeueCount: 0,
    nudgeCount: 0,
    abortedAt: null,
    deliverAt: null,
    expiresAt: null,
    cancelledAt: null,
    ref: null,
    ...overrides,
  };
}

function mockStorage(opts: {
  senderSession?: { title?: string | null; label?: string | null; cwd?: string | null } | null;
  targetSession?: { title?: string | null; label?: string | null; cwd?: string | null } | null;
  outboxThrow?: boolean;
} = {}): { storage: StorageDb; upsertCalls: any[] } {
  const upsertCalls: any[] = [];
  const senderSession = opts.senderSession === undefined
    ? { title: "Sender Title", label: "sender-label", cwd: "/home/dev/sender" }
    : opts.senderSession;
  const targetSession = opts.targetSession === undefined
    ? { title: "Target Title", label: "target-label", cwd: "/home/dev/target" }
    : opts.targetSession;

  const storage = {
    sessions: {
      get: (id: string) => {
        if (id === "ses_sender") return senderSession ? { sessionId: id, ...senderSession } : null;
        if (id === "ses_receiver") return targetSession ? { sessionId: id, ...targetSession } : null;
        return null;
      },
    },
    outbox: {
      upsert: (input: any, now: number) => {
        if (opts.outboxThrow) {
          throw new Error("Outbox database locked");
        }
        upsertCalls.push({ input, now });
      },
    },
  } as unknown as StorageDb;

  return { storage, upsertCalls };
}

describe("enqueueSwarmTelegramNotice", () => {
  it("enqueues exactly one row addressed to the receiver with kind: swarm and threaded: true", () => {
    const { storage, upsertCalls } = mockStorage();
    const record = makeRecord();
    const now = 1786363205000;

    enqueueSwarmTelegramNotice(storage, record, now);

    expect(upsertCalls).toHaveLength(1);
    const call = upsertCalls[0]!;
    expect(call.now).toBe(now);
    expect(call.input.notificationId).toBe("w:msg_1001");
    expect(call.input.sessionId).toBe("ses_receiver");
    expect(call.input.requestId).toBe("swarm-msg_1001");
    expect(call.input.kind).toBe("swarm");

    const payload = JSON.parse(call.input.payload);
    expect(payload.notificationId).toBe("w:msg_1001");
    expect(payload.threaded).toBe(true);
    expect(payload.title).toBe("Target Title");
    expect(payload.dir).toBe("/home/dev/target");
    expect(payload.messages).toBeDefined();
    expect(payload.messages.length).toBeGreaterThan(0);
    expect(payload.messages[0].text).toContain("📨 swarm · chat · normal");
    expect(payload.messages[0].text).toContain("from Sender Title");
    expect(payload.messages[0].text).toContain("Hello receiver!");
  });

  it("skips channel broadcasts when toSession is null", () => {
    const { storage, upsertCalls } = mockStorage();
    const record = makeRecord({ toSession: null, channel: "broadcast-channel" });

    enqueueSwarmTelegramNotice(storage, record, Date.now());

    expect(upsertCalls).toHaveLength(0);
  });

  it("does not throw when outbox upsert throws", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { storage } = mockStorage({ outboxThrow: true });
      const record = makeRecord();

      expect(() => {
        enqueueSwarmTelegramNotice(storage, record, Date.now());
      }).not.toThrow();

      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("enqueueSwarmCancelNotice", () => {
  it("enqueues cancel notice using wc: prefix addressed to the receiver session", () => {
    const { storage, upsertCalls } = mockStorage();
    const record = makeRecord();
    const now = 1786363210000;

    enqueueSwarmCancelNotice(storage, record, now);

    expect(upsertCalls).toHaveLength(1);
    const call = upsertCalls[0]!;
    expect(call.now).toBe(now);
    expect(call.input.notificationId).toBe("wc:msg_1001");
    expect(call.input.sessionId).toBe("ses_receiver");
    expect(call.input.requestId).toBe("swarm-cancel-msg_1001");
    expect(call.input.kind).toBe("swarm");

    const payload = JSON.parse(call.input.payload);
    expect(payload.notificationId).toBe("wc:msg_1001");
    expect(payload.threaded).toBe(true);
    expect(payload.title).toBe("Target Title");
    expect(payload.dir).toBe("/home/dev/target");
    expect(payload.messages[0].text).toContain("🚫 cancelled msg_1001");
  });

  it("skips channel broadcasts when toSession is null", () => {
    const { storage, upsertCalls } = mockStorage();
    const record = makeRecord({ toSession: null, channel: "broadcast-channel" });

    enqueueSwarmCancelNotice(storage, record, Date.now());

    expect(upsertCalls).toHaveLength(0);
  });

  it("does not throw when outbox upsert throws", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { storage } = mockStorage({ outboxThrow: true });
      const record = makeRecord();

      expect(() => {
        enqueueSwarmCancelNotice(storage, record, Date.now());
      }).not.toThrow();

      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("pigeon internal swarm inserts (notifySenderOfFailure & watchdog nudge)", () => {
  it("notifySenderOfFailure enqueues a Telegram notice to original sender in outbox", () => {
    const storage = openStorageDb(":memory:");
    try {
      const failedRecord = makeRecord({
        msgId: "msg_original_1",
        fromSession: "ses_sender_1",
        toSession: "ses_receiver_1",
        payload: "some payload",
      });

      notifySenderOfFailure(storage, failedRecord, "target unroutable", 1000);

      const row = storage.db.prepare("SELECT msg_id, to_session FROM swarm_messages WHERE from_session = 'pigeon'").get() as { msg_id: string; to_session: string };
      expect(row).toBeDefined();
      expect(row.to_session).toBe("ses_sender_1");

      const outboxRow = storage.outbox.getByNotificationId(`w:${row.msg_id}`);
      expect(outboxRow).not.toBeNull();
      expect(outboxRow!.sessionId).toBe("ses_sender_1");
      expect(outboxRow!.kind).toBe("swarm");
    } finally {
      storage.db.close();
    }
  });

  it("DeliveryWatchdog nudge enqueues a Telegram notice to target session in outbox", async () => {
    const storage = openStorageDb(":memory:");
    try {
      const now = 100_000;
      storage.swarm.insert({
        msgId: "m_handed_off",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "test message",
      }, now - 60_000);

      storage.db.prepare("UPDATE swarm_messages SET state = 'handed_off', handed_off_at = ? WHERE msg_id = ?").run(now - 30_000, "m_handed_off");

      const mockClient: WatchdogClient = {
        getSessionMessages: async () => [
          {
            info: { role: "user", time: { created: now - 30_000 } },
            parts: [{ type: "text", text: `<swarm_message v="1" msg_id="m_handed_off">test message</swarm_message>` }],
          },
        ],
        abortSession: async () => {},
      };

      const watchdog = new DeliveryWatchdog({
        storage,
        resolveClients: (sessionId: string) => ({ preferred: mockClient, all: [mockClient] }),
        nowFn: () => now,
        verifyAfterMs: 5_000,
      });

      await watchdog.processOnce();

      const nudgeRow = storage.db.prepare("SELECT msg_id, to_session FROM swarm_messages WHERE kind = 'swarm.nudge'").get() as { msg_id: string; to_session: string } | undefined;
      expect(nudgeRow).toBeDefined();
      expect(nudgeRow!.to_session).toBe("ses_b");

      const outboxRow = storage.outbox.getByNotificationId(`w:${nudgeRow!.msg_id}`);
      expect(outboxRow).not.toBeNull();
      expect(outboxRow!.sessionId).toBe("ses_b");
      expect(outboxRow!.kind).toBe("swarm");
    } finally {
      storage.db.close();
    }
  });
});
