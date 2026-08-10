import type { StorageDb } from "../storage/database";
import type { SwarmMessageRecord } from "../storage/swarm-repo";
import { makeMsgId } from "../ids";
import { enqueueSwarmTelegramNotice } from "./telegram-notice";

/** Kind used for system notifications sent back to a sender whose message
 *  could not be delivered. Also used as the loop guard: a delivery.failed
 *  message that itself fails must NOT spawn another notification. */
export const DELIVERY_FAILED_KIND = "delivery.failed";

/**
 * What we actually OBSERVED about the payload in the target's transcript at
 * the moment we gave up. This is the discriminator for the sender-facing
 * notice, and it must be an observation rather than an inference.
 *
 *   "absent"      we read the transcript and our envelope is NOT in it
 *   "present"     we read the transcript and our envelope IS in it
 *   "unobserved"  we never got a usable look (delivery failed before handoff,
 *                 or the transcript was unreadable)
 */
export type DeliveryEvidence = "absent" | "present" | "unobserved";

/**
 * The sender-facing failure taxonomy. It is cut along what is actually
 * OBSERVABLE, because the sender acts on this text and the wrong verb makes
 * them do the wrong thing -- in either direction:
 *
 *   NOT RECEIVED       tells them to resend. Wrong when the payload is
 *                      sitting in the target's transcript: they duplicate it.
 *                      This was the pigeon-3m5 complaint.
 *   DO NOT RESEND      tells them to stop. Wrong when the payload never
 *                      landed: the message is stranded forever and the sender
 *                      has been talked out of the one action that would fix
 *                      it. This is the strictly WORSE error of the two.
 *
 * So the cut is on observed `evidence`, NOT on `handedOffAt`. handedOffAt only
 * records that `prompt_async` returned 2xx, and we know exactly what that is
 * worth: "a fiber was forked", nothing more (pigeon-usbg). The watchdog has a
 * whole branch for handed-off rows whose payload is provably NOT in the
 * transcript -- its own comment there reads "the 2xx lied". Keying the notice
 * on handedOffAt would make that branch tell the sender the opposite of what
 * the watchdog just observed four times over.
 *
 * `unobserved` falls back to handedOffAt, which is the best available signal
 * when nobody ever managed to read the transcript.
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
  evidence: DeliveryEvidence = "unobserved",
): string {
  const landed =
    evidence === "present"
      ? true
      : evidence === "absent"
        ? false
        : failed.handedOffAt !== null;
  if (!landed) {
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
  evidence: DeliveryEvidence = "unobserved",
): void {
  // Loop guard: a failed delivery.failed notification must not spawn another.
  if (failed.kind === DELIVERY_FAILED_KIND) return;
  // Only route notifications to a real session sender. `from` is not
  // guaranteed to be a session id (channels, coordinators), and a
  // non-ses_ target is unroutable anyway.
  if (!/^ses_[A-Za-z0-9_-]+$/.test(failed.fromSession)) return;

  const target = failed.toSession ?? failed.channel ?? "(unknown target)";
  const payload = formatFailureNotice(failed, target, reason, evidence);
  const msgId = makeMsgId();
  const inserted = storage.swarm.insert(
    {
      msgId,
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
  if (inserted) {
    const record = storage.swarm.getByMsgId(msgId);
    if (record) enqueueSwarmTelegramNotice(storage, record, now);
  }
}
