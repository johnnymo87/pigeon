import { describe, it, expect, vi } from "vitest";
import {
  GooseAcpClient,
  ALLOWED_ACP_METHODS,
  DEFAULT_SESSION_EXTENSIONS,
  DEFAULT_SERVE_FLOOR,
  DisconnectedDuringTurn,
  type AcpTransport,
  type AcpTransportFactory,
} from "../src/goose/acp-client.js";

/**
 * A fake ACP peer driven message-by-message.
 *
 * Deliberately NOT a WebSocket server. The client takes an injected transport
 * precisely so delivery semantics can be tested without sockets, timing, or a
 * live model. The real socket is a thin adapter validated against a real
 * `goose serve` by scripts/goose-acp-probe.ts, not here.
 */
class FakePeer implements AcpTransport {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  private msgCb: ((d: string) => void) | undefined;
  private closeCb: ((c: number, r: string) => void) | undefined;
  /** Set by the test to script replies to outbound requests. */
  onRequest: (msg: Record<string, unknown>, peer: FakePeer) => void = () => {};

  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    this.onRequest(msg, this);
  }
  onMessage(cb: (d: string) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: (c: number, r: string) => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.closed = true;
  }

  /** Deliver a server->client frame. */
  emit(obj: unknown): void {
    this.msgCb?.(JSON.stringify(obj));
  }
  /** Reply to a client request by id. */
  reply(id: unknown, result: unknown): void {
    this.emit({ jsonrpc: "2.0", id, result });
  }
  replyError(id: unknown, code: number, message: string, data?: string): void {
    this.emit({ jsonrpc: "2.0", id, error: { code, message, data } });
  }
  /** Simulate the socket dropping. */
  drop(code = 1006): void {
    this.closeCb?.(code, "abnormal");
  }
  lastOf(method: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((m) => m.method === method);
  }
  countOf(method: string): number {
    return this.sent.filter((m) => m.method === method).length;
  }
}

/**
 * Answers initialize/session-new so tests can get to the interesting part.
 *
 * `session/new` reports `_meta.extensionResults` because THE REAL SERVE DOES:
 * measured against goose 1.48.0, a session/new response carries
 * `{ extensionResults: [{name, success}], workingDir }`
 * (acp/response_builder.rs:80-94). A fake that omitted it would be asserting
 * that the field is optional, and every caller of `newSession` would then be
 * tested against a serve that does not exist.
 *
 * The default answer is the four default extensions because that is what a
 * bare `goose serve` 1.48.0 actually returned for the default request -- arm 2
 * of eng-agent-platform experiments/2026-09-22-goose-extension-probe.mjs.
 */
const DEFAULT_LOADED = ["analyze", "developer", "skills", "todo"];

function autoHandshake(
  peer: FakePeer,
  extensionNames: string[] = DEFAULT_LOADED,
  extraResults: Array<Record<string, unknown>> = [],
): void {
  peer.onRequest = (msg, p) => {
    if (msg.method === "initialize") {
      p.reply(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === "session/new") {
      p.reply(msg.id, {
        sessionId: "sess-1",
        _meta: {
          extensionResults: [
            ...extensionNames.map((name) => ({ name, success: true })),
            ...extraResults,
          ],
          workingDir: "/tmp/x",
        },
      });
    }
  };
}

function makeClient(peer: FakePeer, opts: Record<string, unknown> = {}) {
  const factory: AcpTransportFactory = () => peer;
  return new GooseAcpClient({
    url: "ws://fake/acp",
    transportFactory: factory,
    log: () => {},
    ...opts,
  });
}

describe("GooseAcpClient", () => {
  describe("R1: disconnect mid-turn is silent loss, so it must be loud here", () => {
    it("rejects an outstanding prompt with DisconnectedDuringTurn naming the session", async () => {
      const peer = new FakePeer();
      autoHandshake(peer);
      const client = makeClient(peer);
      await client.connect();

      const inFlight = client.prompt("sess-1", "do the thing");
      // The turn is running; the socket dies.
      peer.drop();

      await expect(inFlight).rejects.toBeInstanceOf(DisconnectedDuringTurn);
      await inFlight.catch((e: DisconnectedDuringTurn) => {
        expect(e.sessionId).toBe("sess-1");
        // The prompt is already persisted in goose's history with no run.
        // The message has to say so -- that is the whole point of the class.
        expect(e.message).toMatch(/may already be persisted|no turn/i);
      });
    });

    it("names the active run id in the failure when one was observed", async () => {
      const peer = new FakePeer();
      autoHandshake(peer);
      const client = makeClient(peer);
      await client.connect();

      const inFlight = client.prompt("sess-1", "first");
      // A concurrent send reveals the run id via the busy rejection.
      const busyProbe = client.prompt("sess-1", "second");
      const probeReq = peer.sent.filter((m) => m.method === "session/prompt")[1]!;
      peer.replyError(
        probeReq.id,
        -32602,
        "Invalid params",
        "session already has active run `run_abc123`; use _goose/unstable/session/steer",
      );
      await busyProbe;

      peer.drop();
      const err = await inFlight.catch((e: DisconnectedDuringTurn) => e);
      expect(err).toBeInstanceOf(DisconnectedDuringTurn);
      expect((err as DisconnectedDuringTurn).runId).toBe("run_abc123");
    });

    it("does not fire DisconnectedDuringTurn when nothing is in flight", async () => {
      const peer = new FakePeer();
      autoHandshake(peer);
      const onLost = vi.fn();
      const client = makeClient(peer, { onTurnLost: onLost });
      await client.connect();
      peer.drop();
      expect(onLost).not.toHaveBeenCalled();
    });
  });

  describe("turn-end receipt", () => {
    it("resolves with stopReason only when the turn ends, not when the call is accepted", async () => {
      const peer = new FakePeer();
      autoHandshake(peer);
      const client = makeClient(peer);
      await client.connect();

      const p = client.prompt("sess-1", "hello");
      const req = peer.lastOf("session/prompt")!;

      // Mid-turn notifications must NOT resolve the promise.
      peer.emit({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk" } } });
      let settled = false;
      void p.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);

      peer.reply(req.id, { stopReason: "end_turn", usage: { totalTokens: 42 } });
      const res = await p;
      expect(res).toEqual({ kind: "receipt", stopReason: "end_turn", usage: { totalTokens: 42 } });
    });

    it("has no client-side turn deadline (R4): a long turn still resolves", async () => {
      vi.useFakeTimers();
      try {
        const peer = new FakePeer();
        autoHandshake(peer);
        const client = makeClient(peer);
        await client.connect();
        const p = client.prompt("sess-1", "slow");
        // Ten minutes -- far past the 30s cap the opencode client imposes.
        await vi.advanceTimersByTimeAsync(600_000);
        peer.reply(peer.lastOf("session/prompt")!.id, { stopReason: "end_turn" });
        await expect(p).resolves.toMatchObject({ kind: "receipt" });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("busy is a routing signal, not a failure", () => {
    it("parses the busy rejection into a typed result carrying the run id", async () => {
      const peer = new FakePeer();
      autoHandshake(peer);
      const client = makeClient(peer);
      await client.connect();

      const p = client.prompt("sess-1", "x");
      peer.replyError(
        peer.lastOf("session/prompt")!.id,
        -32602,
        "Invalid params",
        "session already has active run `run_60872e29-4962-4804-8ae2-5b2bde2d919b`; use _goose/unstable/session/steer",
      );
      await expect(p).resolves.toEqual({
        kind: "busy",
        runId: "run_60872e29-4962-4804-8ae2-5b2bde2d919b",
      });
    });

    it("does not mistake an unrelated -32602 for busy", async () => {
      const peer = new FakePeer();
      autoHandshake(peer);
      const client = makeClient(peer);
      await client.connect();
      const p = client.prompt("sess-1", "x");
      peer.replyError(peer.lastOf("session/prompt")!.id, -32602, "Invalid params", "missing field `prompt`");
      await expect(p).rejects.toThrow(/missing field/);
    });
  });

  describe("steer, with compare-and-swap", () => {
    it("sends expectedRunId and resolves with the steer message id", async () => {
      const peer = new FakePeer();
      autoHandshake(peer);
      const client = makeClient(peer);
      await client.connect();

      const p = client.steer("sess-1", "run_abc", "new instructions");
      const req = peer.lastOf("_goose/unstable/session/steer")!;
      expect(req.params).toMatchObject({ sessionId: "sess-1", expectedRunId: "run_abc" });
      peer.reply(req.id, { runId: "run_abc", messageId: "steer_1" });
      await expect(p).resolves.toEqual({ kind: "steered", runId: "run_abc", messageId: "steer_1" });
    });

    it("surfaces a stale CAS token as a typed no-active-run result, not a crash", async () => {
      const peer = new FakePeer();
      autoHandshake(peer);
      const client = makeClient(peer);
      await client.connect();
      const p = client.steer("sess-1", "run_stale", "too late");
      peer.replyError(
        peer.lastOf("_goose/unstable/session/steer")!.id,
        -32602,
        "Invalid params",
        "no active run to steer",
      );
      await expect(p).resolves.toEqual({ kind: "no-active-run" });
    });
  });

  describe("R6: permission requests stall the turn until answered", () => {
    it("answers a server->client permission request via the injected policy", async () => {
      const peer = new FakePeer();
      autoHandshake(peer);
      const decide = vi.fn(() => "allow_once");
      const client = makeClient(peer, { permissionPolicy: decide });
      await client.connect();

      const p = client.prompt("sess-1", "x");
      peer.emit({
        jsonrpc: "2.0",
        id: "perm-1",
        method: "session/request_permission",
        params: {
          sessionId: "sess-1",
          options: [
            { optionId: "allow_once", name: "Allow once" },
            { optionId: "reject_once", name: "Reject" },
          ],
        },
      });
      await Promise.resolve();
      await Promise.resolve();

      const answer = peer.sent.find((m) => m.id === "perm-1");
      expect(answer).toBeDefined();
      expect(answer!.result).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
      expect(decide).toHaveBeenCalled();

      peer.reply(peer.lastOf("session/prompt")!.id, { stopReason: "end_turn" });
      await expect(p).resolves.toMatchObject({ kind: "receipt" });
    });

    it("refuses by default when no policy is injected, rather than silently allowing", async () => {
      const peer = new FakePeer();
      autoHandshake(peer);
      const client = makeClient(peer);
      await client.connect();
      void client.prompt("sess-1", "x").catch(() => {});
      peer.emit({
        jsonrpc: "2.0",
        id: "perm-2",
        method: "session/request_permission",
        params: { sessionId: "sess-1", options: [{ optionId: "allow_once" }, { optionId: "reject_once" }] },
      });
      await Promise.resolve();
      await Promise.resolve();
      const answer = peer.sent.find((m) => m.id === "perm-2");
      expect(answer!.result).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
    });

    /**
     * The obligation measured against a real goose serve is "reply to the
     * frame", not "reply correctly": a correct optionId, an unknown optionId,
     * an empty `result: {}` and even a JSON-RPC error response all clear a
     * pending request. What does NOT clear it is sending nothing -- and a turn
     * parked on an unanswered request cannot be cancelled either, because
     * goose only applies a recorded cancel after the turn's stream yields an
     * event and the permission phase has no event source. So the wedge is
     * unbounded, and the caller can cause it.
     *
     * These tests exist because the injected policy is CALLER code. A policy
     * that throws is the one precondition for that wedge that lives on our
     * side of the boundary rather than goose's.
     */
    it("still answers when the injected policy throws", async () => {
      const peer = new FakePeer();
      autoHandshake(peer);
      const client = makeClient(peer, {
        permissionPolicy: () => {
          throw new Error("policy blew up");
        },
      });
      await client.connect();
      void client.prompt("sess-1", "x").catch(() => {});
      peer.emit({
        jsonrpc: "2.0",
        id: "perm-throw",
        method: "session/request_permission",
        params: { sessionId: "sess-1", options: [{ optionId: "allow_once" }, { optionId: "reject_once" }] },
      });
      await Promise.resolve();
      await Promise.resolve();

      const answer = peer.sent.find((m) => m.id === "perm-throw");
      expect(answer).toBeDefined();
      // Falls back to the refusal it would have made with no policy at all.
      expect(answer!.result).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
    });

    it("answers with a bare result when the options are unusable and the policy throws", async () => {
      // Nothing to refuse WITH: no options, and a policy that cannot supply
      // one either. An empty result is measured to clear the request, so send
      // that rather than nothing.
      const peer = new FakePeer();
      autoHandshake(peer);
      const client = makeClient(peer, {
        permissionPolicy: () => {
          throw new Error("policy blew up");
        },
      });
      await client.connect();
      void client.prompt("sess-1", "x").catch(() => {});
      peer.emit({
        jsonrpc: "2.0",
        id: "perm-empty",
        method: "session/request_permission",
        params: { sessionId: "sess-1", options: [] },
      });
      await Promise.resolve();
      await Promise.resolve();

      const answer = peer.sent.find((m) => m.id === "perm-empty");
      expect(answer).toBeDefined();
      expect(answer!.result).toEqual({});
    });

    it("answers every request even when one policy call throws", async () => {
      // A throw must not poison the handler for later requests: a single lane
      // turn can raise several permission requests in sequence.
      const peer = new FakePeer();
      autoHandshake(peer);
      let n = 0;
      const client = makeClient(peer, {
        permissionPolicy: () => {
          n += 1;
          if (n === 1) throw new Error("first one throws");
          return "allow_once";
        },
      });
      await client.connect();
      void client.prompt("sess-1", "x").catch(() => {});
      for (const id of ["perm-a", "perm-b"]) {
        peer.emit({
          jsonrpc: "2.0",
          id,
          method: "session/request_permission",
          params: { sessionId: "sess-1", options: [{ optionId: "allow_once" }, { optionId: "reject_once" }] },
        });
        await Promise.resolve();
        await Promise.resolve();
      }

      expect(peer.sent.find((m) => m.id === "perm-a")!.result).toEqual({
        outcome: { outcome: "selected", optionId: "reject_once" },
      });
      expect(peer.sent.find((m) => m.id === "perm-b")!.result).toEqual({
        outcome: { outcome: "selected", optionId: "allow_once" },
      });
    });
  });

  describe("reconnect", () => {
    it("does not resend an in-flight prompt after reconnecting (R1: retry is the caller's decision)", async () => {
      const peer = new FakePeer();
      autoHandshake(peer);
      const client = makeClient(peer);
      await client.connect();

      const p = client.prompt("sess-1", "x");
      expect(peer.countOf("session/prompt")).toBe(1);
      peer.drop();
      await expect(p).rejects.toBeInstanceOf(DisconnectedDuringTurn);

      await client.connect();
      // Reconnect re-handshakes but must never replay the lost turn: goose may
      // have persisted it, so a blind replay is how you get a duplicate.
      expect(peer.countOf("session/prompt")).toBe(1);
    });

    /**
     * The zombie-transport hazard.
     *
     * `connect()` reassigns `this.transport`, but a listener registered on the
     * OLD transport still points at `this.onClose`. A socket we closed can sit
     * in CLOSING until the kernel gives up on the unacked close frame -- minutes
     * later -- and when it finally fires, the old listener rejects the NEW
     * connection's turn as `DisconnectedDuringTurn` and clears its run ids. The
     * human is told a perfectly healthy turn was lost.
     *
     * Latent today (reachable via the handshake-timeout path, which closes and
     * lets the next deliver reconnect). The idle watchdog makes
     * close-then-reconnect the DESIGNED path, so it has to be fixed here first.
     */
    it("ignores a late close from a transport it already replaced", async () => {
      const first = new FakePeer();
      const second = new FakePeer();
      autoHandshake(first);
      autoHandshake(second);

      let next = first;
      const client = makeClient(first, { transportFactory: () => next });
      await client.connect();

      // The socket wedges; we close it and reconnect onto a fresh one.
      client.close();
      next = second;
      await client.connect();

      const live = client.prompt("sess-1", "on the new socket");
      expect(second.countOf("session/prompt")).toBe(1);

      // The zombie finally gives up, long after it stopped being ours.
      first.drop(1006);

      // The live turn must be untouched: still pending, still able to answer.
      second.reply(second.lastOf("session/prompt")!.id, { stopReason: "end_turn" });
      await expect(live).resolves.toMatchObject({ kind: "receipt", stopReason: "end_turn" });
      expect(client.isClosed()).toBe(false);
    });
  });

  /**
   * The trust boundary, pinned.
   *
   * goose's `_goose/unstable/tools/call` executes a tool with the PreToolUse
   * hook chain UNINVOKED -- and PostToolUse too, which is the hook that puts a
   * merge in front of the human. So a tool run that way is both unrefusable and
   * INVISIBLE, and invisibility is the failure this lane exists to fix.
   *
   * The `extensions:` allowlist does still bind there, so the surface is
   * bounded -- but `shell` is inside the lane's allowlist, which is why bounded
   * is not safe. This client therefore never acquires a tool-execution
   * capability, and these tests make that a decision rather than a habit.
   */
  describe("trust boundary: the client never gains a tool-execution capability", () => {
    it("sends only session-oriented methods across a full flow", async () => {
      const peer = new FakePeer();
      autoHandshake(peer);
      const client = makeClient(peer);
      await client.connect();
      const sid = "sess-1";
      const p = client.prompt(sid, "x");
      peer.reply(peer.lastOf("session/prompt")!.id, { stopReason: "end_turn" });
      await p;

      const methods = peer.sent
        .map((m) => m.method)
        .filter((m): m is string => typeof m === "string");
      expect(methods.length).toBeGreaterThan(0);
      for (const m of methods) {
        expect(ALLOWED_ACP_METHODS as readonly string[]).toContain(m);
      }
    });

    it("refuses to send a tool-execution method even if called directly", async () => {
      const peer = new FakePeer();
      autoHandshake(peer);
      const client = makeClient(peer);
      await client.connect();
      const before = peer.sent.length;

      // Reaching past the public API on purpose: the guard must live in the
      // send path, so that a FUTURE caller cannot acquire the capability by
      // adding a method, only by editing the allowlist.
      const callPrivate = (client as unknown as {
        call: (m: string, p: unknown) => Promise<unknown>;
      }).call.bind(client);

      // Throws SYNCHRONOUSLY rather than rejecting: this is a programming
      // error, not a runtime condition, and `call` is not an async function.
      // Every real caller awaits it, so a sync throw still surfaces as a
      // rejection to them.
      expect(() => callPrivate("_goose/unstable/tools/call", { name: "shell" })).toThrow(
        /disallowed method/,
      );
      expect(peer.sent.length).toBe(before);
    });

    it("pins the allowlist so growing it is a deliberate act", () => {
      // If this fails, someone added a method. That is allowed -- but the
      // question "does this give the client a way to run a tool with no hook
      // and no visibility?" has to be answered by a human first.
      expect([...ALLOWED_ACP_METHODS]).toEqual([
        "initialize",
        "session/new",
        "session/prompt",
        "_goose/unstable/session/steer",
      ]);
    });

    it("has no method that looks like tool execution", () => {
      for (const m of ALLOWED_ACP_METHODS) {
        expect(m).not.toMatch(/tools?\//);
        expect(m).not.toMatch(/call_tool/);
      }
    });
  });

});

/**
 * Notifications were previously dropped on the floor (the `onMessage` fall-through
 * said "progress only"), which is correct for DELIVERY EVIDENCE and wrong for
 * everything else: `session/update` is the only streaming surface goose has, and
 * it is also the only place the active run id appears before a turn is contended.
 *
 * Shapes here are transcribed from frames captured off a real goose 1.48.0 serve
 * on 2026-09-18, not invented.
 */
describe("GooseAcpClient session/update notifications", () => {
  it("hands session/update frames to the subscriber, with the session id", async () => {
    const peer = new FakePeer();
    autoHandshake(peer);
    const seen: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
    const c = makeClient(peer, { onSessionUpdate: (sessionId: string, update: Record<string, unknown>) => seen.push({ sessionId, update }) });
    await c.connect();

    peer.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "banana" } },
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.sessionId).toBe("sess-1");
    expect(seen[0]!.update.sessionUpdate).toBe("agent_message_chunk");
    expect((seen[0]!.update.content as { text: string }).text).toBe("banana");
  });

  it("learns the active run id from session_info_update, without needing a busy rejection", async () => {
    // Measured: goose emits this as soon as a turn starts. Learning the run id
    // here is what lets a second message STEER the running turn. The old route
    // -- regexing it out of a busy error -- requires first issuing a competing
    // prompt, which is the thing we are trying to avoid doing.
    const peer = new FakePeer();
    autoHandshake(peer);
    const c = makeClient(peer);
    await c.connect();

    expect(c.activeRunId("sess-1")).toBeUndefined();
    peer.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "session_info_update",
          _meta: { goose: { activeRunId: "run_ba3ce8fe-ab81-43f6-b1b8-d2d7d55479f6" } },
        },
      },
    });
    expect(c.activeRunId("sess-1")).toBe("run_ba3ce8fe-ab81-43f6-b1b8-d2d7d55479f6");
  });

  it("does not let a throwing subscriber escape into the transport callback", async () => {
    // The subscriber is CALLER code running inside the socket's message handler.
    // An exception there would propagate out of the transport and, on the real
    // ws transport, surface as an unhandled rejection -- which on Node kills the
    // daemon for every session, not just this one.
    const peer = new FakePeer();
    autoHandshake(peer);
    const c = makeClient(peer, {
      onSessionUpdate: () => {
        throw new Error("subscriber blew up");
      },
    });
    await c.connect();

    expect(() =>
      peer.emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk" } },
      }),
    ).not.toThrow();
    // and the client still works afterwards
    expect(c.activeRunId("sess-1")).toBeUndefined();
  });

  it("still ignores notifications it has no subscriber for", async () => {
    const peer = new FakePeer();
    autoHandshake(peer);
    const c = makeClient(peer);
    await c.connect();
    expect(() =>
      peer.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: {} } }),
    ).not.toThrow();
  });


});

describe("R9: session/new is a containment decision, not a transport detail", () => {
  // Bead eng-agent-platform-li6. goose 1.48.0 acp/server.rs:581-611: a
  // session/new carrying neither recipe_extensions nor goose_extensions falls
  // back to get_enabled_extensions_with_config -- the HOST's config.yaml. On
  // the machine this runs on that meant every pigeon session was handed
  // summon (the `delegate` tool), Extension Manager, and scheduler.
  //
  // MEASURED on a live serve before the fix (scripts/li6-extension-surface-probe.ts):
  //   no _meta            -> 9 extensions incl. summon, Extension Manager, scheduler
  //   enabledExtensions:[] -> 1 extension: developer
  //   enabledExtensions:[analyze] -> 2: analyze, developer
  // The third arm is what proves the field is read rather than coincidentally
  // narrow, and these tests encode that contract.

  it("always sends _meta.enabledExtensions, because ABSENT is the dangerous value", async () => {
    const peer = new FakePeer();
    autoHandshake(peer);
    const client = makeClient(peer);
    await client.connect();
    await client.newSession("/tmp/x");

    const sent = peer.lastOf("session/new")!;
    const meta = (sent.params as any)._meta;
    // Not merely "some meta": the key must be present, because goose keys off
    // presence. `undefined` and `null` both take the host-config branch.
    expect(meta).toBeDefined();
    expect(meta.enabledExtensions).toBeDefined();
    expect(meta.enabledExtensions).not.toBeNull();
  });

  it("defaults to developer, analyze, todo and skills -- developer named explicitly", async () => {
    // Decided 2026-09-23 (eng-agent-platform
    // docs/plans/2026-09-22-goose-extension-defaults-design.md, 5-7.1).
    // developer is REQUESTED rather than assumed from the serve's floor: with no
    // --with-builtin, goose loads its default developer only if config.yaml does
    // not disable it (v1.48.0 acp/server.rs:568-577), while an explicit request
    // loads it unconditionally. Assuming it made a shell-less session possible.
    const peer = new FakePeer();
    autoHandshake(peer);
    const client = makeClient(peer);
    await client.connect();
    await client.newSession("/tmp/x");

    expect(((peer.lastOf("session/new")!.params as any)._meta).enabledExtensions).toEqual([
      { type: "platform", name: "developer" },
      { type: "platform", name: "analyze" },
      { type: "platform", name: "todo" },
      { type: "platform", name: "skills" },
    ]);
  });

  it("passes a caller's explicit set through unchanged", async () => {
    const peer = new FakePeer();
    autoHandshake(peer, ["developer", "analyze"]);
    const client = makeClient(peer, {
      sessionExtensions: [{ type: "platform", name: "analyze" }],
    });
    await client.connect();
    await client.newSession("/tmp/x");

    expect(((peer.lastOf("session/new")!.params as any)._meta).enabledExtensions).toEqual([
      { type: "platform", name: "analyze" },
    ]);
  });

  it("rejects a session that loaded an extension nobody asked for", async () => {
    // The request is a request. This is the check that it was honoured --
    // without it, a serve on a different version, or one started with
    // --with-builtin summon, silently reintroduces exactly this bead's bug and
    // nothing anywhere fails.
    const peer = new FakePeer();
    autoHandshake(peer, ["developer", "summon"]);
    const client = makeClient(peer);
    await client.connect();

    await expect(client.newSession("/tmp/x")).rejects.toThrow(/summon/);
  });

  it("names every surplus extension, not just the first", async () => {
    const peer = new FakePeer();
    autoHandshake(peer, ["developer", "summon", "scheduler"]);
    const client = makeClient(peer);
    await client.connect();

    await expect(client.newSession("/tmp/x")).rejects.toThrow(/scheduler.*summon|summon.*scheduler/);
  });

  it("matches goose's DISPLAY names against requested config keys", async () => {
    // extensionResults says "Extension Manager"; config and the wire say
    // "extensionmanager". MEASURED -- arm A of the live probe returned
    // exactly that string. A naive set comparison would both miss this
    // extension as surplus AND throw spuriously when a caller legitimately
    // asks for it, so normalisation is load-bearing in both directions.
    const peer = new FakePeer();
    autoHandshake(peer, ["developer", "Extension Manager"]);
    const client = makeClient(peer);
    await client.connect();

    await expect(client.newSession("/tmp/x")).rejects.toThrow(/Extension Manager/);
  });

  it("accepts a requested extension reported under its display name", async () => {
    const peer = new FakePeer();
    autoHandshake(peer, ["developer", "Extension Manager"]);
    const client = makeClient(peer, {
      sessionExtensions: [{ type: "builtin", name: "extensionmanager" }],
    });
    await client.connect();

    // Asked for, so allowed -- the check is "unrequested", not "dangerous".
    await expect(client.newSession("/tmp/x")).resolves.toBe("sess-1");
  });

  it("treats a surplus extension that FAILED to load as surplus anyway", async () => {
    // It was attempted. Whether it happened to fail this time says nothing
    // about the next serve restart.
    const peer = new FakePeer();
    autoHandshake(peer, ["developer"], [{ name: "summon", success: false, error: "boom" }]);
    const client = makeClient(peer);
    await client.connect();

    await expect(client.newSession("/tmp/x")).rejects.toThrow(/summon/);
  });

  it("refuses a session it cannot verify at all", async () => {
    // No extensionResults -> the response cannot answer the question. A serve
    // that does not report is not thereby trustworthy; failing closed here is
    // the difference between "verified narrow" and "assumed narrow".
    const peer = new FakePeer();
    peer.onRequest = (msg, p) => {
      if (msg.method === "initialize") p.reply(msg.id, { protocolVersion: 1 });
      else if (msg.method === "session/new") p.reply(msg.id, { sessionId: "sess-1" });
    };
    const client = makeClient(peer);
    await client.connect();

    await expect(client.newSession("/tmp/x")).rejects.toThrow(/could not be verified|extensionResults/i);
  });

  it("allows the floor itself through when nothing more is requested", async () => {
    const peer = new FakePeer();
    autoHandshake(peer, ["developer"]);
    const client = makeClient(peer, { sessionExtensions: [] });
    await client.connect();
    await expect(client.newSession("/tmp/x")).resolves.toBe("sess-1");
  });

  it("honours a serveFloor the operator has widened via --with-builtin", async () => {
    // The floor is set by the serve's systemd unit, in another repo. The
    // client cannot see those flags; it can only be TOLD what to expect. If
    // the two disagree the session is refused, which is the loud failure that
    // cross-repo drift otherwise does not get.
    const peer = new FakePeer();
    autoHandshake(peer, ["github"]);
    const client = makeClient(peer, { serveFloor: ["github"], sessionExtensions: [] });
    await client.connect();
    await expect(client.newSession("/tmp/x")).resolves.toBe("sess-1");
  });

  it("pins the wire shape, so widening it is a deliberate act", () => {
    // Mirrors the ALLOWED_ACP_METHODS pin. If this fails someone changed what
    // every goose session is allowed to load, and that is a human decision.
    expect(DEFAULT_SESSION_EXTENSIONS).toEqual([
      { type: "platform", name: "developer" },
      { type: "platform", name: "analyze" },
      { type: "platform", name: "todo" },
      { type: "platform", name: "skills" },
    ]);
    expect(DEFAULT_SERVE_FLOOR).toEqual(["developer"]);
  });

  it("refuses a session MISSING a requested extension -- the shell-less session", async () => {
    // goose skips its default developer when config.yaml says enabled:false.
    // A session with analyze/todo/skills but no shell is accepted-then-dead:
    // it handshakes fine and fails on the first real command.
    const peer = new FakePeer();
    autoHandshake(peer, ["analyze", "skills", "todo"]);
    const client = makeClient(peer);
    await client.connect();

    await expect(client.newSession("/tmp/x")).rejects.toThrow(/missing.*developer/i);
  });

  it("refuses a session missing a FLOOR extension it was told to expect", async () => {
    const peer = new FakePeer();
    autoHandshake(peer, ["developer"]);
    const client = makeClient(peer, { serveFloor: ["developer", "github"], sessionExtensions: [] });
    await client.connect();

    await expect(client.newSession("/tmp/x")).rejects.toThrow(/missing.*github/i);
  });

  it("refuses a session where a requested extension reported success:false", async () => {
    // Reported, but did not load. For the floor that is the same dead session
    // as not reported at all.
    const peer = new FakePeer();
    autoHandshake(peer, ["analyze", "skills", "todo"], [
      { name: "developer", success: false, error: "boom" },
    ]);
    const client = makeClient(peer);
    await client.connect();

    await expect(client.newSession("/tmp/x")).rejects.toThrow(/developer/);
  });

  it("names surplus and missing together in one refusal", async () => {
    const peer = new FakePeer();
    autoHandshake(peer, ["developer", "analyze", "skills", "summon"]);
    const client = makeClient(peer);
    await client.connect();

    const err = await client.newSession("/tmp/x").catch((e: Error) => e);
    expect(String(err)).toMatch(/summon/);
    expect(String(err)).toMatch(/todo/);
  });
});
