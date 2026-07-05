import type { StorageDb } from "../storage/database";
import type { SwarmMessageRecord } from "../storage/swarm-repo";
import { makeMsgId } from "../ids";

/** Kind used for system notifications sent back to a sender whose message
 *  could not be delivered. Also used as the loop guard: a delivery.failed
 *  message that itself fails must NOT spawn another notification. */
export const DELIVERY_FAILED_KIND = "delivery.failed";

/**
 * Enqueue a system notification back to the original sender when their
 * message could not be delivered (terminal failure). The sender's only
 * prior signal was the optimistic ack at send time, so without this a
 * terminal failure is invisible to them.
 *
 * Shared by {@link SwarmArbiter} (delivery-time failures) and the delivery
 * watchdog (post-handoff verification failures).
 */
export function notifySenderOfFailure(
  storage: StorageDb,
  failed: SwarmMessageRecord,
  reason: string,
  now: number,
): void {
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
  storage.swarm.insert(
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
    now,
  );
}
