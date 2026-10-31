import type { StorageDb } from "../storage/database.js";
import { notifySenderOfFailure } from "./notify-sender.js";

export type SwarmSettleOutcome =
  | { kind: "delivered" }
  | { kind: "failed"; reason: string };

export type SwarmSettleCallback = (msgId: string, outcome: SwarmSettleOutcome) => void;

/**
 * Settles a swarm message pushed to a goose coordinator.
 *
 * Exactly one outcome per message:
 * - delivered: marks the swarm row verified so cleanupOlderThan can reap it.
 * - failed: in a transaction, if markFailed succeeds, notifies the original sender
 *   with an accurate reason.
 */
export function settleSwarmMessage(
  storage: StorageDb,
  msgId: string,
  outcome: SwarmSettleOutcome,
  now = Date.now(),
): void {
  if (outcome.kind === "delivered") {
    storage.swarm.markVerified(msgId, now);
  } else {
    storage.db.transaction(() => {
      const record = storage.swarm.getByMsgId(msgId);
      if (storage.swarm.markFailed(msgId, now)) {
        if (record) {
          notifySenderOfFailure(
            storage,
            record,
            outcome.reason,
            now,
            "unobserved",
            `DELIVERY FAILED: your swarm message ${msgId} to ${record.toSession ?? "(unknown target)"} was NOT received. Reason: ${outcome.reason}.`,
          );
        }
      }
    })();
  }
}
