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
  registerSession?: (sessionId: string, label?: string, signal?: AbortSignal) => Promise<unknown>;
  /**
   * Ownership-refresh state (pigeon-k0qn.5): when each local session last re-registered
   * successfully. In memory on purpose: after a restart every session is refreshed again,
   * spread over the next cycles by OWNERSHIP_REFRESH_PER_CYCLE, which costs a few hundred
   * registers and buys not having to persist anything.
   */
  ownership?: OwnershipRefreshState;
  /** Plain Telegram alert, for a session this daemon holds whose worker row another machine owns. */
  alert?: (text: string) => Promise<unknown>;
  nowFn?: () => number;
  log?: (msg: string) => void;
}

interface ReapResult {
  reaped: number;
  expired: number;
  orphanedQuestions: number;
  expiredInjectedPrompts: number;
  refreshedPinned: number;
  refreshedOwnership: number;
}

/** A session is re-registered once its last successful registration is this old. */
export const OWNERSHIP_REFRESH_AGE_MS = 20 * 60 * 60 * 1000;
/** Registers per hourly cycle, so a restart's full refresh is spread over several cycles. */
export const OWNERSHIP_REFRESH_PER_CYCLE = 100;
/** Bound on one register call; a slow worker must not stall the hourly cycle. */
export const OWNERSHIP_REFRESH_TIMEOUT_MS = 10_000;

export interface OwnershipRefreshState {
  lastRefreshed: Map<string, number>;
  /** Sessions already alerted as owned elsewhere, so each alerts once per daemon lifetime. */
  alerted: Set<string>;
}

export function newOwnershipRefreshState(): OwnershipRefreshState {
  return { lastRefreshed: new Map(), alerted: new Set() };
}

function isOwnedElsewhere(r: unknown): boolean {
  if (!r || typeof r !== "object") return false;
  const o = r as { ok?: unknown; status?: unknown; body?: unknown };
  const body = o.body as { error?: unknown } | undefined;
  return o.ok === false && o.status === 409 && body?.error === "owned_by_other_machine";
}

function isTransportFailure(r: unknown): boolean {
  return !!r && typeof r === "object" && (r as { kind?: unknown }).kind === "transport_error";
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

  // Ownership refresh (pigeon-k0qn.5). The worker's session row is what the cross-machine relay
  // routes by, and its `updated_at` moves only on register, notifications and Telegram routing.
  // A quiet session never notifies, so without this its row goes stale: another machine's
  // credential may take it over after 7 days, and the worker sweeps it at 14 and anyone may
  // claim it fresh. Re-registering each live session about once a day keeps the row owned and
  // retries a first registration that failed. Pinned sessions are refreshed every cycle above.
  let refreshedOwnership = 0;
  if (deps.registerSession && deps.ownership) {
    const state = deps.ownership;
    const live = deps.storage.sessions.list();
    const liveIds = new Set(live.map((x) => x.sessionId));
    for (const id of state.lastRefreshed.keys()) if (!liveIds.has(id)) state.lastRefreshed.delete(id);
    const due = live
      .filter((x) => !x.boundTopicKey && now - (state.lastRefreshed.get(x.sessionId) ?? 0) >= OWNERSHIP_REFRESH_AGE_MS)
      .sort((a, b) => (state.lastRefreshed.get(a.sessionId) ?? 0) - (state.lastRefreshed.get(b.sessionId) ?? 0))
      .slice(0, OWNERSHIP_REFRESH_PER_CYCLE);
    for (const session of due) {
      let r: unknown;
      try {
        r = await deps.registerSession(
          session.sessionId,
          session.label ?? undefined,
          AbortSignal.timeout(OWNERSHIP_REFRESH_TIMEOUT_MS),
        );
      } catch (err) {
        r = { ok: false, kind: "transport_error", error: String(err) };
      }
      if (r && typeof r === "object" && (r as { ok?: unknown }).ok === false) {
        if (isTransportFailure(r)) {
          // The worker is unreachable; the rest would fail the same way. Next cycle retries.
          log(`ownership refresh stopped: worker unreachable (${session.sessionId})`);
          break;
        }
        if (isOwnedElsewhere(r) && !state.alerted.has(session.sessionId)) {
          state.alerted.add(session.sessionId);
          const detail = String(((r as { body?: { detail?: unknown } }).body?.detail) ?? "");
          log(`ownership refresh: ${session.sessionId} is registered to another machine: ${detail}`);
          try {
            await deps.alert?.(
              `Session ${session.sessionId}${session.label ? ` (${session.label})` : ""} runs on this machine, ` +
                `but the worker has it registered to another machine, which now receives its cross-machine ` +
                `swarm messages and Telegram commands. ${detail}`,
            );
          } catch {
            // Best-effort; the log line above stands.
          }
        }
        continue;
      }
      state.lastRefreshed.set(session.sessionId, now);
      refreshedOwnership++;
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

  return { reaped, expired, orphanedQuestions, expiredInjectedPrompts, refreshedPinned, refreshedOwnership };
}

interface StartReaperDeps extends ReapDeps {
  intervalMs?: number;
}

export function startSessionReaper(deps: StartReaperDeps): { stop: () => void } {
  const intervalMs = deps.intervalMs ?? 60 * 60 * 1000;
  if (deps.registerSession && !deps.ownership) deps = { ...deps, ownership: newOwnershipRefreshState() };
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
