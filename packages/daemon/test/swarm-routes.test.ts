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
          payload: "wake up!",
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
    expect(body.expires_at).toBeNull();

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
          payload: "wake up!",
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

  it("maps `expires_in` to `expires_at`, or `expires_at: null` when absent", async () => {
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
          payload: "wake",
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
          payload: "wake",
        }),
      }),
    );
    expect(res2.status).toBe(202);
    const body2 = (await res2.json()) as { expires_at: number | null };
    expect(body2.expires_at).toBeNull();
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
          payload: "wake",
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
          payload: "wake",
        }),
      }),
    );
    const b2 = (await res2.json()) as { msg_id: string };
    expect(s.swarm.getByMsgId(b2.msg_id)!.kind).toBe("custom_wake");
  });

  it("honors `msg_id` idempotency: same `msg_id` twice does not create a duplicate row", async () => {
    const { app, storage: s } = newApp();

    for (let i = 0; i < 2; i++) {
      const res = await app(
        new Request("http://localhost/swarm/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            msg_id: "msg_scheduled_dup",
            from: "ses_a",
            to: "ses_b",
            after: "1h",
            payload: i === 0 ? "first" : "second",
          }),
        }),
      );
      expect(res.status).toBe(202);
    }

    const stored = s.swarm.getByMsgId("msg_scheduled_dup");
    expect(stored!.payload).toBe("first");
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
});
