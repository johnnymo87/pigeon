import { afterEach, describe, expect, it } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { PULL_BACKEND_KIND } from "../src/adapters/goose-pull";
import { bankOrInsertSwarmMessage } from "../src/swarm/bank-or-insert";

describe("bankOrInsertSwarmMessage", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newStorage(): StorageDb {
    storage = openStorageDb(":memory:");
    return storage;
  }

  it("banks when target is a pull session opted into swarm", () => {
    const s = newStorage();
    s.sessions.upsert({
      sessionId: "ses_pull",
      backendKind: PULL_BACKEND_KIND,
      notify: true,
    });
    s.sessions.setPullSources("ses_pull", ["telegram-reply", "swarm"]);

    const result = bankOrInsertSwarmMessage(s, {
      msgId: "msg_1",
      fromSession: "ses_peer",
      toSession: "ses_pull",
      channel: null,
      kind: "chat",
      priority: "normal",
      replyTo: "orig_0",
      payload: "hello pull worker",
    }, 1_000);

    expect(result).toEqual({
      status: "banked",
      msgId: "msg_1",
      fresh: true,
    });

    // Stored in pull_inbox
    const claimed = s.pullInbox.claim("ses_pull", 2_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.msgId).toBe("msg_1");
    expect(claimed[0]!.source).toBe("swarm");
    expect(claimed[0]!.senderId).toBe("ses_peer");
    expect(claimed[0]!.kind).toBe("chat");
    expect(claimed[0]!.replyTo).toBe("orig_0");
    expect(claimed[0]!.payload).toBe("hello pull worker");

    // NOT stored in swarm_messages (arbiter must never see it)
    expect(s.swarm.getByMsgId("msg_1")).toBeNull();

    // Telegram notice enqueued in outbox
    const outboxRow = s.outbox.getByNotificationId("w:msg_1");
    expect(outboxRow).not.toBeNull();
    expect(outboxRow!.sessionId).toBe("ses_pull");
  });

  it("is idempotent on repeat bank with the same msg_id and does not duplicate notice", () => {
    const s = newStorage();
    s.sessions.upsert({
      sessionId: "ses_pull",
      backendKind: PULL_BACKEND_KIND,
      notify: true,
    });
    s.sessions.setPullSources("ses_pull", ["swarm"]);

    const first = bankOrInsertSwarmMessage(s, {
      msgId: "msg_dup",
      fromSession: "ses_peer",
      toSession: "ses_pull",
      channel: null,
      kind: "chat",
      priority: "normal",
      replyTo: null,
      payload: "repeatable",
    }, 1_000);
    expect(first).toEqual({ status: "banked", msgId: "msg_dup", fresh: true });

    // Mark outbox row as sent/modified to verify second call doesn't overwrite/re-enqueue
    s.outbox.markSent("w:msg_dup", 1_500);

    const second = bankOrInsertSwarmMessage(s, {
      msgId: "msg_dup",
      fromSession: "ses_peer",
      toSession: "ses_pull",
      channel: null,
      kind: "chat",
      priority: "normal",
      replyTo: null,
      payload: "repeatable",
    }, 2_000);
    expect(second).toEqual({ status: "banked", msgId: "msg_dup", fresh: false });

    // Outbox row remains sent, not re-created
    expect(s.outbox.getByNotificationId("w:msg_dup")?.state).toBe("sent");
  });

  it("inserts into swarm_messages when target pull session has NOT opted into swarm", () => {
    const s = newStorage();
    s.sessions.upsert({
      sessionId: "ses_pull_default",
      backendKind: PULL_BACKEND_KIND,
      notify: true,
    });
    // Default pullSources is ["telegram-reply"], "swarm" not present

    const result = bankOrInsertSwarmMessage(s, {
      msgId: "msg_norm",
      fromSession: "ses_peer",
      toSession: "ses_pull_default",
      channel: null,
      kind: "chat",
      priority: "normal",
      replyTo: null,
      payload: "to non-opted pull",
    }, 1_000);

    expect(result).toEqual({
      status: "inserted",
      msgId: "msg_norm",
      inserted: true,
    });

    // Swarm message row exists
    expect(s.swarm.getByMsgId("msg_norm")).not.toBeNull();
    // Nothing in pull_inbox
    expect(s.pullInbox.pendingCount("ses_pull_default", 2_000)).toBe(0);
  });

  it("inserts into swarm_messages when target is non-pull backend", () => {
    const s = newStorage();
    s.sessions.upsert({
      sessionId: "ses_oc",
      backendKind: "opencode-plugin-direct",
      notify: true,
    });
    s.sessions.setPullSources("ses_oc", ["swarm"]);

    const result = bankOrInsertSwarmMessage(s, {
      msgId: "msg_oc",
      fromSession: "ses_peer",
      toSession: "ses_oc",
      channel: null,
      kind: "chat",
      priority: "normal",
      replyTo: null,
      payload: "to opencode",
    }, 1_000);

    expect(result).toEqual({
      status: "inserted",
      msgId: "msg_oc",
      inserted: true,
    });
    expect(s.swarm.getByMsgId("msg_oc")).not.toBeNull();
  });

  it("inserts into swarm_messages when target is a channel", () => {
    const s = newStorage();
    const result = bankOrInsertSwarmMessage(s, {
      msgId: "msg_chan",
      fromSession: "ses_peer",
      toSession: null,
      channel: "general",
      kind: "chat",
      priority: "normal",
      replyTo: null,
      payload: "channel message",
    }, 1_000);

    expect(result).toEqual({
      status: "inserted",
      msgId: "msg_chan",
      inserted: true,
    });
    expect(s.swarm.getByMsgId("msg_chan")).not.toBeNull();
  });

  it("inserts into swarm_messages when target session does not exist in storage", () => {
    const s = newStorage();
    const result = bankOrInsertSwarmMessage(s, {
      msgId: "msg_ghost",
      fromSession: "ses_peer",
      toSession: "ses_ghost",
      channel: null,
      kind: "chat",
      priority: "normal",
      replyTo: null,
      payload: "ghost target",
    }, 1_000);

    expect(result).toEqual({
      status: "inserted",
      msgId: "msg_ghost",
      inserted: true,
    });
    expect(s.swarm.getByMsgId("msg_ghost")).not.toBeNull();
  });

  it("refuses scheduled message when target would bank (status 409)", () => {
    const s = newStorage();
    s.sessions.upsert({
      sessionId: "ses_pull",
      backendKind: PULL_BACKEND_KIND,
      notify: true,
    });
    s.sessions.setPullSources("ses_pull", ["swarm"]);

    const result = bankOrInsertSwarmMessage(s, {
      msgId: "msg_sched",
      fromSession: "ses_peer",
      toSession: "ses_pull",
      channel: null,
      kind: "wake",
      priority: "normal",
      replyTo: null,
      payload: "wake up",
      deliverAt: 10_000,
    }, 1_000);

    expect(result).toEqual({
      status: "refused",
      reason: "scheduled",
      statusCode: 409,
      error: "scheduled messages cannot be banked for a pull session",
    });

    // Writes NOTHING
    expect(s.pullInbox.pendingCount("ses_pull", 20_000)).toBe(0);
    expect(s.swarm.getByMsgId("msg_sched")).toBeNull();
    expect(s.outbox.getByNotificationId("w:msg_sched")).toBeNull();
  });

  it("refuses payload > 4000 code points when target would bank (status 413)", () => {
    const s = newStorage();
    s.sessions.upsert({
      sessionId: "ses_pull",
      backendKind: PULL_BACKEND_KIND,
      notify: true,
    });
    s.sessions.setPullSources("ses_pull", ["swarm"]);

    // 4000 code points passes
    const payload4000 = "🚀".repeat(2000) + "a".repeat(2000); // 4000 code points
    expect([...payload4000].length).toBe(4000);
    const okResult = bankOrInsertSwarmMessage(s, {
      msgId: "msg_4000",
      fromSession: "ses_peer",
      toSession: "ses_pull",
      channel: null,
      kind: "chat",
      priority: "normal",
      replyTo: null,
      payload: payload4000,
    }, 1_000);
    expect(okResult.status).toBe("banked");

    // 4001 code points refused
    const payload4001 = payload4000 + "b";
    expect([...payload4001].length).toBe(4001);
    const refusedResult = bankOrInsertSwarmMessage(s, {
      msgId: "msg_4001",
      fromSession: "ses_peer",
      toSession: "ses_pull",
      channel: null,
      kind: "chat",
      priority: "normal",
      replyTo: null,
      payload: payload4001,
    }, 1_000);

    expect(refusedResult.status).toBe("refused");
    if (refusedResult.status === "refused") {
      expect(refusedResult.statusCode).toBe(413);
      expect(refusedResult.reason).toBe("payload_too_large");
      expect(refusedResult.error).toContain("4000");
    }

    // Writes NOTHING for msg_4001
    expect(s.swarm.getByMsgId("msg_4001")).toBeNull();
    expect(s.outbox.getByNotificationId("w:msg_4001")).toBeNull();
  });

  it("does not apply refusals to non-banking targets", () => {
    const s = newStorage();
    s.sessions.upsert({
      sessionId: "ses_oc",
      backendKind: "opencode-plugin-direct",
      notify: true,
    });

    // Scheduled message to non-banking target is inserted into swarm_messages
    const schedResult = bankOrInsertSwarmMessage(s, {
      msgId: "msg_sched_oc",
      fromSession: "ses_peer",
      toSession: "ses_oc",
      channel: null,
      kind: "wake",
      priority: "normal",
      replyTo: null,
      payload: "scheduled to oc",
      deliverAt: 10_000,
    }, 1_000);
    expect(schedResult.status).toBe("inserted");
    expect(s.swarm.getByMsgId("msg_sched_oc")).not.toBeNull();

    // Large payload to non-banking target is inserted into swarm_messages
    const bigPayload = "x".repeat(5000);
    const bigResult = bankOrInsertSwarmMessage(s, {
      msgId: "msg_big_oc",
      fromSession: "ses_peer",
      toSession: "ses_oc",
      channel: null,
      kind: "chat",
      priority: "normal",
      replyTo: null,
      payload: bigPayload,
    }, 1_000);
    expect(bigResult.status).toBe("inserted");
    expect(s.swarm.getByMsgId("msg_big_oc")).not.toBeNull();
  });
});
