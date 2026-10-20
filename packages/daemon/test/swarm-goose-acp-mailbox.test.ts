import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { registerGooseSession } from "../src/goose/register-session";

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
      { backendSessionId: "20261020_1", endpoint: "ws://127.0.0.1:4080/acp" },
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
      { backendSessionId: "20261020_1", endpoint: "ws://127.0.0.1:4080/acp" },
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
      { backendSessionId: "20261020_1", endpoint: "ws://127.0.0.1:4080/acp" },
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
