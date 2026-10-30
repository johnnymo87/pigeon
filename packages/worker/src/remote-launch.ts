/**
 * Remote launch, worker side (pigeon-k0qn.17).
 *
 * Spec: §2 of docs/plans/2026-10-29-remote-launch-design.md.
 * Plan: docs/plans/2026-10-29-remote-launch-plan.md.
 *
 * An agent on machine A asks machine B to start a fresh headless opencode session.
 * The sending daemon POSTs to `/launch/relay`. The launch waits in `remote_launch`,
 * is handed out to the target machine on poll (`handOutLaunchItems`), and is acked.
 * Every outcome (launched, refused, expired/unconfirmed) produces a result row
 * returned to the requester on its poll, which mints a `launch.result` swarm message
 * to the requesting agent.
 *
 * Every route here requires a per-machine credential, never the shared key, so the
 * worker, not the caller, establishes which machine is speaking.
 */

import {
  isSharedKeyRetiredFor,
  machineMismatch,
  requireMachinePrincipal,
  sha256Hex,
  MACHINE_ID_PATTERN,
} from "./credentials";
import { SENDER_ID, isMissingTable, relayReachability, readJson, parseRelayHeader } from "./relay";
import { isValidTag } from "./tag-command";

export const LAUNCH_TTL_MS = 15 * 60_000;
export const LAUNCH_LEASE_MS = 60_000;
export const LAUNCH_MAX_LEASES = 3;
export const LAUNCH_HANDOUT_LIMIT = 1;
export const LAUNCH_RESULT_HANDOUT_LIMIT = 20;
export const LAUNCH_RESULT_TTL_MS = 24 * 3600_000;
export const LAUNCH_RESULT_MAX_LEASES = 5;
export const LAUNCH_QUEUE_CAP = 10;
export const LAUNCH_RATE_PER_HOUR = 30;
export const LAUNCH_RETENTION_MS = 7 * 24 * 3600_000;
export const LAUNCH_MAX_PROMPT = 16_000;
export const LAUNCH_MAX_DIRECTORY = 512;
export const LAUNCH_ONLINE_MS = 60_000;

const LAUNCH_ID_PATTERN = /^[^:\s]{1,128}$/;
const REASON = /^[a-z0-9_]{1,64}$/;
const RESULT_ID_PATTERN = /^r:[^:\s]{1,128}(:[a-z0-9_]{1,64})?$/;

export interface LaunchRequest {
  launch_id: string;
  from: string;
  machine: string;
  directory: string;
  prompt: string;
  tag: string | null;
}

export interface RemoteLaunchRow {
  from_machine: string;
  launch_id: string;
  item_kind: "launch" | "result";
  to_machine: string;
  from_session: string;
  body_json: string;
  body_sha256: string;
  status: string;
  session_id: string | null;
  reason: string | null;
  lease_count: number;
  created_at: number;
  leased_at: number | null;
  expires_at: number;
  settled_at: number | null;
}

function unavailable(): Response {
  return Response.json({ error: "launch_unavailable" }, { status: 503 });
}

function bad(detail: string): Response {
  return Response.json({ error: "invalid", detail }, { status: 400 });
}

async function tolerant(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (isMissingTable(err)) return unavailable();
    throw err;
  }
}

export function validateLaunchBody(body: Record<string, unknown>): LaunchRequest | Response {
  const { launch_id, from, machine, directory, prompt, tag } = body;
  if (typeof launch_id !== "string" || !LAUNCH_ID_PATTERN.test(launch_id)) {
    return bad("launch_id must be 1-128 characters with no ':' or whitespace");
  }
  if (typeof from !== "string" || !SENDER_ID.test(from)) {
    return bad("from must be a ses_ session id");
  }
  if (typeof machine !== "string" || !MACHINE_ID_PATTERN.test(machine)) {
    return bad("machine must be a valid machine id");
  }
  if (
    typeof directory !== "string" ||
    directory.length === 0 ||
    directory.length > LAUNCH_MAX_DIRECTORY ||
    /[\x00-\x1f\x7f]/.test(directory)
  ) {
    return bad("directory must be 1-512 characters with no control characters");
  }
  if (
    typeof prompt !== "string" ||
    [...prompt].length === 0 ||
    [...prompt].length > LAUNCH_MAX_PROMPT
  ) {
    return bad("prompt must be 1-16000 code points");
  }
  if (tag !== undefined && tag !== null && (typeof tag !== "string" || !isValidTag(tag))) {
    return bad("tag must be null or a valid tag");
  }

  return {
    launch_id,
    from,
    machine,
    directory,
    prompt,
    tag: typeof tag === "string" ? tag : null,
  };
}

export async function launchHash(req: LaunchRequest): Promise<string> {
  return sha256Hex(JSON.stringify([req.machine, req.from, req.directory, req.prompt, req.tag]));
}

async function getLaunchRow(
  db: D1Database,
  fromMachine: string,
  launchId: string,
): Promise<RemoteLaunchRow | null> {
  return db
    .prepare("SELECT * FROM remote_launch WHERE from_machine = ? AND launch_id = ?")
    .bind(fromMachine, launchId)
    .first<RemoteLaunchRow>();
}

function duplicateOrConflict(existing: RemoteLaunchRow, hash: string): Response {
  if (existing.item_kind === "launch" && existing.body_sha256 === hash) {
    return Response.json(
      { accepted: true, duplicate: true, launch_id: existing.launch_id, to_machine: existing.to_machine },
      { status: 202 },
    );
  }
  return Response.json(
    { error: "launch_id_conflict", detail: "that launch_id is already used with different parameters" },
    { status: 409 },
  );
}

/** `POST /launch/relay`. Checks in load-bearing order. */
export async function handleLaunchRelay(
  db: D1Database,
  env: Env,
  request: Request,
  now: number = Date.now(),
): Promise<Response> {
  // 1. Principal check: machine key only
  const principal = await requireMachinePrincipal(request, env);
  if (principal instanceof Response) return principal;
  const fromMachine = principal.machineId;

  // 2. Body validation
  const raw = await readJson(request);
  if (!raw) return bad("body must be a JSON object");
  if (raw.from_machine !== undefined && raw.from_machine !== fromMachine) {
    return machineMismatch(fromMachine, String(raw.from_machine));
  }
  const req = validateLaunchBody(raw);
  if (req instanceof Response) return req;

  return tolerant(async () => {
    const hash = await launchHash(req);

    // 3. Duplicate check (before offline / other checks, so retries succeed even if target went down)
    const existing = await getLaunchRow(db, fromMachine, req.launch_id);
    if (existing) return duplicateOrConflict(existing, hash);

    // 4. Sender registration check: unregistered passes; registered to another machine fails
    const sender = await db
      .prepare("SELECT machine_id FROM sessions WHERE session_id = ?")
      .bind(req.from)
      .first<{ machine_id: string }>();
    if (sender && sender.machine_id !== fromMachine) {
      return Response.json(
        {
          error: "sender_not_yours",
          detail: `${req.from} is registered to ${sender.machine_id}, not ${fromMachine}`,
        },
        { status: 403 },
      );
    }

    // 5. machine = caller
    if (req.machine === fromMachine) {
      return Response.json(
        {
          error: "same_machine",
          detail: "cannot launch on the calling machine; use opencode-launch locally",
        },
        { status: 409 },
      );
    }

    // 6. Target retired from shared key
    if (!isSharedKeyRetiredFor(env, req.machine)) {
      return Response.json(
        {
          error: "receiver_not_retired",
          detail: `${req.machine} still accepts the shared worker key, so it cannot receive remote launches`,
        },
        { status: 403 },
      );
    }

    // 7. Target's machine_launch_accept lacks caller
    const accept = await db
      .prepare("SELECT accept_csv FROM machine_launch_accept WHERE machine_id = ?")
      .bind(req.machine)
      .first<{ accept_csv: string }>();
    if (!accept || !accept.accept_csv.split(",").includes(fromMachine)) {
      return Response.json(
        {
          error: "not_accepted",
          detail: `${req.machine} does not accept remote launches from ${fromMachine}`,
        },
        { status: 403 },
      );
    }

    // 8. Target offline (machines.last_poll_at null or older than LAUNCH_ONLINE_MS)
    const machine = await db
      .prepare("SELECT last_poll_at FROM machines WHERE machine_id = ?")
      .bind(req.machine)
      .first<{ last_poll_at: number | null }>();
    if (!machine || machine.last_poll_at === null || now - machine.last_poll_at > LAUNCH_ONLINE_MS) {
      return Response.json(
        { error: "target_offline", detail: `${req.machine} is not polling` },
        { status: 503 },
      );
    }

    // 9. Return path check (target B relays to caller A)
    const reach = await relayReachability(db, env, req.machine, fromMachine, now);
    if (reach.relay !== "available") {
      return Response.json(
        {
          error: "no_return_path",
          detail: `remote launch requires a working swarm relay from ${req.machine} to ${fromMachine}`,
        },
        { status: 409 },
      );
    }

    // 10. Queue cap (>= 10 queued/leased launches for target)
    const queued = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM remote_launch WHERE to_machine = ? AND item_kind = 'launch' AND status IN ('queued', 'leased')",
      )
      .bind(req.machine)
      .first<{ n: number }>();
    if ((queued?.n ?? 0) >= LAUNCH_QUEUE_CAP) {
      return Response.json(
        {
          error: "queue_full",
          detail: `${LAUNCH_QUEUE_CAP} launches already wait for ${req.machine}`,
        },
        { status: 429 },
      );
    }

    // 11. Rate limit (>= 30 launches created by caller in the last hour)
    const rate = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM remote_launch WHERE from_machine = ? AND item_kind = 'launch' AND created_at >= ?",
      )
      .bind(fromMachine, now - 3600_000)
      .first<{ n: number }>();
    if ((rate?.n ?? 0) >= LAUNCH_RATE_PER_HOUR) {
      return Response.json(
        {
          error: "rate_limited",
          detail: `caller has created ${LAUNCH_RATE_PER_HOUR} launches in the last hour`,
        },
        { status: 429 },
      );
    }

    // 12. Insert launch row
    const expiresAt = now + LAUNCH_TTL_MS;
    const bodyJson = JSON.stringify({
      from: req.from,
      directory: req.directory,
      prompt: req.prompt,
      tag: req.tag,
    });

    const result = await db
      .prepare(
        `INSERT INTO remote_launch (from_machine, launch_id, item_kind, to_machine, from_session,
                                    body_json, body_sha256, status, lease_count, created_at, expires_at)
         VALUES (?, ?, 'launch', ?, ?, ?, ?, 'queued', 0, ?, ?)
         ON CONFLICT (from_machine, launch_id) DO NOTHING`,
      )
      .bind(fromMachine, req.launch_id, req.machine, req.from, bodyJson, hash, now, expiresAt)
      .run();

    if (!result.meta.changes) {
      // Concurrent insert won
      const raced = await getLaunchRow(db, fromMachine, req.launch_id);
      if (raced) return duplicateOrConflict(raced, hash);
    }

    return Response.json(
      { accepted: true, launch_id: req.launch_id, to_machine: req.machine },
      { status: 202 },
    );
  });
}

export type LaunchHandOut =
  | {
      item: "launch";
      from_machine: string;
      launch_id: string;
      from: string;
      directory: string;
      prompt: string;
      tag: string | null;
      expires_at: number;
    }
  | {
      item: "launch_result";
      from_machine: string;
      result_id: string;
      launch_id: string;
      machine: string;
      outcome: "launched" | "refused" | "unconfirmed";
      session_id: string | null;
      reason: string | null;
    };

/**
 * Expire overdue launch rows (minting refusal/unconfirmed results) and result rows,
 * and prune rows past retention on unscoped runs.
 *
 * Scoped to machine on the poll path; unscoped on the hourly cron.
 */
export async function runLaunchExpiry(
  db: D1Database,
  now: number = Date.now(),
  opts: { machine?: string; limit?: number } = {},
): Promise<{ expired: number; pruned: number }> {
  try {
    const limit = opts.limit ?? 500;

    // 1. Launch rows
    let launchRows: RemoteLaunchRow[];
    if (opts.machine) {
      ({ results: launchRows } = await db
        .prepare(
          `SELECT * FROM remote_launch
           WHERE item_kind = 'launch'
             AND (from_machine = ? OR to_machine = ?)
             AND status IN ('queued', 'leased')
             AND (expires_at <= ? OR (status = 'leased' AND lease_count >= ? AND leased_at < ?))
           LIMIT ?`,
        )
        .bind(opts.machine, opts.machine, now, LAUNCH_MAX_LEASES, now - LAUNCH_LEASE_MS, limit)
        .all<RemoteLaunchRow>());
    } else {
      ({ results: launchRows } = await db
        .prepare(
          `SELECT * FROM remote_launch
           WHERE item_kind = 'launch'
             AND status IN ('queued', 'leased')
             AND (expires_at <= ? OR (status = 'leased' AND lease_count >= ? AND leased_at < ?))
           LIMIT ?`,
        )
        .bind(now, LAUNCH_MAX_LEASES, now - LAUNCH_LEASE_MS, limit)
        .all<RemoteLaunchRow>());
    }

    let expired = 0;
    for (const row of launchRows) {
      const outcome = row.status === "queued" ? "refused" : "unconfirmed";
      const reason = row.status === "queued" ? "never_collected" : "unconfirmed";
      const insertStmt = resultInsert(
        db,
        row,
        outcome,
        null,
        reason,
        `r:${row.launch_id}`,
        now,
        [row.status],
      );
      const settleStmt = db
        .prepare(
          `UPDATE remote_launch SET status = 'expired', reason = ?, settled_at = ?
           WHERE from_machine = ? AND launch_id = ? AND status = ?`,
        )
        .bind(reason, now, row.from_machine, row.launch_id, row.status);

      const batchRes = await db.batch([insertStmt, settleStmt]);
      if ((batchRes[1]?.meta.changes ?? 0) > 0) {
        expired++;
      }
    }

    // 2. Result rows
    let resultRows: RemoteLaunchRow[];
    if (opts.machine) {
      ({ results: resultRows } = await db
        .prepare(
          `SELECT * FROM remote_launch
           WHERE item_kind = 'result'
             AND to_machine = ?
             AND status IN ('queued', 'leased')
             AND (expires_at <= ? OR (status = 'leased' AND lease_count >= ? AND leased_at < ?))
           LIMIT ?`,
        )
        .bind(opts.machine, now, LAUNCH_RESULT_MAX_LEASES, now - LAUNCH_LEASE_MS, limit)
        .all<RemoteLaunchRow>());
    } else {
      ({ results: resultRows } = await db
        .prepare(
          `SELECT * FROM remote_launch
           WHERE item_kind = 'result'
             AND status IN ('queued', 'leased')
             AND (expires_at <= ? OR (status = 'leased' AND lease_count >= ? AND leased_at < ?))
           LIMIT ?`,
        )
        .bind(now, LAUNCH_RESULT_MAX_LEASES, now - LAUNCH_LEASE_MS, limit)
        .all<RemoteLaunchRow>());
    }

    for (const row of resultRows) {
      const reason = row.status === "queued" ? "never_collected" : "unconfirmed";
      const settle = await db
        .prepare(
          `UPDATE remote_launch SET status = 'expired', reason = ?, settled_at = ?
           WHERE from_machine = ? AND launch_id = ? AND status = ?`,
        )
        .bind(reason, now, row.from_machine, row.launch_id, row.status)
        .run();
      if ((settle.meta.changes ?? 0) > 0) {
        console.error("[remote-launch] result item expired uncollected; dropped", {
          toMachine: row.to_machine,
          resultId: row.launch_id,
        });
        expired++;
      }
    }

    // 3. Retention (unscoped only)
    let pruned = 0;
    if (!opts.machine) {
      const pruneRes = await db
        .prepare(
          "DELETE FROM remote_launch WHERE status NOT IN ('queued', 'leased') AND created_at < ?",
        )
        .bind(now - LAUNCH_RETENTION_MS)
        .run();
      pruned = pruneRes.meta.changes ?? 0;
    }

    return { expired, pruned };
  } catch (err) {
    if (isMissingTable(err)) return { expired: 0, pruned: 0 };
    throw err;
  }
}

/**
 * Leases at most LAUNCH_HANDOUT_LIMIT launch items and (if failures=1) up to
 * LAUNCH_RESULT_HANDOUT_LIMIT result items for the polling machine.
 * Never throws.
 */
export async function handOutLaunchItems(
  db: D1Database,
  machineId: string,
  headerValue: string | null,
  now: number = Date.now(),
): Promise<LaunchHandOut[]> {
  try {
    const header = parseRelayHeader(headerValue);
    if (header === null) {
      await db
        .prepare("UPDATE machine_launch_accept SET accept_csv = '', updated_at = ? WHERE machine_id = ? AND accept_csv <> ''")
        .bind(now, machineId)
        .run();
      return [];
    }
    const csv = header.launch.join(",");
    await db
      .prepare(
        `INSERT INTO machine_launch_accept (machine_id, accept_csv, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (machine_id) DO UPDATE SET accept_csv = excluded.accept_csv, updated_at = excluded.updated_at
         WHERE machine_launch_accept.accept_csv IS NOT excluded.accept_csv`,
      )
      .bind(machineId, csv, now)
      .run();

    await runLaunchExpiry(db, now, { machine: machineId, limit: 20 });

    const launchItems: LaunchHandOut[] = [];
    if (header.launch.length > 0) {
      const placeholders = header.launch.map(() => "?").join(",");
      const { results: launchRows } = await db
        .prepare(
          `UPDATE remote_launch SET status = 'leased', leased_at = ?, lease_count = lease_count + 1
           WHERE rowid IN (
             SELECT rowid FROM remote_launch
             WHERE to_machine = ?
               AND item_kind = 'launch'
               AND from_machine IN (${placeholders})
               AND (status = 'queued' OR (status = 'leased' AND leased_at < ?))
               AND lease_count < ?
               AND expires_at - ? >= ?
             ORDER BY created_at ASC
             LIMIT ?
           )
           AND (status = 'queued' OR (status = 'leased' AND leased_at < ?))
           RETURNING from_machine, launch_id, item_kind, body_json, created_at, expires_at`,
        )
        .bind(
          now,
          machineId,
          ...header.launch,
          now - LAUNCH_LEASE_MS,
          LAUNCH_MAX_LEASES,
          now,
          LAUNCH_LEASE_MS,
          LAUNCH_HANDOUT_LIMIT,
          now - LAUNCH_LEASE_MS,
        )
        .all<{ from_machine: string; launch_id: string; item_kind: string; body_json: string; created_at: number; expires_at: number }>();

      const sortedLaunches = [...launchRows].sort((a, b) => a.created_at - b.created_at || a.launch_id.localeCompare(b.launch_id));
      for (const r of sortedLaunches) {
        try {
          const body = JSON.parse(r.body_json) as {
            from: string;
            directory: string;
            prompt: string;
            tag: string | null;
          };
          launchItems.push({
            item: "launch",
            from_machine: r.from_machine,
            launch_id: r.launch_id,
            from: body.from,
            directory: body.directory,
            prompt: body.prompt,
            tag: body.tag ?? null,
            expires_at: r.expires_at,
          });
        } catch (err) {
          console.error("[remote-launch] corrupt launch row body_json; skipping", {
            fromMachine: r.from_machine,
            launchId: r.launch_id,
            error: String(err),
          });
        }
      }
    }

    const resultItems: LaunchHandOut[] = [];
    if (header.failures) {
      const { results: resultRows } = await db
        .prepare(
          `UPDATE remote_launch SET status = 'leased', leased_at = ?, lease_count = lease_count + 1
           WHERE rowid IN (
             SELECT rowid FROM remote_launch
             WHERE to_machine = ?
               AND item_kind = 'result'
               AND (status = 'queued' OR (status = 'leased' AND leased_at < ?))
               AND lease_count < ?
               AND expires_at > ?
             ORDER BY created_at ASC
             LIMIT ?
           )
           AND (status = 'queued' OR (status = 'leased' AND leased_at < ?))
           RETURNING from_machine, launch_id, item_kind, body_json, created_at, expires_at`,
        )
        .bind(
          now,
          machineId,
          now - LAUNCH_LEASE_MS,
          LAUNCH_RESULT_MAX_LEASES,
          now,
          LAUNCH_RESULT_HANDOUT_LIMIT,
          now - LAUNCH_LEASE_MS,
        )
        .all<{ from_machine: string; launch_id: string; item_kind: string; body_json: string; created_at: number; expires_at: number }>();

      const sortedResults = [...resultRows].sort((a, b) => a.created_at - b.created_at || a.launch_id.localeCompare(b.launch_id));
      for (const r of sortedResults) {
        try {
          const body = JSON.parse(r.body_json) as {
            launch_id: string;
            machine: string;
            outcome: "launched" | "refused" | "unconfirmed";
            session_id: string | null;
            reason: string | null;
          };
          resultItems.push({
            item: "launch_result",
            from_machine: r.from_machine,
            result_id: r.launch_id,
            launch_id: body.launch_id,
            machine: body.machine,
            outcome: body.outcome,
            session_id: body.session_id ?? null,
            reason: body.reason ?? null,
          });
        } catch (err) {
          console.error("[remote-launch] corrupt result row body_json; skipping", {
            fromMachine: r.from_machine,
            resultId: r.launch_id,
            error: String(err),
          });
        }
      }
    }

    return [...launchItems, ...resultItems];
  } catch (err) {
    if (!isMissingTable(err)) {
      console.error("[remote-launch] hand-out failed; poll continues without launch items", { machineId, error: String(err) });
    }
    return [];
  }
}

function resultInsert(
  db: D1Database,
  row: RemoteLaunchRow,
  outcome: "launched" | "refused" | "unconfirmed",
  sessionId: string | null,
  reason: string | null,
  key: string,
  now: number,
  guardStatuses: string[],
): D1PreparedStatement {
  const body = {
    launch_id: row.launch_id,
    machine: row.to_machine,
    outcome,
    session_id: sessionId,
    reason,
  };
  const placeholders = guardStatuses.map(() => "?").join(",");
  return db
    .prepare(
      `INSERT INTO remote_launch (from_machine, launch_id, item_kind, to_machine, from_session,
                                  body_json, body_sha256, status, lease_count, created_at, expires_at)
       SELECT ?, ?, 'result', ?, ?, ?, '', 'queued', 0, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM remote_launch
         WHERE from_machine = ? AND launch_id = ? AND item_kind = 'launch'
           AND status IN (${placeholders})
       )
       ON CONFLICT (from_machine, launch_id) DO NOTHING`,
    )
    .bind(
      row.from_machine,
      key,
      row.from_machine,
      row.from_session,
      JSON.stringify(body),
      now,
      now + LAUNCH_RESULT_TTL_MS,
      row.from_machine,
      row.launch_id,
      ...guardStatuses,
    );
}

function correctionBatch(
  db: D1Database,
  row: RemoteLaunchRow,
  outcome: "launched" | "refused" | "unconfirmed",
  sessionId: string | null,
  reason: string | null,
  now: number,
  principalMachineId: string,
): D1PreparedStatement[] {
  const newBody = JSON.stringify({
    launch_id: row.launch_id,
    machine: row.to_machine,
    outcome,
    session_id: sessionId,
    reason: reason ?? (outcome === "unconfirmed" ? "unconfirmed" : null),
  });

  let stmt1: D1PreparedStatement;
  let correctedStateClause: string;
  let correctedStateParams: unknown[];

  if (outcome === "launched") {
    stmt1 = db
      .prepare(
        `UPDATE remote_launch SET status = 'launched', session_id = ?, reason = NULL, settled_at = ?
         WHERE from_machine = ? AND launch_id = ? AND to_machine = ? AND status = 'expired'`,
      )
      .bind(sessionId!, now, row.from_machine, row.launch_id, principalMachineId);
    correctedStateClause = "status = 'launched' AND session_id = ? AND reason IS NULL";
    correctedStateParams = [sessionId!];
  } else if (outcome === "refused") {
    stmt1 = db
      .prepare(
        `UPDATE remote_launch SET status = 'refused', session_id = NULL, reason = ?, settled_at = ?
         WHERE from_machine = ? AND launch_id = ? AND to_machine = ? AND status = 'expired'`,
      )
      .bind(reason!, now, row.from_machine, row.launch_id, principalMachineId);
    correctedStateClause = "status = 'refused' AND session_id IS NULL AND reason = ?";
    correctedStateParams = [reason!];
  } else {
    // unconfirmed with sessionId
    stmt1 = db
      .prepare(
        `UPDATE remote_launch SET session_id = ?, reason = 'unconfirmed', settled_at = ?
         WHERE from_machine = ? AND launch_id = ? AND to_machine = ? AND status = 'expired' AND session_id IS NULL`,
      )
      .bind(sessionId!, now, row.from_machine, row.launch_id, principalMachineId);
    correctedStateClause = "status = 'expired' AND reason = 'unconfirmed' AND session_id = ?";
    correctedStateParams = [sessionId!];
  }

  const stmt2 = db
    .prepare(
      `UPDATE remote_launch SET body_json = ?
       WHERE from_machine = ? AND launch_id = ? AND status = 'queued'
         AND EXISTS (
           SELECT 1 FROM remote_launch
           WHERE from_machine = ? AND launch_id = ? AND item_kind = 'launch' AND ${correctedStateClause}
         )`,
    )
    .bind(
      newBody,
      row.from_machine,
      `r:${row.launch_id}`,
      row.from_machine,
      row.launch_id,
      ...correctedStateParams,
    );

  const stmt3 = db
    .prepare(
      `INSERT INTO remote_launch (from_machine, launch_id, item_kind, to_machine, from_session,
                                  body_json, body_sha256, status, lease_count, created_at, expires_at)
       SELECT ?, ?, 'result', ?, ?, ?, '', 'queued', 0, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM remote_launch
         WHERE from_machine = ? AND launch_id = ? AND item_kind = 'launch' AND ${correctedStateClause}
       )
       AND NOT EXISTS (
         SELECT 1 FROM remote_launch
         WHERE from_machine = ? AND launch_id = ? AND body_json = ?
       )
       ON CONFLICT (from_machine, launch_id) DO NOTHING`,
    )
    .bind(
      row.from_machine,
      `r:${row.launch_id}:${outcome}`,
      row.from_machine,
      row.from_session,
      newBody,
      now,
      now + LAUNCH_RESULT_TTL_MS,
      row.from_machine,
      row.launch_id,
      ...correctedStateParams,
      row.from_machine,
      `r:${row.launch_id}`,
      newBody,
    );

  return [stmt1, stmt2, stmt3];
}

export type LaunchAckItem =
  | {
      kind: "launch";
      from_machine: string;
      launch_id: string;
      outcome: "launched" | "refused" | "unconfirmed";
      session_id?: string;
      reason?: string;
    }
  | {
      kind: "result";
      from_machine: string;
      result_id: string;
      outcome: "delivered" | "refused";
      reason?: string;
    };

export type ProcessAckResult =
  | { kind: "launch"; from_machine: string; launch_id: string; result: "ok" | "not_found" | "not_yours" }
  | { kind: "result"; from_machine: string; result_id: string; result: "ok" | "not_found" | "not_yours" };

export async function processLaunchAckItem(
  db: D1Database,
  principalMachineId: string,
  it: LaunchAckItem,
  now: number,
  rowOverride?: RemoteLaunchRow,
): Promise<ProcessAckResult> {
  if (it.kind === "result") {
    const row = rowOverride ?? (await getLaunchRow(db, it.from_machine, it.result_id));
    if (!row || row.item_kind !== "result") {
      return { kind: "result", from_machine: it.from_machine, result_id: it.result_id, result: "not_found" };
    }
    if (row.to_machine !== principalMachineId) {
      return { kind: "result", from_machine: it.from_machine, result_id: it.result_id, result: "not_yours" };
    }

    await db
      .prepare(
        `UPDATE remote_launch SET status = ?, reason = ?, settled_at = ?
         WHERE from_machine = ? AND launch_id = ? AND to_machine = ? AND status IN ('queued','leased')`,
      )
      .bind(it.outcome, it.reason ?? null, now, row.from_machine, row.launch_id, principalMachineId)
      .run();

    if (it.outcome === "refused") {
      console.error("[remote-launch] result item refused by its receiver; dropped", {
        fromMachine: row.from_machine,
        resultId: row.launch_id,
        reason: it.reason,
      });
    }
    return { kind: "result", from_machine: it.from_machine, result_id: it.result_id, result: "ok" };
  }

  // it.kind === "launch"
  const row = rowOverride ?? (await getLaunchRow(db, it.from_machine, it.launch_id));
  if (!row || row.item_kind !== "launch") {
    return { kind: "launch", from_machine: it.from_machine, launch_id: it.launch_id, result: "not_found" };
  }
  if (row.to_machine !== principalMachineId) {
    return { kind: "launch", from_machine: it.from_machine, launch_id: it.launch_id, result: "not_yours" };
  }

  if (row.status === "queued" || row.status === "leased") {
    let settleStatus: string;
    let sessionId: string | null = null;
    let reason: string | null = null;
    if (it.outcome === "launched") {
      settleStatus = "launched";
      sessionId = it.session_id!;
    } else if (it.outcome === "refused") {
      settleStatus = "refused";
      reason = it.reason!;
    } else {
      settleStatus = "expired";
      reason = "unconfirmed";
      sessionId = it.session_id ?? null;
    }

    const insertStmt = resultInsert(
      db,
      row,
      it.outcome,
      it.session_id ?? null,
      it.reason ?? (it.outcome === "unconfirmed" ? "unconfirmed" : null),
      `r:${row.launch_id}`,
      now,
      ["queued", "leased"],
    );
    const settleStmt = db
      .prepare(
        `UPDATE remote_launch SET status = ?, session_id = ?, reason = ?, settled_at = ?
         WHERE from_machine = ? AND launch_id = ? AND to_machine = ? AND status IN ('queued','leased')`,
      )
      .bind(settleStatus, sessionId, reason, now, row.from_machine, row.launch_id, principalMachineId);

    const batchRes = await db.batch([insertStmt, settleStmt]);
    const settleResult = batchRes[1];
    if ((settleResult?.meta.changes ?? 0) === 0) {
      // Race: between getLaunchRow and db.batch, the row was settled (e.g. expired).
      const freshRow = await getLaunchRow(db, it.from_machine, it.launch_id);
      if (freshRow && freshRow.status === "expired") {
        const isAllowed =
          it.outcome === "launched" ||
          it.outcome === "refused" ||
          (it.outcome === "unconfirmed" && Boolean(it.session_id) && freshRow.session_id === null);
        if (isAllowed) {
          await db.batch(
            correctionBatch(
              db,
              freshRow,
              it.outcome,
              it.session_id ?? null,
              it.reason ?? null,
              now,
              principalMachineId,
            ),
          );
        }
      }
    }
  } else if (row.status === "expired") {
    // CORRECTION
    const isAllowed =
      it.outcome === "launched" ||
      it.outcome === "refused" ||
      (it.outcome === "unconfirmed" && Boolean(it.session_id) && row.session_id === null);

    if (isAllowed) {
      await db.batch(
        correctionBatch(
          db,
          row,
          it.outcome,
          it.session_id ?? null,
          it.reason ?? null,
          now,
          principalMachineId,
        ),
      );
    }
  }
  // status launched/refused -> no-op (never reverse)

  return { kind: "launch", from_machine: it.from_machine, launch_id: it.launch_id, result: "ok" };
}

/**
 * `POST /launch/relay/ack`: machine key only.
 * Settle launch or result rows.
 */
export async function handleLaunchRelayAck(
  db: D1Database,
  env: Env,
  request: Request,
  now: number = Date.now(),
): Promise<Response> {
  const principal = await requireMachinePrincipal(request, env);
  if (principal instanceof Response) return principal;

  const raw = await readJson(request);
  const items = raw?.items;
  if (!Array.isArray(items) || items.length === 0) return bad("items must be a non-empty array");
  if (items.length > 100) return bad("at most 100 items per ack");

  const parsed: LaunchAckItem[] = [];
  for (const it of items as unknown[]) {
    const o = it as Record<string, unknown> | null;
    if (!o || typeof o !== "object") return bad("each item must be an object");
    if (typeof o.from_machine !== "string" || !MACHINE_ID_PATTERN.test(o.from_machine)) {
      return bad("from_machine is invalid");
    }
    if (o.kind === "launch") {
      if (typeof o.launch_id !== "string" || !LAUNCH_ID_PATTERN.test(o.launch_id)) {
        return bad("launch_id is invalid");
      }
      if (o.outcome !== "launched" && o.outcome !== "refused" && o.outcome !== "unconfirmed") {
        return bad("outcome must be launched, refused, or unconfirmed");
      }
      if (o.outcome === "launched") {
        if (typeof o.session_id !== "string" || !SENDER_ID.test(o.session_id)) {
          return bad("launched requires a valid ses_ session_id");
        }
      } else if (o.outcome === "unconfirmed") {
        if (
          o.session_id !== undefined &&
          o.session_id !== null &&
          (typeof o.session_id !== "string" || !SENDER_ID.test(o.session_id))
        ) {
          return bad("session_id must be a valid ses_ session id if present");
        }
      } else if (o.outcome === "refused") {
        if (typeof o.reason !== "string" || !REASON.test(o.reason)) {
          return bad("a refusal needs a reason code ([a-z0-9_]{1,64})");
        }
      }
      parsed.push({
        kind: "launch",
        from_machine: o.from_machine,
        launch_id: o.launch_id,
        outcome: o.outcome,
        session_id: o.session_id as string | undefined,
        reason: o.reason as string | undefined,
      });
    } else if (o.kind === "result") {
      if (typeof o.result_id !== "string" || !RESULT_ID_PATTERN.test(o.result_id)) {
        return bad("result_id is invalid");
      }
      if (o.outcome !== "delivered" && o.outcome !== "refused") {
        return bad("outcome must be delivered or refused");
      }
      if (
        o.reason !== undefined &&
        o.reason !== null &&
        (typeof o.reason !== "string" || !REASON.test(o.reason))
      ) {
        return bad("reason must be a code ([a-z0-9_]{1,64})");
      }
      parsed.push({
        kind: "result",
        from_machine: o.from_machine,
        result_id: o.result_id,
        outcome: o.outcome,
        reason: o.reason as string | undefined,
      });
    } else {
      return bad("kind must be launch or result");
    }
  }

  return tolerant(async () => {
    const results: ProcessAckResult[] = [];
    for (const it of parsed) {
      results.push(await processLaunchAckItem(db, principal.machineId, it, now));
    }
    return Response.json({ ok: true, results });
  });
}
