import type { StorageDb } from "../storage/database";
import type { SwarmMessageRecord } from "../storage/swarm-repo";
import type { OpencodeClient } from "../opencode-client";
import { renderEnvelope, PermanentDeliveryError } from "./envelope";
import { makeMsgId } from "../ids";

/** Kind used for system notifications sent back to a sender whose message
 *  could not be delivered. Also used as the loop guard: a delivery.failed
 *  message that itself fails must NOT spawn another notification. */
export const DELIVERY_FAILED_KIND = "delivery.failed";

export interface ArbiterOptions {
  storage: StorageDb;
  clientForSession: (sessionId: string) => OpencodeClient | undefined;   // replaces opencodeClient
  directoryForSession: (sessionId: string) => Promise<string | undefined>; // replaces registry
  nowFn?: () => number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

const MAX_ATTEMPTS = 10;
const BACKOFF_SCHEDULE = [1_000, 2_000, 5_000, 15_000, 60_000];

function backoffFor(attempts: number): number {
  return (
    BACKOFF_SCHEDULE[Math.min(attempts, BACKOFF_SCHEDULE.length - 1)] ?? 60_000
  );
}

export class SwarmArbiter {
  private readonly storage: StorageDb;
  private readonly clientForSession: (sessionId: string) => OpencodeClient | undefined;
  private readonly directoryForSession: (sessionId: string) => Promise<string | undefined>;
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
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.log =
      opts.log ?? ((m, f) => console.log(`[swarm-arbiter] ${m}`, f ?? ""));
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
    const targets = this.storage.swarm.listTargetsWithReady(now);
    await Promise.all(targets.map((t) => this.drainTarget(t)));
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

      try {
        const client = this.clientForSession(target);
        if (!client) {
          throw new Error(`target ${target} not routable: no healthy serve available`);
        }
        const directory = await this.directoryForSession(target);
        if (!directory) {
          throw new Error(`target ${target} not resolvable: directory lookup returned empty`);
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
          },
          next.payload,
        );
        await client.sendPrompt(target, directory, prompt);
        this.storage.swarm.markHandedOff(next.msgId, this.nowFn());
        this.log("delivered", { msgId: next.msgId, target });
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
          this.notifySenderOfFailure(next, String(err));
          return; // stop draining this target until next tick
        }
        const after = this.storage.swarm.getByMsgId(next.msgId);
        const attempts = (after?.attempts ?? 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          this.storage.swarm.markFailed(next.msgId, this.nowFn());
          this.log("failed (max attempts)", {
            msgId: next.msgId,
            error: String(err),
          });
          this.notifySenderOfFailure(next, String(err));
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
        return; // stop draining this target until next tick
      }
    }
  }

  /**
   * Enqueue a system notification back to the original sender when their
   * message could not be delivered. The sender's only prior signal was the
   * optimistic 202 "Queued" ack, so without this a permanent/terminal failure
   * is invisible to them.
   */
  private notifySenderOfFailure(failed: SwarmMessageRecord, reason: string): void {
    // Loop guard: a failed delivery.failed notification must not spawn another.
    if (failed.kind === DELIVERY_FAILED_KIND) return;
    // Only route notifications to a real session sender. `from` is not
    // guaranteed to be a session id (channels, coordinators), and a
    // non-ses_ target is unroutable anyway.
    if (!/^ses_[A-Za-z0-9_-]+$/.test(failed.fromSession)) return;

    const target = failed.toSession ?? failed.channel ?? "(unknown target)";
    const payload =
      `DELIVERY FAILED: your swarm message ${failed.msgId} to ${target} ` +
      `could not be delivered and was NOT received. Reason: ${reason}.`;
    this.storage.swarm.insert(
      {
        msgId: makeMsgId(),
        fromSession: "pigeon",
        toSession: failed.fromSession,
        channel: null,
        kind: DELIVERY_FAILED_KIND,
        priority: "normal",
        replyTo: failed.msgId,
        payload,
      },
      this.nowFn(),
    );
  }
}
