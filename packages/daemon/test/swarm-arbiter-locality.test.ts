import { afterEach, describe, expect, it, vi } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { SwarmArbiter, type SessionOwner } from "../src/swarm/arbiter";
import type { Locality } from "../src/routing/locality";

// pigeon-k0qn.2: the arbiter decides locality BEFORE building a delivery client,
// so a target owned by another machine fails at once with an owner-naming notice
// and never reaches clientForSession (whose router path writes a placement).

function setup(opts: {
  locality: Locality | ((id: string) => Promise<Locality>);
  ownerOf?: (id: string) => Promise<SessionOwner | null>;
  selfMachineId?: string;
}) {
  const storage: StorageDb = openStorageDb(":memory:");
  const sendPrompt = vi.fn(async () => {});
  const clientForSession = vi.fn(() => ({ sendPrompt }));
  const localityOf =
    typeof opts.locality === "function" ? vi.fn(opts.locality) : vi.fn(async () => opts.locality as Locality);
  const now = 1_000_000;
  const arbiter = new SwarmArbiter({
    storage,
    clientForSession,
    directoryForSession: async (id) => `/dir/${id}`,
    directoryMissing: () => false,
    localityOf,
    ownerOf: opts.ownerOf,
    selfMachineId: opts.selfMachineId ?? "macbook",
    nowFn: () => now,
    log: () => {},
  });
  const insert = (msgId: string, extra: Record<string, unknown> = {}) =>
    storage.swarm.insert(
      {
        msgId,
        fromSession: "ses_sender",
        toSession: "ses_remote",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "hello",
        ...extra,
      } as any,
      now - 10,
    );
  const notices = () =>
    storage.db
      .prepare("SELECT to_session, kind, reply_to, payload FROM swarm_messages WHERE from_session = 'pigeon'")
      .all() as Array<{ to_session: string; kind: string; reply_to: string; payload: string }>;
  return { storage, arbiter, clientForSession, sendPrompt, localityOf, insert, notices };
}

/** A well-formed opencode id: `ses_` + 26 alphanumerics. */
const FULL_ID = "ses_ea4db4ccfffeH9sjJbP76NdLmp";

describe("SwarmArbiter target locality (pigeon-k0qn.2)", () => {
  let s: ReturnType<typeof setup> | null = null;
  afterEach(() => {
    s?.storage.db.close();
    s = null;
  });

  it("remote: fails on the FIRST attempt, never builds a client, names the owner", async () => {
    s = setup({
      locality: "remote",
      ownerOf: async () => ({ machineId: "cloudbox", lastSeen: Date.UTC(2026, 9, 20, 12) }),
    });
    s.insert("m1");

    await s.arbiter.processOnce();

    expect(s.clientForSession).not.toHaveBeenCalled();
    expect(s.sendPrompt).not.toHaveBeenCalled();
    const row = s.storage.swarm.getByMsgId("m1")!;
    expect(row.state).toBe("failed");
    expect(row.attempts).toBe(0);
    const [n] = s.notices();
    expect(n!.to_session).toBe("ses_sender");
    expect(n!.kind).toBe("delivery.failed");
    expect(n!.reply_to).toBe("m1");
    expect(n!.payload).toContain("ses_remote");
    expect(n!.payload).toContain("cloudbox");
    expect(n!.payload).toContain("2026-10-20T12:00:00.000Z");
    expect(n!.payload).toContain("macbook");
    expect(n!.payload).toMatch(/cross-machine swarm delivery is not supported/i);
    expect(n!.payload).toMatch(/NOT received/);
    expect(n!.payload).toMatch(/Do not resend it via swarm/);
    expect(n!.payload).not.toMatch(/safe to resend/);
    expect(n!.payload).not.toMatch(/RemoteTargetError/);
  });

  it("remote with no owner known (404 / old worker / error): still fails at once, names no machine", async () => {
    for (const ownerOf of [async () => null, async () => { throw new Error("worker down"); }, undefined]) {
      s?.storage.db.close();
      s = setup({ locality: "remote", ownerOf });
      s.insert("m1", { toSession: FULL_ID });
      await s.arbiter.processOnce();
      expect(s.storage.swarm.getByMsgId("m1")!.state).toBe("failed");
      const [n] = s.notices();
      expect(n!.payload).toMatch(/not on this machine \(macbook\)/);
      expect(n!.payload).not.toMatch(/registered to/);
    }
  });

  it("the owner lookup is bounded: a hung lookup does not hold the failure", async () => {
    vi.useFakeTimers();
    try {
      s = setup({ locality: "remote", ownerOf: () => new Promise(() => {}) });
      s.insert("m1");
      const p = s.arbiter.processOnce();
      await vi.advanceTimersByTimeAsync(2_100);
      await p;
      expect(s.storage.swarm.getByMsgId("m1")!.state).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("worker names THIS machine (stale D1 row): says not found here, claims no remote owner", async () => {
    s = setup({
      locality: "remote",
      ownerOf: async () => ({ machineId: "macbook", lastSeen: 5 }),
    });
    s.insert("m1");
    await s.arbiter.processOnce();
    const [n] = s.notices();
    expect(n!.payload).toMatch(/not found on this machine \(macbook\)/);
    expect(n!.payload).not.toMatch(/cross-machine/i);
  });

  it("unknown: retried as an outage, never failed as remote, never builds a client", async () => {
    s = setup({ locality: "unknown" });
    s.insert("m1");

    await s.arbiter.processOnce();

    expect(s.clientForSession).not.toHaveBeenCalled();
    const row = s.storage.swarm.getByMsgId("m1")!;
    expect(row.state).toBe("queued");
    expect(s.notices()).toHaveLength(0);
  });

  it("local: delivers as before", async () => {
    s = setup({ locality: "local" });
    s.insert("m1");
    await s.arbiter.processOnce();
    expect(s.sendPrompt).toHaveBeenCalledTimes(1);
    expect(s.storage.swarm.getByMsgId("m1")!.state).toBe("handed_off");
  });

  it("a remote scheduled wake raises the permanent-failure alert like any permanent error", async () => {
    s = setup({ locality: "remote", ownerOf: async () => ({ machineId: "cloudbox", lastSeen: 1 }) });
    s.insert("w1", { kind: "wake", deliverAt: 999_000, expiresAt: 9_999_999 });
    await s.arbiter.processOnce();
    expect(s.storage.swarm.getByMsgId("w1")!.state).toBe("failed");
    const alerts = s.storage.db.prepare("SELECT source FROM operational_alerts").all() as Array<{ source: string }>;
    expect(alerts.map((a) => a.source)).toContain("wake-permanent");
  });

  it("is re-evaluated on every attempt (no cached verdict)", async () => {
    let verdict: Locality = "unknown";
    s = setup({ locality: async () => verdict });
    s.insert("m1");
    await s.arbiter.processOnce();
    expect(s.storage.swarm.getByMsgId("m1")!.state).toBe("queued");
    verdict = "local";
    s.storage.db.prepare("UPDATE swarm_messages SET next_retry_at = NULL").run();
    await s.arbiter.processOnce();
    expect(s.storage.swarm.getByMsgId("m1")!.state).toBe("handed_off");
    expect(s.localityOf).toHaveBeenCalledTimes(2);
  });
});

describe("SwarmArbiter incomplete target ids (pigeon-k0qn.14)", () => {
  let s: ReturnType<typeof setup> | null = null;
  afterEach(() => {
    s?.storage.db.close();
    s = null;
  });

  const registerLocal = (storage: StorageDb, id: string) =>
    storage.sessions.upsert({ sessionId: id, notify: false }, 1);

  it("a truncated id nobody owns is reported as probably incomplete, NOT as do-not-resend", async () => {
    s = setup({ locality: "remote", ownerOf: async () => null });
    s.insert("m1", { toSession: "ses_ea4db4ccfffe" });
    await s.arbiter.processOnce();
    expect(s.storage.swarm.getByMsgId("m1")!.state).toBe("failed");
    const [n] = s.notices();
    expect(n!.kind).toBe("delivery.failed");
    expect(n!.payload).toMatch(/NOT received/);
    expect(n!.payload).toMatch(/16 characters/);
    expect(n!.payload).toMatch(/30/);
    expect(n!.payload).toMatch(/resend/i);
    expect(n!.payload).not.toMatch(/Do not resend/);
    expect(n!.payload).not.toMatch(/cross-machine/i);
  });

  it("names a unique local session the id is a prefix of, without delivering to it", async () => {
    s = setup({ locality: "remote", ownerOf: async () => null });
    registerLocal(s.storage, FULL_ID);
    s.insert("m1", { toSession: "ses_ea4db4ccfffe" });
    await s.arbiter.processOnce();
    const [n] = s.notices();
    expect(n!.payload).toContain(`Did you mean ${FULL_ID}`);
    expect(s.clientForSession).not.toHaveBeenCalled();
    expect(s.sendPrompt).not.toHaveBeenCalled();
  });

  it("names no candidate when the prefix is ambiguous", async () => {
    s = setup({ locality: "remote", ownerOf: async () => null });
    registerLocal(s.storage, "ses_ea4db4ccfffeAAAAAAAAAAAAAA");
    registerLocal(s.storage, "ses_ea4db4ccfffeBBBBBBBBBBBBBB");
    s.insert("m1", { toSession: "ses_ea4db4ccfffe" });
    await s.arbiter.processOnce();
    const [n] = s.notices();
    expect(n!.payload).not.toMatch(/Did you mean/);
    expect(n!.payload).toMatch(/2 sessions on this machine \(macbook\) start with it/);
  });

  it("a malformed id the worker DOES own keeps the remote wording", async () => {
    s = setup({
      locality: "remote",
      ownerOf: async () => ({ machineId: "cloudbox", lastSeen: 5 }),
    });
    s.insert("m1", { toSession: "ses_lane_maven_renovate" });
    await s.arbiter.processOnce();
    const [n] = s.notices();
    expect(n!.payload).toMatch(/registered to cloudbox/);
  });

  it("a lane-style id nobody owns is not called incomplete", async () => {
    s = setup({ locality: "remote", ownerOf: async () => null });
    s.insert("m1", { toSession: "ses_lane_maven_renovate" });
    await s.arbiter.processOnce();
    const [n] = s.notices();
    expect(n!.payload).not.toMatch(/incomplete/);
  });

  it("a full-length id nobody owns keeps the remote wording", async () => {
    s = setup({ locality: "remote", ownerOf: async () => null });
    s.insert("m1", { toSession: FULL_ID });
    await s.arbiter.processOnce();
    const [n] = s.notices();
    expect(n!.payload).toMatch(/Do not resend it via swarm/);
  });
});
