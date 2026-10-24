/**
 * Sender-facing text for a relay that did not deliver (pigeon-k0qn.7).
 *
 * Rendered from a REASON CODE only, never from text that crossed the wire: a failure item is a
 * receipt, not prose, so a key holder posing as a failure cannot put words in a session's
 * mouth. An unrecognised code is named as a code (it already matched `[a-z0-9_]{1,64}`).
 *
 * The verb is the load-bearing part, exactly as in `formatFailureNotice`: "NOT received, safe
 * to resend" when nothing reached the target, "UNCONFIRMED, do not resend" when something may
 * have, and "will fail the same way" when the refusal is structural.
 */

const REASON_CODE = /^[a-z0-9_]{1,64}$/;

/** Codes after which nothing reached the target and a resend is the right move. */
const RESENDABLE: Record<string, string> = {
  never_collected: "the receiving machine never collected it from the worker",
  not_delivered_on_receiver: "the receiving machine accepted it but could not deliver it to the session",
};

/** Codes after which the payload may have reached the target. */
const UNCONFIRMED: Record<string, string> = {
  unconfirmed: "the receiving machine collected it but never confirmed storing it",
  unconfirmed_on_receiver: "the receiving machine handed it to the session but could not confirm it was read",
};

/** Structural refusals: a resend fails the same way. */
const REFUSED: Record<string, string> = {
  not_accepted: "the receiving machine does not accept cross-machine messages from this machine",
  not_on_receiver: "the target is not on the machine the worker routed it to",
  from_is_local: "the receiving machine has a session with the sender's id",
  remote_not_accepted: "the target accepts swarm messages from its own machine only",
  msg_id_conflict: "the receiving machine already has a different message with that msg_id",
  invalid: "the receiving machine rejected the message as malformed",
  scheduled: "a scheduled message cannot be banked for a pull session",
  payload_too_large: "the payload is too long for the target's mailbox",
  no_mailbox: "the target has no swarm mailbox",
  no_session: "the target goose session does not exist on the receiving machine",
};

export function isReasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE.test(value);
}

export function formatRelayFailureNotice(msgId: string, target: string, machine: string, code: string): string {
  const where = /^[A-Za-z0-9_-]{1,64}$/.test(machine) ? ` on ${machine}` : "";
  const safeCode = isReasonCode(code) ? code : "unrecognised";
  if (RESENDABLE[safeCode]) {
    return (
      `DELIVERY FAILED: your swarm message ${msgId} to ${target}${where} was NOT received. ` +
      `Reason: ${RESENDABLE[safeCode]} (${safeCode}). Nothing was written to the target, so it is safe to resend.`
    );
  }
  if (UNCONFIRMED[safeCode]) {
    return (
      `DELIVERY UNCONFIRMED: your swarm message ${msgId} to ${target}${where} may or may not have been received. ` +
      `Reason: ${UNCONFIRMED[safeCode]} (${safeCode}). Resend only if a duplicate would be harmless; ` +
      `otherwise reach the target another way.`
    );
  }
  const why = REFUSED[safeCode] ?? `the receiving machine refused it (reason code ${safeCode})`;
  return (
    `DELIVERY FAILED: your swarm message ${msgId} to ${target}${where} was NOT received. ` +
    `Reason: ${why}. Do not resend it via swarm; it will fail the same way. Reach the target another way.`
  );
}

/** Sender-facing reason for a relay the WORKER refused (a permanent `/swarm/relay` answer). */
export function formatRelayRefusalReason(target: string, code: string, detail: string): string {
  switch (code) {
    case "unknown_session":
      return `target ${target} is not on this machine and the worker has no machine registered for it`;
    case "same_machine":
      return `target ${target} was not found on this machine, but the worker lists it here (probably deleted)`;
    case "receiver_not_retired":
      return `the machine that owns ${target} cannot receive cross-machine messages yet (it still accepts the shared worker key)`;
    case "not_accepted":
      return `the machine that owns ${target} does not accept cross-machine messages from this machine`;
    case "sender_not_yours":
      return `the worker has the sending session registered to another machine (${detail})`;
    case "expired":
      return "the message expired before it could be relayed";
    case "msg_id_conflict":
      return "the worker already holds a different message from this machine with that msg_id";
    default:
      return `the worker refused to relay it (${code}: ${detail})`;
  }
}
