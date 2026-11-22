import type { StorageDb } from "../storage/database.js";
import { notifySenderOfFailure } from "./notify-sender.js";
import { clampPreservingSurrogates } from "../text.js";

export type SwarmSettleOutcome =
  | { kind: "delivered"; turnError?: { kind?: string; message?: string } }
  | { kind: "not_delivered"; reason: string; customPayload?: string }
  | { kind: "unconfirmed"; reason: string };

export type SwarmSettleCallback = (msgId: string, outcome: SwarmSettleOutcome) => void;

/**
 * Settles a swarm message pushed to a goose session.
 *
 * Exactly one outcome per message:
 * - delivered: marks the swarm row verified (refuses already-failed rows) so cleanupOlderThan can reap it.
 *   If turnError is provided, notifies the sender that the prompt was delivered but the turn failed.
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
    const verified = storage.swarm.markVerified(msgId, now);
    if (verified && outcome.turnError) {
      storage.db.transaction(() => {
        const record = storage.swarm.getByMsgId(msgId);
        if (!record) return;
        const inbound = storage.relayInbound.get(msgId);
        if (inbound && inbound.fromSession === record.fromSession && inbound.toSession === (record.toSession ?? null)) {
          return;
        }
        const kind = outcome.turnError?.kind ?? "goose-turn-failed";
        const rawMsg = outcome.turnError?.message ?? "turn failed";
        const shortMsg = rawMsg.length > 300 ? `${clampPreservingSurrogates(rawMsg, 300)}...` : rawMsg;
        const payload = `Delivered; the recipient's turn failed (${kind}): ${shortMsg}. It will see your message on its next turn; resend only if it needs a fresh turn.`;
        notifySenderOfFailure(storage, record, `turn failed: ${kind}`, now, "present", payload);
      })();
    }
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
