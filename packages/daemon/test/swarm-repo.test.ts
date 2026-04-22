import { describe, expect, it } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";

function createStorage(): StorageDb {
  return openStorageDb(":memory:");
}

const BASE = {
  msgId: "msg_01h1",
  fromSession: "ses_a",
  toSession: "ses_b" as string | null,
  channel: null as string | null,
  kind: "chat",
  priority: "normal" as const,
  replyTo: null as string | null,
  payload: "hello",
};

describe("SwarmRepository", () => {
  it("inserts and retrieves a message", () => {
    const s = createStorage();
    s.swarm.insert(BASE, 1_000);
    const m = s.swarm.getByMsgId("msg_01h1");
    expect(m).not.toBeNull();
    expect(m!.toSession).toBe("ses_b");
    expect(m!.state).toBe("queued");
    expect(m!.attempts).toBe(0);
    expect(m!.createdAt).toBe(1_000);
    s.db.close();
  });

  it("is idempotent on duplicate msgId", () => {
    const s = createStorage();
    s.swarm.insert(BASE, 1_000);
    s.swarm.insert({ ...BASE, payload: "different" }, 2_000);
    const m = s.swarm.getByMsgId("msg_01h1");
    expect(m!.payload).toBe("hello");
    expect(m!.createdAt).toBe(1_000);
    s.db.close();
  });

  it("returns ready messages for a target in createdAt order", () => {
    const s = createStorage();
    s.swarm.insert({ ...BASE, msgId: "m1" }, 1_000);
    s.swarm.insert({ ...BASE, msgId: "m2" }, 2_000);
    s.swarm.insert({ ...BASE, msgId: "m3", toSession: "ses_other" }, 3_000);
    const ready = s.swarm.getReadyForTarget("ses_b", 5_000, 10);
    expect(ready.map((m) => m.msgId)).toEqual(["m1", "m2"]);
    s.db.close();
  });

  it("excludes already-handed-off messages from getReady", () => {
    const s = createStorage();
    s.swarm.insert(BASE, 1_000);
    s.swarm.markHandedOff("msg_01h1", 2_000);
    const ready = s.swarm.getReadyForTarget("ses_b", 5_000);
    expect(ready).toHaveLength(0);
    s.db.close();
  });

  it("respects next_retry_at for queued retries", () => {
    const s = createStorage();
    s.swarm.insert(BASE, 1_000);
    s.swarm.markRetry("msg_01h1", 1_500, 10_000); // retry at 11_500
    expect(s.swarm.getReadyForTarget("ses_b", 11_000)).toHaveLength(0);
    expect(s.swarm.getReadyForTarget("ses_b", 11_500)).toHaveLength(1);
    s.db.close();
  });

  it("getInbox returns delivered messages for a session, ordered ascending", () => {
    const s = createStorage();
    s.swarm.insert({ ...BASE, msgId: "m1" }, 1_000);
    s.swarm.insert({ ...BASE, msgId: "m2" }, 2_000);
    s.swarm.markHandedOff("m1", 1_500);
    s.swarm.markHandedOff("m2", 2_500);
    const inbox = s.swarm.getInbox("ses_b", null);
    expect(inbox.map((m) => m.msgId)).toEqual(["m1", "m2"]);
    const since = s.swarm.getInbox("ses_b", "m1");
    expect(since.map((m) => m.msgId)).toEqual(["m2"]);
    s.db.close();
  });

  it("listTargetsWithReady returns distinct targets with ready work", () => {
    const s = createStorage();
    s.swarm.insert({ ...BASE, msgId: "m1", toSession: "ses_b" }, 1_000);
    s.swarm.insert({ ...BASE, msgId: "m2", toSession: "ses_b" }, 1_500);
    s.swarm.insert({ ...BASE, msgId: "m3", toSession: "ses_c" }, 2_000);
    s.swarm.insert({ ...BASE, msgId: "m4", toSession: "ses_d" }, 2_500);
    s.swarm.markHandedOff("m4", 3_000);
    const targets = s.swarm.listTargetsWithReady(5_000).sort();
    expect(targets).toEqual(["ses_b", "ses_c"]);
    s.db.close();
  });
});
