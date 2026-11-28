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
      element: {
        type: "plain_text_input";
        action_id: string;
        multiline: boolean;
        initial_value?: string;
      };
    }
  | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> };

/** Slack Block Kit limit for plain_text_input.initial_value. */
export const SLACK_INPUT_INITIAL_VALUE_MAX = 3000;

export function clampInitialValue(
  text: string,
  max = SLACK_INPUT_INITIAL_VALUE_MAX,
): string {
  if (text.length <= max) return text;
  let cut = Math.max(0, max - 1);
  if (cut > 0 && cut < text.length) {
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      cut--;
    }
  }
  return text.slice(0, cut) + "…";
}

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

/** Splits text into surrogate-pair-safe chunks of at most `max` UTF-16 code units. */
export function splitSurrogateSafe(text: string, max = SLACK_INPUT_INITIAL_VALUE_MAX): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(text.length, pos + max);
    if (end < text.length && end > pos) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        end--;
      }
    }
    if (end === pos) {
      end = Math.min(text.length, pos + 2);
    }
    chunks.push(text.slice(pos, end));
    pos = end;
  }
  return chunks;
}

/**
 * Packs notes into ≤max-char boxes separated by blank lines ("\n\n"), breaking at note
 * boundaries first and only splitting within a note when a single note exceeds `max`.
 */
export function splitNotesIntoBoxes(
  notes: string[],
  max = SLACK_INPUT_INITIAL_VALUE_MAX,
): string[] {
  const boxes: string[] = [];
  let current = "";
  for (const raw of notes) {
    const note = raw.trim();
    if (!note) continue;
    const pieces = splitSurrogateSafe(note, max);
    for (const piece of pieces) {
      if (!current) {
        current = piece;
      } else if (current.length + 2 + piece.length <= max) {
        current += "\n\n" + piece;
      } else {
        boxes.push(current);
        current = piece;
      }
    }
  }
  if (current) boxes.push(current);
  return boxes;
}

/** Returns block_ids for general boxes: "general", "general2", "general3", ... */
export function generalBlockId(index: number): string {
  return index === 0 ? "general" : `general${index + 1}`;
}

export function buildAnswerModal(
  quoteId: string,
  channelId: string,
  stored: StoredQuote,
): SlackView {
  const headerBlocks: SlackModalBlock[] = [];
  if (typeof stored.notesRaw === "string" && stored.notesRaw.trim() !== "") {
    const rawLines = stored.notesRaw
      .trim()
      .split("\n")
      .map((l) => (l ? `> ${escapeMrkdwn(l)}` : ">"));
    const noteSections = splitPassageIntoSections(["*Your notes as typed:*", ...rawLines]);
    for (const text of noteSections) {
      headerBlocks.push({ type: "section", text: { type: "mrkdwn", text } });
    }
  }

  // Pre-build each passage's blocks and collect any >3000-char prefill tails so nothing is cut off.
  const preparedPassages: Array<{
    blocks: SlackModalBlock[];
    overflowTail?: string;
    fullPrefill?: string;
  }> = [];

  for (let idx = 0; idx < stored.passages.length; idx++) {
    const i = idx + 1;
    const passage = stored.passages[idx]!;

    const cleanHeader = escapeMrkdwn(passage.header.replace(/^#\s*/, ""));
    const headerLine = passage.first ? `*[${i}]* ${cleanHeader}` : `*[${i}]* …`;
    const quoteLines = passage.lines.map((l) => (l ? `> ${escapeMrkdwn(l)}` : ">"));
    const passageLines = [headerLine, ...quoteLines];

    const sectionTexts = splitPassageIntoSections(passageLines);
    const hasPrefill = typeof passage.prefill === "string" && passage.prefill.trim() !== "";
    let initialValue: string | undefined;
    let overflowTail: string | undefined;
    if (hasPrefill) {
      const pieces = splitSurrogateSafe(passage.prefill!, SLACK_INPUT_INITIAL_VALUE_MAX);
      initialValue = pieces[0];
      if (pieces.length > 1) {
        overflowTail = `[cont. of #${i}] ${pieces.slice(1).join("")}`;
      }
    }

    const passageBlocks: SlackModalBlock[] = [
      ...sectionTexts.map((text) => ({
        type: "section" as const,
        text: { type: "mrkdwn" as const, text },
      })),
      {
        type: "input" as const,
        block_id: `a${i}`,
        optional: true,
        label: {
          type: "plain_text" as const,
          text: hasPrefill ? `Your answer to [${i}] (draft from notes)` : `Your answer to [${i}]`,
        },
        element: {
          type: "plain_text_input" as const,
          action_id: "answer",
          multiline: true,
          ...(initialValue !== undefined ? { initial_value: initialValue } : {}),
        },
      },
    ];
    preparedPassages.push({
      blocks: passageBlocks,
      overflowTail,
      fullPrefill: hasPrefill ? passage.prefill : undefined,
    });
  }

  const baseUnmatched = [...(stored.unmatchedNotes ?? [])].filter((n) => n.trim() !== "");

  // Greedily add passages while reserving exact space for the overflow context note + all general boxes.
  const addedPassages: typeof preparedPassages = [];
  let passageBlockCount = 0;

  const computeTailBlocks = (includedCount: number): {
    overflowBlock: SlackModalBlock | null;
    generalBlocks: SlackModalBlock[];
  } => {
    const notesForGeneral = [...baseUnmatched];
    for (let idx = 0; idx < includedCount; idx++) {
      const tail = preparedPassages[idx]!.overflowTail;
      if (tail) notesForGeneral.push(tail);
    }
    for (let idx = includedCount; idx < preparedPassages.length; idx++) {
      const fp = preparedPassages[idx]!.fullPrefill;
      if (fp) notesForGeneral.push(fp);
    }
    const boxes = splitNotesIntoBoxes(notesForGeneral, SLACK_INPUT_INITIAL_VALUE_MAX);
    const generalBlocks: SlackModalBlock[] = boxes.map((box, bIdx) => ({
      type: "input",
      block_id: generalBlockId(bIdx),
      optional: true,
      label: {
        type: "plain_text",
        text:
          boxes.length === 1
            ? "Other notes (unmatched)"
            : `Other notes (unmatched, ${bIdx + 1}/${boxes.length})`,
      },
      element: {
        type: "plain_text_input",
        action_id: "answer",
        multiline: true,
        initial_value: box,
      },
    }));
    const overflowBlock: SlackModalBlock | null =
      includedCount < stored.total
        ? {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `Passages ${includedCount + 1}–${stored.total} are not shown; answer them in the thread.`,
              },
            ],
          }
        : null;
    return { overflowBlock, generalBlocks };
  };

  for (let idx = 0; idx < preparedPassages.length; idx++) {
    const candidateCount = idx + 1;
    const candidatePassageBlocks = passageBlockCount + preparedPassages[idx]!.blocks.length;
    const { overflowBlock, generalBlocks } = computeTailBlocks(candidateCount);
    const totalBlocks =
      headerBlocks.length +
      candidatePassageBlocks +
      (overflowBlock ? 1 : 0) +
      generalBlocks.length;
    if (totalBlocks > 100) {
      break;
    }
    addedPassages.push(preparedPassages[idx]!);
    passageBlockCount = candidatePassageBlocks;
  }

  const { overflowBlock, generalBlocks } = computeTailBlocks(addedPassages.length);
  const blocks: SlackModalBlock[] = [
    ...headerBlocks,
    ...addedPassages.flatMap((p) => p.blocks),
    ...(overflowBlock ? [overflowBlock] : []),
    ...generalBlocks,
  ];

  // Safety guard: even if headerBlocks + generalBlocks alone somehow exceed 100 (e.g. huge notesRaw),
  // keep all general boxes and drop trailing header sections rather than failing views.open.
  while (blocks.length > 100 && headerBlocks.length > 0) {
    blocks.splice(headerBlocks.length - 1, 1);
    headerBlocks.pop();
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

export function composeAnswer(
  stored: StoredQuote,
  answers: Map<number, string>,
  generalAnswer?: string,
): string | null {
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

  if (generalAnswer && generalAnswer.trim() !== "") {
    const trimmed = generalAnswer.trimEnd();
    if (parts.length > 0) {
      parts.push(`# Other notes\n${trimmed}`);
    } else {
      parts.push(trimmed);
    }
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
