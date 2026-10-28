import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { registerGooseSession } from "../src/goose/register-session";
import { GOOSE_BACKEND_KIND } from "../src/goose/backend-kind";
import { notifySenderOfFailure } from "../src/swarm/notify-sender";

describe("goose-acp swarm mailbox (Task A1)", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(now = 1_000) {
    storage = openStorageDb(":memory:");
    return {
      app: createApp(storage, { nowFn: () => now }),
      storage,
    };
  }

  it("POST /swarm/send to an opted-in goose-acp gse_ returns 202 banked: true and stores in pull_inbox", async () => {
    const { app, storage: s } = newApp();
    registerGooseSession(
      s.sessions,
      { machineId: null, backendSessionId: "20261020_1", endpoint: "ws://127.0.0.1:4080/acp" },
      1_000,
      () => "gse_target",
    );
    s.sessions.setPullSources("gse_target", ["telegram-reply", "swarm"]);

    const res = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_sender",
          to: "gse_target",
          kind: "chat",
          priority: "normal",
          payload: "hello goose",
        }),
      }),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: boolean; msg_id: string; banked?: boolean };
    expect(body.accepted).toBe(true);
    expect(body.banked).toBe(true);
    expect(body.msg_id).toMatch(/^msg_/);

    // Row in pull_inbox with source: "swarm"
    const claimed = s.pullInbox.claim("gse_target", 2_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.msgId).toBe(body.msg_id);
    expect(claimed[0]!.source).toBe("swarm");
    expect(claimed[0]!.senderId).toBe("ses_sender");
    expect(claimed[0]!.payload).toBe("hello goose");

    // Nothing in swarm_messages
    expect(s.swarm.getByMsgId(body.msg_id)).toBeNull();
  });

  it("POST /swarm/send to a goose-acp gse_ not opted in returns 409 naming session and 'no swarm mailbox', storing nothing", async () => {
    const { app, storage: s } = newApp();
    registerGooseSession(
      s.sessions,
      { machineId: null, backendSessionId: "20261020_1", endpoint: "ws://127.0.0.1:4080/acp" },
      1_000,
      () => "gse_no_optin",
    );
    // pullSources defaults to ["telegram-reply"], "swarm" not present

    const res = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_sender",
          to: "gse_no_optin",
          kind: "chat",
          priority: "normal",
          payload: "hello without mailbox",
        }),
      }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("gse_no_optin");
    expect(body.error).toContain("no swarm mailbox");

    // Nothing stored in pull_inbox or swarm_messages
    expect(s.pullInbox.pendingCount("gse_no_optin", 2_000)).toBe(0);
    const countSwarm = s.db.prepare("SELECT COUNT(*) AS n FROM swarm_messages").get() as { n: number };
    expect(countSwarm.n).toBe(0);
  });

  it("POST /swarm/send to a gse_ with no row returns 409 'no goose session … on this machine', storing nothing", async () => {
    const { app, storage: s } = newApp();

    const res = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_sender",
          to: "gse_missing",
          kind: "chat",
          priority: "normal",
          payload: "hello nowhere",
        }),
      }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no goose session gse_missing on this machine");

    // Nothing stored
    expect(s.pullInbox.pendingCount("gse_missing", 2_000)).toBe(0);
    const countSwarm = s.db.prepare("SELECT COUNT(*) AS n FROM swarm_messages").get() as { n: number };
    expect(countSwarm.n).toBe(0);
  });

  it("POST /swarm/schedule to an opted-in gse_ returns 409 scheduled", async () => {
    const { app, storage: s } = newApp();
    registerGooseSession(
      s.sessions,
      { machineId: null, backendSessionId: "20261020_1", endpoint: "ws://127.0.0.1:4080/acp" },
      1_000,
      () => "gse_sched",
    );
    s.sessions.setPullSources("gse_sched", ["telegram-reply", "swarm"]);

    const res = await app(
      new Request("http://localhost/swarm/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_sender",
          to: "gse_sched",
          after: "1h",
          payload: "Resume pigeon-c68: run bd show pigeon-c68, then continue W4 in .worktrees/wake-w4.",
        }),
      }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/scheduled messages cannot be banked/);
  });

  it("rejects `to` matching neither ses_ nor gse_ with 400 naming both prefixes", async () => {
    const { app } = newApp();

    const res = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_sender",
          to: "invalid_prefix_123",
          kind: "chat",
          payload: "hello invalid",
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("ses_");
    expect(body.error).toContain("gse_");
  });
});

describe("POST /goose/swarm-mailbox (Task A2)", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(now = 1_000, opts: Record<string, unknown> = {}) {
    storage = openStorageDb(":memory:");
    return {
      app: createApp(storage, { nowFn: () => now, ...opts }),
      storage,
    };
  }

  function postMailbox(app: ReturnType<typeof createApp>, body: unknown) {
    return app(
      new Request("http://localhost/goose/swarm-mailbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("requires session_id and endpoint (400)", async () => {
    const { app } = newApp();
    expect((await postMailbox(app, { endpoint: "ws://x/acp" })).status).toBe(400);
    expect((await postMailbox(app, { session_id: "20261020_1" })).status).toBe(400);
    expect((await postMailbox(app, { session_id: "", endpoint: "ws://x/acp" })).status).toBe(400);
    expect((await postMailbox(app, { session_id: "20261020_1", endpoint: "" })).status).toBe(400);
  });

  it("refuses a gse_ in session_id with 400", async () => {
    const { app } = newApp();
    const res = await postMailbox(app, {
      session_id: "gse_my_session",
      endpoint: "ws://x/acp",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/gse_/);
  });

  it("refuses non-goose row at that key with 409", async () => {
    const { app, storage: s } = newApp();
    s.sessions.upsert({ sessionId: "ses_opencode", backendKind: "opencode-plugin-direct" }, 1_000);

    const res = await postMailbox(app, {
      session_id: "ses_opencode",
      endpoint: "ws://x/acp",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("refusing to convert");
  });

  it("absent row -> creates notify: false row with endpoint/token/backend id and pull_sources ['telegram-reply', 'swarm']", async () => {
    const { app, storage: s } = newApp(1_000);
    const res = await postMailbox(app, {
      session_id: "20261020_1",
      endpoint: "ws://127.0.0.1:4080/acp",
      auth_token: "tok_secret",
      cwd: "/repo/path",
      label: "my goose session",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      session_id: string;
      backend_session_id: string;
      created: boolean;
      notify: boolean;
    };
    expect(body).toEqual({
      ok: true,
      session_id: expect.stringMatching(/^gse_/),
      backend_session_id: "20261020_1",
      created: true,
      notify: false,
    });

    const row = s.sessions.get(body.session_id);
    expect(row).not.toBeNull();
    expect(row!.notify).toBe(false);
    expect(row!.backendKind).toBe(GOOSE_BACKEND_KIND);
    expect(row!.backendEndpoint).toBe("ws://127.0.0.1:4080/acp");
    expect(row!.backendAuthToken).toBe("tok_secret");
    expect(row!.backendSessionId).toBe("20261020_1");
    expect(row!.cwd).toBe("/repo/path");
    expect(row!.label).toBe("my goose session");
    expect(row!.pullSources).toEqual(["telegram-reply", "swarm"]);
  });

  it("refuses a legacy row (pigeon id == goose id, NULL backend id) with 409 directing to re-register", async () => {
    const { app, storage: s } = newApp(1_000);
    s.sessions.upsert(
      { sessionId: "20260918_1", backendKind: GOOSE_BACKEND_KIND, backendEndpoint: "ws://old/acp", notify: true },
      500,
    );
    const initialRow = s.sessions.get("20260918_1")!;
    expect(initialRow.lastSeen).toBe(500);

    const res = await postMailbox(app, {
      session_id: "20260918_1",
      endpoint: "ws://new/acp",
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      "goose session 20260918_1 has a legacy pigeon row (its pigeon id is goose's id); re-register it with POST /goose/sessions (e.g. `honk telegram 20260918_1 --force`) before using swarm",
    );

    // Existing row left untouched (endpoint and lastSeen unchanged, pullSources not modified)
    const row = s.sessions.get("20260918_1")!;
    expect(row.backendEndpoint).toBe("ws://old/acp");
    expect(row.lastSeen).toBe(500);
    expect(row.pullSources).toEqual(["telegram-reply"]);
  });

  it("present row registered via /goose/sessions -> created: false, notify: true, endpoint/label untouched, swarm added", async () => {
    const { app, storage: s } = newApp(1_000);
    registerGooseSession(
      s.sessions,
      {
        machineId: null,
        backendSessionId: "20261020_2",
        endpoint: "ws://orig/acp",
        cwd: "/orig/cwd",
        label: "orig label",
        authToken: "orig_tok",
      },
      500,
      () => "gse_registered",
    );

    const res = await postMailbox(app, {
      session_id: "20261020_2",
      endpoint: "ws://changed/acp",
      cwd: "/changed/cwd",
      label: "changed label",
      auth_token: "changed_tok",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      session_id: string;
      backend_session_id: string;
      created: boolean;
      notify: boolean;
    };
    expect(body).toEqual({
      ok: true,
      session_id: "gse_registered",
      backend_session_id: "20261020_2",
      created: false,
      notify: true,
    });

    const row = s.sessions.get("gse_registered")!;
    // Existing fields untouched
    expect(row.backendEndpoint).toBe("ws://orig/acp");
    expect(row.cwd).toBe("/orig/cwd");
    expect(row.label).toBe("orig label");
    expect(row.backendAuthToken).toBe("orig_tok");
    expect(row.notify).toBe(true);
    // pullSources updated
    expect(row.pullSources).toEqual(["telegram-reply", "swarm"]);
    // touched
    expect(row.lastSeen).toBe(1_000);
  });

  it("repeat call is idempotent", async () => {
    const { app, storage: s } = newApp(1_000);
    const first = await (await postMailbox(app, {
      session_id: "20261020_idempotent",
      endpoint: "ws://127.0.0.1:4080/acp",
    })).json() as { session_id: string; created: boolean };

    expect(first.created).toBe(true);

    const second = await (await postMailbox(app, {
      session_id: "20261020_idempotent",
      endpoint: "ws://127.0.0.1:4080/acp",
    })).json() as { session_id: string; created: boolean };

    expect(second.created).toBe(false);
    expect(second.session_id).toBe(first.session_id);
    expect(s.sessions.get(first.session_id)?.pullSources).toEqual(["telegram-reply", "swarm"]);
  });

  it("a later /goose/sessions keeps pull_sources and sets notify: true", async () => {
    const { app, storage: s } = newApp(1_000);
    const mailboxRes = await (await postMailbox(app, {
      session_id: "20261020_upgrade",
      endpoint: "ws://127.0.0.1:4080/acp",
    })).json() as { session_id: string; notify: boolean };

    expect(mailboxRes.notify).toBe(false);
    expect(s.sessions.get(mailboxRes.session_id)?.pullSources).toEqual(["telegram-reply", "swarm"]);

    // Now honk telegram registers the session via POST /goose/sessions
    const sessionsRes = await app(
      new Request("http://localhost/goose/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "20261020_upgrade",
          endpoint: "ws://127.0.0.1:4080/acp",
          notify: true,
        }),
      }),
    );
    expect(sessionsRes.status).toBe(200);

    const row = s.sessions.get(mailboxRes.session_id)!;
    expect(row.notify).toBe(true);
    // pullSources must still contain "swarm"!
    expect(row.pullSources).toEqual(["telegram-reply", "swarm"]);
  });

  it("does not call onSessionStart for a created row", async () => {
    const onSessionStart = vi.fn();
    const { app } = newApp(1_000, { onSessionStart });

    const res = await postMailbox(app, {
      session_id: "20261020_no_start",
      endpoint: "ws://127.0.0.1:4080/acp",
    });
    expect(res.status).toBe(200);
    expect(onSessionStart).not.toHaveBeenCalled();
  });
});

describe("Task A3: notify=false goose-acp rows stay off Telegram", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(now = 1_000, opts: Record<string, unknown> = {}) {
    storage = openStorageDb(":memory:");
    return {
      app: createApp(storage, { nowFn: () => now, ...opts }),
      storage,
    };
  }

  it("turn-event turn.started and turn.ended for a notify: false goose row return ignored: 'notify=false' and write no outbox row", async () => {
    const { app, storage: s } = newApp(1_000);
    // Create notify: false goose row via mailbox route
    await app(
      new Request("http://localhost/goose/swarm-mailbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "20261020_silent",
          endpoint: "ws://127.0.0.1:4080/acp",
        }),
      }),
    );

    const startedRes = await app(
      new Request("http://localhost/goose/turn-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          v: 1,
          type: "turn.started",
          session_id: "20261020_silent",
          upstream_id: "up_1",
          prompt_text: "do something",
        }),
      }),
    );
    expect(startedRes.status).toBe(200);
    expect(await startedRes.json()).toEqual({ ok: true, ignored: "notify=false" });

    const endedRes = await app(
      new Request("http://localhost/goose/turn-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          v: 1,
          type: "turn.ended",
          session_id: "20261020_silent",
          upstream_id: "up_1",
        }),
      }),
    );
    expect(endedRes.status).toBe(200);
    expect(await endedRes.json()).toEqual({ ok: true, ignored: "notify=false" });

    // Assert no outbox row was written
    const count = s.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("last_seen advances for a notify=false goose row on turn-event", async () => {
    let now = 1_000;
    const { app, storage: s } = newApp(now, { nowFn: () => now });
    await app(
      new Request("http://localhost/goose/swarm-mailbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "20261020_touch",
          endpoint: "ws://127.0.0.1:4080/acp",
        }),
      }),
    );

    const initial = s.sessions.getByBackendSessionId("20261020_touch")!;
    expect(initial.lastSeen).toBe(1_000);

    now = 5_000;
    const res = await app(
      new Request("http://localhost/goose/turn-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          v: 1,
          type: "turn.started",
          session_id: "20261020_touch",
          upstream_id: "up_touch_1",
          prompt_text: "advance time",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "notify=false" });

    const touched = s.sessions.getByBackendSessionId("20261020_touch")!;
    expect(touched.lastSeen).toBe(5_000);
  });

  it("bank into a notify: false goose row writes no w: outbox row", async () => {
    const { app, storage: s } = newApp(1_000);
    const mailboxRes = await (await app(
      new Request("http://localhost/goose/swarm-mailbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "20261020_silent_bank",
          endpoint: "ws://127.0.0.1:4080/acp",
        }),
      }),
    )).json() as { session_id: string };

    const sendRes = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_sender",
          to: mailboxRes.session_id,
          kind: "chat",
          payload: "hello silent goose",
        }),
      }),
    );
    expect(sendRes.status).toBe(202);
    const body = (await sendRes.json()) as { accepted: boolean; msg_id: string; banked?: boolean };
    expect(body.banked).toBe(true);

    // No w:<msg_id> in outbox
    expect(s.outbox.getByNotificationId(`w:${body.msg_id}`)).toBeNull();
  });

  it("bank into an opencode session with notify: false still writes a w: outbox row (unchanged behaviour)", async () => {
    const { app, storage: s } = newApp(1_000);
    s.sessions.upsert(
      {
        sessionId: "ses_opencode_notify_false",
        backendKind: "opencode-plugin-direct",
        notify: false,
      },
      1_000,
    );

    const sendRes = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_sender",
          to: "ses_opencode_notify_false",
          kind: "chat",
          payload: "hello opencode",
        }),
      }),
    );
    expect(sendRes.status).toBe(202);
    const body = (await sendRes.json()) as { accepted: boolean; msg_id: string };

    // w:<msg_id> IS in outbox for opencode notify: false
    expect(s.outbox.getByNotificationId(`w:${body.msg_id}`)).not.toBeNull();
  });
});

describe("Task A4: goose-acp may drain its mailbox", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(now = 1_000, opts: Record<string, unknown> = {}) {
    storage = openStorageDb(":memory:");
    return {
      app: createApp(storage, { nowFn: () => now, ...opts }),
      storage,
    };
  }

  it("drain and ack for an opted-in goose-acp session returns and acks the banked swarm rows", async () => {
    const { app, storage: s } = newApp(1_000);
    const mailboxRes = (await (await app(
      new Request("http://localhost/goose/swarm-mailbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "20261020_drain",
          endpoint: "ws://127.0.0.1:4080/acp",
        }),
      }),
    )).json()) as { session_id: string };

    // Bank a swarm message into this goose mailbox
    const sendRes = await app(
      new Request("http://localhost/swarm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ses_sender",
          to: mailboxRes.session_id,
          kind: "chat",
          payload: "task for goose",
        }),
      }),
    );
    expect(sendRes.status).toBe(202);
    const sendBody = (await sendRes.json()) as { msg_id: string; banked?: boolean };
    expect(sendBody.banked).toBe(true);

    // Drain the mailbox via POST /pull/drain
    const drainRes = await app(
      new Request("http://localhost/pull/drain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: mailboxRes.session_id,
        }),
      }),
    );
    expect(drainRes.status).toBe(200);
    const drainBody = (await drainRes.json()) as {
      ok: boolean;
      pending_total: number;
      messages: Array<{ msg_id: string; source: string; payload: string; sender_id: string }>;
    };
    expect(drainBody.ok).toBe(true);
    expect(drainBody.pending_total).toBe(1);
    expect(drainBody.messages).toHaveLength(1);
    expect(drainBody.messages[0]!.msg_id).toBe(sendBody.msg_id);
    expect(drainBody.messages[0]!.source).toBe("swarm");
    expect(drainBody.messages[0]!.payload).toBe("task for goose");
    expect(drainBody.messages[0]!.sender_id).toBe("ses_sender");

    // Ack the drained message via POST /pull/ack
    const ackRes = await app(
      new Request("http://localhost/pull/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: mailboxRes.session_id,
          msg_ids: [sendBody.msg_id],
        }),
      }),
    );
    expect(ackRes.status).toBe(200);
    const ackBody = (await ackRes.json()) as { ok: boolean; acked: string[]; rejected: string[] };
    expect(ackBody.acked).toEqual([sendBody.msg_id]);
    expect(ackBody.rejected).toEqual([]);

    // Mailbox is now empty
    expect(s.pullInbox.pendingCount(mailboxRes.session_id, 2_000)).toBe(0);
  });

  it("drain for an opencode session still 409s", async () => {
    const { app } = newApp(1_000);
    const { storage: s } = { storage };
    s!.sessions.upsert(
      {
        sessionId: "ses_opencode_user",
        backendKind: "opencode-plugin-direct",
        notify: true,
      },
      1_000,
    );

    const res = await app(
      new Request("http://localhost/pull/drain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: "ses_opencode_user",
        }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("nothing is banking inbound for it");
  });
});

describe("Task A5: delivery.failed to gse_ senders and pull_sources in GET /sessions", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newApp(now = 1_000, opts: Record<string, unknown> = {}) {
    storage = openStorageDb(":memory:");
    return {
      app: createApp(storage, { nowFn: () => now, ...opts }),
      storage,
    };
  }

  it("a failure for a message from an opted-in gse_ sender banks delivery.failed into its mailbox", async () => {
    const { storage: s } = newApp(1_000);
    registerGooseSession(
      s.sessions,
      { machineId: null, backendSessionId: "20261020_sender", endpoint: "ws://127.0.0.1:4080/acp" },
      1_000,
      () => "gse_sender",
    );
    s.sessions.setPullSources("gse_sender", ["telegram-reply", "swarm"]);

    notifySenderOfFailure(
      s,
      {
        msgId: "msg_orig_123",
        fromSession: "gse_sender",
        toSession: "ses_unreachable",
        channel: null,
        kind: "chat",
        handedOffAt: null,
      },
      "expired",
      2_000,
    );

    // It should be banked in pull_inbox for gse_sender
    const claimed = s.pullInbox.claim("gse_sender", 3_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.kind).toBe("delivery.failed");
    expect(claimed[0]!.source).toBe("swarm");
    expect(claimed[0]!.senderId).toBe("pigeon");
    expect(claimed[0]!.replyTo).toBe("msg_orig_123");

    // Nothing in swarm_messages
    const countSwarm = s.db.prepare("SELECT COUNT(*) AS n FROM swarm_messages").get() as { n: number };
    expect(countSwarm.n).toBe(0);
  });

  it("a failure for a message from a non-opted-in gse_ sender is refused and logged, nothing inserted", async () => {
    const { storage: s } = newApp(1_000);
    registerGooseSession(
      s.sessions,
      { machineId: null, backendSessionId: "20261020_sender2", endpoint: "ws://127.0.0.1:4080/acp" },
      1_000,
      () => "gse_sender_no_optin",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    notifySenderOfFailure(
      s,
      {
        msgId: "msg_orig_456",
        fromSession: "gse_sender_no_optin",
        toSession: "ses_unreachable",
        channel: null,
        kind: "chat",
        handedOffAt: null,
      },
      "expired",
      2_000,
    );

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("delivery.failed refused for gse_sender_no_optin"));
    warnSpy.mockRestore();

    // Nothing stored in pull_inbox or swarm_messages
    expect(s.pullInbox.pendingCount("gse_sender_no_optin", 3_000)).toBe(0);
    const countSwarm = s.db.prepare("SELECT COUNT(*) AS n FROM swarm_messages").get() as { n: number };
    expect(countSwarm.n).toBe(0);
  });

  it("GET /sessions rows carry pull_sources", async () => {
    const { app, storage: s } = newApp(1_000);
    // Create an opencode session with explicit pullSources
    s.sessions.upsert({ sessionId: "ses_with_sources", notify: true }, 1_000);
    s.sessions.setPullSources("ses_with_sources", ["telegram-reply", "swarm"]);

    // Create an opencode session with default pullSources (NULL in DB)
    s.sessions.upsert({ sessionId: "ses_default_sources", notify: true }, 1_000);

    const res = await app(new Request("http://localhost/sessions"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ session_id: string; pull_sources: string[] }> };

    const withSources = body.sessions.find((sess) => sess.session_id === "ses_with_sources");
    expect(withSources).toBeDefined();
    expect(withSources!.pull_sources).toEqual(["telegram-reply", "swarm"]);

    const defaultSources = body.sessions.find((sess) => sess.session_id === "ses_default_sources");
    expect(defaultSources).toBeDefined();
    expect(defaultSources!.pull_sources).toEqual(["telegram-reply"]);
  });
});
