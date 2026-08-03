export interface ServeInstanceRecord {
  serveId: string;
  instanceUuid: string;
  endpoint: string;
  binaryEpoch: number;
  healthState: "healthy" | "unhealthy" | "unknown";
  heartbeatAt: number;
  draining: boolean;
}

export interface AssignmentRecord {
  sessionId: string;
  directoryKey: string | null;
  desiredServeId: string;
  ownerGeneration: number;
  state: "assigned" | "draining" | "dormant" | "migrating";
  /**
   * When this session was last PLACED onto a serve — nothing else. It is written
   * only by `RouteRepo.upsert`, whose only caller is `Router.placeSession`.
   *
   * It is NOT an activity signal. Two independent mechanisms decouple it from
   * activity, and it is worth knowing both, because each one alone looks refutable:
   *
   *  1. A live lease SUPPRESSES placement. `placeSession` runs only when
   *     `resolveRoute` returns null, and `resolveRoute` succeeds while a live lease
   *     exists — which the serve renews on a 10s fiber for the whole duration of a
   *     turn. So the busier a session is, the less often this advances.
   *  2. Most traffic never places AT ALL. Placement happens only on pigeon's own
   *     paths (`POST /place`, `OpencodeClientFactory.forSession` -> `ensureRouted`).
   *     A TUI or front-door request is served by `GET /route`, which is deliberately
   *     read-only (`resolveRoute ?? resolveProspectiveRoute`) and places nothing.
   *
   * The result is not a uniformly stale field but an erratic one: for a
   * pigeon-delivered session it roughly tracks deliveries (the serve DELETES the
   * lease in a finalizer at turn end, so the next delivery re-places), while for a
   * TUI-driven session it can be arbitrarily ancient no matter how hard that session
   * is working. Do not derive "active" from it in either case.
   *
   * For "is this session/serve doing work", read `session_lease` (live rows), which
   * the serve maintains. The persisted column is still named `last_active_at`; see
   * the note above `ROUTING_DDL` in `route-schema.ts` for why it cannot be renamed.
   */
  lastPlacedAt: number;
  updatedAt: number;
}

export interface LeaseRecord {
  sessionId: string;
  serveId: string;
  instanceUuid: string;
  ownerGeneration: number;
  leaseExpiresAt: number;
  heartbeatAt: number;
  binaryEpoch: number;
}

export interface RouteResult {
  sessionId: string;
  serveId: string;
  instanceUuid: string;
  ownerGeneration: number;
  apiBase: string;
  eventUrl: string;
  expiresAt: number;
  /** True only for a read-only prospective route (idle session, no lease held). */
  prospective?: boolean;
}

export interface RoutingMetaRecord {
  schemaVersion: number;
  ddlChecksum: string;
  binaryEpoch: number;
  updatedAt: number;
}
