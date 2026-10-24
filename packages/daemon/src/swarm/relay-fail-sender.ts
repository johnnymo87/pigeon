import type { StorageDb } from "../storage/database";
import type { RelayClient } from "../worker/relay-client";

/**
 * Drains queued `/swarm/relay/fail` reports (pigeon-k0qn.6): a relayed message that was
 * accepted here and then failed. The queue is the `fail_*` columns of `swarm_relay_inbound`,
 * written by `notifySenderOfFailure`, so a report survives a restart.
 */
export const RELAY_FAIL_BASE_BACKOFF_MS = 5_000;
export const RELAY_FAIL_MAX_BACKOFF_MS = 10 * 60_000;

export function relayFailBackoff(attempts: number): number {
  return Math.min(RELAY_FAIL_BASE_BACKOFF_MS * 2 ** Math.min(attempts, 20), RELAY_FAIL_MAX_BACKOFF_MS);
}

export class RelayFailSender {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly storage: StorageDb,
    private readonly client: Pick<RelayClient, "fail">,
    private readonly nowFn: () => number = Date.now,
  ) {}

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const row of this.storage.relayInbound.listFailuresDue(this.nowFn())) {
        const outcome = await this.client.fail({
          from_machine: row.fromMachine,
          msg_id: row.msgId,
          reason: row.failReason!,
        });
        if (outcome === "sent") {
          this.storage.relayInbound.markFailureSent(row.msgId, this.nowFn());
          console.log(`[relay-fail] reported ${row.msgId} to ${row.fromMachine} (${row.failReason})`);
        } else if (outcome === "noop" || outcome === "final") {
          // The sender will never hear of this failure. The worker no longer has the row
          // (retention), or refused the report outright. Nothing retrying can change.
          this.storage.relayInbound.markFailureSent(row.msgId, this.nowFn());
          console.error(
            `[relay-fail] ${row.msgId} from ${row.fromMachine} failed here (${row.failReason}) and the worker ` +
              `${outcome === "noop" ? "no longer has it" : "refused the report"}; its sender will not be told`,
          );
        } else {
          this.storage.relayInbound.markFailureRetry(row.msgId, this.nowFn() + relayFailBackoff(row.failAttempts));
        }
      }
    } catch (err) {
      console.warn(`[relay-fail] run failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
