import type { StorageDb } from "./storage/database";
import { SESSION_TTL_MS } from "./storage/schema";

interface ReapDeps {
  storage: StorageDb;
  // Stale Pigeon routing state is not the same as stale opencode history.
  deleteSession?: (sessionId: string) => Promise<void>;
  // Return value is ignored here on purpose: reaping is best-effort and a failed unregister is
  // retried by the next hourly cycle only if the local row still exists. The outbox's compensating
  // unregister DOES inspect the result, because nothing else can clean up after it.
  unregisterSession: (sessionId: string) => Promise<unknown>;
  nowFn?: () => number;
  log?: (msg: string) => void;
}

interface ReapResult {
  reaped: number;
  expired: number;
}

export async function reapStaleSessions(deps: ReapDeps): Promise<ReapResult> {
  const now = (deps.nowFn ?? Date.now)();
  const log = deps.log ?? ((msg: string) => console.log(`[reaper] ${msg}`));
  const cutoff = now - SESSION_TTL_MS;

  const stale = deps.storage.sessions.listStale(cutoff);

  let reaped = 0;
  for (const session of stale) {
    deps.storage.sessions.delete(session.sessionId);

    // Drop routing state so prospective /route stops naming a serve for a reaped
    // session (keeps "assignment exists" a true live-session discriminator).
    deps.storage.assignments.delete(session.sessionId);

    try {
      await deps.unregisterSession(session.sessionId);
    } catch {
      // Best-effort — worker may be unreachable
    }

    log(`reaped stale session ${session.sessionId} (last seen ${new Date(session.lastSeen).toISOString()})`);
    reaped++;
  }

  const expired = deps.storage.sessions.cleanupExpired(now);
  if (expired > 0) {
    log(`cleaned ${expired} expired session records`);
  }

  return { reaped, expired };
}

interface StartReaperDeps extends ReapDeps {
  intervalMs?: number;
}

export function startSessionReaper(deps: StartReaperDeps): { stop: () => void } {
  const intervalMs = deps.intervalMs ?? 60 * 60 * 1000;
  let processing = false;

  const timer = setInterval(async () => {
    if (processing) return;
    processing = true;
    try {
      await reapStaleSessions(deps);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[reaper] cycle error: ${msg}`);
    } finally {
      processing = false;
    }
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
