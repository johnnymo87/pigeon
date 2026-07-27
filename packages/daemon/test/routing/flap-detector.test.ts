/**
 * Flap detection over the reassignment log (bead pigeon-f2a).
 *
 * THE DESIGN PROBLEM THIS FILE PINS DOWN
 *
 * The obvious detector — "alert when there are many moves" — is unshippable,
 * because a legitimate pool restart moves EVERY session on a serve exactly once.
 * On a box with 76 sessions that is 76 moves in one second, on every deploy. An
 * alert that fires on every deploy is an alert that gets muted, and a muted alert
 * is why the June regression ran for weeks unnoticed. Shipping that would
 * actively make things worse than shipping nothing.
 *
 * So the trigger is deliberately RESTART-INVARIANT: it fires on a single session
 * moving repeatedly, which is what actually happened in June (one session moved
 * 24 times; devbox measured generations up to 48) and which a restart cannot
 * produce, because a restart moves each session once by construction.
 *
 * Fleet-wide totals are still reported in the alert body as context, but they are
 * never the trigger. That asymmetry is the whole design and the tests below exist
 * to stop someone "simplifying" it back into a total-moves threshold.
 *
 * Thresholds themselves are provisional — nothing has ever recorded this data, so
 * there is no base rate to calibrate against. That is expected at increment 1
 * (the point is to START recording), and the alert text says so out loud rather
 * than implying a tuned number.
 */
import { describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { initRouteSchema } from "../../src/routing/route-schema";
import {
  initReassignmentSchema,
  ReassignmentEventRepo,
} from "../../src/routing/reassignment-repo";
import { evaluateFlapping, FlapDetector } from "../../src/routing/flap-detector";

const T0 = 1_700_000_000_000;
const WINDOW = 15 * 60 * 1000;

function repo(): ReassignmentEventRepo {
  const db = new BetterSqlite3(":memory:");
  initRouteSchema(db);
  initReassignmentSchema(db);
  return new ReassignmentEventRepo(db);
}

function move(r: ReassignmentEventRepo, sessionId: string, at: number, gen = 2) {
  r.record({ sessionId, fromServeId: "serve-0", toServeId: "serve-1", ownerGeneration: gen, at });
}

describe("evaluateFlapping", () => {
  it("is quiet on an empty log", () => {
    const v = evaluateFlapping(repo(), T0, { windowMs: WINDOW, perSessionMoves: 5 });
    expect(v.flapping).toBe(false);
    expect(v.totalMoves).toBe(0);
  });

  it("does NOT fire on a pool restart, however many sessions it moves", () => {
    // The single most important test here. 80 moves, one per session, is a deploy.
    const r = repo();
    for (let i = 0; i < 80; i++) {
      move(r, `ses_${i}`, T0 - 1_000);
    }
    const v = evaluateFlapping(r, T0, { windowMs: WINDOW, perSessionMoves: 5 });

    expect(v.totalMoves).toBe(80);
    expect(v.distinctSessions).toBe(80);
    expect(v.flapping).toBe(false);
  });

  it("fires when one session moves repeatedly, even though the total is tiny", () => {
    // 5 moves total — 16x fewer than the benign restart above — but pathological.
    const r = repo();
    for (let i = 0; i < 5; i++) {
      move(r, "ses_stuck", T0 - 1_000 + i, i + 2);
    }
    const v = evaluateFlapping(r, T0, { windowMs: WINDOW, perSessionMoves: 5 });

    expect(v.flapping).toBe(true);
    expect(v.worst[0]).toEqual({ sessionId: "ses_stuck", moves: 5 });
  });

  it("does not fire one move below the threshold", () => {
    const r = repo();
    for (let i = 0; i < 4; i++) {
      move(r, "ses_stuck", T0 - 1_000 + i, i + 2);
    }
    expect(evaluateFlapping(r, T0, { windowMs: WINDOW, perSessionMoves: 5 }).flapping).toBe(false);
  });

  it("ignores moves that fall outside the window, so history cannot pin it on", () => {
    // Without this the alert latches forever: the log only grows.
    const r = repo();
    for (let i = 0; i < 20; i++) {
      move(r, "ses_ancient", T0 - WINDOW - 60_000 + i, i + 2);
    }
    const v = evaluateFlapping(r, T0, { windowMs: WINDOW, perSessionMoves: 5 });
    expect(v.totalMoves).toBe(0);
    expect(v.flapping).toBe(false);
  });
});

describe("FlapDetector", () => {
  function detector(r: ReassignmentEventRepo, over: Record<string, unknown> = {}) {
    const sendPlainAlert = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const d = new FlapDetector({
      reassignments: r,
      notifier: { sendPlainAlert },
      log,
      nowFn: () => T0,
      windowMs: WINDOW,
      perSessionMoves: 5,
      machineId: "testbox",
      ...over,
    });
    return { d, sendPlainAlert, log };
  }

  function thrash(r: ReassignmentEventRepo, n = 6, id = "ses_stuck") {
    for (let i = 0; i < n; i++) move(r, id, T0 - 1_000 + i, i + 2);
  }

  it("alerts, naming the offending session and its move count", async () => {
    const r = repo();
    thrash(r);
    const { d, sendPlainAlert } = detector(r);

    await d.tick();

    expect(sendPlainAlert).toHaveBeenCalledTimes(1);
    const [text, severity] = sendPlainAlert.mock.calls[0]!;
    expect(text).toContain("ses_stuck");
    expect(text).toContain("6");
    expect(severity).toBe("warning");
  });

  it("says out loud that the thresholds are provisional", () => {
    // Increment 1 has no base rate to calibrate against. An operator reading this
    // at 3am must not be misled into treating the number as tuned.
    const r = repo();
    thrash(r);
    const { d, sendPlainAlert } = detector(r);

    return d.tick().then(() => {
      expect(sendPlainAlert.mock.calls[0]![0]).toMatch(/provisional|untuned|not calibrated/i);
    });
  });

  it("stays silent on a pool restart", async () => {
    const r = repo();
    for (let i = 0; i < 80; i++) move(r, `ses_${i}`, T0 - 1_000);
    const { d, sendPlainAlert } = detector(r);

    await d.tick();
    expect(sendPlainAlert).not.toHaveBeenCalled();
  });

  it("suppresses a repeat alert inside the cooldown", async () => {
    // A genuinely flapping slot re-detects on every single tick. Without a
    // cooldown that is an alert per tick until someone mutes the channel.
    const r = repo();
    thrash(r);
    const { d, sendPlainAlert } = detector(r, { alertCooldownMs: 10 * 60 * 1000 });

    await d.tick();
    await d.tick();
    await d.tick();

    expect(sendPlainAlert).toHaveBeenCalledTimes(1);
  });

  it("alerts again once the cooldown has elapsed", async () => {
    const r = repo();
    thrash(r);
    let now = T0;
    const sendPlainAlert = vi.fn().mockResolvedValue(undefined);
    const d = new FlapDetector({
      reassignments: r,
      notifier: { sendPlainAlert },
      log: vi.fn(),
      nowFn: () => now,
      windowMs: WINDOW,
      perSessionMoves: 5,
      alertCooldownMs: 10 * 60 * 1000,
    });

    await d.tick();
    now = T0 + 11 * 60 * 1000;
    await d.tick();

    expect(sendPlainAlert).toHaveBeenCalledTimes(2);
  });

  it("logs the detection even while the alert is cooling down", async () => {
    // The cooldown throttles Telegram, never the record. The June incident was
    // invisible precisely because nothing on this path logged anything.
    const r = repo();
    thrash(r);
    const { d, log } = detector(r, { alertCooldownMs: 10 * 60 * 1000 });

    await d.tick();
    await d.tick();

    expect(log.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("never rejects, even if the notifier throws", async () => {
    const r = repo();
    thrash(r);
    const { d } = detector(r, {
      notifier: { sendPlainAlert: vi.fn().mockRejectedValue(new Error("telegram down")) },
    });

    await expect(d.tick()).resolves.toBeDefined();
  });

  it("safeTick swallows a wedged database rather than killing the daemon", async () => {
    // Runs inside the live daemon on a fire-and-forget timer. An unhandled
    // rejection terminates the process by default in Node.
    const exploding = {
      countSince() {
        throw new Error("database is locked");
      },
    } as unknown as ReassignmentEventRepo;
    const { d } = detector(exploding);

    await expect(d.safeTick()).resolves.toBeDefined();
  });

  it("works with no notifier configured at all", async () => {
    // On a host without TELEGRAM_BOT_TOKEN the notifier has no sendPlainAlert.
    const r = repo();
    thrash(r);
    const { d } = detector(r, { notifier: undefined });

    await expect(d.tick()).resolves.toBeDefined();
  });

  it("prunes events older than the retention horizon", async () => {
    const r = repo();
    move(r, "ses_ancient", T0 - 48 * 60 * 60 * 1000);
    move(r, "ses_recent", T0 - 1_000);
    const { d } = detector(r, { retentionMs: 24 * 60 * 60 * 1000 });

    await d.tick();

    expect(r.countSince(0)).toBe(1);
  });
});
