import { afterEach, describe, expect, it } from "vitest";
import { openStorageDb } from "../src/storage/database";

function createStorage() {
  return openStorageDb(":memory:");
}

describe("storage schema and repositories", () => {
  afterEach(() => {
    // in-memory databases are dropped when closed.
  });

  it("upserts, reads, touches, and cleans up sessions", () => {
    const storage = createStorage();

    storage.sessions.upsert({
      sessionId: "sess-1",
      pid: 123,
      ppid: 100,
      cwd: "/tmp",
      label: "demo",
      notify: true,
      state: "running",
      instanceName: "pts/9",
    }, 1_000);

    const session = storage.sessions.get("sess-1");
    expect(session).not.toBeNull();
    expect(session?.notify).toBe(true);
    expect(session?.pid).toBe(123);

    expect(storage.sessions.touch("sess-1", 2_000)).toBe(true);
    const touched = storage.sessions.get("sess-1");
    expect(touched?.updatedAt).toBe(2_000);
    expect(touched?.lastSeen).toBe(2_000);

    expect(storage.sessions.cleanupExpired(2_000)).toBe(0);
    expect(storage.sessions.cleanupExpired(2_000 + 24 * 60 * 60 * 1000 + 1)).toBe(1);
    expect(storage.sessions.get("sess-1")).toBeNull();

    storage.db.close();
  });

  it("mints, validates, and expires session tokens", () => {
    const storage = createStorage();
    storage.sessions.upsert({ sessionId: "sess-token", notify: true }, 10_000);

    storage.sessionTokens.mint(
      {
        token: "token-1",
        sessionId: "sess-token",
        chatId: "42",
        scopes: ["command"],
        context: { source: "test" },
      },
      10_000,
      5_000,
    );

    const valid = storage.sessionTokens.validate("token-1", "42", 12_000);
    expect(valid?.sessionId).toBe("sess-token");
    expect(valid?.context).toEqual({ source: "test" });

    expect(storage.sessionTokens.validate("token-1", "43", 12_000)).toBeNull();
    expect(storage.sessionTokens.validate("token-1", "42", 16_000)).toBeNull();

    storage.db.close();
  });

  it("stores and expires reply tokens", () => {
    const storage = createStorage();

    storage.replyTokens.store("chat-1", "msg-1", "rtok-1", 1_000);
    expect(storage.replyTokens.lookup("chat-1", "msg-1", 2_000, 5_000)).toBe("rtok-1");

    expect(storage.replyTokens.lookup("chat-1", "msg-1", 7_000, 5_000)).toBeNull();
    expect(storage.replyTokens.lookup("chat-1", "msg-1", 8_000, 5_000)).toBeNull();

    storage.replyTokens.store("chat-1", "msg-2", "rtok-2", 10_000);
    storage.replyTokens.store("chat-1", "msg-3", "rtok-3", 20_000);
    expect(storage.replyTokens.cleanup(40_000, 15_000)).toBe(2);

    storage.db.close();
  });

  it("persists, replays, marks done, and cleans inbox commands", () => {
    const storage = createStorage();

    expect(storage.inbox.persist({ commandId: "cmd-1", payload: '{"a":1}' }, 1_000)).toBe(true);
    expect(storage.inbox.persist({ commandId: "cmd-1", payload: '{"a":1}' }, 1_100)).toBe(false);

    expect(storage.inbox.persist({ commandId: "cmd-2", payload: '{"a":2}' }, 1_200)).toBe(true);
    const unfinished = storage.inbox.listUnfinished(10);
    expect(unfinished.map((row) => row.commandId)).toEqual(["cmd-1", "cmd-2"]);

    expect(storage.inbox.markDone("cmd-1", 5_000)).toBe(true);
    expect(storage.inbox.cleanupDone(5_000 + 60 * 60 * 1000 + 1)).toBe(1);

    const remaining = storage.inbox.listUnfinished(10);
    expect(remaining.map((row) => row.commandId)).toEqual(["cmd-2"]);

    storage.db.close();
  });
});
