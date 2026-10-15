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
    allowedSenderIds: OWNERS,
    reachability: async () => reach,
    log: () => {},
  });
  return { adapter, delivered };
}

const OWNER = "1001";
const OWNERS: ReadonlySet<string> = new Set([OWNER]);
const ctx = { commandId: "c1", senderId: OWNER };

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
      senderId: OWNER,
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
      allowedSenderIds: OWNERS,
      reachability: async () => {
        calls++;
        return { kind: "ok" };
      },
    });
    await adapter.deliverCommand(session(), "a", { commandId: "c1", senderId: OWNER });
    await adapter.deliverCommand(session(), "b", { commandId: "c2", senderId: OWNER });
    expect(calls).toBe(2);
  });
});

/**
 * Sender allowlist (eng-agent-platform-555.19), the same rule goose-pull applies.
 *
 * A goose session has a shell. The worker's chat allowlist admits every member
 * of an allowed group chat, so without this anyone in the forum could type a
 * prompt into a coordinator that runs commands as the owner.
 */
describe("GooseAcpAdapter sender allowlist", () => {
  it("refuses a sender who is not the owner, before probing or prompting", async () => {
    let probed = false;
    const delivered: string[] = [];
    const adapter = new GooseAcpAdapter({
      runnerFor: () => ({ deliver: async (_c: string, t: string) => { delivered.push(t); return { ok: true }; } }) as unknown as GooseSessionRunner,
      allowedSenderIds: OWNERS,
      reachability: async () => { probed = true; return { kind: "ok" }; },
    });
    const res = await adapter.deliverCommand(session(), "rm -rf", { commandId: "c1", senderId: "2002" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/owner/i);
    expect(probed).toBe(false);
    expect(delivered).toEqual([]);
  });

  it("fails closed when the sender id is missing", async () => {
    const { adapter, delivered } = makeAdapter({ kind: "ok" });
    const res = await adapter.deliverCommand(session(), "x", { commandId: "c1" });
    expect(res.ok).toBe(false);
    expect(delivered).toEqual([]);
  });

  it("refuses a forwarded message even from the owner", async () => {
    // The allowlist proves who SENT it, not who wrote it.
    const { adapter, delivered } = makeAdapter({ kind: "ok" });
    const res = await adapter.deliverCommand(session(), "x", { commandId: "c1", senderId: OWNER, forwarded: true });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/forwarded/i);
    expect(delivered).toEqual([]);
  });

  it("refuses everyone when the allowlist is empty", async () => {
    const adapter = new GooseAcpAdapter({
      runnerFor: () => ({ deliver: async () => ({ ok: true }) }) as unknown as GooseSessionRunner,
      allowedSenderIds: new Set(),
      reachability: async () => ({ kind: "ok" }),
    });
    const res = await adapter.deliverCommand(session(), "x", { commandId: "c1", senderId: OWNER });
    expect(res.ok).toBe(false);
  });
});

/**
 * goose commands typed into a pinned session's topic (eng-agent-platform-555.22).
 */
describe("GooseAcpAdapter refuses goose commands for a pinned session", () => {
  const pinned = () => session({ boundTopicKey: "stallwatch:mono" });

  for (const text of [
    "/clear",
    "  /clear  ",
    "/compact",
    "/summarize",
    "/goal ship it",
    "/grind off",
    "/prompt foo --info",
    "/prompts",
    "/skills",
    "/doctor",
    "/status",
    "/sw delta",
    "Please compact this conversation",
    "please compact this conversation.",
  ]) {
    it(`refuses ${JSON.stringify(text)} without probing or prompting`, async () => {
      let probed = false;
      const delivered: string[] = [];
      const adapter = new GooseAcpAdapter({
        runnerFor: () => ({ deliver: async (_c: string, t: string) => { delivered.push(t); return { ok: true }; } }) as unknown as GooseSessionRunner,
        allowedSenderIds: OWNERS,
        reachability: async () => { probed = true; return { kind: "ok" }; },
      });
      const res = await adapter.deliverCommand(pinned(), text, ctx);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Not sent/);
      expect(probed).toBe(false);
      expect(delivered).toEqual([]);
    });
  }

  for (const text of [
    "status?",
    "/tmp/foo is full, look",
    "what does /clear do?",
    "\"/clear\"",
    "please compact this conversation when you get a chance",
  ]) {
    it(`delivers the ordinary prompt ${JSON.stringify(text)}`, async () => {
      const { adapter, delivered } = makeAdapter({ kind: "ok" });
      const res = await adapter.deliverCommand(pinned(), text, ctx);
      expect(res.ok).toBe(true);
      expect(delivered.map((d) => d.text)).toEqual([text]);
    });
  }

  it("leaves an unpinned goose session alone: /clear still reaches it", async () => {
    const { adapter, delivered } = makeAdapter({ kind: "ok" });
    const res = await adapter.deliverCommand(session(), "/clear", ctx);
    expect(res.ok).toBe(true);
    expect(delivered.map((d) => d.text)).toEqual(["/clear"]);
  });
});

/** Reply-quote context in the goose prompt (eng-agent-platform-555.21). */
describe("GooseAcpAdapter carries what a message replied to", () => {
  it("prefixes the replied-to bot message", async () => {
    const { adapter, delivered } = makeAdapter({ kind: "ok" });
    await adapter.deliverCommand(session(), "yes, do it", { ...ctx, inReplyTo: "Shall I rebase #176?" });
    expect(delivered[0]!.text).toBe('[Replying to your earlier message: "Shall I rebase #176?"]\n\nyes, do it');
  });

  it("prefers the highlighted part when the human quoted one", async () => {
    const { adapter, delivered } = makeAdapter({ kind: "ok" });
    await adapter.deliverCommand(session(), "this one", {
      ...ctx,
      inReplyTo: "Two options: A, rebase. B, merge.",
      inReplyToQuote: "B, merge.",
    });
    expect(delivered[0]!.text).toBe('[Replying to this part of your earlier message: "B, merge."]\n\nthis one');
  });

  it("caps the context like goose-pull does", async () => {
    const { adapter, delivered } = makeAdapter({ kind: "ok" });
    await adapter.deliverCommand(session(), "ok", { ...ctx, inReplyTo: "x".repeat(5000) });
    expect(delivered[0]!.text).toBe(`[Replying to your earlier message: "${"x".repeat(500)}"]\n\nok`);
  });

  it("sends the text alone when there is nothing, or only whitespace, to carry", async () => {
    const { adapter, delivered } = makeAdapter({ kind: "ok" });
    await adapter.deliverCommand(session(), "hi", ctx);
    await adapter.deliverCommand(session(), "hi", { ...ctx, inReplyTo: "  ", inReplyToQuote: "" });
    expect(delivered.map((d) => d.text)).toEqual(["hi", "hi"]);
  });

  it("leaves a goose command untouched on an unpinned session, so it still runs as one", async () => {
    const { adapter, delivered } = makeAdapter({ kind: "ok" });
    await adapter.deliverCommand(session(), "/goal ship it", { ...ctx, inReplyTo: "What next?" });
    expect(delivered[0]!.text).toBe("/goal ship it");
  });
});
