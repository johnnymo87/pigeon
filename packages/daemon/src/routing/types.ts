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
  lastActiveAt: number;
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
