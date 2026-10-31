import type { StorageDb } from "../storage/database.js";
import type { GooseRunnerRegistry } from "./session-runner.js";
import { settleSwarmMessage } from "../swarm/swarm-settle.js";

/**
 * Cleanly drops a goose session's runner on deletion/reaping, and notifies original
 * senders of any queued swarm messages that were retired before reading.
 */
export function dropGooseRunnerWithSwarmNotify(
  storage: {
    swarm?: StorageDb["swarm"];
    db?: StorageDb["db"];
  },
  gooseRunners: GooseRunnerRegistry | undefined,
  sessionId: string,
  now = Date.now(),
): void {
  if (!gooseRunners) return;
  const runner = typeof gooseRunners.peek === "function" ? gooseRunners.peek(sessionId) : undefined;
  if (runner) {
    const queued = runner.dropQueuedItems();
    if (storage.swarm && storage.db) {
      for (const item of queued) {
        if (item.commandId.startsWith("swarm:")) {
          const msgId = item.commandId.slice(6);
          settleSwarmMessage(
            storage as StorageDb,
            msgId,
            {
              kind: "failed",
              reason: "the coordinator session was retired before it read the message; resend to its successor",
            },
            now,
          );
          try {
            storage.db.prepare("DELETE FROM goose_inflight_turns WHERE command_id = ?").run(item.commandId);
          } catch {
            /* best effort */
          }
        }
      }
    }
  }
  gooseRunners.drop(sessionId);
}
