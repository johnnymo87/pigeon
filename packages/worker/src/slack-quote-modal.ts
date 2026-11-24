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

    for (const line of passage.lines) {
      lines.push(line ? `> ${line}` : ">");
    }
    lines.push(answer);

    parts.push(lines.join("\n"));
  }

  if (parts.length === 0) return null;
  return parts.join("\n\n");
}
