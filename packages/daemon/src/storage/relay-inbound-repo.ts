import type BetterSqlite3 from "better-sqlite3";

/**
 * "This message arrived by cross-machine relay" (pigeon-k0qn.6).
 *
 * A side table rather than columns on `swarm_messages`, because a relayed message lands in one
 * of TWO tables: `swarm_messages` (delivered by the arbiter) or `pull_inbox` (a banking pull or
 * goose session). Both key on the original `msg_id`, so one side table answers for both.
 *
 * Read by three things, all of which must agree on it:
 *  - the arbiter's HOP RULE: a row with a record here is never relayed again;
 *  - `notifySenderOfFailure`: a late failure of such a row is reported back through the worker
 *    (`POST /swarm/relay/fail`), never as a local `from='pigeon'` row addressed to a remote
 *    session, which the relay route refuses;
 *  - the envelope, which names `from_machine`.
 *
 * The `fail_*` columns are the durable outbound queue for `/swarm/relay/fail`. `fail_reason` is
 * set at most once (`WHERE fail_reason IS NULL`), so a row that fails twice reports once.
 */
export function initRelayInboundSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS swarm_relay_inbound (
      msg_id TEXT PRIMARY KEY,
      from_machine TEXT NOT NULL,
      from_session TEXT NOT NULL,
      to_session TEXT NOT NULL,
      from_label TEXT,
      received_at INTEGER NOT NULL,
      fail_reason TEXT,
      fail_attempts INTEGER NOT NULL DEFAULT 0,
      fail_next_at INTEGER,
      fail_done_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_relay_inbound_fail
      ON swarm_relay_inbound(fail_done_at, fail_next_at);
  `);
}

export interface RelayInboundRecord {
  msgId: string;
  fromMachine: string;
  fromSession: string;
  toSession: string;
  fromLabel: string | null;
  receivedAt: number;
  failReason: string | null;
  failAttempts: number;
  failNextAt: number | null;
  failDoneAt: number | null;
}

type Row = Record<string, unknown>;

function asRecord(r: Row): RelayInboundRecord {
  return {
    msgId: String(r.msg_id),
    fromMachine: String(r.from_machine),
    fromSession: String(r.from_session),
    toSession: String(r.to_session),
    fromLabel: (r.from_label as string | null) ?? null,
    receivedAt: Number(r.received_at),
    failReason: (r.fail_reason as string | null) ?? null,
    failAttempts: Number(r.fail_attempts ?? 0),
    failNextAt: (r.fail_next_at as number | null) ?? null,
    failDoneAt: (r.fail_done_at as number | null) ?? null,
  };
}

export class RelayInboundRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  record(
    input: { msgId: string; fromMachine: string; fromSession: string; toSession: string; fromLabel: string | null },
    now: number,
  ): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO swarm_relay_inbound (msg_id, from_machine, from_session, to_session, from_label, received_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(msg_id) DO NOTHING`,
      )
      .run(input.msgId, input.fromMachine, input.fromSession, input.toSession, input.fromLabel, now);
    return result.changes > 0;
  }

  get(msgId: string): RelayInboundRecord | null {
    const row = this.db.prepare("SELECT * FROM swarm_relay_inbound WHERE msg_id = ?").get(msgId) as Row | undefined;
    return row ? asRecord(row) : null;
  }

  /** Queues the one `/swarm/relay/fail` report for this row. False if one is already queued. */
  queueFailure(msgId: string, reason: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE swarm_relay_inbound SET fail_reason = ?, fail_next_at = ?
         WHERE msg_id = ? AND fail_reason IS NULL`,
      )
      .run(reason, now, msgId);
    return result.changes > 0;
  }

  listFailuresDue(now: number, limit = 20): RelayInboundRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM swarm_relay_inbound
         WHERE fail_reason IS NOT NULL AND fail_done_at IS NULL AND fail_next_at <= ?
         ORDER BY fail_next_at ASC LIMIT ?`,
      )
      .all(now, limit) as Row[];
    return rows.map(asRecord);
  }

  markFailureSent(msgId: string, now: number): void {
    this.db.prepare("UPDATE swarm_relay_inbound SET fail_done_at = ? WHERE msg_id = ?").run(now, msgId);
  }

  markFailureRetry(msgId: string, nextAt: number): void {
    this.db
      .prepare("UPDATE swarm_relay_inbound SET fail_attempts = fail_attempts + 1, fail_next_at = ? WHERE msg_id = ?")
      .run(nextAt, msgId);
  }

  /**
   * Prunes records received before `cutoff` whose message is gone from both tables. Pass 8 days: the worker keeps a settled relay row
   * for 7 (`RELAY_RETENTION_MS`), after which `/swarm/relay/fail` is a no-op anyway, so a record
   * kept longer could route nothing.
   */
  pruneOlderThan(cutoff: number): number {
    // Never while the message itself is still here: the arbiter's hop rule and the /fail
    // diversion read this record, and an old relayed row can still be requeued by the watchdog.
    return this.db
      .prepare(
        `DELETE FROM swarm_relay_inbound
         WHERE received_at < ?
           AND NOT EXISTS (SELECT 1 FROM swarm_messages m WHERE m.msg_id = swarm_relay_inbound.msg_id)
           AND NOT EXISTS (SELECT 1 FROM pull_inbox p WHERE p.msg_id = swarm_relay_inbound.msg_id)`,
      )
      .run(cutoff).changes;
  }
}
