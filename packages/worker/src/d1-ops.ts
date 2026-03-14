/**
 * D1 query operations module.
 *
 * Pure functions that operate on a D1Database. Replaces the DO-specific
 * command-queue.ts with D1-native async queries.
 */

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
          directory, media_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(commandId, machineId, sessionId, commandType, command, chatId, directory, mediaJson, now)
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
      `SELECT command_id, session_id, command, chat_id, command_type, directory, media_json
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
