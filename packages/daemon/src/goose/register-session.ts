import { randomUUID } from "crypto";
import { GOOSE_BACKEND_KIND } from "./backend-kind.js";
import type { SessionRecord, UpsertSessionInput } from "../storage/types.js";

/**
 * Creating pigeon's row for a goose session, in one place.
 *
 * Two callers need this and must not drift: the `/goose/sessions` route (a human
 * registering a session they started themselves) and the `/launch --backend
 * goose` path (the daemon registering one it just minted). The route's own
 * comment asked for this extraction before a second caller existed; this is it.
 *
 * What must not be re-decided per caller:
 *
 *  - **pigeon mints the id, goose does not.** goose names sessions
 *    `YYYYMMDD_N`, a per-machine counter, so every machine produces
 *    `20260920_1` as its first session of a day -- and the worker keys sessions
 *    globally, upserting `machine_id` on conflict and deleting by bare
 *    `session_id` on unregister. Two machines would silently repoint and then
 *    destroy each other's live sessions. See SessionRecord.backendSessionId.
 *  - **`notify` is forced true, not defaulted.** A goose session exists only to
 *    be driven from Telegram, and with notify=false the `/stop` route returns
 *    early, so the human never hears a turn finish -- indistinguishable from a
 *    broken adapter.
 *  - **Registering the same goose session twice reuses one row.** The caller
 *    knows only goose's id, so without the backend-id lookup a re-registration
 *    would mint a second pigeon session for one goose session.
 */

export interface RegisterGooseSessionInput {
  /** The id GOOSE knows the session by, e.g. `20260920_1`. */
  backendSessionId: string;
  endpoint: string;
  cwd?: string | null;
  label?: string | null;
  authToken?: string | null;
}

export interface GooseSessionStore {
  get(sessionId: string): SessionRecord | null;
  getByBackendSessionId(backendSessionId: string): SessionRecord | null;
  upsert(input: UpsertSessionInput, now: number): void;
}

export type RegisterGooseSessionResult =
  | { ok: true; sessionId: string; reused: boolean }
  | { ok: false; conflict: string };

/**
 * @param mintId Injected so tests can pin the id; defaults to a random one.
 */
export function registerGooseSession(
  sessions: GooseSessionStore,
  input: RegisterGooseSessionInput,
  now: number,
  mintId: () => string = () => `gse_${randomUUID()}`,
): RegisterGooseSessionResult {
  // Refuse to convert an existing session of another kind. Historically this
  // mattered because pigeon's id WAS goose's id and the upsert would rewrite
  // backend_kind/endpoint in place, silently repointing a live opencode session
  // at a goose socket. pigeon now mints its own id so that particular hijack is
  // gone -- but a caller passing an opencode session id still means a typo, and
  // answering it with a cheerful new session would hide that.
  const collidesWithOtherKind = sessions.get(input.backendSessionId);
  if (collidesWithOtherKind && collidesWithOtherKind.backendKind !== GOOSE_BACKEND_KIND) {
    return {
      ok: false,
      conflict: `session ${input.backendSessionId} already exists with backend_kind=${collidesWithOtherKind.backendKind ?? "null"}; refusing to convert it`,
    };
  }

  // Idempotence. Two shapes of existing row can match: one registered since
  // pigeon started minting ids (found by backend id) and a legacy one whose
  // pigeon id IS goose's id (found by primary key, with backendKind already
  // goose -- the other-kind case was refused above).
  const existing =
    sessions.getByBackendSessionId(input.backendSessionId) ?? collidesWithOtherKind;
  const sessionId = existing?.sessionId ?? mintId();

  sessions.upsert(
    {
      sessionId,
      cwd: input.cwd ?? null,
      label: input.label ?? null,
      notify: true,
      backendKind: GOOSE_BACKEND_KIND,
      backendProtocolVersion: 1,
      backendEndpoint: input.endpoint,
      backendAuthToken: input.authToken ?? null,
      // Written even when it equals sessionId (the legacy-row case), so a row
      // touched by this function is never ambiguous afterwards.
      backendSessionId: input.backendSessionId,
    },
    now,
  );

  return { ok: true, sessionId, reused: existing !== null && existing !== undefined };
}
