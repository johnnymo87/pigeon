export type Priority = "urgent" | "normal" | "low";

export interface EnvelopeFields {
  v: string;
  kind: string;
  from: string;
  to: string | null;
  channel: string | null;
  msgId: string;
  replyTo: string | null;
  priority: Priority;
  scheduledFor?: number | null;
  deliveredLateMs?: number | null;
  ref?: string | null;
}

function escAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export const CLOSE_TAG = "</swarm_message>";

/**
 * Appended AFTER the close tag on every message addressed to a session other
 * than the sender.
 *
 * Why it exists: the dominant cost of a swarm is not payload length, it is
 * message count — each delivery spends a full reasoning turn on the receiving
 * session, whether the payload is twelve words or four hundred. Sessions
 * reliably drift into acks, heartbeats and turn-by-turn back-and-forth, and
 * the warning has to travel with the message because the receiver may never
 * have loaded the swarm-messaging skill.
 *
 * Why it sits OUTSIDE the envelope: the body between the tags must remain
 * exactly the sender's payload. A receiver that reads "everything between the
 * open and close tags" must not pick up daemon prose and attribute it to the
 * sender.
 *
 * Self-addressed messages (`to === from`, i.e. the scheduled self-wake) are
 * exempt: there is no back-and-forth to deter, and the tokens would be spent
 * on every wake forever.
 */
export const ECONOMY_FOOTER =
  "[pigeon] Message economy — the unit of cost is the message, not the word. " +
  "Reading this cost the receiving session a full reasoning turn, and so will " +
  "every follow-up. Do NOT ack, thank, heartbeat, or ping. Reply only if you " +
  "carry a decision only the recipient can make, new evidence, a retraction, " +
  "or the deliverable itself. Otherwise act silently — a quiet session making " +
  "progress is the healthy state. If you have several things to say, hold them " +
  "and send ONE message at your next checkpoint instead of a back-and-forth.";

/**
 * Thrown when a delivery can NEVER succeed no matter how many times it is
 * retried (e.g. the payload contains the literal envelope close tag). The
 * arbiter uses this to fail fast instead of burning ~6 minutes of retries on
 * a deterministic error.
 */
export class PermanentDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentDeliveryError";
  }
}

/**
 * True when the payload contains the literal `</swarm_message>` close tag,
 * which would break envelope parsing on the receiving side. Shared by the
 * enqueue-time validator (`POST /swarm/send`) and `renderEnvelope` so both
 * reject the same inputs.
 */
export function payloadHasCloseTag(payload: string): boolean {
  return payload.includes(CLOSE_TAG);
}

export function renderEnvelope(
  fields: EnvelopeFields,
  payload: string,
): string {
  if (payloadHasCloseTag(payload)) {
    throw new PermanentDeliveryError(
      "payload must not contain the literal close tag",
    );
  }

  const attrs: string[] = [
    `v="${escAttr(fields.v)}"`,
    `kind="${escAttr(fields.kind)}"`,
    `from="${escAttr(fields.from)}"`,
  ];
  if (fields.to !== null) attrs.push(`to="${escAttr(fields.to)}"`);
  if (fields.channel !== null)
    attrs.push(`channel="${escAttr(fields.channel)}"`);
  attrs.push(`msg_id="${escAttr(fields.msgId)}"`);
  if (fields.replyTo !== null)
    attrs.push(`reply_to="${escAttr(fields.replyTo)}"`);
  attrs.push(`priority="${escAttr(fields.priority)}"`);
  // Finite-guarded for the same reason as `delivered_late_ms` below:
  // `new Date(NaN).toISOString()` throws a RangeError, and a throw from here
  // that is not a PermanentDeliveryError is classified by the arbiter as an
  // ordinary retryable failure, so one corrupt timestamp would burn the
  // message's whole attempt budget. SQLite is dynamically typed, so a bad
  // `deliver_at` is not unreachable.
  if (fields.scheduledFor != null && Number.isFinite(fields.scheduledFor))
    attrs.push(`scheduled_for="${escAttr(new Date(fields.scheduledFor).toISOString())}"`);
  // Finite-guard is not paranoia: `BigInt(NaN)` throws a RangeError, and a
  // throw from here that is NOT a PermanentDeliveryError would be classified by
  // the arbiter as an ordinary retryable failure, so a single bad timestamp
  // would burn the message's whole attempt budget for no reason.
  if (fields.deliveredLateMs != null && Number.isFinite(fields.deliveredLateMs)) {
    const ms = Math.max(0, Math.floor(fields.deliveredLateMs));
    // String() on an integer below 1e21 never yields exponent notation, and a
    // lateness in milliseconds cannot realistically approach that.
    attrs.push(`delivered_late_ms="${String(ms)}"`);
  }
  if (fields.ref != null)
    attrs.push(`ref="${escAttr(fields.ref)}"`);

  const envelope = `<swarm_message ${attrs.join(" ")}>\n${payload}\n${CLOSE_TAG}`;

  // Self-addressed => scheduled self-wake => nobody to be chatty at.
  const selfAddressed = fields.to !== null && fields.to === fields.from;
  if (selfAddressed) return envelope;

  return `${envelope}\n\n${ECONOMY_FOOTER}`;
}
