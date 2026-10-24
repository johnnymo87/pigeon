/**
 * Cross-machine swarm relay, worker side (pigeon-k0qn.5).
 *
 * Contract: §3.2 of docs/plans/2026-10-20-cross-machine-swarm-design.md. Decisions that
 * document leaves open: docs/plans/2026-10-22-worker-relay.md. Change the design first if the
 * contract must change; the daemon's send (`.7`) and receive (`.6`) sides are built against it.
 *
 * A sending daemon POSTs a row whose target lives on another machine to `/swarm/relay`. The
 * row waits in `swarm_relay`, is handed to the owning machine in its ordinary poll response
 * (`handOutRelayItems`, called from poll.ts), and is acked. Every message ends in a state its
 * sender hears about: anything refused or expired becomes a FAILURE ITEM addressed to the
 * original sending machine, which mints its own `delivery.failed` from the structured fields.
 * Failure items are never answered (the loop guard).
 *
 * Every route here requires a per-machine credential, never the shared key, so the worker,
 * not the caller, establishes which machine is speaking.
 */

import { isSharedKeyRetiredFor, machineMismatch, requireMachinePrincipal, sha256Hex, MACHINE_ID_PATTERN } from "./credentials";

/** The poll request header a receiving daemon sends. Byte-exact on both sides. */
export const SWARM_RELAY_HEADER = "X-Pigeon-Swarm-Relay";

/** A leased item not acked within this long is handed out again. */
export const RELAY_LEASE_MS = 60_000;
/** An owner whose last poll is older than this is offline (503, retried by the sender). */
export const RELAY_ONLINE_MS = 60_000;
/** Message items queued or leased for one machine before the relay answers 429. */
export const RELAY_QUEUE_CAP = 50;
/** Items per poll response. */
export const RELAY_HANDOUT_LIMIT = 20;
/** Longest a message may wait; also the lifetime of a failure item. */
export const RELAY_MAX_TTL_MS = 24 * 60 * 60 * 1000;
/** Hand-outs before an unacked item stops being offered (it then expires as `unconfirmed`). */
export const RELAY_MAX_LEASES = 5;
/** Settled rows are kept this long so a sender's retry still finds its row (idempotency). */
export const RELAY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Payload bound, UTF-8 bytes. Protects the D1 row; pull sessions have their own, smaller limit. */
export const RELAY_MAX_PAYLOAD_BYTES = 64 * 1024;
/** Most items one ack may settle. */
export const RELAY_MAX_ACK_ITEMS = 100;
/** Most machines an accept list may name (also bounds D1's bound-parameter count). */
export const RELAY_MAX_ACCEPT = 16;

const TARGET_ID = /^(ses|gse)_[A-Za-z0-9_-]{8,128}$/;
const SENDER_ID = /^ses_[A-Za-z0-9_-]{8,128}$/;
const MSG_ID = /^[^:\s]{1,128}$/;
const REASON = /^[a-z0-9_]{1,64}$/;
const PRIORITIES = new Set(["urgent", "normal", "low"]);

export type FailureReason = "never_collected" | "unconfirmed" | string;

interface MessageBody {
  msg_id: string;
  from: string;
  to: string;
  kind: string;
  priority: string;
  reply_to: string | null;
  payload: string;
  deliver_at: number | null;
  expires_at: number | null;
  ref: string | null;
  from_label: string | null;
}

interface FailureBody {
  original_msg_id: string;
  from: string;
  to: string;
  reason: string;
  machine: string;
}

interface RelayRow {
  from_machine: string;
  msg_id: string;
  item_kind: "message" | "failure";
  to_machine: string;
  to_session: string;
  from_session: string;
  body_json: string;
  payload_sha256: string;
  status: string;
  lease_count: number;
  created_at: number;
  expires_at: number;
}

function isMissingTable(err: unknown): boolean {
  return /no such table/i.test(String(err));
}

function unavailable(): Response {
  return Response.json({ error: "relay_unavailable" }, { status: 503 });
}

function bad(detail: string): Response {
  return Response.json({ error: "invalid", detail }, { status: 400 });
}

/** Runs a route body, turning a missing relay table into 503 (the schema may lag the deploy). */
async function tolerant(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (isMissingTable(err)) return unavailable();
    throw err;
  }
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function optString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function optNumber(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

/** Validates a relay body. Returns the message or the 400 to send. */
export function validateRelayBody(body: Record<string, unknown>, now: number): MessageBody | Response {
  const { msg_id, from, to, kind, priority, reply_to, payload, deliver_at, expires_at, ref, from_label } = body;
  if (typeof msg_id !== "string" || !MSG_ID.test(msg_id)) return bad("msg_id must be 1-128 characters with no ':' or whitespace");
  if (typeof from !== "string" || !SENDER_ID.test(from)) return bad("from must be a ses_ session id");
  if (typeof to !== "string" || !TARGET_ID.test(to)) return bad("to must be a ses_ or gse_ session id");
  if (typeof kind !== "string" || kind.length === 0 || kind.length > 64) return bad("kind must be a non-empty string");
  if (typeof priority !== "string" || !PRIORITIES.has(priority)) return bad("priority must be urgent, normal or low");
  if (reply_to !== undefined && !optString(reply_to)) return bad("reply_to must be a string or null");
  if (typeof payload !== "string") return bad("payload must be a string");
  if (new TextEncoder().encode(payload).length > RELAY_MAX_PAYLOAD_BYTES) return bad(`payload exceeds ${RELAY_MAX_PAYLOAD_BYTES} bytes`);
  // Required, though either may be null: without them the receiver loses scheduled_for /
  // delivered_late_ms / ref, and isSuppressedFromRecovery flips (design §3.2).
  if (!("deliver_at" in body) || !optNumber(deliver_at)) return bad("deliver_at is required (a number or null)");
  if (!("ref" in body) || !optString(ref)) return bad("ref is required (a string or null)");
  if (expires_at !== undefined && !optNumber(expires_at)) return bad("expires_at must be a number or null");
  if (typeof expires_at === "number" && expires_at <= now) return bad("expires_at is in the past");
  if (from_label !== undefined && !optString(from_label)) return bad("from_label must be a string or null");
  return {
    msg_id,
    from,
    to,
    kind,
    priority,
    reply_to: (reply_to as string | null | undefined) ?? null,
    payload,
    deliver_at: deliver_at as number | null,
    expires_at: (expires_at as number | null | undefined) ?? null,
    ref: ref as string | null,
    from_label: typeof from_label === "string" ? from_label.slice(0, 200) : null,
  };
}

/**
 * What makes two relays the same message. Excludes `from_label` (and the expiry/schedule
 * fields) so a retry from a sender renamed in between is still idempotent.
 */
export async function contentHash(m: Pick<MessageBody, "from" | "to" | "kind" | "reply_to" | "payload">): Promise<string> {
  return sha256Hex(JSON.stringify([m.from, m.to, m.kind, m.reply_to, m.payload]));
}

async function getRow(db: D1Database, fromMachine: string, msgId: string): Promise<RelayRow | null> {
  return db
    .prepare("SELECT * FROM swarm_relay WHERE from_machine = ? AND msg_id = ?")
    .bind(fromMachine, msgId)
    .first<RelayRow>();
}

function duplicateOrConflict(existing: RelayRow, hash: string): Response {
  if (existing.item_kind === "message" && existing.payload_sha256 === hash) {
    return Response.json({ accepted: true, duplicate: true, to_machine: existing.to_machine }, { status: 202 });
  }
  return Response.json(
    { error: "msg_id_conflict", detail: "that msg_id is already used by a different message from this machine" },
    { status: 409 },
  );
}

/** `POST /swarm/relay`. Check order is in the decisions note; it is load-bearing for the sender's table. */
export async function handleRelay(db: D1Database, env: Env, request: Request, now: number = Date.now()): Promise<Response> {
  const principal = await requireMachinePrincipal(request, env);
  if (principal instanceof Response) return principal;
  const fromMachine = principal.machineId;

  const raw = await readJson(request);
  if (!raw) return bad("body must be a JSON object");
  if (raw.from_machine !== undefined && raw.from_machine !== fromMachine) {
    return machineMismatch(fromMachine, String(raw.from_machine));
  }
  const msg = validateRelayBody(raw, now);
  if (msg instanceof Response) return msg;

  return tolerant(async () => {
    const hash = await contentHash(msg);
    const existing = await getRow(db, fromMachine, msg.msg_id);
    if (existing) return duplicateOrConflict(existing, hash);

    const owner = await db
      .prepare("SELECT machine_id FROM sessions WHERE session_id = ?")
      .bind(msg.to)
      .first<{ machine_id: string }>();
    if (!owner) {
      return Response.json({ error: "unknown_session", detail: `${msg.to} is not registered to any machine` }, { status: 404 });
    }
    const toMachine = owner.machine_id;
    if (toMachine === fromMachine) {
      console.error("[relay] same_machine: the sender's locality check and D1 disagree", { fromMachine, to: msg.to, msgId: msg.msg_id });
      return Response.json({ error: "same_machine", detail: `D1 says ${msg.to} is on ${fromMachine}` }, { status: 409 });
    }
    // Rule 1 from the .8 review: until the owner is retired from the shared key, a shared-key
    // holder can re-register its sessions to itself and collect what we would queue here.
    if (!isSharedKeyRetiredFor(env, toMachine)) {
      return Response.json(
        { error: "receiver_not_retired", detail: `${toMachine} still accepts the shared worker key, so it cannot receive relays` },
        { status: 403 },
      );
    }
    const accept = await db
      .prepare("SELECT accept_csv FROM machine_relay_accept WHERE machine_id = ?")
      .bind(toMachine)
      .first<{ accept_csv: string }>();
    if (!accept || !accept.accept_csv.split(",").includes(fromMachine)) {
      return Response.json(
        { error: "not_accepted", detail: `${toMachine} does not accept relays from ${fromMachine}` },
        { status: 403 },
      );
    }
    const machine = await db
      .prepare("SELECT last_poll_at FROM machines WHERE machine_id = ?")
      .bind(toMachine)
      .first<{ last_poll_at: number }>();
    if (!machine || now - machine.last_poll_at > RELAY_ONLINE_MS) {
      return Response.json({ error: "target_offline", detail: `${toMachine} is not polling` }, { status: 503 });
    }
    const queued = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM swarm_relay WHERE to_machine = ? AND item_kind = 'message' AND status IN ('queued','leased')",
      )
      .bind(toMachine)
      .first<{ n: number }>();
    if ((queued?.n ?? 0) >= RELAY_QUEUE_CAP) {
      return Response.json({ error: "queue_full", detail: `${RELAY_QUEUE_CAP} relays already wait for ${toMachine}` }, { status: 429 });
    }

    const expiresAt = Math.min(msg.expires_at ?? Number.POSITIVE_INFINITY, now + RELAY_MAX_TTL_MS);
    const stored: MessageBody = { ...msg, expires_at: expiresAt };
    const result = await db
      .prepare(
        `INSERT INTO swarm_relay (from_machine, msg_id, item_kind, to_machine, to_session, from_session,
                                  body_json, payload_sha256, status, created_at, expires_at)
         VALUES (?, ?, 'message', ?, ?, ?, ?, ?, 'queued', ?, ?)
         ON CONFLICT (from_machine, msg_id) DO NOTHING`,
      )
      .bind(fromMachine, msg.msg_id, toMachine, msg.to, msg.from, JSON.stringify(stored), hash, now, expiresAt)
      .run();
    if (!result.meta.changes) {
      // A concurrent retry of the same msg_id won the insert.
      const raced = await getRow(db, fromMachine, msg.msg_id);
      if (raced) return duplicateOrConflict(raced, hash);
    }
    return Response.json({ accepted: true, to_machine: toMachine }, { status: 202 });
  });
}

/**
 * Turns a message row that did not arrive into a failure item for its sender.
 *
 * Minted only while the message row is still in one of `fromStatuses`, and always batched
 * BEFORE the statement that settles that row, in one transaction. So a message is never
 * settled without its failure item, and the `f:` key keeps it to one failure item per message
 * whichever path (refusal, fail, expiry) gets there first.
 */
function failureStatement(
  db: D1Database,
  row: RelayRow,
  reason: FailureReason,
  now: number,
  fromStatuses: string[],
): D1PreparedStatement {
  const body: FailureBody = {
    original_msg_id: row.msg_id,
    from: row.from_session,
    to: row.to_session,
    reason,
    machine: row.to_machine,
  };
  return db
    .prepare(
      `INSERT INTO swarm_relay (from_machine, msg_id, item_kind, to_machine, to_session, from_session,
                                body_json, payload_sha256, status, created_at, expires_at)
       SELECT ?, ?, 'failure', ?, ?, ?, ?, '', 'queued', ?, ?
       WHERE EXISTS (
         SELECT 1 FROM swarm_relay
         WHERE from_machine = ? AND msg_id = ? AND item_kind = 'message'
           AND status IN (${fromStatuses.map(() => "?").join(",")})
       )
       ON CONFLICT (from_machine, msg_id) DO NOTHING`,
    )
    .bind(
      row.from_machine,
      `f:${row.msg_id}`,
      row.from_machine,
      row.from_session,
      row.from_session,
      JSON.stringify(body),
      now,
      now + RELAY_MAX_TTL_MS,
      row.from_machine,
      row.msg_id,
      ...fromStatuses,
    );
}

interface AckItem {
  from_machine: string;
  msg_id: string;
  outcome: "delivered" | "refused";
  reason?: string;
}

/** `POST /swarm/relay/ack` `{items: [{from_machine, msg_id, outcome, reason?}]}`. */
export async function handleRelayAck(db: D1Database, env: Env, request: Request, now: number = Date.now()): Promise<Response> {
  const principal = await requireMachinePrincipal(request, env);
  if (principal instanceof Response) return principal;
  const raw = await readJson(request);
  const items = raw?.items;
  if (!Array.isArray(items) || items.length === 0) return bad("items must be a non-empty array");
  if (items.length > RELAY_MAX_ACK_ITEMS) return bad(`at most ${RELAY_MAX_ACK_ITEMS} items per ack`);
  const parsed: AckItem[] = [];
  for (const it of items as unknown[]) {
    const o = it as Record<string, unknown> | null;
    if (!o || typeof o !== "object") return bad("each item must be an object");
    if (typeof o.from_machine !== "string" || !MACHINE_ID_PATTERN.test(o.from_machine)) return bad("from_machine is invalid");
    if (typeof o.msg_id !== "string" || !/^(f:)?[^:\s]{1,128}$/.test(o.msg_id)) return bad("msg_id is invalid");
    if (o.outcome !== "delivered" && o.outcome !== "refused") return bad("outcome must be delivered or refused");
    if (o.outcome === "refused" && (typeof o.reason !== "string" || !REASON.test(o.reason))) {
      return bad("a refusal needs a reason code ([a-z0-9_]{1,64})");
    }
    parsed.push({ from_machine: o.from_machine, msg_id: o.msg_id, outcome: o.outcome, reason: o.reason as string | undefined });
  }

  return tolerant(async () => {
    const results: Array<{ from_machine: string; msg_id: string; result: "ok" | "not_found" | "not_yours" }> = [];
    for (const it of parsed) {
      const row = await getRow(db, it.from_machine, it.msg_id);
      if (!row) {
        results.push({ from_machine: it.from_machine, msg_id: it.msg_id, result: "not_found" });
        continue;
      }
      if (row.to_machine !== principal.machineId) {
        results.push({ from_machine: it.from_machine, msg_id: it.msg_id, result: "not_yours" });
        continue;
      }
      // Late acks after a lapsed lease still settle the row; an already-settled row is a no-op.
      const settle = db
        .prepare(
          `UPDATE swarm_relay SET status = ?, reason = ?, settled_at = ?
           WHERE from_machine = ? AND msg_id = ? AND to_machine = ? AND status IN ('queued','leased')`,
        )
        .bind(it.outcome, it.reason ?? null, now, row.from_machine, row.msg_id, principal.machineId);
      if (it.outcome === "refused" && row.item_kind === "message") {
        await db.batch([failureStatement(db, row, it.reason!, now, ["queued", "leased"]), settle]);
      } else {
        await settle.run();
        if (it.outcome === "refused") {
          console.error("[relay] failure item refused by its receiver; dropped (failure items are never answered)", {
            fromMachine: row.from_machine,
            msgId: row.msg_id,
            reason: it.reason,
          });
        }
      }
      results.push({ from_machine: it.from_machine, msg_id: it.msg_id, result: "ok" });
    }
    return Response.json({ ok: true, results });
  });
}

/**
 * `POST /swarm/relay/fail` `{from_machine, msg_id, reason}`: a relayed message that was
 * inserted on the receiver and then failed there (retries exhausted, expired, confirmed gone).
 * The receiver cannot send a `delivery.failed` row back itself (`from='pigeon'` is refused on
 * the relay route), so the worker mints the failure item, exactly as for a refusal.
 */
export async function handleRelayFail(db: D1Database, env: Env, request: Request, now: number = Date.now()): Promise<Response> {
  const principal = await requireMachinePrincipal(request, env);
  if (principal instanceof Response) return principal;
  const raw = await readJson(request);
  if (!raw) return bad("body must be a JSON object");
  const { from_machine, msg_id, reason } = raw;
  if (typeof from_machine !== "string" || !MACHINE_ID_PATTERN.test(from_machine)) return bad("from_machine is invalid");
  if (typeof msg_id !== "string" || !MSG_ID.test(msg_id)) return bad("msg_id is invalid");
  if (typeof reason !== "string" || !REASON.test(reason)) return bad("reason must be a code ([a-z0-9_]{1,64})");

  return tolerant(async () => {
    const row = await getRow(db, from_machine, msg_id);
    // Retention may already have pruned it; the sender's own retry budget covers that case.
    if (!row || row.item_kind !== "message") return Response.json({ ok: true, noop: true });
    if (row.to_machine !== principal.machineId) return machineMismatch(principal.machineId, row.to_machine);
    await db.batch([
      // Any state: a delivered row is exactly the case this route exists for.
      failureStatement(db, row, reason, now, ["queued", "leased", "delivered", "refused", "expired"]),
      db
        .prepare(
          `UPDATE swarm_relay SET status = 'refused', reason = ?, settled_at = ?
           WHERE from_machine = ? AND msg_id = ? AND status IN ('queued','leased')`,
        )
        .bind(reason, now, row.from_machine, row.msg_id),
    ]);
    return Response.json({ ok: true });
  });
}

/** Parsed `X-Pigeon-Swarm-Relay: accept=a,b; failures=1`. Null when the header is absent. */
export function parseRelayHeader(value: string | null): { accept: string[]; failures: boolean } | null {
  if (value === null) return null;
  let accept: string[] = [];
  let failures = false;
  for (const part of value.split(";")) {
    const [k, v = ""] = part.split("=", 2).map((s) => s.trim());
    if (k === "accept") {
      accept = v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => MACHINE_ID_PATTERN.test(s));
    } else if (k === "failures") {
      failures = v === "1";
    }
  }
  return { accept: [...new Set(accept)].sort().slice(0, RELAY_MAX_ACCEPT), failures };
}

/** One item in the `swarm` array of a poll response. */
export type HandOutItem =
  | ({ item: "message"; from_machine: string } & MessageBody)
  | ({ item: "failure"; from_machine: string; msg_id: string } & FailureBody);

/**
 * The poll's relay step: record what the machine accepts, then lease up to
 * RELAY_HANDOUT_LIMIT items for it. Returns the items to attach (possibly empty).
 *
 * NEVER throws. The relay must not cost a command: a missing table or a D1 error is logged and
 * the poll proceeds as if nothing were queued. Items leased by a poll whose response is then
 * lost come back after RELAY_LEASE_MS.
 */
export async function handOutRelayItems(
  db: D1Database,
  machineId: string,
  headerValue: string | null,
  now: number = Date.now(),
): Promise<HandOutItem[]> {
  const header = parseRelayHeader(headerValue);
  try {
    if (header === null) {
      // A rolled-back receiver: clear what it used to accept so senders hear `not_accepted` at
      // once, rather than `target_offline` (retried) while it keeps polling. Writes only once.
      await db
        .prepare("UPDATE machine_relay_accept SET accept_csv = '', updated_at = ? WHERE machine_id = ? AND accept_csv <> ''")
        .bind(now, machineId)
        .run();
      return [];
    }
    const csv = header.accept.join(",");
    // Written only when it changes: a write per poll per machine would double D1's row writes.
    await db
      .prepare(
        `INSERT INTO machine_relay_accept (machine_id, accept_csv, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (machine_id) DO UPDATE SET accept_csv = excluded.accept_csv, updated_at = excluded.updated_at
         WHERE machine_relay_accept.accept_csv IS NOT excluded.accept_csv`,
      )
      .bind(machineId, csv, now)
      .run();

    if (header.accept.length === 0 && !header.failures) return [];
    const placeholders = header.accept.map(() => "?").join(",");
    const messageClause = header.accept.length > 0 ? `(item_kind = 'message' AND from_machine IN (${placeholders}))` : "0";
    const failureClause = header.failures ? "item_kind = 'failure'" : "0";
    const { results } = await db
      .prepare(
        `UPDATE swarm_relay SET status = 'leased', leased_at = ?, lease_count = lease_count + 1
         WHERE rowid IN (
           SELECT rowid FROM swarm_relay
           WHERE to_machine = ?
             AND (status = 'queued' OR (status = 'leased' AND leased_at < ?))
             AND lease_count < ?
             AND expires_at > ?
             AND (${messageClause} OR ${failureClause})
           ORDER BY created_at ASC
           LIMIT ?
         )
         AND (status = 'queued' OR (status = 'leased' AND leased_at < ?))
         RETURNING from_machine, msg_id, item_kind, body_json, created_at`,
      )
      .bind(now, machineId, now - RELAY_LEASE_MS, RELAY_MAX_LEASES, now, ...header.accept, RELAY_HANDOUT_LIMIT, now - RELAY_LEASE_MS)
      .all<{ from_machine: string; msg_id: string; item_kind: string; body_json: string; created_at: number }>();

    // SQLite does not promise RETURNING follows the subquery's order.
    return [...results]
      .sort((a, b) => a.created_at - b.created_at || a.msg_id.localeCompare(b.msg_id))
      .map((r) => {
        const body = JSON.parse(r.body_json) as MessageBody | FailureBody;
        return r.item_kind === "failure"
          ? ({ item: "failure", from_machine: r.from_machine, msg_id: r.msg_id, ...(body as FailureBody) } as HandOutItem)
          : ({ item: "message", from_machine: r.from_machine, ...(body as MessageBody) } as HandOutItem);
      });
  } catch (err) {
    if (!isMissingTable(err)) {
      console.error("[relay] hand-out failed; poll continues without swarm items", { machineId, error: String(err) });
    }
    return [];
  }
}

/**
 * Hourly: expire what nobody collected, turning each message into a failure item for its
 * sender, and prune settled rows past retention. Failure items that expire are logged and
 * dropped (never answered). Bounded per tick; a backlog drains over following ticks.
 */
export async function runRelayExpiry(db: D1Database, now: number = Date.now(), limit = 500): Promise<{ expired: number; pruned: number }> {
  let rows: RelayRow[];
  try {
    ({ results: rows } = await db
      .prepare(
        `SELECT * FROM swarm_relay
         WHERE (status IN ('queued','leased') AND expires_at <= ?)
            OR (status = 'leased' AND lease_count >= ? AND leased_at < ?)
         LIMIT ?`,
      )
      .bind(now, RELAY_MAX_LEASES, now - RELAY_LEASE_MS, limit)
      .all<RelayRow>());
  } catch (err) {
    if (isMissingTable(err)) return { expired: 0, pruned: 0 };
    throw err;
  }

  let expired = 0;
  for (const row of rows) {
    const settle = db
      .prepare(
        `UPDATE swarm_relay SET status = 'expired', reason = ?, settled_at = ?
         WHERE from_machine = ? AND msg_id = ? AND status = ?`,
      )
      .bind(row.status === "queued" ? "never_collected" : "unconfirmed", now, row.from_machine, row.msg_id, row.status);
    if (row.item_kind === "failure") {
      await settle.run();
      console.error("[relay] failure item expired uncollected; dropped", { toMachine: row.to_machine, msgId: row.msg_id });
    } else {
      const reason = row.status === "queued" ? "never_collected" : "unconfirmed";
      await db.batch([failureStatement(db, row, reason, now, [row.status]), settle]);
    }
    expired++;
  }

  const pruned = await db
    .prepare("DELETE FROM swarm_relay WHERE status IN ('delivered','refused','expired') AND created_at < ?")
    .bind(now - RELAY_RETENTION_MS)
    .run();
  return { expired, pruned: pruned.meta.changes ?? 0 };
}
