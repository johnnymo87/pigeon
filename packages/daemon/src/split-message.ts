/**
 * Split a Telegram notification into multiple messages that each fit within maxLen.
 *
 * Each chunk is formatted as: header + "\n\n" + bodyChunk + "\n\n" + footer
 *
 * Body is split at natural boundaries in priority order:
 * 1. Paragraph break (\n\n)
 * 2. Line break (\n)
 * 3. Sentence end (". ")
 * 4. Hard cut at maxBody
 */
export function splitTelegramMessage(
  header: string,
  body: string,
  footer: string,
  maxLen = 4096,
): string[] {
  const JOIN = "\n\n";
  const overhead = header.length + footer.length + JOIN.length * 2;
  const maxBody = maxLen - overhead;

  if (maxBody <= 0) {
    // Edge case: header+footer alone exceed maxLen. Send as-is.
    return [header + JOIN + body + JOIN + footer];
  }

  if (body.length <= maxBody) {
    return [header + JOIN + body + JOIN + footer];
  }

  const chunks: string[] = [];
  let remaining = body;

  while (remaining.length > 0) {
    if (remaining.length <= maxBody) {
      chunks.push(remaining);
      break;
    }

    const cutPoint = findSplitPoint(remaining, maxBody);
    let chunk = remaining.slice(0, cutPoint);
    remaining = remaining.slice(cutPoint);

    // Trim trailing separator from the chunk (may occur on hard cuts landing at \n)
    if (chunk.endsWith("\n\n")) {
      chunk = chunk.slice(0, -2);
    } else if (chunk.endsWith("\n")) {
      chunk = chunk.slice(0, -1);
    }

    chunks.push(chunk);

    // Trim leading separator or space from next chunk
    if (remaining.startsWith("\n\n")) {
      remaining = remaining.slice(2);
    } else if (remaining.startsWith("\n")) {
      remaining = remaining.slice(1);
    } else if (remaining.startsWith(" ")) {
      remaining = remaining.slice(1);
    }
  }

  return chunks.map((chunk) => header + JOIN + chunk + JOIN + footer);
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
