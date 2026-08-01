import { DEFAULT_EXPIRY_MS } from "../swarm/schedule-time";
import type BetterSqlite3 from "better-sqlite3";

export const SWARM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function initSwarmSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS swarm_messages (
      msg_id TEXT PRIMARY KEY,
      from_session TEXT NOT NULL,
      to_session TEXT,
      channel TEXT,
      kind TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      reply_to TEXT,
      payload TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      handed_off_at INTEGER,
      verified_at INTEGER,
      requeue_count INTEGER NOT NULL DEFAULT 0,
      aborted_at INTEGER,
      deliver_at INTEGER,
      expires_at INTEGER,
      cancelled_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_swarm_target_state
      ON swarm_messages(to_session, state, next_retry_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_swarm_inbox
      ON swarm_messages(to_session, state, msg_id);
    CREATE INDEX IF NOT EXISTS idx_swarm_channel
      ON swarm_messages(channel, state, created_at);
  `);

  // Additive migration for existing databases created before delivery
  // verification. Detect whether verified_at is about to be freshly added
  // *before* altering, so we know whether to run the one-time backfill below.
  const hadVerifiedAtBeforeMigration = (
    db.pragma("table_info(swarm_messages)") as Array<{ name: string }>
  ).some((c) => c.name === "verified_at");

  // The ALTERs, the supporting index, and the backfill must all commit or
  // all roll back together. If a crash landed only the ALTERs (verified_at
  // present) without the backfill, every later init would see verified_at
  // already there and skip the backfill forever -- silently defeating the
  // migration. Wrapping them in one transaction makes "verified_at exists"
  // reliably imply "backfill ran".
  const migrate = db.transaction(() => {
    const additiveColumns = [
      "ALTER TABLE swarm_messages ADD COLUMN verified_at INTEGER",
      "ALTER TABLE swarm_messages ADD COLUMN requeue_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE swarm_messages ADD COLUMN aborted_at INTEGER",
      "ALTER TABLE swarm_messages ADD COLUMN deliver_at INTEGER",
      "ALTER TABLE swarm_messages ADD COLUMN expires_at INTEGER",
      "ALTER TABLE swarm_messages ADD COLUMN cancelled_at INTEGER",
    ];

    for (const statement of additiveColumns) {
      try {
        db.exec(statement);
      } catch {
        // Column already exists.
      }
    }

    // Supports the watchdog's listUnverifiedHandedOff poll (every ~60s over
    // up to 7 days of rows). Created here rather than in the CREATE TABLE
    // block above because on upgrade paths verified_at doesn't exist until
    // the ALTERs above run.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_swarm_unverified
        ON swarm_messages(state, verified_at, handed_off_at);
      CREATE INDEX IF NOT EXISTS idx_swarm_scheduled
        ON swarm_messages(state, deliver_at);
    `);

    // Backfill a terminal clock onto scheduled rows banked BEFORE `expires_at`
    // got its default. Without this, the first night after deploy is exactly
    // the bug this feature exists to fix: an already-queued wake has
    // `expires_at IS NULL`, so the arbiter's outage exemption (which is gated
    // on the presence of a terminal clock) does not apply to it, and it burns
    // the old ~324s attempt budget against the restarting serve pool at 03:00.
    // The rows that motivated the fix would have been the ones it missed.
    //
    // Deliberately unguarded and safe to re-run: it only ever touches rows that
    // have no clock at all, and every post-deploy scheduled row is written with
    // one (parseScheduleTime defaults it). `deliver_at IS NOT NULL` keeps it off
    // ordinary /swarm/send rows, which are meant to have no expiry — giving them
    // one would silently opt them into unbounded uncounted retries.
    db.exec(`
      UPDATE swarm_messages
      SET expires_at = deliver_at + ${DEFAULT_EXPIRY_MS}
      WHERE state = 'queued'
        AND deliver_at IS NOT NULL
        AND expires_at IS NULL
    `);

    if (!hadVerifiedAtBeforeMigration) {
      // The watchdog governs only post-deploy messages. Without this backfill
      // its first cycle would mass-fetch and mass-redeliver up to
      // SWARM_RETENTION_MS worth of stale, already-delivered prompts.
      db.exec(`
        UPDATE swarm_messages
        SET verified_at = COALESCE(handed_off_at, updated_at)
        WHERE state = 'handed_off'
      `);
    }
  });

  migrate();
}
