import { describe, it, expect, vi } from "vitest";
import {
  GooseAcpClient,
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

/** Answers initialize/session-new so tests can get to the interesting part. */
function autoHandshake(peer: FakePeer): void {
  peer.onRequest = (msg, p) => {
    if (msg.method === "initialize") {
      p.reply(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === "session/new") {
      p.reply(msg.id, { sessionId: "sess-1" });
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
  });
});
