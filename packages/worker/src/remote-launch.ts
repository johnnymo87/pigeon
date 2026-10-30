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
import { SENDER_ID, isMissingTable, relayReachability } from "./relay";
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

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
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
