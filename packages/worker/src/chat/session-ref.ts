/**
 * Resolving the optional leading `<session-id>` of /kill, /interrupt, /compact, /mcp and /model
 * (spec §5): a full id or a unique prefix. Slack slash commands cannot be typed in a thread, and
 * `#alerts` and named channels have no session, so there the id is the only way to name one; on
 * Telegram it saves finding the session's topic.
 *
 * An ambiguous prefix is REFUSED with its candidates rather than resolved to the newest match,
 * because /kill is destructive and a coordinator's shortened id is exactly the input that can be
 * ambiguous.
 */

export interface SessionRefMatch {
  sessionId: string;
  machineId: string;
  label: string | null;
}

export type SessionRefResult =
  | ({ kind: "found" } & SessionRefMatch)
  | { kind: "ambiguous"; candidates: SessionRefMatch[] }
  | { kind: "none" };

/** How many candidates an ambiguous answer names (one more is fetched, to know there are more). */
export const SESSION_REF_MAX_CANDIDATES = 5;

interface Row {
  session_id: string;
  machine_id: string;
  label: string | null;
}

const toMatch = (r: Row): SessionRefMatch => ({ sessionId: r.session_id, machineId: r.machine_id, label: r.label });

export async function resolveSessionRef(db: D1Database, ref: string): Promise<SessionRefResult> {
  // An exact id wins even when it is also a prefix of a longer one.
  const exact = await db
    .prepare("SELECT session_id, machine_id, label FROM sessions WHERE session_id = ?")
    .bind(ref)
    .first<Row>();
  if (exact) return { kind: "found", ...toMatch(exact) };

  // substr, not LIKE: `_` is a LIKE wildcard and every session id contains one.
  const { results } = await db
    .prepare(
      `SELECT session_id, machine_id, label FROM sessions
       WHERE substr(session_id, 1, ?) = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .bind(ref.length, ref, SESSION_REF_MAX_CANDIDATES + 1)
    .all<Row>();
  const rows = results ?? [];
  if (rows.length === 0) return { kind: "none" };
  if (rows.length === 1) return { kind: "found", ...toMatch(rows[0]!) };
  return { kind: "ambiguous", candidates: rows.map(toMatch) };
}

/** The refusal for an ambiguous prefix: the candidates, so the human can pick one. */
export function ambiguousRefText(ref: string, candidates: SessionRefMatch[]): string {
  const shown = candidates.slice(0, SESSION_REF_MAX_CANDIDATES);
  const lines = shown.map((c) => `• \`${c.sessionId}\` on ${c.machineId}${c.label ? ` (${c.label})` : ""}`);
  if (candidates.length > shown.length) lines.push("• …and more");
  return [`\`${ref}\` is ambiguous; nothing was done. Use a longer id:`, ...lines].join("\n");
}

export function noSessionRefText(ref: string): string {
  return `No session matches \`${ref}\`.`;
}
