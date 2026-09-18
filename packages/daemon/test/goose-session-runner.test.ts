import { describe, it, expect, vi } from "vitest";
import { GooseSessionRunner, GooseRunnerRegistry } from "../src/goose/session-runner.js";
import type { SessionRecord } from "../src/storage/types.js";

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
  /** Resolvers for in-flight prompts, keyed by the text that started them. */
  private turns: Array<{ text: string; resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  prompts: string[] = [];
  steers: Array<{ runId: string; text: string }> = [];
  steerOutcome: unknown = { kind: "steered", runId: "run_1", messageId: "m1" };
  connectImpl: () => Promise<void> = async () => {
    this.connected = true;
    this.closed = false;
  };
  /** Simulate the socket dropping under us without anyone calling close(). */
  dropSocket(): void {
    this.closed = true;
  }
  private runIds = new Map<string, string>();

  async connect(): Promise<void> {
    this.connectCalls++;
    await this.connectImpl();
  }
  prompt(_sessionId: string, text: string): Promise<unknown> {
    this.prompts.push(text);
    return new Promise((resolve, reject) => this.turns.push({ text, resolve, reject }));
  }
  steerImpl: (() => Promise<unknown>) | undefined;
  async steer(_sessionId: string, runId: string, text: string): Promise<unknown> {
    this.steers.push({ runId, text });
    if (this.steerImpl) return this.steerImpl();
    return this.steerOutcome;
  }
  activeRunId(sessionId: string): string | undefined {
    return this.runIds.get(sessionId);
  }
  isClosed(): boolean {
    return this.closed;
  }
  close(): void {
    this.closed = true;
  }

  // --- test controls ---
  setRunId(sessionId: string, runId: string): void {
    this.runIds.set(sessionId, runId);
  }
  finishTurn(stopReason = "end_turn"): void {
    this.turns.shift()?.resolve({ kind: "receipt", stopReason, usage: { totalTokens: 10 } });
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
  const runner = new GooseSessionRunner({
    session: session(),
    client: client as never,
    postStop: async (body) => {
      stops.push(body);
    },
    touch: (id) => touches.push(id),
    log: () => {},
    ...over,
  });
  return { runner, client, stops, touches };
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

  it("ignores tool chatter in the reported message but counts it as liveness", async () => {
    const { runner, client, stops } = makeRunner();
    await runner.deliver("c1", "x");
    runner.onUpdate({ sessionUpdate: "tool_call", title: "shell" });
    runner.onUpdate({ sessionUpdate: "usage_update", used: 12 });
    runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } });
    client.finishTurn();
    await runner.settled();

    expect(stops[0]!.message).toBe("answer");
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
