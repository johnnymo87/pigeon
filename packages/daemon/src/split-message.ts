/**
 * Split a Telegram notification into multiple TgMessages that each fit within maxLen.
 *
 * Each chunk is formatted as: header + "\n\n" + bodyChunk + "\n\n" + footer
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

export function splitTelegramMessage(
  header: TgMessage,
  body: TgMessage,
  footer: TgMessage,
  maxLen = 4096,
): TgMessage[] {
  const overhead = header.text.length + footer.text.length + SEP.text.length * 2;
  const maxBody = maxLen - overhead;

  if (maxBody <= 0 || body.text.length <= maxBody) {
    // Single message: concatenate header + "\n\n" + body + "\n\n" + footer
    return [concatMessages([header, SEP, body, SEP, footer])];
  }

  // Split the body text into chunks at natural boundaries
  const bodyChunks = splitBodyText(body.text, maxBody);

  return bodyChunks.map((chunk) => {
    const chunkMsg = sliceBodyMessage(body, chunk.start, chunk.end);
    return concatMessages([header, SEP, chunkMsg, SEP, footer]);
  });
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

    // Advance past the cut point (including separators)
    pos = pos + cutPoint;
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
 */
function sliceBodyMessage(body: TgMessage, start: number, end: number): TgMessage {
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
