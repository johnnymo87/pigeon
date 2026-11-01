/**
 * "Jump to session" buttons for the sessions a notification mentions (pigeon-ylx3).
 *
 * A coordinator reporting on its workers writes their ids into its answer, usually shortened
 * (`ses_e71285de`). Any notification whose text mentions a session that has a forum topic gets
 * one url button per such session, so the reader can tap straight into that worker's thread,
 * the same buttons stall-watch's digests get through the daemon's `POST /alert` `links`.
 *
 * Which sessions to mention is the writer's call; this only links what it wrote. A worker named
 * only by description, a prefix matching more than one topic, or a session without a topic gets
 * no button.
 *
 * Decoration only, so it FAILS OPEN: any error here yields no buttons, never a failed send.
 */

/** Most buttons added to one notification, matching the daemon's MAX_ALERT_LINKS. */
export const MAX_MENTION_LINKS = 8;

/** Matches the daemon's MAX_BUTTON_LABEL_CHARS. */
const MAX_LABEL_CHARS = 64;

/**
 * An opencode (`ses_`) or goose (`gse_`) session id, full or cut short after at least 8
 * characters. Every match is used as a prefix, so `gse_1a2b3c4d` also finds the full,
 * hyphenated goose id.
 */
const MENTION_RE = /(?<![A-Za-z0-9_])(?:ses|gse)_[A-Za-z0-9]{8,}/g;

export interface UrlKeyboard {
  inline_keyboard: Array<Array<{ text: string; url: string }>>;
}

/**
 * Mentioned ids in text order, deduped. The notifying session itself is dropped (its own id is
 * in every footer), so most notifications yield nothing and cost no query. Twice the button cap
 * is kept, leaving room for mentions that resolve to nothing.
 */
export function extractMentionedIds(text: string, selfId: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const id = m[0];
    if (selfId.startsWith(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= 2 * MAX_MENTION_LINKS) break;
  }
  return out;
}

/** The topic's title without its ` · ~/dir` suffix, else the name, else the id; truncated. */
export function buttonLabel(topicName: string | null, mentionedId: string): string {
  let label = (topicName ?? "").trim();
  const sep = label.lastIndexOf(" · ");
  if (sep > 0 && /^[~/]/.test(label.slice(sep + 3))) label = label.slice(0, sep).trim();
  if (!label) label = mentionedId;
  const chars = [...label];
  return chars.length <= MAX_LABEL_CHARS ? label : `${chars.slice(0, MAX_LABEL_CHARS - 1).join("")}…`;
}

function topicUrl(chatId: string, threadId: number | null): string | null {
  const m = /^-100(\d+)$/.exec(chatId);
  if (!m || typeof threadId !== "number" || !Number.isInteger(threadId) || threadId <= 0) return null;
  return `https://t.me/c/${m[1]}/${threadId}`;
}

interface Row {
  session_id: string;
  chat_id: string;
  message_thread_id: number | null;
  name: string | null;
}

export async function resolveMentionKeyboard(
  db: D1Database,
  text: string,
  selfId: string,
): Promise<UrlKeyboard | undefined> {
  const ids = extractMentionedIds(text, selfId);
  if (ids.length === 0) return undefined;
  try {
    // A range per prefix rather than LIKE, whose `_` is a wildcard. Every character that can
    // follow a prefix in a session id (alphanumerics, `-`) sorts below U+007F.
    const where = ids.map(() => "(session_id >= ? AND session_id < ?)").join(" OR ");
    const { results } = await db
      .prepare(
        `SELECT session_id, chat_id, message_thread_id, name FROM topics WHERE ${where} LIMIT 100`,
      )
      .bind(...ids.flatMap((id) => [id, `${id}\x7f`]))
      .all<Row>();

    const rows: UrlKeyboard["inline_keyboard"] = [];
    const linked = new Set<string>();
    for (const id of ids) {
      const matches = results.filter((r) => r.session_id.startsWith(id));
      if (matches.length !== 1) continue;
      const row = matches[0]!;
      if (row.session_id === selfId || linked.has(row.session_id)) continue;
      const url = topicUrl(row.chat_id, row.message_thread_id);
      if (!url) continue;
      linked.add(row.session_id);
      rows.push([{ text: buttonLabel(row.name, id), url }]);
      if (rows.length >= MAX_MENTION_LINKS) break;
    }
    return rows.length > 0 ? { inline_keyboard: rows } : undefined;
  } catch (err) {
    console.warn("[worker] mention link lookup failed; sending without links", { error: String(err) });
    return undefined;
  }
}

/** True when a caller-supplied reply_markup already carries buttons of its own. */
export function hasButtons(replyMarkup: unknown): boolean {
  const kb = (replyMarkup as { inline_keyboard?: unknown } | null | undefined)?.inline_keyboard;
  return Array.isArray(kb) && kb.some((row) => Array.isArray(row) && row.length > 0);
}
