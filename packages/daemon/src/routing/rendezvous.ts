import { createHash } from "node:crypto";

/** HRW score = first 8 bytes of sha256(serveId + ":" + sessionId) as an unsigned bigint; highest wins. */
function score(serveId: string, sessionId: string): bigint {
  const h = createHash("sha256").update(`${serveId}:${sessionId}`).digest();
  return h.readBigUInt64BE(0);
}

/** Rank candidate serves for a session, highest score first. Pure + deterministic. */
export function rankServes(sessionId: string, serveIds: readonly string[]): string[] {
  return [...serveIds].sort((a, b) => {
    const d = score(b, sessionId) - score(a, sessionId);
    return d > 0n ? 1 : d < 0n ? -1 : a < b ? -1 : 1; // tie-break on id for determinism
  });
}

/** Top-ranked serve, or undefined if no candidates. */
export function pickServe(sessionId: string, serveIds: readonly string[]): string | undefined {
  return rankServes(sessionId, serveIds)[0];
}
