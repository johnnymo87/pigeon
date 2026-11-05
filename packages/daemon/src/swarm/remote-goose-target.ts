import type { StorageDb } from "../storage/database";

export const REMOTE_GOOSE_LOOKUP_TIMEOUT_MS = 3_000;

export interface RemoteGooseTargetDeps {
  swarmRelaySend?: boolean;
  machineId?: string;
  lookupSessionOwner?: (id: string, signal: AbortSignal) => Promise<{ machineId: string } | null>;
  lookupTimeoutMs?: number;
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
 * - if lookupSessionOwner is not wired -> fail open (true)
 * - look up owner with ~3s bound:
 *   - owner is null (worker 404) -> false (keep 409)
 *   - owner.machineId === this machine -> false (keep 409)
 *   - owner.machineId !== this machine -> true (allowRemoteGoose)
 *   - lookup throws or times out -> fail open (true)
 */
export async function shouldAllowRemoteGooseTarget(
  storage: StorageDb,
  to: string | null | undefined,
  channel: string | null | undefined,
  deps: RemoteGooseTargetDeps,
): Promise<boolean> {
  if (deps.swarmRelaySend !== true) return false;
  if (!to || !to.startsWith("gse_")) return false;
  if (channel) return false;
  if (storage.sessions.get(to)) return false;

  if (!deps.lookupSessionOwner) {
    return true;
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
    if (!owner) return false;
    if (deps.machineId && owner.machineId === deps.machineId) return false;
    return true;
  } catch {
    // Lookup threw or timed out -> fail open
    return true;
  } finally {
    clearTimeout(timer);
  }
}
