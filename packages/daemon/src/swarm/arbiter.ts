import type { StorageDb } from "../storage/database";
import type { SwarmMessageRecord } from "../storage/swarm-repo";
import type { OpencodeClient } from "../opencode-client";
import type { StopNotifier, AlertSeverity } from "../notification-service";
import { renderEnvelope, PermanentDeliveryError } from "./envelope";
import { DELIVERY_FAILED_KIND, notifySenderOfFailure } from "./notify-sender";
import {
  isOutageFailure,
  TargetUnavailableError,
  isSuppressedFromRecovery,
  formatWakePayloadAlert,
} from "./delivery-policy";

export { DELIVERY_FAILED_KIND };

export type ArbiterNotifier = Pick<StopNotifier, "sendPlainAlert">;

export interface ArbiterOptions {
  storage: StorageDb;
  clientForSession: (sessionId: string) => OpencodeClient | undefined;   // replaces opencodeClient
  directoryForSession: (sessionId: string) => Promise<string | undefined>; // replaces registry
  notifier?: ArbiterNotifier;
  nowFn?: () => number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

const MAX_ATTEMPTS = 10;
const BACKOFF_SCHEDULE = [1_000, 2_000, 5_000, 15_000, 60_000];

/**
 * Fixed retry delay for failures that never reached the serve (see
 * {@link isOutageFailure}). Deliberately flat rather than escalating: during an
 * outage the cost of a retry is one refused TCP connect, and the row's
 * `expires_at` already bounds the total. Escalating here would buy nothing and
 * would need a second counter column to avoid corrupting the attempt budget.
 */
const OUTAGE_RETRY_DELAY_MS = 30_000;

function backoffFor(attempts: number): number {
  return (
    BACKOFF_SCHEDULE[Math.min(attempts, BACKOFF_SCHEDULE.length - 1)] ?? 60_000
  );
}

export class SwarmArbiter {
  private readonly storage: StorageDb;
  private readonly clientForSession: (sessionId: string) => OpencodeClient | undefined;
  private readonly directoryForSession: (sessionId: string) => Promise<string | undefined>;
  private readonly notifier?: ArbiterNotifier;
  private readonly nowFn: () => number;
  private readonly log: (
    msg: string,
    fields?: Record<string, unknown>,
  ) => void;

  // One in-flight promise per target session — collapses concurrent processOnce
  // calls into a single per-target queue.
  private readonly inflight = new Map<string, Promise<void>>();

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ArbiterOptions) {
    this.storage = opts.storage;
    this.clientForSession = opts.clientForSession;
    this.directoryForSession = opts.directoryForSession;
    this.notifier = opts.notifier;
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.log =
      opts.log ?? ((m, f) => console.log(`[swarm-arbiter] ${m}`, f ?? ""));
  }

  private async alert(severity: AlertSeverity, text: string): Promise<void> {
    if (!this.notifier?.sendPlainAlert) return;
    try {
      await this.notifier.sendPlainAlert(text, severity);
    } catch (err) {
      this.log("alert send failed", { error: String(err) });
    }
  }

  start(intervalMs = 500): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.processOnce();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async processOnce(): Promise<void> {
    const now = this.nowFn();
    await this.sweepExpired(now);
    const targets = this.storage.swarm.listTargetsWithReady(now);
    await Promise.all(targets.map((t) => this.drainTarget(t)));
  }

  /**
   * Transitions one expired row out of `queued` and tells the sender.
   *
   * The notification is NOT optional. This whole feature exists because a
   * message was dropped silently; expiring a wake without saying so would just
   * move the silent drop from delivery time to expiry time.
   *
   * Returns whether this call was the one that expired the row — `markExpired`
   * is guarded on `state = 'queued'`, so a row already taken by cancel or by a
   * concurrent sweep produces no second notification.
   */
  private async expireAndNotify(row: SwarmMessageRecord, now: number): Promise<boolean> {
    if (!this.storage.swarm.markExpired(row.msgId, now)) return false;
    this.log("expired", { msgId: row.msgId, target: row.toSession ?? row.channel });
    const scheduledIso = new Date(row.deliverAt ?? row.createdAt).toISOString();
    const reason =
      `expired before delivery (scheduled for ${scheduledIso}, ` +
      `expired at ${new Date(now).toISOString()})`;
    notifySenderOfFailure(this.storage, row, reason, now);
    if (isSuppressedFromRecovery(row)) {
      await this.alert(
        "error",
        formatWakePayloadAlert(row, reason, "expired before delivery"),
      );
    }
    return true;
  }

  /**
   * Marks rows whose `expires_at` has passed.
   *
   * This sweep is load-bearing, not housekeeping: `getReadyForTarget` and
   * `listTargetsWithReady` both filter expired rows out, so nothing else would
   * ever observe them and they would sit in `queued` forever.
   *
   * That filtering is itself deliberate — the ready queue orders by
   * `created_at ASC`, so an expired 13h-old wake would otherwise sort first and
   * wedge every later message to the same target behind a row that can never
   * deliver.
   */
  private async sweepExpired(now: number): Promise<void> {
    for (const row of this.storage.swarm.listExpired(now)) {
      await this.expireAndNotify(row, now);
    }
  }

  private async drainTarget(target: string): Promise<void> {
    const existing = this.inflight.get(target);
    if (existing) {
      await existing;
      return;
    }
    const work = this.drainTargetInner(target).finally(() =>
      this.inflight.delete(target),
    );
    this.inflight.set(target, work);
    return work;
  }

  private async drainTargetInner(target: string): Promise<void> {
    while (true) {
      const now = this.nowFn();
      const next = this.storage.swarm.getReadyForTarget(target, now, 1)[0];
      if (!next) return;

      // Belt and braces. `getReadyForTarget` already excludes expired rows, so
      // this only fires when `expires_at` passes between that SELECT and here —
      // narrow, but reachable, because draining a target is a loop with an
      // await in it. Cheap to check and the alternative is delivering a wake
      // the caller already declared worthless.
      if (next.expiresAt !== null && next.expiresAt <= now) {
        await this.expireAndNotify(next, now);
        continue;
      }

      try {
        const client = this.clientForSession(target);
        if (!client) {
          throw new TargetUnavailableError(`target ${target} not routable: no healthy serve available`);
        }
        const directory = await this.directoryForSession(target);
        if (!directory) {
          throw new TargetUnavailableError(`target ${target} not resolvable: directory lookup returned empty`);
        }
        const prompt = renderEnvelope(
          {
            v: "1",
            kind: next.kind,
            from: next.fromSession,
            to: next.toSession,
            channel: next.channel,
            msgId: next.msgId,
            replyTo: next.replyTo,
            priority: next.priority,
            scheduledFor: next.deliverAt,
            deliveredLateMs:
              next.deliverAt !== null
                ? Math.max(0, now - next.deliverAt)
                : null,
          },
          next.payload,
        );
        await client.sendPrompt(target, directory, prompt);
        const handedOff = this.storage.swarm.markHandedOff(next.msgId, this.nowFn());
        if (!handedOff) {
          const current = this.storage.swarm.getByMsgId(next.msgId);
          this.log("delivered mid-flight race (cancel lost to delivery)", {
            msgId: next.msgId,
            target,
            currentState: current?.state,
          });
          if (current?.state === "cancelled") {
            this.storage.swarm.markHandedOffAfterCancel(next.msgId, this.nowFn());
          }
        } else {
          this.log("delivered", { msgId: next.msgId, target });
        }
      } catch (err) {
        // Permanent errors can never succeed on retry (e.g. the payload
        // contains the literal close tag). Fail fast instead of burning
        // MAX_ATTEMPTS retries over ~6 minutes.
        if (err instanceof PermanentDeliveryError) {
          this.storage.swarm.markFailed(next.msgId, this.nowFn());
          this.log("failed (permanent)", {
            msgId: next.msgId,
            error: String(err),
          });
          notifySenderOfFailure(this.storage, next, String(err), this.nowFn());
          if (isSuppressedFromRecovery(next)) {
            await this.alert(
              "error",
              formatWakePayloadAlert(
                next,
                `permanent delivery error (${String(err)})`,
              ),
            );
          }
          return; // stop draining this target until next tick
        }

        // An outage failure only escapes the attempt budget when the row has
        // ANOTHER terminal clock. `expires_at` is exactly that, and the
        // predicate is deliberately the presence of that clock rather than
        // anything about what the message is FOR:
        //
        //   scheduled row -> has expires_at (guaranteed: parseScheduleTime
        //     defaults it to deliver_at + 6h), so uncounted retries still end
        //     at expiry. Bounded.
        //   ordinary /swarm/send row -> no expires_at, so MAX_ATTEMPTS is the
        //     ONLY bound. Exempting it would retry a message to a permanently
        //     dead session forever.
        //
        // So it fails CLOSED: no terminal clock, budget applies.
        //
        // Do NOT rewrite this as `isWakeKind(next.kind)` — POST /swarm/schedule
        // only DEFAULTS kind to "wake" and otherwise takes the caller's string
        // verbatim, so that guard is dodgeable (this is the W3 review finding,
        // reapplied). Do NOT use `deliverAt !== null` either: deliver_at is a
        // START clock and says nothing about whether the row is bounded.
        const skipBudget = isOutageFailure(err) && next.expiresAt !== null;

        if (skipBudget) {
          this.storage.swarm.markRetryUncounted(
            next.msgId,
            this.nowFn(),
            OUTAGE_RETRY_DELAY_MS,
          );
          this.log("retry scheduled (uncounted)", {
            msgId: next.msgId,
            error: String(err),
          });
        } else {
          const after = this.storage.swarm.getByMsgId(next.msgId);
          const attempts = (after?.attempts ?? 0) + 1;
          if (attempts >= MAX_ATTEMPTS) {
            this.storage.swarm.markFailed(next.msgId, this.nowFn());
            this.log("failed (max attempts)", {
              msgId: next.msgId,
              error: String(err),
            });
            notifySenderOfFailure(this.storage, next, String(err), this.nowFn());
            if (isSuppressedFromRecovery(next)) {
              await this.alert(
                "error",
                formatWakePayloadAlert(
                  next,
                  `max attempts exhausted (${String(err)})`,
                ),
              );
            }
          } else {
            this.storage.swarm.markRetry(
              next.msgId,
              this.nowFn(),
              backoffFor(attempts),
            );
            this.log("retry scheduled", {
              msgId: next.msgId,
              attempts,
              error: String(err),
            });
          }
        }
        return; // stop draining this target until next tick
      }
    }
  }
}
