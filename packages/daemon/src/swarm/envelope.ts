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

  return `<swarm_message ${attrs.join(" ")}>\n${payload}\n${CLOSE_TAG}`;
}
