import { describe, it, expect, vi, afterEach } from "vitest";
import { GooseSessionRunner, GooseRunnerRegistry, gooseShutdownNotice } from "../src/goose/session-runner.js";
import { DisconnectedDuringTurn, GooseProtocolError } from "../src/goose/acp-client.js";
import type { SessionRecord } from "../src/storage/types.js";
import type { GooseInflightStore, GooseInflightRecord, InsertGooseInflightInput } from "../src/storage/goose-inflight-repo.js";

class FakeInflightStore implements GooseInflightStore {
  rows = new Map<string, GooseInflightRecord>();
  inserts: InsertGooseInflightInput[] = [];
  touches: Array<{ commandId: string; now: number }> = [];
  deletes: string[] = [];
  suspends: Array<{ commandId: string; now: number }> = [];
  resumes: Array<{ commandId: string; now: number }> = [];
  bumps: Array<{ commandId: string; now: number }> = [];
  markSents: Array<{ commandId: string; now: number }> = [];
  markQueueds: Array<{ commandId: string; now: number }> = [];

  insert(input: InsertGooseInflightInput, now: number = Date.now()): void {
    this.inserts.push(input);
    this.rows.set(input.commandId, {
      commandId: input.commandId,
      sessionId: input.sessionId,
      backendSessionId: input.backendSessionId,
      isHonk: input.isHonk,
      promptText: input.promptText,
      recoveryAttempts: input.recoveryAttempts ?? 0,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      lastAliveAt: input.lastAliveAt ?? now,
      cleanSuspend: input.cleanSuspend ?? false,
      state: input.state ?? "sent",
    });
  }

  delete(commandId: string): boolean {
    this.deletes.push(commandId);
    return this.rows.delete(commandId);
  }

  get(commandId: string): GooseInflightRecord | undefined {
    return this.rows.get(commandId);
  }

  listAll(): GooseInflightRecord[] {
    return [...this.rows.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  touchAlive(commandId: string, now: number = Date.now()): void {
    this.touches.push({ commandId, now });
    const row = this.rows.get(commandId);
    if (row) {
      row.lastAliveAt = now;
      row.updatedAt = now;
    }
  }

  markSuspended(commandId: string, now: number = Date.now()): void {
    this.suspends.push({ commandId, now });
    const row = this.rows.get(commandId);
    if (row) {
      row.cleanSuspend = true;
      row.lastAliveAt = now;
      row.updatedAt = now;
      row.recoveryAttempts = 0;
    }
  }

  markResumed(commandId: string, now: number = Date.now()): void {
    this.resumes.push({ commandId, now });
    const row = this.rows.get(commandId);
    if (row) {
      row.cleanSuspend = false;
      row.lastAliveAt = now;
      row.updatedAt = now;
    }
  }

  markSent(commandId: string, now: number = Date.now()): void {
    this.markSents.push({ commandId, now });
    const row = this.rows.get(commandId);
    if (row) {
      row.state = "sent";
      row.lastAliveAt = now;
      row.updatedAt = now;
    }
  }

  markQueued(commandId: string, now: number = Date.now()): void {
    this.markQueueds.push({ commandId, now });
    const row = this.rows.get(commandId);
    if (row) {
      row.state = "queued";
      row.lastAliveAt = now;
      row.updatedAt = now;
    }
  }

  bumpAttempts(commandId: string, now: number = Date.now()): number {
    this.bumps.push({ commandId, now });
    return 1;
  }
}

/**
 * The runner is tested against a scripted fake of the ACP client rather than a
 * socket. The socket is exercised elsewhere (ws-transport tests, and the live
 * probes recorded in bead eng-agent-platform-drm); what needs pinning here is
 * the LIFECYCLE, and the lifecycle's whole reason for existing is a timing
 * property — that delivery returns while the turn is still running.
 */
class FakeClient {
  connected = false;
  connectCalls = 0;
  closed = false;
  isHonk = false;
  /** Resolvers for in-flight prompts, keyed by the text that started them. */
  private turns: Array<{ text: string; resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  prompts: string[] = [];
  promptOptions: Array<{ clientReqId?: string } | undefined> = [];
  steers: Array<{ runId: string; text: string }> = [];
  steerOutcome: unknown = { kind: "steered", runId: "run_1", messageId: "m1" };
  transports: Array<{ closed: boolean }> = [];
  get openTransports(): number {
    return this.transports.filter((t) => !t.closed).length;
  }
  connectImpl: () => Promise<void> = async () => {
    this.connected = true;
    this.closed = false;
  };
  /** Simulate the socket dropping under us without anyone calling close(). */
  dropSocket(): void {
    this.closed = true;
    this.connected = false;
    const last = [...this.transports].reverse().find((t) => !t.closed);
    if (last) last.closed = true;
  }
  private runIds = new Map<string, string>();

  async connect(): Promise<void> {
    this.connectCalls++;
    await this.connectImpl();
    this.transports.push({ closed: false });
    this.connected = true;
    this.closed = false;
  }
  /**
   * Session ids this fake was actually CALLED with, per ACP method.
   *
   * These used to be discarded as `_sessionId`, which meant the fake asserted
   * nothing about the one thing the caller has to get right: goose knows the
   * session by its own id (`YYYYMMDD_N`), pigeon knows it by a `gse_` id it
   * mints itself, and sending pigeon's id to goose fails at runtime while every
   * test stays green. Recorded so the tests below can tell the two apart.
   */
  promptSessionIds: string[] = [];
  steerSessionIds: string[] = [];
  activeRunIdSessionIds: string[] = [];

  prompt(sessionId: string, text: string, options?: { clientReqId?: string }): Promise<unknown> {
    this.promptSessionIds.push(sessionId);
    this.prompts.push(text);
    this.promptOptions.push(options);
    return new Promise((resolve, reject) => this.turns.push({ text, resolve, reject }));
  }
  steerImpl: (() => Promise<unknown>) | undefined;
  async steer(sessionId: string, runId: string, text: string): Promise<unknown> {
    this.steerSessionIds.push(sessionId);
    this.steers.push({ runId, text });
    if (this.steerImpl) return this.steerImpl();
    return this.steerOutcome;
  }
  activeRunId(sessionId: string): string | undefined {
    this.activeRunIdSessionIds.push(sessionId);
    return this.runIds.get(sessionId);
  }
  ownership: "own" | "pending" | "foreign" | "unknown" = "own";
  runOwnership?: (sessionId: string) => "own" | "pending" | "foreign" | "unknown" = () => this.ownership;
  runStateValue: "unknown" | "idle" | "running" = "idle";
  runState?: (sessionId: string) => "unknown" | "idle" | "running" = () => this.runStateValue;
  isClosed(): boolean {
    return this.closed;
  }
  cancelCalls: string[] = [];
  cancelImpl: ((sessionId: string) => void) | undefined;
  cancel(sessionId: string): void {
    this.cancelCalls.push(sessionId);
    if (this.cancelImpl) this.cancelImpl(sessionId);
  }
  /** Answers by default; tests set pingImpl to model a dead socket. */
  pingImpl: (() => Promise<void>) | undefined;
  pings = 0;
  async ping(): Promise<void> {
    this.pings++;
    if (this.pingImpl) return this.pingImpl();
  }
  close(): void {
    this.closed = true;
    this.connected = false;
    for (const t of this.transports) {
      t.closed = true;
    }
  }

  // --- test controls ---
  setRunId(sessionId: string, runId: string): void {
    this.runIds.set(sessionId, runId);
  }
  finishTurn(stopReason = "end_turn", extra?: Record<string, unknown>): void {
    this.turns.shift()?.resolve({ kind: "receipt", stopReason, usage: { totalTokens: 10 }, ...extra });
  }
  failTurn(err: Error): void {
    this.turns.shift()?.reject(err);
  }
  /** goose rejected the prompt because a run was already in flight. */
  finishBusy(runId: string): void {
    this.turns.shift()?.resolve({ kind: "busy", runId });
  }
  get liveTurns(): number {
    return this.turns.length;
  }
}

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

function makeRunner(over: Record<string, unknown> = {}) {
  const client = new FakeClient();
  const stops: Array<Record<string, unknown>> = [];
  const touches: string[] = [];
  const inflight = (over.inflight as FakeInflightStore | undefined) ?? new FakeInflightStore();
  const runner = new GooseSessionRunner({
    session: session(),
    client: client as never,
    inflight,
    postStop: async (body) => {
      stops.push(body);
    },
    touch: (id) => touches.push(id),
    log: () => {},
    ...over,
  });
  return { runner, client, stops, touches, inflight };
}

describe("GooseSessionRunner turn lifecycle", () => {
  it("returns from deliver while the turn is still running", async () => {
    // THE load-bearing property of this whole module. The worker lease is 60s
    // and the poller acks only after the delivery handler returns, so awaiting
    // a multi-minute turn would lapse the lease, redeliver the command, and
    // issue a SECOND prompt into the live turn. See bead eng-agent-platform-drm.
    const { runner, client } = makeRunner();

    const res = await runner.deliver("c1", "do the thing");

    expect(res.ok).toBe(true);
    expect(client.prompts).toEqual(["do the thing"]);
    expect(client.liveTurns).toBe(1); // still running
    expect(runner.isBusy()).toBe(true);
  });

  it("reports the turn to /stop only once it actually ends", async () => {
    const { runner, client, stops } = makeRunner();
    await runner.deliver("c1", "hello");
    expect(stops).toHaveLength(0);

    runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ban" } });
    runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ana" } });
    client.finishTurn("end_turn");
    await runner.settled();

    expect(stops).toHaveLength(1);
    expect(stops[0]!.session_id).toBe("20260918_1");
    expect(stops[0]!.message).toBe("banana");
    expect(stops[0]!.event).toBe("Stop");
    expect(runner.isBusy()).toBe(false);
  });

  it("touches the session on delivery so the reaper does not collect it", async () => {
    // Every writer of last_seen today is opencode-plugin-driven. A goose session
    // nobody touches is reaped and its Telegram topic unregistered while the
    // goose session on disk is still perfectly alive.
    const { runner, touches } = makeRunner();
    await runner.deliver("c1", "hi");
    expect(touches).toEqual(["20260918_1"]);
  });

  it("steers a second message into the running turn instead of prompting again", async () => {
    const { runner, client } = makeRunner();
    await runner.deliver("c1", "first");
    client.setRunId("20260918_1", "run_abc");

    const res = await runner.deliver("c2", "actually, also this");

    expect(res.ok).toBe(true);
    expect(client.prompts).toEqual(["first"]); // NOT prompted twice
    expect(client.steers).toEqual([{ runId: "run_abc", text: "actually, also this" }]);
    expect(res.meta?.mode).toBe("steered");
  });

  it("falls back to a fresh prompt when the turn ended between busy-check and steer", async () => {
    const { runner, client } = makeRunner();
    await runner.deliver("c1", "first");
    client.setRunId("20260918_1", "run_abc");
    client.steerOutcome = { kind: "no-active-run" };

    const res = await runner.deliver("c2", "second");

    expect(res.ok).toBe(true);
    expect(client.prompts).toEqual(["first", "second"]);
    expect(res.meta?.mode).toBe("prompt");
  });

  it("does not prompt twice for a redelivered commandId", async () => {
    // The poller redelivers if the ack fails. Without this the human's message
    // is issued into goose a second time.
    const { runner, client } = makeRunner();
    await runner.deliver("c1", "once");
    const again = await runner.deliver("c1", "once");

    expect(again.ok).toBe(true);
    expect(client.prompts).toEqual(["once"]);
    expect(again.meta?.mode).toBe("already-running");
  });

  it("connects lazily, once, and reuses the connection for later turns", async () => {
    const { runner, client } = makeRunner();
    await runner.deliver("c1", "a");
    client.finishTurn();
    await runner.settled();
    await runner.deliver("c2", "b");

    expect(client.connectCalls).toBe(1);
  });

  it("throws when the connection cannot be established, because nothing was sent", async () => {
    // The contract in adapters/types.ts: throw ONLY for failures provably before
    // the command reached the backend. A failed connect is exactly that, and the
    // throw is what gets the command redelivered rather than dropped.
    const { runner, client } = makeRunner();
    client.connectImpl = async () => {
      throw new Error("ECONNREFUSED");
    };

    await expect(runner.deliver("c1", "x")).rejects.toThrow("ECONNREFUSED");
    expect(client.prompts).toEqual([]);
  });
});

describe("GooseSessionRunner failure containment", () => {
  it("reports a turn that fails as an Error event rather than losing it", async () => {
    const { runner, client, stops } = makeRunner();
    await runner.deliver("c1", "x");
    client.failTurn(new Error("disconnected during turn"));
    await runner.settled();

    expect(stops).toHaveLength(1);
    expect(stops[0]!.event).toBe("Error");
    expect(String(stops[0]!.message)).toContain("disconnected during turn");
    expect(runner.isBusy()).toBe(false);
  });

  it("tells the human a disconnect CANCELLED the turn, and resends nothing", async () => {
    // Measured against goose patched-1.54.0.3 (and honk m0-findings T5): when an
    // ACP WebSocket closes, goose cancels every run that connection started --
    // the tool call in flight is not recorded, no reply is ever written. The old
    // notice said only that the prompt "may" be persisted, and the shutdown and
    // stall notices said the turn would FINISH on goose's side, which sent the
    // human off to wait for an answer that was never coming.
    const { runner, client, stops } = makeRunner();
    await runner.deliver("c1", "build the thing");
    runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "Starting the build." } });
    client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));
    await runner.settled();

    expect(stops).toHaveLength(1);
    expect(stops[0]!.event).toBe("Error");
    expect(stops[0]!.error_kind).toBe("goose-turn-disconnected");
    const msg = String(stops[0]!.message);
    expect(msg).toContain("Starting the build.");
    expect(msg).toMatch(/cancel/i);
    expect(msg).toMatch(/not resent|nothing was resent/i);
    expect(msg).not.toMatch(/will finish|still running|may already be persisted/i);
    // Never an automatic resend: one prompt, and the session is free again.
    expect(client.prompts).toEqual(["build the thing"]);
    expect(runner.isBusy()).toBe(false);

    // The human's next message is a fresh turn on a fresh connection.
    client.dropSocket();
    await runner.deliver("c2", "continue");
    expect(client.prompts).toEqual(["build the thing", "continue"]);
    expect(client.connectCalls).toBe(2);
  });

  it("does not promise that a turn outlives pigeon shutting down", () => {
    const notice = gooseShutdownNotice("gse_1");
    expect(notice).toContain("gse_1");
    expect(notice).toMatch(/cancel/i);
    expect(notice).not.toMatch(/will finish|finish on its side/i);
  });

  it("says turn may still be running in honkd when isHonk is true on shutdown", () => {
    const notice = gooseShutdownNotice("gse_1", true);
    expect(notice).toContain("gse_1");
    expect(notice).toContain("turn may still be running in honkd");
    expect(notice).not.toMatch(/was cancelled and will not finish/i);
    expect(notice).not.toMatch(/the cancelled turn/i);
    expect(notice).toMatch(/the turn may have finished in goose's history; the reply just wasn't collected/i);
  });

  it("survives postStop throwing, and still clears the turn", async () => {
    // A detached turn's continuation runs with no caller. On Node an unhandled
    // rejection terminates the PROCESS, which would take down command delivery
    // for every session on the machine -- so nothing in the continuation may
    // escape, including the reporting call itself.
    const errs: string[] = [];
    const { runner, client } = makeRunner({
      postStop: async () => {
        throw new Error("sqlite is busy");
      },
      log: (m: string) => errs.push(m),
    });
    await runner.deliver("c1", "x");
    client.finishTurn();
    await runner.settled();

    expect(runner.isBusy()).toBe(false);
    expect(errs.join(" ")).toContain("could not report");
  });

  it("caps the buffered transcript so a runaway turn cannot exhaust memory", async () => {
    const { runner, client, stops } = makeRunner({ maxTranscriptBytes: 100 });
    await runner.deliver("c1", "x");
    for (let i = 0; i < 50; i++) {
      runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "0123456789" } });
    }
    client.finishTurn();
    await runner.settled();

    const msg = String(stops[0]!.message);
    // 500 bytes of chunks were offered against a 100-byte cap. What matters is
    // that the buffer stopped near the cap rather than growing with the input:
    // the transcript itself is bounded, and the notice is a fixed addition.
    const notice = "\n\n[... truncated: the turn produced more output than pigeon buffers]";
    expect(msg.endsWith(notice)).toBe(true);
    expect(msg.length - notice.length).toBeLessThanOrEqual(110); // cap + at most one chunk
    expect(msg.length - notice.length).toBeGreaterThanOrEqual(100);
  });

  it("caps receipt.text with maxTranscriptBytes before posting to /stop", async () => {
    const { runner, client, stops } = makeRunner({ maxTranscriptBytes: 100 });
    await runner.deliver("c1", "x");
    const longText = "a".repeat(250);
    client.finishTurn("end_turn", { text: longText });
    await runner.settled();

    const msg = String(stops[0]!.message);
    const notice = "\n\n[... truncated: the turn produced more output than pigeon buffers]";
    expect(msg.endsWith(notice)).toBe(true);
    expect(msg).toBe("a".repeat(100) + notice);
  });

  it("does not split a surrogate pair when capping receipt.text", async () => {
    const { runner, client, stops } = makeRunner({ maxTranscriptBytes: 100 });
    await runner.deliver("c1", "x");
    const textWithEmoji = "a".repeat(99) + "🦀" + "b".repeat(50);
    client.finishTurn("end_turn", { text: textWithEmoji });
    await runner.settled();

    const msg = String(stops[0]!.message);
    const notice = "\n\n[... truncated: the turn produced more output than pigeon buffers]";
    expect(msg.endsWith(notice)).toBe(true);
    expect(msg).toBe("a".repeat(99) + notice);
  });

  it("ignores tool chatter in the reported message but counts it as liveness", async () => {
    const { runner, client, stops } = makeRunner();
    await runner.deliver("c1", "x");
    runner.onUpdate({ sessionUpdate: "tool_call", title: "shell" });
    runner.onUpdate({ sessionUpdate: "usage_update", used: 12 });
    runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } });
    client.finishTurn();
    await runner.settled();

    expect(stops[0]!.message).toBe("answer\n\n📊 12 tokens");
  });

  it("usage_update frames during a turn -> postStop message ends with footer using last valid usage frame", async () => {
    const { runner, client, stops } = makeRunner();
    await runner.deliver("c1", "x");
    runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello world" } });
    runner.onUpdate({ sessionUpdate: "usage_update", used: 10000, size: 200000 });
    runner.onUpdate({
      sessionUpdate: "usage_update",
      used: 45231,
      size: 200000,
      cost: { amount: 1.84, currency: "USD" },
    });
    // Invalid usage_update: ignored, last valid one wins
    runner.onUpdate({ sessionUpdate: "usage_update", used: -1 });
    client.finishTurn();
    await runner.settled();

    expect(stops[0]!.message).toBe("Hello world\n\n📊 45.2K tokens · 23% · $1.84");
  });

  it("no usage frames -> message unchanged", async () => {
    const { runner, client, stops } = makeRunner();
    await runner.deliver("c1", "x");
    runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello world" } });
    client.finishTurn();
    await runner.settled();

    expect(stops[0]!.message).toBe("Hello world");
  });

  it("reports a turn that produced no text at all rather than sending an empty message", async () => {
    const { runner, client, stops } = makeRunner();
    await runner.deliver("c1", "x");
    client.finishTurn("end_turn");
    await runner.settled();

    expect(String(stops[0]!.message).length).toBeGreaterThan(0);
  });

  it("uses a notification id the /stop endpoint will actually accept", async () => {
    // app.ts parseStopNotificationId requires the `s:<sessionId>:` prefix and a
    // restricted charset; an id that fails those checks is silently dropped,
    // taking idempotency with it.
    const { runner, client, stops } = makeRunner();
    await runner.deliver("c1", "x");
    client.finishTurn();
    await runner.settled();

    const id = String(stops[0]!.notification_id);
    expect(id.startsWith("s:20260918_1:")).toBe(true);
    expect(id.length).toBeGreaterThan("s:20260918_1:".length);
    expect(/^[A-Za-z0-9_:.-]+$/.test(id)).toBe(true);
  });
});

/**
 * Two ids, and which one goes where.
 *
 * goose mints `YYYYMMDD_N` — a per-machine counter, NOT globally unique, so two
 * machines both produce `20260920_1` as their first session of a day. The
 * worker's D1 keys sessions globally, so pigeon mints its own `gse_` id and
 * keeps goose's in `backendSessionId`. Everything pigeon-facing (notifications,
 * touch, /stop bodies) must use the pigeon id; the four ACP calls must use
 * goose's, because that is the only name goose answers to.
 *
 * Getting this backwards fails only against a real goose, which is why it is
 * pinned here rather than left to the live probe.
 */
describe("pigeon id vs goose backend id", () => {
  it("prompts goose by its OWN session id, not pigeon's", async () => {
    const { runner, client } = makeRunner({
      session: session({ sessionId: "gse_abc", backendSessionId: "20260920_1" }),
    });
    await runner.deliver("c1", "hello");
    expect(client.promptSessionIds).toEqual(["20260920_1"]);
  });

  it("reports to pigeon under the PIGEON id while prompting goose under goose's", async () => {
    const { runner, client, stops, touches } = makeRunner({
      session: session({ sessionId: "gse_abc", backendSessionId: "20260920_1" }),
    });
    await runner.deliver("c1", "hello");
    client.finishTurn();
    await runner.settled();

    expect(client.promptSessionIds).toEqual(["20260920_1"]);
    // The /stop body and its notification id are pigeon's namespace: the worker
    // looks the session up in D1 by this, and D1 has never heard of `20260920_1`.
    expect(stops[0]!.session_id).toBe("gse_abc");
    expect(String(stops[0]!.notification_id)).toContain("gse_abc");
    expect(String(stops[0]!.notification_id)).not.toContain("20260920_1");
    expect(touches).toEqual(["gse_abc"]);
  });

  it("steers goose by goose's id", async () => {
    const { runner, client } = makeRunner({
      session: session({ sessionId: "gse_abc", backendSessionId: "20260920_1" }),
    });
    await runner.deliver("c1", "first");
    client.setRunId("20260920_1", "run_7");
    await runner.deliver("c2", "steer me");
    expect(client.steerSessionIds).toEqual(["20260920_1"]);
    expect(client.activeRunIdSessionIds).toContain("20260920_1");
  });

  /**
   * Every goose session registered before this column existed has NULL there,
   * and for those pigeon's id IS goose's id. Without the fallback the first
   * prompt to any pre-existing session would go to goose as `undefined`.
   */
  it("falls back to the pigeon id when no backend id is stored (legacy rows)", async () => {
    const { runner, client } = makeRunner({
      session: session({ sessionId: "20260918_1", backendSessionId: null }),
    });
    await runner.deliver("c1", "hello");
    expect(client.promptSessionIds).toEqual(["20260918_1"]);
  });
});

describe("GooseRunnerRegistry", () => {
  it("returns the same runner for a session, so turn state is not split", async () => {
    const made: string[] = [];
    const reg = new GooseRunnerRegistry({
      createRunner: (s) => {
        made.push(s.sessionId);
        return makeRunner().runner;
      },
    });
    const a = reg.get(session());
    const b = reg.get(session());
    expect(a).toBe(b);
    expect(made).toEqual(["20260918_1"]);
  });

  it("closes every runner on shutdown", async () => {
    const closed: string[] = [];
    const reg = new GooseRunnerRegistry({
      createRunner: () => ({ close: () => closed.push("x") }) as never,
    });
    reg.get(session({ sessionId: "a" }));
    reg.get(session({ sessionId: "b" }));
    reg.closeAll();
    expect(closed).toHaveLength(2);
  });

  it("forgets a runner when its session is dropped, so /kill does not leak it", () => {
    const reg = new GooseRunnerRegistry({ createRunner: () => ({ close: () => {} }) as never });
    reg.get(session({ sessionId: "a" }));
    expect(reg.size).toBe(1);
    reg.drop("a");
    expect(reg.size).toBe(0);
  });

  /**
   * Inbound `session/update` notifications arrive off the socket carrying
   * GOOSE's id, so they cannot be routed through the pigeon-id map. The second
   * map exists only for that, and the risk of a second map is that the two fall
   * out of step -- a drop that clears one and not the other leaves a runner
   * reachable by backend id forever, still holding a socket.
   */
  it("finds a runner by the backend id inbound updates carry", () => {
    const reg = new GooseRunnerRegistry({ createRunner: () => ({ close: () => {} }) as never });
    const r = reg.get(session({ sessionId: "gse_abc", backendSessionId: "20260920_1" }));
    expect(reg.peekByBackendId("20260920_1")).toBe(r);
    // The pigeon id is NOT a backend id; conflating them is the whole bug.
    expect(reg.peekByBackendId("gse_abc")).toBeUndefined();
    expect(reg.peek("gse_abc")).toBe(r);
  });

  it("clears BOTH maps on drop, so no runner survives by backend id", () => {
    let closed = 0;
    const reg = new GooseRunnerRegistry({ createRunner: () => ({ close: () => { closed++; } }) as never });
    reg.get(session({ sessionId: "gse_abc", backendSessionId: "20260920_1" }));
    reg.drop("gse_abc");
    expect(reg.size).toBe(0);
    expect(reg.peekByBackendId("20260920_1")).toBeUndefined();
    expect(closed).toBe(1);
  });

  it("clears BOTH maps on closeAll", () => {
    const reg = new GooseRunnerRegistry({ createRunner: () => ({ close: () => {} }) as never });
    reg.get(session({ sessionId: "gse_abc", backendSessionId: "20260920_1" }));
    reg.closeAll();
    expect(reg.peekByBackendId("20260920_1")).toBeUndefined();
    expect(reg.size).toBe(0);
  });

  /** Legacy rows have no backend id, and must still be routable by their own. */
  it("indexes a legacy row under its own id", () => {
    const reg = new GooseRunnerRegistry({ createRunner: () => ({ close: () => {} }) as never });
    const r = reg.get(session({ sessionId: "20260918_1", backendSessionId: null }));
    expect(reg.peekByBackendId("20260918_1")).toBe(r);
  });
});


/**
 * Every test here covers a defect found by pre-PR adversarial review rather than
 * by the test suite or the live probe -- all three sat at seams the tests stub
 * (the transport's lifecycle, and `postStop`). They are grouped so that is
 * visible: this is the class of bug this module is most exposed to.
 */
describe("GooseSessionRunner defects found in review", () => {
  it("reconnects after the socket closed underneath it", async () => {
    // A closed WebSocket's send() does NOT throw (verified on node 22.22.2:
    // readyState 3, silent no-op). Without noticing the close, the runner would
    // write the prompt into a void, report ok, and wait forever for a receipt --
    // wedging the session permanently.
    const { runner, client } = makeRunner();
    await runner.deliver("c1", "first");
    client.finishTurn();
    await runner.settled();
    expect(client.connectCalls).toBe(1);

    client.dropSocket();
    await runner.deliver("c2", "second");

    expect(client.connectCalls).toBe(2);
    expect(client.prompts).toEqual(["first", "second"]);
  });

  it("steers instead of reporting an empty success when the prompt is rejected as busy", async () => {
    // goose does not persist a prompt it rejected as busy, so the message was
    // never delivered. An earlier version cast the busy outcome to a receipt and
    // cheerfully reported "finished with no message" while dropping what the
    // human typed. Reachable on the ordinary path: pigeon restarts while a turn
    // is still running on goose's side.
    const { runner, client, stops } = makeRunner();
    await runner.deliver("c1", "please do this");
    client.finishBusy("run_live");
    await runner.settled();

    expect(client.steers).toEqual([{ runId: "run_live", text: "please do this" }]);
    // The live run reports its own completion; this one must not double-report.
    expect(stops).toHaveLength(0);
    expect(runner.isBusy()).toBe(false);
  });

  it("tells the human their message was lost when a busy prompt cannot be steered either", async () => {
    const { runner, client, stops } = makeRunner();
    client.steerOutcome = { kind: "no-active-run" };
    await runner.deliver("c1", "please do this");
    client.finishBusy("run_live");
    await runner.settled();

    expect(stops).toHaveLength(1);
    expect(stops[0]!.event).toBe("Error");
    expect(String(stops[0]!.message)).toMatch(/NOT delivered/);
  });

  it("does not wait forever on a handshake that never answers", async () => {
    // The poller is serial, so an unbounded await here freezes command delivery
    // for every session on the machine -- including another session's commands.
    const { runner, client } = makeRunner({ });
    client.connectImpl = () => new Promise<void>(() => {});
    const started = Date.now();
    await expect(runner.deliver("c1", "x")).rejects.toThrow(/did not answer/);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(client.prompts).toEqual([]);
    // and the half-open socket was closed rather than left to wedge a retry
    expect(client.closed).toBe(true);
  }, 20_000);

  it("does not wait forever on a steer that never answers", async () => {
    const { runner, client } = makeRunner();
    await runner.deliver("c1", "first");
    client.setRunId("20260918_1", "run_abc");
    client.steerImpl = () => new Promise(() => {});

    const res = await runner.deliver("c2", "second");

    expect(res.ok).toBe(false);
    expect(res.meta?.mode).toBe("steer-timeout");
  }, 20_000);
});

/**
 * The half-open socket.
 *
 * A websocket that dies with no close event (NAT idle drop, serve SIGKILL with
 * no FIN) leaves the turn's promise pending forever. `isBusy()` is a presence
 * check, so the session wedges permanently: every later message takes the steer
 * branch and steers a run id that is stale or absent.
 *
 * The inherited plan was "close the socket and let onClose reject the turn".
 * That does not work -- GooseAcpClient.close() does not touch its pending map,
 * and a half-open socket may never deliver a close event at all. The runner has
 * to settle its own turn.
 */
describe("GooseSessionRunner idle watchdog", () => {
  const IDLE = 30 * 60 * 1000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("abandons a turn that has gone completely silent, and unwedges the session", async () => {
    vi.useFakeTimers();
    const { runner, client, stops } = makeRunner();
    client.setRunId("20260918_1", "run_1");
    // The socket is dead: it will not answer the liveness probe either.
    client.pingImpl = () => new Promise(() => {});

    await runner.deliver("c1", "build the thing");
    expect(runner.isBusy()).toBe(true);

    await vi.advanceTimersByTimeAsync(IDLE + 1_000);
    await vi.advanceTimersByTimeAsync(11_000); // the probe's own 10s deadline

    expect(stops).toHaveLength(1);
    expect(stops[0]!.event).toBe("Error");
    expect(stops[0]!.error_kind).toBe("goose-turn-stalled");
    // Closing the socket cancels any run goose still had going for it, so the
    // notice must not tell the human to wait for it to finish.
    expect(String(stops[0]!.message)).not.toMatch(/will finish/i);
    expect(String(stops[0]!.message)).toMatch(/cancel/i);
    // The session must be usable again -- that is the whole point.
    expect(runner.isBusy()).toBe(false);
    // And the socket is dropped so the next delivery reconnects.
    expect(client.closed).toBe(true);
  });

  it("says turn may still be running in honkd in stall notice when isHonk is true", async () => {
    vi.useFakeTimers();
    try {
      const { runner, client, stops } = makeRunner({ turnIdleTimeoutMs: 5_000 });
      client.isHonk = true;
      client.pingImpl = async () => {
        throw new Error("dead");
      };
      await runner.deliver("c1", "stalling");

      await vi.advanceTimersByTimeAsync(6_000);

      expect(stops).toHaveLength(1);
      expect(stops[0]!.error_kind).toBe("goose-turn-stalled");
      expect(stops[0]!.message).toContain("turn may still be running in honkd");
      expect(stops[0]!.message).toMatch(/the turn may have finished in goose's history; the reply just wasn't collected/i);
      expect(stops[0]!.message).not.toMatch(/the cancelled turn/i);
      expect(stops[0]!.message).not.toMatch(/no result is coming here/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports 'one resend was attempted' instead of 'nothing was resent' in stall notice after resend", async () => {
    vi.useFakeTimers();
    try {
      const { runner, client, stops } = makeRunner({ turnIdleTimeoutMs: 5_000 });
      client.isHonk = true;
      await runner.deliver("c1", "resending-then-stalling");

      // Mid-turn disconnect
      client.dropSocket();
      client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));

      // Wait for resend prompt
      await vi.advanceTimersByTimeAsync(1);
      expect(client.prompts).toEqual(["resending-then-stalling", "resending-then-stalling"]);

      // Now the resend turn stalls
      client.pingImpl = async () => {
        throw new Error("dead");
      };
      await vi.advanceTimersByTimeAsync(6_000);

      expect(stops).toHaveLength(1);
      expect(stops[0]!.error_kind).toBe("goose-turn-stalled");
      expect(stops[0]!.message).toContain("one resend was attempted");
      expect(stops[0]!.message).not.toMatch(/nothing was resent/i);
      expect(stops[0]!.message).toMatch(/the turn may have finished in goose's history; the reply just wasn't collected/i);
      expect(stops[0]!.message).not.toMatch(/the cancelled turn/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not abandon a turn that is quietly working", async () => {
    vi.useFakeTimers();
    const { runner, client, stops } = makeRunner();
    client.setRunId("20260918_1", "run_1");
    await runner.deliver("c1", "long build");

    // A tool call that emits nothing for 25 minutes, then reports.
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
    expect(stops).toHaveLength(0);
    expect(runner.isBusy()).toBe(true);

    // Tool chatter is liveness even though it contributes no transcript text.
    runner.onUpdate({ sessionUpdate: "tool_call_update", status: "completed" });
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000);

    expect(stops).toHaveLength(0);
    expect(runner.isBusy()).toBe(true);
  });

  /**
   * The false-positive path, and the reason the stall notice needs its own
   * notification id. /stop dedups on notification_id: if the stall notice
   * claimed the turn's normal id, a late REAL answer would be swallowed as
   * "already queued" and the human would lose it entirely.
   */
  it("still reports a real answer that arrives after the turn was abandoned", async () => {
    vi.useFakeTimers();
    const { runner, client, stops } = makeRunner();
    client.setRunId("20260918_1", "run_1");
    client.pingImpl = () => new Promise(() => {});
    await runner.deliver("c1", "slow but alive");

    await vi.advanceTimersByTimeAsync(IDLE + 1_000);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(stops).toHaveLength(1);
    const stalledId = stops[0]!.notification_id as string;

    // goose was fine all along and finally answers.
    client.finishTurn("end_turn");
    await vi.runAllTimersAsync();
    await runner.settled();

    expect(stops).toHaveLength(2);
    expect(stops[1]!.event).toBe("Stop");
    // Distinct ids, or /stop's idempotency would have eaten the real answer.
    expect(stops[1]!.notification_id).not.toBe(stalledId);
  });

  it("abandoned turn answering late with empty string text: posts honest receipt", async () => {
    vi.useFakeTimers();
    const { runner, client, stops } = makeRunner();
    client.isHonk = true;
    client.setRunId("20260918_1", "run_1");
    client.pingImpl = () => new Promise(() => {});
    await runner.deliver("c1", "slow but alive");

    await vi.advanceTimersByTimeAsync(IDLE + 1_000);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(stops).toHaveLength(1);
    const stalledId = stops[0]!.notification_id as string;

    // goose was fine all along and finally answers with text: ""
    client.finishTurn("end_turn", { text: "" });
    await vi.runAllTimersAsync();
    await runner.settled();

    expect(stops).toHaveLength(2);
    expect(stops[1]!.event).toBe("Stop");
    expect(stops[1]!.message).toBe("goose ended the turn without a reply.");
    expect(stops[1]!.notification_id).not.toBe(stalledId);
  });

  it("stays quiet when the abandoned turn merely errors out later", async () => {
    vi.useFakeTimers();
    const { runner, client, stops } = makeRunner();
    client.setRunId("20260918_1", "run_1");
    client.pingImpl = () => new Promise(() => {});
    await runner.deliver("c1", "doomed");

    await vi.advanceTimersByTimeAsync(IDLE + 1_000);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(stops).toHaveLength(1);

    // This rejection is the expected consequence of our own close(). Reporting
    // it would be a second failure notice for one failure.
    client.failTurn(new Error("connection closed (code 1006)"));
    await vi.runAllTimersAsync();
    await runner.settled();

    expect(stops).toHaveLength(1);
  });

  /**
   * The event-driven half. A wedged session plus a human who sends anything
   * hits the steer branch, which is already bounded at 10s -- and steer is a
   * ~1ms call, so 10s of silence there is dead-socket evidence at least as good
   * as 30 minutes of turn silence. It just did not unwedge anything.
   */
  it("unwedges on a steer that never answers, so the human's resend works", async () => {
    const { runner, client, stops } = makeRunner();
    client.setRunId("20260918_1", "run_1");
    await runner.deliver("c1", "first");

    // A truly dead socket: neither the steer nor the liveness probe answers.
    client.steerImpl = () => new Promise(() => {});
    client.pingImpl = () => new Promise(() => {});
    const outcome = await runner.deliver("c2", "are you there?");

    expect(outcome.ok).toBe(false);
    expect(outcome.meta?.mode).toBe("steer-timeout");
    // Unwedged: the stuck turn was abandoned and reported.
    expect(runner.isBusy()).toBe(false);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.error_kind).toBe("goose-turn-stalled");
  }, 30_000);

  it("declines without abandoning when the steer is slow but the socket is alive", async () => {
    const { runner, client, stops } = makeRunner();
    client.setRunId("20260918_1", "run_1");
    await runner.deliver("c1", "first");

    // The steer hangs, but the connection answers a liveness check -- so the
    // turn is still real and must NOT be thrown away. Same rule as the watchdog:
    // silence is not evidence, and abandoning a live turn costs the answer.
    client.steerImpl = () => new Promise(() => {});
    const outcome = await runner.deliver("c2", "are you there?");

    expect(outcome.ok).toBe(false);
    expect(outcome.meta?.mode).toBe("steer-timeout");
    expect(runner.isBusy()).toBe(true);
    expect(stops).toHaveLength(0);
    expect(client.closed).toBe(false);
  }, 30_000);

  it("bounds the steer on the busy path too", async () => {
    const { runner, client, stops } = makeRunner();
    await runner.deliver("c1", "hello");

    // goose rejected the prompt as busy, and the follow-up steer hangs.
    client.steerImpl = () => new Promise(() => {});
    client.finishBusy("run_9");
    await runner.settled();

    // Bounded rather than hanging forever: the turn is settled and the human is
    // told their message did not land.
    expect(stops).toHaveLength(1);
    expect(runner.isBusy()).toBe(false);
    expect(String(stops[0]!.message)).toMatch(/NOT delivered|not delivered/i);
  }, 20_000);
});

/**
 * Silence is not evidence. Asking is.
 *
 * A turn that emits nothing and a socket that is dead look identical from the
 * outside, and the cost of confusing them is asymmetric but bad both ways: keep
 * faith in a dead socket and the session wedges forever; abandon a live turn and
 * the human loses the answer outright, because abandoning MEANS closing the
 * socket the answer would have come back on.
 *
 * Measured against goose 1.48.0: a second `initialize` mid-turn answers in ~1ms
 * and the in-flight turn still completes with stopReason end_turn, so the probe
 * is both cheap and non-disruptive.
 */
describe("GooseSessionRunner liveness probing", () => {
  const IDLE = 30 * 60 * 1000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps waiting on a silent turn whose socket still answers", async () => {
    vi.useFakeTimers();
    const { runner, client, stops } = makeRunner();
    client.setRunId("20260918_1", "run_1");
    await runner.deliver("c1", "a very long build");

    // Two full idle periods of total silence -- but the socket is fine.
    await vi.advanceTimersByTimeAsync(IDLE + 1_000);
    await vi.advanceTimersByTimeAsync(IDLE + 1_000);

    expect(client.pings).toBeGreaterThanOrEqual(1);
    expect(stops).toHaveLength(0);
    expect(runner.isBusy()).toBe(true);
    expect(client.closed).toBe(false);
  });

  it("gives up once the socket stops answering", async () => {
    vi.useFakeTimers();
    const { runner, client, stops } = makeRunner();
    client.setRunId("20260918_1", "run_1");
    await runner.deliver("c1", "build");

    // Alive through the first check.
    await vi.advanceTimersByTimeAsync(IDLE + 1_000);
    expect(stops).toHaveLength(0);

    // Then the socket dies.
    client.pingImpl = () => new Promise(() => {});
    await vi.advanceTimersByTimeAsync(IDLE + 1_000);
    await vi.advanceTimersByTimeAsync(11_000);

    expect(stops).toHaveLength(1);
    expect(stops[0]!.error_kind).toBe("goose-turn-stalled");
    expect(String(stops[0]!.message)).toContain("liveness check");
    expect(runner.isBusy()).toBe(false);
  });

  it("does not re-probe on every tick once a probe has succeeded", async () => {
    vi.useFakeTimers();
    const { runner, client } = makeRunner();
    client.setRunId("20260918_1", "run_1");
    await runner.deliver("c1", "quiet work");

    await vi.advanceTimersByTimeAsync(IDLE * 3);
    // Exactly one probe per idle period -- not one per timer tick, and not zero,
    // which a <= assertion would have accepted while the watchdog did nothing.
    expect(client.pings).toBe(3);
  });

  describe("honk relay integration (Task B1)", () => {
    it("passes commandId as clientReqId to client.prompt", async () => {
      const { runner, client } = makeRunner();
      await runner.deliver("cmd-abc", "hello");
      expect(client.promptOptions).toEqual([{ clientReqId: "cmd-abc" }]);
    });

    it("does not resend on disconnect when isHonk is false (bare goose)", async () => {
      const { runner, client, stops } = makeRunner();
      client.isHonk = false;
      await runner.deliver("c1", "build");
      client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));
      await runner.settled();

      expect(client.prompts).toEqual(["build"]);
      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Error");
      expect(stops[0]!.error_kind).toBe("goose-turn-disconnected");
      expect(runner.isBusy()).toBe(false);
    });

    it("does not resend if endpoint changed to bare goose after reconnect", async () => {
      const { runner, client, stops } = makeRunner();
      client.isHonk = true;
      await runner.deliver("c1", "build");

      // On reconnect, endpoint turns out to be bare goose (isHonk = false)
      client.connectImpl = async () => {
        client.connected = true;
        client.closed = false;
        client.isHonk = false;
      };
      client.dropSocket();
      client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));
      await runner.settled();

      expect(client.prompts).toEqual(["build"]);
      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Error");
      expect(stops[0]!.error_kind).toBe("goose-turn-disconnected");
      expect(stops[0]!.message).toMatch(/nothing was resent/i);
      expect(runner.isBusy()).toBe(false);
    });

    it("reconnects once and resends with same clientReqId when isHonk is true, preferring receipt text", async () => {
      const { runner, client, stops } = makeRunner();
      client.isHonk = true;
      await runner.deliver("c1", "build");
      runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "partial streamed chunk" } });

      // Mid-turn disconnect
      client.dropSocket();
      client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));

      // Wait for runner to reconnect and issue the resent prompt
      await vi.waitFor(() => expect(client.prompts).toEqual(["build", "build"]));
      expect(client.connectCalls).toBe(2);
      expect(client.promptOptions).toEqual([
        { clientReqId: "c1" },
        { clientReqId: "c1" },
      ]);

      // Resent prompt finishes with receipt carrying honk text
      client.finishTurn("end_turn", { text: "full canonical honk text" });
      await runner.settled();

      // Exactly one receipt reported, preferring text over partial streamed chunk
      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Stop");
      expect(stops[0]!.error_kind).toBeUndefined();
      expect(stops[0]!.message).toBe("full canonical honk text");
      expect(runner.isBusy()).toBe(false);
    });

    it("falls back to streamed chunks if honk receipt text is absent", async () => {
      const { runner, client, stops } = makeRunner();
      client.isHonk = true;
      await runner.deliver("c1", "build");
      runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "chunk 1" } });

      client.dropSocket();
      client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));

      // Wait for the resend prompt to be issued
      await vi.waitFor(() => expect(client.prompts).toEqual(["build", "build"]));

      runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: " chunk 2" } });
      client.finishTurn("end_turn"); // no extra text
      await runner.settled();

      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Stop");
      expect(stops[0]!.message).toBe("chunk 1 chunk 2");
      expect(runner.isBusy()).toBe(false);
    });

    it("on live turn, if honk says empty string but chunks were received, renders accumulator and logs warning", async () => {
      const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
      const { runner, client, stops } = makeRunner({
        log: (msg: string, fields?: Record<string, unknown>) => {
          logs.push({ msg, fields });
        },
      });
      client.isHonk = true;
      await runner.deliver("c1", "build");
      runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "live streamed text" } });

      client.finishTurn("end_turn", { text: "" });
      await runner.settled();

      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Stop");
      expect(stops[0]!.error_kind).toBeUndefined();
      expect(stops[0]!.message).toBe("live streamed text");
      expect(runner.isBusy()).toBe(false);
      expect(logs.some((l) => l.msg.includes("honk text empty but 18 chars received"))).toBe(true);
    });

    it("honk receipt text empty string with no chunks: posts honest receipt", async () => {
      const { runner, client, stops } = makeRunner();
      client.isHonk = true;
      await runner.deliver("c1", "build");

      client.finishTurn("end_turn", { text: "" });
      await runner.settled();

      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Stop");
      expect(stops[0]!.error_kind).toBeUndefined();
      expect(stops[0]!.message).toBe("goose ended the turn without a reply.");
      expect(runner.isBusy()).toBe(false);
    });

    it.each([
      ["max_tokens", "goose ended the turn without a reply (stopReason: max_tokens)."],
      ["refusal", "goose ended the turn without a reply (stopReason: refusal)."],
      ["max_turn_requests", "goose ended the turn without a reply (stopReason: max_turn_requests)."],
      ["cancelled", "goose ended the turn without a reply (stopReason: cancelled)."],
    ])("honk receipt text empty string with stopReason '%s': appends stopReason to message", async (stopReason, expectedMessage) => {
      const { runner, client, stops } = makeRunner();
      client.isHonk = true;
      await runner.deliver("c1", "build");

      client.finishTurn(stopReason, { text: "" });
      await runner.settled();

      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Error");
      expect(stops[0]!.message).toBe(expectedMessage);
      expect(runner.isBusy()).toBe(false);
    });

    it("honk receipt text absent with no chunks: posts finished with no message", async () => {
      const { runner, client, stops } = makeRunner();
      client.isHonk = true;
      await runner.deliver("c1", "build");

      client.finishTurn("end_turn"); // text undefined (absent)
      await runner.settled();

      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Stop");
      expect(stops[0]!.error_kind).toBeUndefined();
      expect(stops[0]!.message).toBe("goose finished the turn with no message (stopReason: end_turn).");
      expect(runner.isBusy()).toBe(false);
    });

    it("reports not_delivered honk cancel reason with advice to send again", async () => {
      const { runner, client, stops } = makeRunner();
      client.isHonk = true;
      await runner.deliver("c1", "build");
      client.finishTurn("cancelled", { honkReason: "not_delivered" });
      await runner.settled();

      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Error");
      expect(stops[0]!.error_kind).toBe("goose-stop-cancelled");
      expect(stops[0]!.message).toMatch(/message was not delivered/i);
      expect(stops[0]!.message).toMatch(/send it again/i);
      expect(runner.isBusy()).toBe(false);
    });

    it("reports upstream_restart honk cancel reason stating goose restarted", async () => {
      const { runner, client, stops } = makeRunner();
      client.isHonk = true;
      await runner.deliver("c1", "build");
      client.finishTurn("cancelled", { honkReason: "upstream_restart" });
      await runner.settled();

      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Error");
      expect(stops[0]!.error_kind).toBe("goose-stop-cancelled");
      expect(stops[0]!.message).toMatch(/goose restarted and the turn was cancelled/i);
      expect(runner.isBusy()).toBe(false);
    });

    it("reports delivery_unknown honk cancel reason advising user to check before resending", async () => {
      const { runner, client, stops } = makeRunner();
      client.isHonk = true;
      await runner.deliver("c1", "build");
      client.finishTurn("cancelled", { honkReason: "delivery_unknown" });
      await runner.settled();

      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Error");
      expect(stops[0]!.error_kind).toBe("goose-stop-cancelled");
      expect(stops[0]!.message).toContain(
        "honkd could not confirm goose received this message; check the session before resending.",
      );
      expect(runner.isBusy()).toBe(false);
    });

    it("retries connect with backoff when honkd is restarting, and delivers exactly one receipt upon reconnecting", async () => {
      const sleepDelays: number[] = [];
      const { runner, client, stops } = makeRunner({
        honkReconnectBudgetMs: 5_000,
        honkReconnectInitialDelayMs: 10,
        honkReconnectMaxDelayMs: 50,
        sleep: async (ms: number) => {
          sleepDelays.push(ms);
        },
      });
      client.isHonk = true;
      await runner.deliver("c1", "build");

      // Mid-turn disconnect
      client.dropSocket();

      let connectAttempts = 0;
      client.connectImpl = async () => {
        connectAttempts++;
        if (connectAttempts < 3) {
          throw new Error("ECONNREFUSED");
        }
        client.connected = true;
        client.closed = false;
      };

      client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));

      // Wait for resend prompt after retries
      await vi.waitFor(() => expect(client.prompts).toEqual(["build", "build"]));
      expect(connectAttempts).toBe(3);
      expect(sleepDelays).toEqual([10, 20]);

      // Now honkd replies with receipt
      client.finishTurn("end_turn", { text: "reconnected build success" });
      await runner.settled();

      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Stop");
      expect(stops[0]!.message).toBe("reconnected build success");
      expect(runner.isBusy()).toBe(false);
    });

    it("reports the resend error honestly as goose-turn-failed when honkd answers resend with protocol error", async () => {
      const { runner, client, stops } = makeRunner();
      client.isHonk = true;
      await runner.deliver("c1", "build");

      // Mid-turn disconnect
      client.dropSocket();
      client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));

      // Wait for reconnect to succeed and resend prompt to be issued
      await vi.waitFor(() => expect(client.prompts).toEqual(["build", "build"]));

      // Honkd answers resend with JSON-RPC error
      client.failTurn(new GooseProtocolError(-32000, "session expired on honkd", "session destroyed"));
      await runner.settled();

      // Must report the resend error honestly as goose-turn-failed, NOT goose-turn-disconnected
      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Error");
      expect(stops[0]!.error_kind).toBe("goose-turn-failed");
      expect(stops[0]!.message).toContain("session expired on honkd: session destroyed");
      expect(stops[0]!.message).not.toMatch(/nothing was resent/i);
      expect(runner.isBusy()).toBe(false);
    });

    it("reports honestly when honkd answers resend with busy instead of steering", async () => {
      const { runner, client, stops } = makeRunner();
      client.isHonk = true;
      await runner.deliver("c1", "build");

      // Mid-turn disconnect
      client.dropSocket();
      client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));

      // Wait for reconnect to succeed and resend prompt to be issued
      await vi.waitFor(() => expect(client.prompts).toEqual(["build", "build"]));

      // Honkd answers resend with busy
      client.finishBusy("run_other");
      await runner.settled();

      // Must NOT attempt to steer (which would duplicate the prompt into the run)
      expect(client.steers).toEqual([]);
      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Error");
      expect(stops[0]!.error_kind).toBe("goose-turn-failed");
      expect(stops[0]!.message).toContain("was NOT delivered -- please send it again once the current turn finishes");
      expect(stops[0]!.message).not.toContain("honkd lost track of the request");
      expect(runner.isBusy()).toBe(false);
    });

    it("reports honk-specific lost contact message when reconnect budget is exhausted", async () => {
      let now = 1_000;
      const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        const { runner, client, stops } = makeRunner({
          honkReconnectBudgetMs: 50,
          honkReconnectInitialDelayMs: 10,
          honkReconnectMaxDelayMs: 20,
          sleep: async (ms: number) => {
            now += ms;
          },
        });
        client.isHonk = true;
        await runner.deliver("c1", "build");

        client.connectImpl = async () => {
          throw new Error("ECONNREFUSED");
        };
        client.dropSocket();
        client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));
        await runner.settled();

        expect(client.prompts).toEqual(["build"]);
        expect(stops).toHaveLength(1);
        expect(stops[0]!.event).toBe("Error");
        expect(stops[0]!.message).toContain(
          "lost contact with honkd; the turn may still be running and its reply was not collected",
        );
        expect(stops[0]!.message).not.toMatch(/goose cancels a turn/i);
        expect(runner.isBusy()).toBe(false);
      } finally {
        dateSpy.mockRestore();
      }
    });

    it("loops back to reconnect and resend when resend disconnects, succeeding on subsequent attempt", async () => {
      const { runner, client, stops } = makeRunner({
        honkReconnectBudgetMs: 5_000,
        honkReconnectInitialDelayMs: 10,
        honkReconnectMaxDelayMs: 50,
        sleep: async () => {},
      });
      client.isHonk = true;
      await runner.deliver("c1", "build");

      // Mid-turn disconnect 1
      client.dropSocket();
      client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));

      // Resend 1 issued
      await vi.waitFor(() => expect(client.prompts).toEqual(["build", "build"]));

      // Resend 1 also disconnects
      client.dropSocket();
      client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));

      // Resend 2 issued
      await vi.waitFor(() => expect(client.prompts).toEqual(["build", "build", "build"]));

      // Resend 2 succeeds
      client.finishTurn("end_turn", { text: "success after two disconnects" });
      await runner.settled();

      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Stop");
      expect(stops[0]!.message).toBe("success after two disconnects");
      expect(runner.isBusy()).toBe(false);
    });

    it("loops back to reconnect if resend itself disconnects, reporting honk-specific lost contact if budget exhausted", async () => {
      let now = 1_000;
      const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        const { runner, client, stops } = makeRunner({
          honkReconnectBudgetMs: 80,
          honkReconnectInitialDelayMs: 10,
          honkReconnectMaxDelayMs: 20,
          sleep: async (ms: number) => {
            now += ms;
          },
        });
        client.isHonk = true;
        await runner.deliver("c1", "build");

        // Mid-turn disconnect
        client.dropSocket();
        client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));

        // Wait for first resend prompt
        await vi.waitFor(() => expect(client.prompts).toEqual(["build", "build"]));

        // Resend prompt also disconnects
        client.dropSocket();
        // Make next reconnects fail until budget exhausted
        client.connectImpl = async () => {
          throw new Error("ECONNREFUSED");
        };
        client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));
        await runner.settled();

        expect(stops).toHaveLength(1);
        expect(stops[0]!.event).toBe("Error");
        expect(stops[0]!.message).toContain(
          "lost contact with honkd; the turn may still be running and its reply was not collected",
        );
        expect(stops[0]!.message).not.toMatch(/goose cancels a turn/i);
        expect(runner.isBusy()).toBe(false);
      } finally {
        dateSpy.mockRestore();
      }
    });

    it("leaves no orphaned open transport when deliver() reconnects during reconnect backoff", async () => {
      let sleeping = false;
      let sleepResolve: (() => void) | undefined;
      const sleepPromise = new Promise<void>((r) => {
        sleepResolve = r;
      });
      const { runner, client } = makeRunner({
        honkReconnectBudgetMs: 5_000,
        honkReconnectInitialDelayMs: 100,
        sleep: async () => {
          sleeping = true;
          await sleepPromise;
        },
      });
      client.isHonk = true;
      await runner.deliver("c1", "build");
      client.setRunId("20260918_1", "run_1");
      expect(client.openTransports).toBe(1);

      // Reconnect attempt 1 will fail
      client.connectImpl = async () => {
        throw new Error("ECONNREFUSED");
      };
      // Mid-turn disconnect
      client.dropSocket();
      expect(client.openTransports).toBe(0);

      client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));

      // Wait until reconnect attempt 1 fails and runner enters sleep in backoff
      await vi.waitFor(() => expect(sleeping).toBe(true));
      expect(client.connectCalls).toBe(2);

      // Now a concurrent deliver() arrives while sleeping, and its reconnect succeeds.
      client.connectImpl = async () => {};
      const deliverPromise = runner.deliver("c2", "steer text");
      await deliverPromise;
      expect(client.openTransports).toBe(1);
      expect(client.connectCalls).toBe(3); // 1 initial + 1 failed reconnect + 1 deliver reconnect

      // Wake the backoff sleep
      sleepResolve!();

      // Backoff loop continues: it must not force connected=false and call connect() again
      await vi.waitFor(() => expect(client.prompts).toEqual(["build", "build"]));
      expect(client.openTransports).toBe(1);
      expect(client.connectCalls).toBe(3);

      client.finishTurn("end_turn", { text: "done" });
      await runner.settled();
      expect(client.openTransports).toBe(1);
      runner.close();
      expect(client.openTransports).toBe(0);
    });

    it("ensures client ends closed when close() is called while connect is in flight", async () => {
      const { runner, client } = makeRunner();
      let resolveConnect: (() => void) | undefined;
      client.connectImpl = () =>
        new Promise<void>((r) => {
          resolveConnect = r;
        });

      const deliverPromise = runner.deliver("c1", "start");
      await vi.waitFor(() => expect(client.connectCalls).toBe(1));

      // Close runner while connect is still in flight
      runner.close();

      // Now connect resolves
      resolveConnect!();

      await expect(deliverPromise).rejects.toThrow(/closed/i);
      expect(client.isClosed()).toBe(true);
    });

    it("ends the loop with exactly one /stop when close() is called during a backoff sleep", async () => {
      let sleeping = false;
      const { runner, client, stops } = makeRunner({
        honkReconnectBudgetMs: 5_000,
        honkReconnectInitialDelayMs: 1_000,
        sleep: async () => {
          sleeping = true;
          // Unresolved promise that cancelSleep should resolve
          await new Promise(() => {});
        },
      });
      client.isHonk = true;
      await runner.deliver("c1", "build");

      // Mid-turn disconnect
      client.dropSocket();
      client.connectImpl = async () => {
        throw new Error("ECONNREFUSED");
      };
      client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));

      // Wait until reconnect attempt 1 fails and runner enters backoff sleep
      await vi.waitFor(() => expect(sleeping).toBe(true));

      // Close runner while sleeping in backoff
      runner.close();

      await runner.settled();

      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Error");
      expect(stops[0]!.error_kind).toBe("goose-turn-disconnected");
      expect(runner.isBusy()).toBe(false);
    });

    it("throws on deliver when runner is closed and does not connect", async () => {
      const { runner, client } = makeRunner();
      runner.close();
      expect(runner.isClosed).toBe(true);
      await expect(runner.deliver("c1", "hello")).rejects.toThrow(/closed/i);
      expect(client.connectCalls).toBe(0);
    });

    it("bails on reconnect and resend when runner is closed mid-reconnect, reporting turn as cancelled", async () => {
      const { runner, client, stops } = makeRunner();
      client.isHonk = true;
      await runner.deliver("c1", "build");

      // Mid-turn disconnect with connectImpl held pending
      let finishConnect: () => void = () => {};
      client.connectImpl = () =>
        new Promise<void>((resolve) => {
          finishConnect = () => {
            client.connected = true;
            client.closed = false;
            resolve();
          };
        });
      client.dropSocket();
      client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));

      // Runner is closed while reconnect is in flight
      runner.close();
      expect(runner.isClosed).toBe(true);

      // Finish connect
      finishConnect();
      await runner.settled();

      // No resend prompt was issued
      expect(client.prompts).toEqual(["build"]);
      // Idle socket timer must not be armed
      expect((runner as any).idleSocketTimer).toBeUndefined();
      // Turn settled reporting honest cancellation matching main (#168)
      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Error");
      expect(stops[0]!.error_kind).toBe("goose-turn-disconnected");
      expect(runner.isBusy()).toBe(false);
    });

    it("bails when runner is closed during the resend prompt", async () => {
      const { runner, client, stops } = makeRunner();
      client.isHonk = true;
      await runner.deliver("c1", "build");

      // Mid-turn disconnect
      client.dropSocket();
      client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));

      // Wait for reconnect to succeed and resend prompt to be issued
      await vi.waitFor(() => expect(client.prompts).toEqual(["build", "build"]));

      // Now runner is closed while resend prompt is in flight
      runner.close();
      client.dropSocket();
      client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));
      await runner.settled();

      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Error");
      expect(stops[0]!.error_kind).toBe("goose-turn-disconnected");
      expect((runner as any).idleSocketTimer).toBeUndefined();
      expect(runner.isBusy()).toBe(false);
    });

    it("never arms idleSocketTimer when runner is closed", async () => {
      const { runner, client } = makeRunner({ idleSocketTimeoutMs: 60_000 });
      client.isHonk = true;
      await runner.deliver("c1", "hello");
      runner.close();
      client.finishTurn();
      await runner.settled();

      expect((runner as any).idleSocketTimer).toBeUndefined();
    });

    it("clears the stall watchdog timer during reconnect so it cannot fire mid-reconnect", async () => {
      vi.useFakeTimers();
      try {
        const { runner, client, stops } = makeRunner({ turnIdleTimeoutMs: 5_000 });
        client.isHonk = true;
        // Ping fails on a dead socket
        client.pingImpl = async () => {
          if (client.isClosed()) throw new Error("dead socket");
        };
        await runner.deliver("c1", "build");

        // Mid-turn disconnect with connectImpl held pending
        let finishConnect: () => void = () => {};
        client.connectImpl = () =>
          new Promise<void>((resolve) => {
            finishConnect = () => {
              client.connected = true;
              client.closed = false;
              resolve();
            };
          });
        client.dropSocket();
        client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));

        // Advance timers past turnIdleTimeoutMs (5s) but within NON_TURN_TIMEOUT_MS (10s)
        await vi.advanceTimersByTimeAsync(6_000);

        // Watchdog should NOT have fired or abandoned turn during reconnect
        expect(stops).toHaveLength(0);

        // Finish reconnect
        finishConnect();
        await vi.waitFor(() => expect(client.prompts).toEqual(["build", "build"]));

        // Now prompt finishes
        client.finishTurn("end_turn", { text: "done" });
        await runner.settled();

        expect(stops).toHaveLength(1);
        expect(stops[0]!.event).toBe("Stop");
        expect(stops[0]!.error_kind).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("idle socket close", () => {
    it("closes the socket after being idle for idleSocketTimeoutMs", async () => {
      vi.useFakeTimers();
      try {
        const { runner, client } = makeRunner({ idleSocketTimeoutMs: 60_000 });
        client.isHonk = true;
        await runner.deliver("c1", "hello");
        client.finishTurn();
        await runner.settled();

        expect(client.closed).toBe(false);

        // Advance past idle socket timeout
        await vi.advanceTimersByTimeAsync(60_000);
        expect(client.closed).toBe(true);

        // Next deliver reconnects cleanly
        await runner.deliver("c2", "world");
        expect(client.connectCalls).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("resets the idle socket timer when a new turn starts before timeout", async () => {
      vi.useFakeTimers();
      try {
        const { runner, client } = makeRunner({ idleSocketTimeoutMs: 60_000 });
        client.isHonk = true;
        await runner.deliver("c1", "first");
        client.finishTurn();
        await runner.settled();

        // Advance halfway
        await vi.advanceTimersByTimeAsync(30_000);
        expect(client.closed).toBe(false);

        // Deliver second turn
        await runner.deliver("c2", "second");
        expect(client.closed).toBe(false);

        // Advance 40s (70s total since first turn, but second turn is active)
        await vi.advanceTimersByTimeAsync(40_000);
        expect(client.closed).toBe(false);

        // Finish second turn
        client.finishTurn();
        await runner.settled();

        // 30s after second turn: still not closed
        await vi.advanceTimersByTimeAsync(30_000);
        expect(client.closed).toBe(false);

        // 60s after second turn: closed
        await vi.advanceTimersByTimeAsync(30_000);
        expect(client.closed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never runs an idle socket timer during a turn longer than idleSocketTimeoutMs", async () => {
      vi.useFakeTimers();
      try {
        const { runner, client } = makeRunner({ idleSocketTimeoutMs: 60_000 });
        client.isHonk = true;
        await runner.deliver("c1", "long-in-flight");

        // The timer should not be armed during a turn
        expect((runner as any).idleSocketTimer).toBeUndefined();

        // Advance well past idleSocketTimeoutMs while turn is still running
        await vi.advanceTimersByTimeAsync(120_000);
        expect(client.closed).toBe(false);
        expect(runner.isBusy()).toBe(true);

        // Turn finishes normally
        client.finishTurn();
        await runner.settled();

        // Now idle socket timer should be armed
        expect((runner as any).idleSocketTimer).toBeDefined();

        // Advance past idle timeout: socket should close
        await vi.advanceTimersByTimeAsync(60_000);
        expect(client.closed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves no idle timer armed after abandonTurn", async () => {
      vi.useFakeTimers();
      try {
        const { runner, client, stops } = makeRunner({ turnIdleTimeoutMs: 5_000, idleSocketTimeoutMs: 60_000 });
        client.isHonk = true;
        client.pingImpl = async () => {
          throw new Error("dead");
        };
        await runner.deliver("c1", "stalling");

        await vi.advanceTimersByTimeAsync(6_000);

        expect(stops).toHaveLength(1);
        expect(stops[0]!.error_kind).toBe("goose-turn-stalled");
        expect(client.closed).toBe(true);
        expect((runner as any).idleSocketTimer).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not arm idle timer on clearTurn if socket is already closed", async () => {
      const { runner, client } = makeRunner({ idleSocketTimeoutMs: 60_000 });
      client.isHonk = true;
      await runner.deliver("c1", "test");
      client.dropSocket();
      client.failTurn(new Error("socket dropped"));
      await runner.settled();

      expect((runner as any).idleSocketTimer).toBeUndefined();
    });

    it("never arms idle socket timer for bare goose (isHonk false)", async () => {
      const { runner, client } = makeRunner({ idleSocketTimeoutMs: 60_000 });
      client.isHonk = false;
      await runner.deliver("c1", "hello");
      client.finishTurn();
      await runner.settled();

      expect((runner as any).idleSocketTimer).toBeUndefined();
    });

    it("arms idle socket timer after a steered turn continuation ends under honk", async () => {
      const { runner, client } = makeRunner({ idleSocketTimeoutMs: 60_000 });
      client.isHonk = true;
      await runner.deliver("c1", "first");
      client.setRunId("20260918_1", "run_live");
      await runner.deliver("c2", "steer me");
      client.finishTurn();
      await runner.settled();

      expect(runner.isBusy()).toBe(false);
      expect((runner as any).idleSocketTimer).toBeDefined();
    });

    it("does not resend when turn was abandoned under honk", async () => {
      vi.useFakeTimers();
      try {
        const { runner, client, stops } = makeRunner({ turnIdleTimeoutMs: 5_000, idleSocketTimeoutMs: 60_000 });
        client.isHonk = true;
        client.pingImpl = async () => {
          throw new Error("dead");
        };
        await runner.deliver("c1", "stalling");

        await vi.advanceTimersByTimeAsync(6_000);

        expect(stops).toHaveLength(1);
        expect(stops[0]!.error_kind).toBe("goose-turn-stalled");

        client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));
        await runner.settled();

        expect(client.prompts).toEqual(["stalling"]);
        expect(stops).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("GooseSessionRunner.cancel()", () => {
    it("when client is connected and not closed -> sends cancel with backend id and returns 'sent'", async () => {
      const { runner, client, stops } = makeRunner();
      // Connect runner by delivering a prompt
      await runner.deliver("c1", "hello");
      expect(client.connected).toBe(true);
      expect(client.isClosed()).toBe(false);

      const res = await runner.cancel();
      expect(res).toBe("sent");
      // Check that cancel was called with the backend sessionId
      expect(client.cancelCalls).toEqual(["20260918_1"]);
      // Does not emit notifications
      expect(stops).toHaveLength(0);
      // Does not close the client or change turn directly (drop/close handles that)
      expect(client.isClosed()).toBe(false);
    });

    it("when client is connected and cancel throws -> returns 'failed'", async () => {
      const { runner, client } = makeRunner();
      await runner.deliver("c1", "hello");
      client.cancelImpl = () => {
        throw new Error("transport send failed");
      };

      const res = await runner.cancel();
      expect(res).toBe("failed");
    });

    it("when not connected and client.isHonk is true -> connects and sends cancel, returns 'sent'", async () => {
      const { runner, client, stops } = makeRunner();
      client.isHonk = true;
      expect(client.connected).toBe(false);

      const res = await runner.cancel();
      expect(res).toBe("sent");
      expect(client.connectCalls).toBe(1);
      expect(client.cancelCalls).toEqual(["20260918_1"]);
      expect(stops).toHaveLength(0);
    });

    it("when not connected and client is bare goose (isHonk false) -> connects, sends nothing, returns 'no-connection'", async () => {
      const { runner, client, stops } = makeRunner();
      client.isHonk = false;
      expect(client.connected).toBe(false);

      const res = await runner.cancel();
      expect(res).toBe("no-connection");
      expect(client.connectCalls).toBe(1);
      expect(client.cancelCalls).toHaveLength(0);
      expect(stops).toHaveLength(0);
    });

    it("when not connected and connect fails -> returns 'failed'", async () => {
      const { runner, client } = makeRunner();
      client.connectImpl = async () => {
        throw new Error("connection refused");
      };

      const res = await runner.cancel();
      expect(res).toBe("failed");
      expect(client.cancelCalls).toHaveLength(0);
    });

    it("when not connected and connect times out (>3s) -> bounds connect and returns 'failed'", async () => {
      vi.useFakeTimers();
      try {
        const { runner, client } = makeRunner();
        client.connectImpl = () => new Promise(() => {}); // hangs indefinitely

        const cancelPromise = runner.cancel();
        // Advance past 3s timeout
        await vi.advanceTimersByTimeAsync(3_500);

        const res = await cancelPromise;
        expect(res).toBe("failed");
        expect(client.cancelCalls).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not start a turn, change turn state, or emit notifications", async () => {
      const { runner, client, stops } = makeRunner();
      client.isHonk = true;

      await runner.cancel();

      expect(runner.isBusy()).toBe(false);
      expect(stops).toHaveLength(0);
      expect(client.prompts).toHaveLength(0);
    });

    it("cancels during honk reconnect backoff: wakes sleep, sends cancel, and sends NO resend prompt", async () => {
      const { runner, client, stops } = makeRunner({
        honkReconnectBudgetMs: 30_000,
        honkReconnectInitialDelayMs: 5_000,
      });
      client.isHonk = true;

      await runner.deliver("c1", "initial-prompt");
      expect(client.prompts).toEqual(["initial-prompt"]);

      // Turn disconnects mid-flight
      client.dropSocket();
      client.failTurn(new DisconnectedDuringTurn("20260918_1", "run_1", 1006));

      // Runner catches DisconnectedDuringTurn and attempts first reconnect.
      // Make the first connect attempt fail so it enters backoff sleep.
      let connectAttempt = 0;
      let resolveSecondConnect: (() => void) | undefined;
      client.connectImpl = async () => {
        connectAttempt++;
        if (connectAttempt === 1) {
          throw new Error("honkd temporarily down");
        }
        await new Promise<void>((r) => {
          resolveSecondConnect = r;
        });
      };

      // Let the first failed connect run and enter backoff sleep
      await new Promise((r) => setTimeout(r, 50));

      // Now the loop is sleeping in backoff! Trigger cancel()!
      const cancelPromise = runner.cancel();

      // cancel() sets cancelRequested, cancels sleep, and calls ensureConnected().
      await new Promise((r) => setTimeout(r, 50));
      expect(resolveSecondConnect).toBeDefined();

      // Resolve the second connect
      resolveSecondConnect!();

      // cancel() should complete with "sent"
      const cancelOutcome = await cancelPromise;
      expect(cancelOutcome).toBe("sent");
      expect(client.cancelCalls).toEqual(["20260918_1"]);

      // Await turn settled
      await runner.settled();

      // Verify: NO second session/prompt was sent and NO stop notification posted!
      expect(client.prompts).toEqual(["initial-prompt"]);
      expect(stops).toHaveLength(0);
    });

    it("cancel() when client already closed: attempts reconnect; if reconnect fails returns 'failed'", async () => {
      const { runner, client } = makeRunner();
      client.close();
      client.connectImpl = async () => {
        throw new Error("cannot connect");
      };

      const res = await runner.cancel();
      expect(res).toBe("failed");
    });

    it("cancel() when client already closed: attempts reconnect; if bare goose returns 'no-connection'", async () => {
      const { runner, client } = makeRunner();
      client.close();
      client.isHonk = false;

      const res = await runner.cancel();
      expect(res).toBe("no-connection");
    });
  });

  describe("ownsActiveRun", () => {
    it("returns true only when client.runOwnership returns 'own'", () => {
      const { runner, client } = makeRunner();
      client.runOwnership = undefined;
      expect(runner.ownsActiveRun()).toBe(false);

      let ownership: "own" | "pending" | "foreign" | "unknown" = "pending";
      client.runOwnership = (sid: string) => {
        expect(sid).toBe("20260918_1");
        return ownership;
      };

      expect(runner.ownsActiveRun()).toBe(false);

      ownership = "foreign";
      expect(runner.ownsActiveRun()).toBe(false);

      ownership = "unknown";
      expect(runner.ownsActiveRun()).toBe(false);

      ownership = "own";
      expect(runner.ownsActiveRun()).toBe(true);
    });
  });

  describe("Queueing and serialization (spec bead eng-agent-platform-555.17)", () => {
    it("message during own run with run id -> steer", async () => {
      const { runner, client, inflight } = makeRunner();
      client.ownership = "own";
      await runner.deliver("c1", "first prompt");
      client.setRunId("20260918_1", "run_live");

      const res = await runner.deliver("c2", "steer prompt");
      expect(res.ok).toBe(true);
      expect(res.meta?.mode).toBe("steered");
      expect(client.steers).toEqual([{ runId: "run_live", text: "steer prompt" }]);
      expect(inflight.get("c2")).toBeUndefined();
    });

    it("message during pending / unknown / foreign / no-run-id-yet / recovered turn -> queued and NOT steered", async () => {
      // 1. Pending ownership
      const { runner, client, stops, inflight } = makeRunner();
      await runner.deliver("c1", "first");
      client.setRunId("20260918_1", "run_1");
      client.ownership = "pending";

      const resPending = await runner.deliver("c2_pending", "text pending");
      expect(resPending.ok).toBe(true);
      expect(resPending.meta?.mode).toBe("queued");
      expect(client.steers).toHaveLength(0);
      expect(inflight.get("c2_pending")?.state).toBe("queued");
      expect(stops).toHaveLength(1);
      expect(stops[0]!.event).toBe("Queued");
      expect(stops[0]!.notification_id).toBe(`s:${runner.sessionId}:c2_pending:queued`);
      expect(stops[0]!.message).toContain("goose is busy with a turn pigeon did not start");

      // 2. Unknown ownership
      client.ownership = "unknown";
      const resUnknown = await runner.deliver("c2_unknown", "text unknown");
      expect(resUnknown.ok).toBe(true);
      expect(resUnknown.meta?.mode).toBe("queued");
      expect(client.steers).toHaveLength(0);
      expect(inflight.get("c2_unknown")?.state).toBe("queued");

      // 3. Foreign ownership
      client.ownership = "foreign";
      const resForeign = await runner.deliver("c2_foreign", "text foreign");
      expect(resForeign.ok).toBe(true);
      expect(resForeign.meta?.mode).toBe("queued");
      expect(client.steers).toHaveLength(0);
      expect(inflight.get("c2_foreign")?.state).toBe("queued");

      // 4. No run id yet (own ownership, but no run id)
      const r4 = makeRunner();
      r4.client.ownership = "own";
      await r4.runner.deliver("c1_b", "first b");
      // no setRunId called
      const resNoRunId = await r4.runner.deliver("c2_norunid", "text norunid");
      expect(resNoRunId.ok).toBe(true);
      expect(resNoRunId.meta?.mode).toBe("queued");
      expect(r4.client.steers).toHaveLength(0);
      expect(r4.inflight.get("c2_norunid")?.state).toBe("queued");

      // 5. Recovered turn
      const r5 = makeRunner();
      r5.client.ownership = "own";
      r5.client.setRunId("20260918_1", "run_rec");
      const recRow: GooseInflightRecord = {
        commandId: "c_rec",
        sessionId: "sess_test",
        backendSessionId: "20260918_1",
        isHonk: true,
        promptText: "recovered turn",
        recoveryAttempts: 0,
        createdAt: 100,
        updatedAt: 100,
        lastAliveAt: 100,
        cleanSuspend: true,
        state: "sent",
      };
      r5.inflight.insert(recRow);
      r5.runner.resume(recRow);

      const resRecovered = await r5.runner.deliver("c2_rec", "text rec");
      expect(resRecovered.ok).toBe(true);
      expect(resRecovered.meta?.mode).toBe("queued");
      expect(r5.client.steers).toHaveLength(0);
      expect(r5.inflight.get("c2_rec")?.state).toBe("queued");
    });

    it("already-queued redelivery -> ok:true meta.mode already-queued (no second notice)", async () => {
      const { runner, client, stops, inflight } = makeRunner();
      await runner.deliver("c1", "first");
      client.ownership = "foreign";

      const res1 = await runner.deliver("c2", "queued text");
      expect(res1.ok).toBe(true);
      expect(res1.meta?.mode).toBe("queued");
      expect(stops).toHaveLength(1);

      const res2 = await runner.deliver("c2", "queued text");
      expect(res2.ok).toBe(true);
      expect(res2.meta?.mode).toBe("already-queued");
      expect(stops).toHaveLength(1); // No second notice
    });

    it("no turn of ours but queue non-empty -> enqueue (order)", async () => {
      const { runner, client, inflight } = makeRunner();
      await runner.deliver("c0", "turn 0");
      client.runStateValue = "running"; // foreign turn running
      client.ownership = "foreign";

      // With c0 in flight and ownership foreign, c1 is queued:
      const res1 = await runner.deliver("c1", "first queued");
      expect(res1.meta?.mode).toBe("queued");
      expect(inflight.get("c1")?.state).toBe("queued");

      // c0 finishes, so no turn of ours, but queue has c1 and client is still running foreign run:
      client.finishTurn();
      await runner.settled();

      // c2 is delivered while queue is non-empty:
      const res2 = await runner.deliver("c2", "second queued");
      expect(res2.ok).toBe(true);
      expect(res2.meta?.mode).toBe("queued");
      expect(inflight.get("c2")?.state).toBe("queued");
    });

    it("busy on honk -> queued (no steer call, no stop notice), drained with fresh prompt using same commandId as clientReqId when onRunStateChange reports idle", async () => {
      const { runner, client, stops, inflight } = makeRunner();
      client.isHonk = true;

      await runner.deliver("c1", "prompt honk");
      expect(inflight.get("c1")?.state).toBe("sent");

      // Honkd rejects with busy while foreign turn is running
      client.runStateValue = "running";
      client.finishBusy("run_other");
      await runner.settled();

      expect(client.steers).toHaveLength(0); // Did NOT steer
      expect(inflight.get("c1")?.state).toBe("queued"); // Marked queued
      expect(stops).toHaveLength(1); // Posted Queued notice
      expect(stops[0]!.event).toBe("Queued");
      expect(stops[0]!.notification_id).toBe(`s:${runner.sessionId}:c1:queued`);
      expect(runner.isBusy()).toBe(false);

      // Now foreign run ends: onRunStateChange reports idle
      client.runStateValue = "idle";
      runner.onRunStateChange({ state: "idle", ownership: "unknown" });

      // Allow microtask to run maybeDrain
      await new Promise((r) => setTimeout(r, 20));

      expect(client.prompts).toEqual(["prompt honk", "prompt honk"]);
      expect(client.promptOptions[1]).toEqual({ clientReqId: "c1" });
      expect(inflight.get("c1")?.state).toBe("sent");
    });

    it("busy on bare goose -> still steers", async () => {
      const { runner, client } = makeRunner();
      client.isHonk = false;

      await runner.deliver("c1", "prompt bare");
      client.finishBusy("run_bare_live");
      await runner.settled();

      expect(client.steers).toEqual([{ runId: "run_bare_live", text: "prompt bare" }]);
    });

    it("drain order FIFO, one turn at a time", async () => {
      const { runner, client } = makeRunner();
      client.isHonk = true;
      await runner.deliver("c0", "turn 0");
      client.runStateValue = "running";
      client.ownership = "foreign";

      await runner.deliver("c1", "turn 1");
      await runner.deliver("c2", "turn 2");
      await runner.deliver("c3", "turn 3");

      expect(client.prompts).toEqual(["turn 0"]);

      // c0 finishes
      client.finishTurn();
      await runner.settled();

      // Foreign run completes: idle
      client.runStateValue = "idle";
      runner.onRunStateChange({ state: "idle", ownership: "unknown" });
      await new Promise((r) => setTimeout(r, 20));

      // c1 should be prompted, but NOT c2 or c3 yet (one turn at a time)
      expect(client.prompts).toEqual(["turn 0", "turn 1"]);
      expect(runner.isBusy()).toBe(true);

      // Finish c1
      client.finishTurn();
      await runner.settled();
      await new Promise((r) => setTimeout(r, 20));

      // c2 is prompted
      expect(client.prompts).toEqual(["turn 0", "turn 1", "turn 2"]);

      // Finish c2
      client.finishTurn();
      await runner.settled();
      await new Promise((r) => setTimeout(r, 20));

      // c3 is prompted
      expect(client.prompts).toEqual(["turn 0", "turn 1", "turn 2", "turn 3"]);
    });

    it("busy during drain -> back to the front, no duplicate notice", async () => {
      const { runner, client, stops, inflight } = makeRunner();
      client.isHonk = true;
      await runner.deliver("c0", "turn 0");
      client.runStateValue = "running";
      client.ownership = "foreign";

      await runner.deliver("c1", "turn 1");
      expect(stops).toHaveLength(1); // 1 queued notice

      client.finishTurn();
      await runner.settled();

      // Trigger drain
      client.runStateValue = "idle";
      runner.onRunStateChange({ state: "idle", ownership: "unknown" });
      await new Promise((r) => setTimeout(r, 20));

      expect(client.prompts).toEqual(["turn 0", "turn 1"]);

      // Turn 1 hits busy again during drain
      client.runStateValue = "running";
      client.finishBusy("run_busy_again");
      await runner.settled();

      expect(inflight.get("c1")?.state).toBe("queued");
      const queuedStops = stops.filter((s) => s.event === "Queued");
      expect(queuedStops).toHaveLength(1); // NO duplicate notice posted!
    });

    it("idle socket not closed while queued", async () => {
      const { runner, client } = makeRunner({ idleSocketTimeoutMs: 50 });
      client.isHonk = true;
      await client.connect();
      await runner.deliver("c0", "turn 0");
      client.runStateValue = "running";
      client.ownership = "foreign";

      await runner.deliver("c1", "queued turn");
      expect(client.isClosed()).toBe(false);

      // Wait past idle socket timeout
      await new Promise((r) => setTimeout(r, 80));

      // Socket must NOT have been closed while queue is non-empty
      expect(client.isClosed()).toBe(false);
    });

    it("fallback timer drains", async () => {
      const { runner, client } = makeRunner({ drainFallbackIntervalMs: 50 });
      client.isHonk = true;
      await runner.deliver("c0", "turn 0");
      client.runStateValue = "running";
      client.ownership = "foreign";

      await runner.deliver("c1", "fallback drain test");
      expect(client.prompts).toEqual(["turn 0"]);

      client.finishTurn();
      await runner.settled();

      // Suppose honk goes idle, but no onRunStateChange notification is received
      client.runStateValue = "idle";

      // Wait for fallback timer (50ms)
      await new Promise((r) => setTimeout(r, 80));

      expect(client.prompts).toEqual(["turn 0", "fallback drain test"]);
    });

    it("late _honk/steer_unconsumed after the receipt still finds its entry until a new turn starts", async () => {
      const { runner, client, stops, inflight } = makeRunner();
      client.ownership = "own";
      client.setRunId("20260918_1", "run_1");
      client.steerOutcome = { kind: "steered", runId: "run_1", messageId: "steer_msg_99" };

      await runner.deliver("c1", "first");
      await runner.deliver("c2", "steer text");

      expect(client.steers).toHaveLength(1);
      expect(stops).toHaveLength(0);

      // Finish turn: receipt arrives, turn settles
      client.finishTurn();
      await runner.settled();
      expect(runner.isBusy()).toBe(false);

      // Late steer_unconsumed arrives after receipt
      runner.onSteerUnconsumed("steer_msg_99");

      expect(inflight.get("c2")?.state).toBe("queued");
      const queuedStops = stops.filter((s) => s.event === "Queued");
      expect(queuedStops).toHaveLength(1);
      expect(queuedStops[0]!.notification_id).toBe(`s:${runner.sessionId}:c2:queued`);
      expect(queuedStops[0]!.message).toBe("your message reached goose too late for the turn it was added to; queued");

      // Now a new turn starts: sentSteers is cleared
      client.runStateValue = "running";
      await runner.deliver("c3", "third");

      // A repeat of steer_msg_99 now does nothing
      runner.onSteerUnconsumed("steer_msg_99");
      expect(stops.filter((s) => s.notification_id === `s:${runner.sessionId}:c2:queued`)).toHaveLength(1);
    });

    it("runner.dropQueued() deletes queued rows and returns count", async () => {
      const { runner, client, inflight } = makeRunner();
      await runner.deliver("c0", "turn 0");
      client.runStateValue = "running";
      client.ownership = "foreign";

      await runner.deliver("c1", "q1");
      await runner.deliver("c2", "q2");
      expect(inflight.get("c1")?.state).toBe("queued");
      expect(inflight.get("c2")?.state).toBe("queued");

      const dropped = runner.dropQueued();
      expect(dropped).toBe(2);
      expect(inflight.get("c1")).toBeUndefined();
      expect(inflight.get("c2")).toBeUndefined();
    });

    it("busy with runState unknown does not re-prompt until fallback timer or run-state change", async () => {
      const { runner, client } = makeRunner();
      client.isHonk = true;
      client.runStateValue = "unknown";

      await runner.deliver("c1", "first prompt");
      expect(client.prompts).toEqual(["first prompt"]);

      // Honkd rejects with busy while runState is unknown
      client.finishBusy("run_live");
      await runner.settled();

      // Wait a bit for any drain microtask
      await new Promise((r) => setTimeout(r, 20));

      // Must NOT have immediately re-prompted!
      expect(client.prompts).toEqual(["first prompt"]);

      // State changes to idle
      client.runStateValue = "idle";
      runner.onRunStateChange({ state: "idle", ownership: "unknown" });
      await new Promise((r) => setTimeout(r, 20));

      // Now it re-prompts
      expect(client.prompts).toEqual(["first prompt", "first prompt"]);
    });

    it("a queued item is not prompted until the previous turn's postStop has resolved", async () => {
      let resolvePostStop: () => void;
      const postStopPromise = new Promise<void>((r) => {
        resolvePostStop = r;
      });

      const { runner, client } = makeRunner({
        postStop: async (body: Record<string, unknown>) => {
          // If body is for the finishing turn c0 (event Stop), hang until resolved
          if (body.event === "Stop" || (typeof body.notification_id === "string" && body.notification_id.includes(":c0"))) {
            await postStopPromise;
          }
        },
      });
      client.isHonk = true;

      // Start turn c0
      await runner.deliver("c0", "turn 0");
      client.runStateValue = "running";
      client.ownership = "foreign";

      // Queue turn c1
      await runner.deliver("c1", "turn 1");

      // c0 finishes on client
      client.runStateValue = "idle";
      client.finishTurn("end_turn", { text: "done 0" });

      // Wait a tick for any microtask
      await new Promise((r) => setTimeout(r, 20));

      // PostStop is still pending, so c1 must NOT have been prompted yet
      expect(client.prompts).toEqual(["turn 0"]);

      // Now postStop resolves
      resolvePostStop!();
      await runner.settled();
      await new Promise((r) => setTimeout(r, 20));

      // Now c1 has drained and been prompted
      expect(client.prompts).toEqual(["turn 0", "turn 1"]);
    });

    it("redelivery of head commandId while drain is connecting returns already-queued (no SQLite PK error, no second turn)", async () => {
      const { runner, client } = makeRunner();
      client.isHonk = true;

      // Queue an item c1
      await runner.deliver("c0", "turn 0");
      client.runStateValue = "running";
      client.ownership = "foreign";
      await runner.deliver("c1", "text c1");

      // Set up connectImpl to hang
      let resolveConnect: () => void;
      const connectPromise = new Promise<void>((r) => {
        resolveConnect = r;
      });
      // Drop connection so drain has to call ensureConnected()
      client.close();
      client.connectImpl = () => connectPromise;

      // Finish c0 and report idle to trigger drain
      client.runStateValue = "idle";
      client.finishTurn();
      await runner.settled();
      runner.onRunStateChange({ state: "idle", ownership: "unknown" });
      await new Promise((r) => setTimeout(r, 20));

      // Drain is now waiting in ensureConnected().
      // Redeliver c1 while drain is connecting:
      const redeliverRes = await runner.deliver("c1", "text c1");
      expect(redeliverRes.ok).toBe(true);
      expect(redeliverRes.meta?.mode).toBe("already-queued");

      // Connect completes
      resolveConnect!();
      await new Promise((r) => setTimeout(r, 20));

      expect(client.prompts).toEqual(["turn 0", "text c1"]); // no second turn
    });

    it("a distinct new message while drain is connecting is queued behind, not started concurrently", async () => {
      const { runner, client, inflight } = makeRunner();
      client.isHonk = true;

      // Queue an item c1
      await runner.deliver("c0", "turn 0");
      client.runStateValue = "running";
      client.ownership = "foreign";
      await runner.deliver("c1", "text c1");

      // Set up connectImpl to hang
      let resolveConnect: () => void;
      const connectPromise = new Promise<void>((r) => {
        resolveConnect = r;
      });
      client.close();
      client.connectImpl = () => connectPromise;

      // Finish c0 and report idle to trigger drain
      client.runStateValue = "idle";
      client.finishTurn();
      await runner.settled();
      runner.onRunStateChange({ state: "idle", ownership: "unknown" });
      await new Promise((r) => setTimeout(r, 20));

      // Deliver distinct new message c2 while drain of c1 is connecting:
      const res2 = await runner.deliver("c2", "text c2");
      expect(res2.ok).toBe(true);
      expect(res2.meta?.mode).toBe("queued");
      expect(inflight.get("c2")?.state).toBe("queued");

      // Connect completes
      resolveConnect!();
      await new Promise((r) => setTimeout(r, 20));

      // Only c1 started, c2 is queued behind it
      expect(client.prompts).toEqual(["turn 0", "text c1"]);
      expect(runner.isBusy()).toBe(true);

      // Finish c1
      client.finishTurn();
      await runner.settled();
      await new Promise((r) => setTimeout(r, 20));

      // c2 runs next
      expect(client.prompts).toEqual(["turn 0", "text c1", "text c2"]);
    });

    it("close() during the connect await starts nothing", async () => {
      const { runner, client } = makeRunner();
      client.isHonk = true;

      // Queue an item c1
      await runner.deliver("c0", "turn 0");
      client.runStateValue = "running";
      client.ownership = "foreign";
      await runner.deliver("c1", "text c1");

      // Set up connectImpl to hang
      let resolveConnect: () => void;
      const connectPromise = new Promise<void>((r) => {
        resolveConnect = r;
      });
      client.close();
      client.connectImpl = () => connectPromise;

      // Finish c0 and trigger drain
      client.runStateValue = "idle";
      client.finishTurn();
      await runner.settled();
      runner.onRunStateChange({ state: "idle", ownership: "unknown" });
      await new Promise((r) => setTimeout(r, 20));

      // Close runner while connect is awaiting
      runner.close();
      resolveConnect!();
      await new Promise((r) => setTimeout(r, 20));

      // c1 should never have been started
      expect(client.prompts).toEqual(["turn 0"]);
    });

    it("runState stuck 'running', fallback tick probes: prompt sent; busy again -> re-queued at front, no duplicate notice; next tick probes again", async () => {
      const { runner, client, stops, inflight } = makeRunner({ drainFallbackIntervalMs: 50 });
      client.isHonk = true;
      client.runStateValue = "running";
      client.ownership = "foreign";

      // Queue an item c1
      await runner.deliver("c0", "turn 0");
      await runner.deliver("c1", "queued probe test");
      expect(stops.filter((s) => s.event === "Queued")).toHaveLength(1);

      client.finishTurn(); // c0 finishes
      await runner.settled();

      // Client says runState is still "running", but c0 finished and queue has c1
      expect(client.prompts).toEqual(["turn 0"]);

      // Wait 70ms for fallback timer tick
      await new Promise((r) => setTimeout(r, 70));

      // Fallback tick should have probed by starting c1 despite runState="running"!
      expect(client.prompts).toEqual(["turn 0", "queued probe test"]);

      // Prompt returns busy again
      client.finishBusy("run_still_busy");
      await runner.settled();

      // Re-queued at front, NO duplicate notice
      expect(inflight.get("c1")?.state).toBe("queued");
      expect(stops.filter((s) => s.event === "Queued")).toHaveLength(1);

      // Next tick (after another 70ms) probes again
      await new Promise((r) => setTimeout(r, 70));
      expect(client.prompts).toEqual(["turn 0", "queued probe test", "queued probe test"]);
    });

    it("steer unconsumed arriving BEFORE steer() promise resolves enqueues with too-late notice", async () => {
      const { runner, client, stops, inflight } = makeRunner();
      client.ownership = "own";
      client.setRunId("20260918_1", "run_1");

      let resolveSteer: (v: unknown) => void;
      const steerPromise = new Promise((r) => {
        resolveSteer = r;
      });
      client.steerImpl = () => steerPromise;

      await runner.deliver("c1", "first");
      const deliverSteerPromise = runner.deliver("c2", "steer text");

      // Now unconsumed notification arrives BEFORE steer promise resolves!
      runner.onSteerUnconsumed("steer_race_msg");

      // Now steer promise resolves with messageId matching the unconsumed message
      resolveSteer!({ kind: "steered", runId: "run_1", messageId: "steer_race_msg" });
      const res = await deliverSteerPromise;

      expect(res.ok).toBe(true);
      expect(res.meta?.mode).toBe("queued");
      expect(inflight.get("c2")?.state).toBe("queued");

      const queuedStops = stops.filter((s) => s.event === "Queued");
      expect(queuedStops).toHaveLength(1);
      expect(queuedStops[0]!.notification_id).toBe(`s:${runner.sessionId}:c2:queued`);
      expect(queuedStops[0]!.message).toBe("your message reached goose too late for the turn it was added to; queued");
    });

    it("drain starts a turn while deliver is awaiting connect -> deliver's message is queued, only one prompt in flight", async () => {
      const { runner, client, inflight } = makeRunner();
      client.isHonk = true;

      // Disconnect so next deliver must connect
      client.close();
      let resolveConnect: () => void;
      const connectPromise = new Promise<void>((r) => {
        resolveConnect = r;
      });
      client.connectImpl = () => connectPromise;

      // Deliver c_user: begins ensureConnected and awaits connectPromise
      const deliverPromise = runner.deliver("c_user", "user text");

      // While deliver is awaiting connect, enqueue a recovered turn and start it
      const row: GooseInflightRecord = {
        commandId: "c_drain",
        sessionId: "20260918_1",
        backendSessionId: "20260918_1",
        isHonk: true,
        promptText: "drain prompt",
        recoveryAttempts: 0,
        createdAt: 100,
        updatedAt: 100,
        lastAliveAt: 100,
        cleanSuspend: true,
        state: "queued",
      };
      inflight.insert(row);
      runner.enqueueRecovered(row);

      // Now connect succeeds: drain starts c_drain as turn
      resolveConnect!();
      await new Promise((r) => setTimeout(r, 20));

      const deliverRes = await deliverPromise;
      expect(deliverRes.ok).toBe(true);
      expect(deliverRes.meta?.mode).toBe("queued");

      // Only c_drain is in flight, NOT c_user
      expect(client.prompts).toEqual(["drain prompt"]);
      expect(runner.isBusy()).toBe(true);
      expect(inflight.get("c_user")?.state).toBe("queued");
    });
  });

  describe("bead eng-agent-platform-555.18: permission deferred notice", () => {
    it("posts notice once per turn when deferred/held during pigeon's own tracked turn", async () => {
      const { runner, stops } = makeRunner();
      await runner.deliver("cmd-perm-1", "do work");
      expect(runner.isBusy()).toBe(true);

      // Request deferred/held
      await runner.onPermissionDeferred({ held: true, ownership: "pending" });

      const permStops = stops.filter((s) => s.event === "Permission");
      expect(permStops).toHaveLength(1);
      expect(permStops[0]).toMatchObject({
        session_id: "20260918_1",
        notification_id: "s:20260918_1:cmd-perm-1:permission",
        event: "Permission",
        message:
          "goose is asking permission for a tool call, and pigeon cannot confirm this run is its own (for example after a reconnect), so it did not answer. Answer it in honk chat.",
      });

      // Deferred again in the same turn -> no second notice
      await runner.onPermissionDeferred({ held: true, ownership: "pending" });
      expect(stops.filter((s) => s.event === "Permission")).toHaveLength(1);
    });

    it("does not post notice for foreign runs without a pigeon turn in flight", async () => {
      const { runner, stops } = makeRunner();
      expect(runner.isBusy()).toBe(false);

      await runner.onPermissionDeferred({ held: false, ownership: "foreign" });
      expect(stops).toHaveLength(0);
    });

    it("does not post notice when detail.held is false even with a pigeon turn in flight", async () => {
      const { runner, stops } = makeRunner();
      await runner.deliver("cmd-perm-foreign-defer", "do work");
      expect(runner.isBusy()).toBe(true);

      // Foreign deferral (held is false)
      await runner.onPermissionDeferred({ held: false, ownership: "foreign" });
      expect(stops.filter((s) => s.event === "Permission")).toHaveLength(0);
    });
  });
});

