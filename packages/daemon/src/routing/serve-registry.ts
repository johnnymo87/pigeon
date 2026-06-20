import { randomUUID } from "node:crypto";
import type { ServeInstanceRepo } from "./route-repo";

export function seedServes(
  serves: ServeInstanceRepo,
  endpoints: readonly string[],
  now: number,
  opts?: { uuidFn?: () => string; binaryEpoch?: number },
): void {
  const binaryEpoch = opts?.binaryEpoch ?? 0;
  const uuidFn = opts?.uuidFn ?? randomUUID;

  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i]!;
    const serveId = `serve-${i}`;
    const existing = serves.get(serveId);

    if (existing) {
      serves.upsert({
        serveId,
        instanceUuid: existing.instanceUuid,
        endpoint,
        binaryEpoch,
        healthState: existing.healthState,
        heartbeatAt: existing.heartbeatAt,
        draining: existing.draining,
      });
    } else {
      serves.upsert({
        serveId,
        instanceUuid: uuidFn(),
        endpoint,
        binaryEpoch,
        healthState: "unknown",
        heartbeatAt: now,
        draining: false,
      });
    }
  }
}
