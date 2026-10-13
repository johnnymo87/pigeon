import { describe, expect, it, vi } from "vitest";
import { GooseRunnerRegistry, GooseSessionRunner, gooseShutdownNotice } from "../src/goose/session-runner";
import { DisconnectedDuringTurn } from "../src/goose/acp-client";
import type { SessionRecord } from "../src/storage/types";
import type { GooseInflightStore, GooseInflightRecord, InsertGooseInflightInput } from "../src/storage/goose-inflight-repo";

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
  isHonk = false;
  runIds = new Map<string, string>();
  onClose?: () => void;

  constructor(isHonk = false) {
    this.isHonk = isHonk;
  }

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

  async steer(): Promise<unknown> {
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
    this.onClose?.();
  }
}

function makeSession(id: string): SessionRecord {
  return {
    sessionId: id,
    backendSessionId: id,
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

describe("GooseRunnerRegistry suspendAll", () => {
  it("ordering: sets suspended on all runners FIRST before any postStop notices", async () => {
    const inflight = new FakeInflightStore();
    const inbox = { markDone: vi.fn() };
    const orderOfOperations: string[] = [];

    const clients = new Map<string, FakeClient>();
    const runners = new Map<string, GooseSessionRunner>();

    const registry = new GooseRunnerRegistry({
      inbox,
      inflight,
      createRunner: (s) => {
        const client = new FakeClient(false);
        clients.set(s.sessionId, client);
        const runner = new GooseSessionRunner({
          session: s,
          client,
          inflight,
          postStop: async () => {
            orderOfOperations.push(`postStop:${s.sessionId}`);
            // Check that other runners are already suspended when this postStop runs
            for (const [otherId, otherRunner] of runners) {
              expect(otherRunner.isSuspended).toBe(true);
            }
          },
          touch: () => {},
        });
        runners.set(s.sessionId, runner);
        return runner;
      },
    });

    const s1 = makeSession("ses_1");
    const s2 = makeSession("ses_2");
    const r1 = registry.get(s1);
    const r2 = registry.get(s2);

    await r1.deliver("cmd_1", "prompt 1");
    await r2.deliver("cmd_2", "prompt 2");

    expect(r1.isSuspended).toBe(false);
    expect(r2.isSuspended).toBe(false);

    await registry.suspendAll();

    expect(orderOfOperations).toContain("postStop:ses_1");
    expect(orderOfOperations).toContain("postStop:ses_2");
    expect(r1.isClosed).toBe(true);
    expect(r2.isClosed).toBe(true);
  });

  it("bare goose runner: posts notice via postStop, deletes inflight row, and calls inbox.markDone", async () => {
    const inflight = new FakeInflightStore();
    const inbox = { markDone: vi.fn() };
    let postStopBody: Record<string, unknown> | undefined;

    const client = new FakeClient(false);
    const registry = new GooseRunnerRegistry({
      inbox,
      inflight,
      createRunner: (s) =>
        new GooseSessionRunner({
          session: s,
          client,
          inflight,
          postStop: async (body) => {
            postStopBody = body;
          },
          touch: () => {},
        }),
    });

    const session = makeSession("ses_bare");
    const runner = registry.get(session);
    await runner.deliver("cmd_bare_1", "do work");

    expect(inflight.get("cmd_bare_1")).toBeDefined();

    await registry.suspendAll();

    expect(postStopBody).toBeDefined();
    expect(postStopBody?.notification_id).toBe("s:ses_bare:cmd_bare_1");
    expect(postStopBody?.message).toContain("pigeon is restarting");
    expect(postStopBody?.message).toContain("that turn was cancelled and will not finish");
    expect(postStopBody?.event).toBe("Error");
    expect(postStopBody?.error_kind).toBe("goose-turn-cancelled-by-restart");

    expect(inflight.deletes).toContain("cmd_bare_1");
    expect(inflight.get("cmd_bare_1")).toBeUndefined();
    expect(inbox.markDone).toHaveBeenCalledWith("cmd_bare_1");
    expect(runner.isClosed).toBe(true);
  });

  it("bare goose runner: postStop throws → inflight row kept, inbox.markDone NOT called", async () => {
    const inflight = new FakeInflightStore();
    const inbox = { markDone: vi.fn() };

    const client = new FakeClient(false);
    const registry = new GooseRunnerRegistry({
      inbox,
      inflight,
      createRunner: (s) =>
        new GooseSessionRunner({
          session: s,
          client,
          inflight,
          postStop: async () => {
            throw new Error("app not ready / network error");
          },
          touch: () => {},
        }),
    });

    const session = makeSession("ses_bare_throw");
    const runner = registry.get(session);
    await runner.deliver("cmd_bare_fail", "do work");

    expect(inflight.get("cmd_bare_fail")).toBeDefined();

    await registry.suspendAll();

    // Row is kept
    expect(inflight.deletes).not.toContain("cmd_bare_fail");
    expect(inflight.get("cmd_bare_fail")).toBeDefined();
    expect(inbox.markDone).not.toHaveBeenCalled();
    expect(runner.isClosed).toBe(true);
  });

  it("honk runner: markSuspended, row KEPT, NO notice posted, inbox.markDone NOT called", async () => {
    const inflight = new FakeInflightStore();
    const inbox = { markDone: vi.fn() };
    const postStop = vi.fn().mockResolvedValue(undefined);

    const client = new FakeClient(true); // isHonk = true
    const registry = new GooseRunnerRegistry({
      inbox,
      inflight,
      createRunner: (s) =>
        new GooseSessionRunner({
          session: s,
          client,
          inflight,
          postStop,
          touch: () => {},
        }),
    });

    const session = makeSession("ses_honk");
    const runner = registry.get(session);
    await runner.deliver("cmd_honk_1", "do honk work");

    expect(inflight.get("cmd_honk_1")).toBeDefined();

    const suspendTime = 999_999;
    await registry.suspendAll({ now: suspendTime });

    // No notice posted
    expect(postStop).not.toHaveBeenCalled();

    // Inflight row marked clean_suspend and KEPT
    expect(inflight.deletes).not.toContain("cmd_honk_1");
    const row = inflight.get("cmd_honk_1")!;
    expect(row).toBeDefined();
    expect(row.cleanSuspend).toBe(true);
    expect(row.lastAliveAt).toBe(suspendTime);
    expect(row.recoveryAttempts).toBe(0);

    // inbox.markDone NOT called (will be done on recovery)
    expect(inbox.markDone).not.toHaveBeenCalled();
    expect(runner.isClosed).toBe(true);
  });

  it("honk runner: latent DisconnectedDuringTurn after close does NOT report or delete row", async () => {
    const inflight = new FakeInflightStore();
    const inbox = { markDone: vi.fn() };
    const postStop = vi.fn().mockResolvedValue(undefined);

    const client = new FakeClient(true);
    // When client.close() is called, reject the in-flight prompt with DisconnectedDuringTurn
    client.onClose = () => {
      client.turns.shift()?.reject(new DisconnectedDuringTurn("ses_honk_latent", "run_honk_abc", 1006));
    };

    const registry = new GooseRunnerRegistry({
      inbox,
      inflight,
      createRunner: (s) =>
        new GooseSessionRunner({
          session: s,
          client,
          inflight,
          postStop,
          touch: () => {},
        }),
    });

    const session = makeSession("ses_honk_latent");
    const runner = registry.get(session);
    await runner.deliver("cmd_honk_latent", "latent disconnect test");

    await registry.suspendAll({ now: 5000 });

    // Allow any pending promises/microtasks to settle
    await runner.settled();

    // postStop must NOT have been called by finishTurn
    expect(postStop).not.toHaveBeenCalled();
    // Row must NOT have been deleted
    expect(inflight.deletes).not.toContain("cmd_honk_latent");
    const row = inflight.get("cmd_honk_latent")!;
    expect(row).toBeDefined();
    expect(row.cleanSuspend).toBe(true);
  });

  it("handles idle runners without errors or notices", async () => {
    const inflight = new FakeInflightStore();
    const inbox = { markDone: vi.fn() };
    const postStop = vi.fn();

    const client = new FakeClient(false);
    const registry = new GooseRunnerRegistry({
      inbox,
      inflight,
      createRunner: (s) =>
        new GooseSessionRunner({
          session: s,
          client,
          inflight,
          postStop,
          touch: () => {},
        }),
    });

    const session = makeSession("ses_idle");
    const runner = registry.get(session);
    expect(runner.isBusy()).toBe(false);

    await registry.suspendAll();

    expect(postStop).not.toHaveBeenCalled();
    expect(inbox.markDone).not.toHaveBeenCalled();
    expect(runner.isClosed).toBe(true);
    expect(registry.size).toBe(0);
  });
});
