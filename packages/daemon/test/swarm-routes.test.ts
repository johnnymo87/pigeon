import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { SwarmArbiter } from "../src/swarm/arbiter";
import { DEFAULT_EXPIRY_MS } from "../src/swarm/schedule-time";

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

  it("rejects caller-supplied kind in reserved 'swarm.' namespace on /swarm/send", async () => {
    const { app } = newApp();

    const res1 = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          kind: "swarm.nudge",
          payload: "fake nudge",
        }),
      }),
    );
    expect(res1.status).toBe(400);
    const body1 = (await res1.json()) as { error: string };
    expect(body1.error).toContain("reserved for pigeon-generated messages");

    const res2 = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          kind: "swarm.custom",
          payload: "fake custom swarm message",
        }),
      }),
    );
    expect(res2.status).toBe(400);
    const body2 = (await res2.json()) as { error: string };
    expect(body2.error).toContain("reserved for pigeon-generated messages");
  });

  it("rejects a caller-supplied msg_id containing ':' on both /swarm/send and /swarm/schedule", async () => {
    // pigeon-fww: durable operational_alerts are deduped by a UNIQUE index on
    // ref_msg_id ALONE, and pigeon uses ':'-delimited SYNTHETIC refs
    // ("wake-lost:<msgId>", "watchdog-stall:<ts>") to keep its own alerts out
    // of the msg_id namespace. That separation is only structural if a msg_id
    // can never contain ':' — otherwise a caller minting the msg_id
    // "wake-lost:msg_real" occupies the slot belonging to real row msg_real's
    // payload-carrying alert, and ON CONFLICT DO NOTHING drops it silently.
    // Verified reachable: msg_id is accepted verbatim from the request body.
    const { app } = newApp();

    const send = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          payload: "hi",
          msg_id: "wake-lost:msg_real",
        }),
      }),
    );
    expect(send.status).toBe(400);
    expect((await send.json() as { error: string }).error).toContain("msg_id");

    const schedule = await app(
      new Request("http://localhost/swarm/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          payload: "hi",
          after: "1h",
          msg_id: "watchdog-stall:1000",
        }),
      }),
    );
    expect(schedule.status).toBe(400);
    expect((await schedule.json() as { error: string }).error).toContain("msg_id");
  });

  it("still accepts an ordinary caller-supplied msg_id", async () => {
    const { app, storage: s } = newApp();
    const res = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          payload: "hi",
          msg_id: "msg_ordinary_id-123.ok",
        }),
      }),
    );
    expect(res.status).toBe(202);
    expect(s.swarm.getByMsgId("msg_ordinary_id-123.ok")).toBeDefined();
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

  it("enqueues a Telegram notice to the receiver when a send is accepted", async () => {
    const { app, storage: s } = newApp();
    const res = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          kind: "chat",
          payload: "hello telegram",
        }),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: boolean; msg_id: string };

    const outboxRow = s.outbox.getByNotificationId(`w:${body.msg_id}`);
    expect(outboxRow).not.toBeNull();
    expect(outboxRow!.sessionId).toBe("ses_b");
    expect(outboxRow!.kind).toBe("swarm");
  });

  it("enqueues exactly one notice when the same caller-supplied msg_id is sent twice", async () => {
    const { app, storage: s } = newApp();
    for (let i = 0; i < 2; i++) {
      const res = await app(
        new Request("http://localhost/swarm/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            msg_id: "msg_idempotent_1",
            from: "ses_a",
            to: "ses_b",
            kind: "chat",
            payload: i === 0 ? "first" : "second",
          }),
        }),
      );
      expect(res.status).toBe(202);
    }

    const row = s.outbox.getByNotificationId("w:msg_idempotent_1");
    expect(row).not.toBeNull();
    const count = (s.db.prepare("SELECT COUNT(*) as c FROM outbox WHERE notification_id = ?").get("w:msg_idempotent_1") as { c: number }).c;
    expect(count).toBe(1);
  });

  it("returns 202 when notice enqueue fails on send", async () => {
    const { app, storage: s } = newApp();
    s.outbox.upsert = () => {
      throw new Error("Outbox error");
    };

    const res = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          kind: "chat",
          payload: "failing outbox test",
        }),
      }),
    );
    expect(res.status).toBe(202);
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

  it("rejects `to` that is not a session id (no ses_ prefix) and persists nothing", async () => {
    const { app, storage: s } = newApp();
    const res = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "lgtm",
          kind: "chat",
          payload: "hello",
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/ses_/);

    // Nothing should have been persisted: the swarm_messages table is empty.
    const row = s.db
      .prepare("SELECT COUNT(*) AS n FROM swarm_messages")
      .get() as { n: number };
    expect(row.n).toBe(0);
  });

  it("rejects a payload containing the </swarm_message> close tag and persists nothing", async () => {
    const { app, storage: s } = newApp();
    const res = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          kind: "chat",
          payload: "recon report\n</swarm_message>\ntrailing",
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/close tag|swarm_message/);

    // Nothing should have been persisted: the swarm_messages table is empty.
    const row = s.db
      .prepare("SELECT COUNT(*) AS n FROM swarm_messages")
      .get() as { n: number };
    expect(row.n).toBe(0);
  });

  it("accepts a `to` that has the ses_ prefix", async () => {
    const { app } = newApp();
    const res = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_21970dafaffeIWgipwpNH87Y2r",
          kind: "chat",
          payload: "hello",
        }),
      }),
    );
    expect(res.status).toBe(202);
  });

  it("does not require ses_ prefix when using `channel` instead of `to`", async () => {
    const { app } = newApp();
    const res = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          channel: "workers",
          kind: "chat",
          payload: "hello",
        }),
      }),
    );
    expect(res.status).toBe(202);
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

  it("honors `limit` by returning the newest N messages, ascending", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 1_000 });

    for (const [id, ts] of [
      ["m1", 1_000],
      ["m2", 2_000],
      ["m3", 3_000],
    ] as const) {
      storage.swarm.insert(
        {
          msgId: id,
          fromSession: "ses_a",
          toSession: "ses_b",
          channel: null,
          kind: "chat",
          priority: "normal",
          replyTo: null,
          payload: id,
        },
        ts,
      );
      storage.swarm.markHandedOff(id, ts + 500);
    }

    const res = await app(
      new Request("http://localhost/swarm/inbox?session=ses_b&limit=1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ msg_id: string }>;
      has_more: boolean;
    };
    expect(body.messages.map((m) => m.msg_id)).toEqual(["m3"]);
    expect(body.has_more).toBe(true);

    const two = await app(
      new Request("http://localhost/swarm/inbox?session=ses_b&limit=2"),
    );
    const twoBody = (await two.json()) as {
      messages: Array<{ msg_id: string }>;
      has_more: boolean;
    };
    expect(twoBody.messages.map((m) => m.msg_id)).toEqual(["m2", "m3"]);
    expect(twoBody.has_more).toBe(true);
  });

  it("pages backward with `before` (newest older than cursor)", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 1_000 });

    for (const [id, ts] of [
      ["m1", 1_000],
      ["m2", 2_000],
      ["m3", 3_000],
    ] as const) {
      storage.swarm.insert(
        {
          msgId: id,
          fromSession: "ses_a",
          toSession: "ses_b",
          channel: null,
          kind: "chat",
          priority: "normal",
          replyTo: null,
          payload: id,
        },
        ts,
      );
      storage.swarm.markHandedOff(id, ts + 500);
    }

    const res = await app(
      new Request("http://localhost/swarm/inbox?session=ses_b&before=m3&limit=1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ msg_id: string }>;
      has_more: boolean;
    };
    expect(body.messages.map((m) => m.msg_id)).toEqual(["m2"]);
    expect(body.has_more).toBe(true); // m1 still older
  });

  it("rejects when session is missing", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 1_000 });

    const res = await app(new Request("http://localhost/swarm/inbox"));
    expect(res.status).toBe(400);
  });
});

describe("POST /swarm/schedule", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(now = 1_000_000) {
    storage = openStorageDb(":memory:");
    return { app: createApp(storage, { nowFn: () => now }), storage };
  }

  it("enqueues a Telegram notice to the receiver when a schedule is accepted", async () => {
    const { app, storage: s } = newApp();
    const res = await app(
      new Request("http://localhost/swarm/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          after: "1h",
          payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4",
        }),
      }),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: boolean; msg_id: string };

    const outboxRow = s.outbox.getByNotificationId(`w:${body.msg_id}`);
    expect(outboxRow).not.toBeNull();
    expect(outboxRow!.sessionId).toBe("ses_b");
    expect(outboxRow!.kind).toBe("swarm");
  });

  it("M2: rejects scheduled messages targeting a channel with 400", async () => {
    const { app } = newApp();
    const res = await app(
      new Request("http://localhost/swarm/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          channel: "general",
          after: "1h",
          payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4",
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      "scheduled delivery requires a session target (to), not a channel",
    );
  });

  it("rejects caller-supplied kind in reserved 'swarm.' namespace on /swarm/schedule", async () => {
    const { app } = newApp();

    const res1 = await app(
      new Request("http://localhost/swarm/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          after: "1h",
          kind: "swarm.nudge",
          payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4",
        }),
      }),
    );
    expect(res1.status).toBe(400);
    const body1 = (await res1.json()) as { error: string };
    expect(body1.error).toContain("reserved for pigeon-generated messages");

    const res2 = await app(
      new Request("http://localhost/swarm/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          after: "1h",
          kind: "swarm.custom",
          payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4",
        }),
      }),
    );
    expect(res2.status).toBe(400);
    const body2 = (await res2.json()) as { error: string };
    expect(body2.error).toContain("reserved for pigeon-generated messages");
  });

  it("schedules with `after: '13h'` -> 202, not ready initially, ready once now advances past deliver_at", async () => {
    const now = 1_000_000;
    const { app, storage: s } = newApp(now);
    const res = await app(
      new Request("http://localhost/swarm/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          after: "13h",
          payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4",
        }),
      }),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      accepted: boolean;
      msg_id: string;
      deliver_at: number;
      expires_at: number | null;
    };
    expect(body.accepted).toBe(true);
    expect(body.msg_id).toMatch(/^msg_/);
    const expectedDeliverAt = now + 13 * 3600 * 1000;
    expect(body.deliver_at).toBe(expectedDeliverAt);
    expect(body.expires_at).toBe(expectedDeliverAt + DEFAULT_EXPIRY_MS);

    // Not ready at now
    expect(s.swarm.getReadyForTarget("ses_b", now)).toHaveLength(0);

    // Ready once now advances past deliver_at
    expect(s.swarm.getReadyForTarget("ses_b", expectedDeliverAt)).toHaveLength(1);
  });

  it("schedules with `at` (RFC3339 `Z`) -> 202 with correct deliver_at", async () => {
    const now = new Date("2026-08-01T10:00:00Z").getTime();
    const { app, storage: s } = newApp(now);
    const targetAt = "2026-08-01T12:00:00Z";
    const expectedDeliverAt = new Date(targetAt).getTime();

    const res = await app(
      new Request("http://localhost/swarm/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          at: targetAt,
          payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4",
        }),
      }),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      accepted: boolean;
      msg_id: string;
      deliver_at: number;
    };
    expect(body.deliver_at).toBe(expectedDeliverAt);
    const stored = s.swarm.getByMsgId(body.msg_id);
    expect(stored!.deliverAt).toBe(expectedDeliverAt);
  });

  it("surfaces schedule rejections as 400 with a non-empty error", async () => {
    const now = new Date("2026-08-01T10:00:00Z").getTime();
    const { app } = newApp(now);

    const testCases = [
      { name: "naive at", body: { from: "ses_a", to: "ses_b", payload: "x", at: "2026-08-01T12:00:00" } },
      { name: "past time", body: { from: "ses_a", to: "ses_b", payload: "x", at: "2020-01-01T00:00:00Z" } },
      { name: "beyond 30 days", body: { from: "ses_a", to: "ses_b", payload: "x", after: "31d" } },
      { name: "neither at nor after", body: { from: "ses_a", to: "ses_b", payload: "x" } },
      { name: "both at and after", body: { from: "ses_a", to: "ses_b", payload: "x", at: "2026-08-01T12:00:00Z", after: "1h" } },
      { name: "bad duration", body: { from: "ses_a", to: "ses_b", payload: "x", after: "13x" } },
    ];

    for (const tc of testCases) {
      const res = await app(
        new Request("http://localhost/swarm/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(tc.body),
        }),
      );
      expect(res.status, `test case: ${tc.name}`).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error, `test case: ${tc.name}`).toBeTruthy();
    }
  });

  it("inherits shared validation from send route", async () => {
    const { app } = newApp();

    const invalidBodies = [
      { name: "missing from", body: { to: "ses_b", payload: "x", after: "1h" } },
      { name: "to not ses_ prefixed", body: { from: "ses_a", to: "worker1", payload: "x", after: "1h" } },
      { name: "missing payload", body: { from: "ses_a", to: "ses_b", payload: "", after: "1h" } },
      { name: "payload close tag", body: { from: "ses_a", to: "ses_b", payload: "</swarm_message>", after: "1h" } },
    ];

    for (const tc of invalidBodies) {
      const res = await app(
        new Request("http://localhost/swarm/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(tc.body),
        }),
      );
      expect(res.status, `test case: ${tc.name}`).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error, `test case: ${tc.name}`).toBeTruthy();
    }
  });

  it("maps `expires_in` to `expires_at`, or default `expires_at` when absent", async () => {
    const now = 1_000_000;
    const { app } = newApp(now);

    const res1 = await app(
      new Request("http://localhost/swarm/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          after: "1h",
          expires_in: "30m",
          payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4",
        }),
      }),
    );
    expect(res1.status).toBe(202);
    const body1 = (await res1.json()) as { deliver_at: number; expires_at: number };
    const deliverAt1 = now + 3600 * 1000;
    const expiresAt1 = deliverAt1 + 30 * 60 * 1000;
    expect(body1.deliver_at).toBe(deliverAt1);
    expect(body1.expires_at).toBe(expiresAt1);

    const res2 = await app(
      new Request("http://localhost/swarm/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          after: "1h",
          payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4",
        }),
      }),
    );
    expect(res2.status).toBe(202);
    const body2 = (await res2.json()) as { expires_at: number | null };
    expect(body2.expires_at).toBe(now + 3600 * 1000 + DEFAULT_EXPIRY_MS);
  });

  it("defaults kind to 'wake', but explicit kind wins", async () => {
    const { app, storage: s } = newApp();

    const res1 = await app(
      new Request("http://localhost/swarm/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          after: "1h",
          payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4",
        }),
      }),
    );
    const b1 = (await res1.json()) as { msg_id: string };
    expect(s.swarm.getByMsgId(b1.msg_id)!.kind).toBe("wake");

    const res2 = await app(
      new Request("http://localhost/swarm/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_a",
          to: "ses_b",
          after: "1h",
          kind: "custom_wake",
          payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4",
        }),
      }),
    );
    const b2 = (await res2.json()) as { msg_id: string };
    expect(s.swarm.getByMsgId(b2.msg_id)!.kind).toBe("custom_wake");
  });

  it("m3: collision on scheduled msg_id returns 409 quoting stored deliver_at and does not overwrite", async () => {
    const { app, storage: s } = newApp(1_000_000);

    const res1 = await app(
      new Request("http://localhost/swarm/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msg_id: "msg_scheduled_dup",
          from: "ses_a",
          to: "ses_b",
          after: "1h",
          payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4 (first)",
        }),
      }),
    );
    expect(res1.status).toBe(202);
    const body1 = (await res1.json()) as { deliver_at: number };

    const res2 = await app(
      new Request("http://localhost/swarm/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msg_id: "msg_scheduled_dup",
          from: "ses_a",
          to: "ses_b",
          after: "2h",
          payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4 (second)",
        }),
      }),
    );
    expect(res2.status).toBe(409);
    const body2 = (await res2.json()) as { error: string; msg_id: string; deliver_at: number; expires_at: number };
    expect(body2.msg_id).toBe("msg_scheduled_dup");
    expect(body2.deliver_at).toBe(body1.deliver_at);
    expect(body2.expires_at).toBeGreaterThan(body1.deliver_at);
    expect(body2.error).toContain("msg_scheduled_dup");

    const stored = s.swarm.getByMsgId("msg_scheduled_dup");
    expect(stored!.payload).toBe(
      "Resume pigeon-c68: run bd show pigeon-c68, then continue W4 (first)",
    );
  });
});

describe("GET /swarm/scheduled", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  it("returns pending wakes for both from and to session, excludes unrelated, excludes non-scheduled, includes recent expired, excludes ancient expired", async () => {
    const now = 100_000_000;
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => now });

    // Pending wake where ses_a is sender (from)
    storage.swarm.insert(
      {
        msgId: "m_from",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "wake",
        priority: "normal",
        replyTo: null,
        payload: "p1",
        deliverAt: now + 5000,
      },
      now - 1000,
    );

    // Pending wake where ses_a is receiver (to)
    storage.swarm.insert(
      {
        msgId: "m_to",
        fromSession: "ses_other",
        toSession: "ses_a",
        channel: null,
        kind: "wake",
        priority: "normal",
        replyTo: null,
        payload: "p2",
        deliverAt: now + 10000,
      },
      now - 1000,
    );

    // Unrelated session
    storage.swarm.insert(
      {
        msgId: "m_unrelated",
        fromSession: "ses_x",
        toSession: "ses_y",
        channel: null,
        kind: "wake",
        priority: "normal",
        replyTo: null,
        payload: "p3",
        deliverAt: now + 5000,
      },
      now - 1000,
    );

    // Ordinary non-scheduled message (deliverAt is null)
    storage.swarm.insert(
      {
        msgId: "m_nonsched",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "p4",
        deliverAt: null,
      },
      now - 1000,
    );

    // Recent expired row for ses_a (updated 1 hour ago <= 24h)
    storage.swarm.insert(
      {
        msgId: "m_recent_expired",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "wake",
        priority: "normal",
        replyTo: null,
        payload: "p5",
        deliverAt: now - 10000,
      },
      now - 20000,
    );
    storage.swarm.markExpired("m_recent_expired", now - 3600 * 1000);

    // Ancient expired row for ses_a (updated 25 hours ago > 24h)
    storage.swarm.insert(
      {
        msgId: "m_ancient_expired",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "wake",
        priority: "normal",
        replyTo: null,
        payload: "p6",
        deliverAt: now - 100000,
      },
      now - 200000,
    );
    storage.swarm.markExpired("m_ancient_expired", now - 25 * 3600 * 1000);

    const res = await app(new Request("http://localhost/swarm/scheduled?session=ses_a"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scheduled: Array<{
        msg_id: string;
        from: string;
        to: string | null;
        kind: string;
        priority: string;
        payload: string;
        state: string;
        deliver_at: number | null;
        expires_at: number | null;
        created_at: number;
      }>;
    };

    const ids = body.scheduled.map((m) => m.msg_id);
    expect(ids).toContain("m_from");
    expect(ids).toContain("m_to");
    expect(ids).toContain("m_recent_expired");
    expect(ids).not.toContain("m_unrelated");
    expect(ids).not.toContain("m_nonsched");
    expect(ids).not.toContain("m_ancient_expired");

    // Check entry fields mapping
    const mFrom = body.scheduled.find((m) => m.msg_id === "m_from");
    expect(mFrom).toEqual({
      msg_id: "m_from",
      from: "ses_a",
      to: "ses_b",
      kind: "wake",
      priority: "normal",
      payload: "p1",
      state: "queued",
      deliver_at: now + 5000,
      expires_at: null,
      created_at: now - 1000,
      ref: null,
    });
  });

  it("requires session query parameter", async () => {
    storage = openStorageDb(":memory:");
    const app = createApp(storage, { nowFn: () => 1_000 });

    const res = await app(new Request("http://localhost/swarm/scheduled"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("session is required");
  });
});

describe("POST /swarm/scheduled/:msg_id/cancel", () => {
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

  it("happy path -> 200, row cancelled and no longer ready", async () => {
    const { app, storage: s } = newApp(1_000);

    s.swarm.insert(
      {
        msgId: "msg_cancel_me",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "wake",
        priority: "normal",
        replyTo: null,
        payload: "wake",
        deliverAt: 5_000,
      },
      1_000,
    );

    const res = await app(
      new Request("http://localhost/swarm/scheduled/msg_cancel_me/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "ses_a" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { cancelled: boolean; msg_id: string };
    expect(body).toEqual({ cancelled: true, msg_id: "msg_cancel_me" });

    // Verify row state in db
    const record = s.swarm.getByMsgId("msg_cancel_me");
    expect(record!.state).toBe("cancelled");

    // Row is no longer ready at deliverAt
    expect(s.swarm.getReadyForTarget("ses_b", 5_000)).toHaveLength(0);
  });

  it("enqueues a cancellation notice (wc:) in outbox when a scheduled message is cancelled", async () => {
    const { app, storage: s } = newApp(1_000);

    const schedRes = await app(
      new Request("http://localhost/swarm/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msg_id: "msg_to_cancel_1",
          from: "ses_a",
          to: "ses_b",
          after: "1h",
          payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4",
        }),
      }),
    );
    expect(schedRes.status).toBe(202);

    expect(s.outbox.getByNotificationId("w:msg_to_cancel_1")).not.toBeNull();

    const cancelRes = await app(
      new Request("http://localhost/swarm/scheduled/msg_to_cancel_1/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "ses_a" }),
      }),
    );
    expect(cancelRes.status).toBe(200);

    const scheduleNotice = s.outbox.getByNotificationId("w:msg_to_cancel_1");
    const cancelNotice = s.outbox.getByNotificationId("wc:msg_to_cancel_1");

    expect(scheduleNotice).not.toBeNull();
    expect(scheduleNotice!.sessionId).toBe("ses_b");

    expect(cancelNotice).not.toBeNull();
    expect(cancelNotice!.sessionId).toBe("ses_b");
    expect(cancelNotice!.kind).toBe("swarm");
  });

  it("requires `from` in body", async () => {
    const { app } = newApp();

    const res = await app(
      new Request("http://localhost/swarm/scheduled/msg_1/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/from/);
  });

  it("m4: returns 404 when attempting to cancel an unscheduled message (deliverAt is null)", async () => {
    const { app, storage: s } = newApp();

    s.swarm.insert(
      {
        msgId: "msg_unscheduled",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "plain chat message",
        deliverAt: null,
      },
      1_000,
    );

    const res = await app(
      new Request("http://localhost/swarm/scheduled/msg_unscheduled/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "ses_a" }),
      }),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("scheduled message not found");
  });

  it("returns 403 when `from` does not match original sender", async () => {
    const { app, storage: s } = newApp();

    s.swarm.insert(
      {
        msgId: "msg_secret",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "wake",
        priority: "normal",
        replyTo: null,
        payload: "wake",
        deliverAt: 5_000,
      },
      1_000,
    );

    const res = await app(
      new Request("http://localhost/swarm/scheduled/msg_secret/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "ses_imposter" }),
      }),
    );

    expect(res.status).toBe(403);
  });

  it("returns 404 for unknown msg_id", async () => {
    const { app } = newApp();

    const res = await app(
      new Request("http://localhost/swarm/scheduled/msg_nonexistent/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "ses_a" }),
      }),
    );

    expect(res.status).toBe(404);
  });

  it("returns 409 reporting current state when message is already handed_off / expired / cancelled", async () => {
    const { app, storage: s } = newApp();

    s.swarm.insert(
      {
        msgId: "msg_already_delivered",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "wake",
        priority: "normal",
        replyTo: null,
        payload: "wake",
        deliverAt: 5_000,
      },
      1_000,
    );
    s.swarm.markHandedOff("msg_already_delivered", 2_000);

    const res = await app(
      new Request("http://localhost/swarm/scheduled/msg_already_delivered/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "ses_a" }),
      }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; state: string };
    expect(body.state).toBe("handed_off");
    expect(body.error).toBeTruthy();
  });

  describe("E2: scheduler running guard", () => {
    it("6. POST /swarm/schedule with isSchedulerRunning: () => false -> 503, and assert NOTHING was persisted", async () => {
      const storage = openStorageDb(":memory:");
      const app = createApp(storage, {
        nowFn: () => 1_000_000,
        isSchedulerRunning: () => false,
      });

      const res = await app(
        new Request("http://localhost/swarm/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            msg_id: "msg_blocked_sched",
            from: "ses_a",
            to: "ses_b",
            after: "1h",
            payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4",
          }),
        }),
      );

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/scheduler is not running/i);

      // Assert NOTHING was persisted
      const stored = storage.swarm.getByMsgId("msg_blocked_sched");
      expect(stored).toBeNull();
      const count = storage.db
        .prepare("SELECT COUNT(*) AS n FROM swarm_messages")
        .get() as { n: number };
      expect(count.n).toBe(0);

      storage.db.close();
    });

    it("7. POST /swarm/schedule with isSchedulerRunning: () => true -> 202 accepted", async () => {
      const storage = openStorageDb(":memory:");
      const app = createApp(storage, {
        nowFn: () => 1_000_000,
        isSchedulerRunning: () => true,
      });

      const res = await app(
        new Request("http://localhost/swarm/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            msg_id: "msg_running_sched",
            from: "ses_a",
            to: "ses_b",
            after: "1h",
            payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4",
          }),
        }),
      );

      expect(res.status).toBe(202);
      const stored = storage.swarm.getByMsgId("msg_running_sched");
      expect(stored).not.toBeNull();

      storage.db.close();
    });

    it("8. POST /swarm/schedule with option omitted -> unchanged current behavior (202 accepted)", async () => {
      const storage = openStorageDb(":memory:");
      const app = createApp(storage, {
        nowFn: () => 1_000_000,
      });

      const res = await app(
        new Request("http://localhost/swarm/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            msg_id: "msg_omitted_sched",
            from: "ses_a",
            to: "ses_b",
            after: "1h",
            payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4",
          }),
        }),
      );

      expect(res.status).toBe(202);
      const stored = storage.swarm.getByMsgId("msg_omitted_sched");
      expect(stored).not.toBeNull();

      storage.db.close();
    });

    it("9. POST /swarm/send still 202s when isSchedulerRunning: () => false (proves scope containment)", async () => {
      const storage = openStorageDb(":memory:");
      const app = createApp(storage, {
        nowFn: () => 1_000_000,
        isSchedulerRunning: () => false,
      });

      const res = await app(
        new Request("http://localhost/swarm/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            msg_id: "msg_send_scope",
            from: "ses_a",
            to: "ses_b",
            kind: "chat",
            payload: "regular chat",
          }),
        }),
      );

      expect(res.status).toBe(202);
      const stored = storage.swarm.getByMsgId("msg_send_scope");
      expect(stored).not.toBeNull();

      storage.db.close();
    });
  });

  describe("W4: ref column and minimum payload guard", () => {
    let storage: StorageDb | null = null;

    afterEach(() => {
      if (storage) {
        storage.db.close();
        storage = null;
      }
    });

    function newApp(now = 1_000_000) {
      storage = openStorageDb(":memory:");
      return { app: createApp(storage, { nowFn: () => now }), storage };
    }

    it("ref round-trips: schedule with ref -> stored -> returned by GET /swarm/scheduled -> rendered in envelope", async () => {
      const { app, storage: s } = newApp(1_000_000);
      const validPayload = "Resume pigeon-c68: run bd show pigeon-c68, then continue W4";

      const res = await app(
        new Request("http://localhost/swarm/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "ses_a",
            to: "ses_b",
            after: "1h",
            ref: "pigeon-c68",
            payload: validPayload,
          }),
        }),
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as { msg_id: string };

      const stored = s.swarm.getByMsgId(body.msg_id);
      expect(stored).not.toBeNull();
      expect(stored!.ref).toBe("pigeon-c68");

      const getRes = await app(new Request("http://localhost/swarm/scheduled?session=ses_a"));
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as {
        scheduled: Array<{ msg_id: string; ref: string | null }>;
      };
      const row = getBody.scheduled.find((m) => m.msg_id === body.msg_id);
      expect(row).toBeDefined();
      expect(row!.ref).toBe("pigeon-c68");

      let promptSent = "";
      const arbiter = new SwarmArbiter({
        storage: s,
        clientForSession: () =>
          ({
            sendPrompt: async (_session: string, _dir: string, prompt: string) => {
              promptSent = prompt;
            },
          }) as any,
        directoryForSession: async () => "/dir/ses_b",
        // Fictional directory; see note in swarm-routes.integration.test.ts.
        directoryMissing: () => false,
        nowFn: () => 1_000_000 + 3600 * 1000 + 1,
        log: () => {},
      });

      await arbiter.processOnce();
      expect(promptSent).toContain('ref="pigeon-c68"');
    });

    it("ref omitted -> column NULL -> returned as null -> NO ref attr in envelope", async () => {
      const { app, storage: s } = newApp(1_000_000);
      const validPayload = "Resume pigeon-c68: run bd show pigeon-c68, then continue W4";

      const res = await app(
        new Request("http://localhost/swarm/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "ses_a",
            to: "ses_b",
            after: "1h",
            payload: validPayload,
          }),
        }),
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as { msg_id: string };

      const stored = s.swarm.getByMsgId(body.msg_id);
      expect(stored).not.toBeNull();
      expect(stored!.ref).toBeNull();

      const getRes = await app(new Request("http://localhost/swarm/scheduled?session=ses_a"));
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as {
        scheduled: Array<{ msg_id: string; ref: string | null }>;
      };
      const row = getBody.scheduled.find((m) => m.msg_id === body.msg_id);
      expect(row).toBeDefined();
      expect(row!.ref).toBeNull();

      let promptSent = "";
      const arbiter = new SwarmArbiter({
        storage: s,
        clientForSession: () =>
          ({
            sendPrompt: async (_session: string, _dir: string, prompt: string) => {
              promptSent = prompt;
            },
          }) as any,
        directoryForSession: async () => "/dir/ses_b",
        // Fictional directory; see note in swarm-routes.integration.test.ts.
        directoryMissing: () => false,
        nowFn: () => 1_000_000 + 3600 * 1000 + 1,
        log: () => {},
      });

      await arbiter.processOnce();
      expect(promptSent).not.toContain("ref=");
    });

    it("ref over 200 chars -> 400 error", async () => {
      const { app } = newApp(1_000_000);
      const longRef = "x".repeat(201);
      const validPayload = "Resume pigeon-c68: run bd show pigeon-c68, then continue W4";

      const res = await app(
        new Request("http://localhost/swarm/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "ses_a",
            to: "ses_b",
            after: "1h",
            ref: longRef,
            payload: validPayload,
          }),
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("ref exceeds maximum length of 200 characters");
    });

    it("payload of 39 chars -> 400 with teaching error; 40 chars -> 202 accepted", async () => {
      const { app } = newApp(1_000_000);
      const p39 = "a".repeat(39);
      const p40 = "a".repeat(40);

      const res39 = await app(
        new Request("http://localhost/swarm/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "ses_a",
            to: "ses_b",
            after: "1h",
            payload: p39,
          }),
        }),
      );
      expect(res39.status).toBe(400);
      const body39 = (await res39.json()) as { error: string };
      expect(body39.error).toContain("scheduled wake payload is too short (39 chars, minimum 40)");
      expect(body39.error).toContain("a wake must be self-contained");
      expect(body39.error).toContain("Example:");

      const res40 = await app(
        new Request("http://localhost/swarm/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "ses_a",
            to: "ses_b",
            after: "1h",
            payload: p40,
          }),
        }),
      );
      expect(res40.status).toBe(202);
    });

    it("empty payload returns pre-existing 'payload is required' error", async () => {
      const { app } = newApp(1_000_000);

      const res = await app(
        new Request("http://localhost/swarm/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "ses_a",
            to: "ses_b",
            after: "1h",
            payload: "",
          }),
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("payload is required");
    });

    it("ref of non-string type (e.g. number 123) -> 400 error", async () => {
      const { app } = newApp(1_000_000);
      const validPayload = "Resume pigeon-c68: run bd show pigeon-c68, then continue W4";

      const res = await app(
        new Request("http://localhost/swarm/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "ses_a",
            to: "ses_b",
            after: "1h",
            ref: 123,
            payload: validPayload,
          }),
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("ref must be a string");
    });

    it("ref containing control characters (newline, tab) -> 400 error", async () => {
      const { app } = newApp(1_000_000);
      const validPayload = "Resume pigeon-c68: run bd show pigeon-c68, then continue W4";

      for (const ctrlChar of ["\n", "\r", "\t"]) {
        const res = await app(
          new Request("http://localhost/swarm/schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "ses_a",
              to: "ses_b",
              after: "1h",
              ref: `bad${ctrlChar}ref`,
              payload: validPayload,
            }),
          }),
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("control characters");
      }
    });

    it("terse payload on POST /swarm/send is still accepted with 202", async () => {
      const { app } = newApp(1_000_000);

      const res = await app(
        new Request("http://localhost/swarm/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "ses_a",
            to: "ses_b",
            kind: "chat",
            payload: "hi",
          }),
        }),
      );
      expect(res.status).toBe(202);
    });
  });
});
