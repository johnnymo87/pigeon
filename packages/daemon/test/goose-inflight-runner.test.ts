import { GOOSE_BACKEND_KIND } from "../src/goose/backend-kind";
import { describe, expect, it, vi } from "vitest";
import { GooseSessionRunner } from "../src/goose/session-runner";
import type { SessionRecord } from "../src/storage/types";
import type { GooseInflightStore, GooseInflightRecord, InsertGooseInflightInput } from "../src/storage/goose-inflight-repo";

class FakeInflightStore implements GooseInflightStore {
  rows = new Map<string, GooseInflightRecord>();
  inserts: InsertGooseInflightInput[] = [];
  touches: Array<{ commandId: string; now: number }> = [];
  deletes: string[] = [];
  suspends: Array<{ commandId: string; now: number }> = [];
  bumps: Array<{ commandId: string; now: number }> = [];
  throwOnInsert?: Error;

  insert(input: InsertGooseInflightInput, now: number = Date.now()): void {
    if (this.throwOnInsert) {
      throw this.throwOnInsert;
    }
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

  markSent(commandId: string, now: number = Date.now()): void {
    const row = this.rows.get(commandId);
    if (row) {
      row.state = "sent";
      row.lastAliveAt = now;
      row.updatedAt = now;
    }
  }

  markQueued(commandId: string, now: number = Date.now()): void {
    const row = this.rows.get(commandId);
    if (row) {
      row.state = "queued";
      row.lastAliveAt = now;
      row.updatedAt = now;
    }
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
    const row = this.rows.get(commandId);
    if (row) {
      row.cleanSuspend = false;
      row.lastAliveAt = now;
      row.updatedAt = now;
    }
  }

  bumpAttempts(commandId: string, now: number = Date.now()): number {
    this.bumps.push({ commandId, now });
    const row = this.rows.get(commandId);
    if (row) {
      row.recoveryAttempts += 1;
      row.updatedAt = now;
      return row.recoveryAttempts;
    }
    return 0;
  }
}

class FakeClient {
  connected = false;
  closed = false;
  prompts: string[] = [];
  turns: Array<{
    text: string;
    resolve: (v: unknown) => void;
    reject: (err: unknown) => void;
  }> = [];
  steers: Array<{ runId: string; text: string }> = [];
  steerOutcome: unknown = { kind: "steered", runId: "r1" };
  isHonk = false;
  runIds = new Map<string, string>();
  pingReject = false;

  async connect(): Promise<void> {
    this.connected = true;
    this.closed = false;
  }

  isClosed(): boolean {
    return this.closed;
  }

  prompt(sessionId: string, text: string, options?: { clientReqId?: string }): Promise<unknown> {
    this.prompts.push(text);
    return new Promise((resolve, reject) => this.turns.push({ text, resolve, reject }));
  }

  async steer(sessionId: string, runId: string, text: string): Promise<unknown> {
    this.steers.push({ runId, text });
    return this.steerOutcome;
  }

  activeRunId(sessionId: string): string | undefined {
    return this.runIds.get(sessionId);
  }

  cancel(sessionId: string): void {}

  async ping(): Promise<void> {
    if (this.pingReject) throw new Error("ping timeout");
  }

  close(): void {
    this.closed = true;
    this.connected = false;
  }

  finishTurn(stopReason = "end_turn", text = "done"): void {
    this.turns.shift()?.resolve({ kind: "receipt", stopReason, text });
  }

  failTurn(err: Error): void {
    this.turns.shift()?.reject(err);
  }

  finishBusy(runId: string): void {
    this.turns.shift()?.resolve({ kind: "busy", runId });
  }
}

function makeSession(): SessionRecord {
  return {
    sessionId: "ses_inflight_1",
    backendSessionId: "20261012_1",
    ppid: null,
    pid: null,
    startTime: null,
    cwd: "/tmp",
    label: null,
    title: null,
    lastHumanMsgId: null,
    notify: true,
    state: "running",
    ptyPath: null,
    nvimSocket: null,
    backendKind: GOOSE_BACKEND_KIND,
    backendProtocolVersion: null,
    backendEndpoint: null,
    backendAuthToken: null,
    pullSources: ["telegram-reply"],
    createdAt: 1000,
    updatedAt: 1000,
    lastSeen: 1000,
    expiresAt: 2000,
  };
}

describe("GooseSessionRunner Inflight Lifecycle", () => {
  it("inserts inflight row synchronously before client.prompt", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeClient();
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    const deliverPromise = runner.deliver("cmd_1", "test prompt");
    await deliverPromise;

    expect(inflight.inserts).toHaveLength(1);
    expect(inflight.inserts[0]).toEqual({
      commandId: "cmd_1",
      sessionId: "ses_inflight_1",
      backendSessionId: "20261012_1",
      isHonk: false,
      promptText: "test prompt",
      state: "sent",
    });
    expect(inflight.get("cmd_1")).toBeDefined();
    expect(client.prompts).toHaveLength(1);
  });

  it("insert failure → deliver throws and nothing is sent to client.prompt", async () => {
    const inflight = new FakeInflightStore();
    inflight.throwOnInsert = new Error("disk full");
    const client = new FakeClient();
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    await expect(runner.deliver("cmd_1", "test prompt")).rejects.toThrow("disk full");
    expect(client.prompts).toHaveLength(0);
    expect(runner.isBusy()).toBe(false);
  });

  it("throttles touchAlive to ~1/min on onUpdate", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeClient();
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    await runner.deliver("cmd_1", "test prompt");

    // First update at t = 100_000
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(100_000);
    runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "hello" } });
    expect(inflight.touches).toHaveLength(1);
    expect(inflight.touches[0]).toEqual({ commandId: "cmd_1", now: 100_000 });

    // Second update at t = 130_000 (only 30s elapsed, < 60s) -> throttled
    nowSpy.mockReturnValue(130_000);
    runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: " there" } });
    expect(inflight.touches).toHaveLength(1);

    // Third update at t = 161_000 (61s elapsed, > 60s) -> touched
    nowSpy.mockReturnValue(161_000);
    runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: " world" } });
    expect(inflight.touches).toHaveLength(2);
    expect(inflight.touches[1]).toEqual({ commandId: "cmd_1", now: 161_000 });

    nowSpy.mockRestore();
  });

  it("terminal path 1: normal finishTurn success deletes row after postStop resolves", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeClient();
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    await runner.deliver("cmd_term_1", "test prompt");
    expect(inflight.get("cmd_term_1")).toBeDefined();

    client.finishTurn("end_turn", "all done");
    await runner.settled();

    expect(postStop).toHaveBeenCalledTimes(1);
    expect(inflight.deletes).toContain("cmd_term_1");
    expect(inflight.get("cmd_term_1")).toBeUndefined();
  });

  it("terminal path 2: normal finishTurn error deletes row after postStop resolves", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeClient();
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    await runner.deliver("cmd_term_2", "test prompt");
    expect(inflight.get("cmd_term_2")).toBeDefined();

    client.failTurn(new Error("turn failed"));
    await runner.settled();

    expect(postStop).toHaveBeenCalledTimes(1);
    expect(inflight.deletes).toContain("cmd_term_2");
    expect(inflight.get("cmd_term_2")).toBeUndefined();
  });

  it("terminal path 3: postStop throws in finishTurn → row is KEPT", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeClient();
    const postStop = vi.fn().mockRejectedValue(new Error("telegram 500 / sqlite busy"));

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    await runner.deliver("cmd_term_3", "test prompt");
    expect(inflight.get("cmd_term_3")).toBeDefined();

    client.finishTurn("end_turn", "all done");
    await runner.settled();

    expect(postStop).toHaveBeenCalledTimes(1);
    expect(inflight.deletes).not.toContain("cmd_term_3");
    expect(inflight.get("cmd_term_3")).toBeDefined();
  });

  it("terminal path 4: cancelRequested skip branch deletes row", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeClient();
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    await runner.deliver("cmd_term_4", "test prompt");
    expect(inflight.get("cmd_term_4")).toBeDefined();

    await runner.cancel();
    client.finishTurn("cancelled", "stopped");
    await runner.settled();

    // postStop is skipped on cancelRequested
    expect(postStop).not.toHaveBeenCalled();
    // but row is retired/deleted
    expect(inflight.deletes).toContain("cmd_term_4");
    expect(inflight.get("cmd_term_4")).toBeUndefined();
  });

  it("terminal path 5: abandoned-late-error deletes row", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeClient();
    client.pingReject = true;
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
      turnIdleTimeoutMs: 10,
    });

    await runner.deliver("cmd_term_5", "test prompt");
    expect(inflight.get("cmd_term_5")).toBeDefined();

    // Let idle timer trigger stall check and ping rejection -> abandonTurn
    await new Promise((r) => setTimeout(r, 30));
    expect(postStop).toHaveBeenCalledTimes(1);
    expect(postStop.mock.calls[0]![0].notification_id).toContain(":stalled");

    // Clear deletes from the abandon notice to specifically check late error
    inflight.deletes = [];

    // Now late error arrives
    client.failTurn(new Error("late socket error"));
    await runner.settled();

    expect(inflight.deletes).toContain("cmd_term_5");
  });

  it("terminal path 6: abandonTurn after stall notice deletes row when postStop resolves", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeClient();
    client.pingReject = true;
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
      turnIdleTimeoutMs: 10,
    });

    await runner.deliver("cmd_term_6", "test prompt");
    expect(inflight.get("cmd_term_6")).toBeDefined();

    // Wait for idle watchdog to trigger abandonTurn
    await new Promise((r) => setTimeout(r, 30));

    expect(postStop).toHaveBeenCalledTimes(1);
    expect(inflight.deletes).toContain("cmd_term_6");
    expect(inflight.get("cmd_term_6")).toBeUndefined();
  });

  it("terminal path 6b: abandonTurn keeps row when postStop throws", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeClient();
    client.pingReject = true;
    const postStop = vi.fn().mockRejectedValue(new Error("outbox full"));

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
      turnIdleTimeoutMs: 10,
    });

    await runner.deliver("cmd_term_6b", "test prompt");
    expect(inflight.get("cmd_term_6b")).toBeDefined();

    await new Promise((r) => setTimeout(r, 30));

    expect(postStop).toHaveBeenCalledTimes(1);
    expect(inflight.deletes).not.toContain("cmd_term_6b");
    expect(inflight.get("cmd_term_6b")).toBeDefined();
  });

  it("terminal path 7: busy → steered branch of onPromptOutcome deletes row", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeClient();
    client.steerOutcome = { kind: "steered", runId: "r1" };
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    await runner.deliver("cmd_term_7", "test prompt");
    expect(inflight.get("cmd_term_7")).toBeDefined();

    client.finishBusy("r1");
    await runner.settled();

    expect(client.steers).toHaveLength(1);
    expect(postStop).not.toHaveBeenCalled();
    expect(inflight.deletes).toContain("cmd_term_7");
    expect(inflight.get("cmd_term_7")).toBeUndefined();
  });
});
