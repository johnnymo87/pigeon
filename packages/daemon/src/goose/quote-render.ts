import {
  escapePlainSlack,
  sanitizeBodyMarkdown,
  SLACK_RICH_MAX_CHARS,
} from "../rich-markdown";
import {
  QUOTE_MAX_PASSAGES,
  QUOTE_MAX_SINGLE_PASSAGE_CHARS,
  QUOTE_MAX_TOTAL_CHARS,
  type QuotePick,
  type QuoteResult,
  type StoredQuotePassage,
} from "./quote-types";

export {
  QUOTE_MAX_PASSAGES,
  QUOTE_MAX_SINGLE_PASSAGE_CHARS,
  QUOTE_MAX_TOTAL_CHARS,
  type StoredQuote,
  type StoredQuotePassage,
} from "./quote-types";

export const QUOTE_MAX_BODY_CHARS = 12_000;

/**
 * Caps a single stored passage at maxChars (default 6,000) of lines.
 * Truncates its lines and appends a "…" line.
 */
export function capSinglePassage(
  passage: StoredQuotePassage,
  maxChars = QUOTE_MAX_SINGLE_PASSAGE_CHARS,
): StoredQuotePassage {
  const totalChars = passage.lines.reduce((sum, l) => sum + l.length, 0);
  if (totalChars <= maxChars) {
    return passage;
  }
  const newLines: string[] = [];
  let remaining = maxChars;
  for (const line of passage.lines) {
    if (remaining <= 0) break;
    if (line.length <= remaining) {
      newLines.push(line);
      remaining -= line.length;
    } else {
      newLines.push(line.slice(0, remaining));
      remaining = 0;
      break;
    }
  }
  newLines.push("…");
  return {
    ...passage,
    lines: newLines,
  };
}

/**
 * Renders the pick label for /quote status:
 * "since your last message" | "since your previous message" | "last N" (+ " (full)").
 */
export function pickLabel(pick: QuotePick, full: boolean): string {
  let label: string;
  switch (pick.kind) {
    case "since":
      label = "since your last message";
      break;
    case "prev":
      label = "since your previous message";
      break;
    case "last":
      label = `last ${pick.n}`;
      break;
  }
  return full ? `${label} (full)` : label;
}

/**
 * Flattens passages from all replies into StoredQuote["passages"].
 * Reply order, then passage order; `first` is true for each reply's first passage.
 */
export function flattenPassages(result: QuoteResult): StoredQuotePassage[] {
  const passages: StoredQuotePassage[] = [];
  for (const reply of result.replies) {
    const header = reply.header;
    for (let i = 0; i < reply.passages.length; i++) {
      const p = reply.passages[i]!;
      passages.push({
        header,
        lines: p.flatMap((l) => l.split("\n")),
        first: i === 0,
      });
    }
  }
  return passages;
}

/**
 * Caps passages at QUOTE_MAX_PASSAGES (45) and QUOTE_MAX_TOTAL_CHARS (100,000) total line chars,
 * and caps each single passage at QUOTE_MAX_SINGLE_PASSAGE_CHARS (6,000) chars.
 * `total` records the uncapped count before capping.
 */
export function capPassages(
  passages: StoredQuotePassage[],
  maxPassages = QUOTE_MAX_PASSAGES,
  maxTotalChars = QUOTE_MAX_TOTAL_CHARS,
  maxSinglePassageChars = QUOTE_MAX_SINGLE_PASSAGE_CHARS,
): { passages: StoredQuotePassage[]; total: number } {
  const total = passages.length;
  const capped: StoredQuotePassage[] = [];
  let totalChars = 0;

  for (const rawPassage of passages) {
    if (capped.length >= maxPassages) break;
    const passage = capSinglePassage(rawPassage, maxSinglePassageChars);
    const passageChars = passage.lines.reduce((sum, l) => sum + l.length, 0);
    if (totalChars + passageChars > maxTotalChars && capped.length > 0) break;
    capped.push(passage);
    totalChars += passageChars;
  }

  return { passages: capped, total };
}

function formatPassageLines(passage: StoredQuotePassage, i: number): string[] {
  const lines: string[] = [];
  if (passage.first) {
    lines.push(`[${i + 1}] ${stripHeader(passage.header)}`);
  } else {
    lines.push(`[${i + 1}] …`);
  }
  for (const line of passage.lines) {
    const defused = defuseBroadcasts(line);
    lines.push(defused === "" ? ">" : `> ${defused}`);
  }
  return lines;
}

/**
 * Selects passages for the body post so that the plain body stays within maxBodyChars (12,000).
 * If passages must be omitted, stops adding passages and accounts for the trailer line:
 * "… <k> more passage(s): open them with Answer."
 */
export function selectBodyPassages(
  passages: StoredQuotePassage[],
  headerText: string,
  maxBodyChars = QUOTE_MAX_BODY_CHARS,
): { visiblePassages: StoredQuotePassage[]; omittedCount: number } {
  if (passages.length === 0) {
    return { visiblePassages: [], omittedCount: 0 };
  }

  const basePrefixLength = headerText.length + 2; // headerText + "\n\n"
  const accumulatedLines: string[] = [];
  let visibleCount = 0;

  for (let i = 0; i < passages.length; i++) {
    const passage = passages[i]!;
    const pLines = formatPassageLines(passage, i);
    const remainingAfter = passages.length - (i + 1);
    const trailerLength =
      remainingAfter > 0
        ? `\n… ${remainingAfter} more passage(s): open them with Answer.`.length
        : 0;

    const candidateLinesLength =
      (accumulatedLines.length > 0 ? accumulatedLines.join("\n").length + 1 : 0) +
      pLines.join("\n").length;
    const candidateLength = basePrefixLength + candidateLinesLength + trailerLength;

    if (candidateLength > maxBodyChars && i > 0) {
      break;
    }

    accumulatedLines.push(...pLines);
    visibleCount++;
  }

  return {
    visiblePassages: passages.slice(0, visibleCount),
    omittedCount: passages.length - visibleCount,
  };
}

/**
 * Formats a single line for empty results, prefixed with warnings and notices if present.
 */
export function emptyText(result: QuoteResult, _pickLabel?: string): string {
  const lines: string[] = [];
  for (const w of result.warnings) {
    lines.push(w.startsWith("⚠️") ? w : `⚠️ ${w}`);
  }
  for (const n of result.notices) {
    lines.push(n.startsWith("ℹ️") ? n : `ℹ️ ${n}`);
  }

  let reason: string;
  switch (result.empty) {
    case "nothing_since":
      reason = "Nothing has replied since your last message. Try /quote 3 or /quote prev.";
      break;
    case "nothing_kept":
      reason = "The trim found nothing that needs you (/quote full shows everything).";
      break;
    case "never_spoke":
      reason = "No messages from you found in this session. Try /quote 3.";
      break;
    case "one_prompt":
      reason = "Only one prompt found in this session.";
      break;
    case "no_replies":
      reason = "No replies found in this session.";
      break;
    default:
      reason = "No replies to quote.";
      break;
  }
  lines.push(reason);
  return lines.join("\n");
}

const ZWJ = "\u200d";

/**
 * Defuses Slack broadcast mentions in untrusted text using a zero-width joiner (ZWJ).
 * Prevents `<!channel>`, `<!here>`, `<!everyone>`, `<!subteam…>`, and bare
 * `@channel` / `@here` / `@everyone` from triggering broadcast notifications.
 */
export function defuseBroadcasts(text: string): string {
  return text
    .replace(/<!(?=\s*(?:channel|here|everyone|subteam))/gi, `<${ZWJ}!`)
    .replace(/(?<![A-Za-z0-9_.])@(?=(?:channel|here|everyone)(?![A-Za-z0-9_]))/gi, `@${ZWJ}`);
}

function stripHeader(header: string): string {
  return header.replace(/^#\s*/, "");
}

/**
 * Renders plain text for the body post:
 * 📋 /quote <pickLabel> · <label>
 * <summary without the leading "# ", or "quoted in full">
 * ⚠️ <each warning>
 * ℹ️ <each notice>
 *
 * [1] 11-24 13:05 (wake: mail) · ask
 * > line
 * >
 * > line
 * [2] …
 */
export function quoteBodyText(
  result: QuoteResult,
  pickLabel: string,
  label: string,
  maxBodyChars = QUOTE_MAX_BODY_CHARS,
): string {
  const headerLines: string[] = [
    `📋 /quote ${pickLabel} · ${label}`,
    result.summary ? stripHeader(result.summary) : "quoted in full",
  ];
  for (const w of result.warnings) {
    headerLines.push(w.startsWith("⚠️") ? w : `⚠️ ${w}`);
  }
  for (const n of result.notices) {
    headerLines.push(n.startsWith("ℹ️") ? n : `ℹ️ ${n}`);
  }

  const { passages } = capPassages(flattenPassages(result));
  if (passages.length === 0) {
    return headerLines.join("\n");
  }

  const headerText = headerLines.join("\n");
  const { visiblePassages, omittedCount } = selectBodyPassages(
    passages,
    headerText,
    maxBodyChars,
  );

  const passageLines: string[] = [];
  for (let i = 0; i < visiblePassages.length; i++) {
    passageLines.push(...formatPassageLines(visiblePassages[i]!, i));
  }
  if (omittedCount > 0) {
    passageLines.push(`… ${omittedCount} more passage(s): open them with Answer.`);
  }

  return `${headerText}\n\n${passageLines.join("\n")}`;
}

/**
 * Escapes characters in untrusted reply lines so they cannot be interpreted
 * as markdown structure (headings, blockquotes, lists, rules, emphasis, code, links).
 */
export function escapeQuoteLine(line: string): string {
  let escaped = escapePlainSlack(defuseBroadcasts(line));
  escaped = escaped.replace(/^(\s*)([#>\-+])/g, "$1\\$2");
  escaped = escaped.replace(/^(\s*\d+)([.)])/g, "$1\\$2");
  return escaped;
}

/**
 * Renders Slack-dialect GFM markdown: header lines bold, quote lines as `> `.
 * Returns null when exceeding SLACK_RICH_MAX_CHARS.
 */
export function quoteBodyMarkdown(
  result: QuoteResult,
  pickLabel: string,
  label: string,
  maxBodyChars = QUOTE_MAX_BODY_CHARS,
): string | null {
  const headerLines: string[] = [
    `📋 /quote ${escapePlainSlack(pickLabel)} · ${escapePlainSlack(label)}`,
    result.summary ? escapePlainSlack(stripHeader(result.summary)) : "quoted in full",
  ];
  for (const w of result.warnings) {
    headerLines.push(`⚠️ ${escapePlainSlack(w.replace(/^⚠️\s*/, ""))}`);
  }
  for (const n of result.notices) {
    headerLines.push(`ℹ️ ${escapePlainSlack(n.replace(/^ℹ️\s*/, ""))}`);
  }

  const { passages } = capPassages(flattenPassages(result));
  let rawMarkdown: string;

  if (passages.length === 0) {
    rawMarkdown = headerLines.join("\n");
  } else {
    const plainHeaderLines: string[] = [
      `📋 /quote ${pickLabel} · ${label}`,
      result.summary ? stripHeader(result.summary) : "quoted in full",
    ];
    for (const w of result.warnings) {
      plainHeaderLines.push(w.startsWith("⚠️") ? w : `⚠️ ${w}`);
    }
    for (const n of result.notices) {
      plainHeaderLines.push(n.startsWith("ℹ️") ? n : `ℹ️ ${n}`);
    }
    const plainHeaderText = plainHeaderLines.join("\n");
    const { visiblePassages, omittedCount } = selectBodyPassages(
      passages,
      plainHeaderText,
      maxBodyChars,
    );

    const passageLines: string[] = [];
    for (let i = 0; i < visiblePassages.length; i++) {
      const passage = visiblePassages[i]!;
      if (passage.first) {
        passageLines.push(`**[${i + 1}] ${escapePlainSlack(stripHeader(passage.header))}**`);
      } else {
        passageLines.push(`**[${i + 1}] …**`);
      }
      for (const line of passage.lines) {
        passageLines.push(line === "" ? ">" : `> ${escapeQuoteLine(line)}`);
      }
    }
    if (omittedCount > 0) {
      passageLines.push(`… ${omittedCount} more passage(s): open them with Answer.`);
    }
    rawMarkdown = `${headerLines.join("\n")}\n\n${passageLines.join("\n")}`;
  }

  const sanitized = sanitizeBodyMarkdown(rawMarkdown);
  return [...sanitized].length > SLACK_RICH_MAX_CHARS ? null : sanitized;
}
