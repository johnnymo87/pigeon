/**
 * D1 query operations module.
 *
 * Pure functions that operate on a D1Database. Replaces the DO-specific
 * command-queue.ts with D1-native async queries.
 */

import { createTelegramClient } from "./telegram";
import { MAX_SESSIONS } from "./sessions";

export const LEASE_TIMEOUT_MS = 60_000; // 60s lease expiry
export const MAX_QUEUE_PER_MACHINE = 100;

const DEFAULT_MACHINE_THRESHOLD_MS = 60_000; // 60s for "is machine online"

// ─── generateCommandId ────────────────────────────────────────────────────────

/**
 * Generate a random command ID (16 bytes -> 32-char hex string).
 */
export function generateCommandId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── queueCommand ─────────────────────────────────────────────────────────────

/**
 * Queue a command into D1.
 * Returns the commandId on success, or null if the per-machine queue limit is
 * reached.
 */
export async function queueCommand(
  db: D1Database,
  opts: {
    machineId: string;
    sessionId: string | null;
    command: string;
    chatId: string;
    commandType?: string;
    directory?: string | null;
    mediaJson?: string | null;
    metadataJson?: string | null;
    messageThreadId?: number | null;
  },
): Promise<string | null> {
  const {
    machineId,
    sessionId,
    command,
    chatId,
    commandType = "execute",
    directory = null,
    mediaJson = null,
    metadataJson = null,
    messageThreadId = null,
  } = opts;

  // Check queue depth
  const countRow = await db
    .prepare(
      `SELECT COUNT(*) as count FROM commands
       WHERE machine_id = ? AND status IN ('pending', 'leased')`,
    )
    .bind(machineId)
    .first<{ count: number }>();

  if ((countRow?.count ?? 0) >= MAX_QUEUE_PER_MACHINE) {
    return null;
  }

  const commandId = generateCommandId();
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO commands
         (command_id, machine_id, session_id, command_type, command, chat_id,
          directory, media_json, metadata_json, message_thread_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(commandId, machineId, sessionId, commandType, command, chatId, directory, mediaJson, metadataJson, messageThreadId ?? null, now)
    .run();

  return commandId;
}

// ─── PollResult ───────────────────────────────────────────────────────────────

export interface PollResult {
  commandId: string;
  sessionId: string | null;
  command: string;
  chatId: string;
  commandType: string;
  directory: string | null;
  mediaJson: string | null;
  metadataJson: string | null;
  messageThreadId: number | null;
}

// ─── pollNextCommand ──────────────────────────────────────────────────────────

/**
 * Poll for the next command for a machine.
 *
 * Selects the oldest pending command, or the oldest leased command whose lease
 * has expired. Atomically marks the selected command as 'leased' and records
 * leased_at.
 *
 * Returns null if no command is available.
 */
export async function pollNextCommand(
  db: D1Database,
  machineId: string,
  now: number = Date.now(),
): Promise<PollResult | null> {
  const leaseExpiry = now - LEASE_TIMEOUT_MS;

  // Find the oldest eligible command for this machine:
  // either pending, or leased-but-expired
  const row = await db
    .prepare(
      `SELECT command_id, session_id, command, chat_id, command_type, directory, media_json, metadata_json, message_thread_id
       FROM commands
       WHERE machine_id = ?
         AND (
           status = 'pending'
           OR (status = 'leased' AND leased_at < ?)
         )
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .bind(machineId, leaseExpiry)
    .first<{
      command_id: string;
      session_id: string | null;
      command: string;
      chat_id: string;
      command_type: string;
      directory: string | null;
      media_json: string | null;
      metadata_json: string | null;
      message_thread_id?: number | null;
    }>();

  if (!row) {
    return null;
  }

  // Atomically mark as leased
  await db
    .prepare(
      `UPDATE commands
       SET status = 'leased', leased_at = ?
       WHERE command_id = ?`,
    )
    .bind(now, row.command_id)
    .run();

  return {
    commandId: row.command_id,
    sessionId: row.session_id,
    command: row.command,
    chatId: row.chat_id,
    commandType: row.command_type,
    directory: row.directory,
    mediaJson: row.media_json,
    metadataJson: row.metadata_json,
    messageThreadId: row.message_thread_id ?? null,
  };
}

// ─── ackCommand ───────────────────────────────────────────────────────────────

/**
 * Acknowledge a command as done (status = 'acked', acked_at = now).
 * Returns true if the command was found and updated, false otherwise.
 */
export async function ackCommand(
  db: D1Database,
  commandId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE commands
       SET status = 'acked', acked_at = ?
       WHERE command_id = ?`,
    )
    .bind(now, commandId)
    .run();

  return (result.meta.rows_written ?? 0) > 0;
}

// ─── touchMachine ─────────────────────────────────────────────────────────────

/**
 * Update the machine's last_poll_at timestamp (upsert).
 */
export async function touchMachine(
  db: D1Database,
  machineId: string,
  now: number = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO machines (machine_id, last_poll_at) VALUES (?, ?)
       ON CONFLICT (machine_id) DO UPDATE SET last_poll_at = excluded.last_poll_at`,
    )
    .bind(machineId, now)
    .run();
}

// ─── isMachineRecent ──────────────────────────────────────────────────────────

/**
 * Check whether a machine has polled within the given threshold.
 * Returns false for unknown machines.
 */
export async function isMachineRecent(
  db: D1Database,
  machineId: string,
  thresholdMs: number = DEFAULT_MACHINE_THRESHOLD_MS,
  now: number = Date.now(),
): Promise<boolean> {
  const row = await db
    .prepare("SELECT last_poll_at FROM machines WHERE machine_id = ?")
    .bind(machineId)
    .first<{ last_poll_at: number }>();

  if (!row) {
    return false;
  }

  return now - row.last_poll_at <= thresholdMs;
}

// ─── cleanupCommands ──────────────────────────────────────────────────────────

/**
 * Cleanup old commands:
 * - Delete acked commands older than 1 hour
 * - Delete non-done (stuck) commands older than 24 hours
 *
 * Returns counts of deleted rows.
 */
export async function cleanupCommands(
  db: D1Database,
  now: number = Date.now(),
): Promise<{ ackedDeleted: number; stuckDeleted: number }> {
  const oneHourAgo = now - 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const results = await db.batch([
    db.prepare(
      `DELETE FROM commands WHERE status = 'acked' AND acked_at < ?`,
    ).bind(oneHourAgo),
    db.prepare(
      `DELETE FROM commands WHERE status != 'acked' AND created_at < ?`,
    ).bind(oneDayAgo),
  ]);

  return {
    ackedDeleted: results[0]?.meta.rows_written ?? 0,
    stuckDeleted: results[1]?.meta.rows_written ?? 0,
  };
}

// ─── cleanupSeenUpdates ───────────────────────────────────────────────────────

/**
 * Cleanup old seen_updates entries older than 24 hours.
 * Returns the count of deleted rows.
 */
export async function cleanupSeenUpdates(
  db: D1Database,
  now: number = Date.now(),
): Promise<number> {
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const result = await db
    .prepare("DELETE FROM seen_updates WHERE created_at < ?")
    .bind(oneDayAgo)
    .run();

  return result.meta.rows_written ?? 0;
}

// ─── checkSessionHighWaterAlert ───────────────────────────────────────────────

/**
 * High-water alert check for session capacity.
 * If session count >= thresholdRatio (default 80%) of maxSessions (default MAX_SESSIONS),
 * sends a Telegram alert to the first chat ID in env.ALLOWED_CHAT_IDS.
 * Rejections inside sendMessage are caught and logged so cron execution stays alive.
 *
 * Returns the session count and whether an alert was sent.
 */
export async function checkSessionHighWaterAlert(
  db: D1Database,
  env: Env,
  opts?: {
    maxSessions?: number;
    thresholdRatio?: number;
    now?: number;
  },
): Promise<{ count: number; alerted: boolean }> {
  const cap = opts?.maxSessions ?? MAX_SESSIONS;
  const thresholdRatio = opts?.thresholdRatio ?? 0.8;

  const countResult = await db
    .prepare("SELECT COUNT(*) as count FROM sessions")
    .first<{ count: number }>();
  const count = countResult?.count ?? 0;

  if (count < cap * thresholdRatio) {
    return { count, alerted: false };
  }

  const raw = env.ALLOWED_CHAT_IDS || "";
  const allowed = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const firstChatId = allowed[0];

  if (!firstChatId) {
    // Over threshold with nowhere to send. Silence here would mean the alert is disabled
    // by misconfiguration and nobody ever finds out, which is worse than no alert at all.
    console.error(
      `Session high-water alert suppressed: ${count} / ${cap} sessions but ALLOWED_CHAT_IDS is empty`,
    );
    return { count, alerted: false };
  }

  const pct = Math.round((count / cap) * 100);
  const text = `⚠️ Session count high: ${count} / ${cap} sessions (${pct}%)`;

  let alerted = false;
  try {
    const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
    const res = await client.sendMessage({ chatId: firstChatId, text });
    if (res.ok) {
      alerted = true;
    } else {
      console.error("Failed to send session high-water alert:", res);
    }
  } catch (err) {
    console.error("Failed to send session high-water alert:", err);
  }

  return { count, alerted };
}

// ─── sweepStaleSessions ───────────────────────────────────────────────────────

export const SESSION_SWEEP_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Victim ids bound per DELETE. D1 allows a maximum of 100 bound parameters per query, and
 * that limit applies to each statement inside a `db.batch` individually:
 * https://developers.cloudflare.com/d1/platform/limits/
 *
 * Held below 100 deliberately, and pinned by a test — exceeding it does not degrade, it
 * throws the entire batch.
 */
export const SWEEP_ID_CHUNK = 90;

/**
 * Sweep stale sessions whose `updated_at` is older than SESSION_SWEEP_TTL_MS (14 days),
 * deleting their `messages` rows alongside them.
 *
 * This is the ONLY thing that can remove a session whose daemon lost its local state
 * (machine reinstalled, SQLite wiped, machine retired). The daemon reaper unregisters at
 * 7 days, but only for sessions it still holds locally, so those rows are otherwise
 * permanent. `messages` matters just as much: unregister (sessions.ts) is its only other
 * deletion path anywhere in the worker, so a stranded session strands its messages too.
 *
 * The victim ids are SELECTed once and bound explicitly into both deletes, rather than
 * letting each DELETE re-run the same subquery. Two identical subqueries over identical
 * data almost certainly return the same rows — but "almost certainly" is doing real work
 * in that sentence, `updated_at` is not unique, and the failure is asymmetric: if the two
 * ever disagreed such that the session went and its messages stayed, nothing in the
 * system would ever collect those messages, because the only other deleter is keyed by a
 * session id that no longer exists. Selecting once removes the question entirely.
 * `session_id` is the tiebreaker so the LIMIT window is itself deterministic.
 *
 * Returns counts of deleted sessions and messages.
 */
export async function sweepStaleSessions(
  db: D1Database,
  opts?: {
    now?: number;
    limit?: number;
    ttlMs?: number;
  },
): Promise<{ sessionsDeleted: number; messagesDeleted: number }> {
  const ttlMs = opts?.ttlMs ?? SESSION_SWEEP_TTL_MS;
  const cutoff = (opts?.now ?? Date.now()) - ttlMs;
  const limit = opts?.limit ?? 500;

  const { results: victims } = await db
    .prepare(
      "SELECT session_id FROM sessions WHERE updated_at < ? ORDER BY updated_at, session_id LIMIT ?",
    )
    .bind(cutoff, limit)
    .all<{ session_id: string }>();

  const ids = (victims ?? []).map((r) => r.session_id);
  if (ids.length === 0) {
    return { sessionsDeleted: 0, messagesDeleted: 0 };
  }

  // Deleted in chunks because D1 caps bound parameters at 100 PER STATEMENT, and that cap
  // applies to each statement inside a batch. One parameter per victim means a sweep of
  // more than 100 stale sessions exceeds it and the whole batch throws.
  //
  // This is not hypothetical. The first production run of this sweep had 126 victims,
  // threw on exactly this, was swallowed by the caller's try/catch, and deleted nothing
  // for two consecutive hourly ticks while appearing healthy. Local tests did not catch it
  // because miniflare is plain SQLite, whose parameter ceiling is 999, so the limit that
  // matters does not exist in the environment the tests run in. Keep SWEEP_ID_CHUNK at or
  // under 100 and keep the guard test that pins it.
  //
  // Chunking trades one transaction for several. Each chunk is still atomic in the only
  // way that matters here -- a session and its messages go together -- and a chunk failing
  // midway leaves earlier chunks deleted, which is simply less work for the next tick.
  let messagesDeleted = 0;
  let sessionsDeleted = 0;
  for (let i = 0; i < ids.length; i += SWEEP_ID_CHUNK) {
    const chunk = ids.slice(i, i + SWEEP_ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const batchResults = await db.batch([
      db
        .prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`)
        .bind(...chunk),
      db
        .prepare(`DELETE FROM sessions WHERE session_id IN (${placeholders})`)
        .bind(...chunk),
    ]);
    // `meta.changes` is the row count. `meta.rows_written` counts index writes too, so it
    // over-reports on `messages`, which carries a partial unique index on notification_id.
    messagesDeleted += batchResults[0]?.meta.changes ?? 0;
    sessionsDeleted += batchResults[1]?.meta.changes ?? 0;
  }

  // The sweep is the only observability there is into the leak it exists to clean, and a
  // silent DELETE is not something to run against production on a timer.
  console.log(
    `Stale session sweep: deleted ${sessionsDeleted} sessions and ${messagesDeleted} messages ` +
      `(updated_at < ${new Date(cutoff).toISOString()}, limit ${limit})`,
  );

  return { sessionsDeleted, messagesDeleted };
}
