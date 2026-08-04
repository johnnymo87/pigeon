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
import {
  evaluateFlapping,
  FlapDetector,
  type FlapThresholds,
} from "../../src/routing/flap-detector";

const T0 = 1_700_000_000_000;
const WINDOW = 15 * 60 * 1000;

function repo(): ReassignmentEventRepo {
  const db = new BetterSqlite3(":memory:");
  initRouteSchema(db);
  initReassignmentSchema(db);
  return new ReassignmentEventRepo(db);
}

const DAY = 24 * 60 * 60 * 1000;

/** Full threshold set; override only what a test is actually about. */
const TH = (over: Partial<FlapThresholds> = {}): FlapThresholds => ({
  windowMs: WINDOW,
  perSessionMoves: 5,
  breadthSessions: 10,
  breadthMovesEach: 3,
  slowBurnWindowMs: DAY,
  slowBurnMoves: 8,
  ...over,
});

function move(r: ReassignmentEventRepo, sessionId: string, at: number, gen = 2) {
  r.record({ sessionId, fromServeId: "serve-0", toServeId: "serve-1", ownerGeneration: gen, at });
}

describe("evaluateFlapping", () => {
  it("is quiet on an empty log", () => {
    const v = evaluateFlapping(repo(), T0, TH());
    expect(v.flapping).toBe(false);
    expect(v.totalMoves).toBe(0);
  });

  it("does NOT fire on a pool restart, however many sessions it moves", () => {
    // The single most important test here. 80 moves, one per session, is a deploy.
    const r = repo();
    for (let i = 0; i < 80; i++) {
      move(r, `ses_${i}`, T0 - 1_000);
    }
    const v = evaluateFlapping(r, T0, TH());

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
    const v = evaluateFlapping(r, T0, TH());

    expect(v.flapping).toBe(true);
    expect(v.worst[0]).toEqual({ sessionId: "ses_stuck", moves: 5, lastMoveAt: T0 - 1_000 + 4 });
  });

  it("does not fire one move below the threshold", () => {
    const r = repo();
    for (let i = 0; i < 4; i++) {
      move(r, "ses_stuck", T0 - 1_000 + i, i + 2);
    }
    expect(evaluateFlapping(r, T0, TH()).flapping).toBe(false);
  });

  it("excludes moves outside the short window from the burst arm", () => {
    // Without a window the burst alert latches forever: the log only grows.
    const r = repo();
    for (let i = 0; i < 20; i++) {
      move(r, "ses_ancient", T0 - WINDOW - 60_000 + i, i + 2);
    }
    const v = evaluateFlapping(r, T0, TH());

    expect(v.totalMoves).toBe(0);
    expect(v.reasons).not.toContain("burst");
  });

  it("but DOES fire slow-burn on those same moves, which the burst arm alone missed", () => {
    // This case is the adversarial review's MAJOR-1 made concrete. Twenty moves by
    // one session, spread beyond a 15-minute window, was previously reported as
    // "not flapping" — yet it is exactly the low-intensity, sustained profile that
    // June's numbers actually imply (2634 fleet moves over ~3 weeks is ~1.3 moves
    // per 15-min window fleet-wide, which no short-window threshold can see).
    const r = repo();
    for (let i = 0; i < 20; i++) {
      move(r, "ses_ancient", T0 - WINDOW - 60_000 + i, i + 2);
    }
    const v = evaluateFlapping(r, T0, TH());

    expect(v.flapping).toBe(true);
    expect(v.reasons).toEqual(["slow-burn"]);
    expect(v.slowBurnWorstMoves).toBe(20);
  });

  it("keeps the slow-burn arm restart-invariant", () => {
    // 200 sessions moved once each, a day's worth of deploys: still silent.
    const r = repo();
    for (let d = 0; d < 5; d++) {
      for (let i = 0; i < 200; i++) move(r, `ses_${i}`, T0 - d * 60 * 60 * 1000);
    }
    const v = evaluateFlapping(r, T0, TH());

    expect(v.totalMoves).toBeGreaterThan(0);
    expect(v.flapping).toBe(false);
  });
});

describe("evaluateFlapping breadth arm", () => {
  it("fires when many sessions each move a few times, which the burst arm misses", () => {
    // MAJOR-2. A serve oscillating in and out of the healthy pool evacuates its
    // whole population every cycle: each session picks up 3 moves, NOT ONE of them
    // reaches the burst floor of 5, and 36 moves pass in total silence. Both
    // documented write-fight classes in this repo produce this exact shape.
    const r = repo();
    for (let s = 0; s < 12; s++) {
      for (let i = 0; i < 3; i++) move(r, `ses_${s}`, T0 - 1_000 + i, i + 2);
    }
    const v = evaluateFlapping(r, T0, TH());

    expect(v.worst[0]!.moves).toBeLessThan(5); // burst arm is blind here
    expect(v.reasons).toContain("breadth");
    expect(v.breadthSessions).toBe(12);
  });

  it("stays silent for a pool restart of any size", () => {
    // The constraint that makes the arm shippable: a restart moves each session
    // exactly once, so a floor of 3 is untouched no matter how large the fleet.
    const r = repo();
    for (let i = 0; i < 500; i++) move(r, `ses_${i}`, T0 - 1_000);
    const v = evaluateFlapping(r, T0, TH());

    expect(v.totalMoves).toBe(500);
    expect(v.breadthSessions).toBe(0);
    expect(v.flapping).toBe(false);
  });

  it("stays silent for a deploy plus a hotfix redeploy in one window", () => {
    // Why a ratio arm (total/distinct >= 2) was rejected: this is ratio 2.0 and an
    // ordinary dev afternoon. The breadth arm's per-session floor of 3 ignores it.
    const r = repo();
    for (let i = 0; i < 60; i++) {
      move(r, `ses_${i}`, T0 - 8_000);
      move(r, `ses_${i}`, T0 - 2_000, 3);
    }
    const v = evaluateFlapping(r, T0, TH());

    expect(v.totalMoves / v.distinctSessions).toBe(2);
    expect(v.flapping).toBe(false);
  });

  it("does not fire one session below the breadth count", () => {
    const r = repo();
    for (let s = 0; s < 9; s++) {
      for (let i = 0; i < 3; i++) move(r, `ses_${s}`, T0 - 1_000 + i, i + 2);
    }
    expect(evaluateFlapping(r, T0, TH()).reasons).not.toContain("breadth");
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
    // "error", not "warning": this condition killed four in-flight turns in June.
    // A warning undersells a signal whose observed consequence was data loss.
    expect(severity).toBe("error");
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

  it("emits a base-rate summary even when nothing is flapping", async () => {
    // MAJOR-1. Before this, tick() logged ONLY on detection, so a quiet detector
    // was indistinguishable from a severed recorder — and the calibration bead's
    // "week of data" had no way to reach anyone: someone had to remember to
    // hand-query the table. That is the same "data exists, nobody looks" shape
    // that let June run for weeks, and the spine's own rule is that absence of a
    // signal proves nothing.
    const r = repo();
    for (let i = 0; i < 3; i++) move(r, `ses_${i}`, T0 - 1_000);
    const { d, log } = detector(r);

    d.reportNow();

    expect(log).toHaveBeenCalled();
    const [msg, fields] = log.mock.calls[0]!;
    expect(msg).toMatch(/summary|base.?rate/i);
    expect(JSON.stringify(fields)).toContain("3");
  });

  it("reports even when the log is completely empty, so silence is verified", async () => {
    // "Zero moves in the last hour" is a positive statement. "No log line" is not.
    const { d, log } = detector(repo());
    d.reportNow();
    expect(log).toHaveBeenCalled();
  });

  it("labels the thresholds provisional in the summary too", () => {
    const { d, log } = detector(repo());
    d.reportNow();
    expect(JSON.stringify(log.mock.calls[0]!)).toMatch(/provisional/i);
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
