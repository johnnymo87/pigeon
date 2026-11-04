import { GOOSE_BACKEND_KIND } from "./goose/backend-kind";
import { backendSessionIdOf, type SessionRecord } from "./storage/types";
import { isValidTag } from "./worker/tag-ingest";

/**
 * The id session-tags knows a pigeon session by.
 *
 * - An opencode session: its own `ses_…` id.
 * - A goose session: `goose:<native goose id>`, the key goose spend is ledgered
 *   under. Pigeon's `gse_…` id means nothing to session-tags, which since
 *   workstation#779 refuses `gse_…` and `goose:gse_…` on `set` outright (and
 *   answers `auto:` for them on `which`). The native id is known only through
 *   this daemon's `sessions.backend_session_id`; NULL there means a legacy row
 *   whose pigeon id IS goose's id. Nobody computes the uuidv5 in reverse.
 *
 * Membership is per machine (tags.db and backend_session_id are both local), so
 * a `gse_…` id with no local goose row is refused, not guessed at.
 */

export type TagKeySession = Pick<SessionRecord, "sessionId" | "backendKind" | "backendSessionId"> & {
  boundTopicKey?: string | null;
};

export interface TagKeySessionLookup {
  get(sessionId: string): TagKeySession | null;
}

export type TagKeyResult = { ok: true; key: string } | { ok: false; reason: string };

const OPENCODE_ID_RE = /^ses_[A-Za-z0-9_-]+$/;
/** argv-safe: no leading `-`, so session-tags' argparse cannot read it as an option. */
const NATIVE_GOOSE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The session's local row, or null. A lookup failure is "no row", never a throw. */
export function lookupSession(sessionId: string, sessions: TagKeySessionLookup | undefined): TagKeySession | null {
  if (!sessions) return null;
  try {
    return sessions.get(sessionId);
  } catch (err) {
    console.warn(`[tag-key] session lookup failed for ${sessionId}:`, err);
    return null;
  }
}

export function tagKeyFor(sessionId: string, sessions: TagKeySessionLookup | undefined): TagKeyResult {
  if (typeof sessionId !== "string" || sessionId === "") {
    return { ok: false, reason: "invalid session id" };
  }
  const row = lookupSession(sessionId, sessions);
  if (row && row.backendKind === GOOSE_BACKEND_KIND) {
    const native = backendSessionIdOf(row);
    if (native.startsWith("gse_") || !NATIVE_GOOSE_ID_RE.test(native)) {
      return { ok: false, reason: `goose session ${sessionId} has no goose id on record` };
    }
    return { ok: true, key: `goose:${native}` };
  }
  if (OPENCODE_ID_RE.test(sessionId)) return { ok: true, key: sessionId };
  if (sessionId.startsWith("gse_")) {
    return { ok: false, reason: `${sessionId} is not a goose session on this machine` };
  }
  return { ok: false, reason: `invalid session id ${sessionId.slice(0, 64)}` };
}

const COORDINATOR_TOPIC_PREFIX = "stallwatch:";

/**
 * The program a stall-watch coordinator coordinates, or null for any other session.
 *
 * A coordinator's own session tag is `stall-watcher-runs`, which says nothing
 * about the work, so a `/launch` sent in a coordinator's context (a swipe-reply
 * to one of its notifications) inherits the PROGRAM instead. The program is the
 * suffix of the coordinator's named-topic key, `stallwatch:<tag>`.
 *
 * `invalid` means the binding is a coordinator's but its suffix is not a tag
 * session-tags would accept: the caller reports it rather than falling back to
 * the coordinator's own tag, which would file the new session's spend under
 * stall-watch itself.
 */
export function coordinatorProgramOf(row: TagKeySession | null): { program: string } | { invalid: string } | null {
  const key = row?.boundTopicKey;
  if (typeof key !== "string" || !key.startsWith(COORDINATOR_TOPIC_PREFIX)) return null;
  const program = key.slice(COORDINATOR_TOPIC_PREFIX.length);
  return isValidTag(program) ? { program } : { invalid: program };
}

/**
 * The key the footer's `which` should ask about, or null to ask nothing.
 *
 * Looser than tagKeyFor on purpose: `which` is read-only and exits 0 on any
 * id, so an id this module has no rule for (a pull session's, say) is passed
 * through unchanged, as it always was. Only a `gse_…` id that cannot be mapped
 * is withheld: session-tags would just answer `auto:` for it.
 */
export function whichKeyFor(sessionId: string, sessions: TagKeySessionLookup | undefined): string | null {
  const res = tagKeyFor(sessionId, sessions);
  if (res.ok) return res.key;
  return sessionId.startsWith("gse_") ? null : sessionId;
}
