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
  /**
   * Re-register a session with the worker, which bumps its `updated_at`. Called
   * every cycle for each pinned (topic-bound goose-acp) session, so the worker's
   * 14-day sweep never collects a coordinator this daemon still holds, while a
   * daemon that loses its state stops refreshing and its rows are swept as
   * before. Optional so a host without a worker connection still reaps.
   */
  registerSession?: (sessionId: string, label?: string) => Promise<unknown>;
  nowFn?: () => number;
  log?: (msg: string) => void;
}

interface ReapResult {
  reaped: number;
  expired: number;
  orphanedQuestions: number;
  expiredInjectedPrompts: number;
  refreshedPinned: number;
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

  // Pinned sessions are skipped by listStale and cleanupExpired; keep their
  // worker rows fresh too (see ReapDeps.registerSession).
  let refreshedPinned = 0;
  if (deps.registerSession) {
    for (const session of deps.storage.sessions.listPinned()) {
      try {
        const r = await deps.registerSession(session.sessionId, session.label ?? undefined);
        if (!(r && typeof r === "object" && "ok" in r && r.ok === false)) refreshedPinned++;
      } catch {
        // Best-effort; the next hourly cycle tries again, well inside 14 days.
      }
    }
  }

  const expired = deps.storage.sessions.cleanupExpired(now);
  if (expired > 0) {
    log(`cleaned ${expired} expired session records`);
  }

  // Sweep pending questions for deleted/orphaned sessions.
  // Orphan rows are unreachable because command-ingest checks sessions.get before any
  // pending_questions read; do NOT add an age/expiry-based sweep here — expired-but-live
  // rows are load-bearing for question resurrection (command-ingest.ts:157).
  const orphanedQuestions = deps.storage.pendingQuestions.deleteOrphaned();
  if (orphanedQuestions > 0) {
    log(`cleaned ${orphanedQuestions} orphaned pending question records`);
  }

  const expiredInjectedPrompts = deps.storage.injectedPrompts.cleanupExpired(now);
  if (expiredInjectedPrompts > 0) {
    log(`cleaned ${expiredInjectedPrompts} expired injected prompt records`);
  }

  return { reaped, expired, orphanedQuestions, expiredInjectedPrompts, refreshedPinned };
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
