/**
 * Split a Telegram notification into multiple TgMessages that each fit within maxLen.
 *
 * Each chunk is formatted as: header + "\n\n" + bodyChunk + "\n\n" + footer
 *
 * Header and footer are truncated as needed if overhead crowds out the body budget below minBodyBudget.
 * Header is truncated first (least load-bearing); footer is truncated second (routing metadata at top preserved).
 *
 * Guarantees two hard invariants:
 * 1. Every returned chunk satisfies text.length <= maxLen.
 * 2. Chunk count is bounded by ~ceil(bodyLength / minBodyBudget) for all inputs.
 * 3. UTF-16 surrogate pairs (e.g. emoji) are never split across chunks or truncation boundaries.
 *
 * Body is split at natural boundaries in priority order:
 * 1. Paragraph break (\n\n)
 * 2. Line break (\n)
 * 3. Sentence end (". ")
 * 4. Hard cut at maxBody
 *
 * Entities are offset-adjusted to reflect their positions in the combined message.
 * Body entities that span a split boundary are clipped to the chunk end.
 */
import type { TgMessage, TgEntity } from "./telegram-message";
import { concatMessages } from "./telegram-message";

const SEP: TgMessage = { text: "\n\n", entities: [] };
const MIN_BODY_BUDGET = 200;

export function splitTelegramMessage(
  header: TgMessage,
  body: TgMessage,
  footer: TgMessage,
  maxLen = 4096,
): TgMessage[] {
  // Scale minBodyBudget with maxLen so small maxLen test cases (e.g. maxLen = 26 where overhead = 16 leaves maxBody = 10)
  // are not broken by a floor of 13 (maxLen / 2). Using maxLen / 4 gives minBodyBudget = 6 for maxLen = 26, leaving 10 >= 6
  // without triggering unwanted header truncation. For standard maxLen = 4096, minBodyBudget evaluates to 200.
  const minBodyBudget = Math.min(MIN_BODY_BUDGET, Math.floor(maxLen / 4));
  let currentHeader = header;
  let currentFooter = footer;
  let overhead = currentHeader.text.length + currentFooter.text.length + SEP.text.length * 2;
  let maxBody = maxLen - overhead;

  // 1. Truncate header if overhead crowds out body budget below minBodyBudget
  if (maxBody < minBodyBudget && currentHeader.text.length > 0) {
    const allowedHeaderLen = Math.max(
      0,
      maxLen - minBodyBudget - currentFooter.text.length - SEP.text.length * 2,
    );
    if (currentHeader.text.length > allowedHeaderLen) {
      currentHeader = sliceBodyMessage(currentHeader, 0, allowedHeaderLen);
      overhead = currentHeader.text.length + currentFooter.text.length + SEP.text.length * 2;
      maxBody = maxLen - overhead;
    }
  }

  // 2. Truncate footer if overhead still crowds out body budget (pathological footer)
  if (maxBody < minBodyBudget && currentFooter.text.length > 0) {
    const allowedFooterLen = Math.max(
      0,
      maxLen - currentHeader.text.length - minBodyBudget - SEP.text.length * 2,
    );
    if (currentFooter.text.length > allowedFooterLen) {
      // Note: session ID sits near the top of the footer (after cwd), so truncating from 0 to allowedFooterLen
      // preserves routing metadata at the start of the footer while dropping any pathological tail.
      currentFooter = sliceBodyMessage(currentFooter, 0, allowedFooterLen);
      overhead = currentHeader.text.length + currentFooter.text.length + SEP.text.length * 2;
      maxBody = maxLen - overhead;
    }
  }

  let result: TgMessage[];

  if (maxBody > 0 && body.text.length <= maxBody) {
    result = [concatMessages([currentHeader, SEP, body, SEP, currentFooter])];
  } else {
    const bodyChunks = splitBodyText(body.text, maxBody);
    result = bodyChunks.map((chunk) => {
      const chunkMsg = sliceBodyMessage(body, chunk.start, chunk.end);
      return concatMessages([currentHeader, SEP, chunkMsg, SEP, currentFooter]);
    });
  }

  // Final safety clamp: ensure no chunk exceeds maxLen (belt and braces)
  return result.map((msg) =>
    msg.text.length > maxLen ? sliceBodyMessage(msg, 0, maxLen) : msg,
  );
}

/**
 * Represents a text range [start, end) within the body text.
 */
interface TextRange {
  start: number;
  end: number;
}

/**
 * Split body text into ranges at natural boundaries.
 */
function splitBodyText(text: string, maxBody: number): TextRange[] {
  if (maxBody <= 0) return [{ start: 0, end: text.length }];

  const ranges: TextRange[] = [];
  let pos = 0;

  while (pos < text.length) {
    if (text.length - pos <= maxBody) {
      ranges.push({ start: pos, end: text.length });
      break;
    }

    const remaining = text.slice(pos);
    const cutPoint = findSplitPoint(remaining, maxBody);
    let chunkEnd = pos + cutPoint;
    let nextPos = pos + cutPoint;

    // Adjust chunkEnd if it cuts between a high and low surrogate
    if (chunkEnd > pos && chunkEnd < text.length) {
      const c = text.charCodeAt(chunkEnd - 1);
      if (c >= 0xd800 && c <= 0xdbff) {
        chunkEnd--;
        nextPos = chunkEnd;
      }
    }

    // Trim trailing separator from chunk
    let chunk = text.slice(pos, chunkEnd);
    if (chunk.endsWith("\n\n")) {
      chunk = chunk.slice(0, -2);
      chunkEnd = pos + chunk.length;
    } else if (chunk.endsWith("\n")) {
      chunk = chunk.slice(0, -1);
      chunkEnd = pos + chunk.length;
    }

    ranges.push({ start: pos, end: chunkEnd });

    // Advance past cut point or adjusted position
    pos = nextPos;
    // Trim leading separator or space from next chunk
    if (text.slice(pos).startsWith("\n\n")) {
      pos += 2;
    } else if (text.slice(pos).startsWith("\n")) {
      pos += 1;
    } else if (text.slice(pos).startsWith(" ")) {
      pos += 1;
    }
  }

  return ranges;
}

/**
 * Slice a TgMessage to the character range [start, end), adjusting entity offsets.
 * Entities that start before end and finish after end are clipped to end.
 * Entities that start at or after end are dropped.
 *
 * Guarantees that neither start nor end splits a UTF-16 surrogate pair.
 */
function sliceBodyMessage(body: TgMessage, start: number, end: number): TgMessage {
  // Prevent splitting surrogate pairs at end
  if (end > start && end < body.text.length) {
    const c = body.text.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end--;
  }
  // Prevent splitting surrogate pairs at start
  if (start > 0 && start < end) {
    const c = body.text.charCodeAt(start);
    if (c >= 0xdc00 && c <= 0xdfff) start++;
  }

  const text = body.text.slice(start, end);
  const entities: TgEntity[] = [];

  for (const e of body.entities) {
    const entityEnd = e.offset + e.length;
    // Entity is entirely before the slice or entirely after it — skip
    if (e.offset >= end || entityEnd <= start) continue;
    // Clip to chunk boundaries
    const clippedStart = Math.max(e.offset, start);
    const clippedEnd = Math.min(entityEnd, end);
    entities.push({
      offset: clippedStart - start,
      length: clippedEnd - clippedStart,
      type: e.type,
    });
  }

  return { text, entities };
}

const MIN_CHUNK = 200;

function findSplitPoint(text: string, maxBody: number): number {
  // Don't start so far into the text that we collapse the search window to nothing
  const searchStart = Math.min(MIN_CHUNK, Math.floor(maxBody / 2));
  const window = text.slice(searchStart, maxBody);

  // 1. Paragraph break
  const paraIdx = window.lastIndexOf("\n\n");
  if (paraIdx !== -1) return searchStart + paraIdx;

  // 2. Line break
  const lineIdx = window.lastIndexOf("\n");
  if (lineIdx !== -1) return searchStart + lineIdx;

  // 3. Sentence end
  const sentIdx = window.lastIndexOf(". ");
  if (sentIdx !== -1) return searchStart + sentIdx + 1; // include the period

  // 4. Hard cut
  return maxBody;
}
