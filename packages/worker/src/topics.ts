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
  /**
   * 1 when the topic's name was derived WITHOUT a human-meaningful session title — i.e. it is
   * just the abbreviated directory. Such a name may be upgraded exactly once, by the first
   * notification that carries a real title (pigeon-353p). 0 for every name that is final:
   * one built from a real title, and any name set by the manual `/rename` command.
   */
  name_provisional: number;
}

/**
 * opencode core names a brand-new session `New session - <ISO timestamp>` and only replaces it
 * seconds later, once its summarizer has produced a real title. Pigeon must never bake that
 * placeholder into a forum topic name, because topic names are write-once (pigeon-353p).
 *
 * Matched here in the worker as well as in the daemon (`parseTitle`) deliberately: the worker
 * deploys centrally while daemons are updated per-machine, so a lagging daemon would otherwise
 * keep minting placeholder-named topics indefinitely. Fail-open by construction — if opencode
 * changes the format this stops matching and we are back to today's behaviour, never worse.
 */
const PLACEHOLDER_TITLE_RE = /^New session - \d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;

export function isPlaceholderTitle(title: string | null | undefined): boolean {
  if (typeof title !== "string") return false;
  return PLACEHOLDER_TITLE_RE.test(title.trim());
}

/**
 * True when a stored topic NAME was built from the placeholder title — i.e. it looks like
 * `New session - <ISO> · ~/path`.
 *
 * Only rows marked provisional by the one-off backfill (see the forum-migration runbook) can look
 * like this; a name minted by current code never can, because the placeholder is stripped before
 * `topicName` sees it. It matters because the upgrade path may reuse a provisional name AS the
 * directory when a notification carries no dir, and that reuse is only sound for a name that
 * really is directory-only. Without this check a backfilled row would be permanently renamed to
 * `Real title · New session - <ISO> · ~/path`.
 */
export function hasPlaceholderName(name: string | null | undefined): boolean {
  if (typeof name !== "string") return false;
  return /^New session - \d{4}-\d{2}-\d{2}T/.test(name.trim());
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
 * Format is `${title} · ${dir}` clamped to at most 128 UTF-16 code units.
 * Home directories (/home/<user> or /Users/<user>) in the path are abbreviated to `~`.
 *
 * Internal newlines (\r, \n) are replaced with a single space " " because Telegram
 * topic names are single-line UI headers in topic lists and headers.
 *
 * Title comes first because the topic LIST truncates a row visually well before 128 chars,
 * so a trailing title is unreadable — the directory used to eat the visible width. The path
 * stays a real, pasteable suffix (deliberately not compressed to something like repo@branch).
 *
 * Two accepted limitations:
 *  - The `~` rewrite matches ANY user's home, so `/home/otheruser/x` also renders `~/x`, which
 *    would expand to the wrong path if pasted. Harmless while each machine runs sessions as a
 *    single user; the alternative is hardcoding usernames here, which is worse.
 *  - When a title is long enough to fill the budget, the DIRECTORY is the part that clamps away
 *    (previously the title was). Live names max out at 103 of 128 units so this does not occur
 *    today, and the path is still recoverable from the session-id inside the topic. Splitting
 *    the budget would need surrogate-safe handling at two cut points — not worth it unless a
 *    >125-char title actually shows up.
 */
export function topicName(dir: string, title: string): string {
  const cleanDir = dir.replace(/[\r\n]+/g, " ").replace(/ +/g, " ").trim();
  const cleanTitle = title.replace(/[\r\n]+/g, " ").replace(/ +/g, " ").trim();

  const abbrevDir = cleanDir.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");

  let full: string;
  if (cleanTitle && abbrevDir) {
    full = `${cleanTitle} · ${abbrevDir}`;
  } else if (cleanTitle) {
    full = cleanTitle;
  } else if (abbrevDir) {
    full = abbrevDir;
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
 *
 * `provisional` is written alongside the name, and only when a name is given: the two must agree,
 * and the caller that supplies the name is the one that knows whether it came from a real title.
 * It is set here rather than at `reserve` so that a steal-winner's view of the title wins.
 */
export async function finalize(
  db: D1Database,
  opts: {
    sessionId: string;
    messageThreadId: number;
    name?: string | null;
    provisional?: boolean;
    now?: number;
  },
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  if (opts.name !== undefined) {
    const res = await db
      .prepare(
        `UPDATE topics
         SET message_thread_id = ?, name = ?, name_provisional = ?, updated_at = ?
         WHERE session_id = ? AND message_thread_id IS NULL`,
      )
      .bind(opts.messageThreadId, opts.name, opts.provisional ? 1 : 0, now, opts.sessionId)
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
 * Rename a topic. Unconditional — this is the manual `/rename` command's writer, and an explicit
 * human name always wins. Clearing `name_provisional` here is what makes `/rename` a permanent
 * opt-out of the automatic one-shot upgrade (pigeon-353p).
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
       SET name = ?, name_provisional = 0, updated_at = ?
       WHERE session_id = ?`,
    )
    .bind(opts.name, now, opts.sessionId)
    .run();
  return (res.meta.rows_written ?? 0) > 0;
}

/**
 * Upgrade a provisional (directory-only) topic name to one built from a real session title.
 *
 * CAS on `name_provisional = 1`, so it is a no-op against a topic that has since been renamed by
 * a human or already upgraded by a rival isolate. Returns whether this caller won.
 *
 * Accepted residual: the CAS protects the D1 row, not Telegram. A `/rename` that lands between
 * this caller's `editForumTopic` and its CAS leaves Telegram showing the automatic name while D1
 * holds the human one; re-issuing `/rename` converges. The window is milliseconds wide and the
 * consequence is cosmetic, which is why it is not worth claiming the flag BEFORE the API call —
 * that would trade this for the much worse "one transient Telegram failure and the topic is
 * never upgraded", since every retry of the upgrade is driven by a later notification.
 */
export async function renameProvisional(
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
       SET name = ?, name_provisional = 0, updated_at = ?
       WHERE session_id = ? AND name_provisional = 1`,
    )
    .bind(opts.name, now, opts.sessionId)
    .run();
  return (res.meta.changes ?? 0) > 0;
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
 * Delete a topic record by session_id and message_thread_id.
 * Used for stale-thread recovery when a finalized topic was deleted out-of-band in Telegram.
 * Scoped to message_thread_id using SQLite `IS ?` so a late delete against a stale thread id no-ops
 * and cannot delete a newly finalized topic row for the same session (pigeon-5o7).
 * Uses `IS` for NULL-safe comparison (handles reservation rows where message_thread_id IS NULL).
 * Note: `deleteBySession` remains CAS-guarded on `message_thread_id IS NULL` to protect
 * topic creation reservation races from deleting finalized rows.
 */
export async function deleteTopicBySession(
  db: D1Database,
  sessionId: string,
  messageThreadId: number | null,
): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM topics WHERE session_id = ? AND message_thread_id IS ?")
    .bind(sessionId, messageThreadId)
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
 * List closed topics older than closedBefore where the session is no longer live, capped by limit.
 * Skips topics whose session is live (sessions row exists AND updated_at >= updatedBefore).
 * Used by cron reaper (T2.11).
 */
export async function listReapable(
  db: D1Database,
  opts: {
    closedBefore: number;
    updatedBefore: number;
    limit: number;
  },
): Promise<TopicRow[]> {
  const { results } = await db
    .prepare(
      `SELECT t.* FROM topics t
       LEFT JOIN sessions s ON t.session_id = s.session_id
       WHERE t.state = 'closed' AND t.closed_at < ? AND (s.session_id IS NULL OR s.updated_at < ?)
       ORDER BY t.closed_at ASC
       LIMIT ?`,
    )
    .bind(opts.closedBefore, opts.updatedBefore, opts.limit)
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
