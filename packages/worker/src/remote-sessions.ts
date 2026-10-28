/**
 * `GET /sessions/remote?limit=<n>` (pigeon-k0qn.9): swarm_list's remote discovery.
 *
 * Contract: §3.4 of docs/plans/2026-10-20-cross-machine-swarm-design.md; the decisions it leaves
 * open are in docs/plans/2026-10-28-swarm-list-remote.md.
 *
 * Lists sessions registered to machines OTHER than the caller, so the caller must be identified
 * by a machine credential: a machine named in the URL or the query would be self-asserted, which
 * is what the relay routes refuse. Read-only; it never touches `updated_at`.
 */

import { requireMachinePrincipal, MACHINE_ID_PATTERN } from "./credentials";
import { isMissingTable, relayReachability, SENDER_ID, type RelayReachability } from "./relay";
import { REGISTER_TAKEOVER_STALE_MS } from "./sessions";
import { withD1, StorageError } from "./d1";

export const REMOTE_SESSIONS_DEFAULT_LIMIT = 100;
export const REMOTE_SESSIONS_MAX_LIMIT = 500;

/**
 * Rows idle longer than this are left out. The same horizon after which a row counts as
 * abandoned (another machine may take it over) and the owner's reaper unregisters it, so a
 * listed session is one its owner still holds.
 */
export const REMOTE_SESSIONS_HORIZON_MS = REGISTER_TAKEOVER_STALE_MS;

/** Labels are cut to this many code points. */
export const REMOTE_LABEL_MAX = 120;

/**
 * `sessions` rows are written by any credential holder and `/sessions/register` validates
 * neither field, while this listing lands in agents' context on other machines. A newline
 * would let one machine forge rows (or a relay-status line) in that output, so control
 * characters become spaces. Design §3.2's "receipts, not prose" rule, applied here.
 */
function cleanLabel(label: string | null): string | null {
  if (label === null) return null;
  return [...label.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")].slice(0, REMOTE_LABEL_MAX).join("");
}

interface Row {
  session_id: string;
  machine_id: string;
  label: string | null;
  updated_at: number;
}

export async function handleRemoteSessions(
  db: D1Database,
  env: Env,
  request: Request,
  now: number = Date.now(),
): Promise<Response> {
  const principal = await requireMachinePrincipal(request, env);
  if (principal instanceof Response) return principal;
  const caller = principal.machineId;

  const raw = new URL(request.url).searchParams.get("limit");
  let limit = REMOTE_SESSIONS_DEFAULT_LIMIT;
  if (raw !== null) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return Response.json({ error: "invalid", detail: "limit must be a positive integer" }, { status: 400 });
    }
    limit = Math.min(parsed, REMOTE_SESSIONS_MAX_LIMIT);
  }

  try {
    // Only ids the relay would accept as a target are listed: `gse_` because a goose session
    // cannot be a remote target (design §7), and anything malformed because the relay would
    // answer 400 and because ids are unvalidated free text (see cleanLabel). The same goes for
    // machine ids: the shared key may still register a session as any unretired machine name. The filter is in
    // JS, so the query is not LIMITed; it is bounded by MAX_SESSIONS (~820 rows today).
    const { results } = await withD1(
      "remoteSessions.list",
      db
        .prepare(
          `SELECT session_id, machine_id, label, updated_at FROM sessions
           WHERE machine_id <> ? AND updated_at >= ? AND substr(session_id, 1, 4) = 'ses_'
           ORDER BY updated_at DESC, session_id ASC`,
        )
        .bind(caller, now - REMOTE_SESSIONS_HORIZON_MS)
        .all<Row>(),
    );
    const valid = results.filter((r) => SENDER_ID.test(r.session_id) && MACHINE_ID_PATTERN.test(r.machine_id));
    const truncated = valid.length > limit;
    const sessions = valid.slice(0, limit).map((r) => ({
      session_id: r.session_id,
      machine_id: r.machine_id,
      label: cleanLabel(r.label),
      updated_at: r.updated_at,
    }));

    // What a send from the caller would be told, per machine listed. A snapshot only: the
    // relay route re-checks on every send. A missing relay schema reads as "unknown" rather
    // than failing the listing, which is still useful without it.
    const machineIds = [...new Set(sessions.map((s) => s.machine_id))].sort();
    const machines: Array<{ machine_id: string; relay: RelayReachability | "unknown"; last_poll_at: number | null }> = [];
    for (const id of machineIds) {
      try {
        const reach = await relayReachability(db, env, caller, id, now);
        machines.push({ machine_id: id, relay: reach.relay, last_poll_at: reach.lastPollAt });
      } catch (err) {
        if (!isMissingTable(err)) throw new StorageError("remoteSessions.reachability", err);
        const poll = await db
          .prepare("SELECT last_poll_at FROM machines WHERE machine_id = ?")
          .bind(id)
          .first<{ last_poll_at: number }>()
          .catch(() => null);
        machines.push({ machine_id: id, relay: "unknown", last_poll_at: poll?.last_poll_at ?? null });
      }
    }

    return Response.json({ machine_id: caller, sessions, machines, truncated });
  } catch (err) {
    if (err instanceof StorageError) {
      console.error("[worker] storage error", { op: err.op, error: err.message });
      return Response.json({ error: "storage_error", store: "d1", op: err.op }, { status: 503 });
    }
    throw err;
  }
}
