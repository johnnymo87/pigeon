import type BetterSqlite3 from "better-sqlite3";

export const REMOTE_LAUNCH_REQUEST_TTL_MS = 15 * 60_000;
export const REMOTE_LAUNCH_DEADLINE_GRACE_MS = 180_000; // 60s lease + 120s buffer

export function initRemoteLaunchSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_launch_inbound (       -- B side
      from_machine TEXT NOT NULL, launch_id TEXT NOT NULL,
      from_session TEXT NOT NULL,
      state TEXT NOT NULL,                  -- received | created | settled
      session_id TEXT, outcome TEXT, reason TEXT,
      ack_done INTEGER NOT NULL DEFAULT 0, ack_attempts INTEGER NOT NULL DEFAULT 0, next_ack_at INTEGER,
      received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (from_machine, launch_id)
    );
    CREATE INDEX IF NOT EXISTS idx_remote_launch_inbound_ack
      ON remote_launch_inbound(state, ack_done, next_ack_at);
    CREATE INDEX IF NOT EXISTS idx_remote_launch_inbound_updated
      ON remote_launch_inbound(updated_at);

    CREATE TABLE IF NOT EXISTS remote_launch_outbound (      -- A side
      launch_id TEXT PRIMARY KEY,
      from_session TEXT NOT NULL, to_machine TEXT NOT NULL, directory TEXT NOT NULL,
      request_json TEXT NOT NULL,
      state TEXT NOT NULL,                  -- sending | accepted | refused | resolved | deadline
      resolved_outcome TEXT,                -- launched | refused | unconfirmed: last outcome told to the agent
      refusal_code TEXT, refusal_status INTEGER, refusal_detail TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER,
      created_at INTEGER NOT NULL, request_expires_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
      settled_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_remote_launch_outbound_send
      ON remote_launch_outbound(state, next_attempt_at, request_expires_at);
    CREATE INDEX IF NOT EXISTS idx_remote_launch_outbound_deadline
      ON remote_launch_outbound(state, deadline_at);
    CREATE INDEX IF NOT EXISTS idx_remote_launch_outbound_created
      ON remote_launch_outbound(created_at);

    CREATE TABLE IF NOT EXISTS remote_launch_results_seen (  -- A side, dedup by result row id
      result_id TEXT PRIMARY KEY, launch_id TEXT NOT NULL, received_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_remote_launch_results_seen_received
      ON remote_launch_results_seen(received_at);
  `);
}

export type InboundState = "received" | "created" | "settled";
export type OutboundState = "sending" | "accepted" | "refused" | "resolved" | "deadline";
export type LaunchOutcome = "launched" | "refused" | "unconfirmed";

export interface RemoteLaunchInboundRecord {
  fromMachine: string;
  launchId: string;
  fromSession: string;
  state: InboundState;
  sessionId: string | null;
  outcome: LaunchOutcome | null;
  reason: string | null;
  ackDone: boolean;
  ackAttempts: number;
  nextAckAt: number | null;
  receivedAt: number;
  updatedAt: number;
}

export interface RemoteLaunchOutboundRecord {
  launchId: string;
  fromSession: string;
  toMachine: string;
  directory: string;
  requestJson: string;
  state: OutboundState;
  resolvedOutcome: LaunchOutcome | null;
  refusalCode: string | null;
  refusalStatus: number | null;
  refusalDetail: string | null;
  attempts: number;
  nextAttemptAt: number | null;
  createdAt: number;
  requestExpiresAt: number;
  deadlineAt: number;
  settledAt: number | null;
}

export interface RemoteLaunchResultSeenRecord {
  resultId: string;
  launchId: string;
  receivedAt: number;
}

type Row = Record<string, unknown>;

function asInboundRecord(r: Row): RemoteLaunchInboundRecord {
  return {
    fromMachine: String(r.from_machine),
    launchId: String(r.launch_id),
    fromSession: String(r.from_session),
    state: r.state as InboundState,
    sessionId: (r.session_id as string | null) ?? null,
    outcome: (r.outcome as LaunchOutcome | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    ackDone: Number(r.ack_done) === 1,
    ackAttempts: Number(r.ack_attempts ?? 0),
    nextAckAt: (r.next_ack_at as number | null) ?? null,
    receivedAt: Number(r.received_at),
    updatedAt: Number(r.updated_at),
  };
}

function asOutboundRecord(r: Row): RemoteLaunchOutboundRecord {
  return {
    launchId: String(r.launch_id),
    fromSession: String(r.from_session),
    toMachine: String(r.to_machine),
    directory: String(r.directory),
    requestJson: String(r.request_json),
    state: r.state as OutboundState,
    resolvedOutcome: (r.resolved_outcome as LaunchOutcome | null) ?? null,
    refusalCode: (r.refusal_code as string | null) ?? null,
    refusalStatus: (r.refusal_status as number | null) ?? null,
    refusalDetail: (r.refusal_detail as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    nextAttemptAt: (r.next_attempt_at as number | null) ?? null,
    createdAt: Number(r.created_at),
    requestExpiresAt: Number(r.request_expires_at),
    deadlineAt: Number(r.deadline_at),
    settledAt: (r.settled_at as number | null) ?? null,
  };
}

function asResultSeenRecord(r: Row): RemoteLaunchResultSeenRecord {
  return {
    resultId: String(r.result_id),
    launchId: String(r.launch_id),
    receivedAt: Number(r.received_at),
  };
}

export class RemoteLaunchInboundRepo {
  constructor(private readonly db: BetterSqlite3.Database) {}

  get(fromMachine: string, launchId: string): RemoteLaunchInboundRecord | null {
    const row = this.db
      .prepare("SELECT * FROM remote_launch_inbound WHERE from_machine = ? AND launch_id = ?")
      .get(fromMachine, launchId) as Row | undefined;
    return row ? asInboundRecord(row) : null;
  }

  insertReceived(
    input: { fromMachine: string; launchId: string; fromSession: string },
    now: number,
  ): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO remote_launch_inbound (from_machine, launch_id, from_session, state, received_at, updated_at)
         VALUES (?, ?, ?, 'received', ?, ?)
         ON CONFLICT (from_machine, launch_id) DO NOTHING`,
      )
      .run(input.fromMachine, input.launchId, input.fromSession, now, now);
    return result.changes > 0;
  }

  markCreated(fromMachine: string, launchId: string, sessionId: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE remote_launch_inbound
         SET state = 'created', session_id = ?, updated_at = ?
         WHERE from_machine = ? AND launch_id = ? AND state = 'received'`,
      )
      .run(sessionId, now, fromMachine, launchId);
    return result.changes > 0;
  }

  settle(
    fromMachine: string,
    launchId: string,
    outcome: LaunchOutcome,
    sessionId: string | null,
    reason: string | null,
    now: number,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE remote_launch_inbound
         SET state = 'settled', outcome = ?, session_id = ?, reason = ?, updated_at = ?
         WHERE from_machine = ? AND launch_id = ? AND state IN ('received', 'created')`,
      )
      .run(outcome, sessionId, reason, now, fromMachine, launchId);
    return result.changes > 0;
  }

  markAckDone(fromMachine: string, launchId: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE remote_launch_inbound
         SET ack_done = 1, updated_at = ?
         WHERE from_machine = ? AND launch_id = ? AND ack_done = 0`,
      )
      .run(now, fromMachine, launchId);
    return result.changes > 0;
  }

  markAckRetry(fromMachine: string, launchId: string, nextAt: number, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE remote_launch_inbound
         SET ack_attempts = ack_attempts + 1, next_ack_at = ?, updated_at = ?
         WHERE from_machine = ? AND launch_id = ? AND ack_done = 0`,
      )
      .run(nextAt, now, fromMachine, launchId);
    return result.changes > 0;
  }

  listAcksDue(now: number, limit = 20): RemoteLaunchInboundRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM remote_launch_inbound
         WHERE state = 'settled' AND ack_done = 0 AND (next_ack_at IS NULL OR next_ack_at <= ?)
         ORDER BY next_ack_at ASC, updated_at ASC
         LIMIT ?`,
      )
      .all(now, limit) as Row[];
    return rows.map(asInboundRecord);
  }

  pruneOlderThan(cutoff: number): number {
    return this.db
      .prepare("DELETE FROM remote_launch_inbound WHERE updated_at < ?")
      .run(cutoff).changes;
  }
}

export class RemoteLaunchOutboundRepo {
  constructor(private readonly db: BetterSqlite3.Database) {}

  get(launchId: string): RemoteLaunchOutboundRecord | null {
    const row = this.db
      .prepare("SELECT * FROM remote_launch_outbound WHERE launch_id = ?")
      .get(launchId) as Row | undefined;
    return row ? asOutboundRecord(row) : null;
  }

  insert(input: {
    launchId: string;
    fromSession: string;
    toMachine: string;
    directory: string;
    requestJson: string;
    createdAt: number;
  }): boolean {
    const requestExpiresAt = input.createdAt + REMOTE_LAUNCH_REQUEST_TTL_MS;
    const deadlineAt = requestExpiresAt + REMOTE_LAUNCH_DEADLINE_GRACE_MS;
    const result = this.db
      .prepare(
        `INSERT INTO remote_launch_outbound (
           launch_id, from_session, to_machine, directory, request_json,
           state, attempts, created_at, request_expires_at, deadline_at
         )
         VALUES (?, ?, ?, ?, ?, 'sending', 0, ?, ?, ?)
         ON CONFLICT (launch_id) DO NOTHING`,
      )
      .run(
        input.launchId,
        input.fromSession,
        input.toMachine,
        input.directory,
        input.requestJson,
        input.createdAt,
        requestExpiresAt,
        deadlineAt,
      );
    return result.changes > 0;
  }

  markAccepted(launchId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE remote_launch_outbound
         SET state = 'accepted', next_attempt_at = NULL
         WHERE launch_id = ? AND state = 'sending'`,
      )
      .run(launchId);
    return result.changes > 0;
  }

  markRefused(
    launchId: string,
    code: string,
    status: number,
    detail: string,
    now: number,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE remote_launch_outbound
         SET state = 'refused', resolved_outcome = 'refused',
             refusal_code = ?, refusal_status = ?, refusal_detail = ?, settled_at = ?
         WHERE launch_id = ? AND state = 'sending'`,
      )
      .run(code, status, detail, now, launchId);
    return result.changes > 0;
  }

  markRetry(launchId: string, nextAt: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE remote_launch_outbound
         SET attempts = attempts + 1, next_attempt_at = ?
         WHERE launch_id = ? AND state = 'sending'`,
      )
      .run(nextAt, launchId);
    return result.changes > 0;
  }

  markResolved(
    launchId: string,
    outcome: LaunchOutcome,
    now: number,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE remote_launch_outbound
         SET state = 'resolved', resolved_outcome = ?, settled_at = ?
         WHERE launch_id = ?
           AND NOT (? = 'unconfirmed' AND COALESCE(resolved_outcome, '') IN ('launched', 'refused'))`,
      )
      .run(outcome, now, launchId, outcome);
    return result.changes > 0;
  }

  markDeadline(launchId: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE remote_launch_outbound
         SET state = 'deadline', resolved_outcome = 'unconfirmed', settled_at = ?
         WHERE launch_id = ? AND state IN ('sending', 'accepted')`,
      )
      .run(now, launchId);
    return result.changes > 0;
  }

  listSendDue(now: number, limit = 50): RemoteLaunchOutboundRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM remote_launch_outbound
         WHERE state = 'sending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND request_expires_at > ?
         ORDER BY next_attempt_at ASC, created_at ASC
         LIMIT ?`,
      )
      .all(now, now, limit) as Row[];
    return rows.map(asOutboundRecord);
  }

  listDeadlinePassed(now: number, limit = 50): RemoteLaunchOutboundRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM remote_launch_outbound
         WHERE state IN ('sending', 'accepted') AND deadline_at <= ?
         ORDER BY deadline_at ASC, created_at ASC
         LIMIT ?`,
      )
      .all(now, limit) as Row[];
    return rows.map(asOutboundRecord);
  }

  pruneOlderThan(cutoff: number): number {
    return this.db
      .prepare("DELETE FROM remote_launch_outbound WHERE created_at < ?")
      .run(cutoff).changes;
  }
}

export class RemoteLaunchResultsSeenRepo {
  constructor(private readonly db: BetterSqlite3.Database) {}

  record(resultId: string, launchId: string, now: number): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO remote_launch_results_seen (result_id, launch_id, received_at)
         VALUES (?, ?, ?)
         ON CONFLICT (result_id) DO NOTHING`,
      )
      .run(resultId, launchId, now);
    return result.changes > 0;
  }

  get(resultId: string): RemoteLaunchResultSeenRecord | null {
    const row = this.db
      .prepare("SELECT * FROM remote_launch_results_seen WHERE result_id = ?")
      .get(resultId) as Row | undefined;
    return row ? asResultSeenRecord(row) : null;
  }

  pruneOlderThan(cutoff: number): number {
    return this.db
      .prepare("DELETE FROM remote_launch_results_seen WHERE received_at < ?")
      .run(cutoff).changes;
  }
}

export class RemoteLaunchRepository {
  readonly inbound: RemoteLaunchInboundRepo;
  readonly outbound: RemoteLaunchOutboundRepo;
  readonly resultsSeen: RemoteLaunchResultsSeenRepo;

  constructor(db: BetterSqlite3.Database) {
    this.inbound = new RemoteLaunchInboundRepo(db);
    this.outbound = new RemoteLaunchOutboundRepo(db);
    this.resultsSeen = new RemoteLaunchResultsSeenRepo(db);
  }

  pruneOlderThan(cutoff: number): { inbound: number; outbound: number; resultsSeen: number } {
    return {
      inbound: this.inbound.pruneOlderThan(cutoff),
      outbound: this.outbound.pruneOlderThan(cutoff),
      resultsSeen: this.resultsSeen.pruneOlderThan(cutoff),
    };
  }
}
