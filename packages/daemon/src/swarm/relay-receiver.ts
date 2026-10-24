/**
 * Receiving side of the cross-machine relay (pigeon-k0qn.6), plus the sender's receipt of
 * failure items (pigeon-k0qn.7). Design §3.2–§3.3; decisions in
 * docs/plans/2026-10-24-daemon-relay.md.
 *
 * Called from the poller with the `swarm` array of one poll response, BEFORE that response's
 * command is dispatched: the tick is serialised, and a slow command would otherwise let these
 * items outlive their 60s lease and be handed out again.
 *
 * Pure SQLite work, synchronous, never throws. Returns the acks to send. An item that hits an
 * unexpected error is left OUT of the acks, so the worker hands it out again: acking it
 * `refused` would turn a transient fault into a permanent `delivery.failed`.
 */

import type { StorageDb } from "../storage/database";
import type { Priority } from "../storage/swarm-repo";
import { parseSwarmSendBody } from "../app";
import { isPullBackend } from "../adapters/goose-pull";
import { GOOSE_BACKEND_KIND } from "../goose/backend-kind";
import type { RelayAckItem } from "../worker/relay-client";
import { bankOrInsertSwarmMessage } from "./bank-or-insert";
import { notifySenderOfFailure } from "./notify-sender";
import { formatRelayFailureNotice, isReasonCode } from "./relay-notice";
import { formatWakePayloadAlert, isSuppressedFromRecovery } from "./delivery-policy";
import type { Locality } from "../routing/locality";

const SENDER_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;
const MACHINE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PRIORITIES = new Set(["urgent", "normal", "low"]);

/**
 * TTL for a relayed message banked in a pull inbox. The worker keeps the relay row 7 days from
 * when it was RELAYED, and the message may have waited up to 24h there before being banked, so
 * 5 days leaves an expiry here time to be reported back through `/swarm/relay/fail`.
 */
export const RELAYED_PULL_TTL_MS = 5 * 24 * 60 * 60 * 1000;

export interface RelayReceiverDeps {
  storage: StorageDb;
  selfMachineId: string;
  /** Machines whose messages this daemon accepts (`PIGEON_SWARM_RELAY_ACCEPT_FROM`). */
  acceptFrom: readonly string[];
  /**
   * The arbiter's locality check, used to refuse a `from` that is a session on THIS machine but
   * has no `sessions` row (subagents never register; idle sessions are reaped). Replies route by
   * id, so such a message would have its replies delivered to our own session. "unknown" (a sick
   * serve) passes: the sessions-table check still applies, and holding every relay hostage to
   * serve health would expire them as "unconfirmed" when nothing was written.
   */
  localityOf?: (sessionId: string) => Promise<Locality>;
  nowFn?: () => number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

class Refusal extends Error {
  constructor(readonly code: string, detail: string) {
    super(detail);
  }
}

function isNumOrNull(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

export async function processRelayItems(deps: RelayReceiverDeps, items: unknown): Promise<RelayAckItem[]> {
  const log = deps.log ?? ((m, f) => console.log(`[relay-receiver] ${m}`, f ?? ""));
  const acks: RelayAckItem[] = [];
  if (!Array.isArray(items)) return acks;

  // Locality of every sender, probed in parallel BEFORE the synchronous pass, so a poll's worth
  // of items costs one probe round inside the serialised tick, not one per item. A round tries a
  // sender's serve bases one after another at up to 3s each, so the worst case against hung serves
  // is (bases x 3s): well inside the 60s lease at today's base counts.
  const localSenders = new Set<string>();
  if (deps.localityOf) {
    const froms = new Set<string>();
    for (const raw of items) {
      const it = raw as Record<string, unknown> | null;
      if (it?.item === "message" && typeof it.from === "string" && SENDER_ID.test(it.from)) froms.add(it.from);
    }
    await Promise.all(
      [...froms].map(async (from) => {
        try {
          if ((await deps.localityOf!(from)) === "local") localSenders.add(from);
        } catch {
          // Fail open, as for "unknown".
        }
      }),
    );
  }

  for (const raw of items) {
    const it = raw as Record<string, unknown> | null;
    if (!it || typeof it !== "object" || typeof it.from_machine !== "string" || typeof it.msg_id !== "string") {
      // Nothing to ack it by. The worker re-offers it and finally expires it.
      log("unackable item dropped", { item: JSON.stringify(raw)?.slice(0, 200) });
      continue;
    }
    const key = { from_machine: it.from_machine, msg_id: it.msg_id };
    try {
      if (it.item === "failure") {
        acks.push({ ...key, ...receiveFailure(deps, it, log) });
      } else if (it.item === "message") {
        acks.push({ ...key, ...receiveMessage(deps, it, log, localSenders) });
      } else {
        acks.push({ ...key, outcome: "refused", reason: "invalid" });
      }
    } catch (err) {
      log("item left unacked after an error; the worker will offer it again", {
        msgId: it.msg_id,
        fromMachine: it.from_machine,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return acks;
}

type Outcome = Pick<RelayAckItem, "outcome" | "reason">;

function receiveMessage(
  deps: RelayReceiverDeps,
  it: Record<string, unknown>,
  log: NonNullable<RelayReceiverDeps["log"]>,
  localSenders: ReadonlySet<string>,
): Outcome {
  const { storage } = deps;
  const now = (deps.nowFn ?? Date.now)();
  const fromMachine = it.from_machine as string;
  try {
    // 1. Defence in depth: the worker checks the accept list too, but it could be wrong or old.
    if (!deps.acceptFrom.includes(fromMachine) || fromMachine === deps.selfMachineId) {
      throw new Refusal("not_accepted", `${fromMachine} is not in this machine's accept list`);
    }

    // 2. Items bypass /swarm/send's validator, so run it here (it refuses from='pigeon',
    //    reserved kinds, ':' in msg_id and the close tag), plus the worker's own shape rules.
    const parsed = parseSwarmSendBody({
      from: it.from,
      to: it.to,
      kind: it.kind,
      priority: it.priority,
      reply_to: it.reply_to,
      payload: it.payload,
      msg_id: it.msg_id,
    });
    if (!parsed.ok || typeof it.to !== "string") throw new Refusal("invalid", "failed /swarm/send validation");
    const f = parsed.fields;
    if (!SENDER_ID.test(f.from)) throw new Refusal("invalid", "from must be a ses_ id");
    if (typeof it.kind !== "string" || !PRIORITIES.has(String(it.priority))) {
      throw new Refusal("invalid", "kind and priority are required");
    }
    if (it.reply_to !== undefined && it.reply_to !== null && typeof it.reply_to !== "string") {
      throw new Refusal("invalid", "reply_to must be a string or null");
    }
    if (!isNumOrNull(it.deliver_at ?? null) || !isNumOrNull(it.expires_at ?? null)) {
      throw new Refusal("invalid", "deliver_at and expires_at must be numbers or null");
    }
    if (it.ref !== undefined && it.ref !== null && typeof it.ref !== "string") {
      throw new Refusal("invalid", "ref must be a string or null");
    }
    const msgId = it.msg_id as string;
    const to = it.to;

    // 3. Same msg_id already here, checked before anything that can change between hand-outs
    //    (sender locality, target opt-in), so a re-handout of an inserted message is acked.
    //    A duplicate only if WE recorded it as this very relay; any
    //    other holder of the id is a conflict, including a local row with a reused id.
    const inbound = storage.relayInbound.get(msgId);
    const localRow = storage.swarm.getByMsgId(msgId);
    const pullRow = storage.pullInbox.getIdentity(msgId);
    if (inbound || localRow || pullRow) {
      const storedPayload = localRow?.payload ?? pullRow?.payload;
      const same =
        inbound !== null &&
        inbound.fromMachine === fromMachine &&
        inbound.fromSession === f.from &&
        inbound.toSession === to &&
        (storedPayload === undefined || storedPayload === f.payload);
      if (same) return { outcome: "delivered" };
      throw new Refusal("msg_id_conflict", `msg_id ${msgId} is already used here by a different message`);
    }

    // 4. The worker refuses a REGISTERED sender owned by another machine; this is the receiver's
    //    half, against a remote machine speaking as one of our own sessions (a sessions row, or
    //    the locality probe above).
    if (storage.sessions.get(f.from) || localSenders.has(f.from)) {
      throw new Refusal("from_is_local", `${f.from} is a session on this machine`);
    }

    // 5. `swarm` in pull_sources was a local-trust decision; remote senders need `swarm-remote`.
    const target = storage.sessions.get(to);
    if (target && (isPullBackend(target) || target.backendKind === GOOSE_BACKEND_KIND)) {
      if (!target.pullSources.includes("swarm") || !target.pullSources.includes("swarm-remote")) {
        throw new Refusal("remote_not_accepted", `${to} does not accept swarm messages from other machines`);
      }
    }

    // 6. Insert. The inbound record goes first, in the same transaction, so the Telegram notice
    //    and any immediate failure already see it; a refusal rolls both back.
    const fromLabel = typeof it.from_label === "string" ? it.from_label.slice(0, 200) : null;
    storage.db.transaction(() => {
      storage.relayInbound.record({ msgId, fromMachine, fromSession: f.from, toSession: to, fromLabel }, now);
      const result = bankOrInsertSwarmMessage(
        storage,
        {
          msgId,
          fromSession: f.from,
          toSession: to,
          channel: null,
          kind: f.kind,
          priority: f.priority as Priority,
          replyTo: f.replyTo,
          payload: f.payload,
          deliverAt: (it.deliver_at as number | null | undefined) ?? null,
          // The SENDER's expiry, null included: the arbiter picks its retry policy by whether a
          // row has one at all. The worker's own deadline (relay_expires_at) is not ours.
          expiresAt: (it.expires_at as number | null | undefined) ?? null,
          ref: (it.ref as string | null | undefined) ?? null,
          remoteSenderName: `${fromLabel ?? f.from} (${fromMachine})`,
          pullTtlMs: RELAYED_PULL_TTL_MS,
        },
        now,
      );
      if (result.status === "refused") throw new Refusal(result.reason, result.error);
    })();
  } catch (err) {
    if (err instanceof Refusal) {
      log("refused", { msgId: it.msg_id, fromMachine, reason: err.code, detail: err.message });
      return { outcome: "refused", reason: err.code };
    }
    throw err;
  }
  log("received", { msgId: it.msg_id, fromMachine, to: it.to });
  return { outcome: "delivered" };
}

/**
 * A failure item: the worker reporting that a message THIS machine relayed did not arrive.
 *
 * A receipt, not prose. Accepted only when it names a row we relayed, from that same `from` to
 * that same `to`; the notice is rendered from the reason code. Acked `delivered` whether or not
 * the row still needs changing, so a failure item handed out twice (a lost ack) is not refused.
 */
function receiveFailure(
  deps: RelayReceiverDeps,
  it: Record<string, unknown>,
  log: NonNullable<RelayReceiverDeps["log"]>,
): Outcome {
  const { storage } = deps;
  const now = (deps.nowFn ?? Date.now)();
  const originalId = typeof it.original_msg_id === "string" ? it.original_msg_id : "";
  const row = originalId ? storage.swarm.getByMsgId(originalId) : null;
  // A row still `queued` is accepted too: a relay whose 202 was lost (timeout) leaves the row
  // queued while the worker holds the message, and the receiver can refuse it before our retry
  // learns it was stored. The failure item is the worker's proof that this machine relayed it,
  // so it is authoritative for a queued row as well. (Without this the retry's `202 duplicate`
  // would then stamp the row relayed and the sender would never hear of the refusal.)
  const relayed = row?.verifyFamily === "relayed" && row.state === "handed_off";
  const queued = row?.state === "queued";
  // Already failed (an earlier copy of this item, or the arbiter's own budget): ack, change nothing.
  const settled = row?.state === "failed";
  if (
    it.from_machine !== deps.selfMachineId ||
    !row ||
    !(relayed || queued || settled) ||
    row.fromSession !== it.from ||
    row.toSession !== it.to
  ) {
    log("failure item matches no relay of ours; dropped", {
      msgId: it.msg_id,
      originalMsgId: originalId,
      fromMachine: it.from_machine,
    });
    return { outcome: "refused", reason: "no_matching_relay" };
  }
  const code = isReasonCode(it.reason) ? it.reason : "unrecognised";
  const machine = typeof it.machine === "string" && MACHINE_ID.test(it.machine) ? it.machine : "another machine";
  storage.db.transaction(() => {
    const changed = queued ? storage.swarm.markFailed(row.msgId, now) : storage.swarm.markRelayFailed(row.msgId, now);
    if (!changed) return;
    const target = row.toSession ?? "(unknown target)";
    notifySenderOfFailure(
      storage,
      row,
      `relay to ${machine} failed: ${code}`,
      now,
      "unobserved",
      formatRelayFailureNotice(row.msgId, target, machine, code),
    );
    if (isSuppressedFromRecovery(row)) {
      storage.alerts.enqueue({
        source: "wake-relay-failed",
        refMsgId: row.msgId,
        text: formatWakePayloadAlert(row, `cross-machine relay to ${machine} failed (${code})`),
        severity: "error",
        now,
      });
    }
    log("relay failed at the receiver", { msgId: row.msgId, machine, reason: code });
  })();
  return { outcome: "delivered" };
}
