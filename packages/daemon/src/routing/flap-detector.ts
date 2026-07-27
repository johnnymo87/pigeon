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

/** Telegram throttle. Detection still logs every tick; only delivery is capped. */
export const DEFAULT_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/** How long the event log is kept. Bounded because this is an append-only table. */
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Cap on how many sessions the alert body names, so a wide incident stays readable. */
const ALERT_SESSION_LIMIT = 5;

export interface FlapVerdict {
  /** True when at least one session exceeded the per-session move threshold. */
  flapping: boolean;
  windowMs: number;
  /** Context only — deliberately NOT part of the trigger. */
  totalMoves: number;
  /** Context only. `totalMoves / distinctSessions` ~ 1 is the restart signature. */
  distinctSessions: number;
  /** Worst offenders, descending. Empty when the log is quiet. */
  worst: SessionMoveCount[];
}

export interface FlapThresholds {
  windowMs: number;
  perSessionMoves: number;
}

/**
 * Pure evaluation over the event log. Separated from delivery so the detection
 * rule can be tested without notifiers, timers or cooldown state.
 */
export function evaluateFlapping(
  reassignments: Pick<ReassignmentEventRepo, "countSince" | "distinctSessionsSince" | "topSessionsSince">,
  now: number,
  thresholds: FlapThresholds,
): FlapVerdict {
  const since = now - thresholds.windowMs;

  const totalMoves = reassignments.countSince(since);
  const distinctSessions = reassignments.distinctSessionsSince(since);
  const worst = reassignments.topSessionsSince(since, ALERT_SESSION_LIMIT);

  // The trigger. Restart-invariant by construction: a restart yields worst == 1.
  const flapping = (worst[0]?.moves ?? 0) >= thresholds.perSessionMoves;

  return { flapping, windowMs: thresholds.windowMs, totalMoves, distinctSessions, worst };
}

export interface FlapDetectorOptions {
  reassignments: ReassignmentEventRepo;
  notifier?: FlapNotifier;
  log?: FlapLogger;
  nowFn?: () => number;
  windowMs?: number;
  perSessionMoves?: number;
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
  private readonly alertCooldownMs: number;
  private readonly retentionMs: number;
  private readonly machineId: string | undefined;

  private lastAlertAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: FlapDetectorOptions) {
    this.reassignments = opts.reassignments;
    this.notifier = opts.notifier;
    this.log = opts.log ?? ((msg, fields) => {
      console.warn(`[flap-detector] ${msg}`, fields ? JSON.stringify(fields) : "");
    });
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.perSessionMoves = opts.perSessionMoves ?? DEFAULT_PER_SESSION_MOVES;
    this.alertCooldownMs = opts.alertCooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS;
    this.retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
    this.machineId = opts.machineId;
  }

  async tick(): Promise<FlapVerdict> {
    const now = this.nowFn();
    const verdict = evaluateFlapping(this.reassignments, now, {
      windowMs: this.windowMs,
      perSessionMoves: this.perSessionMoves,
    });

    if (verdict.flapping) {
      // Logged on EVERY tick. The cooldown below throttles Telegram only — the
      // record is the thing whose absence made June invisible, so it is never
      // suppressed.
      this.log("serve reassignment flapping detected", {
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
      await this.notifier.sendPlainAlert(text, "warning");
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
        windowMs: this.windowMs,
        totalMoves: 0,
        distinctSessions: 0,
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
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
