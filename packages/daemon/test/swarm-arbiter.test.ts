import { afterEach, describe, expect, it, vi } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { SwarmArbiter } from "../src/swarm/arbiter";
import { PermanentDeliveryError } from "../src/swarm/envelope";
import { TransportError } from "../src/opencode-client";
import { RequestTimeoutError } from "../src/routing/serve-outcome";

interface DeliveryCall {
  sessionId: string;
  directory: string;
  prompt: string;
  startedAt: number;
  finishedAt?: number;
}

function makeFixture(opts?: {
  clientForSession?: (sessionId: string) => any;
  directoryForSession?: (sessionId: string) => Promise<string | undefined>;
  directoryMissing?: (dir: string) => boolean;
}) {
  const storage: StorageDb = openStorageDb(":memory:");
  const calls: DeliveryCall[] = [];
  let now = 1_000;
  let inFlightDelay = 0;
  let throwError: Error | null = null;
  let throwOnce: Error | null = null;

  const defaultOpencodeClient = {
    sendPrompt: vi.fn(
      async (sessionId: string, directory: string, prompt: string) => {
        const rec: DeliveryCall = {
          sessionId,
          directory,
          prompt,
          startedAt: Date.now(),
        };
        calls.push(rec);
        if (throwError) {
          throw throwError;
        }
        if (throwOnce) {
          const e = throwOnce;
          throwOnce = null;
          throw e;
        }
        if (inFlightDelay > 0) {
          await new Promise((r) => setTimeout(r, inFlightDelay));
        }
        rec.finishedAt = Date.now();
      },
    ),
  };

  let clientFn = opts?.clientForSession ?? ((_sessionId: string) => defaultOpencodeClient as any);
  let dirFn = opts?.directoryForSession ?? (async (sessionId: string) => `/dir/${sessionId}`);

  // The fixture's directories (`/dir/ses_x`) are fictional, so the REAL default
  // predicate would report every one of them missing and refuse every delivery
  // in this file. Inject a stub that reports "present" by default; tests that
  // care about the preflight opt in via setDirectoryMissing.
  //
  // Consequence worth stating: no test in THIS file exercises the real
  // statSync-based predicate. Its errno discrimination is covered separately in
  // swarm-directory-check.test.ts, and the two must be read together.
  let dirMissingFn = opts?.directoryMissing ?? ((_dir: string) => false);

  const registry = {
    resolve: vi.fn(async (sessionId: string) => `/dir/${sessionId}`),
  };

  const arbiter = new SwarmArbiter({
    storage,
    clientForSession: (sessionId: string) => clientFn(sessionId),
    directoryForSession: (sessionId: string) => dirFn(sessionId),
    directoryMissing: (dir: string) => dirMissingFn(dir),
    nowFn: () => now,
    log: () => {},
  });

  return {
    storage,
    arbiter,
    opencodeClient: defaultOpencodeClient,
    registry,
    calls,
    setClientForSession(fn: (sessionId: string) => any) {
      clientFn = fn;
    },
    setDirectoryForSession(fn: (sessionId: string) => Promise<string | undefined>) {
      dirFn = fn;
    },
    setDirectoryMissing(fn: (dir: string) => boolean) {
      dirMissingFn = fn;
    },
    setNow(v: number) {
      now = v;
    },
    setInFlightDelay(v: number) {
      inFlightDelay = v;
    },
    setThrowOnce(e: Error) {
      throwOnce = e;
    },
    setThrowError(e: Error | null) {
      throwError = e;
    },
  };
}

describe("SwarmArbiter", () => {
  let fixture: ReturnType<typeof makeFixture> | null = null;

  afterEach(() => {
    fixture?.arbiter.stop();
    fixture?.storage.db.close();
    fixture = null;
  });

  it("delivers a single queued message and marks it handed_off", async () => {
    fixture = makeFixture();
    const { storage, arbiter, calls } = fixture;

    storage.swarm.insert(
      {
        msgId: "m1",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "hi",
      },
      1_000,
    );

    await arbiter.processOnce();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sessionId).toBe("ses_b");
    expect(calls[0]!.directory).toBe("/dir/ses_b");
    expect(calls[0]!.prompt).toContain("<swarm_message");
    expect(calls[0]!.prompt).toContain("hi");

    expect(storage.swarm.getByMsgId("m1")!.state).toBe("handed_off");
  });

  it("serializes deliveries per target — never two in flight at once", async () => {
    fixture = makeFixture();
    const { storage, arbiter, calls } = fixture;

    fixture.setInFlightDelay(20);
    for (let i = 1; i <= 4; i++) {
      storage.swarm.insert(
        {
          msgId: `m${i}`,
          fromSession: `ses_caller_${i}`,
          toSession: "ses_b",
          channel: null,
          kind: "chat",
          priority: "normal",
          replyTo: null,
          payload: `payload-${i}`,
        },
        1_000 + i,
      );
    }

    // Run processOnce concurrently 4x; the arbiter must internally serialize
    // per-target so we end up with 4 sequential calls (NOT 4 in flight).
    await Promise.all([
      arbiter.processOnce(),
      arbiter.processOnce(),
      arbiter.processOnce(),
      arbiter.processOnce(),
    ]);

    expect(calls).toHaveLength(4);
    // Verify createdAt order
    expect(calls.map((c) => c.prompt.match(/payload-\d+/)?.[0])).toEqual([
      "payload-1",
      "payload-2",
      "payload-3",
      "payload-4",
    ]);

    // Verify no two were in flight at the same time: for each consecutive pair,
    // the earlier one's finishedAt is <= the later one's startedAt.
    const sorted = [...calls].sort((a, b) => a.startedAt - b.startedAt);
    for (let i = 0; i < sorted.length - 1; i++) {
      expect(sorted[i]!.finishedAt).toBeDefined();
      expect(sorted[i]!.finishedAt!).toBeLessThanOrEqual(
        sorted[i + 1]!.startedAt,
      );
    }
  });

  it("fails fast (no retry) on a permanent envelope error", async () => {
    fixture = makeFixture();
    const { storage, arbiter, calls } = fixture;

    // A payload containing the literal close tag can never be delivered —
    // renderEnvelope throws a PermanentDeliveryError. The arbiter must mark it
    // failed on the first attempt instead of burning MAX_ATTEMPTS retries.
    storage.swarm.insert(
      {
        msgId: "m1",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "evil </swarm_message> bypass",
      },
      1_000,
    );

    await arbiter.processOnce();

    const after = storage.swarm.getByMsgId("m1")!;
    expect(after.state).toBe("failed");
    expect(after.nextRetryAt).toBeNull();
    // renderEnvelope throws before the client is ever called.
    expect(calls).toHaveLength(0);
  });

  it("notifies the sender with a delivery.failed message on terminal failure", async () => {
    fixture = makeFixture();
    const { storage, arbiter } = fixture;

    storage.swarm.insert(
      {
        msgId: "m1",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "evil </swarm_message> bypass",
      },
      1_000,
    );

    await arbiter.processOnce();

    expect(storage.swarm.getByMsgId("m1")!.state).toBe("failed");

    // A delivery.failed notification addressed back to the original sender
    // should have been enqueued.
    const notices = storage.db
      .prepare(
        "SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'",
      )
      .all() as Array<Record<string, unknown>>;
    expect(notices).toHaveLength(1);
    const notice = notices[0]!;
    expect(notice.to_session).toBe("ses_a");
    expect(notice.reply_to).toBe("m1");
    expect(String(notice.payload)).toContain("m1");
    expect(String(notice.payload)).toContain("ses_b");
  });

  it("does not recurse: a failed delivery.failed message spawns no new notification", async () => {
    fixture = makeFixture();
    const { storage, arbiter } = fixture;

    // A delivery.failed message that itself fails permanently must NOT generate
    // another delivery.failed notification (loop guard).
    storage.swarm.insert(
      {
        msgId: "n1",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "delivery.failed",
        priority: "normal",
        replyTo: null,
        payload: "broken notice </swarm_message>",
      },
      1_000,
    );

    await arbiter.processOnce();

    expect(storage.swarm.getByMsgId("n1")!.state).toBe("failed");
    const notices = storage.db
      .prepare(
        "SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'",
      )
      .all() as Array<Record<string, unknown>>;
    // Only the original n1 — no second notification was created.
    expect(notices).toHaveLength(1);
    expect(notices[0]!.msg_id).toBe("n1");
  });

  it("retries on opencode 5xx with backoff", async () => {
    fixture = makeFixture();
    const { storage, arbiter } = fixture;

    storage.swarm.insert(
      {
        msgId: "m1",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "hi",
      },
      1_000,
    );

    fixture.setThrowOnce(new Error("sendPrompt failed: 500"));
    await arbiter.processOnce();

    const after = storage.swarm.getByMsgId("m1")!;
    expect(after.state).toBe("queued");
    expect(after.attempts).toBe(1);
    expect(after.nextRetryAt).not.toBeNull();
  });

  it("M1: promotes mid-flight cancelled row to handed_off while preserving cancelled_at so getInbox sees delivered message", async () => {
    fixture = makeFixture();
    const { storage, arbiter, opencodeClient } = fixture;

    storage.swarm.insert(
      {
        msgId: "m_midflight",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "wake up",
      },
      1_000,
    );

    // Cancel lands mid-flight while sendPrompt is executing
    opencodeClient.sendPrompt.mockImplementationOnce(async () => {
      storage.swarm.markCancelled("m_midflight", 1_500);
    });

    await arbiter.processOnce();

    const record = storage.swarm.getByMsgId("m_midflight")!;
    expect(record.state).toBe("handed_off");
    expect(record.cancelledAt).toBe(1_500);

    const inbox = storage.swarm.getInbox("ses_b");
    expect(inbox.messages.map((m) => m.msgId)).toContain("m_midflight");
  });

  it("1. A wake whose target has no healthy serve for 20 simulated minutes still delivers when the serve returns — attempts not burned", async () => {
    fixture = makeFixture();
    const { storage, arbiter, opencodeClient, calls } = fixture;
    let now = 1_000;
    fixture.setNow(now);

    // Target has no healthy serve initially
    fixture.setClientForSession(() => undefined);

    storage.swarm.insert({
      msgId: "m_wake1",
      fromSession: "ses_a",
      toSession: "ses_b",
      channel: null,
      kind: "wake.check",
      priority: "normal",
      replyTo: null,
      payload: "wake up",
      deliverAt: now,
      expiresAt: now + 6 * 3600 * 1000,
    }, now);

    // Simulate 20 minutes (40 ticks of 30s)
    for (let i = 0; i < 40; i++) {
      await arbiter.processOnce();
      now += 30_000;
      fixture.setNow(now);

      const state = storage.swarm.getByMsgId("m_wake1")!;
      expect(state.attempts).toBe(0); // attempts not burned!
      expect(state.state).toBe("queued");
    }

    expect(calls).toHaveLength(0);

    // Serve returns
    fixture.setClientForSession(() => opencodeClient as any);

    await arbiter.processOnce();

    expect(calls).toHaveLength(1);
    const finalState = storage.swarm.getByMsgId("m_wake1")!;
    expect(finalState.state).toBe("handed_off");
    expect(finalState.attempts).toBe(0);
  });

  it("2. A wake facing mid-request ECONNREFUSED from sendPrompt for 20 simulated minutes still delivers when serve returns — attempts not burned", async () => {
    fixture = makeFixture();
    const { storage, arbiter, opencodeClient, calls } = fixture;
    let now = 1_000;
    fixture.setNow(now);

    const transportErr = new TransportError(
      Object.assign(new Error("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      }),
    );

    fixture.setThrowError(transportErr);

    storage.swarm.insert({
      msgId: "m_wake2",
      fromSession: "ses_a",
      toSession: "ses_b",
      channel: null,
      kind: "wake.check",
      priority: "normal",
      replyTo: null,
      payload: "wake up",
      deliverAt: now,
      expiresAt: now + 6 * 3600 * 1000,
    }, now);

    // Simulate 20 minutes (40 ticks of 30s)
    for (let i = 0; i < 40; i++) {
      await arbiter.processOnce();
      now += 30_000;
      fixture.setNow(now);

      const state = storage.swarm.getByMsgId("m_wake2")!;
      expect(state.attempts).toBe(0); // attempts not burned!
      expect(state.state).toBe("queued");
    }

    // Serve returns to normal
    fixture.setThrowError(null);

    await arbiter.processOnce();

    expect(calls.length).toBeGreaterThan(0);
    const finalState = storage.swarm.getByMsgId("m_wake2")!;
    expect(finalState.state).toBe("handed_off");
    expect(finalState.attempts).toBe(0);
  });

  it("3. A wake past expires_at does not deliver, ends in state expired, and produces a sender notification", async () => {
    fixture = makeFixture();
    const { storage, arbiter, calls } = fixture;
    const now = 1_000;
    fixture.setNow(now);

    storage.swarm.insert({
      msgId: "m_expired",
      fromSession: "ses_a",
      toSession: "ses_b",
      channel: null,
      kind: "wake.check",
      priority: "normal",
      replyTo: null,
      payload: "wake up",
      deliverAt: now,
      expiresAt: now + 5_000,
    }, now);

    // Advance past expiresAt
    fixture.setNow(now + 10_000);

    await arbiter.processOnce();

    // ses_b received NO calls
    const targetCalls = calls.filter((c) => c.sessionId === "ses_b");
    expect(targetCalls).toHaveLength(0);

    const state = storage.swarm.getByMsgId("m_expired")!;
    expect(state.state).toBe("expired");

    // Sender notification
    const notices = storage.db
      .prepare("SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'")
      .all() as Array<Record<string, unknown>>;
    expect(notices).toHaveLength(1);
    expect(notices[0]!.to_session).toBe("ses_a");
    expect(notices[0]!.reply_to).toBe("m_expired");
    expect(String(notices[0]!.payload)).toContain("expired before delivery");
  });

  it("4. Positive control: an ORDINARY (non-scheduled, expires_at IS NULL) message to a dead target still terminal-fails after MAX_ATTEMPTS", async () => {
    fixture = makeFixture();
    const { storage, arbiter } = fixture;
    let now = 1_000;
    fixture.setNow(now);

    // Target has no healthy serve
    fixture.setClientForSession(() => undefined);

    storage.swarm.insert({
      msgId: "m_ordinary",
      fromSession: "ses_a",
      toSession: "ses_b",
      channel: null,
      kind: "chat",
      priority: "normal",
      replyTo: null,
      payload: "ordinary message",
      deliverAt: null,
      expiresAt: null, // NO expiresAt!
    }, now);

    // Run arbiter across retries until MAX_ATTEMPTS (10)
    for (let i = 0; i < 15; i++) {
      await arbiter.processOnce();
      now += 60_000;
      fixture.setNow(now);
    }

    const state = storage.swarm.getByMsgId("m_ordinary")!;
    expect(state.state).toBe("failed");

    // Sender notification produced
    const notices = storage.db
      .prepare("SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'")
      .all() as Array<Record<string, unknown>>;
    expect(notices).toHaveLength(1);
  });

  it("5. A timeout DOES burn budget (pins the non-idempotency decision)", async () => {
    fixture = makeFixture();
    const { storage, arbiter } = fixture;
    const now = 1_000;
    fixture.setNow(now);

    storage.swarm.insert({
      msgId: "m_timeout",
      fromSession: "ses_a",
      toSession: "ses_b",
      channel: null,
      kind: "wake.check",
      priority: "normal",
      replyTo: null,
      payload: "wake up",
      deliverAt: now,
      expiresAt: now + 6 * 3600 * 1000,
    }, now);

    fixture.setThrowOnce(new RequestTimeoutError(30_000, "http://localhost:4096/session/ses_b/prompt_async"));

    await arbiter.processOnce();

    const state = storage.swarm.getByMsgId("m_timeout")!;
    expect(state.attempts).toBe(1); // attempts WAS burned!
    expect(state.state).toBe("queued");
  });

  it("6. An expired row does not wedge the queue: a newer, non-expired message to the same target still delivers", async () => {
    fixture = makeFixture();
    const { storage, arbiter, calls } = fixture;
    const now = 10_000;
    fixture.setNow(now);

    // Older expired message
    storage.swarm.insert({
      msgId: "m_old_expired",
      fromSession: "ses_a",
      toSession: "ses_b",
      channel: null,
      kind: "wake.check",
      priority: "normal",
      replyTo: null,
      payload: "old wake",
      deliverAt: 1_000,
      expiresAt: 2_000, // expired at now=10_000
    }, 1_000);

    // Newer valid message
    storage.swarm.insert({
      msgId: "m_fresh",
      fromSession: "ses_a",
      toSession: "ses_b",
      channel: null,
      kind: "wake.check",
      priority: "normal",
      replyTo: null,
      payload: "fresh wake",
      deliverAt: 5_000,
      expiresAt: 20_000, // valid
    }, 2_000);

    await arbiter.processOnce();

    expect(storage.swarm.getByMsgId("m_old_expired")!.state).toBe("expired");
    expect(storage.swarm.getByMsgId("m_fresh")!.state).toBe("handed_off");

    const targetCalls = calls.filter((c) => c.sessionId === "ses_b");
    expect(targetCalls).toHaveLength(1);
    expect(targetCalls[0]!.prompt).toContain("fresh wake");
  });

  it("7. Cancel racing an uncounted retry: cancelled row is not resurrected", async () => {
    fixture = makeFixture();
    const { storage, arbiter } = fixture;
    let now = 1_000;
    fixture.setNow(now);

    // Target unavailable
    fixture.setClientForSession(() => undefined);

    storage.swarm.insert({
      msgId: "m_cancel_race",
      fromSession: "ses_a",
      toSession: "ses_b",
      channel: null,
      kind: "wake.check",
      priority: "normal",
      replyTo: null,
      payload: "wake up",
      deliverAt: now,
      expiresAt: now + 6 * 3600 * 1000,
    }, now);

    // First processOnce triggers uncounted retry
    await arbiter.processOnce();
    expect(storage.swarm.getByMsgId("m_cancel_race")!.state).toBe("queued");

    // Cancel lands
    now += 500;
    fixture.setNow(now);
    storage.swarm.markCancelled("m_cancel_race", now);
    expect(storage.swarm.getByMsgId("m_cancel_race")!.state).toBe("cancelled");

    // Next tick when retry fires
    now += 30_000;
    fixture.setNow(now);
    await arbiter.processOnce();

    // Must stay cancelled, NOT resurrected to queued
    expect(storage.swarm.getByMsgId("m_cancel_race")!.state).toBe("cancelled");
  });

  it("populates scheduledFor and deliveredLateMs for scheduled messages", async () => {
    fixture = makeFixture();
    const { storage, arbiter, calls } = fixture;

    const deliverAt = 10_000;
    const now = 15_000;
    fixture.setNow(now);

    storage.swarm.insert(
      {
        msgId: "m_sched_1",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "wake.scheduled",
        priority: "normal",
        replyTo: null,
        payload: "hello scheduled",
        deliverAt,
      },
      now,
    );

    await arbiter.processOnce();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain('scheduled_for="1970-01-01T00:00:10.000Z"');
    expect(calls[0]!.prompt).toContain('delivered_late_ms="5000"');
  });

  it("renders delivered_late_ms as 0 when delivered on time or early", async () => {
    fixture = makeFixture();
    const { storage, arbiter, calls } = fixture;

    const deliverAt = 10_000;
    const now = 10_000; // on time
    fixture.setNow(now);

    storage.swarm.insert(
      {
        msgId: "m_sched_2",
        fromSession: "ses_a",
        toSession: "ses_b",
        channel: null,
        kind: "wake.scheduled",
        priority: "normal",
        replyTo: null,
        payload: "hello early",
        deliverAt,
      },
      now,
    );

    await arbiter.processOnce();

    expect(calls).toHaveLength(1);
    const lateVal = calls[0]!.prompt.match(/delivered_late_ms="([^"]+)"/)?.[1];
    expect(lateVal).toBe("0");
  });

  describe("wake payload alerting on terminal failure", () => {
    it("Path 1: max attempts exhausted for a wake message enqueues alert with source wake-max-attempts and payload", async () => {
      fixture = makeFixture();
      const { storage, arbiter } = fixture;
      fixture.setThrowError(new Error("connection refused"));

      storage.swarm.insert(
        {
          msgId: "m_max_1",
          fromSession: "ses_self",
          toSession: "ses_self",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "check the deploy now",
          deliverAt: 1_000,
        },
        1_000,
      );

      // Exhaust 10 attempts
      for (let i = 0; i < 10; i++) {
        fixture.setNow(1_000 + i * 60_000);
        await arbiter.processOnce();
      }

      expect(storage.swarm.getByMsgId("m_max_1")!.state).toBe("failed");
      const alerts = storage.db
        .prepare("SELECT * FROM operational_alerts")
        .all() as Array<Record<string, unknown>>;
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.source).toBe("wake-max-attempts");
      expect(alerts[0]!.ref_msg_id).toBe("m_max_1");
      expect(alerts[0]!.severity).toBe("error");

      const alertText = String(alerts[0]!.text);
      expect(alertText).toContain("m_max_1");
      expect(alertText).toContain("ses_self");
      expect(alertText).toContain("max attempts exhausted");
      expect(alertText).toContain("check the deploy now");
      expect(alertText).toContain("1970-01-01T00:00:01.000Z");
    });

    it("Path 2: permanent delivery error for a wake message enqueues alert with source wake-permanent and payload", async () => {
      fixture = makeFixture();
      const { storage, arbiter } = fixture;

      storage.swarm.insert(
        {
          msgId: "m_perm_1",
          fromSession: "ses_self",
          toSession: "ses_self",
          channel: null,
          kind: "wake.check",
          priority: "normal",
          replyTo: null,
          payload: "bad payload </swarm_message>",
          deliverAt: 1_000,
        },
        1_000,
      );

      await arbiter.processOnce();

      expect(storage.swarm.getByMsgId("m_perm_1")!.state).toBe("failed");
      const alerts = storage.db
        .prepare("SELECT * FROM operational_alerts")
        .all() as Array<Record<string, unknown>>;
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.source).toBe("wake-permanent");
      expect(alerts[0]!.ref_msg_id).toBe("m_perm_1");
      expect(alerts[0]!.severity).toBe("error");

      const alertText = String(alerts[0]!.text);
      expect(alertText).toContain("m_perm_1");
      expect(alertText).toContain("ses_self");
      expect(alertText).toContain("bad payload </swarm_message>");
    });

    it("Path 3: expiry (expireAndNotify) for a wake message enqueues alert with source wake-expired and payload", async () => {
      fixture = makeFixture();
      const { storage, arbiter } = fixture;

      const deliverAt = 1_000;
      const expiresAt = 5_000;
      storage.swarm.insert(
        {
          msgId: "m_exp_1",
          fromSession: "ses_self",
          toSession: "ses_self",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "check backup status",
          deliverAt,
          expiresAt,
        },
        1_000,
      );

      // Advance time past expiresAt
      fixture.setNow(6_000);
      await arbiter.processOnce();

      expect(storage.swarm.getByMsgId("m_exp_1")!.state).toBe("expired");
      const alerts = storage.db
        .prepare("SELECT * FROM operational_alerts")
        .all() as Array<Record<string, unknown>>;
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.source).toBe("wake-expired");
      expect(alerts[0]!.ref_msg_id).toBe("m_exp_1");
      expect(alerts[0]!.severity).toBe("error");

      const alertText = String(alerts[0]!.text);
      expect(alertText).toContain("m_exp_1");
      expect(alertText).toContain("ses_self");
      expect(alertText).toContain("check backup status");
      expect(alertText).toContain("expired before delivery");
    });

    it("cancel race: if wake is cancelled mid-flight, permanent failure produces ZERO alert rows and ZERO failure notifications", async () => {
      fixture = makeFixture();
      const { storage, arbiter } = fixture;

      storage.swarm.insert(
        {
          msgId: "m_cancel_race",
          fromSession: "ses_self",
          toSession: "ses_self",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "normal wake payload",
          deliverAt: 1_000,
        },
        1_000,
      );

      // Send prompt will throw PermanentDeliveryError, but simulate user cancelling mid-flight
      fixture.opencodeClient.sendPrompt.mockImplementationOnce(async () => {
        storage.swarm.markCancelled("m_cancel_race", 1_500);
        throw new PermanentDeliveryError("invalid tag");
      });

      await arbiter.processOnce();

      // Row should be cancelled, NOT failed
      expect(storage.swarm.getByMsgId("m_cancel_race")!.state).toBe("cancelled");

      // Assert ZERO alerts enqueued
      const alerts = storage.db
        .prepare("SELECT * FROM operational_alerts")
        .all();
      expect(alerts).toHaveLength(0);

      // Assert ZERO delivery.failed notifications sent
      const notifications = storage.db
        .prepare("SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'")
        .all();
      expect(notifications).toHaveLength(0);
    });

    it("cancel race: if wake is cancelled mid-flight on 10th attempt, max attempts produces ZERO alert rows and ZERO failure notifications", async () => {
      fixture = makeFixture();
      const { storage, arbiter } = fixture;

      storage.swarm.insert(
        {
          msgId: "m_cancel_race_max",
          fromSession: "ses_self",
          toSession: "ses_self",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "scheduled wake payload",
          deliverAt: 1_000,
        },
        1_000,
      );

      // Exhaust 9 attempts
      for (let i = 0; i < 9; i++) {
        fixture.setThrowOnce(new Error("transient error"));
        fixture.setNow(1_000 + i * 60_000);
        await arbiter.processOnce();
      }

      // 10th attempt fails, but user cancels mid-flight
      fixture.setNow(1_000 + 9 * 60_000);
      fixture.opencodeClient.sendPrompt.mockImplementationOnce(async () => {
        storage.swarm.markCancelled("m_cancel_race_max", 1_000 + 9 * 60_000);
        throw new Error("transient error on 10th try");
      });

      await arbiter.processOnce();

      expect(storage.swarm.getByMsgId("m_cancel_race_max")!.state).toBe("cancelled");

      const alerts = storage.db
        .prepare("SELECT * FROM operational_alerts")
        .all();
      expect(alerts).toHaveLength(0);

      const notifications = storage.db
        .prepare("SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'")
        .all();
      expect(notifications).toHaveLength(0);
    });

    it("sweepExpired continues processing remaining expired rows when one row throws an error", async () => {
      fixture = makeFixture();
      const { storage, arbiter } = fixture;

      const deliverAt = 1_000;
      const expiresAt = 5_000;
      storage.swarm.insert(
        {
          msgId: "m_exp_throw",
          fromSession: "ses_self",
          toSession: "ses_self",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "payload 1",
          deliverAt,
          expiresAt,
        },
        1_000,
      );
      storage.swarm.insert(
        {
          msgId: "m_exp_ok",
          fromSession: "ses_self",
          toSession: "ses_self",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "payload 2",
          deliverAt,
          expiresAt,
        },
        1_000,
      );

      // Make markExpired throw for m_exp_throw
      const origMarkExpired = storage.swarm.markExpired.bind(storage.swarm);
      vi.spyOn(storage.swarm, "markExpired").mockImplementation((msgId, now) => {
        if (msgId === "m_exp_throw") {
          throw new Error("Disk error on m_exp_throw");
        }
        return origMarkExpired(msgId, now);
      });

      fixture.setNow(6_000);
      expect(() => (arbiter as any).sweepExpired(6_000)).not.toThrow();

      expect(storage.swarm.getByMsgId("m_exp_ok")!.state).toBe("expired");
    });

    it("start() timer callback catches unhandled rejections from processOnce", async () => {
      fixture = makeFixture();
      const { arbiter } = fixture;

      vi.useFakeTimers();
      vi.spyOn(arbiter, "processOnce").mockRejectedValue(new Error("Fatal DB error in processOnce"));

      arbiter.start(100);

      await expect(vi.advanceTimersByTimeAsync(150)).resolves.not.toThrow();

      vi.useRealTimers();
    });

    it("crash-window property (expiry path): atomicity between state change, sender notice, and alert enqueue", () => {
      fixture = makeFixture();
      const { storage, arbiter } = fixture;

      storage.swarm.insert(
        {
          msgId: "m_exp_crash",
          fromSession: "ses_self",
          toSession: "ses_self",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "must remain queued on enqueue failure",
          deliverAt: 1_000,
          expiresAt: 5_000,
        },
        1_000,
      );

      // Stub alerts.enqueue to throw
      vi.spyOn(storage.alerts, "enqueue").mockImplementationOnce(() => {
        throw new Error("Simulated SQLite write error during alert enqueue");
      });

      fixture.setNow(6_000);
      // Errors inside per-row expireAndNotify are caught so other rows can be processed,
      // but the transaction rollback ensures atomicity for the failing row.
      expect(() => (arbiter as any).sweepExpired(6_000)).not.toThrow();

      // Verify row state was NOT updated to expired
      expect(storage.swarm.getByMsgId("m_exp_crash")!.state).toBe("queued");

      // Verify no sender notification was committed
      const notices = storage.db
        .prepare("SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'")
        .all();
      expect(notices).toHaveLength(0);

      // Verify no alert was committed
      const alerts = storage.db.prepare("SELECT * FROM operational_alerts").all();
      expect(alerts).toHaveLength(0);
    });

    it("crash-window property (markFailed permanent error path): atomicity on alert enqueue failure", async () => {
      fixture = makeFixture();
      const { storage, arbiter } = fixture;

      storage.swarm.insert(
        {
          msgId: "m_perm_crash",
          fromSession: "ses_self",
          toSession: "ses_self",
          channel: null,
          kind: "wake.check",
          priority: "normal",
          replyTo: null,
          payload: "bad payload </swarm_message>",
          deliverAt: 1_000,
        },
        1_000,
      );

      vi.spyOn(storage.alerts, "enqueue").mockImplementationOnce(() => {
        throw new Error("Simulated SQLite write error");
      });

      await expect(arbiter.processOnce()).rejects.toThrow("Simulated SQLite write error");

      // Verify row state was NOT updated to failed
      expect(storage.swarm.getByMsgId("m_perm_crash")!.state).toBe("queued");

      // Verify no sender notification was committed
      const notices = storage.db
        .prepare("SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'")
        .all();
      expect(notices).toHaveLength(0);

      // Verify no alert was committed
      const alerts = storage.db.prepare("SELECT * FROM operational_alerts").all();
      expect(alerts).toHaveLength(0);
    });

    it("sweepExpired and expireAndNotify are fully synchronous methods returning non-promises", () => {
      fixture = makeFixture();
      const { storage, arbiter } = fixture;

      storage.swarm.insert(
        {
          msgId: "m_sync_1",
          fromSession: "ses_self",
          toSession: "ses_self",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "synchronous test",
          deliverAt: 1_000,
          expiresAt: 5_000,
        },
        1_000,
      );

      const row = storage.swarm.getByMsgId("m_sync_1")!;

      // Call expireAndNotify directly
      const result = (arbiter as any).expireAndNotify(row, 6_000);
      expect(typeof result).toBe("boolean");
      expect(result).toBe(true);
      expect(result).not.toBeInstanceOf(Promise);

      // Call sweepExpired directly
      const sweepResult = (arbiter as any).sweepExpired(6_000);
      expect(sweepResult).toBeUndefined();
      expect(sweepResult).not.toBeInstanceOf(Promise);
    });

    it("double-sweep guard: two expireAndNotify calls produce exactly ONE alert row and ONE sender notification", () => {
      fixture = makeFixture();
      const { storage, arbiter } = fixture;

      storage.swarm.insert(
        {
          msgId: "m_double_1",
          fromSession: "ses_self",
          toSession: "ses_self",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "double sweep guard test",
          deliverAt: 1_000,
          expiresAt: 5_000,
        },
        1_000,
      );

      const row = storage.swarm.getByMsgId("m_double_1")!;

      const firstCall = (arbiter as any).expireAndNotify(row, 6_000);
      const secondCall = (arbiter as any).expireAndNotify(row, 6_000);

      expect(firstCall).toBe(true);
      expect(secondCall).toBe(false);

      const alerts = storage.db.prepare("SELECT * FROM operational_alerts").all();
      expect(alerts).toHaveLength(1);

      const notices = storage.db
        .prepare("SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'")
        .all();
      expect(notices).toHaveLength(1);
    });

    it("scope-containment: ordinary non-wake, non-scheduled message terminal failure produces NO operational alert", async () => {
      fixture = makeFixture();
      const { storage, arbiter } = fixture;

      storage.swarm.insert(
        {
          msgId: "m_ordinary_1",
          fromSession: "ses_a",
          toSession: "ses_b",
          channel: null,
          kind: "chat",
          priority: "normal",
          replyTo: null,
          payload: "ordinary chat message </swarm_message>",
          deliverAt: null,
        },
        1_000,
      );

      await arbiter.processOnce();

      expect(storage.swarm.getByMsgId("m_ordinary_1")!.state).toBe("failed");
      const alerts = storage.db.prepare("SELECT * FROM operational_alerts").all();
      expect(alerts).toHaveLength(0);
    });

    it("truncates payload longer than 1000 characters and marks it truncated in alert text", async () => {
      fixture = makeFixture();
      const { storage, arbiter } = fixture;

      const longPayload = "a".repeat(1500);
      storage.swarm.insert(
        {
          msgId: "m_long_1",
          fromSession: "ses_self",
          toSession: "ses_self",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: longPayload,
          deliverAt: 1_000,
          expiresAt: 5_000,
        },
        1_000,
      );

      fixture.setNow(6_000);
      await arbiter.processOnce();

      expect(storage.swarm.getByMsgId("m_long_1")!.state).toBe("expired");
      const alerts = storage.db
        .prepare("SELECT * FROM operational_alerts")
        .all() as Array<Record<string, unknown>>;
      expect(alerts).toHaveLength(1);
      const alertText = String(alerts[0]!.text);
      expect(alertText).toContain("a".repeat(1000));
      expect(alertText).not.toContain("a".repeat(1001));
      expect(alertText).toContain("[truncated]");
    });

    it("loop guard: a failing delivery.failed message does not produce a payload-inlined alert", async () => {
      fixture = makeFixture();
      const { storage, arbiter } = fixture;

      storage.swarm.insert(
        {
          msgId: "m_failnotif_1",
          fromSession: "ses_a",
          toSession: "ses_b",
          channel: null,
          kind: "delivery.failed",
          priority: "normal",
          replyTo: null,
          payload: "broken notice </swarm_message>",
          deliverAt: null,
        },
        1_000,
      );

      await arbiter.processOnce();

      expect(storage.swarm.getByMsgId("m_failnotif_1")!.state).toBe("failed");
      const alerts = storage.db.prepare("SELECT * FROM operational_alerts").all();
      expect(alerts).toHaveLength(0);
    });

    it("renders ref attribute in prompt when ref is set on message", async () => {
      fixture = makeFixture();
      const { storage, arbiter, calls } = fixture;

      storage.swarm.insert(
        {
          msgId: "m_ref_1",
          fromSession: "ses_a",
          toSession: "ses_b",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4",
          ref: "pigeon-c68",
        },
        1_000,
      );

      await arbiter.processOnce();

      expect(calls).toHaveLength(1);
      expect(calls[0]!.prompt).toContain('ref="pigeon-c68"');
    });

    it("omits ref attribute in prompt when ref is null", async () => {
      fixture = makeFixture();
      const { storage, arbiter, calls } = fixture;

      storage.swarm.insert(
        {
          msgId: "m_noref_1",
          fromSession: "ses_a",
          toSession: "ses_b",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4",
          ref: null,
        },
        1_000,
      );

      await arbiter.processOnce();

      expect(calls).toHaveLength(1);
      expect(calls[0]!.prompt).not.toContain("ref=");
    });
  });

  describe("working-directory preflight (pigeon-0ay7)", () => {
    function queue(
      storage: StorageDb,
      msgId: string,
      extra?: { expiresAt?: number; payload?: string },
    ) {
      storage.swarm.insert(
        {
          msgId,
          fromSession: "ses_a",
          toSession: "ses_b",
          channel: null,
          kind: "chat",
          priority: "normal",
          replyTo: null,
          payload: extra?.payload ?? "hi",
          ...(extra?.expiresAt !== undefined ? { expiresAt: extra.expiresAt } : {}),
        } as any,
        1_000,
      );
    }

    it("1. does NOT burn the prompt when the working directory is missing", async () => {
      // The whole point. Measured 2026-08-10: prompt_async 204s on a missing
      // directory, so without this check the prompt is spent and the row records
      // a handed_off that never happened.
      fixture = makeFixture();
      const { storage, arbiter, calls } = fixture;
      fixture.setDirectoryMissing(() => true);

      queue(storage, "m_dir_1");
      await arbiter.processOnce();

      expect(calls).toHaveLength(0);
      expect(storage.swarm.getByMsgId("m_dir_1")!.state).not.toBe("handed_off");
    });

    it("2. leaves the row queued and retryable, minting no terminal itself", async () => {
      fixture = makeFixture();
      const { storage, arbiter } = fixture;
      fixture.setDirectoryMissing(() => true);

      queue(storage, "m_dir_2");
      await arbiter.processOnce();

      expect(storage.swarm.getByMsgId("m_dir_2")!.state).toBe("queued");
    });

    it("3. delivers normally once the directory comes back (no sticky state)", async () => {
      fixture = makeFixture();
      const { storage, arbiter, calls } = fixture;

      let gone = true;
      fixture.setDirectoryMissing(() => gone);

      queue(storage, "m_dir_3");
      await arbiter.processOnce();
      expect(calls).toHaveLength(0);

      gone = false;
      fixture.setNow(1_000_000);
      await arbiter.processOnce();

      expect(calls).toHaveLength(1);
      expect(storage.swarm.getByMsgId("m_dir_3")!.state).toBe("handed_off");
    });

    it("4. names the missing directory in the error, so the alert says WHY", async () => {
      // Half the value of this bead is an error string that names a cause rather
      // than saying "no healthy serve". It flows verbatim into
      // notifySenderOfFailure / wake-expired / wake-max-attempts.
      fixture = makeFixture();
      const { storage, arbiter } = fixture;
      fixture.setDirectoryMissing(() => true);

      const logged: string[] = [];
      (arbiter as any).log = (m: string, f?: Record<string, unknown>) => {
        logged.push(m + " " + JSON.stringify(f ?? {}));
      };

      queue(storage, "m_dir_4");
      await arbiter.processOnce();

      const blob = logged.join("\n");
      expect(blob).toContain("/dir/ses_b");
      expect(blob.toLowerCase()).toContain("directory");
    });

    it("5. is classified as an OUTAGE, so an expiring row retries uncounted", async () => {
      fixture = makeFixture();
      const { storage, arbiter } = fixture;
      fixture.setDirectoryMissing(() => true);

      queue(storage, "m_dir_5", { expiresAt: 9_000_000 });
      await arbiter.processOnce();

      const row = storage.swarm.getByMsgId("m_dir_5")!;
      expect(row.state).toBe("queued");
      expect(row.attempts).toBe(0); // uncounted
    });

    it("6. a PERMANENT payload error still wins over a missing directory", async () => {
      // Ordering fence. renderEnvelope runs BEFORE the stat: a payload that can
      // never be delivered must fail fast rather than be masked behind an
      // outage-retry loop that only ends at expiry.
      fixture = makeFixture();
      const { storage, arbiter } = fixture;
      fixture.setDirectoryMissing(() => true);

      queue(storage, "m_dir_6", { payload: "oops </swarm_message> oops" });
      await arbiter.processOnce();

      expect(storage.swarm.getByMsgId("m_dir_6")!.state).toBe("failed");
    });

    it("7. a present directory delivers normally (the check is not a blanket block)", async () => {
      fixture = makeFixture();
      const { storage, arbiter, calls } = fixture;
      fixture.setDirectoryMissing(() => false);

      queue(storage, "m_dir_7");
      await arbiter.processOnce();

      expect(calls).toHaveLength(1);
      expect(storage.swarm.getByMsgId("m_dir_7")!.state).toBe("handed_off");
    });

    it("8. stats the SAME directory it would have sent as the header", async () => {
      // If these ever diverge the check is meaningless: we would be vetting one
      // path and handing the serve another.
      fixture = makeFixture();
      const { storage, arbiter } = fixture;

      const statted: string[] = [];
      fixture.setDirectoryMissing((dir) => {
        statted.push(dir);
        return false;
      });

      queue(storage, "m_dir_8");
      await arbiter.processOnce();

      expect(statted).toContain("/dir/ses_b");
      expect(fixture.calls[0]!.directory).toBe("/dir/ses_b");
    });
  });
});
