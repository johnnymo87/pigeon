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

const CLOSE_TAG = "</swarm_message>";

export function renderEnvelope(
  fields: EnvelopeFields,
  payload: string,
): string {
  if (payload.includes(CLOSE_TAG)) {
    throw new Error("payload must not contain the literal close tag");
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
