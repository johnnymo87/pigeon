/**
 * Slack rendering: pure functions from the Telegram-shaped message the daemon sends (text,
 * entities, an inline keyboard, optionally markdown) to Slack Block Kit. Bead pigeon-4ogz.3; plan
 * docs/plans/2026-11-20-slack-outbound-plan.md, "Rendering", and spec §4.
 *
 * Nothing here does I/O, so none of it needs a mock to test, and the transport can call it from
 * any send path.
 *
 * Two shapes of body, chosen by the caller:
 *  - rich_text: the plain text and its bold/italic/code/pre entities, rendered natively. The
 *    default, and what a message without markdown always gets.
 *  - markdown block: Slack's own markdown renderer, for messages the daemon sent as markdown.
 *    One cumulative limit (`SLACK_MARKDOWN_MAX`) applies, so an over-long body falls back to
 *    rich_text rather than being refused by Slack.
 * Either way the message also carries a plain `text`, which Slack shows in notifications and
 * search and which is the only thing a client without block support renders.
 */

export type SlackBlock = { type: string; [key: string]: unknown };

/** Slack's cumulative limit for markdown block text, in characters (code points). */
export const SLACK_MARKDOWN_MAX = 12000;

/** `chat.postMessage` text limit. Slack truncates beyond it, so this stays under it. */
const SLACK_TEXT_MAX = 40_000;

/** Slack allows 50 blocks in a message. */
const MAX_BLOCKS = 50;

/** Slack allows 25 elements in one actions block. */
const MAX_ACTION_ELEMENTS = 25;

/** Slack's limit for a button label (plain_text), in characters. */
const MAX_LABEL = 75;

interface TextStyle {
  bold?: true;
  italic?: true;
  code?: true;
}

interface NormalizedEntity {
  type: string;
  start: number;
  end: number;
}

const INLINE_STYLES: Record<string, keyof TextStyle> = { bold: "bold", italic: "italic", code: "code" };

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Moves a boundary that falls between the halves of a surrogate pair back to before the pair.
 * Telegram counts UTF-16 units, so a well-formed entity never lands inside one, but a split
 * would emit a lone surrogate that Slack may reject as invalid JSON text.
 */
function snap(text: string, index: number): number {
  if (index > 0 && index < text.length && isLowSurrogate(text.charCodeAt(index)) && isHighSurrogate(text.charCodeAt(index - 1))) {
    return index - 1;
  }
  return index;
}

/** A Telegram entity clamped to the text, or null when it is unusable (garbage, empty, off the end). */
function normalizeEntity(text: string, raw: unknown): NormalizedEntity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { type, offset, length } = raw as { type?: unknown; offset?: unknown; length?: unknown };
  if (typeof type !== "string" || typeof offset !== "number" || typeof length !== "number") return null;
  if (!Number.isFinite(offset) || !Number.isFinite(length)) return null;
  const first = Math.floor(offset);
  const start = snap(text, Math.max(0, first));
  const end = snap(text, Math.min(text.length, first + Math.floor(length)));
  return end > start ? { type, start, end } : null;
}

function sameStyle(a: TextStyle, b: TextStyle): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.code === b.code;
}

function textElement(text: string, style: TextStyle): Record<string, unknown> {
  return Object.keys(style).length > 0 ? { type: "text", text, style } : { type: "text", text };
}

/** Styled text elements for text[from, to): split at every entity boundary, equal neighbours merged. */
function styledElements(text: string, from: number, to: number, inline: Array<NormalizedEntity & { style: keyof TextStyle }>) {
  const points = new Set<number>([from, to]);
  for (const e of inline) {
    if (e.start > from && e.start < to) points.add(e.start);
    if (e.end > from && e.end < to) points.add(e.end);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const runs: Array<{ text: string; style: TextStyle }> = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    const style: TextStyle = {};
    for (const e of inline) {
      if (e.start <= a && e.end >= b) style[e.style] = true;
    }
    const piece = text.slice(a, b);
    if (piece === "") continue;
    const last = runs[runs.length - 1];
    if (last && sameStyle(last.style, style)) last.text += piece;
    else runs.push({ text: piece, style });
  }
  return runs.map((r) => textElement(r.text, r.style));
}

/**
 * Telegram text + entities as one `rich_text` block (`bold`, `italic`, `code`, `pre`; every other
 * entity type is ignored). Overlapping and nested inline entities are supported by segmenting at
 * every boundary. `pre` becomes a `rich_text_preformatted` between sections, and inline styles
 * inside it are dropped, as Telegram renders them. Offsets are UTF-16 code units, which is how
 * JavaScript indexes strings, so they are used as they are.
 *
 * Never emits an empty text element: empty text gives a block with no elements.
 */
export function entitiesToRichText(text: string, entities: ReadonlyArray<unknown> | undefined): SlackBlock {
  const normalized = (entities ?? []).map((e) => normalizeEntity(text, e)).filter((e): e is NormalizedEntity => e !== null);

  // Greedy, first-start-first: a pre that starts inside an earlier one is dropped.
  const pres: NormalizedEntity[] = [];
  for (const e of normalized.filter((n) => n.type === "pre").sort((a, b) => a.start - b.start)) {
    const last = pres[pres.length - 1];
    if (!last || e.start >= last.end) pres.push(e);
  }
  const inline = normalized
    .filter((n) => INLINE_STYLES[n.type] !== undefined)
    .map((n) => ({ ...n, style: INLINE_STYLES[n.type]! }));

  const elements: SlackBlock[] = [];
  const pushGap = (from: number, to: number, afterPre: boolean, beforePre: boolean) => {
    // The newline that separates a prose line from a code block belongs to the layout, and a
    // rich_text_preformatted already breaks the line, so keeping it would add a blank one.
    let start = from;
    let end = to;
    if (afterPre && text[start] === "\n") start++;
    if (beforePre && end > start && text[end - 1] === "\n") end--;
    if (end <= start) return;
    const runs = styledElements(text, start, end, inline);
    if (runs.length > 0) elements.push({ type: "rich_text_section", elements: runs });
  };

  let cursor = 0;
  pres.forEach((pre, i) => {
    pushGap(cursor, pre.start, i > 0, true);
    elements.push({ type: "rich_text_preformatted", elements: [{ type: "text", text: text.slice(pre.start, pre.end) }] });
    cursor = pre.end;
  });
  pushGap(cursor, text.length, pres.length > 0, false);

  return { type: "rich_text", elements };
}

/** Puts a user mention first in a rich_text block: in its first section when it starts with one. */
function withMention(block: SlackBlock, userId: string): SlackBlock {
  const elements = [...(block.elements as SlackBlock[])];
  const user = { type: "user", user_id: userId };
  const first = elements[0];
  if (first && first.type === "rich_text_section") {
    elements[0] = {
      ...first,
      elements: [user, { type: "text", text: " " }, ...(first.elements as unknown[])],
    };
  } else {
    elements.unshift({ type: "rich_text_section", elements: [user] });
  }
  return { ...block, elements };
}

function truncateLabel(label: string): string {
  const points = [...label];
  if (points.length === 0) return "(button)";
  return points.length > MAX_LABEL ? `${points.slice(0, MAX_LABEL - 1).join("")}…` : label;
}

/**
 * An inline keyboard as `actions` blocks, one per row (a row of more than 25 buttons is split).
 * A callback button carries its `callback_data` as the button `value`; a URL button carries its
 * `url`. `action_id` is `b<row>_<col>` by position in the ORIGINAL keyboard, so ids stay unique
 * across a split row. A button with neither is skipped. At most 50 blocks.
 */
export function keyboardToBlocks(replyMarkup: unknown): SlackBlock[] {
  const rows = (replyMarkup as { inline_keyboard?: unknown } | null | undefined)?.inline_keyboard;
  if (!Array.isArray(rows)) return [];
  const blocks: SlackBlock[] = [];
  rows.forEach((row: unknown, r: number) => {
    if (!Array.isArray(row)) return;
    const buttons: SlackBlock[] = [];
    row.forEach((raw: unknown, c: number) => {
      if (typeof raw !== "object" || raw === null) return;
      const { text, callback_data, url } = raw as { text?: unknown; callback_data?: unknown; url?: unknown };
      const target =
        typeof callback_data === "string" && callback_data !== ""
          ? { value: callback_data }
          : typeof url === "string" && url !== ""
            ? { url }
            : null;
      if (!target) return;
      buttons.push({
        type: "button",
        action_id: `b${r}_${c}`,
        text: { type: "plain_text", text: truncateLabel(typeof text === "string" ? text : ""), emoji: true },
        ...target,
      });
    });
    for (let i = 0; i < buttons.length; i += MAX_ACTION_ELEMENTS) {
      blocks.push({ type: "actions", elements: buttons.slice(i, i + MAX_ACTION_ELEMENTS) });
    }
  });
  return blocks.slice(0, MAX_BLOCKS);
}

/** Slack's markdown block (GFM-ish, rendered by Slack). Subject to `SLACK_MARKDOWN_MAX`. */
export function markdownBlock(md: string): SlackBlock {
  return { type: "markdown", text: md };
}

export interface BuildSlackMessageOptions {
  /** The plain text. The fallback `text` and, with no usable markdown, the rich_text body. */
  text: string;
  entities?: ReadonlyArray<unknown>;
  replyMarkup?: unknown;
  /** When present and within the limit, the body is a markdown block instead of rich_text. */
  markdown?: string;
  ownerUserId?: string;
  /** Mention `ownerUserId` so Slack notifies them. */
  notifyOwner?: boolean;
}

export interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
}

/** Slack user ids are upper-case alphanumerics. Anything else is not put inside `<@…>`. */
const USER_ID_RE = /^[A-Z0-9]{2,}$/;

/**
 * Pigeon never broadcasts. Slack turns `<!channel>`, `<!here>`, `<!everyone>` (and a user group,
 * `<!subteam^…>`) into a mention of many people, and its markdown renderer may also turn a bare
 * `@channel` / `@here` / `@everyone` into one. Both are defused with a zero-width joiner, which
 * keeps the text readable and stops it matching.
 */
const ZWJ = "\u200d";

function neutralizeBroadcast(text: string): string {
  return text
    .replace(/<!(?=\s*(?:channel|here|everyone|subteam))/gi, `<${ZWJ}!`)
    .replace(/(?<![A-Za-z0-9_.])@(?=(?:channel|here|everyone)(?![A-Za-z0-9_]))/gi, `@${ZWJ}`);
}

export function escapeMrkdwn(text: string): string {
  return neutralizeBroadcast(text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
}

/** Caps text at `SLACK_TEXT_MAX` without leaving half a surrogate pair or half an `&amp;`. */
function capText(text: string): string {
  if (text.length <= SLACK_TEXT_MAX) return text;
  let cut = text.slice(0, SLACK_TEXT_MAX);
  if (isHighSurrogate(cut.charCodeAt(cut.length - 1))) cut = cut.slice(0, -1);
  return cut.replace(/&(?:a(?:m(?:p)?)?|l(?:t)?|g(?:t)?)?$/, "");
}

function codePointLengthAtMost(text: string, limit: number): boolean {
  // A string of N code points has between N and 2N UTF-16 units, so only the middle needs counting.
  if (text.length <= limit) return true;
  if (text.length > limit * 2) return false;
  return [...text].length <= limit;
}

/**
 * The `{text, blocks}` for one Slack post. Max 50 blocks: the body and mention take priority and
 * the keyboard is trimmed to fit. `text` is never empty, because Slack answers `no_text` to a
 * message with neither text nor a renderable body, and a blocks-only message has no notification
 * preview.
 */
export function buildSlackMessage(options: BuildSlackMessageOptions): SlackMessage {
  const mention =
    options.notifyOwner === true && typeof options.ownerUserId === "string" && USER_ID_RE.test(options.ownerUserId)
      ? options.ownerUserId
      : null;

  const fallback = capText(`${mention ? `<@${mention}> ` : ""}${escapeMrkdwn(options.text)}`);

  const md = options.markdown;
  const useMarkdown = typeof md === "string" && md.trim() !== "" && codePointLengthAtMost(md, SLACK_MARKDOWN_MAX);

  const lead: SlackBlock[] = [];
  if (useMarkdown) {
    if (mention) lead.push({ type: "section", text: { type: "mrkdwn", text: `<@${mention}>` } });
    lead.push(markdownBlock(neutralizeBroadcast(md)));
  } else {
    let rich = entitiesToRichText(options.text, options.entities);
    if (mention) rich = withMention(rich, mention);
    if ((rich.elements as unknown[]).length > 0) lead.push(rich);
  }

  const actions = keyboardToBlocks(options.replyMarkup).slice(0, Math.max(0, MAX_BLOCKS - lead.length));
  return { text: fallback === "" ? "(no text)" : fallback, blocks: [...lead, ...actions] };
}
