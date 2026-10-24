/**
 * Per-machine worker credentials (pigeon-k0qn.8, spec §6 of
 * docs/plans/2026-10-20-cross-machine-swarm-design.md; plan
 * docs/plans/2026-10-21-per-machine-credentials.md; runbook
 * docs/runbooks/per-machine-credentials.md).
 *
 * Before this, every daemon held one shared `CCR_API_KEY` and the worker took the machine
 * id from the URL or body, so any key holder could act as any machine. Phase 2's relay makes
 * the sending machine decide which sessions may be prompted, so the worker, not the caller,
 * has to establish it. A request now resolves to a PRINCIPAL:
 *
 *   shared   the bearer is the legacy `CCR_API_KEY`. Today's behaviour, unchanged, until it
 *            is retired machine by machine via `SHARED_KEY_REFUSED_MACHINES`.
 *   machine  the bearer is a per-machine key whose SHA-256 is in D1 `machine_credentials`.
 *
 * Only the routes that ASSERT a machine identity (poll, command ack, session register and
 * unregister) check it; the rest accept either principal. Relay routes (`.5`) must use
 * `requireMachinePrincipal`, so `from_machine` can never be asserted with the shared key.
 */

import { unauthorized } from "./auth";

export type Principal = { kind: "shared" } | { kind: "machine"; machineId: string };

/**
 * `pgk_` + base64url of 32 random bytes. Only bearers of exactly this shape reach D1: an
 * unauthenticated caller sending arbitrary garbage must not buy a D1 read per request.
 */
export const MACHINE_KEY_PATTERN = /^pgk_[A-Za-z0-9_-]{43}$/;

/** Machine ids a credential may name. Also what the mint script validates. */
export const MACHINE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * How long a resolved key is trusted without re-reading D1, per isolate. Bounds revocation
 * latency. Hits only: a miss is never cached, so a newly registered key works at once.
 */
export const CREDENTIAL_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  machineId: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test seam: forget every cached credential. */
export function clearCredentialCache(): void {
  cache.clear();
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i]! ^ bufB[i]!;
  }
  return result === 0;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearerOf(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) return null;
  return parts[1];
}

function isMissingTable(err: unknown): boolean {
  return /no such table/i.test(String(err));
}

/** `SHARED_KEY_REFUSED_MACHINES`: CSV of machine ids, or `*` for every request. */
function refusedSet(env: Env): { all: boolean; machines: Set<string> } {
  const raw = (env.SHARED_KEY_REFUSED_MACHINES ?? "").trim();
  const items = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return { all: items.includes("*"), machines: new Set(items.filter((s) => s !== "*")) };
}

/**
 * Is the shared key retired for `machineId`? The relay (pigeon-k0qn.5) refuses to queue for a
 * machine that is not: until it is, a shared-key holder can re-register that machine's
 * sessions to itself and collect what is queued for them.
 */
export function isSharedKeyRetiredFor(env: Env, machineId: string): boolean {
  const refused = refusedSet(env);
  return refused.all || refused.machines.has(machineId);
}

/** The refused set as `,a,b,` for an SQL `instr` membership test (`,,` when empty). */
export function refusedCsvForSql(env: Env): string {
  return `,${[...refusedSet(env).machines].join(",")},`;
}

/**
 * Resolve the request's principal, or null for a 401.
 *
 * A D1 failure other than a missing table THROWS (and becomes a 500): reporting it as a 401
 * would send whoever diagnoses it hunting for a credential problem during a D1 incident, and
 * the daemon's worker-health alarm classifies 4xx and 5xx differently. A missing table reads
 * as "no per-machine keys", so deploying this before the schema is applied changes nothing.
 */
export async function authenticate(
  request: Request,
  env: Env,
  now: number = Date.now(),
): Promise<Principal | null> {
  const bearer = bearerOf(request);
  if (!bearer) return null;

  if (env.CCR_API_KEY && timingSafeEqual(bearer, env.CCR_API_KEY)) {
    return refusedSet(env).all ? null : { kind: "shared" };
  }

  if (!MACHINE_KEY_PATTERN.test(bearer)) return null;

  const hash = await sha256Hex(bearer);
  const hit = cache.get(hash);
  if (hit && hit.expiresAt > now) return { kind: "machine", machineId: hit.machineId };
  cache.delete(hash);

  let row: { machine_id: string } | null;
  try {
    row = await env.DB
      .prepare(
        "SELECT machine_id FROM machine_credentials WHERE key_sha256 = ? AND revoked_at IS NULL",
      )
      .bind(hash)
      .first<{ machine_id: string }>();
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
  if (!row) return null;

  cache.set(hash, { machineId: row.machine_id, expiresAt: now + CREDENTIAL_CACHE_TTL_MS });
  return { kind: "machine", machineId: row.machine_id };
}

export function machineMismatch(principal: string, claimed: string): Response {
  return Response.json(
    {
      error: "machine_mismatch",
      detail: `this credential belongs to ${principal}, not ${claimed}`,
    },
    { status: 403 },
  );
}

/**
 * May `principal` act as `machineId` on a machine-scoped route? Returns null when it may, or
 * the response to send. `machineId` may be null when the route's subject has no recorded
 * owner yet (a brand-new session); only the refused-shared-key check applies then.
 */
export function checkActsAs(
  principal: Principal,
  env: Env,
  ...machineIds: Array<string | null | undefined>
): Response | null {
  const ids = machineIds.filter((m): m is string => typeof m === "string" && m.length > 0);
  if (principal.kind === "shared") {
    const refused = refusedSet(env);
    return ids.some((m) => refused.machines.has(m)) ? unauthorized() : null;
  }
  for (const m of ids) {
    if (m !== principal.machineId) return machineMismatch(principal.machineId, m);
  }
  return null;
}

/**
 * For routes that must never accept the shared key (the Phase 2 relay, `.5`). Returns the
 * machine principal, or the 401 to send.
 */
export async function requireMachinePrincipal(
  request: Request,
  env: Env,
): Promise<{ machineId: string } | Response> {
  const principal = await authenticate(request, env);
  if (!principal) return unauthorized();
  if (principal.kind !== "machine") {
    return Response.json(
      { error: "machine_credential_required" },
      { status: 401 },
    );
  }
  return { machineId: principal.machineId };
}

/** `GET /whoami`: which principal the worker resolves this request's credential to. */
export async function handleWhoami(request: Request, env: Env): Promise<Response> {
  const principal = await authenticate(request, env);
  if (!principal) return unauthorized();
  return Response.json(
    principal.kind === "machine"
      ? { credential: "machine", machine_id: principal.machineId }
      : { credential: "shared", machine_id: null },
  );
}
