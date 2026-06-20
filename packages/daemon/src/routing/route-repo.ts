import type BetterSqlite3 from "better-sqlite3";
import type {
  ServeInstanceRecord,
  AssignmentRecord,
  LeaseRecord,
  RoutingMetaRecord,
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

function asRoutingMeta(row: Row): RoutingMetaRecord {
  return {
    schemaVersion: Number(row.schema_version),
    ddlChecksum: String(row.ddl_checksum),
    binaryEpoch: Number(row.binary_epoch),
    updatedAt: Number(row.updated_at),
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

  insertStubIfAbsent(rec: ServeInstanceRecord): void {
    this.db
      .prepare(
        `INSERT INTO serve_instance
           (serve_id, instance_uuid, endpoint, binary_epoch, health_state, heartbeat_at, draining)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(serve_id) DO NOTHING`,
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

  setHealthState(serveId: string, state: "healthy" | "unhealthy" | "unknown"): void {
    this.db
      .prepare(
        `UPDATE serve_instance
         SET health_state = ?
         WHERE serve_id = ?`,
      )
      .run(state, serveId);
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

  /**
   * Mark an assignment dormant ONLY if it still matches the given serve + generation
   * (and isn't already dormant). Fenced so a sweeper expiring an OLD lease cannot clobber
   * a newer assignment created by a concurrent re-route. Returns true iff a row changed.
   */
  setDormantFenced(sessionId: string, serveId: string, ownerGeneration: number, now: number): boolean {
    const res = this.db
      .prepare(
        `UPDATE session_assignment
         SET state = 'dormant', updated_at = @now
         WHERE session_id = @sid AND desired_serve_id = @serve AND owner_generation = @gen AND state != 'dormant'`,
      )
      .run({ now, sid: sessionId, serve: serveId, gen: ownerGeneration });
    return res.changes > 0;
  }

  listForServe(serveId: string): AssignmentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM session_assignment WHERE desired_serve_id = ?")
      .all(serveId) as Row[];
    return rows.map(asAssignment);
  }

  all(): AssignmentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM session_assignment")
      .all() as Row[];
    return rows.map(asAssignment);
  }

  countActiveForServe(serveId: string): number {
    const res = this.db
      .prepare(`SELECT COUNT(*) as count FROM session_assignment WHERE desired_serve_id = ? AND state = 'assigned'`)
      .get(serveId) as { count: number } | undefined;
    return res?.count ?? 0;
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

  /**
   * Atomic lease acquire. A lease may only be created/taken when it agrees with the
   * source-of-truth tables: `session_assignment` (desired serve + owner_generation) AND
   * `routing_meta.binary_epoch`. This is a single SQL statement so the check-and-set is
   * race-safe across connections/processes (SQLite holds the write lock for the whole stmt).
   *
   * The INSERT path is `INSERT ... SELECT ... WHERE <assignment+epoch match>` (NOT
   * `INSERT ... VALUES`): when no lease row exists, a stale caller whose generation/epoch
   * does not match the assignment produces zero SELECT rows and inserts nothing (fixes the
   * "stale lower-gen insert when row absent" hole). The ON CONFLICT path re-validates the
   * same assignment+epoch invariant against `excluded.*`, then applies the take-over ladder.
   * Returns true iff a row was written (changes > 0).
   */
  acquireCAS(
    i: { sessionId: string; serveId: string; instanceUuid: string; ownerGeneration: number; binaryEpoch: number },
    now: number,
    ttlMs: number,
  ): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO session_lease (session_id, serve_id, instance_uuid, owner_generation, lease_expires_at, heartbeat_at, binary_epoch)
         SELECT @sid, @serve, @uuid, sa.owner_generation, @now + @ttlMs, @now, rm.binary_epoch
         FROM session_assignment sa JOIN routing_meta rm ON rm.id = 1
         WHERE sa.session_id=@sid AND sa.desired_serve_id=@serve AND sa.owner_generation=@gen AND rm.binary_epoch=@epoch
         ON CONFLICT(session_id) DO UPDATE SET
           serve_id=excluded.serve_id, instance_uuid=excluded.instance_uuid, owner_generation=excluded.owner_generation,
           lease_expires_at=excluded.lease_expires_at, heartbeat_at=excluded.heartbeat_at, binary_epoch=excluded.binary_epoch
         -- Re-validate the assignment+epoch invariant on conflict: the proposed (excluded.*) row
         -- must still match the source-of-truth assignment and the current binary_epoch.
         WHERE EXISTS (SELECT 1 FROM session_assignment sa JOIN routing_meta rm ON rm.id=1
                       WHERE sa.session_id=excluded.session_id AND sa.desired_serve_id=excluded.serve_id
                         AND sa.owner_generation=excluded.owner_generation AND rm.binary_epoch=excluded.binary_epoch)
           -- Take-over ladder (only one branch need hold):
           --   A: higher binary_epoch wins immediately (cutover; safe because M6 drains/stops old serves first).
           AND ( session_lease.binary_epoch < excluded.binary_epoch
                 --   B: same epoch, higher generation wins (crash-reassignment).
                 OR (session_lease.binary_epoch = excluded.binary_epoch AND session_lease.owner_generation < excluded.owner_generation)
                 --   C: same epoch+generation, allowed only if the held lease has expired OR it's
                 --      the same owner (serve+instance) renewing its own lease (idempotent).
                 OR (session_lease.binary_epoch = excluded.binary_epoch AND session_lease.owner_generation = excluded.owner_generation
                     AND (session_lease.lease_expires_at <= @now
                          OR (session_lease.serve_id = excluded.serve_id AND session_lease.instance_uuid = excluded.instance_uuid))) )`,
      )
      .run({
        sid: i.sessionId,
        serve: i.serveId,
        uuid: i.instanceUuid,
        gen: i.ownerGeneration,
        epoch: i.binaryEpoch,
        now,
        ttlMs,
      });
    return res.changes > 0;
  }

  renewCAS(
    sessionId: string,
    serveId: string,
    instanceUuid: string,
    ownerGeneration: number,
    binaryEpoch: number,
    now: number,
    ttlMs: number,
  ): boolean {
    const res = this.db
      .prepare(
        // Renew only the caller's own lease (full-token fence) AND only while it still agrees
        // with the source-of-truth assignment + current binary_epoch — so an old serve cannot
        // keep renewing after pigeon bumps the generation or the epoch.
        `UPDATE session_lease SET lease_expires_at=@now+@ttlMs, heartbeat_at=@now
         WHERE session_id=@sid AND serve_id=@serve AND instance_uuid=@uuid AND owner_generation=@gen AND binary_epoch=@epoch
           AND EXISTS (SELECT 1 FROM session_assignment sa JOIN routing_meta rm ON rm.id=1
                       WHERE sa.session_id=@sid AND sa.desired_serve_id=@serve AND sa.owner_generation=@gen AND rm.binary_epoch=@epoch)`,
      )
      .run({
        sid: sessionId,
        serve: serveId,
        uuid: instanceUuid,
        gen: ownerGeneration,
        epoch: binaryEpoch,
        now,
        ttlMs,
      });
    return res.changes > 0;
  }

  release(
    sessionId: string,
    serveId: string,
    instanceUuid: string,
    ownerGeneration: number,
    binaryEpoch: number,
  ): boolean {
    const res = this.db
      .prepare(
        `DELETE FROM session_lease
         WHERE session_id=@sid AND serve_id=@serve AND instance_uuid=@uuid AND owner_generation=@gen AND binary_epoch=@epoch`,
      )
      .run({
        sid: sessionId,
        serve: serveId,
        uuid: instanceUuid,
        gen: ownerGeneration,
        epoch: binaryEpoch,
      });
    return res.changes > 0;
  }

  listExpired(now: number): LeaseRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM session_lease WHERE lease_expires_at <= ?")
      .all(now) as Row[];
    return rows.map(asLease);
  }
}

export class RoutingMetaRepo {
  constructor(private readonly db: BetterSqlite3.Database) {}

  get(): RoutingMetaRecord {
    const row = this.db
      .prepare("SELECT * FROM routing_meta WHERE id = 1")
      .get() as Row | undefined;
    if (!row) {
      throw new Error("Routing meta singleton row not found; has schema been initialized?");
    }
    return asRoutingMeta(row);
  }

  bumpEpoch(now: number): number {
    const res = this.db
      .prepare(
        `UPDATE routing_meta SET binary_epoch = binary_epoch + 1, updated_at = ?
         WHERE id = 1
         RETURNING binary_epoch`,
      )
      .get(now) as { binary_epoch: number } | undefined;
    if (!res) {
      throw new Error("Failed to bump epoch; routing_meta row not found.");
    }
    return Number(res.binary_epoch);
  }
}
