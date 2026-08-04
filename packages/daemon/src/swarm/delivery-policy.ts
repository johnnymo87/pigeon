import { TransportError } from "../opencode-client";
import { clampPreservingSurrogates } from "../text";
import type { SwarmMessageRecord } from "../storage/swarm-repo";

export class TargetUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetUnavailableError";
  }
}

/**
 * Returns true if the delivery failure was an outage failure (uncounted retry).
 * Uncounted means "the request provably never reached the serve" (so a retry cannot duplicate a prompt).
 *
 * Timeout being COUNTED (returning false) is deliberate and important:
 * `prompt_async` is NOT idempotent, so a timeout may mean the request WAS processed.
 * Uncounted timeout retries would mean unbounded duplicate wakes.
 */
export function isOutageFailure(err: unknown): boolean {
  if (err instanceof TargetUnavailableError) {
    return true;
  }
  if (err instanceof TransportError) {
    return true;
  }
  return false;
}

/** True when `kind === "wake"` or `kind.startsWith("wake.")`. */
export function isWakeKind(kind: string): boolean {
  return kind === "wake" || kind.startsWith("wake.");
}

/**
 * Identifies "wake-like" rows: scheduled messages (`deliverAt !== null`) and
 * wake-kind messages (`wake` / `wake.*`). Scheduled-ness is the mechanism
 * (a scheduled target is idle by definition) and `wake.*` is the label; either
 * is sufficient. Keyed on the mechanism deliberately — `POST /swarm/schedule`
 * only DEFAULTS `kind` to `wake` and otherwise takes the caller's string
 * verbatim, so a label-only guard is dodgeable.
 *
 * Named for its original use — suppressing the requeue/abort recovery ladder,
 * which is invalid against idle targets — but it now gates a second, related
 * decision: whether a terminal failure inlines the payload into a Telegram
 * alert. Both follow from the same fact about this population, that NOBODY IS
 * LISTENING IN-BAND. That is why recovery-by-redelivery is pointless for them,
 * and why notifying the sender is pointless too (for a self-wake the sender is
 * the unreachable session). One predicate, one underlying property; splitting
 * it into two identical predicates would just let them drift.
 */
export function isSuppressedFromRecovery(
  row: Pick<SwarmMessageRecord, "kind" | "deliverAt">,
): boolean {
  return isWakeKind(row.kind) || row.deliverAt !== null;
}

export const MAX_PAYLOAD_ALERT_CHARS = 1000;

export function formatWakePayloadAlert(
  row: Pick<
    SwarmMessageRecord,
    "msgId" | "toSession" | "channel" | "deliverAt" | "createdAt" | "payload"
  >,
  reason: string,
  prefix = "delivery failed for wake/scheduled message",
): string {
  const target = row.toSession ?? row.channel ?? "unknown";
  // Label honestly. A `kind: "wake"` message sent through plain /swarm/send is
  // wake-like (so it lands here) but was never scheduled, and printing its
  // creation time under a `scheduled_for:` heading would invent a schedule
  // that never existed.
  const timeLabel = row.deliverAt !== null ? "scheduled_for" : "created_at";
  const timeIso = new Date(row.deliverAt ?? row.createdAt).toISOString();
  let payloadText = row.payload;
  if (payloadText.length > MAX_PAYLOAD_ALERT_CHARS) {
    payloadText =
      clampPreservingSurrogates(payloadText, MAX_PAYLOAD_ALERT_CHARS) +
      "... [truncated]";
  }
  return (
    `${prefix}: msg ${row.msgId} to ${target}\n` +
    `${timeLabel}: ${timeIso}\n` +
    `reason: ${reason}\n\n` +
    `payload:\n${payloadText}`
  );
}

/**
 * Kind used for a NUDGE: a small message telling a target session that it has
 * an earlier swarm message sitting unread in its own transcript.
 *
 * A nudge exists because of an opencode behaviour (pigeon-usbg): prompting a
 * BUSY session writes the user message into the transcript and then silently
 * discards the run, so the payload is present but no turn is ever started for
 * it. The payload does not need re-sending — it needs a turn. A nudge is the
 * cheapest thing that starts one.
 *
 * It is also the loop guard: the watchdog must never nudge a nudge, or a
 * permanently idle session mints them forever.
 */
export const NUDGE_KIND = "swarm.nudge";

/**
 * Body of a nudge. It must be intelligible to the RECEIVING AGENT, which is a
 * language model reading its own context, so it says plainly what happened,
 * names the message, and — importantly — tells the agent what to do if it has
 * already handled it.
 *
 * That last clause is load-bearing. A turn that was already running when the
 * original arrived can have absorbed it mid-turn (opencode re-reads the whole
 * transcript on every step), in which case the message HAS been handled and
 * the watchdog cannot tell. Rather than risk silent double-execution we make
 * the ambiguity explicit and let the agent, which can see its own history,
 * resolve it.
 */
export function formatNudgePayload(
  original: Pick<SwarmMessageRecord, "msgId" | "fromSession">,
): string {
  // NOTE the deliberately non-attribute rendering of the id below. Writing it
  // as msg_id="..." would make this nudge byte-match findAnchor's needle, so
  // the delivered nudge would register as an ANCHOR for the original message.
  // That silently breaks findAnchor's premise (attribute-form matches appear
  // only in a row's own envelope) and, if the original were ever removed from
  // the transcript, would let a surviving nudge fabricate an anchor and keep
  // the watchdog asserting that a vanished payload "is in the transcript".
  return (
    `You have an UNREAD swarm message earlier in this conversation: ` +
    `message id ${original.msgId}, from ${original.fromSession}. ` +
    `It was delivered into your transcript but no turn was ever started for ` +
    `it, so you may never have acted on it. Scroll back, find that envelope, ` +
    `and handle it now. ` +
    `If you cannot find it — a compaction may have dropped it out of your ` +
    `context — call swarm_read to fetch it, rather than assuming it was ` +
    `nothing. ` +
    `If you have ALREADY handled it, do nothing further — this nudge is ` +
    `automatic and does not mean your earlier work was lost.`
  );
}
