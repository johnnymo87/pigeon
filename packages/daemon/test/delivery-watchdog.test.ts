import { afterEach, describe, expect, it, vi } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { formatFailureNotice } from "../src/swarm/notify-sender";
import {
  DeliveryWatchdog,
  isWakeKind,
  isSuppressedFromRecovery,
  type ClientSet,
  type WatchdogClient,
} from "../src/swarm/delivery-watchdog";
import { NUDGE_KIND } from "../src/swarm/delivery-policy";

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
  id?: string;
  created: number;
  completed?: number | null;
  error?: unknown;
  parts?: unknown[];
}): unknown {
  const time: Record<string, number> = { created: opts.created };
  if (typeof opts.completed === "number") time.completed = opts.completed;
  return {
    info: { id: opts.id, role: "assistant", time, error: opts.error },
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

/** `step-start` / `step-finish` carry NO timestamp and appear on every real
 *  turn — scaffolding, not evidence of execution. */
function stepPart(type: "step-start" | "step-finish" = "step-start"): unknown {
  return { type };
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

function makeFixture(opts?: {
  directoryForSession?: (sessionId: string) => Promise<string | undefined>;
}) {
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
    directoryForSession: opts?.directoryForSession,
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
    deliverAt?: number | null;
    payload?: string;
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
        payload: opts.payload ?? "payload",
        deliverAt: opts.deliverAt,
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

describe("isSuppressedFromRecovery", () => {
  it("suppresses recovery for wake kinds or non-null deliverAt", () => {
    expect(isSuppressedFromRecovery({ kind: "checkpoint", deliverAt: 100_000 })).toBe(true);
    expect(isSuppressedFromRecovery({ kind: "wake", deliverAt: null })).toBe(true);
    expect(isSuppressedFromRecovery({ kind: "wake.self", deliverAt: null })).toBe(true);
    expect(isSuppressedFromRecovery({ kind: "chat", deliverAt: null })).toBe(false);
    expect(isSuppressedFromRecovery({ kind: "task.assign", deliverAt: null })).toBe(false);
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
    // idle-never-ran -> NUDGE. The row stays handed_off and its payload is
    // never re-injected (pigeon-3m5).
    expect(row.state).toBe("handed_off");
    expect(row.requeueCount).toBe(0);
    expect(row.nudgeCount).toBe(1);
  });

  it("5. serving in-flight turn (created > anchor) that has PRODUCED OUTPUT verifies, no alert/abort", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    client.getSessionMessages.mockResolvedValue([
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
      // Was `parts: []`. That made this test assert the pigeon-s9d bug as
      // intended behaviour: mere existence of an in-flight row counted as
      // proof the turn was running. A turn that is genuinely serving our
      // prompt has emitted something, so the fixture now says so.
      assistantMessage({ created: 100, completed: null, parts: [textPart(120)] }),
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

    // The payload was observed ABSENT on every cycle, so the notice must tell
    // the sender to resend. Keying this on handedOffAt (which IS set here)
    // would emit "the payload IS in the transcript, do NOT resend" and strand
    // the message forever -- the same lie as pigeon-3m5, inverted. This
    // assertion is the guard: the bug hid precisely because the old version of
    // this test checked that a notice existed but never read its text.
    const text = String(notices[0]!.payload);
    expect(text).toContain("was never delivered and was NOT received");
    expect(text).toContain("safe to resend");
    expect(text).not.toContain("Do NOT resend");
  });

  it("8. idle-never-ran: NUDGES (never requeues, never aborts); bounded terminal on nudge exhaustion", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    const anchorText = `<swarm_message v="1" msg_id="m1">`;
    client.getSessionMessages.mockImplementation(async () => [
      userMessage(50, anchorText),
    ]);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });

    // Three nudges, then terminal. Crucially the row NEVER leaves handed_off
    // on the way (a requeue would re-inject the payload) and requeueCount
    // stays 0 forever.
    for (const [tick, expected] of [
      [400_000, 1],
      [900_000, 2],
      [1_400_000, 3],
    ] as const) {
      fixture.setNow(tick);
      await watchdog.processOnce();
      const row = storage.swarm.getByMsgId("m1")!;
      expect(row.nudgeCount).toBe(expected);
      expect(row.state).toBe("handed_off");
      expect(row.requeueCount).toBe(0);
      storage.db.prepare("UPDATE swarm_messages SET state = 'handed_off', handed_off_at = ? WHERE kind = ? AND state = 'queued'").run(tick, NUDGE_KIND);
    }

    fixture.setNow(1_900_000);
    await watchdog.processOnce();
    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.state).toBe("failed");
    expect(row.requeueCount).toBe(0);
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

  it("11. blocking in-flight past stuckAbortSilenceMs: WAITS, never aborts the peer's turn", async () => {
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
    // silence = now - 20, far past the old abort threshold (3_600_000).
    fixture.setNow(4_000_000);

    await watchdog.processOnce();

    // pigeon-0gxy: the blocking turn is somebody else's work, and opencode's
    // run loop re-reads the transcript every step, so that turn may be the one
    // processing our message. We never kill it. No abort, no TOCTOU refetch
    // (nothing to re-check before acting, because we do not act), no requeue.
    expect(clientA.getSessionMessages).toHaveBeenCalledTimes(1);
    expect(clientA.abortSession).not.toHaveBeenCalled();
    expect(clientB.abortSession).not.toHaveBeenCalled();

    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.abortedAt).toBeNull();
    expect(row.state).toBe("handed_off");
    expect(row.requeueCount).toBe(0);
    expect(row.nudgeCount).toBe(0); // not nudged either — the target is busy
  });

  it("12. blocked row is nudged once the blocking turn finishes (delivery still completes without aborting)", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const client = makeClient();
    const blocked = [
      assistantMessage({ created: 10, completed: null, parts: [toolPart(10, 20)] }),
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
    ];
    const finished = [
      assistantMessage({ created: 10, completed: 4_100_000, parts: [toolPart(10, 20)] }),
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
    ];
    client.getSessionMessages.mockImplementation(async () => blocked);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });

    fixture.setNow(4_000_000);
    await watchdog.processOnce();
    expect(storage.swarm.getByMsgId("m1")!.nudgeCount).toBe(0); // still blocked

    // The blocker completes (with a pre-anchor created time, so it is not
    // verification evidence for us). Now the session is idle and we nudge.
    client.getSessionMessages.mockImplementation(async () => finished);
    fixture.setNow(4_200_000);
    await watchdog.processOnce();

    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.nudgeCount).toBe(1);
    expect(row.state).toBe("handed_off");
    expect(client.abortSession).not.toHaveBeenCalled();
  });

  it("13. a historic row with aborted_at set is NOT failed on sight; it waits like any other blocked row", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    client.getSessionMessages.mockResolvedValue([
      assistantMessage({ created: 10, completed: null }),
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
    ]);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    // A row from before R3, when the watchdog still aborted and redelivered.
    storage.swarm.markAborted("m1", 100_000);
    storage.swarm.markHandedOff("m1", 200_000);

    fixture.setNow(600_000);

    await watchdog.processOnce();

    expect(client.abortSession).not.toHaveBeenCalled();

    // The old code marked this failed and told the sender it was NOT received.
    // Both were wrong: the payload is in the transcript, and a turn is running.
    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.state).toBe("handed_off");
    expect(sendPlainAlert).not.toHaveBeenCalledWith(expect.any(String), "error");

    const notices = storage.db
      .prepare("SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'")
      .all() as Array<Record<string, unknown>>;
    expect(notices).toHaveLength(0);
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

  it("15. INVARIANT: abortSession is never called, for any row shape, ever (pigeon-0gxy)", async () => {
    // The abort broadcast, its TOCTOU re-read, its partial-failure handling
    // and the aborted_at bookkeeping were all deleted in R3. This test stands
    // where those four tests used to, and asserts the property that replaced
    // them: pigeon does not touch a peer's running turn to deliver mail.
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const clientA = makeClient();
    const clientB = makeClient();
    clientA.getSessionMessages.mockImplementation(async () => [
      // A turn that has been silent for over an hour — the shape that used to
      // trigger the abort broadcast.
      assistantMessage({ created: 10, completed: null, parts: [toolPart(10, 20)] }),
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
    ]);
    clientMap.set("ses_b", { preferred: clientA, all: [clientA, clientB] });
    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });

    for (const t of [4_000_000, 8_000_000, 12_000_000]) {
      fixture.setNow(t);
      await watchdog.processOnce();
    }

    expect(clientA.abortSession).not.toHaveBeenCalled();
    expect(clientB.abortSession).not.toHaveBeenCalled();
    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.abortedAt).toBeNull();
    expect(row.state).toBe("handed_off");
    expect(row.requeueCount).toBe(0);
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

    // Both rows stay handed_off now (a nudge never requeues), so the budget
    // is visible in nudgeCount rather than in state.
    const m1 = storage.swarm.getByMsgId("m1")!;
    const m2 = storage.swarm.getByMsgId("m2")!;
    expect(m1.state).toBe("handed_off");
    expect(m2.state).toBe("handed_off");
    const nudged = [m1, m2].filter((r) => r.nudgeCount === 1).length;
    const untouched = [m1, m2].filter((r) => r.nudgeCount === 0).length;
    expect(nudged).toBe(1);
    expect(untouched).toBe(1);
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

  it("20. contradicted 404 second opinion: the winning (alt) client serves the read", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const clientA = makeClient(); // preferred — 404s every time
    const clientB = makeClient(); // alt — the contradicting second opinion
    clientA.getSessionMessages.mockRejectedValue(
      new Error("getSessionMessages failed (404): not found"),
    );
    const idleTranscript = [
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
    ];
    clientB.getSessionMessages.mockImplementation(async () => idleTranscript);
    clientMap.set("ses_b", { preferred: clientA, all: [clientA, clientB] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });
    fixture.setNow(4_000_000);

    await watchdog.processOnce();

    // Preferred (404-ing) client is read exactly once — the initial fetch.
    expect(clientA.getSessionMessages).toHaveBeenCalledTimes(1);
    // The alt client wins the second opinion and its transcript is the one we
    // act on. With the abort path gone there is no TOCTOU refetch, so this is
    // a single read rather than two.
    expect(clientB.getSessionMessages).toHaveBeenCalledTimes(1);

    expect(clientA.abortSession).not.toHaveBeenCalled();
    expect(clientB.abortSession).not.toHaveBeenCalled();

    const row = storage.swarm.getByMsgId("m1")!;
    expect(row.abortedAt).toBeNull();
    expect(row.state).toBe("handed_off");
    expect(row.nudgeCount).toBe(1);
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

    // Simulate out-of-band deletion (e.g. manual DB cleanup or nudge deletion)
    // removing the row without ever routing it through markVerified/markFailed.
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

  it("25. lifecycle alert budget: warn once while blocked, then one error alert when nudges are exhausted", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    const blockedTranscript = [
      assistantMessage({ created: 10, completed: null, parts: [toolPart(10, 20)] }), // silent since t=20
      userMessage(50, `<swarm_message v="1" msg_id="m1">`),
    ];
    const idleTranscript = [userMessage(50, `<swarm_message v="1" msg_id="m1">`)];
    client.getSessionMessages.mockImplementation(async () => blockedTranscript);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });

    // Step 1: past stuckAlertMs -> one warn alert, no intervention.
    fixture.setNow(1_000_000);
    await watchdog.processOnce();
    expect(sendPlainAlert).toHaveBeenCalledTimes(1);
    expect(sendPlainAlert.mock.calls[0]![1]).toBe("warning");
    expect(storage.swarm.getByMsgId("m1")!.state).toBe("handed_off");

    // Step 2: silence now far past the OLD abort threshold. We keep waiting,
    // and the stuck-alert dedupe means no new alert.
    fixture.setNow(3_700_000);
    await watchdog.processOnce();
    expect(storage.swarm.getByMsgId("m1")!.state).toBe("handed_off");
    expect(storage.swarm.getByMsgId("m1")!.abortedAt).toBeNull();
    expect(client.abortSession).not.toHaveBeenCalled();
    expect(sendPlainAlert).toHaveBeenCalledTimes(1);

    // Step 3: the blocker goes away. Now we nudge, up to the budget.
    client.getSessionMessages.mockImplementation(async () => idleTranscript);
    for (const t of [4_100_000, 4_500_000, 4_900_000]) {
      fixture.setNow(t);
      await watchdog.processOnce();
      storage.db.prepare("UPDATE swarm_messages SET state = 'handed_off', handed_off_at = ? WHERE kind = ? AND state = 'queued'").run(t, NUDGE_KIND);
    }
    expect(storage.swarm.getByMsgId("m1")!.nudgeCount).toBe(3);
    expect(sendPlainAlert).toHaveBeenCalledTimes(1); // nudging is not alert-worthy

    // Step 4: budget exhausted -> exactly one error alert, and terminal.
    fixture.setNow(5_300_000);
    await watchdog.processOnce();
    expect(storage.swarm.getByMsgId("m1")!.state).toBe("failed");
    expect(sendPlainAlert).toHaveBeenCalledTimes(2);
    expect(sendPlainAlert.mock.calls[1]![1]).toBe("error");
  });

  it("26. pigeon-3m5 regression test: wake message to idle target is NEVER requeued, row stays handed_off during nudges, gets nudged, then terminal without false failure report notice", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    const anchorText = `<swarm_message v="1" msg_id="wake1">`;
    const transcript = [userMessage(50, anchorText)];
    client.getSessionMessages.mockImplementation(async () => transcript);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({
      msgId: "wake1",
      fromSession: "ses_b",
      toSession: "ses_b",
      handedOffAt: 0,
      kind: "wake",
      payload: "WAKE_PAYLOAD_TEST_26",
    });

    // Run 3 watchdog cycles: gets nudged each time, never requeued, stays handed_off
    for (const [now, expectedNudges] of [
      [400_000, 1],
      [900_000, 2],
      [1_400_000, 3],
    ] as const) {
      fixture.setNow(now);
      await watchdog.processOnce();
      const r = storage.swarm.getByMsgId("wake1")!;
      expect(r.state).toBe("handed_off");
      expect(r.requeueCount).toBe(0);
      expect(r.nudgeCount).toBe(expectedNudges);
      storage.db.prepare("UPDATE swarm_messages SET state = 'handed_off', handed_off_at = ? WHERE kind = ? AND state = 'queued'").run(now, NUDGE_KIND);
    }

    // Cycle 4: nudge budget exhausted -> marks failed
    fixture.setNow(1_900_000);
    await watchdog.processOnce();

    const row = storage.swarm.getByMsgId("wake1")!;
    expect(row.state).toBe("failed");
    expect(row.requeueCount).toBe(0);

    // Durable alert fired containing payload text
    const alerts = storage.db
      .prepare("SELECT * FROM operational_alerts")
      .all() as Array<Record<string, unknown>>;
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0]!.text)).toContain("WAKE_PAYLOAD_TEST_26");

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

  it("30. non-wake kinds (chat, task.assign): nudged when idle, left alone when blocked — never requeued, never aborted", async () => {
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

    // Idle target: nudged, payload NOT re-injected.
    const chat = storage.swarm.getByMsgId("chat1")!;
    expect(chat.state).toBe("handed_off");
    expect(chat.requeueCount).toBe(0);
    expect(chat.nudgeCount).toBe(1);

    // Busy target: left strictly alone.
    const task = storage.swarm.getByMsgId("task1")!;
    expect(task.state).toBe("handed_off");
    expect(task.requeueCount).toBe(0);
    expect(task.nudgeCount).toBe(0);
    expect(task.abortedAt).toBeNull();
    expect(client2.abortSession).not.toHaveBeenCalled();
  });

  it("31. Major 1: scheduled message with kind='checkpoint' and deliverAt set now gets nudged on idle target, not requeued", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const client1 = makeClient();
    client1.getSessionMessages.mockImplementation(async () => [
      userMessage(50, `<swarm_message v="1" msg_id="sched1">`),
    ]);
    clientMap.set("ses_b1", { preferred: client1, all: [client1] });

    // Scheduled checkpoint message (deliverAt set) to idle target
    insertHandedOff({
      msgId: "sched1",
      fromSession: "ses_a",
      toSession: "ses_b1",
      handedOffAt: 0,
      kind: "checkpoint",
      deliverAt: 100_000,
    });

    // Positive control: unscheduled chat message (deliverAt null) to idle target
    const client2 = makeClient();
    client2.getSessionMessages.mockImplementation(async () => [
      userMessage(50, `<swarm_message v="1" msg_id="chat_unsched">`),
    ]);
    clientMap.set("ses_b2", { preferred: client2, all: [client2] });

    insertHandedOff({
      msgId: "chat_unsched",
      fromSession: "ses_a",
      toSession: "ses_b2",
      handedOffAt: 0,
      kind: "chat",
      deliverAt: null,
    });

    fixture.setNow(400_000);
    await watchdog.processOnce();

    // Scheduled checkpoint IS recovered by nudge (not requeued, not aborted).
    const rowSched = storage.swarm.getByMsgId("sched1")!;
    expect(rowSched.state).toBe("handed_off");
    expect(rowSched.requeueCount).toBe(0);
    expect(rowSched.nudgeCount).toBe(1);

    // Unscheduled chat IS ALSO recovered by nudge.
    const rowChat = storage.swarm.getByMsgId("chat_unsched")!;
    expect(rowChat.state).toBe("handed_off");
    expect(rowChat.nudgeCount).toBe(1);
    expect(rowChat.requeueCount).toBe(0);
  });

  it("32. Major 2: anchor-null branch alerts with severity error and states prompt not found, wake lost, recovery suppressed", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    // Transcript has NO anchor for wake_lost
    client.getSessionMessages.mockImplementation(async () => []);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({
      msgId: "wake_lost",
      fromSession: "ses_a",
      toSession: "ses_b",
      handedOffAt: 0,
      kind: "wake",
    });

    fixture.setNow(1_000_000); // blockedAge = 1,000,000 > stuckAlertMs (900_000)
    await watchdog.processOnce();

    expect(sendPlainAlert).toHaveBeenCalledTimes(1);
    const [alertText, severity] = sendPlainAlert.mock.calls[0]!;
    expect(severity).toBe("error");
    expect(alertText).not.toContain("expected for idle target");
    expect(alertText).toContain("not found in target transcript");
    expect(alertText).toContain("may be lost");

    // Redelivery is suppressed
    const row = storage.swarm.getByMsgId("wake_lost")!;
    expect(row.state).toBe("handed_off");
    expect(row.requeueCount).toBe(0);
  });

  it("33. a historic wake row carrying aborted_at is left alone (no abort, no terminal)", async () => {
    // Was two near-identical tests, both named "33", both pinned to a guard at
    // a line number that no longer exists. The guard they described (skip
    // recovery when abortedAt is set) is gone with the abort path; what still
    // matters is that a row left over from that era is handled calmly.
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    const client = makeClient();
    client.getSessionMessages.mockImplementation(async () => [
      assistantMessage({ created: 10, completed: null, parts: [toolPart(10, 20)] }),
      userMessage(50, `<swarm_message v="1" msg_id="wake_aborted">`),
    ]);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({
      msgId: "wake_aborted",
      fromSession: "ses_a",
      toSession: "ses_b",
      handedOffAt: 0,
      kind: "wake",
    });
    storage.swarm.markAborted("wake_aborted", 100_000);

    for (const t of [600_000, 4_000_000]) {
      fixture.setNow(t);
      await watchdog.processOnce();
    }

    expect(client.abortSession).not.toHaveBeenCalled();
    const row = storage.swarm.getByMsgId("wake_aborted")!;
    expect(row.state).toBe("handed_off");
    expect(row.nudgeCount).toBe(0); // wake + blocked: no recovery of any kind
  });

  it("34. Minor 1: requeueOrTerminal only counts requeued when requeueForRecovery succeeds", async () => {
    fixture = makeFixture();
    const { storage, watchdog, clientMap, insertHandedOff } = fixture;

    insertHandedOff({
      msgId: "chat_race",
      fromSession: "ses_a",
      toSession: "ses_b",
      handedOffAt: 0,
      kind: "chat",
    });

    const client = makeClient();
    client.getSessionMessages.mockImplementation(async () => {
      // Concurrently change state to 'queued' during transcript fetch (after listUnverifiedHandedOff read it)
      storage.db
        .prepare("UPDATE swarm_messages SET state = 'queued' WHERE msg_id = ?")
        .run("chat_race");
      return []; // anchor === null for non-wake -> requeueOrTerminal
    });
    clientMap.set("ses_b", { preferred: client, all: [client] });

    fixture.setNow(400_000);
    const summary = await watchdog.processOnce();

    expect(summary.requeued).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it("35. Minor 4: wake behind live blocking turn appends recovery suppressed note in alert", async () => {
    fixture = makeFixture();
    const { watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

    const client = makeClient();
    // Blocking turn that is silent (last activity t=100_000)
    const stuckTranscript = [
      assistantMessage({ created: 10, completed: null, parts: [toolPart(100_000)] }),
      userMessage(200_000, `<swarm_message v="1" msg_id="wake_behind_turn">`),
    ];
    client.getSessionMessages.mockImplementation(async () => stuckTranscript);
    clientMap.set("ses_b", { preferred: client, all: [client] });

    insertHandedOff({
      msgId: "wake_behind_turn",
      fromSession: "ses_a",
      toSession: "ses_b",
      handedOffAt: 0,
      kind: "wake",
    });

    fixture.setNow(1_200_000); // blockedAge = 1,200,000 > stuckAlertMs (900_000)
    await watchdog.processOnce();

    expect(sendPlainAlert).toHaveBeenCalledTimes(1);
    const [alertText] = sendPlainAlert.mock.calls[0]!;
    expect(alertText).toContain("recovery suppressed");
  });

  describe("E1: overdue queued alarm", () => {
    it("1. overdue queued row (deliver_at 6 min in the past, still queued) -> alert at severity error naming msg_id", async () => {
      fixture = makeFixture();
      const { storage, watchdog, sendPlainAlert } = fixture;
      const now = 1_000_000;
      fixture.setNow(now);

      // deliverAt = now - 6 minutes (now - 360_000)
      storage.swarm.insert(
        {
          msgId: "msg_overdue_6m",
          fromSession: "ses_a",
          toSession: "ses_b",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "wake",
          deliverAt: now - 360_000,
        },
        now - 360_000,
      );

      await watchdog.processOnce();

      expect(sendPlainAlert).toHaveBeenCalledTimes(1);
      const [text, severity] = sendPlainAlert.mock.calls[0]!;
      expect(severity).toBe("error");
      expect(text).toContain("msg_overdue_6m");
      expect(text).toContain("ses_b");
      expect(text).toContain("overdue");
    });

    it("does NOT alert for an overdue row the arbiter is actively retrying (the 03:00 nightly-reset case)", async () => {
      // The headline false-alarm guard. During the nightly serve bounce a wake
      // scheduled for 03:00 sits queued and overdue ON PURPOSE while the
      // arbiter retries it without charging its attempt budget — the system
      // working exactly as designed. Alarming there would page at 3am claiming
      // the delivery loop was stopped, which is false, and a nightly false
      // alarm is how a real one gets ignored.
      //
      // The discriminator is `updated_at`: every retry path bumps it, so a live
      // loop keeps it fresh. Here the row is 6 minutes overdue but was touched
      // 1 second ago, so it must stay silent.
      fixture = makeFixture();
      const { storage, watchdog, sendPlainAlert } = fixture;
      const now = 1_000_000;
      fixture.setNow(now);

      storage.swarm.insert(
        {
          msgId: "msg_overdue_but_retrying",
          fromSession: "ses_a",
          toSession: "ses_b",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "wake",
          deliverAt: now - 360_000,
        },
        now - 360_000,
      );

      // Arbiter just rescheduled it (uncounted outage retry), bumping updated_at.
      storage.swarm.markRetryUncounted("msg_overdue_but_retrying", now - 1_000, 30_000);

      await watchdog.processOnce();

      expect(sendPlainAlert).not.toHaveBeenCalled();
    });

    it("DOES alert once the arbiter stops touching the row (loop genuinely dead)", async () => {
      // Complement of the test above: same row, same overdue amount, but
      // nothing has touched it in a long time. That is the condition actually
      // worth waking someone for.
      fixture = makeFixture();
      const { storage, watchdog, sendPlainAlert } = fixture;
      const now = 1_000_000;
      fixture.setNow(now);

      storage.swarm.insert(
        {
          msgId: "msg_overdue_abandoned",
          fromSession: "ses_a",
          toSession: "ses_b",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "wake",
          deliverAt: now - 360_000,
        },
        now - 360_000,
      );
      storage.swarm.markRetryUncounted("msg_overdue_abandoned", now - 400_000, 30_000);

      await watchdog.processOnce();

      expect(sendPlainAlert).toHaveBeenCalledTimes(1);
      expect(sendPlainAlert.mock.calls[0]![0]).toContain("msg_overdue_abandoned");
    });

    it("2. same row on a second watchdog cycle -> NO duplicate alert (dedupe works)", async () => {
      fixture = makeFixture();
      const { storage, watchdog, sendPlainAlert } = fixture;
      const now = 1_000_000;
      fixture.setNow(now);

      storage.swarm.insert(
        {
          msgId: "msg_overdue_dedupe",
          fromSession: "ses_a",
          toSession: "ses_b",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "wake",
          deliverAt: now - 360_000,
        },
        now - 360_000,
      );

      await watchdog.processOnce();
      expect(sendPlainAlert).toHaveBeenCalledTimes(1);

      // Second cycle
      fixture.setNow(now + 60_000);
      await watchdog.processOnce();
      expect(sendPlainAlert).toHaveBeenCalledTimes(1); // No new alert
    });

    it("3. a row deliver_at 1 min in the past -> no alert (under 5min threshold)", async () => {
      fixture = makeFixture();
      const { storage, watchdog, sendPlainAlert } = fixture;
      const now = 1_000_000;
      fixture.setNow(now);

      storage.swarm.insert(
        {
          msgId: "msg_overdue_1m",
          fromSession: "ses_a",
          toSession: "ses_b",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "wake",
          deliverAt: now - 60_000, // 1 minute ago < 5 min threshold
        },
        now - 60_000,
      );

      await watchdog.processOnce();
      expect(sendPlainAlert).not.toHaveBeenCalled();
    });

    it("4. a row already delivered (handed_off) -> no alert", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, sendPlainAlert } = fixture;
      const now = 1_000_000;
      fixture.setNow(now);

      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(now - 360_000, `<swarm_message v="1" msg_id="msg_handed_off_overdue">`),
        assistantMessage({ created: now - 350_000, completed: now - 300_000 }),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });

      storage.swarm.insert(
        {
          msgId: "msg_handed_off_overdue",
          fromSession: "ses_a",
          toSession: "ses_b",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "wake",
          deliverAt: now - 360_000,
        },
        now - 360_000,
      );
      storage.swarm.markHandedOff("msg_handed_off_overdue", now - 350_000);

      await watchdog.processOnce();
      expect(sendPlainAlert).not.toHaveBeenCalled();
    });

    it("5. an expired row -> no alert (pins the state filter)", async () => {
      fixture = makeFixture();
      const { storage, watchdog, sendPlainAlert } = fixture;
      const now = 1_000_000;
      fixture.setNow(now);

      storage.swarm.insert(
        {
          msgId: "msg_expired_overdue",
          fromSession: "ses_a",
          toSession: "ses_b",
          channel: null,
          kind: "wake",
          priority: "normal",
          replyTo: null,
          payload: "wake",
          deliverAt: now - 360_000,
          expiresAt: now - 180_000,
        },
        now - 360_000,
      );
      storage.swarm.markExpired("msg_expired_overdue", now - 180_000);

      await watchdog.processOnce();
      expect(sendPlainAlert).not.toHaveBeenCalled();
    });
  });

  describe("wake payload alerting in watchdog", () => {
    it("Path 4: 404-confirmed session deleted for wake message includes payload in sendPlainAlert", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;
      const now = 1_000_000;
      fixture.setNow(now);

      // Preferred client 404s
      const client1 = makeClient();
      client1.getSessionMessages.mockRejectedValue(new Error("getSessionMessages failed (404): Not found"));
      // Second client also 404s -> confirmed session deleted
      const client2 = makeClient();
      client2.getSessionMessages.mockRejectedValue(new Error("getSessionMessages failed (404): Not found"));

      clientMap.set("ses_b", { preferred: client1, all: [client1, client2] });

      insertHandedOff({
        msgId: "m_path4_wake",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: now - 400_000,
        kind: "wake.check",
        deliverAt: now - 450_000,
      });
      // update payload
      storage.db.prepare("UPDATE swarm_messages SET payload = ? WHERE msg_id = ?").run("check production deployment", "m_path4_wake");

      await watchdog.processOnce();

      expect(storage.swarm.getByMsgId("m_path4_wake")!.state).toBe("failed");
      const alerts = storage.db
        .prepare("SELECT * FROM operational_alerts")
        .all() as Array<Record<string, unknown>>;
      expect(alerts).toHaveLength(1);
      const alertText = String(alerts[0]!.text);
      expect(alertText).toContain("m_path4_wake");
      expect(alertText).toContain("ses_b");
      expect(alertText).toContain("check production deployment");
      expect(alertText).toContain("no longer exists");
    });

    it("Path 5: lost-wake-unverified (anchor === null) includes payload in sendPlainAlert", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;
      const now = 1_000_000;
      fixture.setNow(now);

      const client = makeClient();
      // Transcript does NOT contain msg_id -> anchor === null
      client.getSessionMessages.mockResolvedValue([
        userMessage(now - 800_000, "unrelated message"),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });

      insertHandedOff({
        msgId: "m_path5_wake",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: now - 950_000, // stuckAlertMs = 900_000
        kind: "wake",
        deliverAt: now - 1_000_000,
      });
      storage.db.prepare("UPDATE swarm_messages SET payload = ? WHERE msg_id = ?").run("run database migrations", "m_path5_wake");

      await watchdog.processOnce();

      expect(sendPlainAlert).toHaveBeenCalledTimes(1);
      const alertText = sendPlainAlert.mock.calls[0]![0];
      expect(alertText).toContain("m_path5_wake");
      expect(alertText).toContain("ses_b");
      expect(alertText).toContain("run database migrations");
      expect(alertText).toContain("not found in target transcript");
    });
  });

  // -------------------------------------------------------------------------
  // pigeon-s9d: a wake into a session whose working directory was deleted.
  // The turn starts, produces nothing, and never completes. Previously the
  // mere existence of that in-flight row stamped the row verified on the
  // first pass, closing a wake that never ran as a permanent success.
  //
  // The fix makes that state HONESTLY UNKNOWN rather than falsely successful.
  // It deliberately does NOT condemn it: a provider rate-limit produces a
  // byte-identical transcript (opencode surfaces retries as ephemeral session
  // status, never as a part), so failing on this evidence would destroy live
  // wakes that were about to run.
  // -------------------------------------------------------------------------
  describe("pigeon-s9d: started-but-silent turns", () => {
    function silentWakeFixture(msgId: string) {
      const f = makeFixture();
      fixture = f;
      const { clientMap, insertHandedOff } = f;
      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="${msgId}">`),
        // The measured signature: started, zero parts, completed=null forever.
        assistantMessage({ created: 100, completed: null, parts: [] }),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({
        msgId,
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 60,
        kind: "wake",
        deliverAt: 60,
      });
      return { client, f };
    }

    it("s9d-1. THE BUG: a started-but-silent turn is never verified", async () => {
      const msgId = "m_wedged";
      const { f } = silentWakeFixture(msgId);
      const { storage, watchdog } = f;
      f.setNow(400_000); // past verifyAfterMs, when the stamp used to land

      await watchdog.processOnce();

      const row = storage.swarm.getByMsgId(msgId)!;
      // Previously this was 400_000: a wake that never ran, recorded as a
      // confirmed success, permanently removed from every queue that could
      // have caught it.
      expect(row.verifiedAt).toBeNull();
      expect(row.state).toBe("handed_off");
    });

    it("s9d-2. unknown is not failure: hours of silence still does not condemn or requeue the wake", async () => {
      const msgId = "m_patient";
      const { client, f } = silentWakeFixture(msgId);
      const { storage, watchdog, sendPlainAlert } = f;
      f.setNow(6 * 60 * 60 * 1000); // six hours

      await watchdog.processOnce();
      await watchdog.processOnce();

      const row = storage.swarm.getByMsgId(msgId)!;
      expect(row.state).toBe("handed_off"); // not failed
      expect(row.verifiedAt).toBeNull(); // and not verified
      expect(row.requeueCount).toBe(0); // and not redelivered
      expect(client.abortSession).not.toHaveBeenCalled();
      expect(sendPlainAlert).not.toHaveBeenCalled();
      const alerts = storage.db
        .prepare("SELECT COUNT(*) c FROM operational_alerts")
        .get() as { c: number };
      expect(alerts.c).toBe(0);
    });

    it("s9d-3. a rate-limited turn (zero parts, retry surfaced only as session status) is NOT destroyed, and verifies once it finally runs", async () => {
      const msgId = "m_ratelimited";
      const { client, f } = silentWakeFixture(msgId);
      const { storage, watchdog } = f;

      // 429 with a long retry-after: opencode writes no part at all, because
      // `step-start` only lands on the first stream event.
      f.setNow(60 * 60 * 1000);
      await watchdog.processOnce();
      expect(storage.swarm.getByMsgId(msgId)!.state).toBe("handed_off");

      // Limit clears; the turn runs for real.
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="${msgId}">`),
        assistantMessage({
          created: 100,
          completed: null,
          parts: [textPart(3_600_500)],
        }),
      ]);
      f.setNow(3_601_000);
      await watchdog.processOnce();

      const row = storage.swarm.getByMsgId(msgId)!;
      expect(row.verifiedAt).toBe(3_601_000);
      expect(row.state).toBe("handed_off");
    });

    it("s9d-4. long-running tool call (start, no end) counts as progress", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;
      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="m_tool">`),
        assistantMessage({ created: 100, completed: null, parts: [toolPart(150)] }),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({
        msgId: "m_tool",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 60,
        kind: "wake",
        deliverAt: 60,
      });
      fixture.setNow(3 * 900_000);

      await watchdog.processOnce();

      expect(storage.swarm.getByMsgId("m_tool")!.verifiedAt).toBe(3 * 900_000);
      expect(sendPlainAlert).not.toHaveBeenCalled();
    });

    it("s9d-5. a PENDING tool call (no timestamps at all) still counts as evidence the model ran", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff } = fixture;
      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="m_pending">`),
        // ToolStatePending is {status,input,raw} — no `time` field exists.
        // The model emitted a tool call and is blocked on a permission ask.
        assistantMessage({
          created: 100,
          completed: null,
          parts: [
            stepPart("step-start"),
            { type: "tool", state: { status: "pending", input: {}, raw: "" } },
          ],
        }),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({
        msgId: "m_pending",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 60,
        kind: "wake",
        deliverAt: 60,
      });
      fixture.setNow(400_000);

      await watchdog.processOnce();

      expect(storage.swarm.getByMsgId("m_pending")!.verifiedAt).toBe(400_000);
    });

    it("s9d-6. untimed step-start/step-finish scaffolding alone is NOT evidence of execution", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff } = fixture;
      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="m_scaffold">`),
        // Every real turn carries these and neither has a timestamp; counting
        // them would reintroduce the rubber stamp.
        assistantMessage({
          created: 100,
          completed: null,
          parts: [stepPart("step-start"), stepPart("step-finish")],
        }),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({
        msgId: "m_scaffold",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 60,
        kind: "wake",
        deliverAt: 60,
      });
      fixture.setNow(400_000);

      await watchdog.processOnce();

      const row = storage.swarm.getByMsgId("m_scaffold")!;
      expect(row.verifiedAt).toBeNull();
      expect(row.state).toBe("handed_off");
    });

    it("s9d-7. IDLE (no assistant turn at all) still takes the W3 suppression path, unchanged", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff } = fixture;
      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="m_idle">`),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({
        msgId: "m_idle",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 60,
        kind: "wake",
        deliverAt: 60,
      });
      fixture.setNow(400_000);

      await watchdog.processOnce();

      expect(storage.swarm.getByMsgId("m_idle")!.state).toBe("handed_off");
    });

    it("s9d-8. REGRESSION: an ORDINARY message whose turn is silent is NOT requeued (no duplicate injection)", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff } = fixture;
      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="m_chat">`),
        assistantMessage({ created: 100, completed: null, parts: [] }),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({
        msgId: "m_chat",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 60,
        kind: "chat",
      });
      fixture.setNow(400_000);

      await watchdog.processOnce();

      // Ordinary messages are NOT suppressed from recovery, so without the
      // silent-turn branch they would fall into the idle branch and be
      // redelivered — injecting a duplicate prompt into a session that may
      // merely be waiting on a provider retry. prompt_async is not idempotent.
      const row = storage.swarm.getByMsgId("m_chat")!;
      expect(row.state).toBe("handed_off");
      expect(row.requeueCount).toBe(0);
    });

    it("s9d-9. oldest post-anchor silent turn is reported, so later traffic cannot mask it", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff } = fixture;
      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="m_multi">`),
        assistantMessage({ created: 100, completed: null, parts: [] }),
        assistantMessage({ created: 350_000, completed: null, parts: [] }),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({
        msgId: "m_multi",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 60,
        kind: "wake",
        deliverAt: 60,
      });
      fixture.setNow(400_000);

      const logged: Array<Record<string, unknown>> = [];
      const spy = new DeliveryWatchdog({
        storage,
        resolveClients: () => ({ preferred: client, all: [client] }),
        notifier: { sendPlainAlert: async () => {} },
        nowFn: () => 400_000,
        log: (_event: string, fields?: Record<string, unknown>) => {
          if (fields) logged.push(fields);
        },
      });
      await spy.processOnce();

      const skip = logged.find((f) => f.reason === "in-flight-no-output-yet");
      expect(skip).toBeDefined();
      // Anchored on the OLDEST silent turn (created=100), not the newest.
      expect(skip!.silentForMs).toBe(399_900);
    });
  });

  // -------------------------------------------------------------------------
  // pigeon-3m5 (R3): the payload is injected exactly ONCE per msg_id, and a
  // failure report never claims non-receipt for a payload that is sitting in
  // the target's transcript.
  // -------------------------------------------------------------------------
  describe("pigeon-3m5: nudge instead of re-injecting the payload", () => {
    it("3m5-1: the reproduction shape — ordinary send to an unresponsive target never produces a second payload copy", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff } = fixture;

      // Exactly the 2026-07-25 transcript: our envelope is present, and the
      // session never ran a turn for it.
      const client = makeClient();
      client.getSessionMessages.mockImplementation(async () => [
        userMessage(50, `<swarm_message v="1" msg_id="m1">`),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({
        msgId: "m1",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 0,
        kind: "result",
      });

      for (const t of [400_000, 800_000, 1_200_000, 1_600_000, 2_000_000]) {
        fixture.setNow(t);
        await watchdog.processOnce();
        storage.db.prepare("UPDATE swarm_messages SET state = 'handed_off', handed_off_at = ? WHERE kind = ? AND state = 'queued'").run(t, NUDGE_KIND);
      }

      // The row never re-entered the queue, so the arbiter never re-rendered
      // and re-sent the envelope. THIS is the duplicate-injection fix.
      const row = storage.swarm.getByMsgId("m1")!;
      expect(row.requeueCount).toBe(0);

      // And every recovery attempt was a nudge, bounded by the budget.
      const nudges = storage.db
        .prepare("SELECT * FROM swarm_messages WHERE kind = 'swarm.nudge'")
        .all() as Array<Record<string, unknown>>;
      expect(nudges).toHaveLength(3);
    });

    it("3m5-2: the nudge is addressed to the target, references the original, and does not carry the payload", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff } = fixture;

      const client = makeClient();
      client.getSessionMessages.mockImplementation(async () => [
        userMessage(50, `<swarm_message v="1" msg_id="m1">`),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({
        msgId: "m1",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 0,
        payload: "SECRET-ORIGINAL-PAYLOAD",
      });

      fixture.setNow(400_000);
      await watchdog.processOnce();

      const nudge = storage.db
        .prepare("SELECT * FROM swarm_messages WHERE kind = 'swarm.nudge'")
        .get() as Record<string, unknown>;
      expect(nudge.to_session).toBe("ses_b");
      expect(nudge.reply_to).toBe("m1");
      expect(nudge.state).toBe("queued"); // the arbiter will deliver it
      // It names the original so the agent can find it...
      expect(String(nudge.payload)).toContain("m1");
      // ...but NOT in attribute form, which would make the nudge itself match
      // findAnchor's needle and register as an anchor for the original.
      expect(String(nudge.payload)).not.toContain('msg_id="m1"');
      // ...but must NOT restate the payload, or we are back to two copies.
      expect(String(nudge.payload)).not.toContain("SECRET-ORIGINAL-PAYLOAD");
    });

    it("3m5-3: an unread NUDGE never spawns another nudge (no cascade)", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff } = fixture;

      const client = makeClient();
      client.getSessionMessages.mockImplementation(async () => [
        userMessage(50, `<swarm_message v="1" msg_id="n1">`),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({
        msgId: "n1",
        fromSession: "pigeon",
        toSession: "ses_b",
        handedOffAt: 0,
        kind: "swarm.nudge",
      });

      for (const t of [400_000, 800_000, 1_200_000, 1_600_000]) {
        fixture.setNow(t);
        await watchdog.processOnce();
      }

      const row = storage.swarm.getByMsgId("n1")!;
      expect(row.nudgeCount).toBe(0);
      expect(row.state).toBe("handed_off"); // honest unknown, not terminal
      const spawned = storage.db
        .prepare("SELECT COUNT(*) c FROM swarm_messages WHERE kind = 'swarm.nudge'")
        .get() as { c: number };
      expect(spawned.c).toBe(1); // just the one we seeded
    });

    it("3m5-4: a row that left handed_off between read and act is not nudged", async () => {
      fixture = makeFixture();
      const { storage, clientMap, insertHandedOff } = fixture;

      const client = makeClient();
      client.getSessionMessages.mockImplementation(async () => [
        userMessage(50, `<swarm_message v="1" msg_id="m1">`),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });

      // Simulate the race directly at the repo guard: the row leaves
      // handed_off before the nudge is recorded.
      storage.db
        .prepare("UPDATE swarm_messages SET state='cancelled' WHERE msg_id='m1'")
        .run();

      expect(storage.swarm.recordNudge("m1")).toBe(false);
      expect(storage.swarm.getByMsgId("m1")!.nudgeCount).toBe(0);
    });

    it("3m5-5: the failure notice is cut on OBSERVED evidence, not on handedOffAt", () => {
      // A handed-off row whose payload we watched NOT arrive must still be
      // reported as resendable. This is the case that handedOffAt gets wrong.
      const absentButHandedOff = formatFailureNotice(
        { msgId: "m1", handedOffAt: 123 },
        "ses_b",
        "delivery write repeatedly lost",
        "absent",
      );
      expect(absentButHandedOff).toContain("was never delivered");
      expect(absentButHandedOff).toContain("safe to resend");
      expect(absentButHandedOff).not.toContain("Do NOT resend");

      const present = formatFailureNotice(
        { msgId: "m1", handedOffAt: 123 },
        "ses_b",
        "why",
        "present",
      );
      expect(present).toContain("DELIVERY UNCONFIRMED");
      expect(present).not.toContain("was NOT received");
      expect(present).toContain("Do NOT resend");

      // Unobserved falls back to handedOffAt, the best signal available when
      // nobody ever managed to read the transcript.
      expect(
        formatFailureNotice({ msgId: "m1", handedOffAt: null }, "ses_b", "why"),
      ).toContain("was never delivered and was NOT received");
      expect(
        formatFailureNotice({ msgId: "m1", handedOffAt: 9 }, "ses_b", "why"),
      ).toContain("DELIVERY UNCONFIRMED");
    });

    it("3m5-6: terminal report for a handed-off row says UNCONFIRMED and warns against resending", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff } = fixture;

      const client = makeClient();
      client.getSessionMessages.mockImplementation(async () => [
        userMessage(50, `<swarm_message v="1" msg_id="m1">`),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({ msgId: "m1", fromSession: "ses_a", toSession: "ses_b", handedOffAt: 0 });

      for (const t of [400_000, 800_000, 1_200_000, 1_600_000]) {
        fixture.setNow(t);
        await watchdog.processOnce();
        storage.db.prepare("UPDATE swarm_messages SET state = 'handed_off', handed_off_at = ? WHERE kind = ? AND state = 'queued'").run(t, NUDGE_KIND);
      }

      expect(storage.swarm.getByMsgId("m1")!.state).toBe("failed");
      const notice = storage.db
        .prepare("SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'")
        .get() as Record<string, unknown>;
      const text = String(notice.payload);
      // The lie pigeon-3m5 was filed for.
      expect(text).not.toContain("was NOT received");
      expect(text).toContain("DELIVERY UNCONFIRMED");
      expect(text).toContain("Do NOT resend");
    });
  });

  describe("r4-nudge-wakes: suppressed row recovery and nudge exhaustion", () => {
    it("1. SUPPRESSED row (wake and scheduled non-wake) with anchor present and idle session gets NUDGED without payload re-sent", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff } = fixture;

      // Case A: wake kind (label)
      const client1 = makeClient();
      client1.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="wake_idle">`),
      ]);
      clientMap.set("ses_wake", { preferred: client1, all: [client1] });
      insertHandedOff({
        msgId: "wake_idle",
        fromSession: "ses_a",
        toSession: "ses_wake",
        handedOffAt: 0,
        kind: "wake.self",
        payload: "ORIGINAL_WAKE_PAYLOAD",
      });

      // Case B: deliverAt set, non-wake kind (mechanism)
      const client2 = makeClient();
      client2.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="sched_idle">`),
      ]);
      clientMap.set("ses_sched", { preferred: client2, all: [client2] });
      insertHandedOff({
        msgId: "sched_idle",
        fromSession: "ses_a",
        toSession: "ses_sched",
        handedOffAt: 0,
        kind: "task.assign",
        deliverAt: 100_000,
        payload: "ORIGINAL_SCHED_PAYLOAD",
      });

      fixture.setNow(400_000);
      await watchdog.processOnce();

      // Case A asserts
      const rowWake = storage.swarm.getByMsgId("wake_idle")!;
      expect(rowWake.state).toBe("handed_off");
      expect(rowWake.nudgeCount).toBe(1);
      expect(rowWake.requeueCount).toBe(0);

      // Case B asserts
      const rowSched = storage.swarm.getByMsgId("sched_idle")!;
      expect(rowSched.state).toBe("handed_off");
      expect(rowSched.nudgeCount).toBe(1);
      expect(rowSched.requeueCount).toBe(0);

      // Nudge rows inserted in DB
      const nudges = storage.db
        .prepare("SELECT * FROM swarm_messages WHERE kind = 'swarm.nudge' ORDER BY created_at")
        .all() as Array<Record<string, unknown>>;
      expect(nudges).toHaveLength(2);

      expect(nudges[0]!.to_session).toBe("ses_wake");
      expect(nudges[0]!.reply_to).toBe("wake_idle");
      expect(String(nudges[0]!.payload)).not.toContain("ORIGINAL_WAKE_PAYLOAD");

      expect(nudges[1]!.to_session).toBe("ses_sched");
      expect(nudges[1]!.reply_to).toBe("sched_idle");
      expect(String(nudges[1]!.payload)).not.toContain("ORIGINAL_SCHED_PAYLOAD");

      // Verify original envelope was NOT re-sent
      const wakeRowsInDb = storage.db
        .prepare("SELECT * FROM swarm_messages WHERE msg_id = 'wake_idle'")
        .all();
      expect(wakeRowsInDb).toHaveLength(1);
    });

    it("2. Nudge exhaustion for a SUPPRESSED row: marked failed, durable alert enqueued, sender notice written ONLY for cross-session", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff } = fixture;

      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="wake_exhaust">`),
        userMessage(50, `<swarm_message v="1" msg_id="cross_wake_exhaust">`),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });

      // Self-wake: fromSession === toSession
      insertHandedOff({
        msgId: "wake_exhaust",
        fromSession: "ses_b",
        toSession: "ses_b",
        handedOffAt: 0,
        kind: "wake.checkpoint",
        payload: "CRITICAL_CHECKPOINT_DATA_TO_VERIFY",
      });

      // Exhaust 3 nudges
      for (const t of [400_000, 800_000, 1_200_000]) {
        fixture.setNow(t);
        await watchdog.processOnce();
        storage.db.prepare("UPDATE swarm_messages SET state = 'handed_off', handed_off_at = ? WHERE kind = ? AND state = 'queued'").run(t, NUDGE_KIND);
      }

      const rowBefore = storage.swarm.getByMsgId("wake_exhaust")!;
      expect(rowBefore.nudgeCount).toBe(3);
      expect(rowBefore.state).toBe("handed_off");

      // Next cycle triggers exhaustion
      fixture.setNow(1_600_000);
      await watchdog.processOnce();

      const rowAfter = storage.swarm.getByMsgId("wake_exhaust")!;
      expect(rowAfter.state).toBe("failed");

      // Assert durable alert enqueued with payload text and softened wording
      const alerts = storage.db
        .prepare("SELECT * FROM operational_alerts")
        .all() as Array<Record<string, unknown>>;
      expect(alerts).toHaveLength(1);
      const alertText = String(alerts[0]!.text);
      expect(String(alerts[0]!.severity)).toBe("error");
      expect(alertText).toContain("delivery watchdog: wake unverified after nudges exhausted");
      expect(alertText).toContain("wake_exhaust");
      expect(alertText).toContain("CRITICAL_CHECKPOINT_DATA_TO_VERIFY");
      expect(alertText).toContain("payload IS in the transcript but no turn was confirmed to have read it");

      // Assert NO notifySenderOfFailure notice was written for self-wake
      const noticesSelf = storage.db
        .prepare("SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'")
        .all();
      expect(noticesSelf).toHaveLength(0);

      // Now test cross-session wake: fromSession !== toSession
      insertHandedOff({
        msgId: "cross_wake_exhaust",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 0,
        kind: "wake.checkpoint",
        payload: "CROSS_SESSION_WAKE_PAYLOAD",
      });

      for (const t of [2_000_000, 2_400_000, 2_800_000, 3_200_000, 3_600_000]) {
        fixture.setNow(t);
        await watchdog.processOnce();
        storage.db.prepare("UPDATE swarm_messages SET state = 'handed_off', handed_off_at = ? WHERE kind = ? AND state = 'queued'").run(t, NUDGE_KIND);
      }

      expect(storage.swarm.getByMsgId("cross_wake_exhaust")!.state).toBe("failed");
      const noticesCross = storage.db
        .prepare("SELECT * FROM swarm_messages WHERE kind = 'delivery.failed' AND reply_to = 'cross_wake_exhaust'")
        .all() as Array<Record<string, unknown>>;
      expect(noticesCross).toHaveLength(1);
      expect(noticesCross[0]!.to_session).toBe("ses_a");
    });

    it("3. Nudge exhaustion for an ORDINARY row: marked failed, alert fired, sender notice IS written with evidence 'present'", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="chat_exhaust">`),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({
        msgId: "chat_exhaust",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 0,
        kind: "chat",
        payload: "ORDINARY_CHAT_PAYLOAD",
      });

      for (const t of [400_000, 800_000, 1_200_000, 1_600_000]) {
        fixture.setNow(t);
        await watchdog.processOnce();
        storage.db.prepare("UPDATE swarm_messages SET state = 'handed_off', handed_off_at = ? WHERE kind = ? AND state = 'queued'").run(t, NUDGE_KIND);
      }

      const row = storage.swarm.getByMsgId("chat_exhaust")!;
      expect(row.state).toBe("failed");

      expect(sendPlainAlert).toHaveBeenCalledWith(expect.any(String), "error");
      const [alertText] = sendPlainAlert.mock.calls[0]!;
      expect(alertText).toContain("chat_exhaust");
      expect(alertText).toContain("payload IS in the transcript but no turn was confirmed to have read it");

      // Sender notice IS written
      const notices = storage.db
        .prepare("SELECT * FROM swarm_messages WHERE kind = 'delivery.failed'")
        .all() as Array<Record<string, unknown>>;
      expect(notices).toHaveLength(1);
      expect(notices[0]!.to_session).toBe("ses_a");
      const noticePayload = String(notices[0]!.payload);
      expect(noticePayload).toContain("DELIVERY UNCONFIRMED");
      expect(noticePayload).toContain("Do NOT resend");
      expect(noticePayload).not.toContain("was NOT received");
    });

    it("4. A swarm.nudge row that is itself unread does NOT cascade another nudge", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff } = fixture;

      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="nudge_unread">`),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({
        msgId: "nudge_unread",
        fromSession: "pigeon",
        toSession: "ses_b",
        handedOffAt: 0,
        kind: "swarm.nudge",
      });

      fixture.setNow(400_000);
      await watchdog.processOnce();

      const row = storage.swarm.getByMsgId("nudge_unread")!;
      expect(row.state).toBe("handed_off");
      expect(row.nudgeCount).toBe(0);

      const nudges = storage.db
        .prepare("SELECT * FROM swarm_messages WHERE kind = 'swarm.nudge'")
        .all();
      expect(nudges).toHaveLength(1); // Only the initial row, no second nudge created
    });

    it("5. anchor === null branch for suppressed row: unchanged (suppressed from requeue, no nudge, no state change)", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([]); // No anchor in transcript
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({
        msgId: "wake_no_anchor",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 0,
        kind: "wake",
        payload: "MISSING_ANCHOR_PAYLOAD",
      });

      fixture.setNow(1_000_000); // blockedAge > stuckAlertMs (900_000)
      await watchdog.processOnce();

      const row = storage.swarm.getByMsgId("wake_no_anchor")!;
      expect(row.state).toBe("handed_off");
      expect(row.requeueCount).toBe(0);
      expect(row.nudgeCount).toBe(0);

      expect(sendPlainAlert).toHaveBeenCalledTimes(1);
      const [alertText, severity] = sendPlainAlert.mock.calls[0]!;
      expect(severity).toBe("error");
      expect(alertText).toContain("delivery watchdog: prompt lost and unverified");
      expect(alertText).toContain("MISSING_ANCHOR_PAYLOAD");
      expect(alertText).toContain("prompt for msg wake_no_anchor to ses_b not found in target transcript");
    });

    it("6. silent-in-flight branch for suppressed row: unchanged (no nudge, no terminal, state remains handed_off)", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="wake_silent">`),
        assistantMessage({ created: 100, completed: null, parts: [] }), // silent post-anchor turn
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({
        msgId: "wake_silent",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 0,
        kind: "wake",
      });

      fixture.setNow(400_000);
      await watchdog.processOnce();

      const row = storage.swarm.getByMsgId("wake_silent")!;
      expect(row.state).toBe("handed_off");
      expect(row.nudgeCount).toBe(0);
      expect(row.requeueCount).toBe(0);
      expect(sendPlainAlert).not.toHaveBeenCalled();
    });

    it("6b. same-millisecond in-flight zero-part assistant shell is treated as silent-in-flight (not nudged, not failed)", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = fixture;

      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="wake_same_ms">`),
        assistantMessage({ created: 50, completed: null, parts: [] }), // in-flight turn created at EXACT SAME ms as anchor
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({
        msgId: "wake_same_ms",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 0,
        kind: "wake",
      });

      // Run multiple cycles up to maxNudges threshold
      for (const t of [400_000, 800_000, 1_200_000, 1_600_000]) {
        fixture.setNow(t);
        await watchdog.processOnce();
      }

      const row = storage.swarm.getByMsgId("wake_same_ms")!;
      expect(row.state).toBe("handed_off");
      expect(row.nudgeCount).toBe(0);
      expect(row.requeueCount).toBe(0);
      expect(row.verifiedAt).toBeNull();

      // The row DOES escalate an advisory alert once it has been observed
      // silent for long enough — that is the silent-in-flight escalation, and
      // it is exactly what we want for a row we cannot resolve. What must
      // never happen is a state change, asserted above. Pin that the alert is
      // advisory (it reports a turn producing no output) and never terminal.
      expect(sendPlainAlert).toHaveBeenCalledTimes(1);
      const alertTexts = sendPlainAlert.mock.calls.map((c) => String(c[0]));
      for (const text of alertTexts) {
        expect(text).toContain("in-flight turn produces no output");
        expect(text).not.toContain("nudges exhausted");
        expect(text).not.toContain("marking failed");
      }
    });

    it("7. no alert text produced anywhere in idle path contains string 'expected for idle target'", async () => {
      fixture = makeFixture();
      const { watchdog, clientMap, insertHandedOff, sendPlainAlert, storage } = fixture;

      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="wake_check_string">`),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({
        msgId: "wake_check_string",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 0,
        kind: "wake",
        payload: "SOME_WAKE_PAYLOAD",
      });

      // Run through nudges until exhaustion
      for (const t of [400_000, 800_000, 1_200_000, 1_600_000]) {
        fixture.setNow(t);
        await watchdog.processOnce();
        storage.db.prepare("UPDATE swarm_messages SET state = 'handed_off', handed_off_at = ? WHERE kind = ? AND state = 'queued'").run(t, NUDGE_KIND);
      }

      // Collect all alerts sent or enqueued (Fix 7: assert alerts were actually produced)
      const alerts = storage.db
        .prepare("SELECT * FROM operational_alerts")
        .all() as Array<Record<string, unknown>>;
      const totalAlerts = alerts.length + sendPlainAlert.mock.calls.length;
      expect(totalAlerts).toBeGreaterThanOrEqual(1);

      for (const alert of alerts) {
        expect(String(alert.text)).not.toContain("expected for idle target");
      }
      for (const call of sendPlainAlert.mock.calls) {
        const text = call[0];
        expect(text).not.toContain("expected for idle target");
      }
    });

    it("8. Fix 5: nudge budget does not advance if previous nudge is still queued", async () => {
      fixture = makeFixture();
      const { storage, watchdog, clientMap, insertHandedOff } = fixture;

      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="wake_queued_nudge">`),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });
      insertHandedOff({
        msgId: "wake_queued_nudge",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 0,
        kind: "wake",
      });

      // Cycle 1: mints first nudge (nudgeCount -> 1)
      fixture.setNow(400_000);
      await watchdog.processOnce();
      let row = storage.swarm.getByMsgId("wake_queued_nudge")!;
      expect(row.nudgeCount).toBe(1);

      // Do NOT deliver the nudge (it remains queued in DB).
      // Cycle 2: watchdog should skip because previous nudge is still queued.
      fixture.setNow(800_000);
      const summary2 = await watchdog.processOnce();
      expect(summary2.skipped).toBe(1);
      row = storage.swarm.getByMsgId("wake_queued_nudge")!;
      expect(row.nudgeCount).toBe(1); // unchanged!
      expect(row.state).toBe("handed_off"); // not marked failed!

      // Now simulate arbiter delivering the nudge (state -> handed_off).
      const queuedNudges = storage.db
        .prepare("SELECT msg_id FROM swarm_messages WHERE reply_to = ? AND kind = ? AND state = 'queued'")
        .all("wake_queued_nudge", NUDGE_KIND) as Array<{ msg_id: string }>;
      expect(queuedNudges).toHaveLength(1);
      storage.swarm.markHandedOff(queuedNudges[0]!.msg_id, 850_000);

      // Cycle 3: now that previous nudge is handed off, watchdog mints nudge 2 (nudgeCount -> 2).
      fixture.setNow(1_200_000);
      await watchdog.processOnce();
      row = storage.swarm.getByMsgId("wake_queued_nudge")!;
      expect(row.nudgeCount).toBe(2);
    });
  });

  describe("one-shot escalation alert for silent-in-flight rows", () => {
    it("1. does NOT alert on first observation even if turn created timestamp is very old", async () => {
      const f = makeFixture();
      fixture = f;
      const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = f;

      const client = makeClient();
      // Turn created 2_000_000ms ago (very old)
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="m_old_turn">`),
        assistantMessage({ created: 100, completed: null, parts: [] }),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });

      insertHandedOff({
        msgId: "m_old_turn",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 60,
      });

      // First observation at t = 2_000_000
      f.setNow(2_000_000);
      await watchdog.processOnce();

      // Clock starts at first observation, so no alert on cycle 1
      expect(sendPlainAlert).not.toHaveBeenCalled();

      const row = storage.swarm.getByMsgId("m_old_turn")!;
      expect(row.state).toBe("handed_off");
      expect(row.verifiedAt).toBeNull();
      expect(row.nudgeCount).toBe(0);
      expect(row.requeueCount).toBe(0);
    });

    it("2. alerts exactly once after enough time across MULTIPLE cycles; state stays handed_off with no transitions", async () => {
      const f = makeFixture();
      fixture = f;
      const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = f;

      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="m_silent_alert">`),
        assistantMessage({ created: 100, completed: null, parts: [] }),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });

      insertHandedOff({
        msgId: "m_silent_alert",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 60,
      });

      // Cycle 1 at t = 1_000_000 (first observation)
      f.setNow(1_000_000);
      await watchdog.processOnce();
      expect(sendPlainAlert).not.toHaveBeenCalled();

      // Cycle 2 at t = 1_000_000 + 900_001 (past stuckAlertMs = 900_000ms threshold)
      f.setNow(1_900_001);
      await watchdog.processOnce();

      expect(sendPlainAlert).toHaveBeenCalledTimes(1);
      const [text, severity] = sendPlainAlert.mock.calls[0]!;
      expect(severity).toBe("warning");
      expect(text).toContain("m_silent_alert");
      expect(text).toContain("silent for");

      // Verify NO state transition occurred
      const row = storage.swarm.getByMsgId("m_silent_alert")!;
      expect(row.state).toBe("handed_off");
      expect(row.verifiedAt).toBeNull();
      expect(row.nudgeCount).toBe(0);
      expect(row.requeueCount).toBe(0);
    });

    it("3. running further cycles produces NO second alert (dedupe holds)", async () => {
      const f = makeFixture();
      fixture = f;
      const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = f;

      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="m_dedupe">`),
        assistantMessage({ created: 100, completed: null, parts: [] }),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });

      insertHandedOff({
        msgId: "m_dedupe",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 60,
      });

      // Cycle 1
      f.setNow(1_000_000);
      await watchdog.processOnce();

      // Cycle 2: alert fires
      f.setNow(2_000_000);
      await watchdog.processOnce();
      expect(sendPlainAlert).toHaveBeenCalledTimes(1);

      // Cycles 3, 4, 5
      f.setNow(3_000_000);
      await watchdog.processOnce();
      f.setNow(4_000_000);
      await watchdog.processOnce();
      f.setNow(5_000_000);
      await watchdog.processOnce();

      // Still only 1 alert
      expect(sendPlainAlert).toHaveBeenCalledTimes(1);

      const row = storage.swarm.getByMsgId("m_dedupe")!;
      expect(row.state).toBe("handed_off");
      expect(row.verifiedAt).toBeNull();
      expect(row.nudgeCount).toBe(0);
      expect(row.requeueCount).toBe(0);
    });

    it("4. part set changes between cycles reset clock and turn never alerts", async () => {
      const f = makeFixture();
      fixture = f;
      const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = f;

      const client = makeClient();
      let parts: unknown[] = [];
      client.getSessionMessages.mockImplementation(async () => [
        userMessage(50, `<swarm_message v="1" msg_id="m_progressing">`),
        assistantMessage({ created: 100, completed: null, parts }),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });

      insertHandedOff({
        msgId: "m_progressing",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 60,
      });

      // Cycle 1 at t = 1_000_000
      f.setNow(1_000_000);
      await watchdog.processOnce();

      // Cycle 2 at t = 1_500_000 (part added, signature changes)
      parts = [stepPart("step-start")];
      f.setNow(1_500_000);
      await watchdog.processOnce();

      // Cycle 3 at t = 2_000_000 (part added)
      parts = [stepPart("step-start"), stepPart("step-finish")];
      f.setNow(2_000_000);
      await watchdog.processOnce();

      // Cycle 4 at t = 2_500_000 (part added)
      parts = [stepPart("step-start"), stepPart("step-finish"), { type: "unknown" }];
      f.setNow(2_500_000);
      await watchdog.processOnce();

      expect(sendPlainAlert).not.toHaveBeenCalled();

      const row = storage.swarm.getByMsgId("m_progressing")!;
      expect(row.state).toBe("handed_off");
      expect(row.verifiedAt).toBeNull();
      expect(row.nudgeCount).toBe(0);
      expect(row.requeueCount).toBe(0);
    });

    it("5a. alert text corroboration: missing directory names cause and working directory", async () => {
      const missingDir = "/tmp/nonexistent-pigeon-test-dir-12345";
      const directoryForSession = vi.fn(async () => missingDir);

      const f = makeFixture({ directoryForSession });
      fixture = f;
      const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = f;

      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="m_missing_dir">`),
        assistantMessage({ created: 100, completed: null, parts: [] }),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });

      insertHandedOff({
        msgId: "m_missing_dir",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 60,
      });

      f.setNow(1_000_000);
      await watchdog.processOnce();

      f.setNow(2_000_000);
      await watchdog.processOnce();

      expect(sendPlainAlert).toHaveBeenCalledTimes(1);
      const [text] = sendPlainAlert.mock.calls[0]!;
      expect(text).toContain(missingDir);
      expect(text).toContain("not found on daemon filesystem");
      expect(text).toContain("turn cannot proceed");

      const row = storage.swarm.getByMsgId("m_missing_dir")!;
      expect(row.state).toBe("handed_off");
      expect(row.verifiedAt).toBeNull();
      expect(row.nudgeCount).toBe(0);
      expect(row.requeueCount).toBe(0);
    });

    it("5b. alert text corroboration: existing directory states retry possible and cannot distinguish", async () => {
      const existingDir = "/tmp";
      const directoryForSession = vi.fn(async () => existingDir);

      const f = makeFixture({ directoryForSession });
      fixture = f;
      const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = f;

      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="m_existing_dir">`),
        assistantMessage({ created: 100, completed: null, parts: [] }),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });

      insertHandedOff({
        msgId: "m_existing_dir",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 60,
      });

      f.setNow(1_000_000);
      await watchdog.processOnce();

      f.setNow(2_000_000);
      await watchdog.processOnce();

      expect(sendPlainAlert).toHaveBeenCalledTimes(1);
      const [text] = sendPlainAlert.mock.calls[0]!;
      expect(text).toContain(existingDir);
      expect(text).toContain("working directory exists");
      expect(text).toContain("provider retry");

      const row = storage.swarm.getByMsgId("m_existing_dir")!;
      expect(row.state).toBe("handed_off");
      expect(row.verifiedAt).toBeNull();
      expect(row.nudgeCount).toBe(0);
      expect(row.requeueCount).toBe(0);
    });

    it("5c. alert text corroboration: no directoryForSession supplied states directory unresolvable and does not throw", async () => {
      const f = makeFixture(); // no directoryForSession supplied
      fixture = f;
      const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = f;

      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="m_no_dir_fn">`),
        assistantMessage({ created: 100, completed: null, parts: [] }),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });

      insertHandedOff({
        msgId: "m_no_dir_fn",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 60,
      });

      f.setNow(1_000_000);
      await watchdog.processOnce();

      f.setNow(2_000_000);
      await watchdog.processOnce();

      expect(sendPlainAlert).toHaveBeenCalledTimes(1);
      const [text] = sendPlainAlert.mock.calls[0]!;
      expect(text).toContain("working directory unresolvable");
      expect(text).not.toContain("no longer exists");
      expect(text).not.toContain("working directory exists");

      const row = storage.swarm.getByMsgId("m_no_dir_fn")!;
      expect(row.state).toBe("handed_off");
      expect(row.verifiedAt).toBeNull();
      expect(row.nudgeCount).toBe(0);
      expect(row.requeueCount).toBe(0);
    });

    it("5d. directoryForSession hang times out, degrades to unresolvable, and cycle completes without state change", async () => {
      const neverResolvingDir = new Promise<string | undefined>(() => {});
      const directoryForSession = vi.fn(async () => neverResolvingDir);

      const f = makeFixture({ directoryForSession });
      const storage = f.storage;
      const sendPlainAlert = f.sendPlainAlert;
      const watchdog = new DeliveryWatchdog({
        storage,
        resolveClients: f.resolveClients,
        directoryForSession,
        notifier: { sendPlainAlert },
        nowFn: () => f.getNow(),
        log: () => {},
        directoryTimeoutMs: 10,
      });

      const client = makeClient();
      client.getSessionMessages.mockResolvedValue([
        userMessage(50, `<swarm_message v="1" msg_id="m_timeout_dir">`),
        assistantMessage({ created: 100, completed: null, parts: [] }),
      ]);
      f.clientMap.set("ses_b", { preferred: client, all: [client] });

      f.insertHandedOff({
        msgId: "m_timeout_dir",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 60,
      });

      f.setNow(1_000_000);
      await watchdog.processOnce();

      f.setNow(2_000_000);
      await watchdog.processOnce();

      expect(sendPlainAlert).toHaveBeenCalledTimes(1);
      const [text] = sendPlainAlert.mock.calls[0]!;
      expect(text).toContain("working directory unresolvable; cannot determine cause");

      const row = storage.swarm.getByMsgId("m_timeout_dir")!;
      expect(row.state).toBe("handed_off");
      expect(row.verifiedAt).toBeNull();
      expect(row.nudgeCount).toBe(0);
      expect(row.requeueCount).toBe(0);

      watchdog.stop();
    });

    it("6. turn id changes between cycles at constant part count resets clock and prevents alert", async () => {
      const f = makeFixture();
      fixture = f;
      const { storage, watchdog, clientMap, insertHandedOff, sendPlainAlert } = f;

      const client = makeClient();
      let turnId = "turn_1";
      client.getSessionMessages.mockImplementation(async () => [
        userMessage(50, `<swarm_message v="1" msg_id="m_turn_id_change">`),
        assistantMessage({ id: turnId, created: 100, completed: null, parts: [] }),
      ]);
      clientMap.set("ses_b", { preferred: client, all: [client] });

      insertHandedOff({
        msgId: "m_turn_id_change",
        fromSession: "ses_a",
        toSession: "ses_b",
        handedOffAt: 60,
      });

      // Cycle 1 at t = 1_000_000 (first observation for turn_1)
      f.setNow(1_000_000);
      await watchdog.processOnce();

      // Cycle 2 at t = 1_500_000 (turn replaces with turn_2, constant part count = 0)
      turnId = "turn_2";
      f.setNow(1_500_000);
      await watchdog.processOnce();

      // Cycle 3 at t = 2_000_000 (silentMs since turn_2 is 500_000 < 900_000 stuckAlertMs)
      f.setNow(2_000_000);
      await watchdog.processOnce();

      expect(sendPlainAlert).not.toHaveBeenCalled();

      const row = storage.swarm.getByMsgId("m_turn_id_change")!;
      expect(row.state).toBe("handed_off");
      expect(row.verifiedAt).toBeNull();
      expect(row.nudgeCount).toBe(0);
      expect(row.requeueCount).toBe(0);
    });
  });
});
