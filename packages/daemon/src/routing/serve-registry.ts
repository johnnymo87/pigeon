import { randomUUID } from "node:crypto";
import type { ServeInstanceRepo } from "./route-repo";

export function seedServes(
  serves: ServeInstanceRepo,
  endpoints: readonly string[],
  now: number,
  opts?: { uuidFn?: () => string; binaryEpoch?: number },
): void {
  const uuidFn = opts?.uuidFn ?? randomUUID;

  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i]!;
    const serveId = `serve-${i}`;

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
