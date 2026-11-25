import { escapeMrkdwn } from "./chat/slack-render";
import type { StoredQuote } from "./slack-quotes";

export interface SlackView {
  type: string;
  callback_id: string;
  private_metadata: string;
  title: { type: string; text: string };
  submit?: { type: string; text: string };
  close?: { type: string; text: string };
  blocks: SlackModalBlock[];
}

export type SlackModalBlock =
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | {
      type: "input";
      block_id: string;
      optional: boolean;
      label: { type: "plain_text"; text: string };
      element: { type: "plain_text_input"; action_id: string; multiline: boolean };
    }
  | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> };

function splitPassageIntoSections(lines: string[]): string[] {
  const sections: string[] = [];
  let current = "";
  for (const line of lines) {
    if (!current) {
      if (line.length > 3000) {
        for (let j = 0; j < line.length; j += 3000) {
          sections.push(line.slice(j, j + 3000));
        }
      } else {
        current = line;
      }
    } else {
      if (current.length + 1 + line.length <= 3000) {
        current += "\n" + line;
      } else {
        sections.push(current);
        if (line.length > 3000) {
          for (let j = 0; j < line.length; j += 3000) {
            sections.push(line.slice(j, j + 3000));
          }
          current = "";
        } else {
          current = line;
        }
      }
    }
  }
  if (current) {
    sections.push(current);
  }
  return sections;
}

export function buildAnswerModal(
  quoteId: string,
  channelId: string,
  stored: StoredQuote,
): SlackView {
  const blocks: SlackModalBlock[] = [];
  let lastAddedPassage = 0;

  for (let idx = 0; idx < stored.passages.length; idx++) {
    const i = idx + 1;
    const passage = stored.passages[idx]!;

    const cleanHeader = escapeMrkdwn(passage.header.replace(/^#\s*/, ""));
    const headerLine = passage.first ? `*[${i}]* ${cleanHeader}` : `*[${i}]* …`;
    const quoteLines = passage.lines.map((l) => (l ? `> ${escapeMrkdwn(l)}` : ">"));
    const passageLines = [headerLine, ...quoteLines];

    const sectionTexts = splitPassageIntoSections(passageLines);
    const passageBlocks: SlackModalBlock[] = [
      ...sectionTexts.map((text) => ({
        type: "section" as const,
        text: { type: "mrkdwn" as const, text },
      })),
      {
        type: "input" as const,
        block_id: `a${i}`,
        optional: true,
        label: { type: "plain_text" as const, text: `Your answer to [${i}]` },
        element: {
          type: "plain_text_input" as const,
          action_id: "answer",
          multiline: true,
        },
      },
    ];

    if (blocks.length + passageBlocks.length > 99) {
      break;
    }

    blocks.push(...passageBlocks);
    lastAddedPassage = i;
  }

  if (lastAddedPassage < stored.total) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Passages ${lastAddedPassage + 1}–${stored.total} are not shown; answer them in the thread.`,
        },
      ],
    });
  }

  return {
    type: "modal",
    callback_id: "quote_answer",
    private_metadata: JSON.stringify({ quoteId, channelId }),
    title: { type: "plain_text", text: "Answer quote" },
    submit: { type: "plain_text", text: "Send" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

function elidePassageLines(rawLines: string[]): string[] {
  const totalChars = rawLines.reduce((sum, l) => sum + l.length, 0);
  if (rawLines.length <= 12 && totalChars <= 1500) {
    return rawLines;
  }

  let kept: Array<{ line: string; isEllipsis?: boolean }>;
  if (rawLines.length > 8) {
    kept = [
      ...rawLines.slice(0, 4).map((line) => ({ line })),
      { line: "…", isEllipsis: true },
      ...rawLines.slice(-4).map((line) => ({ line })),
    ];
  } else {
    kept = rawLines.map((line) => ({ line }));
  }

  const currentChars = kept.reduce((sum, k) => sum + k.line.length, 0);
  if (currentChars > 1500) {
    kept = kept.map((k) => {
      if (k.isEllipsis) return k;
      if (k.line.length > 180) {
        return { line: k.line.slice(0, 180) + "…" };
      }
      return k;
    });
  }

  return kept.map((k) => k.line);
}

export function composeAnswer(stored: StoredQuote, answers: Map<number, string>): string | null {
  const parts: string[] = [];
  let lastHeaderWritten: string | null = null;

  for (let idx = 0; idx < stored.passages.length; idx++) {
    const i = idx + 1;
    const rawAnswer = answers.get(i);
    if (!rawAnswer || rawAnswer.trim() === "") continue;

    const answer = rawAnswer.trimEnd();
    const passage = stored.passages[idx]!;

    const lines: string[] = [];
    if (passage.header !== lastHeaderWritten) {
      lines.push(passage.header);
      lastHeaderWritten = passage.header;
    }

    const passageLines = elidePassageLines(passage.lines);
    for (const line of passageLines) {
      lines.push(line ? `> ${line}` : ">");
    }
    lines.push(answer);

    parts.push(lines.join("\n"));
  }

  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

function findSplitPoint(slice: string, budget: number): { cutPoint: number; sepLen: number } {
  const window = slice.slice(0, budget);

  // 1. Paragraph break (\n\n)
  const paraIdx = window.lastIndexOf("\n\n");
  if (paraIdx > 0) {
    return { cutPoint: paraIdx, sepLen: 2 };
  }

  // 2. Line break (\n)
  const lineIdx = window.lastIndexOf("\n");
  if (lineIdx > 0) {
    return { cutPoint: lineIdx, sepLen: 1 };
  }

  // 3. Sentence break (". ")
  const sentIdx = window.lastIndexOf(". ");
  if (sentIdx > 0) {
    return { cutPoint: sentIdx + 1, sepLen: 1 };
  }

  // 4. Hard cut at budget
  let cutPoint = budget;
  if (cutPoint > 0 && cutPoint < slice.length) {
    const code = slice.charCodeAt(cutPoint - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      cutPoint--;
    }
  }
  if (cutPoint === 0) {
    cutPoint = Math.min(slice.length, slice.charCodeAt(0) >= 0xd800 && slice.charCodeAt(0) <= 0xdbff ? 2 : 1);
  }
  return { cutPoint, sepLen: 0 };
}

/**
 * Splits quote copy text into chunks of at most maxChunkLen (default 3500) characters,
 * cutting at line boundaries (\n\n, \n, sentence . , or hard cut) without splitting surrogate pairs.
 * The first chunk is prefixed with `firstPrefix` (e.g. `🧑 via /quote\n`).
 */
export function splitCopyPost(
  text: string,
  firstPrefix = "🧑 via /quote\n",
  maxChunkLen = 3500,
): string[] {
  if (firstPrefix.length + text.length <= maxChunkLen) {
    return [`${firstPrefix}${text}`];
  }

  const chunks: string[] = [];
  let pos = 0;
  let isFirst = true;

  while (pos < text.length) {
    const prefix = isFirst ? firstPrefix : "";
    const budget = Math.max(1, maxChunkLen - prefix.length);
    const remaining = text.slice(pos);

    if (remaining.length <= budget) {
      chunks.push(`${prefix}${remaining}`);
      break;
    }

    const { cutPoint, sepLen } = findSplitPoint(remaining, budget);
    const chunkText = remaining.slice(0, cutPoint);
    chunks.push(`${prefix}${chunkText}`);

    pos += cutPoint + sepLen;
    isFirst = false;
  }

  return chunks;
}
