import type { SessionRepository } from "../storage/repos.js";
import { GOOSE_BACKEND_KIND } from "./backend-kind.js";
import { DEFAULT_PULL_SOURCES } from "../storage/types.js";

export interface RemoteReachableDeps {
  sessions: Pick<SessionRepository, "get" | "setPullSources">;
  register?: (sessionId: string, label: string | null, signal: AbortSignal) => Promise<unknown>;
  timeoutMs?: number; // default 5000
  nowFn?: () => number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

function defaultLog(msg: string, fields?: Record<string, unknown>): void {
  if (fields && Object.keys(fields).length > 0) {
    console.warn(`[remote-reachable] ${msg}`, fields);
  } else {
    console.warn(`[remote-reachable] ${msg}`);
  }
}

export function createMarkGooseRemoteReachable(
  deps: RemoteReachableDeps,
): (sessionId: string) => Promise<{ marked: boolean; registered: boolean | "cached" | "skipped" }> {
  const log = deps.log ?? defaultLog;
  const timeoutMs = deps.timeoutMs ?? 5000;
  const nowFn = deps.nowFn ?? Date.now;
  const registeredThisLifetime = new Set<string>();

  return async function markGooseRemoteReachable(
    sessionId: string,
  ): Promise<{ marked: boolean; registered: boolean | "cached" | "skipped" }> {
    try {
      if (!sessionId.startsWith("gse_")) {
        return { marked: false, registered: "skipped" };
      }

      let row;
      try {
        row = deps.sessions.get(sessionId);
      } catch (err) {
        log("session lookup failed", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { marked: false, registered: "skipped" };
      }

      if (!row || row.backendKind !== GOOSE_BACKEND_KIND) {
        return { marked: false, registered: "skipped" };
      }

      const base = Array.isArray(row.pullSources) ? row.pullSources : [...DEFAULT_PULL_SOURCES];
      const next = [...base];
      let changed = false;
      if (!next.includes("swarm")) {
        next.push("swarm");
        changed = true;
      }
      if (!next.includes("swarm-remote")) {
        next.push("swarm-remote");
        changed = true;
      }

      const now = nowFn();
      if (changed) {
        try {
          deps.sessions.setPullSources(sessionId, next, now);
        } catch (err) {
          log("setPullSources failed", {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          return { marked: false, registered: "skipped" };
        }
      }

      const marked = true;

      if (!deps.register) {
        return { marked, registered: "skipped" };
      }

      if (registeredThisLifetime.has(sessionId)) {
        return { marked, registered: "cached" };
      }

      const controller = new AbortController();
      let timeoutId: NodeJS.Timeout | undefined;

      const timeoutPromise = new Promise<{ isTimeout: true }>((resolve) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          resolve({ isTimeout: true });
        }, timeoutMs);
      });

      try {
        const registerPromise = Promise.resolve().then(() =>
          deps.register!(sessionId, row.label ?? null, controller.signal),
        );
        registerPromise.catch(() => {});

        const outcome = await Promise.race([
          registerPromise.then((val) => ({ isTimeout: false as const, val })),
          timeoutPromise,
        ]);

        if (outcome.isTimeout) {
          log("remote-reachable: registration failed", { sessionId, reason: "timeout" });
          return { marked, registered: false };
        }

        const val = outcome.val;
        if (typeof val === "object" && val !== null && (val as { ok?: unknown }).ok === false) {
          const v = val as { reason?: unknown; error?: unknown; kind?: unknown };
          const reason =
            (typeof v.reason === "string" ? v.reason : undefined) ??
            (typeof v.error === "string" ? v.error : undefined) ??
            (typeof v.kind === "string" ? v.kind : undefined) ??
            "ok: false";
          log("remote-reachable: registration failed", { sessionId, reason });
          return { marked, registered: false };
        }

        registeredThisLifetime.add(sessionId);
        return { marked, registered: true };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log("remote-reachable: registration failed", { sessionId, reason });
        return { marked, registered: false };
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }
    } catch (err) {
      log("unexpected error", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { marked: false, registered: "skipped" };
    }
  };
}
