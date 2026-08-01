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
  if (fields.scheduledFor != null)
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

  return `<swarm_message ${attrs.join(" ")}>\n${payload}\n${CLOSE_TAG}`;
}
