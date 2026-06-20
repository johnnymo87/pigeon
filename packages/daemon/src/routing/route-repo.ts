import type BetterSqlite3 from "better-sqlite3";
import type {
  ServeInstanceRecord,
  AssignmentRecord,
  LeaseRecord,
} from "./types";

type Row = Record<string, unknown>;

function asServeInstance(row: Row): ServeInstanceRecord {
  return {
    serveId: String(row.serve_id),
    instanceUuid: String(row.instance_uuid),
    endpoint: String(row.endpoint),
    binaryEpoch: Number(row.binary_epoch),
    healthState: String(row.health_state) as ServeInstanceRecord["healthState"],
    heartbeatAt: Number(row.heartbeat_at),
    draining: Number(row.draining) === 1,
  };
}

function asAssignment(row: Row): AssignmentRecord {
  return {
    sessionId: String(row.session_id),
    directoryKey: (row.directory_key as string | null) ?? null,
    desiredServeId: String(row.desired_serve_id),
    ownerGeneration: Number(row.owner_generation),
    state: String(row.state) as AssignmentRecord["state"],
    lastActiveAt: Number(row.last_active_at),
    updatedAt: Number(row.updated_at),
  };
}

function asLease(row: Row): LeaseRecord {
  return {
    sessionId: String(row.session_id),
    serveId: String(row.serve_id),
    instanceUuid: String(row.instance_uuid),
    ownerGeneration: Number(row.owner_generation),
    leaseExpiresAt: Number(row.lease_expires_at),
    heartbeatAt: Number(row.heartbeat_at),
    binaryEpoch: Number(row.binary_epoch),
  };
}

export class ServeInstanceRepo {
  constructor(private readonly db: BetterSqlite3.Database) {}

  upsert(rec: ServeInstanceRecord): void {
    this.db
      .prepare(
        `INSERT INTO serve_instance
           (serve_id, instance_uuid, endpoint, binary_epoch, health_state, heartbeat_at, draining)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(serve_id) DO UPDATE SET
           instance_uuid = excluded.instance_uuid,
           endpoint = excluded.endpoint,
           binary_epoch = excluded.binary_epoch,
           health_state = excluded.health_state,
           heartbeat_at = excluded.heartbeat_at,
           draining = excluded.draining`,
      )
      .run(
        rec.serveId,
        rec.instanceUuid,
        rec.endpoint,
        rec.binaryEpoch,
        rec.healthState,
        rec.heartbeatAt,
        rec.draining ? 1 : 0,
      );
  }

  get(serveId: string): ServeInstanceRecord | null {
    const row = this.db
      .prepare("SELECT * FROM serve_instance WHERE serve_id = ?")
      .get(serveId) as Row | undefined;
    return row ? asServeInstance(row) : null;
  }

  all(): ServeInstanceRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM serve_instance")
      .all() as Row[];
    return rows.map(asServeInstance);
  }

  listHealthy(now: number, staleMs: number, binaryEpoch: number): ServeInstanceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM serve_instance
         WHERE health_state = 'healthy'
           AND heartbeat_at > ?
           AND draining = 0
           AND binary_epoch = ?`,
      )
      .all(now - staleMs, binaryEpoch) as Row[];
    return rows.map(asServeInstance);
  }

  setHealth(serveId: string, state: "healthy" | "unhealthy" | "unknown", now: number): void {
    this.db
      .prepare(
        `UPDATE serve_instance
         SET health_state = ?, heartbeat_at = ?
         WHERE serve_id = ?`,
      )
      .run(state, now, serveId);
  }

  setDraining(serveId: string, draining: boolean): void {
    this.db
      .prepare(
        `UPDATE serve_instance
         SET draining = ?
         WHERE serve_id = ?`,
      )
      .run(draining ? 1 : 0, serveId);
  }
}

export class SessionAssignmentRepo {
  constructor(private readonly db: BetterSqlite3.Database) {}

  get(sessionId: string): AssignmentRecord | null {
    const row = this.db
      .prepare("SELECT * FROM session_assignment WHERE session_id = ?")
      .get(sessionId) as Row | undefined;
    return row ? asAssignment(row) : null;
  }

  upsert(rec: AssignmentRecord): void {
    this.db
      .prepare(
        `INSERT INTO session_assignment
           (session_id, directory_key, desired_serve_id, owner_generation, state, last_active_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           directory_key = excluded.directory_key,
           desired_serve_id = excluded.desired_serve_id,
           owner_generation = excluded.owner_generation,
           state = excluded.state,
           last_active_at = excluded.last_active_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        rec.sessionId,
        rec.directoryKey,
        rec.desiredServeId,
        rec.ownerGeneration,
        rec.state,
        rec.lastActiveAt,
        rec.updatedAt,
      );
  }

  bumpGeneration(sessionId: string, now: number): number {
    this.db
      .prepare(
        `UPDATE session_assignment
         SET owner_generation = owner_generation + 1, updated_at = ?
         WHERE session_id = ?`,
      )
      .run(now, sessionId);

    const rec = this.get(sessionId);
    if (!rec) {
      throw new Error(`Assignment not found to bump generation: ${sessionId}`);
    }
    return rec.ownerGeneration;
  }

  touchActive(sessionId: string, now: number): void {
    this.db
      .prepare(
        `UPDATE session_assignment
         SET last_active_at = ?, updated_at = ?
         WHERE session_id = ?`,
      )
      .run(now, now, sessionId);
  }

  setState(sessionId: string, state: AssignmentRecord["state"], now: number): void {
    this.db
      .prepare(
        `UPDATE session_assignment
         SET state = ?, updated_at = ?
         WHERE session_id = ?`,
      )
      .run(state, now, sessionId);
  }

  listForServe(serveId: string): AssignmentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM session_assignment WHERE desired_serve_id = ?")
      .all(serveId) as Row[];
    return rows.map(asAssignment);
  }
}

export class SessionLeaseRepo {
  constructor(private readonly db: BetterSqlite3.Database) {}

  get(sessionId: string): LeaseRecord | null {
    const row = this.db
      .prepare("SELECT * FROM session_lease WHERE session_id = ?")
      .get(sessionId) as Row | undefined;
    return row ? asLease(row) : null;
  }

  acquireCAS(
    i: { sessionId: string; serveId: string; instanceUuid: string; ownerGeneration: number; binaryEpoch: number },
    now: number,
    ttlMs: number,
  ): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO session_lease
           (session_id, serve_id, instance_uuid, owner_generation, lease_expires_at, heartbeat_at, binary_epoch)
         VALUES (@sid, @serve, @uuid, @gen, @exp, @now, @epoch)
         ON CONFLICT(session_id) DO UPDATE SET
           serve_id=@serve, instance_uuid=@uuid, owner_generation=@gen,
           lease_expires_at=@exp, heartbeat_at=@now, binary_epoch=@epoch
         WHERE session_lease.lease_expires_at <= @now
            OR session_lease.owner_generation < @gen
            OR (session_lease.serve_id=@serve AND session_lease.instance_uuid=@uuid)`,
      )
      .run({
        sid: i.sessionId,
        serve: i.serveId,
        uuid: i.instanceUuid,
        gen: i.ownerGeneration,
        epoch: i.binaryEpoch,
        exp: now + ttlMs,
        now,
      });
    return res.changes > 0;
  }

  renewCAS(
    sessionId: string,
    serveId: string,
    instanceUuid: string,
    ownerGeneration: number,
    now: number,
    ttlMs: number,
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE session_lease
         SET lease_expires_at = ?, heartbeat_at = ?
         WHERE session_id = ?
           AND serve_id = ?
           AND instance_uuid = ?
           AND owner_generation = ?`,
      )
      .run(now + ttlMs, now, sessionId, serveId, instanceUuid, ownerGeneration);
    return res.changes > 0;
  }

  release(sessionId: string): void {
    this.db
      .prepare("DELETE FROM session_lease WHERE session_id = ?")
      .run(sessionId);
  }

  listExpired(now: number): LeaseRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM session_lease WHERE lease_expires_at <= ?")
      .all(now) as Row[];
    return rows.map(asLease);
  }
}
