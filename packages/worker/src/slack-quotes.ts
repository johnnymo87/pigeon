export interface StoredQuotePassage {
  header: string;
  lines: string[];
  first: boolean;
}

export interface StoredQuote {
  v: 1;
  sessionId: string;
  passages: StoredQuotePassage[];
  total: number;
}

export const SLACK_QUOTE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SLACK_QUOTE_SWEEP_CAP = 5000;
export const MAX_QUOTE_PAYLOAD_CHARS = 200_000;

export function isValidStoredQuote(raw: unknown): raw is StoredQuote {
  if (typeof raw !== "object" || raw === null) return false;
  const q = raw as Record<string, unknown>;

  if (q.v !== 1) return false;
  if (typeof q.sessionId !== "string" || q.sessionId.length === 0) return false;
  if (typeof q.total !== "number" || !Number.isInteger(q.total) || q.total < 0) return false;
  if (!Array.isArray(q.passages)) return false;

  for (const p of q.passages) {
    if (typeof p !== "object" || p === null) return false;
    const passage = p as Record<string, unknown>;
    if (typeof passage.header !== "string") return false;
    if (typeof passage.first !== "boolean") return false;
    if (!Array.isArray(passage.lines) || !passage.lines.every((line) => typeof line === "string")) {
      return false;
    }
  }

  return true;
}

export function extractQuoteIdFromReplyMarkup(replyMarkup: unknown): string | null {
  if (!replyMarkup || typeof replyMarkup !== "object") return null;
  const markup = replyMarkup as { inline_keyboard?: unknown[][] };
  if (!Array.isArray(markup.inline_keyboard)) return null;

  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) continue;
    for (const button of row) {
      if (!button || typeof button !== "object") continue;
      const btn = button as { callback_data?: string };
      if (typeof btn.callback_data !== "string") continue;
      if (btn.callback_data.startsWith("quote:")) {
        const id = btn.callback_data.slice("quote:".length);
        if (id) return id;
      }
    }
  }
  return null;
}

export async function putQuote(
  db: D1Database,
  quoteId: string,
  quote: StoredQuote,
  now: number = Date.now(),
): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO slack_quotes (quote_id, session_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(quoteId, quote.sessionId, JSON.stringify(quote), now)
      .run();
  } catch (err) {
    if (/no such table/i.test(String(err))) {
      console.log("[worker] slack_quotes put skipped: table missing");
      return;
    }
    throw err;
  }
}

export async function getQuote(db: D1Database, quoteId: string): Promise<StoredQuote | null> {
  try {
    const row = await db
      .prepare("SELECT payload_json FROM slack_quotes WHERE quote_id = ?")
      .bind(quoteId)
      .first<{ payload_json: string }>();
    if (!row) return null;
    const parsed = JSON.parse(row.payload_json);
    if (!isValidStoredQuote(parsed)) return null;
    return parsed;
  } catch (err) {
    if (/no such table/i.test(String(err))) {
      return null;
    }
    throw err;
  }
}

export interface SlackQuoteSweepOptions {
  now?: number;
  ttlMs?: number;
  cap?: number;
}

export async function sweepSlackQuotes(
  db: D1Database,
  opts: SlackQuoteSweepOptions | number = {},
): Promise<number> {
  const options = typeof opts === "number" ? { now: opts } : opts;
  const now = options.now ?? Date.now();
  const cutoff = now - (options.ttlMs ?? SLACK_QUOTE_TTL_MS);
  const cap = options.cap ?? SLACK_QUOTE_SWEEP_CAP;

  try {
    const res = await db
      .prepare(
        `DELETE FROM slack_quotes WHERE quote_id IN (
           SELECT quote_id FROM slack_quotes WHERE created_at < ? ORDER BY created_at LIMIT ?
         )`,
      )
      .bind(cutoff, cap)
      .run();
    return res.meta?.changes ?? 0;
  } catch (err) {
    if (/no such table/i.test(String(err))) {
      console.log("[worker] slack_quotes retention skipped: table missing");
      return 0;
    }
    console.error("[worker] slack_quotes retention sweep failed", { error: String(err) });
    return 0;
  }
}
