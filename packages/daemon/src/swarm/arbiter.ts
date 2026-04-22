import type { StorageDb } from "../storage/database";
import type { OpencodeClient } from "../opencode-client";
import type { SessionDirectoryRegistry } from "./registry";
import { renderEnvelope } from "./envelope";

export interface ArbiterOptions {
  storage: StorageDb;
  opencodeClient: OpencodeClient;
  registry: SessionDirectoryRegistry;
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
  private readonly opencodeClient: OpencodeClient;
  private readonly registry: SessionDirectoryRegistry;
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
    this.opencodeClient = opts.opencodeClient;
    this.registry = opts.registry;
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
        const directory = await this.registry.resolve(target);
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
        await this.opencodeClient.sendPrompt(target, directory, prompt);
        this.storage.swarm.markHandedOff(next.msgId, this.nowFn());
        this.log("delivered", { msgId: next.msgId, target });
      } catch (err) {
        const after = this.storage.swarm.getByMsgId(next.msgId);
        const attempts = (after?.attempts ?? 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          this.storage.swarm.markFailed(next.msgId, this.nowFn());
          this.log("failed (max attempts)", {
            msgId: next.msgId,
            error: String(err),
          });
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
}
