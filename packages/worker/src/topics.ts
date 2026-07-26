/**
 * D1 repo module for Telegram forum topics (`topics` table).
 */

export interface TopicRow {
  session_id: string;
  machine_id: string | null;
  chat_id: string;
  message_thread_id: number | null;
  name: string | null;
  state: "open" | "closed";
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

/**
 * Returns true if TELEGRAM_TOPICS_ENABLED is set to "true" (exact match).
 * Returns false if "false", absent/undefined, or any other value (fail-safe).
 */
export function topicsEnabled(env: { TELEGRAM_TOPICS_ENABLED?: string }): boolean {
  return env.TELEGRAM_TOPICS_ENABLED === "true";
}

/**
 * Machine icon color mapping for Telegram forum topics.
 * Fixed map rather than a hash to prevent trivial collisions between machine names.
 */
export const MACHINE_ICON_COLORS: Record<string, number> = {
  devbox: 7322096, // 0x6FB9F0 blue
  cloudbox: 9367192, // 0x8EEE98 green
};
export const DEFAULT_ICON_COLOR = 16766590; // 0xFFD67E yellow

/**
 * Clamp `s` to at most `max` UTF-16 code units without splitting a surrogate pair.
 *
 * When the cut would land between a high and a low surrogate, the whole astral character is
 * dropped, yielding `max - 1` units. A pair that ends exactly on the boundary is preserved.
 *
 * Sibling copies exist in `@pigeon/daemon` (`text.ts`) and `@pigeon/opencode-plugin`
 * (`session-state.ts`). The three packages share no library, so this is duplicated
 * deliberately. Keep them in sync.
 */
export function clampPreservingSurrogates(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  // Trailing high surrogate means its low half was cut off — drop it too.
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

/**
 * Formats a Telegram forum topic name from directory and title.
 * Format is `${dir} · ${title}` clamped to at most 128 UTF-16 code units.
 *
 * Internal newlines (\r, \n) are replaced with a single space " " because Telegram
 * topic names are single-line UI headers in topic lists and headers.
 */
export function topicName(dir: string, title: string): string {
  const cleanDir = dir.replace(/[\r\n]+/g, " ").replace(/ +/g, " ").trim();
  const cleanTitle = title.replace(/[\r\n]+/g, " ").replace(/ +/g, " ").trim();

  let full: string;
  if (cleanDir && cleanTitle) {
    full = `${cleanDir} · ${cleanTitle}`;
  } else if (cleanDir) {
    full = cleanDir;
  } else if (cleanTitle) {
    full = cleanTitle;
  } else {
    full = "session";
  }

  if (full.length <= 128) return full;
  return clampPreservingSurrogates(full, 127) + "…";
}

/**
 * Retrieve a topic record by session_id.
 */
export async function getBySession(
  db: D1Database,
  sessionId: string,
): Promise<TopicRow | null> {
  const row = await db
    .prepare("SELECT * FROM topics WHERE session_id = ?")
    .bind(sessionId)
    .first<TopicRow>();
  return row ?? null;
}

/**
 * Retrieve a topic record by chat_id and message_thread_id.
 */
export async function getByThread(
  db: D1Database,
  chatId: string,
  messageThreadId: number,
): Promise<TopicRow | null> {
  const row = await db
    .prepare("SELECT * FROM topics WHERE chat_id = ? AND message_thread_id = ?")
    .bind(chatId, messageThreadId)
    .first<TopicRow>();
  return row ?? null;
}

/**
 * Reserve a topic reservation row for a session.
 * Built on INSERT OR IGNORE and reports whether *this* caller won the reservation.
 *
 * Returns true if this caller inserted the row, false if a row already existed.
 */
export async function reserve(
  db: D1Database,
  opts: {
    sessionId: string;
    machineId: string | null;
    chatId: string;
    name: string | null;
    now?: number;
  },
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO topics (session_id, machine_id, chat_id, name, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?)`,
    )
    .bind(opts.sessionId, opts.machineId, opts.chatId, opts.name, now, now)
    .run();
  // `changes`, not `rows_written`. The rest of this codebase reads `rows_written`
  // (d1-ops.ts:189,261,283) but every one of those is an UPDATE or DELETE, where the
  // distinction is invisible. Here it is load-bearing: this boolean elects the single
  // winner of the topic-creation race, so a false positive mints duplicate Telegram
  // topics. `changes` is contractually SQLite's changes() — 0 for an ignored insert.
  // `rows_written` is a billing counter that says nothing about OR IGNORE; measured
  // against production D1 it reports 2 for a plain insert and 3 for a CREATE TABLE,
  // i.e. it counts page/bookkeeping writes. It happens to report 0 for an ignored
  // insert today, but that is an observation, not a contract.
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Finalize a reserved topic row with its assigned message_thread_id.
 * CAS operation: only succeeds if message_thread_id IS NULL (prevents late winner overwriting).
 * Optionally updates name if provided.
 */
export async function finalize(
  db: D1Database,
  opts: {
    sessionId: string;
    messageThreadId: number;
    name?: string | null;
    now?: number;
  },
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  if (opts.name !== undefined) {
    const res = await db
      .prepare(
        `UPDATE topics
         SET message_thread_id = ?, name = ?, updated_at = ?
         WHERE session_id = ? AND message_thread_id IS NULL`,
      )
      .bind(opts.messageThreadId, opts.name, now, opts.sessionId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  } else {
    const res = await db
      .prepare(
        `UPDATE topics
         SET message_thread_id = ?, updated_at = ?
         WHERE session_id = ? AND message_thread_id IS NULL`,
      )
      .bind(opts.messageThreadId, now, opts.sessionId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }
}

/**
 * Rename a topic.
 */
export async function rename(
  db: D1Database,
  opts: {
    sessionId: string;
    name: string;
    now?: number;
  },
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const res = await db
    .prepare(
      `UPDATE topics
       SET name = ?, updated_at = ?
       WHERE session_id = ?`,
    )
    .bind(opts.name, now, opts.sessionId)
    .run();
  return (res.meta.rows_written ?? 0) > 0;
}

/**
 * Mark a topic as closed.
 */
export async function markClosed(
  db: D1Database,
  opts: {
    sessionId: string;
    now?: number;
  },
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const res = await db
    .prepare(
      `UPDATE topics
       SET state = 'closed', closed_at = ?, updated_at = ?
       WHERE session_id = ?`,
    )
    .bind(now, now, opts.sessionId)
    .run();
  return (res.meta.rows_written ?? 0) > 0;
}

/**
 * Mark a topic as open.
 */
export async function markOpen(
  db: D1Database,
  opts: {
    sessionId: string;
    now?: number;
  },
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const res = await db
    .prepare(
      `UPDATE topics
       SET state = 'open', closed_at = NULL, updated_at = ?
       WHERE session_id = ?`,
    )
    .bind(now, opts.sessionId)
    .run();
  return (res.meta.rows_written ?? 0) > 0;
}

/**
 * Delete a topic reservation record by session_id.
 * CAS operation: only deletes if message_thread_id IS NULL (preserves finalized topics).
 */
export async function deleteBySession(
  db: D1Database,
  sessionId: string,
): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM topics WHERE session_id = ? AND message_thread_id IS NULL")
    .bind(sessionId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Attempt to steal a stale reservation row (message_thread_id IS NULL and updated_at < expiredBefore).
 * Returns true if this caller won the CAS update and stole the reservation.
 */
export async function stealReservation(
  db: D1Database,
  opts: {
    sessionId: string;
    machineId: string | null;
    expiredBefore: number;
    now?: number;
  },
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const res = await db
    .prepare(
      `UPDATE topics
       SET updated_at = ?, machine_id = ?
       WHERE session_id = ? AND message_thread_id IS NULL AND updated_at < ?`,
    )
    .bind(now, opts.machineId, opts.sessionId, opts.expiredBefore)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * List closed topics older than closedBefore, capped by limit.
 * Used by cron reaper (T2.11).
 */
export async function listReapable(
  db: D1Database,
  opts: {
    closedBefore: number;
    limit: number;
  },
): Promise<TopicRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM topics
       WHERE state = 'closed' AND closed_at < ?
       ORDER BY closed_at ASC
       LIMIT ?`,
    )
    .bind(opts.closedBefore, opts.limit)
    .all<TopicRow>();
  return results ?? [];
}

/**
 * List open topics whose session row is missing or last updated before updatedBefore.
 * Used by cron orphan-closer (T2.11).
 */
export async function listOrphaned(
  db: D1Database,
  opts: {
    updatedBefore: number;
    limit?: number;
  },
): Promise<TopicRow[]> {
  if (opts.limit !== undefined) {
    const { results } = await db
      .prepare(
        `SELECT t.* FROM topics t
         LEFT JOIN sessions s ON t.session_id = s.session_id
         WHERE t.state = 'open' AND (s.session_id IS NULL OR s.updated_at < ?)
         ORDER BY t.created_at ASC
         LIMIT ?`,
      )
      .bind(opts.updatedBefore, opts.limit)
      .all<TopicRow>();
    return results ?? [];
  } else {
    const { results } = await db
      .prepare(
        `SELECT t.* FROM topics t
         LEFT JOIN sessions s ON t.session_id = s.session_id
         WHERE t.state = 'open' AND (s.session_id IS NULL OR s.updated_at < ?)
         ORDER BY t.created_at ASC`,
      )
      .bind(opts.updatedBefore)
      .all<TopicRow>();
    return results ?? [];
  }
}
