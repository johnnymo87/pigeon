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
    const inbox = s.swarm.getInbox("ses_b", {});
    expect(inbox.messages.map((m) => m.msgId)).toEqual(["m1", "m2"]);
    expect(inbox.hasMore).toBe(false);
    const since = s.swarm.getInbox("ses_b", { since: "m1" });
    expect(since.messages.map((m) => m.msgId)).toEqual(["m2"]);
    expect(since.hasMore).toBe(false);
    s.db.close();
  });

  it("getInbox with a limit returns the NEWEST N messages (recent view), ascending", () => {
    const s = createStorage();
    s.swarm.insert({ ...BASE, msgId: "m1" }, 1_000);
    s.swarm.insert({ ...BASE, msgId: "m2" }, 2_000);
    s.swarm.insert({ ...BASE, msgId: "m3" }, 3_000);
    s.swarm.markHandedOff("m1", 1_500);
    s.swarm.markHandedOff("m2", 2_500);
    s.swarm.markHandedOff("m3", 3_500);

    // limit=1 must return the NEWEST message, not the oldest.
    const one = s.swarm.getInbox("ses_b", { limit: 1 });
    expect(one.messages.map((m) => m.msgId)).toEqual(["m3"]);
    expect(one.hasMore).toBe(true); // older messages exist

    // limit=2 returns the newest 2, in chronological (ascending) order.
    const two = s.swarm.getInbox("ses_b", { limit: 2 });
    expect(two.messages.map((m) => m.msgId)).toEqual(["m2", "m3"]);
    expect(two.hasMore).toBe(true);

    // limit == count: everything, ascending, nothing more.
    const three = s.swarm.getInbox("ses_b", { limit: 3 });
    expect(three.messages.map((m) => m.msgId)).toEqual(["m1", "m2", "m3"]);
    expect(three.hasMore).toBe(false);

    // limit larger than available returns everything, ascending.
    const big = s.swarm.getInbox("ses_b", { limit: 50 });
    expect(big.messages.map((m) => m.msgId)).toEqual(["m1", "m2", "m3"]);
    expect(big.hasMore).toBe(false);
  });

  it("getInbox with `since` + limit drains forward: OLDEST N after the cursor", () => {
    const s = createStorage();
    for (const [id, ts] of [
      ["m1", 1_000],
      ["m2", 2_000],
      ["m3", 3_000],
    ] as const) {
      s.swarm.insert({ ...BASE, msgId: id }, ts);
      s.swarm.markHandedOff(id, ts + 500);
    }
    // Forward replay wants the oldest-after-cursor first so a caller can
    // advance `since` without skipping the middle.
    const page1 = s.swarm.getInbox("ses_b", { since: "m1", limit: 1 });
    expect(page1.messages.map((m) => m.msgId)).toEqual(["m2"]);
    expect(page1.hasMore).toBe(true); // m3 still ahead

    const page2 = s.swarm.getInbox("ses_b", { since: "m2", limit: 1 });
    expect(page2.messages.map((m) => m.msgId)).toEqual(["m3"]);
    expect(page2.hasMore).toBe(false);

    const both = s.swarm.getInbox("ses_b", { since: "m1", limit: 2 });
    expect(both.messages.map((m) => m.msgId)).toEqual(["m2", "m3"]);
    expect(both.hasMore).toBe(false);
    s.db.close();
  });

  it("getInbox with `before` pages backward: NEWEST N older than the cursor", () => {
    const s = createStorage();
    for (const [id, ts] of [
      ["m1", 1_000],
      ["m2", 2_000],
      ["m3", 3_000],
    ] as const) {
      s.swarm.insert({ ...BASE, msgId: id }, ts);
      s.swarm.markHandedOff(id, ts + 500);
    }
    // Scrolling back from m3: the newest message older than m3 is m2.
    const back1 = s.swarm.getInbox("ses_b", { before: "m3", limit: 1 });
    expect(back1.messages.map((m) => m.msgId)).toEqual(["m2"]);
    expect(back1.hasMore).toBe(true); // m1 still older

    const back2 = s.swarm.getInbox("ses_b", { before: "m3", limit: 2 });
    expect(back2.messages.map((m) => m.msgId)).toEqual(["m1", "m2"]);
    expect(back2.hasMore).toBe(false);

    // before without limit returns all older messages, ascending.
    const allBefore = s.swarm.getInbox("ses_b", { before: "m3" });
    expect(allBefore.messages.map((m) => m.msgId)).toEqual(["m1", "m2"]);
    expect(allBefore.hasMore).toBe(false);
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
