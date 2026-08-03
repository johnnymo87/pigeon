import type { StorageDb } from "../storage/database";
import type { StopNotifier } from "../notification-service";

export type ArbiterNotifier = Pick<StopNotifier, "sendPlainAlert">;
export type AlertDrainerNotifier = ArbiterNotifier;

export type AlertDrainerLogger = (
  msg: string,
  fields?: Record<string, unknown>,
) => void;

export interface AlertDrainerOptions {
  storage: StorageDb;
  notifier: AlertDrainerNotifier;
  nowFn?: () => number;
  log?: AlertDrainerLogger;
}

export const BACKLOG_SUMMARY_THRESHOLD = 5;
export const DEFAULT_DRAIN_INTERVAL_MS = 5000;

export const BACKOFF_SCHEDULE_MS = [
  5_000, // attempt 0 (1st retry delay: 5s)
  30_000, // attempt 1 (2nd retry delay: 30s)
  120_000, // attempt 2 (3rd retry delay: 2m)
  600_000, // attempt 3 (4th retry delay: 10m)
  1_800_000, // attempt 4 (5th retry delay: 30m)
  3_600_000, // attempt 5+ (capped at 1h)
];

export function alertBackoffMs(attempts: number): number {
  if (attempts < 0) return BACKOFF_SCHEDULE_MS[0] ?? 5_000;
  const idx = Math.min(Math.floor(attempts), BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[idx] ?? 3_600_000;
}

export class AlertDrainer {
  private readonly storage: StorageDb;
  private readonly notifier: AlertDrainerNotifier;
  private readonly nowFn: () => number;
  private readonly log?: AlertDrainerLogger;

  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private hasLoggedBacklog = false;
  /**
   * Alerts whose Telegram send SUCCEEDED but whose `markSent` then failed.
   *
   * Deliberately the one piece of in-memory state here, and deliberately NOT a
   * DB column: recording "sent" is precisely the write that just failed, so
   * durably remembering it needs the thing that is broken. A restart therefore
   * loses this set and the alert is sent twice.
   *
   * That is the correct trade. These alerts are the only signal a human gets
   * that a wake died (for a self-wake the in-band notification goes to the
   * session that just proved unreachable), so at-least-once beats at-most-once.
   * A duplicate is noise; a miss is the silent drop this whole change exists to
   * close.
   *
   * Bounded: entries are added only when `markSent` throws and removed as soon
   * as one succeeds, so it stays empty unless the DB is already failing.
   */
  private readonly sentIds = new Set<string>();

  constructor(opts: AlertDrainerOptions) {
    this.storage = opts.storage;
    this.notifier = opts.notifier;
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.log = opts.log;
  }

  start(intervalMs = DEFAULT_DRAIN_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.drainOnce().catch((err) => {
        this.log?.("drainOnce unhandled error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer && typeof (this.timer as { unref?: unknown }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async drainOnce(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const now = this.nowFn();
      const count = this.storage.alerts.countDrainable(now);

      if (count >= BACKLOG_SUMMARY_THRESHOLD) {
        if (!this.hasLoggedBacklog) {
          this.hasLoggedBacklog = true;
          this.log?.("backlog summary: backlog threshold reached", { count });
        }
      } else {
        this.hasLoggedBacklog = false;
      }

      if (!this.notifier.sendPlainAlert) return;

      const row = this.storage.alerts.nextDrainable(now);
      if (!row) return;

      if (!this.sentIds.has(row.id)) {
        try {
          await this.notifier.sendPlainAlert(row.text, row.severity);
          this.sentIds.add(row.id);
        } catch (err) {
          try {
            const delay = alertBackoffMs(row.attempts);
            this.storage.alerts.markRetry(row.id, now + delay);
          } catch (retryErr) {
            this.log?.("alert markRetry failed", {
              id: row.id,
              error: retryErr instanceof Error ? retryErr.message : String(retryErr),
            });
          }
          this.log?.("alert send failed", {
            id: row.id,
            attempts: row.attempts + 1,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }

      try {
        const marked = this.storage.alerts.markSent(row.id, now);
        if (marked) {
          this.sentIds.delete(row.id);
        } else {
          this.sentIds.delete(row.id);
          this.log?.("alert sent but markSent returned false (state changed mid-send)", {
            id: row.id,
          });
        }
      } catch (err) {
        this.log?.("alert sent but not recorded", {
          id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (passErr) {
      this.log?.("alert drain pass failed", {
        error: passErr instanceof Error ? passErr.message : String(passErr),
      });
    } finally {
      this.processing = false;
    }
  }
}
