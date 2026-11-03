/**
 * Markdown for Telegram's `sendRichMessage` (Bot API 10.1), used for stop notifications whose
 * body contains a GFM pipe table (pigeon-p909), and for every goose turn (pigeon-6mkr). Design:
 * docs/plans/2026-11-02-telegram-rich-tables-design.md and
 * docs/plans/2026-11-03-goose-rich-markdown-design.md.
 *
 * Why only tables trigger it for opencode (whose plugin strips markdown anyway): plain `sendMessage` shows a table as a wall of `|`, and nothing
 * else agents write is unreadable that way. Turning markdown on for every message would change
 * how every answer reads, and Telegram's dialect is GFM PLUS extensions that make ordinary
 * prose fragile (`$5 and $10` is inline math, `a || b` a spoiler, `Promise<void>` an
 * unsupported HTML tag and therefore a parse error). So rich is the exception, and
 * `sanitizeBodyMarkdown` defangs exactly those extensions.
 *
 * Everything here is pure, and every "this cannot be sent rich" answer is `null`, which the
 * caller treats as "send plain, as before".
 */
import type { TgMessage } from "./telegram-message";

/** Telegram's documented limits for a rich message. */
export const RICH_MAX_CHARS = 32768;
export const RICH_MAX_BLOCKS = 500;
export const RICH_MAX_COLUMNS = 20;

/**
 * A GFM table delimiter row: `|---|:-:|`, `--- | ---` (Hermes's regex), or a one-column `|---|`,
 * which needs both outer pipes so a plain `---` rule is never read as one.
 */
const DELIMITER_ROW =
  /^\s*(?:\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?|\|\s*:?-+:?\s*\|)\s*$/;
/**
 * A fence opener, after any indentation and blockquote markers: fences under list items are
 * indented, fences in quotes carry `>`. A backtick fence's info string cannot contain a
 * backtick (CommonMark), so ```` ```npm test``` ```` at the start of a line is inline code,
 * not a fence that would swallow the rest of the message.
 */
const FENCE_OPEN = /^(?:[ \t]*>)*[ \t]*(?:(`{3,})(?![^`]*`)|(~{3,}))/;
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
/** A list item marker, which Telegram counts as two blocks (the item and its paragraph). */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

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
      fence = (open[1] ?? open[2])!;
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

  return lines;
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

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

/**
 * Characters Telegram's rich markdown does NOT take a backslash escape for, so they are
 * written as entities. Probed against the live API on 2026-11-02: `Promise\<void>` rendered as
 * `Promise\` with `<void>` silently dropped (read as an unsupported HTML tag), and `\&` kept
 * its backslash. `&lt;` and `&amp;` render as `<` and `&`. Every other escape used here
 * (`\$ \= \| \! \* \_ \> \# \~ \\ \[ \] \``) was probed and works. Not applied inside code,
 * where entities are not decoded.
 */
const ENTITY_SHAPED = /^&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9a-fA-F]+);/;
const ENTITY_ENCODED = new Map([
  ["<", "&lt;"],
  ["&", "&amp;"],
]);

/**
 * Escapes Telegram's non-GFM extensions in one line of prose, outside inline code spans:
 * `$` (math), `<` (HTML), `==` (marked) and, off table rows, `||` (spoiler). A table row keeps
 * `||` because there it is an empty cell. An existing backslash escape is copied as is.
 */
function escapeInline(line: string, inTable: boolean): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "\\" && i + 1 < line.length && ASCII_PUNCT.test(line[i + 1]!) && !ENTITY_ENCODED.has(line[i + 1]!)) {
      out += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (line[i + run] === "`") run++;
      const close = findBacktickRun(line, i + run, run);
      if (close === -1) {
        out += line.slice(i, i + run);
        i += run;
      } else {
        out += line.slice(i, close + run);
        i = close + run;
      }
      continue;
    }
    if (ch === "<") {
      out += "&lt;";
    } else if (ch === "&" && ENTITY_SHAPED.test(line.slice(i))) {
      // Only an `&` that would be decoded: a lone `&` (R&D, `?a=1&b=2` in a URL) already
      // renders as itself, and encoding it would break query strings in links.
      out += "&amp;";
    } else if (ch === "$") {
      out += "\\$";
    } else if (ch === "!" && line[i + 1] === "[") {
      // `![alt](url)` is a media block that Telegram fetches, and inline it is a parse error.
      out += "\\!";
    } else if (ch === "=" && (line[i + 1] === "=" || line[i - 1] === "=")) {
      out += "\\=";
    } else if (!inTable && ch === "|" && (line[i + 1] === "|" || line[i - 1] === "|")) {
      out += "\\|";
    } else {
      out += ch;
    }
    i++;
  }
  return out;
}

/** Index of the next backtick run of exactly `len` at or after `from`, or -1. */
function findBacktickRun(line: string, from: number, len: number): number {
  let i = from;
  while (i < line.length) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    let run = 1;
    while (line[i + run] === "`") run++;
    if (run === len) return i;
    i += run;
  }
  return -1;
}

/**
 * Prepares an agent's text for rich markdown:
 *
 * - escapes the Telegram extensions (see `escapeInline`) outside fenced and inline code;
 * - turns a lone newline into a hard break (`"  \n"`), because plain text showed every
 *   newline and markdown would otherwise fold consecutive lines into one paragraph. Not
 *   inside fences or tables, and not next to a fence line;
 * - puts a blank line before and after every table, so a table directly under a line of
 *   prose is not read as part of that paragraph, and a line directly under a table is not
 *   read as one more row;
 * - puts a blank line before a heading under a non-blank line, and after a quote line followed
 *   by an unquoted one. Probed: Telegram folds `- done\n# Heading` into the list item, and
 *   `> said\nreply` into the quote (lazy continuation), where plain text showed the `>`
 *   (pigeon-6mkr).
 */
export function sanitizeBodyMarkdown(text: string): string {
  const lines = classifyLines(text);
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out += line.fenced ? line.text : escapeInline(line.text, line.table);
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
  return out;
}

/** Characters escaped in pigeon's own (non-agent) text: header, footer. */
const MD_SPECIAL = /[\\`*_[\]<>|$=~#&!]/g;

function escapePlain(s: string): string {
  return s
    .replace(MD_SPECIAL, (c, i: number) =>
      c === "&" ? (ENTITY_SHAPED.test(s.slice(i)) ? "&amp;" : "&") : (ENTITY_ENCODED.get(c) ?? "\\" + c),
    )
    .replace(/\n/g, "  \n");
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
    out += escapePlain(msg.text.slice(pos, e.offset));
    const content = msg.text.slice(e.offset, e.offset + e.length);
    switch (e.type) {
      case "code":
        out += codeSpan(content);
        break;
      case "pre":
        out += codeBlock(content);
        break;
      case "bold":
        out += `**${escapePlain(content)}**`;
        break;
      case "italic":
        out += `_${escapePlain(content)}_`;
        break;
    }
    pos = e.offset + e.length;
  }
  out += escapePlain(msg.text.slice(pos));
  return out;
}

/**
 * Estimate of Telegram's block count, which includes nested blocks: every non-blank line
 * outside fences, list items twice (item plus paragraph), plus fences. An undercount costs
 * one rejected call and a plain fallback, not a lost message.
 */
function estimateBlocks(markdown: string): number {
  let blocks = 0;
  for (const line of classifyLines(markdown)) {
    if (line.fenceLine) blocks++;
    else if (!line.fenced && line.text.trim() !== "") blocks += LIST_ITEM.test(line.text) ? 2 : 1;
  }
  return blocks;
}

export interface BuildRichOptions {
  /**
   * Only offer rich when the body has a pipe table (the default, pigeon-p909). False for
   * goose turns, whose markdown is rendered whatever it contains (pigeon-6mkr).
   */
  requireTable?: boolean;
}

/**
 * The rich markdown for a notification, or null when it should go plain: no table in the
 * body (unless `requireTable` is false), a header/footer that cannot be converted, or any of
 * Telegram's limits exceeded. Layout matches the plain chunk: header, body, footer separated
 * by blank lines, empty parts skipped.
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
  const markdown = parts.join("\n\n");

  if ([...markdown].length > RICH_MAX_CHARS) return null;
  if (estimateBlocks(markdown) > RICH_MAX_BLOCKS) return null;
  return markdown;
}
