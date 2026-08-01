import { afterEach, describe, expect, it, vi } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import {
  DeliveryWatchdog,
  isWakeKind,
  type ClientSet,
  type WatchdogClient,
} from "../src/swarm/delivery-watchdog";

// ---------------------------------------------------------------------------
// Transcript builders — mirror opencode's GET /session/:id/message shape.
// ---------------------------------------------------------------------------

function userMessage(created: number, text: string): unknown {
  return {
    info: { role: "user", time: { created } },
    parts: [{ type: "text", text }],
  };
}

function assistantMessage(opts: {
  created: number;
  completed?: number | null;
  error?: unknown;
  parts?: unknown[];
}): unknown {
  const time: Record<string, number> = { created: opts.created };
  if (typeof opts.completed === "number") time.completed = opts.completed;
  return {
    info: { role: "assistant", time, error: opts.error },
    parts: opts.parts ?? [],
  };
}

function toolPart(start: number, end?: number): unknown {
  return {
    type: "tool",
    state:
      end !== undefined
        ? { status: "completed", time: { start, end } }
        : { status: "running", time: { start } },
  };
}

function textPart(start: number, end?: number): unknown {
  return {
    type: "text",
    text: "...",
    time: end !== undefined ? { start, end } : { start },
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeClient(): WatchdogClient & {
  getSessionMessages: ReturnType<typeof vi.fn>;
  abortSession: ReturnType<typeof vi.fn>;
} {
  return {
    getSessionMessages: vi.fn(async () => [] as unknown[]),
    abortSession: vi.fn(async () => {}),
  };
}

function makeFixture() {
  const storage: StorageDb = openStorageDb(":memory:");
  let now = 1_000_000;
  const clientMap = new Map<string, ClientSet>();
  const sendPlainAlert = vi.fn(async (_text: string, _severity: string) => {});

  const resolveClients = vi.fn((sessionId: string): ClientSet => {
    return clientMap.get(sessionId) ?? { preferred: undefined, all: [] };
  });

  const watchdog = new DeliveryWatchdog({
    storage,
    resolveClients,
    notifier: { sendPlainAlert },
    nowFn: () => now,
    log: () => {},
  });

  function insertHandedOff(opts: {
    msgId: string;
    fromSession: string;
    toSession: string;
    handedOffAt: number;
    kind?: string;
  }): void {
    storage.swarm.insert(
      {
        msgId: opts.msgId,
        fromSession: opts.fromSession,
        toSession: opts.toSession,
        channel: null,
        kind: opts.kind ?? "chat",
        priority: "normal",
        replyTo: null,
        payload: "payload",
      },
      opts.handedOffAt,
    );
    storage.swarm.markHandedOff(opts.msgId, opts.handedOffAt);
  }

  return {
    storage,
    watchdog,
    resolveClients,
    sendPlainAlert,
    clientMap,
    insertHandedOff,
    setNow(v: number) {
      now = v;
    },
    getNow() {
      return now;
    },
  };
}

type Fixture = ReturnType<typeof makeFixture>;

describe("isWakeKind", () => {
  it("correctly identifies wake kinds and near-misses", () => {
    expect(isWakeKind("wake")).toBe(true);
    expect(isWakeKind("wake.self")).toBe(true);
    expect(isWakeKind("wake.checkpoint")).toBe(true);
    expect(isWakeKind("wakeup")).toBe(false);
    expect(isWakeKind("awake")).toBe(false);
    expect(isWakeKind("chat")).toBe(false);
    expect(isWakeKind("")).toBe(false);
  });
});

describe("DeliveryWatchdog", () => {
  let fixture: Fixture | null = null;

  afterEach(() => {
    fixture?.watchdog.stop();
    fixture?.storage.db.close();
    fixture = null;
  });

  it("1. verifies: user row + later completed clean assistant sets verified_at", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    client.getSessionMessages.mockResolvedValue([
      userMessage(100, `<swarm_message v="1" msg_id="m1">`),
      assistantMessage({ created: 200, completed: 300 }),
    ]);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    fixture.setNow(400_000);

    await watchdog.processOnce();

    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.verifiedAt).toBe(400_000);
    expect(row.state).toBe("handed_off");
    expect(sendPlainAlert).not.toHaveBeenCalled();
    expect(client.abortSession).not.toHaveBeenCalled();
  });

  it("2. reply_to=\"<id>\" in another row does NOT count as our user row", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const client = makeClient();
    // A decoy row mentions m1 only as reply_to, and a clean assistant run
    // follows it. If the matcher incorrectly treated reply_to as an anchor,
    // this assistant message would satisfy verification.
    client.getSessionMessages.mockResolvedValue([
      userMessage(50, `<swarm_message v="1" reply_to="m1">`),
      assistantMessage({ created: 100, completed: 200 }),
    ]);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    fixture.setNow(400_000);

    await watchdog.processOnce();

    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.verifiedAt).toBeNull();
    expect(row.state).toBe("queued"); // requeued: no true anchor found
    expect(row.requeueCount).toBe(1);
  });

  it("3. redelivered duplicate: LATEST msg_id match anchors verification", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    // First (stale) delivery attempt at t=50, an in-flight leftover from that
    // attempt at t=70 (completed: null), then the TRUE redelivery anchor at
    // t=200. Using the correct (latest) anchor, the in-flight message at 70
    // is BEFORE the anchor -> blocking, not verifying. If the wrong (first)
    // anchor were used, that same in-flight message would count as serving
    // evidence and incorrectly verify.
    client.getSessionMessages.mockResolvedValue([
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
      assistantMessage({ created: 70, completed: null }),
      userMessage(200, `<swarm_message v="1" msg_id="m1">`),
    ]);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 650_000 });
    fixture.setNow(1_000_000); // age=350_000 (<900_000 stuckAlertMs); silence small

    await watchdog.processOnce();

    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.verifiedAt).toBeNull();
    expect(row.state).toBe("handed_off"); // stuck-but-waiting, not requeued/aborted
    expect(sendPlainAlert).not.toHaveBeenCalled();
    expect(client.abortSession).not.toHaveBeenCalled();
  });

  it("4. later assistant row completed WITH ERROR is not verification; falls through to stuck rules", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const client = makeClient();
    client.getSessionMessages.mockResolvedValue([
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
      assistantMessage({ created: 100, completed: 150, error: { name: "UnknownError" } }),
    ]);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    fixture.setNow(400_000);

    await watchdog.processOnce();

    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.verifiedAt).toBeNull();
    // No in-flight turn at all (the errored assistant already completed) ->
    // idle-never-ran -> requeue.
    expect(row.state).toBe("queued");
    expect(row.requeueCount).toBe(1);
  });

  it("5. serving in-flight turn (created > anchor) verifies, no alert/abort", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    client.getSessionMessages.mockResolvedValue([
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
      assistantMessage({ created: 100, completed: null }),
    ]);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    fixture.setNow(400_000);

    await watchdog.processOnce();

    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.verifiedAt).toBe(400_000);
    expect(sendPlainAlert).not.toHaveBeenCalled();
    expect(client.abortSession).not.toHaveBeenCalled();
  });

  it("6. blocking in-flight turn (created < anchor) triggers stuck rules, not verification", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    client.getSessionMessages.mockResolvedValue([
      assistantMessage({ created: 10, completed: null }),
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
    ]);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 650_000 });
    fixture.setNow(1_000_000); // age below stuckAlertMs, silence below stuckAbortSilenceMs

    await watchdog.processOnce();

    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.verifiedAt).toBeNull();
    expect(row.state).toBe("handed_off");
    expect(sendPlainAlert).not.toHaveBeenCalled();
    expect(client.abortSession).not.toHaveBeenCalled();
  });

  it("7. user row missing: requeue (no abort); terminal + alert on maxRequeues exhaustion", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    client.getSessionMessages.mockResolvedValue([]); // no user row for m1 at all
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });

    // Detection 1: requeueCount 0 -> 1
    fixture.setNow(400_000);
    await watchdog.processOnce();
    let row = storage.swarm.getByMsgId("m1")!;
    expect(row.state).toBe("queued");
    expect(row.requeueCount).toBe(1);
    expect(client.abortSession).not.toHaveBeenCalled();

    // Simulate the arbiter redelivering.
    storage.swarm.markHandedOff("m1", 500_000);
    fixture.setNow(900_000);
    await watchdog.processOnce();
    row = storage.swarm.getByMsgId("m1")!;
    expect(row.requeueCount).toBe(2);

    storage.swarm.markHandedOff("m1", 1_000_000);
    fixture.setNow(1_400_000);
    await watchdog.processOnce();
    row = storage.swarm.getByMsgId("m1")!;
    expect(row.requeueCount).toBe(3);
    expect(row.state).toBe("queued");

    // Detection 4: requeueCount(3) >= maxRequeues(3) -> terminal.
    storage.swarm.markHandedOff("m1", 1_500_000);
    fixture.setNow(1_900_000);
    await watchdog.processOnce();
    row = storage.swarm.getByMsgId("m1")!;
    expect(row.state).toBe("failed");
    expect(sendPlainAlert).toHaveBeenCalledWith(expect.any(String), "error");
    expect(client.abortSession).not.toHaveBeenCalled();

    const notices = storage.db
      .prepare("SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'")
      .all() as Array<Record<string, unknown>>;
    expect(notices).toHaveLength(1);
    expect(notices[0]!.to_session).toBe("ses_a");
  });

  it("8. idle-never-ran: requeue (no abort); bounded terminal on exhaustion", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    const anchorText = `<swarm_message v="1" msg_id="m1">`;
    client.getSessionMessages.mockImplementation(async () => [
      userMessage(50, anchorText),
    ]);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });

    fixture.setNow(400_000);
    await watchdog.processOnce();
    expect(storage.swarm.getByMsgId("m1")!.requeueCount).toBe(1);
    expect(client.abortSession).not.toHaveBeenCalled();

    storage.swarm.markHandedOff("m1", 500_000);
    fixture.setNow(900_000);
    await watchdog.processOnce();
    expect(storage.swarm.getByMsgId("m1")!.requeueCount).toBe(2);

    storage.swarm.markHandedOff("m1", 1_000_000);
    fixture.setNow(1_400_000);
    await watchdog.processOnce();
    expect(storage.swarm.getByMsgId("m1")!.requeueCount).toBe(3);

    storage.swarm.markHandedOff("m1", 1_500_000);
    fixture.setNow(1_900_000);
    await watchdog.processOnce();
    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.state).toBe("failed");
    expect(sendPlainAlert).toHaveBeenCalledWith(expect.any(String), "error");
    expect(client.abortSession).not.toHaveBeenCalled();
  });

  it("9. blocking in-flight with FRESH part activity: labeled ACTIVE warn once past stuckAlertMs, no abort", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    client.getSessionMessages.mockResolvedValue([
      assistantMessage({ created: 10, completed: null, parts: [toolPart(999_000)] }),
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
    ]);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    // age = 1_000_000 > stuckAlertMs(900_000); lastActivity=999_000, silence=1_000 (fresh)
    fixture.setNow(1_000_000);

    await watchdog.processOnce();

    expect(sendPlainAlert).toHaveBeenCalledTimes(1);
    const [text, severity] = sendPlainAlert.mock.calls[0]!;
    expect(text).toContain("ACTIVE");
    expect(text).toContain("m1");
    expect(text).toContain("ses_b");
    // Human-readable durations render alongside the raw ms values.
    expect(text).toContain("1000000ms (17min)");
    expect(text).toContain("1000ms (1s)");
    expect(severity).toBe("warning");
    expect(client.abortSession).not.toHaveBeenCalled();
    expect(storage.swarm.getByMsgId("m1")!.verifiedAt).toBeNull();
  });

  it("10. blocking in-flight, age > stuckAlertMs: alert exactly once (dedupe), pruned on verify", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    const stuckTranscript = [
      assistantMessage({ created: 10, completed: null, parts: [toolPart(999_000)] }),
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
    ];
    client.getSessionMessages.mockImplementation(async () => stuckTranscript);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    fixture.setNow(1_000_000);

    await watchdog.processOnce();
    expect(sendPlainAlert).toHaveBeenCalledTimes(1);
    expect((watchdog as any).stuckAlerted.has("m1")).toBe(true);

    // Repeat cycles: alert must not fire again.
    fixture.setNow(1_050_000);
    await watchdog.processOnce();
    fixture.setNow(1_100_000);
    await watchdog.processOnce();
    expect(sendPlainAlert).toHaveBeenCalledTimes(1);

    // Now let it verify — the dedupe entry should be pruned.
    client.getSessionMessages.mockImplementation(async () => [
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
      assistantMessage({ created: 60, completed: 70 }),
    ]);
    fixture.setNow(1_150_000);
    await watchdog.processOnce();

    expect(storage.swarm.getByMsgId("m1")!.verifiedAt).toBe(1_150_000);
    expect((watchdog as any).stuckAlerted.has("m1")).toBe(false);
  });

  it("11. blocking in-flight past stuckAbortSilenceMs, no aborted_at: TOCTOU refetch then abort+requeue", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const clientA = makeClient();
    const clientB = makeClient();
    const stuckTranscript = [
      assistantMessage({ created: 10, completed: null, parts: [toolPart(10, 20)] }), // silent since t=20
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
    ];
    clientA.getSessionMessages.mockImplementation(async () => stuckTranscript);
    clientMap.set("ses_b", { preferred: clientA, all: [clientA, clientB] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    // silence = now - 20, must exceed stuckAbortSilenceMs (3_600_000)
    fixture.setNow(4_000_000);

    await watchdog.processOnce();

    // Initial fetch + TOCTOU refetch, both via the preferred (readClient).
    expect(clientA.getSessionMessages).toHaveBeenCalledTimes(2);
    expect(clientA.abortSession).toHaveBeenCalledWith("ses_b");
    expect(clientB.abortSession).toHaveBeenCalledWith("ses_b");

    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.abortedAt).toBe(4_000_000);
    expect(row.state).toBe("queued");
    expect(row.requeueCount).toBe(1);
  });

  it("12. TOCTOU: refetch shows fresh activity -> no abort", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const client = makeClient();
    const staleTranscript = [
      assistantMessage({ created: 10, completed: null, parts: [toolPart(10, 20)] }),
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
    ];
    const freshTranscript = [
      assistantMessage({ created: 10, completed: null, parts: [toolPart(10, 3_999_000)] }),
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
    ];
    client.getSessionMessages
      .mockResolvedValueOnce(staleTranscript)
      .mockResolvedValueOnce(freshTranscript);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    fixture.setNow(4_000_000);

    await watchdog.processOnce();

    expect(client.getSessionMessages).toHaveBeenCalledTimes(2);
    expect(client.abortSession).not.toHaveBeenCalled();
    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.abortedAt).toBeNull();
    expect(row.state).toBe("handed_off");
  });

  it("13. aborted_at already set + stuck again post-redelivery: markFailed + error alert + sender delivery.failed", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    client.getSessionMessages.mockResolvedValue([
      assistantMessage({ created: 10, completed: null }),
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
    ]);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    // Simulate: a prior cycle already aborted once and requeued.
    storage.swarm.markAborted("m1", 100_000);
    storage.swarm.requeueForRecovery("m1", 100_000, 5_000);
    storage.swarm.markHandedOff("m1", 200_000); // arbiter redelivered

    fixture.setNow(600_000); // eligible again (> verifyAfterMs past 200_000)

    await watchdog.processOnce();

    expect(client.getSessionMessages).toHaveBeenCalledTimes(1); // no TOCTOU refetch
    expect(client.abortSession).not.toHaveBeenCalled();

    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.state).toBe("failed");
    expect(sendPlainAlert).toHaveBeenCalledWith(expect.any(String), "error");

    const notices = storage.db
      .prepare("SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'")
      .all() as Array<Record<string, unknown>>;
    expect(notices).toHaveLength(1);
    expect(notices[0]!.to_session).toBe("ses_a");
  });

  it("14. 404 handling: confirmed (terminal), contradicted (proceed), 5xx (skip no counter bump)", async () => {
    // Scenario A: confirmed 404 across both clients -> markFailed + alert.
    {
      const f = makeFixture();
      const clientA = makeClient();
      const clientB = makeClient();
      clientA.getSessionMessages.mockRejectedValue(
        new Error("getSessionMessages failed (404): not found"),
      );
      clientB.getSessionMessages.mockRejectedValue(
        new Error("getSessionMessages failed (404): not found"),
      );
      f.clientMap.set("ses_b", { preferred: clientA, all: [clientA, clientB] });
      f.insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
      f.setNow(400_000);

      await f.watchdog.processOnce();

      expect(clientB.getSessionMessages).toHaveBeenCalledTimes(1);
      const row = f.storage.swarm.getByMsgId("m1")!;
      expect(row.state).toBe("failed");
      expect(f.sendPlainAlert).toHaveBeenCalledWith(expect.any(String), "error");
      f.watchdog.stop();
      f.storage.db.close();
    }

    // Scenario B: contradicted — other serve returns 200 -> proceed with it.
    {
      const f = makeFixture();
      const clientA = makeClient();
      const clientB = makeClient();
      clientA.getSessionMessages.mockRejectedValue(
        new Error("getSessionMessages failed (404): not found"),
      );
      clientB.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="m1">`),
        assistantMessage({ created: 100, completed: 200 }),
      ]);
      f.clientMap.set("ses_b", { preferred: clientA, all: [clientA, clientB] });
      f.insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
      f.setNow(400_000);

      await f.watchdog.processOnce();

      const row = f.storage.swarm.getByMsgId("m1")!;
      expect(row.verifiedAt).toBe(400_000);
      expect(row.state).toBe("handed_off");
      f.watchdog.stop();
      f.storage.db.close();
    }

    // Scenario C: 5xx -> skip, no counter bump.
    {
      const f = makeFixture();
      const client = makeClient();
      client.getSessionMessages.mockRejectedValue(
        new Error("getSessionMessages failed (500): internal error"),
      );
      f.clientMap.set("ses_b", { preferred: client, all: [client] });
      f.insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
      f.setNow(400_000);

      await f.watchdog.processOnce();

      const row = f.storage.swarm.getByMsgId("m1")!;
      expect(row.state).toBe("handed_off");
      expect(row.verifiedAt).toBeNull();
      expect(row.requeueCount).toBe(0);
      expect(f.sendPlainAlert).not.toHaveBeenCalled();
      f.watchdog.stop();
      f.storage.db.close();
    }
  });

  it("15. broadcast partial failure sets aborted_at (no repeat abort); all-hard-fail leaves aborted_at unset + alert", async () => {
    // Scenario A: one 2xx + one 4xx -> aborted_at set; a later stuck-again
    // cycle goes straight to terminal (no second abort attempt).
    {
      const f = makeFixture();
      const clientA = makeClient();
      const clientB = makeClient();
      const stuckTranscript = [
        assistantMessage({ created: 10, completed: null, parts: [toolPart(10, 20)] }),
        userMessage(50, `<swarm_message v="1" msg_id="m1">`),
      ];
      clientA.getSessionMessages.mockImplementation(async () => stuckTranscript);
      clientA.abortSession.mockResolvedValue(undefined);
      clientB.abortSession.mockRejectedValue(new Error("abortSession failed: 403 Forbidden"));
      f.clientMap.set("ses_b", { preferred: clientA, all: [clientA, clientB] });
      f.insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
      f.setNow(4_000_000);

      await f.watchdog.processOnce();

      let row = f.storage.swarm.getByMsgId("m1")!;
      expect(row.abortedAt).toBe(4_000_000);
      expect(row.state).toBe("queued");
      expect(clientA.abortSession).toHaveBeenCalledTimes(1);
      expect(clientB.abortSession).toHaveBeenCalledTimes(1);

      // Redeliver and get stuck again — must go straight to terminal, no
      // second abort broadcast.
      f.storage.swarm.markHandedOff("m1", 4_100_000);
      clientA.getSessionMessages.mockImplementation(async () => stuckTranscript);
      f.setNow(4_500_000);
      await f.watchdog.processOnce();

      row = f.storage.swarm.getByMsgId("m1")!;
      expect(row.state).toBe("failed");
      expect(clientA.abortSession).toHaveBeenCalledTimes(1); // unchanged
      expect(clientB.abortSession).toHaveBeenCalledTimes(1); // unchanged

      f.watchdog.stop();
      f.storage.db.close();
    }

    // Scenario B: all serves hard-fail -> aborted_at unset, skip + alert.
    {
      const f = makeFixture();
      const clientA = makeClient();
      const clientB = makeClient();
      const stuckTranscript = [
        assistantMessage({ created: 10, completed: null, parts: [toolPart(10, 20)] }),
        userMessage(50, `<swarm_message v="1" msg_id="m1">`),
      ];
      clientA.getSessionMessages.mockImplementation(async () => stuckTranscript);
      clientA.abortSession.mockRejectedValue(new Error("abortSession failed: 500 Internal"));
      clientB.abortSession.mockRejectedValue(new Error("abortSession failed: 500 Internal"));
      f.clientMap.set("ses_b", { preferred: clientA, all: [clientA, clientB] });
      f.insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
      f.setNow(4_000_000);

      await f.watchdog.processOnce();

      const row = f.storage.swarm.getByMsgId("m1")!;
      expect(row.abortedAt).toBeNull();
      expect(row.state).toBe("handed_off");
      expect(f.sendPlainAlert).toHaveBeenCalledWith(expect.any(String), "error");

      f.watchdog.stop();
      f.storage.db.close();
    }
  });

  it("16. abortSession all-fail: no requeue count burn", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const clientA = makeClient();
    const stuckTranscript = [
      assistantMessage({ created: 10, completed: null, parts: [toolPart(10, 20)] }),
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
    ];
    clientA.getSessionMessages.mockImplementation(async () => stuckTranscript);
    clientA.abortSession.mockRejectedValue(new Error("abortSession failed: 500 Internal"));
    clientMap.set("ses_b", { preferred: clientA, all: [clientA] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    fixture.setNow(4_000_000);

    const before = storage.swarm.getByMsgId("m1")!.requeueCount;
    await watchdog.processOnce();
    const after = storage.swarm.getByMsgId("m1")!.requeueCount;

    expect(before).toBe(0);
    expect(after).toBe(0);
    expect(storage.swarm.getByMsgId("m1")!.state).toBe("handed_off");
  });

  it("17. two stuck rows to one session in one cycle: ONE transcript fetch, ONE intervention", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const client = makeClient();
    client.getSessionMessages.mockResolvedValue([
      userMessage(10, `<swarm_message v="1" msg_id="m1">`),
      userMessage(20, `<swarm_message v="1" msg_id="m2">`),
      // No assistant messages at all -> both rows are "idle-never-ran".
    ]);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    insertHandedOff({ msgId: "m2", fromSession: "ses_c", toSession: "ses_b", handedOffAt: 0 });
    fixture.setNow(400_000);

    await watchdog.processOnce();

    expect(client.getSessionMessages).toHaveBeenCalledTimes(1);

    const m1 = storage.swarm.getByMsgId("m1")!;
    const m2 = storage.swarm.getByMsgId("m2")!;
    const requeuedCount = [m1, m2].filter((r) => r.state === "queued").length;
    const untouchedCount = [m1, m2].filter((r) => r.state === "handed_off").length;
    expect(requeuedCount).toBe(1);
    expect(untouchedCount).toBe(1);
  });

  it("18. no healthy serve: skipped; unverified > 1h -> age alarm once, pruned on verify", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, resolveClients, insertHandedOff, sendPlainAlert } = fixture;

    clientMap.set("ses_b", { preferred: undefined, all: [] });
    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });

    // Eligible (past verifyAfterMs) but age < 1h -> skip, no alarm.
    fixture.setNow(400_000);
    await watchdog.processOnce();
    expect(sendPlainAlert).not.toHaveBeenCalled();
    expect(storage.swarm.getByMsgId("m1")!.state).toBe("handed_off");

    // age > 1h -> alarm fires once.
    fixture.setNow(3_700_000);
    await watchdog.processOnce();
    expect(sendPlainAlert).toHaveBeenCalledTimes(1);
    // Human-readable duration renders alongside the raw ms value.
    expect(sendPlainAlert.mock.calls[0]![0]).toContain("3700000ms (62min)");
    expect((watchdog as any).ageAlarmed.has("m1")).toBe(true);

    // Still no healthy serve, still old -> dedupe holds.
    fixture.setNow(3_800_000);
    await watchdog.processOnce();
    expect(sendPlainAlert).toHaveBeenCalledTimes(1);

    // Now a healthy serve appears and verifies the message -> dedupe entry pruned.
    const client = makeClient();
    client.getSessionMessages.mockResolvedValue([
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
      assistantMessage({ created: 100, completed: 200 }),
    ]);
    clientMap.set("ses_b", { preferred: client, all: [client] });
    fixture.setNow(3_900_000);
    await watchdog.processOnce();

    expect(storage.swarm.getByMsgId("m1")!.verifiedAt).toBe(3_900_000);
    expect((watchdog as any).ageAlarmed.has("m1")).toBe(false);
    void resolveClients;
  });

  it("19. re-entrancy: overlapping processOnce calls coalesce (second returns immediately)", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const client = makeClient();
    let resolveFetch!: (v: unknown[]) => void;
    client.getSessionMessages.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    clientMap.set("ses_b", { preferred: client, all: [client] });
    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    fixture.setNow(400_000);

    const listSpy = vi.spyOn(storage.swarm, "listUnverifiedHandedOff");

    const first = watchdog.processOnce();
    const second = watchdog.processOnce();

    const secondResult = await second;
    expect(secondResult.coalesced).toBe(true);
    expect(listSpy).toHaveBeenCalledTimes(1);

    resolveFetch([
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
      assistantMessage({ created: 100, completed: 200 }),
    ]);
    const firstResult = await first;
    expect(firstResult.coalesced).toBe(false);
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it("20. contradicted 404 second opinion: TOCTOU refetch and abort broadcast use the winning (alt) client", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const clientA = makeClient(); // preferred — 404s every time
    const clientB = makeClient(); // alt — the contradicting second opinion
    clientA.getSessionMessages.mockRejectedValue(
      new Error("getSessionMessages failed (404): not found"),
    );
    const stuckTranscript = [
      assistantMessage({ created: 10, completed: null, parts: [toolPart(10, 20)] }), // silent since t=20
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
    ];
    clientB.getSessionMessages.mockImplementation(async () => stuckTranscript);
    clientMap.set("ses_b", { preferred: clientA, all: [clientA, clientB] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    // silence = now - 20, must exceed stuckAbortSilenceMs (3_600_000)
    fixture.setNow(4_000_000);

    await watchdog.processOnce();

    // Preferred (404-ing) client is read exactly once — the initial fetch.
    expect(clientA.getSessionMessages).toHaveBeenCalledTimes(1);
    // The alt client wins the second opinion AND serves the TOCTOU refetch
    // that gates the abort — it must NOT go back to the 404-ing preferred.
    expect(clientB.getSessionMessages).toHaveBeenCalledTimes(2);

    expect(clientA.abortSession).toHaveBeenCalledWith("ses_b");
    expect(clientB.abortSession).toHaveBeenCalledWith("ses_b");

    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.abortedAt).toBe(4_000_000);
    expect(row.state).toBe("queued");
    expect(row.requeueCount).toBe(1);
  });

  it("21. 404 with no second-opinion client available: skip, no counter bump", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    client.getSessionMessages.mockRejectedValue(
      new Error("getSessionMessages failed (404): not found"),
    );
    clientMap.set("ses_b", { preferred: client, all: [client] });
    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    fixture.setNow(400_000);

    await watchdog.processOnce();

    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.state).toBe("handed_off");
    expect(row.verifiedAt).toBeNull();
    expect(row.requeueCount).toBe(0);
    expect(sendPlainAlert).not.toHaveBeenCalled();
  });

  it("22. 404 second-opinion fetch itself errors (non-404): skip, no counter bump", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const clientA = makeClient();
    const clientB = makeClient();
    clientA.getSessionMessages.mockRejectedValue(
      new Error("getSessionMessages failed (404): not found"),
    );
    clientB.getSessionMessages.mockRejectedValue(
      new Error("network error: ECONNRESET"),
    );
    clientMap.set("ses_b", { preferred: clientA, all: [clientA, clientB] });
    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    fixture.setNow(400_000);

    await watchdog.processOnce();

    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.state).toBe("handed_off");
    expect(row.verifiedAt).toBeNull();
    expect(row.requeueCount).toBe(0);
    expect(sendPlainAlert).not.toHaveBeenCalled();
  });

  it("23. dedupe reconciliation: row deleted out-of-band (retention sweep) prunes stale stuckAlerted entry", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    const stuckTranscript = [
      assistantMessage({ created: 10, completed: null, parts: [toolPart(999_000)] }),
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
    ];
    client.getSessionMessages.mockImplementation(async () => stuckTranscript);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    fixture.setNow(1_000_000);

    await watchdog.processOnce();
    expect(sendPlainAlert).toHaveBeenCalledTimes(1);
    expect((watchdog as any).stuckAlerted.has("m1")).toBe(true);

    // Simulate the 7-day retention sweep (cleanupOlderThan) deleting the row
    // out-of-band, without ever routing it through markVerified/markFailed.
    storage.db.prepare("DELETE FROM swarm_messages WHERE msg_id = ?").run("m1");

    fixture.setNow(1_050_000);
    await watchdog.processOnce();

    expect((watchdog as any).stuckAlerted.has("m1")).toBe(false);
  });

  it("24. per-session error isolation: one session's resolveClients throw is caught+logged+skipped; another session's rows still get processed in the same cycle", async () => {
    const storage: StorageDb = openStorageDb(":memory:");
    const logSpy = vi.fn();
    const boom = new Error("boom: resolveClients exploded");

    const clientB = makeClient();
    clientB.getSessionMessages.mockResolvedValue([
      userMessage(50, `<swarm_message v="1" msg_id="m2">`),
      assistantMessage({ created: 100, completed: 200 }),
    ]);

    const resolveClients = vi.fn((sessionId: string): ClientSet => {
      if (sessionId === "ses_bad") throw boom;
      if (sessionId === "ses_b") return { preferred: clientB, all: [clientB] };
      return { preferred: undefined, all: [] };
    });

    const watchdog = new DeliveryWatchdog({
      storage,
      resolveClients,
      nowFn: () => 400_000,
      log: logSpy,
    });

    function insert(msgId: string, fromSession: string, toSession: string): void {
      storage.swarm.insert(
        {
          msgId,
          fromSession,
          toSession,
          channel: null,
          kind: "chat",
          priority: "normal",
          replyTo: null,
          payload: "payload",
        },
        0,
      );
      storage.swarm.markHandedOff(msgId, 0);
    }
    insert("m1", "ses_x", "ses_bad");
    insert("m2", "ses_y", "ses_b");

    const result = await watchdog.processOnce();

    // The whole cycle still resolves cleanly — no top-level `error`.
    expect(result.error).toBeUndefined();
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    // The failing session's row is untouched (not verified, not requeued).
    const badRow = storage.swarm.getByMsgId("m1")!;
    expect(badRow.verifiedAt).toBeNull();
    expect(badRow.state).toBe("handed_off");

    // The healthy session's row still got processed in the SAME cycle.
    expect(storage.swarm.getByMsgId("m2")!.verifiedAt).toBe(400_000);

    expect(logSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sessionId: "ses_bad", error: expect.stringContaining("boom") }),
    );

    watchdog.stop();
    storage.db.close();
  });

  it("25. lifecycle alert budget: warn -> abort+redeliver -> stuck again -> terminal fires sendPlainAlert exactly twice (one warn, one error)", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    const stuckTranscript = [
      assistantMessage({ created: 10, completed: null, parts: [toolPart(10, 20)] }), // silent since t=20
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
    ];
    client.getSessionMessages.mockImplementation(async () => stuckTranscript);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });

    // Episode step 1: past stuckAlertMs but silence still within
    // stuckAbortSilenceMs -> warn alert fires, no abort.
    fixture.setNow(1_000_000); // age=1_000_000>900_000; silence=999_980<=3_600_000
    await watchdog.processOnce();
    expect(sendPlainAlert).toHaveBeenCalledTimes(1);
    expect(sendPlainAlert.mock.calls[0]![1]).toBe("warning");
    expect(storage.swarm.getByMsgId("m1")!.state).toBe("handed_off");

    // Episode step 2: silence now exceeds stuckAbortSilenceMs -> TOCTOU
    // refetch confirms still-stuck -> abort broadcast + requeue. No new
    // alert (the stuck-alert dedupe already fired, and abort success
    // itself doesn't alert).
    fixture.setNow(3_700_000); // silence=3_699_980>3_600_000
    await watchdog.processOnce();
    let row = storage.swarm.getByMsgId("m1")!;
    expect(row.abortedAt).toBe(3_700_000);
    expect(row.state).toBe("queued");
    expect(sendPlainAlert).toHaveBeenCalledTimes(1); // still just the warn

    // Simulate the arbiter redelivering the recovered message.
    storage.swarm.markHandedOff("m1", 3_700_000);

    // Episode step 3: eligible again (past verifyAfterMs) and still stuck on
    // the SAME blocking turn. Because aborted_at is already (permanently)
    // set, this must go straight to terminal — no second abort attempt —
    // firing exactly one more (error) alert.
    fixture.setNow(4_100_000); // age since redelivery = 400_000 > verifyAfterMs(300_000)
    await watchdog.processOnce();
    row = storage.swarm.getByMsgId("m1")!;
    expect(row.state).toBe("failed");
    expect(client.abortSession).toHaveBeenCalledTimes(1); // unchanged since step 2 — no second abort attempt

    expect(sendPlainAlert).toHaveBeenCalledTimes(2);
    expect(sendPlainAlert.mock.calls[1]![1]).toBe("error");
  });

  it("26. pigeon-3m5 regression test: wake message to idle target is NEVER requeued, row stays handed_off, no false failure report", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const client = makeClient();
    const anchorText = `<swarm_message v="1" msg_id="wake1">`;
    const transcript = [userMessage(50, anchorText)];
    client.getSessionMessages.mockImplementation(async () => transcript);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({
      msgId: "wake1",
      fromSession: "ses_a",
      toSession: "ses_b",
      handedOffAt: 0,
      kind: "wake",
    });

    // Run multiple watchdog cycles across advancing time.
    for (const now of [400_000, 900_000, 1_400_000, 1_900_000, 2_400_000]) {
      fixture.setNow(now);
      await watchdog.processOnce();
    }

    const row = storage.swarm.getByMsgId("wake1")!;
    expect(row.state).toBe("handed_off");
    expect(row.requeueCount).toBe(0);

    // Target transcript has exactly 1 envelope.
    expect(transcript).toHaveLength(1);

    // notifySenderOfFailure was never called -> no delivery.failed notice in storage.
    const notices = storage.db
      .prepare("SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'")
      .all();
    expect(notices).toHaveLength(0);
  });

  it("27. wake blocked behind a turn silent for 2h never calls abortSession and never marks aborted", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const client = makeClient();
    const stuckTranscript = [
      assistantMessage({ created: 10, completed: null, parts: [toolPart(10, 20)] }), // silent since t=20
      userMessage(50, `<swarm_message v="1" msg_id="wake2">`),
    ];
    client.getSessionMessages.mockImplementation(async () => stuckTranscript);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({
      msgId: "wake2",
      fromSession: "ses_a",
      toSession: "ses_b",
      handedOffAt: 0,
      kind: "wake.self",
    });

    // 2 hours past silence threshold
    fixture.setNow(7_200_000);
    await watchdog.processOnce();

    expect(client.abortSession).not.toHaveBeenCalled();
    const row = storage.swarm.getByMsgId("wake2")!;
    expect(row.abortedAt).toBeNull();
    expect(row.state).toBe("handed_off");
  });

  it("28. wake whose requeue budget is exhausted (requeueCount >= maxRequeues) is NOT marked failed", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const client = makeClient();
    client.getSessionMessages.mockImplementation(async () => [
      userMessage(50, `<swarm_message v="1" msg_id="wake3">`),
    ]);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({
      msgId: "wake3",
      fromSession: "ses_a",
      toSession: "ses_b",
      handedOffAt: 0,
      kind: "wake.checkpoint",
    });

    // Pre-set requeueCount to maxRequeues (3)
    storage.db
      .prepare("UPDATE swarm_messages SET requeue_count = 3 WHERE msg_id = ?")
      .run("wake3");

    fixture.setNow(400_000);
    await watchdog.processOnce();

    const row = storage.swarm.getByMsgId("wake3")!;
    expect(row.state).toBe("handed_off");

    const notices = storage.db
      .prepare("SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'")
      .all();
    expect(notices).toHaveLength(0);
  });

  it("29. wake that DOES verify normally gets markVerified", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const client = makeClient();
    client.getSessionMessages.mockImplementation(async () => [
      userMessage(50, `<swarm_message v="1" msg_id="wake4">`),
      assistantMessage({ created: 100, completed: 200 }),
    ]);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({
      msgId: "wake4",
      fromSession: "ses_a",
      toSession: "ses_b",
      handedOffAt: 0,
      kind: "wake",
    });

    fixture.setNow(400_000);
    await watchdog.processOnce();

    const row = storage.swarm.getByMsgId("wake4")!;
    expect(row.verifiedAt).toBe(400_000);
    expect(row.state).toBe("handed_off");
  });

  it("30. non-wake kinds (chat, task.assign) retain today's exact behavior (requeued when idle, aborted when stuck)", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const client1 = makeClient();
    clientMap.set("ses_b1", { preferred: client1, all: [client1] });
    client1.getSessionMessages.mockResolvedValue([
      userMessage(50, `<swarm_message v="1" msg_id="chat1">`),
    ]);
    insertHandedOff({
      msgId: "chat1",
      fromSession: "ses_a",
      toSession: "ses_b1",
      handedOffAt: 0,
      kind: "chat",
    });

    const client2 = makeClient();
    clientMap.set("ses_b2", { preferred: client2, all: [client2] });
    client2.getSessionMessages.mockResolvedValue([
      assistantMessage({ created: 10, completed: null, parts: [toolPart(10, 20)] }),
      userMessage(50, `<swarm_message v="1" msg_id="task1">`),
    ]);
    insertHandedOff({
      msgId: "task1",
      fromSession: "ses_a",
      toSession: "ses_b2",
      handedOffAt: 0,
      kind: "task.assign",
    });

    fixture.setNow(4_000_000);
    await watchdog.processOnce();

    expect(storage.swarm.getByMsgId("chat1")!.state).toBe("queued");
    expect(storage.swarm.getByMsgId("chat1")!.requeueCount).toBe(1);

    expect(storage.swarm.getByMsgId("task1")!.state).toBe("queued");
    expect(storage.swarm.getByMsgId("task1")!.abortedAt).toBe(4_000_000);
    expect(client2.abortSession).toHaveBeenCalledWith("ses_b2");
  });
});
