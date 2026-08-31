import type BetterSqlite3 from "better-sqlite3";

/**
 * The bank for PULL-mode backends: clients that are not addressable HTTP servers
 * and must come and collect their mail.
 *
 * WHY A SEPARATE TABLE, when `swarm_messages` already banks inbound.
 *
 * The first design of this feature (SDD §13, first draft) reused `swarm_messages`
 * with `state='queued'` as the bank, on the reasoning that swarm inbound already
 * waits there so one table would mean one claim primitive. Adversarial review
 * priced that reuse and every consequence was independently fatal:
 *
 *  1. A `queued` row HAS NO BOUND once the arbiter is skipped for its target.
 *     `cleanupOlderThan` (swarm-repo.ts) deletes only terminal states and
 *     `handed_off`; what actually bounds a queued row today is the arbiter's
 *     MAX_ATTEMPTS -> markFailed -> terminal -> reaped. Skipping the arbiter --
 *     which a pull target requires, or it is pushed at a serve that never owned
 *     it -- removes the only bound, and the rows become immortal.
 *  2. `markVerified` carries NO OWNERSHIP GUARD (`WHERE msg_id = ?` alone). It is
 *     safe today because its only caller is the watchdog holding a row it just
 *     read. Exposing it over HTTP as an ack would make it a forgery primitive
 *     against other sessions' mail -- on a host where every process runs as the
 *     same uid and can read the shared bearer token (auth.ts says so out loud).
 *  3. It would redefine `verified_at` TABLE-WIDE. For opencode it means "we read
 *     the transcript and the payload is in it". For a pull client it could only
 *     mean "the client says it has it" -- the weaker meaning, asserted by the
 *     party being measured, silently applied to a column other code reasons about.
 *
 * One small table costs a migration and buys all three back, and leaves the swarm
 * delivery state machine completely untouched: no arbiter change, no watchdog
 * change, no new meaning for an existing column.
 *
 * TWO CLOCKS, TWO PHASES. `claimed_at` is stamped when the client collects the
 * row; `acked_at` when it confirms the payload reached the input it actually
 * runs. They are separate because an HTTP 200 out of the drain evidences only
 * that bytes left the daemon -- the client can die in between, and for the
 * motivating client (a systemd oneshot with TimeoutStartSec=3h) being SIGKILLed
 * is a designed-for event, not a freak one. A claimed row that is never acked is
 * re-served by the next claim (at-least-once, and the claim count says so), which
 * is the strongest honest guarantee available across a process boundary.
 *
 * `answer_kind` exists because of something MEASURED rather than predicted, on
 * 2026-08-31, running the real path end to end. While a question is pending,
 * command-ingest routes EVERY plain message to that session into the
 * question-reply path -- it says so in its own comment ("a live row hijacks EVERY
 * plain message to the session"). So an unrelated Telegram message sent during
 * the 4h TTL is banked as a `question-answer`, carrying the request id of a
 * question it was not answering, and it consumes the pending row so a later
 * button tap is refused as stale. The text is never lost; the LABEL is wrong,
 * and a client told to validate answers against open questions would believe it.
 * So the adapter records whether the answer matched one of the question's own
 * option labels, and the client is told which -- `option` is the human pressing
 * a button, `free-text` may be an answer or may be an unrelated message.
 *
 * `unacked_alerted_at` is DURABLE on purpose. Every dedupe in delivery-watchdog.ts
 * is an in-memory Set, so an alarm about a permanently stuck row re-fires on every
 * daemon restart -- and a permanently stuck row is precisely the population that
 * outlives many restarts.
 */
export function initPullInboxSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pull_inbox (
      msg_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      payload TEXT NOT NULL,
      question_request_id TEXT,
      answer_kind TEXT,
      chat_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      claimed_at INTEGER,
      claim_count INTEGER NOT NULL DEFAULT 0,
      acked_at INTEGER,
      unacked_alerted_at INTEGER
    );

    -- Serves the claim and the pending count, which are the two hot reads: both
    -- filter on (session_id, acked_at IS NULL, expires_at) and order by created_at.
    CREATE INDEX IF NOT EXISTS idx_pull_inbox_session
      ON pull_inbox(session_id, acked_at, expires_at, created_at);

    -- Serves the expiry sweep and the unacked alarm, which scan across sessions.
    CREATE INDEX IF NOT EXISTS idx_pull_inbox_sweep
      ON pull_inbox(acked_at, expires_at, claimed_at);
  `);
}
