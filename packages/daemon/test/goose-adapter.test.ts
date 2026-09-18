import { describe, it, expect } from "vitest";
import { GooseAcpAdapter } from "../src/goose/adapter.js";
import type { Reachability } from "../src/goose/preflight.js";
import type { SessionRecord } from "../src/storage/types.js";
import type { GooseSessionRunner } from "../src/goose/session-runner.js";

const session = (over: Partial<SessionRecord> = {}): SessionRecord =>
  ({
    sessionId: "20260918_1",
    ppid: null,
    pid: null,
    startTime: null,
    cwd: "/tmp/work",
    label: null,
    title: null,
    lastHumanMsgId: null,
    notify: true,
    state: "idle",
    ptyPath: null,
    nvimSocket: null,
    backendKind: "goose-acp",
    backendProtocolVersion: 1,
    backendEndpoint: "ws://127.0.0.1:38910/acp",
    backendAuthToken: "tok",
    createdAt: 0,
    updatedAt: 0,
    lastSeen: 0,
    expiresAt: 0,
    ...over,
  }) as SessionRecord;

function makeAdapter(reach: Reachability, deliverImpl?: () => Promise<unknown>) {
  const delivered: Array<{ commandId: string; text: string }> = [];
  const runner = {
    deliver: async (commandId: string, text: string) => {
      delivered.push({ commandId, text });
      return deliverImpl ? await deliverImpl() : { ok: true, meta: { mode: "prompt" } };
    },
  } as unknown as GooseSessionRunner;
  const adapter = new GooseAcpAdapter({
    runnerFor: () => runner,
    reachability: async () => reach,
    log: () => {},
  });
  return { adapter, delivered };
}

const ctx = { commandId: "c1" };

describe("GooseAcpAdapter delivery contract", () => {
  it("declares failurePolicy surface", () => {
    // NOT decoration. Without this the goose adapter inherits the path that
    // reads a socket blip as a dead opencode plugin and DELETES the session row,
    // its routing assignment and its Telegram topic. Forgetting it fails
    // silently and destructively, which is why it is pinned here and again at
    // the selectAdapter level.
    const { adapter } = makeAdapter({ kind: "ok" });
    expect(adapter.failurePolicy).toBe("surface");
  });

  it("does not implement deliverQuestionReply", () => {
    // The question-reply path throws and string-classifies regardless of
    // failurePolicy, so offering it would reopen the hazard by the back door.
    const { adapter } = makeAdapter({ kind: "ok" });
    expect((adapter as { deliverQuestionReply?: unknown }).deliverQuestionReply).toBeUndefined();
  });

  it("delivers through the runner when the endpoint is reachable", async () => {
    const { adapter, delivered } = makeAdapter({ kind: "ok" });
    const res = await adapter.deliverCommand(session(), "do it", ctx);
    expect(res.ok).toBe(true);
    expect(delivered).toEqual([{ commandId: "c1", text: "do it" }]);
  });

  it("returns ok:false for a rejected token, and does not throw", async () => {
    // A 401 is permanent. Throwing would retry the same bad credential every 60s
    // until the command expired about a day later.
    const { adapter, delivered } = makeAdapter({ kind: "auth-failed" });
    const res = await adapter.deliverCommand(session(), "x", ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/token/i);
    expect(delivered).toEqual([]);
  });

  it("returns ok:false when the port answers like something that is not goose", async () => {
    const { adapter, delivered } = makeAdapter({ kind: "not-goose", status: 200 });
    const res = await adapter.deliverCommand(session(), "x", ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/port/i);
    expect(delivered).toEqual([]);
  });

  it("throws when the serve is unreachable, because nothing was sent", async () => {
    // The one safe throw: redelivery cannot duplicate a prompt that never left.
    const { adapter, delivered } = makeAdapter({
      kind: "unreachable",
      cause: "connect ECONNREFUSED 127.0.0.1:38910",
    });
    await expect(adapter.deliverCommand(session(), "x", ctx)).rejects.toThrow(/unreachable/);
    expect(delivered).toEqual([]);
  });

  it("refuses a session with no endpoint rather than guessing one", async () => {
    const { adapter } = makeAdapter({ kind: "ok" });
    const res = await adapter.deliverCommand(session({ backendEndpoint: null }), "x", ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/endpoint/i);
  });

  it("says so when asked to deliver an attachment instead of dropping it", async () => {
    const { adapter, delivered } = makeAdapter({ kind: "ok" });
    const res = await adapter.deliverCommand(session(), "look at this", {
      commandId: "c1",
      media: { mime: "image/png", filename: "a.png", url: "data:image/png;base64,AA" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/attachment/i);
    expect(delivered).toEqual([]);
  });

  it("probes before every delivery, so a token rotated mid-session is caught", async () => {
    let calls = 0;
    const runner = { deliver: async () => ({ ok: true }) } as unknown as GooseSessionRunner;
    const adapter = new GooseAcpAdapter({
      runnerFor: () => runner,
      reachability: async () => {
        calls++;
        return { kind: "ok" };
      },
    });
    await adapter.deliverCommand(session(), "a", { commandId: "c1" });
    await adapter.deliverCommand(session(), "b", { commandId: "c2" });
    expect(calls).toBe(2);
  });
});
