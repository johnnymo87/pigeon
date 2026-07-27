/**
 * Flap detector — makes serve reassignment churn LOUD (bead pigeon-f2a,
 * increment 1 of the pigeon-u1u serve-serviceability arc).
 *
 * ── WHY THIS SHIPS BEFORE THE FIX IT INSTRUMENTS ──────────────────────────────
 *
 * Increment 2 (`pigeon-886`) adds a verdict that will create NEW health
 * transitions, and a flapping slot is the failure mode that makes routing bugs
 * unreproducible. The June 2026 flapping regression ran for weeks undetected —
 * 2634 cumulative moves across 407 assignments, one session moved 24 times,
 * generations up to 48 on devbox — and killed four in-flight turns before anyone
 * noticed. It was found by root-causing the dead turns, never by an alert,
 * because nothing on the reassignment path logs anything
 * (`serve-health-poller.ts:75-91`, `router.ts:296-314`) and no history table
 * existed. Observability first means increment 2 lands already instrumented.
 *
 * ── THE TRIGGER IS RESTART-INVARIANT, AND THAT IS THE WHOLE DESIGN ────────────
 *
 * The intuitive rule — "alert when there are lots of moves" — cannot ship. A
 * legitimate pool restart moves every session on a serve exactly once, so on a
 * busy box it produces dozens of moves in one second on every single deploy. An
 * alert that cries wolf on every deploy gets muted, and a muted alert is exactly
 * how June stayed invisible. Shipping that would be worse than shipping nothing.
 *
 * So the trigger is: DOES ANY ONE SESSION MOVE REPEATEDLY inside the window.
 *  - A restart moves each session once   -> worst-session count is 1 -> silent.
 *  - June's pathology moved ONE session many times -> fires, on a total far
 *    smaller than a routine deploy produces.
 *
 * Fleet-wide totals are carried in the alert body as context only. They are
 * never the trigger. Do not "simplify" this into a total-moves threshold.
 *
 * (Generation counters cannot substitute for this table: `owner_generation` is
 * monotonic but undateable, because `session_assignment.updated_at` is churned by
 * `touchActive` and `setDormantFenced` for unrelated reasons. "Moved 12 times"
 * over three months and over ten minutes are indistinguishable from the counter.)
 *
 * ── THRESHOLDS ARE PROVISIONAL ───────────────────────────────────────────────
 *
 * Nothing has ever recorded this data, so there is no base rate to calibrate
 * against. The defaults below are a reasoned guess anchored on the June numbers,
 * and the alert text says so explicitly rather than implying a tuned figure.
 * Re-tune once this has run for a week — that is the point of shipping it first.
 */
import type { ReassignmentEventRepo, SessionMoveCount } from "./reassignment-repo";

/** Matches `StopNotifier.sendPlainAlert` — a session-free operational message. */
export interface FlapNotifier {
  sendPlainAlert?(text: string, severity: "info" | "warning" | "error"): Promise<void>;
}

export type FlapLogger = (msg: string, fields?: Record<string, unknown>) => void;

/**
 * Rolling window. Long enough that a slow oscillation still lands several moves
 * inside it, short enough that a resolved incident stops alerting promptly.
 */
export const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Moves by a SINGLE session within the window before we call it flapping.
 *
 * A healthy session moves 0 times in 15 minutes; a pool restart moves it once.
 * Five is comfortably above both and far below June's 24, so it should catch a
 * recurrence early while staying silent on every benign cause we know of.
 */
export const DEFAULT_PER_SESSION_MOVES = 5;

/**
 * BREADTH arm (adversarial review MAJOR-2): this many sessions each clearing
 * `DEFAULT_BREADTH_MOVES_EACH` inside the window.
 *
 * The burst arm above is blind to the shape where a serve oscillates in and out
 * of the healthy pool and evacuates its whole population every cycle: each
 * session collects 2-4 moves, no single one reaches 5, and 150+ moves pass in
 * silence. That is not hypothetical here — both documented write-fight classes
 * (setHealth vs. the 5s heartbeat; reconciler vs. registerSelf endpoint skew)
 * produce exactly it.
 *
 * Still restart-invariant, which is the constraint that matters: a restart gives
 * every session exactly ONE move, so the per-session floor of 3 is untouched.
 * False-firing this arm requires three pool restarts inside 15 minutes, which is
 * itself worth a warning.
 *
 * Note a ratio arm (total/distinct >= 2) was considered and REJECTED: a deploy
 * plus a hotfix redeploy inside one window is ratio 2.0, which is an ordinary
 * dev afternoon.
 */
export const DEFAULT_BREADTH_SESSIONS = 10;
export const DEFAULT_BREADTH_MOVES_EACH = 3;

/**
 * SLOW-BURN arm (adversarial review MAJOR-1) and its 24h window.
 *
 * The burst threshold was originally justified as "far below June's 24" — a
 * category error, because 24 was CUMULATIVE OVER WEEKS. 2634 fleet moves across
 * ~3 weeks is roughly 1.3 moves per 15-minute window fleet-wide. A recurrence at
 * June's average intensity would therefore never trip a 15-minute arm at all.
 *
 * Mechanistically, one stale-heartbeat false positive costs a session ~2 moves
 * (out, then back). A serve doing that once every 20 minutes flaps forever —
 * on the order of 360 potential mid-turn kills a day — while sitting under every
 * short-window threshold. This arm is what sees it.
 *
 * 8 in 24h stays restart-invariant unless you deploy eight times in a day, and
 * if you do, the resulting churn is arguably worth surfacing anyway.
 */
export const DEFAULT_SLOW_BURN_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SLOW_BURN_MOVES = 8;

/**
 * How often the unconditional base-rate summary is emitted.
 *
 * Separate from alerting on purpose. Before this existed the detector logged
 * ONLY when it fired, so "no output" was indistinguishable from a severed
 * recorder, and the calibration bead's week of data had no way to reach anyone —
 * they would have had to remember to hand-query the table. That is the same
 * "data exists, nobody looks" shape that let June run for weeks.
 */
export const DEFAULT_SUMMARY_MS = 60 * 60 * 1000;

/** Telegram throttle. Detection still logs every tick; only delivery is capped. */
export const DEFAULT_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/** How long the event log is kept. Bounded because this is an append-only table. */
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Cap on how many sessions the alert body names, so a wide incident stays readable. */
const ALERT_SESSION_LIMIT = 5;

/** Which arm fired. Named so the alert can say WHAT shape was seen, not just "flapping". */
export type FlapReason = "burst" | "breadth" | "slow-burn";

export interface FlapVerdict {
  /** True when any arm fired. */
  flapping: boolean;
  /** Every arm that fired, in severity-agnostic order. Empty when quiet. */
  reasons: FlapReason[];
  windowMs: number;
  /** Context only — deliberately NOT a trigger. A restart inflates this. */
  totalMoves: number;
  /** Context only. `totalMoves / distinctSessions` ~ 1 is the restart signature. */
  distinctSessions: number;
  /** Sessions clearing the breadth floor. Drives the breadth arm. */
  breadthSessions: number;
  /** Worst offender over the 24h slow-burn window. */
  slowBurnWorstMoves: number;
  /** Worst offenders in the short window, descending. Empty when the log is quiet. */
  worst: SessionMoveCount[];
}

export interface FlapThresholds {
  windowMs: number;
  perSessionMoves: number;
  breadthSessions: number;
  breadthMovesEach: number;
  slowBurnWindowMs: number;
  slowBurnMoves: number;
}

/**
 * Pure evaluation over the event log. Separated from delivery so the detection
 * rule can be tested without notifiers, timers or cooldown state.
 */
export function evaluateFlapping(
  reassignments: Pick<
    ReassignmentEventRepo,
    "countSince" | "distinctSessionsSince" | "topSessionsSince" | "countSessionsWithAtLeastSince"
  >,
  now: number,
  thresholds: FlapThresholds,
): FlapVerdict {
  const since = now - thresholds.windowMs;

  const totalMoves = reassignments.countSince(since);
  const distinctSessions = reassignments.distinctSessionsSince(since);
  const worst = reassignments.topSessionsSince(since, ALERT_SESSION_LIMIT);
  const breadthSessions = reassignments.countSessionsWithAtLeastSince(
    since,
    thresholds.breadthMovesEach,
  );
  const slowBurnWorst = reassignments.topSessionsSince(
    now - thresholds.slowBurnWindowMs,
    1,
  );
  const slowBurnWorstMoves = slowBurnWorst[0]?.moves ?? 0;

  // Three arms, every one of them restart-invariant — a pool restart moves each
  // session EXACTLY ONCE, so none of these floors (5-in-window, 3-each, 8-in-24h)
  // can be reached by a deploy. That invariant is the design; totals are never a
  // trigger, because a totals rule fires on every deploy, gets muted, and
  // reproduces the blindness this whole bead exists to end.
  const reasons: FlapReason[] = [];
  if ((worst[0]?.moves ?? 0) >= thresholds.perSessionMoves) {
    reasons.push("burst"); // one session thrashing hard, fast
  }
  if (breadthSessions >= thresholds.breadthSessions) {
    reasons.push("breadth"); // a serve oscillating and evacuating its population
  }
  if (slowBurnWorstMoves >= thresholds.slowBurnMoves) {
    reasons.push("slow-burn"); // low intensity, sustained — June's likely profile
  }

  return {
    flapping: reasons.length > 0,
    reasons,
    windowMs: thresholds.windowMs,
    totalMoves,
    distinctSessions,
    breadthSessions,
    slowBurnWorstMoves,
    worst,
  };
}

export interface FlapDetectorOptions {
  reassignments: ReassignmentEventRepo;
  notifier?: FlapNotifier;
  log?: FlapLogger;
  nowFn?: () => number;
  windowMs?: number;
  perSessionMoves?: number;
  breadthSessions?: number;
  breadthMovesEach?: number;
  slowBurnWindowMs?: number;
  slowBurnMoves?: number;
  summaryMs?: number;
  alertCooldownMs?: number;
  retentionMs?: number;
  machineId?: string;
}

export class FlapDetector {
  private readonly reassignments: ReassignmentEventRepo;
  private readonly notifier: FlapNotifier | undefined;
  private readonly log: FlapLogger;
  private readonly nowFn: () => number;
  private readonly windowMs: number;
  private readonly perSessionMoves: number;
  private readonly breadthSessions: number;
  private readonly breadthMovesEach: number;
  private readonly slowBurnWindowMs: number;
  private readonly slowBurnMoves: number;
  private readonly summaryMs: number;
  private readonly alertCooldownMs: number;
  private readonly retentionMs: number;
  private readonly machineId: string | undefined;

  private lastAlertAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private summaryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: FlapDetectorOptions) {
    this.reassignments = opts.reassignments;
    this.notifier = opts.notifier;
    this.log = opts.log ?? ((msg, fields) => {
      console.warn(`[flap-detector] ${msg}`, fields ? JSON.stringify(fields) : "");
    });
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.perSessionMoves = opts.perSessionMoves ?? DEFAULT_PER_SESSION_MOVES;
    this.breadthSessions = opts.breadthSessions ?? DEFAULT_BREADTH_SESSIONS;
    this.breadthMovesEach = opts.breadthMovesEach ?? DEFAULT_BREADTH_MOVES_EACH;
    this.slowBurnWindowMs = opts.slowBurnWindowMs ?? DEFAULT_SLOW_BURN_WINDOW_MS;
    this.slowBurnMoves = opts.slowBurnMoves ?? DEFAULT_SLOW_BURN_MOVES;
    this.summaryMs = opts.summaryMs ?? DEFAULT_SUMMARY_MS;
    this.alertCooldownMs = opts.alertCooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS;
    this.retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
    this.machineId = opts.machineId;
  }

  async tick(): Promise<FlapVerdict> {
    const now = this.nowFn();
    const verdict = evaluateFlapping(this.reassignments, now, {
      windowMs: this.windowMs,
      perSessionMoves: this.perSessionMoves,
      breadthSessions: this.breadthSessions,
      breadthMovesEach: this.breadthMovesEach,
      slowBurnWindowMs: this.slowBurnWindowMs,
      slowBurnMoves: this.slowBurnMoves,
    });

    if (verdict.flapping) {
      // Logged on EVERY tick. The cooldown below throttles Telegram only — the
      // record is the thing whose absence made June invisible, so it is never
      // suppressed.
      this.log("serve reassignment flapping detected", {
        reasons: verdict.reasons.join(","),
        windowMs: verdict.windowMs,
        totalMoves: verdict.totalMoves,
        distinctSessions: verdict.distinctSessions,
        worst: verdict.worst.map((w) => `${w.sessionId}x${w.moves}`).join(","),
        perSessionMoves: this.perSessionMoves,
      });

      const cooling =
        this.lastAlertAt !== null && now - this.lastAlertAt < this.alertCooldownMs;
      if (!cooling) {
        this.lastAlertAt = now;
        await this.alert(verdict);
      }
    }

    this.prune(now);
    return verdict;
  }

  /**
   * Unconditional base-rate emission (adversarial review MAJOR-1).
   *
   * Deliberately NOT gated on `flapping`. Before this existed the detector spoke
   * only when it fired, which made a quiet pool and a severed recorder produce
   * byte-identical output — and left the calibration bead with no delivery
   * mechanism at all. "Zero moves in the last hour" is a positive statement;
   * no log line is not.
   *
   * This is the feed for pigeon-u1u.3. Diff successive lines to get the rate.
   */
  reportNow(): void {
    const now = this.nowFn();
    const v = evaluateFlapping(this.reassignments, now, {
      windowMs: this.windowMs,
      perSessionMoves: this.perSessionMoves,
      breadthSessions: this.breadthSessions,
      breadthMovesEach: this.breadthMovesEach,
      slowBurnWindowMs: this.slowBurnWindowMs,
      slowBurnMoves: this.slowBurnMoves,
    });

    this.log("reassignment base-rate summary (calibration feed for pigeon-u1u.3)", {
      windowMs: v.windowMs,
      movesInWindow: v.totalMoves,
      distinctSessionsInWindow: v.distinctSessions,
      // ~1.0 is the pool-restart signature; sustained >1 is the breadth pathology.
      movesPerSession:
        v.distinctSessions > 0
          ? Number((v.totalMoves / v.distinctSessions).toFixed(2))
          : 0,
      sessionsAtBreadthFloor: v.breadthSessions,
      worstSessionInWindow: v.worst[0]?.moves ?? 0,
      worstSessionIn24h: v.slowBurnWorstMoves,
      flappingNow: v.flapping,
      reasons: v.reasons.join(",") || "none",
      thresholds:
        `burst=${this.perSessionMoves}/${Math.round(this.windowMs / 60_000)}m ` +
        `breadth=${this.breadthSessions}x${this.breadthMovesEach} ` +
        `slowBurn=${this.slowBurnMoves}/24h (ALL PROVISIONAL)`,
    });
  }

  private prune(now: number): void {
    try {
      this.reassignments.pruneBefore(now - this.retentionMs);
    } catch (err) {
      // Retention is the least important thing this class does; never let it
      // mask a detection or break the tick.
      this.log("prune failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async alert(v: FlapVerdict): Promise<void> {
    if (!this.notifier?.sendPlainAlert) {
      return;
    }
    const where = this.machineId ? ` on ${this.machineId}` : "";
    const minutes = Math.round(v.windowMs / 60_000);
    const detail = v.worst
      .filter((w) => w.moves > 1)
      .map((w) => `${w.sessionId} moved ${w.moves}x`)
      .join("; ");

    const text =
      `serve reassignment flapping${where}: at least one session is bouncing ` +
      `between serves (${detail}) in the last ${minutes}m. ` +
      `Fleet context: ${v.totalMoves} moves across ${v.distinctSessions} sessions ` +
      `— a pool restart looks like ~1 move per session and does NOT trigger this. ` +
      `Repeated moves of the SAME session are what killed four in-flight turns in ` +
      `June ("session lease lost mid-run"). Check for a serve whose heartbeat is ` +
      `stale while it is alive, or endpoint/config skew. ` +
      `NOTE: this threshold (${this.perSessionMoves} moves/session/${minutes}m) is ` +
      `PROVISIONAL — no base rate existed when it was set, so tune it once there ` +
      `is a week of data.`;

    try {
      await this.notifier.sendPlainAlert(text, "error");
    } catch (err) {
      this.log("flap alert send failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * `tick()` that is guaranteed never to reject.
   *
   * Same reasoning as `ServeEndpointReconciler.safeTick`: this runs on a
   * fire-and-forget timer inside the live daemon, better-sqlite3 is synchronous,
   * and a transient SQLITE_BUSY on this shared DB would otherwise surface as an
   * unhandled rejection — which terminates the Node process by default. A locked
   * database must degrade to "try again next tick", never to "kill routing".
   */
  async safeTick(): Promise<FlapVerdict> {
    try {
      return await this.tick();
    } catch (err) {
      this.log("tick failed", { error: err instanceof Error ? err.message : String(err) });
      return {
        flapping: false,
        reasons: [],
        windowMs: this.windowMs,
        totalMoves: 0,
        distinctSessions: 0,
        breadthSessions: 0,
        slowBurnWorstMoves: 0,
        worst: [],
      };
    }
  }

  start(intervalMs: number): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.safeTick();
    }, intervalMs);
    this.timer.unref?.();

    // Separate, much slower cadence. Detection needs to be prompt; the base-rate
    // feed needs to be regular and must not bury the alerts.
    this.summaryTimer = setInterval(() => {
      try {
        this.reportNow();
      } catch (err) {
        this.log("summary failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, this.summaryMs);
    this.summaryTimer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.summaryTimer !== null) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = null;
    }
  }
}
