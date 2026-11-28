export type QuotePick =
  | { kind: "since" }
  | { kind: "prev" }
  | { kind: "last"; n: number };

export interface QuoteRequest {
  sessionId: string;
  pick: QuotePick;
  full: boolean;
  notes?: string;
  tag?: string;
  quoteId?: string;
}

export interface QuoteReply {
  header: string; // "# 11-24 13:05 (wake: mail) · ask"
  passages: string[][]; // verbatim, unquoted lines
  prefills?: (string | null)[]; // parallel to passages when present
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
  unmatchedNotes?: string[];
}

export interface StoredQuotePassage {
  header: string;
  lines: string[];
  first: boolean;
  prefill?: string;
}

export interface StoredQuote {
  v: 1;
  sessionId: string;
  passages: StoredQuotePassage[];
  total: number;
  unmatchedNotes?: string[];
  notesRaw?: string;
}

export const QUOTE_MAX_PASSAGES = 45;
export const QUOTE_MAX_TOTAL_CHARS = 100_000;
export const QUOTE_MAX_SINGLE_PASSAGE_CHARS = 6_000;

export class QuoteUnsupportedError extends Error {
  constructor(message = "honkd does not support _honk/quote") {
    super(message);
    this.name = "QuoteUnsupportedError";
  }
}

export function isValidQuotePick(raw: unknown): raw is QuotePick {
  if (typeof raw !== "object" || raw === null) return false;
  const p = raw as Record<string, unknown>;
  if (p.kind === "since" || p.kind === "prev") return true;
  if (p.kind === "last" && typeof p.n === "number" && Number.isInteger(p.n) && p.n > 0) return true;
  return false;
}

export function isValidQuoteMetadata(
  raw: unknown,
): raw is { pick: QuotePick; full: boolean; notes?: string } {
  if (typeof raw !== "object" || raw === null) return false;
  const m = raw as Record<string, unknown>;
  if (typeof m.full !== "boolean") return false;
  if (m.notes !== undefined && typeof m.notes !== "string") return false;
  return isValidQuotePick(m.pick);
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

  if (obj.unmatchedNotes !== undefined) {
    if (!Array.isArray(obj.unmatchedNotes) || !obj.unmatchedNotes.every((n) => typeof n === "string")) {
      throw new Error("malformed _honk/quote result: unmatchedNotes must be string[]");
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
    let prefills: (string | null)[] | undefined;
    if (replyObj.prefills !== undefined) {
      if (
        !Array.isArray(replyObj.prefills) ||
        replyObj.prefills.length !== passages.length ||
        !replyObj.prefills.every((p) => p === null || typeof p === "string")
      ) {
        throw new Error(
          "malformed _honk/quote result: reply prefills must be (string | null)[] matching passages length",
        );
      }
      prefills = [...replyObj.prefills];
    }
    replies.push({
      header: replyObj.header,
      passages,
      ...(prefills !== undefined ? { prefills } : {}),
      inProgress: replyObj.inProgress,
    });
  }

  const unmatchedNotes =
    Array.isArray(obj.unmatchedNotes) && obj.unmatchedNotes.length > 0
      ? [...obj.unmatchedNotes]
      : undefined;

  return {
    summary: typeof obj.summary === "string" ? obj.summary : null,
    replies,
    notices: Array.isArray(obj.notices) ? [...obj.notices] : [],
    warnings: Array.isArray(obj.warnings) ? [...obj.warnings] : [],
    empty: (obj.empty as QuoteEmptyReason | undefined) || null,
    model: typeof obj.model === "string" ? obj.model : null,
    ...(unmatchedNotes !== undefined ? { unmatchedNotes } : {}),
  };
}
