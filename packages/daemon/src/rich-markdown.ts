/**
 * Markdown for a Slack `markdown` block, used for stop notifications whose body contains a GFM
 * pipe table (pigeon-p909), and for every goose turn (pigeon-6mkr). Design:
 * docs/plans/2026-11-02-telegram-rich-tables-design.md and
 * docs/plans/2026-11-03-goose-rich-markdown-design.md (written for Telegram's dialect, which
 * was deleted with Telegram, pigeon-4ogz.13; Slack's is plain GFM).
 *
 * Why only tables trigger it for opencode (whose plugin strips markdown anyway): plain text
 * shows a table as a wall of `|`, and nothing else agents write is unreadable that way. Turning
 * markdown on for every message would change how every answer reads. So rich is the exception.
 *
 * Everything here is pure, and every "this cannot be sent rich" answer is `null`, which the
 * caller treats as "send plain, as before".
 */
import type { TgMessage } from "./telegram-message";

/** The widest table a rich message is offered with (a conservative bound, kept from Telegram's limit). */
export const RICH_MAX_COLUMNS = 20;

/**
 * A GFM table delimiter row: `|---|:-:|`, `--- | ---` (Hermes's regex), or a one-column `|---|`,
 * which needs both outer pipes so a plain `---` rule is never read as one.
 */
const DELIMITER_ROW =
  /^\s*(?:\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?|\|\s*:?-+:?\s*\|)\s*$/;
/**
 * A fence opener, after any indentation, blockquote markers and list markers: fences under
 * list items are indented or follow the marker (`- ```bash`), fences in quotes carry `>`. A backtick fence's info string cannot contain a
 * backtick (CommonMark), so ```` ```npm test``` ```` at the start of a line is inline code,
 * not a fence that would swallow the rest of the message.
 */
const FENCE_OPEN =
  /^((?:[ \t]*>|[ \t]*(?:[-*+]|\d+[.)])[ \t]+)*)[ \t]*(?:(`{3,})(?![^`]*`)|(~{3,}))/;
const FENCE_CLOSE = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})\s*$/;
/** A thematic break made of dashes: under a line of prose it would make that line a heading. */
const DASH_RULE = /^\s{0,3}-{3,}\s*$/;
/**
 * An ATX heading (CommonMark: up to three spaces, one to six `#`, then a space or the end).
 * `#5387` is not one.
 */
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
/** A blockquote line, at any indentation (quotes nest inside list items). */
const QUOTE_LINE = /^\s*>/;
interface LineInfo {
  text: string;
  /** Inside a fenced code block, including the fence lines themselves. */
  fenced: boolean;
  /** A fence open or close line. */
  fenceLine: boolean;
  /** Part of a pipe table (header, delimiter or data row). */
  table: boolean;
  /** Column count, on a table's delimiter row only. */
  columns?: number;
}

/**
 * Classifies each line as fenced code, table, or ordinary. A fence opens on 3+ backticks or
 * tildes and closes on a line of only the same character, at least as long (CommonMark). An
 * unclosed fence runs to the end of the text, as CommonMark renders it.
 */
function classifyLines(text: string): LineInfo[] {
  return classify(text).lines;
}

/**
 * `classifyLines`, plus the fence still open at the end when it was opened at top level
 * (no quote or list marker before it). A fence inside a quote or list item is closed by the
 * end of its container; only a top-level one would swallow what follows.
 */
function classify(text: string): { lines: LineInfo[]; openTopLevelFence: string | null } {
  let topLevel = false;
  const lines = text.split("\n").map<LineInfo>((t) => ({
    text: t,
    fenced: false,
    fenceLine: false,
    table: false,
  }));

  let fence: string | null = null;
  for (const line of lines) {
    if (fence !== null) {
      line.fenced = true;
      const close = line.text.match(FENCE_CLOSE);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) {
        line.fenceLine = true;
        fence = null;
      }
      continue;
    }
    const open = line.text.match(FENCE_OPEN);
    if (open) {
      line.fenced = true;
      line.fenceLine = true;
      fence = (open[2] ?? open[3])!;
      topLevel = open[1] === "";
    }
  }

  for (let i = 0; i + 1 < lines.length; i++) {
    const head = lines[i]!;
    const delim = lines[i + 1]!;
    if (head.fenced || delim.fenced || head.table) continue;
    if (!head.text.includes("|") || !DELIMITER_ROW.test(delim.text)) continue;
    // GFM: the header must have as many cells as the delimiter row, or it is not a table.
    if (countColumns(head.text) !== countColumns(delim.text)) continue;
    head.table = true;
    delim.table = true;
    delim.columns = countColumns(delim.text);
    let j = i + 2;
    while (j < lines.length) {
      const row = lines[j]!;
      if (row.fenced || row.text.trim() === "" || !row.text.includes("|")) break;
      row.table = true;
      j++;
    }
    i = j - 1;
  }

  return { lines, openTopLevelFence: fence !== null && topLevel ? fence : null };
}

function countColumns(delimiterRow: string): number {
  let t = delimiterRow.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").length;
}

/** True when the text contains a GFM pipe table outside fenced code. */
export function hasPipeTable(text: string): boolean {
  return classifyLines(text).some((l) => l.table);
}

/** Column count of the widest table outside fenced code; 0 when there is none. */
export function maxTableColumns(text: string): number {
  return classifyLines(text).reduce((max, l) => Math.max(max, l.columns ?? 0), 0);
}

/**
 * Prepares an agent's text for Slack's markdown block (plain GFM, so none of Telegram's
 * extensions to defang and none of its rendering quirks to work around):
 *
 * - turns a lone newline into a hard break (`"  \n"`), because plain text showed every
 *   newline and markdown would otherwise fold consecutive lines into one paragraph. Not
 *   inside fences or tables, and not next to a fence line;
 * - puts a blank line before and after every table, so a table directly under a line of
 *   prose is not read as part of that paragraph, and a line directly under a table is not
 *   read as one more row;
 * - puts a blank line before a heading under a non-blank line, and after a quote line followed
 *   by an unquoted one, so neither folds into the line above (lazy continuation);
 * - closes an agent's unclosed top-level fence, which would otherwise take the footer in.
 */
export function sanitizeBodyMarkdown(text: string): string {
  const classified = classify(text);
  const lines = classified.lines;
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out += line.text;
    const next = lines[i + 1];
    if (!next) break;
    const blank = line.text.trim() === "";
    const nextBlank = next.text.trim() === "";
    const plainPair = !blank && !nextBlank && !line.fenced && !next.fenced;
    if (
      plainPair &&
      (line.table !== next.table ||
        DASH_RULE.test(next.text) ||
        DASH_RULE.test(line.text) ||
        (!next.table && ATX_HEADING.test(next.text)) ||
        (!line.table && !next.table && QUOTE_LINE.test(line.text) && !QUOTE_LINE.test(next.text)))
    ) {
      out += "\n\n";
    } else if (
      !blank &&
      !nextBlank &&
      !line.table &&
      !next.table &&
      !line.fenced &&
      !next.fenced
    ) {
      out += "  \n";
    } else {
      out += "\n";
    }
  }
  if (classified.openTopLevelFence !== null) out += "\n" + classified.openTopLevelFence;
  return out;
}

function codeSpan(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${pad}${content}${pad}${fence}`;
}

function codeBlock(content: string): string {
  const longest = Math.max(2, ...(content.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${content}\n${fence}`;
}

/**
 * Converts one of pigeon's entity-built messages (header, footer) to rich markdown. Plain
 * segments are escaped; entities become their markdown form. Returns null on overlapping
 * entities, which pigeon never builds, so the caller falls back to plain.
 */
export function tgMessageToMarkdown(msg: TgMessage): string | null {
  const entities = [...msg.entities].sort((a, b) => a.offset - b.offset);
  let out = "";
  let pos = 0;
  for (const e of entities) {
    if (e.offset < pos) return null;
    out += escapePlainSlack(msg.text.slice(pos, e.offset));
    const content = msg.text.slice(e.offset, e.offset + e.length);
    switch (e.type) {
      case "code":
        // Slack has no copy button; a code span is what its client lets you copy.
        out += codeSpan(content);
        break;
      case "pre":
        out += codeBlock(content);
        break;
      case "bold":
        out += `**${escapePlainSlack(content)}**`;
        break;
      case "italic":
        out += `_${escapePlainSlack(content)}_`;
        break;
    }
    pos = e.offset + e.length;
  }
  out += escapePlainSlack(msg.text.slice(pos));
  return out;
}

/**
 * Characters escaped in pigeon's own text: CommonMark's backslash escapes for the emphasis,
 * code, link, strikethrough and table characters.
 */
const MD_SPECIAL_SLACK = /[\\`*_[\]~|]/g;

function escapePlainSlack(s: string): string {
  return s.replace(MD_SPECIAL_SLACK, (c) => "\\" + c).replace(/\n/g, "  \n");
}

/** Slack's limit for a markdown block, in characters (the worker's `SLACK_MARKDOWN_MAX`). */
export const SLACK_RICH_MAX_CHARS = 12_000;

export interface BuildRichOptions {
  /**
   * Only offer rich when the body has a pipe table (the default, pigeon-p909). False for
   * goose turns, whose markdown is rendered whatever it contains (pigeon-6mkr).
   */
  requireTable?: boolean;
}

/**
 * The rich markdown for a notification, or null when it should go plain: no table in the
 * body (unless `requireTable` is false), a header/footer that cannot be converted, or a limit
 * exceeded. Layout matches the plain chunk: header, body, footer separated by blank lines,
 * empty parts skipped.
 */
export function buildRichMarkdown(
  header: TgMessage,
  body: TgMessage,
  footer: TgMessage,
  options: BuildRichOptions = {},
): string | null {
  if ((options.requireTable ?? true) && !hasPipeTable(body.text)) return null;
  if (maxTableColumns(body.text) > RICH_MAX_COLUMNS) return null;

  const head = tgMessageToMarkdown(header);
  const foot = tgMessageToMarkdown(footer);
  if (head === null || foot === null) return null;

  const parts = [head, sanitizeBodyMarkdown(body.text), foot].filter((p) => p.length > 0);
  // Slack draws the gap between paragraphs itself.
  const markdown = parts.join("\n\n");
  return [...markdown].length > SLACK_RICH_MAX_CHARS ? null : markdown;
}
