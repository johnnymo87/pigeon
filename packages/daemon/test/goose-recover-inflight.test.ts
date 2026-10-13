import { afterEach, describe, expect, it, vi } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { GooseRunnerRegistry, GooseSessionRunner } from "../src/goose/session-runner";
import { recoverGooseTurns } from "../src/goose/recover-inflight";
import type { SessionRecord } from "../src/storage/types";

class FakeClient {
  connected = false;
  closed = false;
  prompts: string[] = [];
  promptOptions: Array<{ clientReqId?: string; resumeOnly?: boolean } | undefined> = [];
  turns: Array<{
    text: string;
    resolve: (v: unknown) => void;
    reject: (err: unknown) => void;
  }> = [];
  isHonk = true;
  supportsResumeOnly = true;

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

  async steer(): Promise<unknown> {
    return { kind: "steered" };
  }

  activeRunId(): string | undefined {
    return undefined;
  }

  cancel(): void {}
  async ping(): Promise<void> {}
  close(): void {
    this.closed = true;
  }
}

describe("recoverGooseTurns (Commit 2)", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  function newStorage(): StorageDb {
    storage = openStorageDb(":memory:");
    return storage;
  }

  function createSession(
    s: StorageDb,
    sessionId = "ses_rec_1",
    over: Partial<SessionRecord> = {},
  ): SessionRecord {
    s.sessions.upsert({
      sessionId,
      cwd: "/tmp",
      backendKind: "goose",
      notify: true,
      ...over,
    });
    return s.sessions.get(sessionId)!;
  }

  it("deletes rows older than 24h with a log line and no notice (R9)", async () => {
    const s = newStorage();
    createSession(s, "ses_old");
    const now = 25 * 60 * 60 * 1000;
    const postStop = vi.fn();

    s.inbox.persist({ commandId: "cmd_old", payload: "payload" });
    s.gooseInflight.insert({
      commandId: "cmd_old",
      sessionId: "ses_old",
      backendSessionId: "b_old",
      isHonk: true,
      promptText: "old turn",
      createdAt: 0, // 25 hours ago
      lastAliveAt: now,
    });

    const registry = new GooseRunnerRegistry({
      inbox: s.inbox,
      inflight: s.gooseInflight,
      createRunner: (session) =>
        new GooseSessionRunner({
          session,
          client: new FakeClient(),
          inflight: s.gooseInflight,
          postStop,
          touch: () => {},
        }),
    });

    await recoverGooseTurns({
      storage: s,
      gooseRunners: registry,
      now,
      postStop,
    });

    expect(postStop).not.toHaveBeenCalled();
    expect(s.gooseInflight.get("cmd_old")).toBeUndefined();
    expect(s.inbox.get("cmd_old")?.status).toBe("done");
  });

  it("deletes rows whose session is missing or not goose, with no notice", async () => {
    const s = newStorage();
    createSession(s, "ses_missing", { backendKind: "opencode-plugin-direct" });
    const now = 1000;
    const postStop = vi.fn();

    s.inbox.persist({ commandId: "cmd_missing", payload: "payload" });
    s.gooseInflight.insert({
      commandId: "cmd_missing",
      sessionId: "ses_missing", // not goose!
      backendSessionId: "b_m",
      isHonk: true,
      promptText: "missing session",
      createdAt: now,
      lastAliveAt: now,
    });

    const registry = new GooseRunnerRegistry({
      inbox: s.inbox,
      inflight: s.gooseInflight,
      createRunner: () => {
        throw new Error("should not create runner for missing session");
      },
    });

    await recoverGooseTurns({
      storage: s,
      gooseRunners: registry,
      now,
      postStop,
    });

    expect(postStop).not.toHaveBeenCalled();
    expect(s.gooseInflight.get("cmd_missing")).toBeUndefined();
    expect(s.inbox.get("cmd_missing")?.status).toBe("done");
  });

  it("outbox pre-check: deletes row and marks inbox done if normal notification already exists in outbox", async () => {
    const s = newStorage();
    createSession(s, "ses_outbox");
    const now = 1000;
    const postStop = vi.fn();

    s.inbox.persist({ commandId: "cmd_outbox", payload: "payload" });
    s.gooseInflight.insert({
      commandId: "cmd_outbox",
      sessionId: "ses_outbox",
      backendSessionId: "b_o",
      isHonk: true,
      promptText: "outbox check",
      createdAt: now,
      lastAliveAt: now,
    });

    // Insert normal notification id into outbox
    s.outbox.upsert({
      notificationId: "s:ses_outbox:cmd_outbox",
      sessionId: "ses_outbox",
      requestId: "req_1",
      kind: "stop",
      payload: JSON.stringify({ message: "done" }),
      token: "tok_1",
    });

    const registry = new GooseRunnerRegistry({
      inbox: s.inbox,
      inflight: s.gooseInflight,
      createRunner: () => {
        throw new Error("should not create runner");
      },
    });

    await recoverGooseTurns({
      storage: s,
      gooseRunners: registry,
      now,
      postStop,
    });

    expect(postStop).not.toHaveBeenCalled();
    expect(s.gooseInflight.get("cmd_outbox")).toBeUndefined();
    expect(s.inbox.get("cmd_outbox")?.status).toBe("done");
  });

  it("outbox pre-check: deletes row and marks inbox done if stalled notification already exists in outbox", async () => {
    const s = newStorage();
    createSession(s, "ses_stalled");
    const now = 1000;
    const postStop = vi.fn();

    s.inbox.persist({ commandId: "cmd_stalled", payload: "payload" });
    s.gooseInflight.insert({
      commandId: "cmd_stalled",
      sessionId: "ses_stalled",
      backendSessionId: "b_s",
      isHonk: true,
      promptText: "stalled check",
      createdAt: now,
      lastAliveAt: now,
    });

    // Insert stalled notification id into outbox
    s.outbox.upsert({
      notificationId: "s:ses_stalled:cmd_stalled:stalled",
      sessionId: "ses_stalled",
      requestId: "req_2",
      kind: "stop",
      payload: JSON.stringify({ message: "stalled" }),
      token: "tok_2",
    });

    const registry = new GooseRunnerRegistry({
      inbox: s.inbox,
      inflight: s.gooseInflight,
      createRunner: () => {
        throw new Error("should not create runner");
      },
    });

    await recoverGooseTurns({
      storage: s,
      gooseRunners: registry,
      now,
      postStop,
    });

    expect(postStop).not.toHaveBeenCalled();
    expect(s.gooseInflight.get("cmd_stalled")).toBeUndefined();
    expect(s.inbox.get("cmd_stalled")?.status).toBe("done");
  });

  it("R8: quiet session (notify=false) has no outbox row, so recovery re-collects", async () => {
    const s = newStorage();
    // Quiet session
    createSession(s, "ses_quiet", { notify: false });
    const now = 1000;
    const postStop = vi.fn().mockResolvedValue(undefined);
    const client = new FakeClient();

    s.inbox.persist({ commandId: "cmd_quiet", payload: "payload" });
    s.gooseInflight.insert({
      commandId: "cmd_quiet",
      sessionId: "ses_quiet",
      backendSessionId: "b_q",
      isHonk: true,
      promptText: "quiet turn",
      cleanSuspend: true,
      createdAt: now,
      lastAliveAt: now,
    });

    const registry = new GooseRunnerRegistry({
      inbox: s.inbox,
      inflight: s.gooseInflight,
      createRunner: (session) =>
        new GooseSessionRunner({
          session,
          client,
          inflight: s.gooseInflight,
          postStop,
          touch: () => {},
        }),
    });

    await recoverGooseTurns({
      storage: s,
      gooseRunners: registry,
      now,
      postStop,
    });

    // Runner was resumed inline!
    const runner = registry.peek("ses_quiet")!;
    expect(runner).toBeDefined();
    expect(runner.isBusy()).toBe(true);

    // Prompt was sent with resumeOnly: true
    await new Promise((r) => setTimeout(r, 10));
    expect(client.prompts).toHaveLength(1);
    expect(client.promptOptions[0]?.resumeOnly).toBe(true);

    client.turns.shift()?.resolve({ kind: "receipt", stopReason: "end_turn", text: "quiet reply" });
    await runner.settled();

    expect(postStop).toHaveBeenCalledTimes(1);
    expect(s.gooseInflight.get("cmd_quiet")).toBeUndefined();
    expect(s.inbox.get("cmd_quiet")?.status).toBe("done");
  });

  it("attempts: clean_suspend=true does NOT bump attempts", async () => {
    const s = newStorage();
    createSession(s, "ses_clean");
    const now = 1000;
    const postStop = vi.fn().mockResolvedValue(undefined);
    const client = new FakeClient();

    s.inbox.persist({ commandId: "cmd_clean", payload: "payload" });
    s.gooseInflight.insert({
      commandId: "cmd_clean",
      sessionId: "ses_clean",
      backendSessionId: "b_clean",
      isHonk: true,
      promptText: "clean turn",
      recoveryAttempts: 0,
      cleanSuspend: true,
      createdAt: now,
      lastAliveAt: now,
    });

    const registry = new GooseRunnerRegistry({
      inbox: s.inbox,
      inflight: s.gooseInflight,
      createRunner: (session) =>
        new GooseSessionRunner({
          session,
          client,
          inflight: s.gooseInflight,
          postStop,
          touch: () => {},
        }),
    });

    await recoverGooseTurns({
      storage: s,
      gooseRunners: registry,
      now,
      postStop,
    });

    const row = s.gooseInflight.get("cmd_clean");
    expect(row?.recoveryAttempts).toBe(0); // Not bumped!
  });

  it("attempts: crash rows (clean_suspend=false) bump attempts, >3 posts give-up notice", async () => {
    const s = newStorage();
    createSession(s, "ses_crash");
    const now = 1000;
    let postStopBody: Record<string, unknown> | undefined;

    s.inbox.persist({ commandId: "cmd_poison", payload: "payload" });
    s.gooseInflight.insert({
      commandId: "cmd_poison",
      sessionId: "ses_crash",
      backendSessionId: "b_crash",
      isHonk: true,
      promptText: "poison turn",
      recoveryAttempts: 3, // already 3 attempts!
      cleanSuspend: false, // crashed, not clean suspend
      createdAt: now,
      lastAliveAt: now,
    });

    const registry = new GooseRunnerRegistry({
      inbox: s.inbox,
      inflight: s.gooseInflight,
      createRunner: () => {
        throw new Error("should not create runner");
      },
    });

    await recoverGooseTurns({
      storage: s,
      gooseRunners: registry,
      now,
      postStop: async (body) => {
        postStopBody = body;
      },
    });

    expect(postStopBody).toBeDefined();
    expect(postStopBody?.notification_id).toBe("s:ses_crash:cmd_poison");
    expect(postStopBody?.error_kind).toBe("goose-recovery-exhausted");
    expect(postStopBody?.message).toContain("giving up to prevent crash loop");

    expect(s.gooseInflight.get("cmd_poison")).toBeUndefined();
    expect(s.inbox.get("cmd_poison")?.status).toBe("done");
  });

  it("bare goose (is_honk=false): posts cancelled by restart notice, deletes row, marks inbox done", async () => {
    const s = newStorage();
    createSession(s, "ses_bare");
    const now = 1000;
    let postStopBody: Record<string, unknown> | undefined;

    s.inbox.persist({ commandId: "cmd_bare", payload: "payload" });
    s.gooseInflight.insert({
      commandId: "cmd_bare",
      sessionId: "ses_bare",
      backendSessionId: "b_bare",
      isHonk: false, // bare goose!
      promptText: "bare turn",
      createdAt: now,
      lastAliveAt: now,
    });

    const registry = new GooseRunnerRegistry({
      inbox: s.inbox,
      inflight: s.gooseInflight,
      createRunner: () => {
        throw new Error("should not create runner");
      },
    });

    await recoverGooseTurns({
      storage: s,
      gooseRunners: registry,
      now,
      postStop: async (body) => {
        postStopBody = body;
      },
    });

    expect(postStopBody).toBeDefined();
    expect(postStopBody?.notification_id).toBe("s:ses_bare:cmd_bare");
    expect(postStopBody?.error_kind).toBe("goose-turn-cancelled-by-restart");
    expect(postStopBody?.message).toContain("pigeon is restarting while a goose turn was running");

    expect(s.gooseInflight.get("cmd_bare")).toBeUndefined();
    expect(s.inbox.get("cmd_bare")?.status).toBe("done");
  });

  it("downtime cutoff (>6h from last_alive_at): posts cutoff notice, deletes row, marks inbox done", async () => {
    const s = newStorage();
    createSession(s, "ses_cutoff");
    const now = 7 * 60 * 60 * 1000; // 7h later
    let postStopBody: Record<string, unknown> | undefined;

    s.inbox.persist({ commandId: "cmd_cutoff", payload: "payload" });
    s.gooseInflight.insert({
      commandId: "cmd_cutoff",
      sessionId: "ses_cutoff",
      backendSessionId: "b_cutoff",
      isHonk: true,
      promptText: "cutoff turn",
      cleanSuspend: true,
      createdAt: 0,
      lastAliveAt: 0, // 7h downtime!
    });

    const registry = new GooseRunnerRegistry({
      inbox: s.inbox,
      inflight: s.gooseInflight,
      createRunner: () => {
        throw new Error("should not create runner");
      },
    });

    await recoverGooseTurns({
      storage: s,
      gooseRunners: registry,
      now,
      postStop: async (body) => {
        postStopBody = body;
      },
    });

    expect(postStopBody).toBeDefined();
    expect(postStopBody?.notification_id).toBe("s:ses_cutoff:cmd_cutoff");
    expect(postStopBody?.error_kind).toBe("goose-recovery-cutoff");
    expect(postStopBody?.message).toContain("down too long (>6h)");

    expect(s.gooseInflight.get("cmd_cutoff")).toBeUndefined();
    expect(s.inbox.get("cmd_cutoff")?.status).toBe("done");
  });

  it("processes rows per session oldest-first, one at a time (R5)", async () => {
    const s = newStorage();
    createSession(s, "ses_multi");
    const now = 1000;
    const client = new FakeClient();
    const postStop = vi.fn().mockResolvedValue(undefined);

    s.inbox.persist({ commandId: "cmd_1", payload: "payload" });
    s.inbox.persist({ commandId: "cmd_2", payload: "payload" });

    s.gooseInflight.insert({
      commandId: "cmd_2",
      sessionId: "ses_multi",
      backendSessionId: "b_m",
      isHonk: true,
      promptText: "second turn",
      cleanSuspend: true,
      createdAt: 200,
      lastAliveAt: now,
    });
    s.gooseInflight.insert({
      commandId: "cmd_1",
      sessionId: "ses_multi",
      backendSessionId: "b_m",
      isHonk: true,
      promptText: "first turn",
      cleanSuspend: true,
      createdAt: 100,
      lastAliveAt: now,
    });

    const registry = new GooseRunnerRegistry({
      inbox: s.inbox,
      inflight: s.gooseInflight,
      createRunner: (session) =>
        new GooseSessionRunner({
          session,
          client,
          inflight: s.gooseInflight,
          postStop,
          touch: () => {},
        }),
    });

    await recoverGooseTurns({
      storage: s,
      gooseRunners: registry,
      now,
      postStop,
    });

    const runner = registry.peek("ses_multi")!;
    // Oldest turn (cmd_1) should be live first
    expect(runner.activeTurn?.commandId).toBe("cmd_1");

    await new Promise((r) => setTimeout(r, 10));
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]).toBe("first turn");

    // Settle cmd_1
    client.turns.shift()?.resolve({ kind: "receipt", stopReason: "end_turn", text: "done 1" });
    await runner.settled();

    // Now cmd_2 starts!
    await new Promise((r) => setTimeout(r, 10));
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[1]).toBe("second turn");
    expect(runner.activeTurn?.commandId).toBe("cmd_2");

    // Settle cmd_2
    client.turns.shift()?.resolve({ kind: "receipt", stopReason: "end_turn", text: "done 2" });
    await runner.settled();

    expect(s.gooseInflight.get("cmd_1")).toBeUndefined();
    expect(s.gooseInflight.get("cmd_2")).toBeUndefined();
    expect(s.inbox.get("cmd_1")?.status).toBe("done");
    expect(s.inbox.get("cmd_2")?.status).toBe("done");
  });
});
