import type { StorageDb } from "../storage/database";

export const REMOTE_GOOSE_LOOKUP_TIMEOUT_MS = 3_000;

export interface RemoteGooseTargetDeps {
  swarmRelaySend?: boolean;
  machineId?: string;
  lookupSessionOwner?: (id: string, signal: AbortSignal) => Promise<{ machineId: string } | null>;
  lookupTimeoutMs?: number;
}

export interface RemoteGooseTargetResult {
  allowed: boolean;
  error?: string;
}

/**
 * Determines whether a target session starting with `gse_` should be permitted
 * as a remote target (relayed via arbiter) on /swarm/send and /swarm/schedule.
 *
 * Gated on:
 * - swarmRelaySend === true
 * - target `to` starts with "gse_"
 * - no channel
 * - target has no local session row in storage.sessions
 *
 * When these conditions hold:
 * - if lookupSessionOwner is not wired -> fail open (allowed: true)
 * - look up owner with ~3s bound:
 *   - owner is null (worker 404) -> allowed: false with detailed registration retry message
 *   - owner.machineId === this machine -> allowed: false (keep standard 409)
 *   - owner.machineId !== this machine -> allowed: true (allowRemoteGoose)
 *   - lookup throws or times out -> fail open (allowed: true)
 */
export async function shouldAllowRemoteGooseTarget(
  storage: StorageDb,
  to: string | null | undefined,
  channel: string | null | undefined,
  deps: RemoteGooseTargetDeps,
): Promise<RemoteGooseTargetResult> {
  if (deps.swarmRelaySend !== true) return { allowed: false };
  if (!to || !to.startsWith("gse_")) return { allowed: false };
  if (channel) return { allowed: false };
  if (storage.sessions.get(to)) return { allowed: false };

  if (!deps.lookupSessionOwner) {
    return { allowed: true };
  }

  const timeoutMs = deps.lookupTimeoutMs ?? REMOTE_GOOSE_LOOKUP_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`lookup timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const inFlight = deps.lookupSessionOwner(to, controller.signal);
    const owner = await Promise.race([inFlight, deadline]);
    if (!owner) {
      return {
        allowed: false,
        error: `no goose session ${to} on this machine, and no machine has registered it with the relay; if it contacted you just now, retry in a few minutes`,
      };
    }
    if (deps.machineId && owner.machineId === deps.machineId) return { allowed: false };
    return { allowed: true };
  } catch {
    // Lookup threw or timed out -> fail open
    return { allowed: true };
  } finally {
    clearTimeout(timer);
  }
}
