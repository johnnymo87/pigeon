import { describe, expect, it, vi } from "vitest";
import { GooseSessionRunner } from "../src/goose/session-runner";
import { DisconnectedDuringTurn } from "../src/goose/acp-client";
import type { SessionRecord } from "../src/storage/types";
import type { GooseInflightRecord, GooseInflightStore, InsertGooseInflightInput } from "../src/storage/goose-inflight-repo";

class FakeInflightStore implements GooseInflightStore {
  rows = new Map<string, GooseInflightRecord>();
  inserts: InsertGooseInflightInput[] = [];
  touches: Array<{ commandId: string; now: number }> = [];
  deletes: string[] = [];
  suspends: Array<{ commandId: string; now: number }> = [];
  bumps: Array<{ commandId: string; now: number }> = [];

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
  }

  bumpAttempts(commandId: string, now: number = Date.now()): number {
    this.bumps.push({ commandId, now });
    return 1;
  }
}

class FakeRecoveryClient {
  connected = false;
  closed = false;
  prompts: string[] = [];
  promptOptions: Array<{ clientReqId?: string; resumeOnly?: boolean } | undefined> = [];
  turns: Array<{
    text: string;
    resolve: (v: unknown) => void;
    reject: (err: unknown) => void;
  }> = [];
  steers: Array<{ runId: string; text: string }> = [];
  isHonk = true;
  supportsResumeOnly = true;
  runIds = new Map<string, string>();

  async connect(): Promise<void> {
    this.connected = true;
    this.closed = false;
  }

  isClosed(): boolean {
    return this.closed;
  }

  prompt(
    sessionId: string,
    text: string,
    options?: { clientReqId?: string; resumeOnly?: boolean },
  ): Promise<unknown> {
    this.prompts.push(text);
    this.promptOptions.push(options);
    return new Promise((resolve, reject) => this.turns.push({ text, resolve, reject }));
  }

  async steer(sessionId: string, runId: string, text: string): Promise<unknown> {
    this.steers.push({ runId, text });
    return { kind: "steered" };
  }

  activeRunId(sessionId: string): string | undefined {
    return this.runIds.get(sessionId);
  }

  cancel(sessionId: string): void {}

  async ping(): Promise<void> {}

  close(): void {
    this.closed = true;
    this.connected = false;
  }

  finishTurn(stopReason = "end_turn", extra?: Record<string, unknown>): void {
    this.turns.shift()?.resolve({ kind: "receipt", stopReason, usage: { totalTokens: 10 }, ...extra });
  }

  failTurn(err: Error): void {
    this.turns.shift()?.reject(err);
  }

  finishBusy(runId: string): void {
    this.turns.shift()?.resolve({ kind: "busy", runId });
  }

  finishUnknown(): void {
    this.turns.shift()?.resolve({ kind: "unknown-request" });
  }
}

function makeSession(): SessionRecord {
  return {
    sessionId: "ses_rec_1",
    backendSessionId: "20261012_rec",
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
    backendKind: "goose",
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

function makeInflightRow(over: Partial<GooseInflightRecord> = {}): GooseInflightRecord {
  return {
    commandId: "cmd_rec_1",
    sessionId: "ses_rec_1",
    backendSessionId: "20261012_rec",
    isHonk: true,
    promptText: "recover this turn",
    recoveryAttempts: 0,
    createdAt: 1000,
    updatedAt: 1000,
    lastAliveAt: 1000,
    cleanSuspend: true,
    ...over,
  };
}

describe("GooseSessionRunner Recovery (Commit 2)", () => {
  it("resume(row) sets this.turn synchronously with recovered=true and resent=true", () => {
    const inflight = new FakeInflightStore();
    const client = new FakeRecoveryClient();
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    const row = makeInflightRow();
    inflight.insert(row);

    expect(runner.isBusy()).toBe(false);
    runner.resume(row);
    expect(runner.isBusy()).toBe(true);
    expect(runner.activeTurn?.commandId).toBe("cmd_rec_1");
  });

  it("redelivery of the same commandId while recovered returns already-running", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeRecoveryClient();
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    const row = makeInflightRow();
    inflight.insert(row);
    runner.resume(row);

    const deliverOutcome = await runner.deliver("cmd_rec_1", "recover this turn");
    expect(deliverOutcome).toEqual({
      ok: true,
      meta: { mode: "already-running", runId: undefined },
    });
  });

  it("gating: if endpoint is not honk, sends NO prompt, posts honest notice, and retires row", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeRecoveryClient();
    client.isHonk = false; // Not honk!
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    const row = makeInflightRow();
    inflight.insert(row);
    runner.resume(row);

    await runner.settled();

    expect(client.prompts).toHaveLength(0);
    expect(postStop).toHaveBeenCalledTimes(1);
    expect(postStop.mock.calls[0]![0].message).toContain(
      "pigeon restarted while goose was working on this; can't safely collect the reply, nothing was resent",
    );
    expect(inflight.deletes).toContain("cmd_rec_1");
    expect(runner.isBusy()).toBe(false);
  });

  it("gating: if honk does not advertise resume_only, sends NO prompt, posts honest notice, and retires row", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeRecoveryClient();
    client.isHonk = true;
    client.supportsResumeOnly = false; // Feature not advertised!
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    const row = makeInflightRow();
    inflight.insert(row);
    runner.resume(row);

    await runner.settled();

    expect(client.prompts).toHaveLength(0);
    expect(postStop).toHaveBeenCalledTimes(1);
    expect(postStop.mock.calls[0]![0].message).toContain(
      "pigeon restarted while goose was working on this; can't safely collect the reply, nothing was resent",
    );
    expect(inflight.deletes).toContain("cmd_rec_1");
    expect(runner.isBusy()).toBe(false);
  });

  it("sends prompt with resumeOnly: true and same clientReqId when resume_only is advertised", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeRecoveryClient();
    client.isHonk = true;
    client.supportsResumeOnly = true;
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    const row = makeInflightRow({ commandId: "cmd_rec_wire" });
    inflight.insert(row);
    runner.resume(row);

    // Yield to allow connect and prompt to be issued
    await new Promise((r) => setTimeout(r, 10));

    expect(client.prompts).toHaveLength(1);
    expect(client.promptOptions[0]).toEqual({
      clientReqId: "cmd_rec_wire",
      resumeOnly: true,
    });

    client.finishTurn("end_turn", { text: "recovered successfully" });
    await runner.settled();

    expect(postStop).toHaveBeenCalledTimes(1);
    expect(postStop.mock.calls[0]![0].message).toBe("recovered successfully");
    expect(inflight.deletes).toContain("cmd_rec_wire");
  });

  it("missing _meta.honk.text on recovered turn: labels partial or says unavailable", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeRecoveryClient();
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    const row = makeInflightRow();
    inflight.insert(row);
    runner.resume(row);

    await new Promise((r) => setTimeout(r, 10));

    // Post-restart chunk arrives
    runner.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "chunk after restart" } });

    // Reply finishes WITHOUT _meta.honk.text
    client.finishTurn("end_turn", { text: undefined });
    await runner.settled();

    expect(postStop).toHaveBeenCalledTimes(1);
    const msg = String(postStop.mock.calls[0]![0].message);
    expect(msg).toContain("pigeon restarted mid-turn; only output after the restart is shown");
    expect(msg).toContain("chunk after restart");
  });

  it("missing _meta.honk.text on recovered turn with no chunks: says text is unavailable", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeRecoveryClient();
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    const row = makeInflightRow();
    inflight.insert(row);
    runner.resume(row);

    await new Promise((r) => setTimeout(r, 10));

    // Reply finishes WITHOUT _meta.honk.text and NO chunks arrived
    client.finishTurn("end_turn", { text: undefined });
    await runner.settled();

    expect(postStop).toHaveBeenCalledTimes(1);
    const msg = String(postStop.mock.calls[0]![0].message);
    expect(msg).toContain("goose reply text is unavailable");
  });

  it("-32004 (unknown-request) on recovery: posts honest notice, does not resend, retires row", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeRecoveryClient();
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    const row = makeInflightRow();
    inflight.insert(row);
    runner.resume(row);

    await new Promise((r) => setTimeout(r, 10));

    client.finishUnknown();
    await runner.settled();

    expect(client.prompts).toHaveLength(1); // Exactly one prompt, no resend
    expect(postStop).toHaveBeenCalledTimes(1);
    expect(postStop.mock.calls[0]![0].message).toContain(
      "honkd has no record of this turn (it may never have arrived, or honkd lost it); nothing was resent.",
    );
    expect(inflight.deletes).toContain("cmd_rec_1");
  });

  it("busy on recovery: posts recovered-specific notice, does NOT steer, retires row", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeRecoveryClient();
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    const row = makeInflightRow();
    inflight.insert(row);
    runner.resume(row);

    await new Promise((r) => setTimeout(r, 10));

    client.finishBusy("run_other");
    await runner.settled();

    // Must NOT call steer
    expect(client.steers).toHaveLength(0);
    expect(postStop).toHaveBeenCalledTimes(1);
    expect(postStop.mock.calls[0]![0].error_kind).toBe("goose-busy-recovered");
    expect(inflight.deletes).toContain("cmd_rec_1");
  });

  it("in-run reconnect resend does NOT carry resume_only (R4)", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeRecoveryClient();
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
      honkReconnectInitialDelayMs: 10,
    });

    // Start fresh in-run turn
    await runner.deliver("cmd_in_run", "normal prompt");
    expect(client.promptOptions[0]).toEqual({ clientReqId: "cmd_in_run" });
    expect(client.promptOptions[0]?.resumeOnly).toBeUndefined();

    // Trigger disconnect mid-turn
    client.failTurn(new DisconnectedDuringTurn("ses_rec_1", "run_1", 1006));

    await new Promise((r) => setTimeout(r, 30));

    // Reconnected and resent: should still NOT have resumeOnly!
    expect(client.prompts).toHaveLength(2);
    expect(client.promptOptions[1]?.resumeOnly).toBeUndefined();

    client.finishTurn("end_turn", { text: "done after in-run reconnect" });
    await runner.settled();

    expect(postStop).toHaveBeenCalledTimes(1);
  });

  it("R3: deliver() awaits recovery resolution when turn is recovered and has no runId, then starts fresh if recovery settles", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeRecoveryClient();
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    const row = makeInflightRow({ commandId: "cmd_rec_r3" });
    inflight.insert(row);
    runner.resume(row);

    await new Promise((r) => setTimeout(r, 10));
    expect(client.prompts).toHaveLength(1);

    // Human sends a new message while recovered turn is settling
    const newDeliverPromise = runner.deliver("cmd_new", "human message");

    // Settle the recovered turn
    client.finishTurn("end_turn", { text: "recovery reply" });

    // The new deliver should now start fresh!
    const outcome = await newDeliverPromise;
    expect(outcome.ok).toBe(true);
    expect(outcome.meta?.mode).toBe("prompt");
    expect(outcome.meta?.commandId).toBe("cmd_new");

    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[1]).toBe("human message");
  });

  it("R3: deliver() awaits recovery attach, then steers when runId becomes known", async () => {
    const inflight = new FakeInflightStore();
    const client = new FakeRecoveryClient();
    const postStop = vi.fn().mockResolvedValue(undefined);

    const runner = new GooseSessionRunner({
      session: makeSession(),
      client,
      inflight,
      postStop,
      touch: () => {},
    });

    const row = makeInflightRow({ commandId: "cmd_rec_attach" });
    inflight.insert(row);
    runner.resume(row);

    await new Promise((r) => setTimeout(r, 10));
    expect(client.prompts).toHaveLength(1);

    // Deliver new message
    const deliverPromise = runner.deliver("cmd_new_steer", "steer text");

    // Active runId arrives via onSessionUpdate
    client.runIds.set("20261012_rec", "run_active_123");
    runner.onUpdate({
      sessionUpdate: "session_info_update",
      _meta: { goose: { activeRunId: "run_active_123" } },
    });

    const outcome = await deliverPromise;
    expect(outcome.ok).toBe(true);
    expect(outcome.meta?.mode).toBe("steered");
    expect(client.steers).toHaveLength(1);
    expect(client.steers[0]).toEqual({
      runId: "run_active_123",
      text: "steer text",
    });
  });
});
