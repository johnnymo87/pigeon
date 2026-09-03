import { describe, expect, it, vi } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { DeliveryWatchdog, type ClientSet } from "../src/swarm/delivery-watchdog";

/**
 * The fail-closed backend gate.
 *
 * Everything behind `listUnverifiedHandedOff` is opencode-specific: fetch the
 * target's transcript, grep for our envelope, and on a 404 run a "second
 * opinion" that ends in `markFailed` plus a notice telling the sender the
 * message was never written and is SAFE TO RESEND. Run that against a backend
 * with no transcript endpoint and every one of those steps is wrong -- the last
 * one actively invites a duplicate prompt into the context of an agent that
 * holds merge authority.
 *
 * So these tests are mostly about what does NOT happen. The strongest assertion
 * in the file is that `resolveClients` is never called, because that single call
 * is the door to all of it.
 */

const GRACE = 600_000;

function makeFixture() {
  const storage: StorageDb = openStorageDb(":memory:");
  let now = 1_000_000;
  const sendPlainAlert = vi.fn(async (_text: string, _severity: string) => {});
  const resolveClients = vi.fn((_sessionId: string): ClientSet => {
    // A healthy serve is deliberately always available. If the gate leaks, the
    // row reaches real opencode machinery rather than dying on "no client",
    // which is what makes the leak visible.
    return {
      preferred: undefined,
      all: [
        {
          baseUrl: "http://serve-1",
          fetchTranscript: vi.fn(async () => ({ status: 404, messages: [] })),
        } as unknown as ClientSet["all"][number],
      ],
    };
  });
  const isReceiptPending = vi.fn((_msgId: string) => false);

  const watchdog = new DeliveryWatchdog({
    storage,
    resolveClients,
    notifier: { sendPlainAlert },
    nowFn: () => now,
    log: () => {},
    receiptGraceMs: GRACE,
    isReceiptPending,
  });

  function insertHandedOff(opts: {
    msgId: string;
    fromSession?: string;
    toSession?: string;
    handedOffAt?: number;
    family?: string | null;
  }): void {
    const at = opts.handedOffAt ?? 1_000;
    storage.swarm.insert(
      {
        msgId: opts.msgId,
        fromSession: opts.fromSession ?? "ses_sender",
        toSession: opts.toSession ?? "ses_target",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "payload",
      },
      at,
    );
    storage.swarm.markHandedOff(opts.msgId, at);
    if (opts.family !== undefined && opts.family !== null) {
      storage.db
        .prepare("UPDATE swarm_messages SET verify_family = ? WHERE msg_id = ?")
        .run(opts.family, opts.msgId);
    }
  }

  return {
    storage,
    watchdog,
    resolveClients,
    sendPlainAlert,
    isReceiptPending,
    insertHandedOff,
    setNow(v: number) {
      now = v;
    },
    row(msgId: string) {
      return storage.swarm.getByMsgId(msgId);
    },
    /**
     * Read the sender's notices straight from the table rather than via
     * `getInbox`, which only returns rows that have themselves been handed off.
     * A freshly minted failure notice is still `queued`, so `getInbox` would
     * report an empty inbox and this assertion would pass vacuously.
     */
    senderInbox(sessionId = "ses_sender") {
      const rows = storage.db
        .prepare("SELECT payload FROM swarm_messages WHERE to_session = ?")
        .all(sessionId) as Array<{ payload: string }>;
      return rows.map((r) => r.payload).join("\n");
    },
  };
}

describe("fail-closed backend gate", () => {
  it("never lets a receipt-family row reach the transcript or 404 path", async () => {
    const f = makeFixture();
    f.insertHandedOff({ msgId: "msg_receipt", family: "receipt" });
    f.setNow(1_000 + GRACE + 1);

    await f.watchdog.processOnce();

    // The door to the opencode machinery is never opened.
    expect(f.resolveClients).not.toHaveBeenCalled();
  });

  it("survives its target session row being deleted, which a join would not", async () => {
    // The regression this design exists to prevent. `sessions` rows are deleted
    // on expiry while an unverified handed-off message is never reaped, so a
    // design that read the backend from `sessions` would silently reclassify
    // this row into the opencode path purely by waiting.
    const f = makeFixture();
    f.storage.sessions.upsert(
      {
        sessionId: "ses_target",
        origin: "test",
        backendKind: "goose-acp",
      } as never,
      1_000,
    );
    f.insertHandedOff({ msgId: "msg_orphan", family: "receipt" });

    f.storage.db.prepare("DELETE FROM sessions WHERE session_id = ?").run("ses_target");
    expect(
      f.storage.db.prepare("SELECT COUNT(*) AS n FROM sessions").get(),
    ).toEqual({ n: 0 });

    f.setNow(1_000 + GRACE + 1);
    await f.watchdog.processOnce();

    expect(f.resolveClients).not.toHaveBeenCalled();
    expect(f.senderInbox()).not.toContain("safe to resend");
  });

  it("routes a NULL family to the existing opencode machinery", async () => {
    const f = makeFixture();
    f.insertHandedOff({ msgId: "msg_legacy", family: null });
    f.setNow(1_000 + GRACE + 1);

    await f.watchdog.processOnce();

    // NULL means opencode, by failure asymmetry: misreading an opencode row as
    // a receipt row would remove its recovery net entirely (silent loss),
    // whereas the reverse is merely noisy.
    expect(f.resolveClients).toHaveBeenCalledWith("ses_target");
  });

  it("refuses an unrecognised family loudly, and touches nothing", async () => {
    const f = makeFixture();
    f.insertHandedOff({ msgId: "msg_alien", family: "quantum-telepathy" });
    f.setNow(1_000 + GRACE + 1);

    await f.watchdog.processOnce();

    expect(f.resolveClients).not.toHaveBeenCalled();
    expect(f.row("msg_alien")?.state).toBe("handed_off");
    expect(f.row("msg_alien")?.verifiedAt).toBeNull();
    expect(f.sendPlainAlert).toHaveBeenCalledTimes(1);
    expect(f.sendPlainAlert.mock.calls[0]?.[0] ?? "").toContain("unrecognised verify_family");
  });

  it("does not re-alert the same unrecognised row every cycle", async () => {
    // The row is deliberately never touched, so without a dedupe this alarm
    // would fire forever and train the reader to ignore it.
    const f = makeFixture();
    f.insertHandedOff({ msgId: "msg_alien", family: "quantum-telepathy" });
    f.setNow(1_000 + GRACE + 1);

    await f.watchdog.processOnce();
    await f.watchdog.processOnce();

    expect(f.sendPlainAlert).toHaveBeenCalledTimes(1);
  });
});

describe("receipt-family terminal", () => {
  it("tells the sender the payload was delivered but unconfirmed, not that it is safe to resend", async () => {
    const f = makeFixture();
    f.insertHandedOff({ msgId: "msg_receipt", family: "receipt" });
    f.setNow(1_000 + GRACE + 1);

    await f.watchdog.processOnce();

    expect(f.row("msg_receipt")?.state).toBe("failed");
    const inbox = f.senderInbox();
    // "absent" evidence would render "safe to resend". For this backend class
    // the payload IS persisted by the target even when no turn ran, so that
    // wording would talk the sender into a duplicate prompt.
    expect(inbox).not.toContain("safe to resend");
    expect(inbox).toContain("Do NOT resend");
  });

  it("does not requeue, because a missing receipt cannot prove the turn never ran", async () => {
    const f = makeFixture();
    f.insertHandedOff({ msgId: "msg_receipt", family: "receipt" });
    f.setNow(1_000 + GRACE + 1);

    await f.watchdog.processOnce();

    expect(f.row("msg_receipt")?.requeueCount).toBe(0);
    expect(f.row("msg_receipt")?.state).not.toBe("queued");
  });

  it("waits out the grace window before declaring anything", async () => {
    const f = makeFixture();
    f.insertHandedOff({ msgId: "msg_receipt", family: "receipt" });
    f.setNow(1_000 + GRACE - 1);

    await f.watchdog.processOnce();

    expect(f.row("msg_receipt")?.state).toBe("handed_off");
    expect(f.sendPlainAlert).not.toHaveBeenCalled();
  });

  it("leaves a row alone while its receipt is still legitimately outstanding", async () => {
    // For a receipt backend the prompt call IS the turn, so a turn running for
    // longer than the grace window is not evidence of anything wrong.
    const f = makeFixture();
    f.isReceiptPending.mockReturnValue(true);
    f.insertHandedOff({ msgId: "msg_slow", family: "receipt" });
    f.setNow(1_000 + GRACE * 10);

    await f.watchdog.processOnce();

    expect(f.row("msg_slow")?.state).toBe("handed_off");
    expect(f.sendPlainAlert).not.toHaveBeenCalled();
  });
});

describe("state guards added before the second writer exists", () => {
  it("will not stamp verified on a row that is not handed off", async () => {
    const f = makeFixture();
    f.storage.swarm.insert(
      {
        msgId: "msg_cancelled",
        fromSession: "ses_sender",
        toSession: "ses_target",
        channel: null,
        kind: "chat",
        priority: "normal",
        replyTo: null,
        payload: "payload",
      },
      1_000,
    );
    f.storage.swarm.markCancelled("msg_cancelled", 1_100);

    expect(f.storage.swarm.markVerified("msg_cancelled", 2_000)).toBe(false);
    expect(f.row("msg_cancelled")?.verifiedAt).toBeNull();
    expect(f.row("msg_cancelled")?.state).toBe("cancelled");
  });

  it("will not fail a row that has already verified", async () => {
    // The race this closes: the watchdog selects an unverified row, awaits, and
    // a receipt verifies it in the meantime. Without the guard the terminal
    // would still land and tell the sender a turn that ran was never observed.
    const f = makeFixture();
    f.insertHandedOff({ msgId: "msg_raced", family: "receipt" });

    expect(f.storage.swarm.markVerified("msg_raced", 1_500)).toBe(true);
    expect(f.storage.swarm.markFailed("msg_raced", 2_000)).toBe(false);
    expect(f.row("msg_raced")?.state).toBe("handed_off");
  });

  it("does not run the terminal on a row that verified during the cycle", async () => {
    const f = makeFixture();
    f.insertHandedOff({ msgId: "msg_raced", family: "receipt" });
    f.storage.swarm.markVerified("msg_raced", 1_500);
    f.setNow(1_000 + GRACE + 1);

    await f.watchdog.processOnce();

    // Verified rows are not selected at all, so the sender hears nothing.
    expect(f.row("msg_raced")?.state).toBe("handed_off");
    expect(f.senderInbox()).toBe("");
  });
});
