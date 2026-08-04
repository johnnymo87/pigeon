import type { StorageDb } from "../storage/database";
import type { SwarmMessageRecord } from "../storage/swarm-repo";
import { makeMsgId } from "../ids";

/** Kind used for system notifications sent back to a sender whose message
 *  could not be delivered. Also used as the loop guard: a delivery.failed
 *  message that itself fails must NOT spawn another notification. */
export const DELIVERY_FAILED_KIND = "delivery.failed";

/**
 * The sender-facing failure taxonomy. It is cut along what is actually
 * OBSERVABLE, not along what we suspect happened, because the sender acts on
 * this text and the wrong verb makes them do the wrong thing.
 *
 * `handed_off_at` is the discriminator, and it is a real structural fact: the
 * arbiter sets it only after `prompt_async` returned 2xx, and opencode writes
 * the user message into the target transcript before anything else can go
 * wrong (see pigeon-usbg). So:
 *
 *   handedOffAt === null  NEVER_DELIVERED       nothing was ever written into
 *                                               the target. Safe to resend.
 *   handedOffAt !== null  DELIVERED_UNCONFIRMED the payload IS in the target's
 *                                               transcript and will be in the
 *                                               context of its next turn. We
 *                                               could not confirm it was READ.
 *                                               Resending duplicates it.
 *
 * The old text said "could not be delivered and was NOT received" for BOTH,
 * which is a flat lie in the second case and the one that pigeon-3m5 was
 * filed for: it invites the sender to resend a message the target already
 * holds, compounding the duplication the watchdog just worked to avoid.
 *
 * Note what is deliberately ABSENT: a "dropped because the target was busy"
 * category. That is an inference, not an observation -- the transcript cannot
 * separate "dropped" from "started and has produced nothing yet" (the same
 * ambiguity documented on findSilentInFlight). It stays an internal recovery
 * trigger and is never asserted to a sender.
 */
export function formatFailureNotice(
  failed: Pick<SwarmMessageRecord, "msgId" | "handedOffAt">,
  target: string,
  reason: string,
): string {
  if (failed.handedOffAt === null) {
    return (
      `DELIVERY FAILED: your swarm message ${failed.msgId} to ${target} ` +
      `was never delivered and was NOT received. Reason: ${reason}. ` +
      `Nothing was written to the target, so it is safe to resend.`
    );
  }
  return (
    `DELIVERY UNCONFIRMED: your swarm message ${failed.msgId} to ${target} ` +
    `was handed to the target session, but we could not confirm it was read. ` +
    `Reason: ${reason}. The payload IS present in the target's transcript and ` +
    `will be in the context of its next turn, so it may still be acted on. ` +
    `Do NOT resend it -- that would deliver a second copy. If it is urgent, ` +
    `reach the target another way.`
  );
}

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
  const payload = formatFailureNotice(failed, target, reason);
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
