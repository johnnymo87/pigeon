import { coordinatorProgramOf, lookupSession, whichKeyFor, type TagKeySessionLookup } from "../tag-key";
import { parseWhichLine } from "../tag-resolver";

export interface RequesterTagResolverDeps {
  sessions: TagKeySessionLookup;
  runOcTags?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string } | null>;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export function createRequesterTagResolver(
  deps: RequesterTagResolverDeps,
): (sessionId: string) => Promise<string | null> {
  const log = deps.log ?? ((msg, fields) => console.warn(`[requester-tag] ${msg}`, fields ?? ""));

  return async function resolveRequesterTag(sessionId: string): Promise<string | null> {
    const row = lookupSession(sessionId, deps.sessions);
    const coordinator = coordinatorProgramOf(row);
    if (coordinator) {
      if ("invalid" in coordinator) {
        log("coordinator has invalid program tag", {
          sessionId,
          program: coordinator.invalid,
        });
        return null;
      }
      return coordinator.program;
    }

    const key = whichKeyFor(sessionId, deps.sessions);
    if (!key) return null;

    if (!deps.runOcTags) return null;

    try {
      const res = await deps.runOcTags(["which", "--", key]);
      if (!res || res.code !== 0) return null;
      const which = parseWhichLine(String(res.stdout ?? ""));
      return which?.kind === "session" && which.tag ? which.tag : null;
    } catch {
      return null;
    }
  };
}
