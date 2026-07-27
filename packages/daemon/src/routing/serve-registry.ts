import { randomUUID } from "node:crypto";
import type { ServeInstanceRepo } from "./route-repo";

/**
 * DM5-4 drift firewall. Pigeon mints serve ids from PIGEON_SERVE_ENDPOINTS
 * order, and the serve unit bound to the i-th port sets
 * OPENCODE_SERVE_ID=serve-<i> from the same Nix list (workstation
 * users/dev/serve-pool.nix). Every pigeon-side consumer that needs to address
 * "the slot at endpoint index i" MUST go through this function rather than
 * re-deriving the id, or a reassert could repair the wrong row.
 */
export function serveIdForIndex(index: number): string {
  return `serve-${index}`;
}

export function seedServes(
  serves: ServeInstanceRepo,
  endpoints: readonly string[],
  now: number,
  opts?: { uuidFn?: () => string; binaryEpoch?: number },
): void {
  const uuidFn = opts?.uuidFn ?? randomUUID;

  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i]!;
    const serveId = serveIdForIndex(i);

    serves.insertStubIfAbsent({
      serveId,
      instanceUuid: uuidFn(),
      endpoint,
      binaryEpoch: 0,
      healthState: "unknown",
      heartbeatAt: 0,
      draining: false,
    });
  }
}
