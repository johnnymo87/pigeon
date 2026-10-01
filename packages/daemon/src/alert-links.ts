/**
 * Optional "jump to session" buttons on a `POST /alert` message.
 *
 * A caller that summarises several sessions (a digest, a watcher) can pass
 * `links: [{label, sessionId}]`. Each session that has a forum topic gets one
 * inline-keyboard url button linking to that topic, so the reader can tap from
 * the alert straight into the session's thread and answer it there.
 *
 * Everything here FAILS OPEN. An alert is the deliverable and the buttons are
 * decoration: a malformed `links`, an unreachable worker, a slow lookup, or a
 * session with no topic all degrade to "the alert is sent without that button",
 * never to a failed or delayed-indefinitely alert and never to a 4xx.
 *
 * The session -> topic mapping lives only in the worker's D1 (`topics`), so the
 * daemon asks for it per alert (`POST /topics/lookup`) rather than caching a copy
 * that the worker's reaper and stale-thread recovery could silently invalidate.
 */

/** Most buttons rendered on one alert. Extra links are dropped, first ones kept. */
export const MAX_ALERT_LINKS = 8;

/**
 * Button labels longer than this are truncated with an ellipsis. Telegram does not
 * document a hard limit on inline button text, but clients cut long labels anyway;
 * 64 code points is a conservative bound that keeps a button readable on a phone.
 */
export const MAX_BUTTON_LABEL_CHARS = 64;

/** Default bound on the topic lookup. Short: the alert waits on it. */
export const DEFAULT_LINK_LOOKUP_TIMEOUT_MS = 2_000;

export interface AlertLink {
  label: string;
  sessionId: string;
}

export interface TopicInfo {
  chatId: string;
  messageThreadId: number | null;
  state: "open" | "closed";
}

export type TopicMap = Record<string, TopicInfo | null>;

/** Batch lookup of sessions' forum topics. Must honour `signal` where it can. */
export type TopicLookup = (sessionIds: string[], signal?: AbortSignal) => Promise<TopicMap>;

export interface UrlKeyboard {
  inline_keyboard: Array<Array<{ text: string; url: string }>>;
}

function truncateLabel(label: string): string {
  const chars = [...label];
  if (chars.length <= MAX_BUTTON_LABEL_CHARS) return label;
  return `${chars.slice(0, MAX_BUTTON_LABEL_CHARS - 1).join("")}…`;
}

/**
 * Tolerant parse of the request's `links` field. Never throws: anything that is not
 * an array yields [], and malformed entries are dropped individually. Deduped by
 * sessionId (first label wins) and capped at MAX_ALERT_LINKS.
 */
export function parseAlertLinks(raw: unknown): AlertLink[] {
  if (!Array.isArray(raw)) return [];
  const out: AlertLink[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_ALERT_LINKS) break;
    if (!item || typeof item !== "object") continue;
    const { label, sessionId } = item as { label?: unknown; sessionId?: unknown };
    if (typeof label !== "string" || typeof sessionId !== "string") continue;
    const l = label.trim();
    const s = sessionId.trim();
    if (!l || !s || seen.has(s)) continue;
    seen.add(s);
    out.push({ label: truncateLabel(l), sessionId: s });
  }
  return out;
}

/**
 * `https://t.me/c/<internal id>/<thread id>` for a forum topic, or null when the
 * pair cannot form a valid link. Only a supergroup id (`-100<digits>`) has an
 * internal id; a private chat or basic group cannot be linked this way.
 */
export function topicUrl(chatId: string, messageThreadId: number | null): string | null {
  const m = /^-100(\d+)$/.exec(chatId);
  if (!m) return null;
  if (
    typeof messageThreadId !== "number" ||
    !Number.isInteger(messageThreadId) ||
    messageThreadId <= 0
  ) {
    return null;
  }
  return `https://t.me/c/${m[1]}/${messageThreadId}`;
}

function isTopicInfo(v: unknown): v is TopicInfo {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.chatId === "string" &&
    (t.messageThreadId === null || typeof t.messageThreadId === "number")
  );
}

/**
 * One url button per row, in link order. Sessions with no topic, a reserved
 * (thread-less) topic, or an unlinkable chat are skipped. A CLOSED topic is still
 * linked because it remains readable, though its session is usually gone or idle.
 */
export function buildAlertKeyboard(links: AlertLink[], topics: TopicMap): UrlKeyboard | undefined {
  const rows: UrlKeyboard["inline_keyboard"] = [];
  for (const link of links) {
    const topic = Object.prototype.hasOwnProperty.call(topics, link.sessionId)
      ? topics[link.sessionId]
      : undefined;
    if (!isTopicInfo(topic)) continue;
    const url = topicUrl(topic.chatId, topic.messageThreadId);
    if (!url) continue;
    rows.push([{ text: link.label, url }]);
  }
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

/**
 * Parse, look up, and build — bounded by `timeoutMs`, never throwing. Returns
 * undefined whenever no button can be rendered, for whatever reason.
 *
 * The deadline is raced explicitly rather than trusted to the AbortSignal alone,
 * because a lookup that ignores its signal would otherwise hold the alert open
 * (same reasoning as `sendPlainAlert`, pigeon-wfj1).
 */
export async function resolveAlertKeyboard(
  rawLinks: unknown,
  lookup: TopicLookup | undefined,
  timeoutMs: number = DEFAULT_LINK_LOOKUP_TIMEOUT_MS,
): Promise<UrlKeyboard | undefined> {
  if (!lookup) return undefined;
  const links = parseAlertLinks(rawLinks);
  if (links.length === 0) return undefined;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, timeoutMs);
  });

  try {
    const inFlight = lookup(
      links.map((l) => l.sessionId),
      controller.signal,
    );
    inFlight.catch(() => {});
    const topics = await Promise.race([inFlight, deadline]);
    if (!topics || typeof topics !== "object") {
      if (topics === undefined && controller.signal.aborted) {
        console.warn(`[alert] topic lookup timed out after ${timeoutMs}ms; sending without links`);
      }
      return undefined;
    }
    return buildAlertKeyboard(links, topics);
  } catch (err) {
    console.warn(
      `[alert] topic lookup failed; sending without links: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
