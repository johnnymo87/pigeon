export type QuotePick =
  | { kind: "since" }
  | { kind: "prev" }
  | { kind: "last"; n: number };

export interface QuoteRequest {
  sessionId: string;
  pick: QuotePick;
  full: boolean;
  tag?: string;
  quoteId?: string;
}

export interface QuoteReply {
  header: string; // "# 11-24 13:05 (wake: mail) · ask"
  passages: string[][]; // verbatim, unquoted lines
  inProgress: boolean;
}

export type QuoteEmptyReason =
  | "no_replies"
  | "never_spoke"
  | "nothing_since"
  | "one_prompt"
  | "nothing_kept";

export interface QuoteResult {
  summary: string | null;
  replies: QuoteReply[];
  notices: string[];
  warnings: string[];
  empty: null | QuoteEmptyReason;
  model: string | null;
}

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

export const QUOTE_MAX_PASSAGES = 45;
export const QUOTE_MAX_TOTAL_CHARS = 100_000;

export class QuoteUnsupportedError extends Error {
  constructor(message = "honkd does not support _honk/quote") {
    super(message);
    this.name = "QuoteUnsupportedError";
  }
}

const VALID_EMPTY_REASONS = new Set<QuoteEmptyReason>([
  "no_replies",
  "never_spoke",
  "nothing_since",
  "one_prompt",
  "nothing_kept",
]);

export function parseQuoteResult(raw: unknown): QuoteResult {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("malformed _honk/quote result: expected an object");
  }

  const obj = raw as Record<string, unknown>;

  if (obj.summary !== null && obj.summary !== undefined && typeof obj.summary !== "string") {
    throw new Error("malformed _honk/quote result: summary must be string or null");
  }

  if (obj.model !== null && obj.model !== undefined && typeof obj.model !== "string") {
    throw new Error("malformed _honk/quote result: model must be string or null");
  }

  if (obj.notices !== undefined) {
    if (!Array.isArray(obj.notices) || !obj.notices.every((n) => typeof n === "string")) {
      throw new Error("malformed _honk/quote result: notices must be string[]");
    }
  }

  if (obj.warnings !== undefined) {
    if (!Array.isArray(obj.warnings) || !obj.warnings.every((w) => typeof w === "string")) {
      throw new Error("malformed _honk/quote result: warnings must be string[]");
    }
  }

  if (obj.empty !== null && obj.empty !== undefined) {
    if (typeof obj.empty !== "string" || !VALID_EMPTY_REASONS.has(obj.empty as QuoteEmptyReason)) {
      throw new Error("malformed _honk/quote result: invalid empty value");
    }
  }

  if (!Array.isArray(obj.replies)) {
    throw new Error("malformed _honk/quote result: replies must be an array");
  }

  const replies: QuoteReply[] = [];
  for (const r of obj.replies) {
    if (typeof r !== "object" || r === null) {
      throw new Error("malformed _honk/quote result: reply must be an object");
    }
    const replyObj = r as Record<string, unknown>;
    if (typeof replyObj.header !== "string") {
      throw new Error("malformed _honk/quote result: reply header must be a string");
    }
    if (typeof replyObj.inProgress !== "boolean") {
      throw new Error("malformed _honk/quote result: reply inProgress must be a boolean");
    }
    if (!Array.isArray(replyObj.passages)) {
      throw new Error("malformed _honk/quote result: reply passages must be an array");
    }
    const passages: string[][] = [];
    for (const p of replyObj.passages) {
      if (!Array.isArray(p) || !p.every((line) => typeof line === "string")) {
        throw new Error("malformed _honk/quote result: passage must be string[]");
      }
      passages.push([...p]);
    }
    replies.push({
      header: replyObj.header,
      passages,
      inProgress: replyObj.inProgress,
    });
  }

  return {
    summary: typeof obj.summary === "string" ? obj.summary : null,
    replies,
    notices: Array.isArray(obj.notices) ? [...obj.notices] : [],
    warnings: Array.isArray(obj.warnings) ? [...obj.warnings] : [],
    empty: (obj.empty as QuoteEmptyReason | undefined) || null,
    model: typeof obj.model === "string" ? obj.model : null,
  };
}
