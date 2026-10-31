import type { StorageDb } from "../storage/database.js";
import { notifySenderOfFailure } from "./notify-sender.js";

export type SwarmSettleOutcome =
  | { kind: "delivered" }
  | { kind: "not_delivered"; reason: string; customPayload?: string }
  | { kind: "unconfirmed"; reason: string };

export type SwarmSettleCallback = (msgId: string, outcome: SwarmSettleOutcome) => void;

/**
 * Settles a swarm message pushed to a goose coordinator.
 *
 * Exactly one outcome per message:
 * - delivered: marks the swarm row verified (refuses already-failed rows) so cleanupOlderThan can reap it.
 * - not_delivered: marks failed and notifies sender with "was NOT received ... resend" wording.
 * - unconfirmed: marks failed and notifies sender WITHOUT custom payload ("DELIVERY UNCONFIRMED ... Do NOT resend").
 */
export function settleSwarmMessage(
  storage: StorageDb,
  msgId: string,
  outcome: SwarmSettleOutcome,
  now = Date.now(),
): void {
  if (outcome.kind === "delivered") {
    storage.swarm.markVerified(msgId, now);
  } else if (outcome.kind === "not_delivered") {
    storage.db.transaction(() => {
      const record = storage.swarm.getByMsgId(msgId);
      if (storage.swarm.markFailed(msgId, now)) {
        if (record) {
          const target = record.toSession ?? "(unknown target)";
          const payload =
            outcome.customPayload ??
            `DELIVERY FAILED: your swarm message ${msgId} to ${target} was never delivered and was NOT received. Reason: ${outcome.reason}. Nothing reached the target, so it is safe to resend.`;
          notifySenderOfFailure(storage, record, outcome.reason, now, "absent", payload);
        }
      }
    })();
  } else {
    // outcome.kind === "unconfirmed"
    storage.db.transaction(() => {
      const record = storage.swarm.getByMsgId(msgId);
      if (storage.swarm.markFailed(msgId, now)) {
        if (record) {
          // Without customPayload, formatFailureNotice produces:
          // "DELIVERY UNCONFIRMED: your swarm message <id> to <target> was handed to the target session, but we could not confirm it was read. ... Do NOT resend it..."
          notifySenderOfFailure(storage, record, outcome.reason, now, "unobserved");
        }
      }
    })();
  }
}
