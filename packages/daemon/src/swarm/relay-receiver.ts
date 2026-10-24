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

const SENDER_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;
const MACHINE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PRIORITIES = new Set(["urgent", "normal", "low"]);

/**
 * TTL for a relayed message banked in a pull inbox. Under the worker's 7-day retention of the
 * relay row, so an expiry here can still be reported back through `/swarm/relay/fail`.
 */
export const RELAYED_PULL_TTL_MS = 6 * 24 * 60 * 60 * 1000;

export interface RelayReceiverDeps {
  storage: StorageDb;
  selfMachineId: string;
  /** Machines whose messages this daemon accepts (`PIGEON_SWARM_RELAY_ACCEPT_FROM`). */
  acceptFrom: readonly string[];
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

export function processRelayItems(deps: RelayReceiverDeps, items: unknown): RelayAckItem[] {
  const log = deps.log ?? ((m, f) => console.log(`[relay-receiver] ${m}`, f ?? ""));
  const acks: RelayAckItem[] = [];
  if (!Array.isArray(items)) return acks;
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
        acks.push({ ...key, ...receiveMessage(deps, it, log) });
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

    // 3. The worker refuses a REGISTERED sender owned by another machine; this is the airtight
    //    half, against a remote machine speaking as one of our own sessions.
    if (storage.sessions.get(f.from)) {
      throw new Refusal("from_is_local", `${f.from} is a session on this machine`);
    }

    // 4. Same msg_id already here. A duplicate only if WE recorded it as this very relay; any
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
  if (
    it.from_machine !== deps.selfMachineId ||
    !row ||
    row.verifyFamily !== "relayed" ||
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
    if (!storage.swarm.markRelayFailed(row.msgId, now)) return;
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
