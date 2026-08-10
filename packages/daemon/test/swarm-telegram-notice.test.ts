import { describe, expect, it, vi } from "vitest";
import {
  enqueueSwarmTelegramNotice,
  enqueueSwarmCancelNotice,
} from "../src/swarm/telegram-notice";
import type { StorageDb } from "../src/storage/database";
import type { SwarmMessageRecord } from "../src/storage/swarm-repo";

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
