import { GOOSE_BACKEND_KIND } from "../src/goose/backend-kind";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { GooseRunnerRegistry, GooseSessionRunner } from "../src/goose/session-runner";
import { recoverGooseTurns } from "../src/goose/recover-inflight";
import { registerGooseSession } from "../src/goose/register-session";
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
      backendKind: GOOSE_BACKEND_KIND,
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

  it("resumes a turn for a session created by the production registration path (555.15)", async () => {
    // Regression: recovery compared backendKind to the literal "goose" while the
    // real kind is GOOSE_BACKEND_KIND ("goose-acp"), so every in-flight goose
    // turn was deleted and markDone'd on restart with no notice. Fixtures used
    // the same wrong literal, which is why no test caught it. Register through
    // registerGooseSession so the fixture cannot drift from production again.
    const s = newStorage();
    const reg = registerGooseSession(
      s.sessions,
      { machineId: null, backendSessionId: "20261015_1", endpoint: "ws://127.0.0.1:1/acp" },
      1000,
      () => "gse_real",
    );
    expect(reg.ok).toBe(true);
    const now = 1000;
    const postStop = vi.fn().mockResolvedValue(undefined);
    const client = new FakeClient();

    s.inbox.persist({ commandId: "cmd_real", payload: "payload" });
    s.gooseInflight.insert({
      commandId: "cmd_real",
      sessionId: "gse_real",
      backendSessionId: "20261015_1",
      isHonk: true,
      promptText: "real turn",
      cleanSuspend: true,
      createdAt: now,
      lastAliveAt: now,
    });

    const registry = new GooseRunnerRegistry({
      inbox: s.inbox,
      inflight: s.gooseInflight,
      createRunner: (session) =>
        new GooseSessionRunner({ session, client, inflight: s.gooseInflight, postStop, touch: () => {} }),
    });

    await recoverGooseTurns({ storage: s, gooseRunners: registry, now, postStop });

    await new Promise((r) => setTimeout(r, 10));
    expect(client.prompts).toHaveLength(1);
    expect(client.promptOptions[0]?.resumeOnly).toBe(true);
    expect(s.inbox.get("cmd_real")?.status).not.toBe("done");

    client.turns.shift()?.resolve({ kind: "receipt", stopReason: "end_turn", text: "reply" });
    await registry.peek("gse_real")!.settled();
    expect(postStop).toHaveBeenCalledTimes(1);
    expect(s.inbox.get("cmd_real")?.status).toBe("done");
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

  it("two rows for one session, human turn starts between them: row 2 waits for human turn, exactly one receipt each", async () => {
    const s = newStorage();
    createSession(s, "ses_human_interleave");
    const now = 1000;
    const client = new FakeClient();
    const receipts: Array<{ commandId?: string; text?: unknown }> = [];

    let deliverHumanOnR1 = true;
    let runnerRef: GooseSessionRunner | undefined;

    const postStop = vi.fn().mockImplementation(async (body: Record<string, unknown>) => {
      const commandId = String(body.notification_id).replace(/^.*:/, "");
      receipts.push({
        commandId,
        text: body.message,
      });
      if (commandId === "cmd_r1" && deliverHumanOnR1 && runnerRef) {
        deliverHumanOnR1 = false;
        // Human replies immediately upon seeing cmd_r1 notification!
        await runnerRef.deliver("cmd_human", "human question");
      }
    });

    s.inbox.persist({ commandId: "cmd_r1", payload: "payload 1" });
    s.inbox.persist({ commandId: "cmd_r2", payload: "payload 2" });

    s.gooseInflight.insert({
      commandId: "cmd_r2",
      sessionId: "ses_human_interleave",
      backendSessionId: "b_hi",
      isHonk: true,
      promptText: "recovery row 2",
      cleanSuspend: true,
      createdAt: 200,
      lastAliveAt: now,
    });
    s.gooseInflight.insert({
      commandId: "cmd_r1",
      sessionId: "ses_human_interleave",
      backendSessionId: "b_hi",
      isHonk: true,
      promptText: "recovery row 1",
      cleanSuspend: true,
      createdAt: 100,
      lastAliveAt: now,
    });

    const registry = new GooseRunnerRegistry({
      inbox: s.inbox,
      inflight: s.gooseInflight,
      createRunner: (session) => {
        const r = new GooseSessionRunner({
          session,
          client,
          inflight: s.gooseInflight,
          postStop,
          touch: () => {},
        });
        runnerRef = r;
        return r;
      },
    });

    await recoverGooseTurns({
      storage: s,
      gooseRunners: registry,
      now,
      postStop,
    });

    const runner = registry.peek("ses_human_interleave")!;
    expect(runner.activeTurn?.commandId).toBe("cmd_r1");

    await new Promise((r) => setTimeout(r, 10));
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]).toBe("recovery row 1");

    // Settle cmd_r1. In postStop, human delivers cmd_human!
    client.turns.shift()?.resolve({ kind: "receipt", stopReason: "end_turn", text: "reply 1" });

    // Wait for human turn prompt to arrive at client
    await new Promise((r) => setTimeout(r, 15));
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[1]).toBe("human question");
    expect(runner.activeTurn?.commandId).toBe("cmd_human");

    // Settle human turn
    client.turns.shift()?.resolve({ kind: "receipt", stopReason: "end_turn", text: "human answer" });

    // Now recovery should resume row 2 after human turn settles!
    await new Promise((r) => setTimeout(r, 20));
    expect(client.prompts).toHaveLength(3);
    expect(client.prompts[2]).toBe("recovery row 2");
    expect(runner.activeTurn?.commandId).toBe("cmd_r2");

    // Settle cmd_r2
    client.turns.shift()?.resolve({ kind: "receipt", stopReason: "end_turn", text: "reply 2" });
    await runner.settled();

    // Check receipts: exactly one receipt each
    expect(receipts).toHaveLength(3);
    expect(receipts.map((r) => r.commandId)).toEqual(["cmd_r1", "cmd_human", "cmd_r2"]);

    // Both recovery rows gone and marked done
    expect(s.gooseInflight.get("cmd_r1")).toBeUndefined();
    expect(s.gooseInflight.get("cmd_r2")).toBeUndefined();
    expect(s.inbox.get("cmd_r1")?.status).toBe("done");
    expect(s.inbox.get("cmd_r2")?.status).toBe("done");
  });

  describe("Queued rows recovery (Spec bead eng-agent-platform-555.17)", () => {
    it("recovers sent rows first, then hands queued rows in created order to runner.enqueueRecovered without waiting to settle", async () => {
      const s = newStorage();
      const session = createSession(s, "ses_q_rec");
      const client = new FakeClient();
      const registry = new GooseRunnerRegistry({
        inbox: s.inbox,
        inflight: s.gooseInflight,
        createRunner: (sess) =>
          new GooseSessionRunner({
            session: sess,
            client,
            inflight: s.gooseInflight,
            postStop: async () => {},
            touch: () => {},
          }),
      });

      // Insert 1 sent row and 2 queued rows
      s.gooseInflight.insert({
        commandId: "cmd_sent_1",
        sessionId: session.sessionId,
        backendSessionId: "b1",
        isHonk: true,
        promptText: "sent turn",
        createdAt: 100,
        state: "sent",
      });
      s.gooseInflight.insert({
        commandId: "cmd_q_1",
        sessionId: session.sessionId,
        backendSessionId: "b1",
        isHonk: true,
        promptText: "queued turn 1",
        createdAt: 200,
        state: "queued",
      });
      s.gooseInflight.insert({
        commandId: "cmd_q_2",
        sessionId: session.sessionId,
        backendSessionId: "b1",
        isHonk: true,
        promptText: "queued turn 2",
        createdAt: 300,
        state: "queued",
      });

      const runner = registry.get(session);
      const enqueueRecoveredSpy = vi.spyOn(runner, "enqueueRecovered");

      // Run recovery
      const recoverPromise = recoverGooseTurns({
        storage: s,
        gooseRunners: registry,
        now: 1000,
      });

      // Settle the sent row
      await vi.waitFor(() => expect(client.prompts).toHaveLength(1));
      expect(client.prompts[0]).toBe("sent turn");
      client.turns.shift()?.resolve({ kind: "receipt", stopReason: "end_turn", text: "sent answer" });

      await runner.settled();
      await vi.waitFor(() => expect(enqueueRecoveredSpy).toHaveBeenCalledTimes(2));

      // Both queued rows handed to enqueueRecovered in created order
      expect(enqueueRecoveredSpy.mock.calls[0]![0].commandId).toBe("cmd_q_1");
      expect(enqueueRecoveredSpy.mock.calls[1]![0].commandId).toBe("cmd_q_2");
    });

    it("posts notice and deletes queued row older than 24h", async () => {
      const s = newStorage();
      const session = createSession(s, "ses_q_stale");
      const client = new FakeClient();
      const registry = new GooseRunnerRegistry({
        inbox: s.inbox,
        inflight: s.gooseInflight,
        createRunner: (sess) =>
          new GooseSessionRunner({
            session: sess,
            client,
            inflight: s.gooseInflight,
            postStop: async () => {},
            touch: () => {},
          }),
      });

      const now = 200_000_000;
      s.gooseInflight.insert({
        commandId: "cmd_q_stale",
        sessionId: session.sessionId,
        backendSessionId: "b1",
        isHonk: true,
        promptText: "stale queued turn",
        createdAt: now - (25 * 60 * 60 * 1000), // 25h old
        state: "queued",
      });
      s.inbox.persist({
        commandId: "cmd_q_stale",
        payload: "stale queued turn",
      });

      const notices: Array<Record<string, unknown>> = [];
      await recoverGooseTurns({
        storage: s,
        gooseRunners: registry,
        now,
        postStop: async (body) => {
          notices.push(body);
        },
      });

      // Row deleted and inbox marked done
      expect(s.gooseInflight.get("cmd_q_stale")).toBeUndefined();
      expect(s.inbox.get("cmd_q_stale")?.status).toBe("done");

      // Stale notice posted
      expect(notices).toHaveLength(1);
      expect(notices[0]!.notification_id).toBe(`s:${session.sessionId}:cmd_q_stale`);
      expect(notices[0]!.message).toBe("pigeon queued this message more than 24h ago and never sent it; nothing was sent");
    });

    it("a deliver() during a resumed turn queues behind the recovered queued row, and nothing drains before the sent rows are processed", async () => {
      const s = newStorage();
      const session = createSession(s, "ses_q_order");
      const client = new FakeClient();
      const registry = new GooseRunnerRegistry({
        inbox: s.inbox,
        inflight: s.gooseInflight,
        createRunner: (sess) =>
          new GooseSessionRunner({
            session: sess,
            client,
            inflight: s.gooseInflight,
            postStop: async () => {},
            touch: () => {},
          }),
      });

      const now = 1000;
      // 1 sent row and 1 queued row
      s.gooseInflight.insert({
        commandId: "cmd_sent",
        sessionId: session.sessionId,
        backendSessionId: "b1",
        isHonk: true,
        promptText: "sent prompt",
        createdAt: 100,
        state: "sent",
      });
      s.gooseInflight.insert({
        commandId: "cmd_queued",
        sessionId: session.sessionId,
        backendSessionId: "b1",
        isHonk: true,
        promptText: "queued prompt",
        createdAt: 200,
        state: "queued",
      });

      const runner = registry.get(session);

      // Start recovery in background
      void recoverGooseTurns({
        storage: s,
        gooseRunners: registry,
        now,
      });

      // Wait for resumed sent row to start
      await vi.waitFor(() => expect(client.prompts).toHaveLength(1));
      expect(client.prompts[0]).toBe("sent prompt");
      expect(runner.activeTurn?.commandId).toBe("cmd_sent");

      // While cmd_sent is active, poller delivers cmd_poller
      const deliverRes = await runner.deliver("cmd_poller", "poller prompt");
      expect(deliverRes.ok).toBe(true);
      expect(deliverRes.meta?.mode).toBe("queued");

      // Nothing drains before the sent rows are processed
      await new Promise((r) => setTimeout(r, 20));
      expect(client.prompts).toHaveLength(1);

      // Settle sent row
      client.turns.shift()?.resolve({ kind: "receipt", stopReason: "end_turn", text: "sent answer" });
      await runner.settled();

      // Now queued row should drain FIRST (before cmd_poller)
      await vi.waitFor(() => expect(client.prompts).toHaveLength(2));
      expect(client.prompts[1]).toBe("queued prompt");
      expect(runner.activeTurn?.commandId).toBe("cmd_queued");

      // Settle queued row
      client.turns.shift()?.resolve({ kind: "receipt", stopReason: "end_turn", text: "queued answer" });
      await runner.settled();

      // Finally poller row drains
      await vi.waitFor(() => expect(client.prompts).toHaveLength(3));
      expect(client.prompts[2]).toBe("poller prompt");
      expect(runner.activeTurn?.commandId).toBe("cmd_poller");
    });
  });
});
