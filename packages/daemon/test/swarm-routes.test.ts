import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";

describe("POST /swarm/send", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(now = 1_000) {
    storage = openStorageDb(":memory:");
    return { app: createApp(storage, { nowFn: () => now }), storage };
  }

  it("returns 202 and persists a swarm message", async () => {
    const { app, storage: s } = newApp();
    const res = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          kind: "chat",
          priority: "normal",
          payload: "hello",
        }),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: boolean; msg_id: string };
    expect(body.accepted).toBe(true);
    expect(body.msg_id).toMatch(/^msg_/);

    const stored = s.swarm.getByMsgId(body.msg_id);
    expect(stored).not.toBeNull();
    expect(stored!.payload).toBe("hello");
    expect(stored!.fromSession).toBe("ses_a");
    expect(stored!.toSession).toBe("ses_b");
    expect(stored!.priority).toBe("normal");
  });

  it("respects caller-supplied msg_id (idempotency)", async () => {
    const { app, storage: s } = newApp();
    for (let i = 0; i < 2; i++) {
      const res = await app(
        new Request("http://localhost/swarm/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            msg_id: "msg_caller",
            from: "ses_a",
            to: "ses_b",
            kind: "chat",
            payload: i === 0 ? "first" : "second",
          }),
        }),
      );
      expect(res.status).toBe(202);
    }
    const stored = s.swarm.getByMsgId("msg_caller");
    expect(stored!.payload).toBe("first");
  });

  it("rejects without `from`", async () => {
    const { app } = newApp();
    const res = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "ses_b", payload: "x" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects when neither `to` nor `channel` is provided", async () => {
    const { app } = newApp();
    const res = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "ses_a", payload: "x" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects when both `to` and `channel` are provided", async () => {
    const { app } = newApp();
    const res = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          channel: "workers",
          payload: "x",
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects empty payload", async () => {
    const { app } = newApp();
    const res = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "ses_a", to: "ses_b", payload: "" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /swarm/inbox", () => {
  let storage: StorageDb | null = null;
  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  it("returns delivered messages for a session, supports `since`", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 1_000 });

    storage.swarm.insert(
      {
        msgId: "m1",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "p1",
      },
      1_000,
    );
    storage.swarm.insert(
      {
        msgId: "m2",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "p2",
      },
      2_000,
    );
    storage.swarm.markHandedOff("m1", 1_500);
    storage.swarm.markHandedOff("m2", 2_500);

    const res = await app(
      new Request("http://localhost/swarm/inbox?session=ses_b"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ msg_id: string }>;
    };
    expect(body.messages.map((m) => m.msg_id)).toEqual(["m1", "m2"]);

    const since = await app(
      new Request("http://localhost/swarm/inbox?session=ses_b&since=m1"),
    );
    const sinceBody = (await since.json()) as {
      messages: Array<{ msg_id: string }>;
    };
    expect(sinceBody.messages.map((m) => m.msg_id)).toEqual(["m2"]);
  });

  it("rejects when session is missing", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 1_000 });

    const res = await app(new Request("http://localhost/swarm/inbox"));
    expect(res.status).toBe(400);
  });
});
