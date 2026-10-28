import { GOOSE_BACKEND_KIND } from "./backend-kind.js";
import type { SessionRecord, UpsertSessionInput } from "../storage/types.js";
import { gooseSessionId } from "./session-id.js";

export interface EnsureGooseSwarmMailboxInput {
  /** This daemon's machine id, hashed into the pigeon id (see gooseSessionId). */
  machineId: string | null | undefined;
  backendSessionId: string;
  endpoint: string;
  cwd?: string | null;
  label?: string | null;
  authToken?: string | null;
}

export interface GooseSwarmMailboxStore {
  get(sessionId: string): SessionRecord | null;
  getByBackendSessionId(backendSessionId: string): SessionRecord | null;
  upsert(input: UpsertSessionInput, now: number): void;
  setPullSources(sessionId: string, sources: string[] | null, now?: number): boolean;
  touch(sessionId: string, now?: number, ttlMs?: number): boolean;
}

export type EnsureGooseSwarmMailboxResult =
  | {
      ok: true;
      sessionId: string;
      backendSessionId: string;
      created: boolean;
      notify: boolean;
    }
  | {
      ok: false;
      error: string;
      statusCode: 400 | 409;
    };

/**
 * Creates or updates a swarm mailbox for a goose-acp session.
 *
 * Synchronous (no await between lookup and upsert), idempotent.
 *
 * Rules:
 *  - Create-if-absent: with no row, creates a notify: false goose-acp row
 *    with pull_sources ["telegram-reply", "swarm"].
 *  - With an existing row: never downgrades notify or overwrites endpoint, token,
 *    label, or cwd. Adds "swarm" to pull_sources and touches liveness (touch).
 *  - Refuses gse_ in session_id (400), non-goose existing rows (409), and legacy
 *    goose rows where pigeon id == goose id (409).
 *  - A created row gets the derived id (gooseSessionId), the same one
 *    registerGooseSession would mint, so a re-created mailbox finds the mail
 *    banked under it before it was reaped. A row already at that id for another
 *    goose session is refused (409), never overwritten.
 */
export function ensureGooseSwarmMailbox(
  sessions: GooseSwarmMailboxStore,
  input: EnsureGooseSwarmMailboxInput,
  now: number,
  mintId?: () => string,
): EnsureGooseSwarmMailboxResult {
  if (input.backendSessionId.startsWith("gse_")) {
    return {
      ok: false,
      error: `${input.backendSessionId} is a pigeon id (starts with 'gse_'); pass goose's id, not pigeon's`,
      statusCode: 400,
    };
  }

  const atPrimaryKey = sessions.get(input.backendSessionId);
  if (atPrimaryKey && atPrimaryKey.backendKind !== GOOSE_BACKEND_KIND) {
    return {
      ok: false,
      error: `session ${input.backendSessionId} already exists with backend_kind=${atPrimaryKey.backendKind ?? "null"}; refusing to convert it`,
      statusCode: 409,
    };
  }

  if (
    atPrimaryKey &&
    atPrimaryKey.backendSessionId !== null &&
    atPrimaryKey.backendSessionId !== input.backendSessionId
  ) {
    return {
      ok: false,
      error: `${input.backendSessionId} is pigeon's id for a session goose knows as ${atPrimaryKey.backendSessionId}; pass goose's id, not pigeon's`,
      statusCode: 400,
    };
  }

  const byBackend = sessions.getByBackendSessionId(input.backendSessionId);
  if (
    !byBackend &&
    atPrimaryKey &&
    atPrimaryKey.backendKind === GOOSE_BACKEND_KIND &&
    atPrimaryKey.backendSessionId === null
  ) {
    return {
      ok: false,
      error: `goose session ${input.backendSessionId} has a legacy pigeon row (its pigeon id is goose's id); re-register it with POST /goose/sessions (e.g. \`honk telegram ${input.backendSessionId} --force\`) before using swarm`,
      statusCode: 409,
    };
  }

  const existing = byBackend;

  if (existing) {
    const existingPullSources = existing.pullSources ?? ["telegram-reply"];
    const pullSources = existingPullSources.includes("swarm")
      ? existingPullSources
      : [...existingPullSources, "swarm"];
    sessions.setPullSources(existing.sessionId, pullSources, now);
    sessions.touch(existing.sessionId, now);

    return {
      ok: true,
      sessionId: existing.sessionId,
      backendSessionId: existing.backendSessionId ?? input.backendSessionId,
      created: false,
      notify: existing.notify,
    };
  }

  const sessionId = mintId ? mintId() : gooseSessionId(input.machineId, input.backendSessionId);
  const squatter = sessions.get(sessionId);
  if (squatter) {
    return {
      ok: false,
      error: `pigeon id ${sessionId} for goose session ${input.backendSessionId} is already taken by goose session ${squatter.backendSessionId ?? squatter.sessionId}; refusing to overwrite it`,
      statusCode: 409,
    };
  }
  sessions.upsert(
    {
      sessionId,
      cwd: input.cwd ?? null,
      label: input.label ?? null,
      notify: false,
      backendKind: GOOSE_BACKEND_KIND,
      backendProtocolVersion: 1,
      backendEndpoint: input.endpoint,
      backendAuthToken: input.authToken ?? null,
      backendSessionId: input.backendSessionId,
    },
    now,
  );
  sessions.setPullSources(sessionId, ["telegram-reply", "swarm"], now);

  return {
    ok: true,
    sessionId,
    backendSessionId: input.backendSessionId,
    created: true,
    notify: false,
  };
}
