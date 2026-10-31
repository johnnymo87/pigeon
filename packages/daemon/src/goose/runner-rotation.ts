import type { StorageDb } from "../storage/database.js";
import type { GooseRunnerRegistry } from "./session-runner.js";
import { notifySenderOfFailure } from "../swarm/notify-sender.js";

/**
 * Cleanly drops a goose session's runner on deletion/reaping, and notifies original
 * senders of any queued swarm messages that were retired before reading.
 */
export function dropGooseRunnerWithSwarmNotify(
  storage: StorageDb,
  gooseRunners: GooseRunnerRegistry | undefined,
  sessionId: string,
  now = Date.now(),
): void {
  if (!gooseRunners) return;
  const runner = gooseRunners.peek(sessionId);
  if (runner) {
    const queued = runner.dropQueuedItems();
    for (const item of queued) {
      if (item.commandId.startsWith("swarm:")) {
        const msgId = item.commandId.slice(6);
        const record = storage.swarm.getByMsgId(msgId);
        if (record) {
          storage.swarm.markFailed(msgId, now);
          notifySenderOfFailure(
            storage,
            record,
            "the coordinator session was retired before it read the message; resend to its successor",
            now,
            "unobserved",
            `DELIVERY FAILED: your swarm message ${msgId} to ${record.toSession ?? sessionId} was NOT received. Reason: the coordinator session was retired before it read the message; resend to its successor.`,
          );
        }
        try {
          storage.db.prepare("DELETE FROM goose_inflight_turns WHERE command_id = ?").run(item.commandId);
        } catch {
          /* best effort */
        }
      }
    }
  }
  gooseRunners.drop(sessionId);
}
