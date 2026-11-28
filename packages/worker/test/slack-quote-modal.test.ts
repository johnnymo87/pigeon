import { describe, it, expect } from "vitest";
import {
  buildAnswerModal,
  clampInitialValue,
  composeAnswer,
  SLACK_INPUT_INITIAL_VALUE_MAX,
  splitCopyPost,
} from "../src/slack-quote-modal";
import type { StoredQuote } from "../src/slack-quotes";

describe("buildAnswerModal", () => {
  it("builds modal view JSON for 1 passage", () => {
    const stored: StoredQuote = {
      v: 1,
      sessionId: "ses_1",
      passages: [
        {
          header: "# 11-24 13:05 (wake: mail) · ask",
          lines: ["first line", "second line"],
          first: true,
        },
      ],
      total: 1,
    };

    const view = buildAnswerModal("quote_123", "C_CHAN", stored);
    expect(view.type).toBe("modal");
    expect(view.callback_id).toBe("quote_answer");
    expect(view.private_metadata).toBe(JSON.stringify({ quoteId: "quote_123", channelId: "C_CHAN" }));
    expect(view.title).toEqual({ type: "plain_text", text: "Answer quote" });
    expect(view.submit).toEqual({ type: "plain_text", text: "Send" });
    expect(view.close).toEqual({ type: "plain_text", text: "Cancel" });

    // 1 section + 1 input = 2 blocks
    expect(view.blocks).toHaveLength(2);
    expect(view.blocks[0]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*[1]* 11-24 13:05 (wake: mail) · ask\n> first line\n> second line",
      },
    });
    expect(view.blocks[1]).toEqual({
      type: "input",
      block_id: "a1",
      optional: true,
      label: { type: "plain_text", text: "Your answer to [1]" },
      element: { type: "plain_text_input", action_id: "answer", multiline: true },
    });
  });

  it("builds modal view JSON for 3 passages with first/continuation headers", () => {
    const stored: StoredQuote = {
      v: 1,
      sessionId: "ses_3",
      passages: [
        {
          header: "# 11-24 13:05 (wake: mail) · ask",
          lines: ["reply 1 line 1"],
          first: true,
        },
        {
          header: "# 11-24 13:05 (wake: mail) · ask",
          lines: ["reply 1 line 2"],
          first: false,
        },
        {
          header: "# 11-24 13:10 (wake: check) · ask",
          lines: ["reply 2 line 1"],
          first: true,
        },
      ],
      total: 3,
    };

    const view = buildAnswerModal("quote_3p", "C_CHAN", stored);
    // 3 sections + 3 inputs = 6 blocks
    expect(view.blocks).toHaveLength(6);

    // Passage 1: first = true -> header without "# "
    expect(view.blocks[0]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*[1]* 11-24 13:05 (wake: mail) · ask\n> reply 1 line 1",
      },
    });
    expect(view.blocks[1]).toMatchObject({ type: "input", block_id: "a1" });

    // Passage 2: first = false -> *[2]* …
    expect(view.blocks[2]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*[2]* …\n> reply 1 line 2",
      },
    });
    expect(view.blocks[3]).toMatchObject({ type: "input", block_id: "a2" });

    // Passage 3: first = true -> header without "# "
    expect(view.blocks[4]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*[3]* 11-24 13:10 (wake: check) · ask\n> reply 2 line 1",
      },
    });
    expect(view.blocks[5]).toMatchObject({ type: "input", block_id: "a3" });
  });

  it("escapes mrkdwn special characters (&, <, >) in quote lines", () => {
    const stored: StoredQuote = {
      v: 1,
      sessionId: "ses_esc",
      passages: [
        {
          header: "# Header",
          lines: ["if (a < b && c > d) return true;"],
          first: true,
        },
      ],
      total: 1,
    };

    const view = buildAnswerModal("quote_esc", "C_CHAN", stored);
    expect(view.blocks[0]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*[1]* Header\n> if (a &lt; b &amp;&amp; c &gt; d) return true;",
      },
    });
  });

  it("escapes mrkdwn and defuses broadcasts in header and quote lines", () => {
    const stored: StoredQuote = {
      v: 1,
      sessionId: "ses_broadcast",
      passages: [
        {
          header: "# Announcement: <!channel> and @here & <test>",
          lines: [
            "Check <!everyone> now",
            "Also bare @channel and @here should defuse",
          ],
          first: true,
        },
      ],
      total: 1,
    };

    const view = buildAnswerModal("quote_bcast", "C_CHAN", stored);
    expect(view.blocks[0]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*[1]* Announcement: &lt;!channel&gt; and @\u200dhere &amp; &lt;test&gt;\n> Check &lt;!everyone&gt; now\n> Also bare @\u200dchannel and @\u200dhere should defuse",
      },
    });
  });

  it("splits a 7,000-character passage into sections of at most 3,000 characters", () => {
    // 70 lines of 100 characters each = 7,000 chars
    const lines = Array.from({ length: 70 }, (_, i) => `line ${i + 1}: ${"x".repeat(90)}`);
    const stored: StoredQuote = {
      v: 1,
      sessionId: "ses_long",
      passages: [
        {
          header: "# Header",
          lines,
          first: true,
        },
      ],
      total: 1,
    };

    const view = buildAnswerModal("quote_long", "C_CHAN", stored);
    // Find all section blocks before the input block
    const sectionBlocks = view.blocks.filter((b) => b.type === "section");
    const inputBlocks = view.blocks.filter((b) => b.type === "input");

    expect(sectionBlocks.length).toBeGreaterThan(1);
    expect(inputBlocks).toHaveLength(1);
    expect(inputBlocks[0]?.block_id).toBe("a1");

    // Every section block text must be <= 3000 chars
    for (const sec of sectionBlocks) {
      if (sec.type === "section") {
        expect(sec.text.text.length).toBeLessThanOrEqual(3000);
      }
    }
  });

  it("enforces block cap at 100 blocks when there are 60 passages", () => {
    const passages = Array.from({ length: 60 }, (_, i) => ({
      header: `# Header ${i + 1}`,
      lines: [`line for passage ${i + 1}`],
      first: true,
    }));
    const stored: StoredQuote = {
      v: 1,
      sessionId: "ses_60",
      passages,
      total: 60,
    };

    const view = buildAnswerModal("quote_60", "C_CHAN", stored);
    expect(view.blocks.length).toBeLessThanOrEqual(100);

    // Last block must be a context block explaining the omitted passages
    const lastBlock = view.blocks[view.blocks.length - 1];
    expect(lastBlock?.type).toBe("context");
    if (lastBlock?.type === "context") {
      const contextText = lastBlock.elements[0]?.text;
      expect(contextText).toMatch(/Passages \d+–60 are not shown; answer them in the thread\./);
    }
  });

  it("adds context block when stored.total exceeds passages length", () => {
    const stored: StoredQuote = {
      v: 1,
      sessionId: "ses_capped",
      passages: [
        {
          header: "# Header 1",
          lines: ["line 1"],
          first: true,
        },
        {
          header: "# Header 2",
          lines: ["line 2"],
          first: true,
        },
      ],
      total: 10, // Uncapped total is 10
    };

    const view = buildAnswerModal("quote_cap", "C_CHAN", stored);
    const lastBlock = view.blocks[view.blocks.length - 1];
    expect(lastBlock?.type).toBe("context");
    if (lastBlock?.type === "context") {
      expect(lastBlock.elements[0]?.text).toBe(
        "Passages 3–10 are not shown; answer them in the thread.",
      );
    }
  });
});

describe("composeAnswer", () => {
  const sampleStored: StoredQuote = {
    v: 1,
    sessionId: "ses_ans",
    passages: [
      {
        header: "# 11-24 13:05 (wake: mail) · ask",
        lines: ["line 1", "line 2"],
        first: true,
      },
      {
        header: "# 11-24 13:05 (wake: mail) · ask",
        lines: ["line 3", "", "line 4"],
        first: false,
      },
      {
        header: "# 11-24 13:10 (wake: check) · ask",
        lines: ["line 5"],
        first: true,
      },
    ],
    total: 3,
  };

  it("returns null when answers map is empty or all blank", () => {
    expect(composeAnswer(sampleStored, new Map())).toBe(null);
    expect(composeAnswer(sampleStored, new Map([[1, "   "], [2, ""]]))).toBe(null);
  });

  it("formats single answered passage", () => {
    const answers = new Map([[1, "my answer"]]);
    const text = composeAnswer(sampleStored, answers);
    expect(text).toBe(
      "# 11-24 13:05 (wake: mail) · ask\n" +
      "> line 1\n" +
      "> line 2\n" +
      "my answer",
    );
  });

  it("drops unanswered passages and keeps header for answered one", () => {
    // Only passage 2 answered
    const answers = new Map([[2, "answer to 2"]]);
    const text = composeAnswer(sampleStored, answers);
    expect(text).toBe(
      "# 11-24 13:05 (wake: mail) · ask\n" +
      "> line 3\n" +
      ">\n" +
      "> line 4\n" +
      "answer to 2",
    );
  });

  it("omits repeated header for consecutive answered passages from the same reply, and separates by blank line", () => {
    const answers = new Map([
      [1, "answer 1   "], // trailing whitespace to be trimmed
      [2, "answer 2"],
      [3, "answer 3"],
    ]);
    const text = composeAnswer(sampleStored, answers);
    const expected =
      "# 11-24 13:05 (wake: mail) · ask\n" +
      "> line 1\n" +
      "> line 2\n" +
      "answer 1\n\n" +
      "> line 3\n" +
      ">\n" +
      "> line 4\n" +
      "answer 2\n\n" +
      "# 11-24 13:10 (wake: check) · ask\n" +
      "> line 5\n" +
      "answer 3";
    expect(text).toBe(expected);
  });

  it("elides an answered passage longer than 12 lines to first 4, '> …', and last 4 lines", () => {
    const rawLines = Array.from({ length: 16 }, (_, i) => `line ${i + 1}`);
    const stored: StoredQuote = {
      v: 1,
      sessionId: "ses_long_lines",
      passages: [
        {
          header: "# 11-24 13:05 · ask",
          lines: rawLines,
          first: true,
        },
      ],
      total: 1,
    };
    const answers = new Map([[1, "my answer"]]);
    const text = composeAnswer(stored, answers);
    const expected =
      "# 11-24 13:05 · ask\n" +
      "> line 1\n" +
      "> line 2\n" +
      "> line 3\n" +
      "> line 4\n" +
      "> …\n" +
      "> line 13\n" +
      "> line 14\n" +
      "> line 15\n" +
      "> line 16\n" +
      "my answer";
    expect(text).toBe(expected);
  });

  it("elides an answered passage with <= 12 lines but > 1500 chars, truncating kept lines at ~180 chars if still over 1500 chars", () => {
    // 10 lines of 200 chars each = 2000 chars total (> 1500 chars, but <= 12 lines)
    const rawLines = Array.from({ length: 10 }, (_, i) => `L${i + 1}_${"x".repeat(195)}`);
    const stored: StoredQuote = {
      v: 1,
      sessionId: "ses_long_chars",
      passages: [
        {
          header: "# 11-24 13:05 · ask",
          lines: rawLines,
          first: true,
        },
      ],
      total: 1,
    };
    const answers = new Map([[1, "my answer"]]);
    const text = composeAnswer(stored, answers);

    // Kept lines are first 4 and last 4, plus '> …'
    // But 8 lines of 200 chars = 1600 chars > 1500 chars!
    // So kept lines longer than 180 chars must be truncated at 180 chars with "…"
    const expectedLine = (i: number) => `> ${`L${i + 1}_${"x".repeat(195)}`.slice(0, 180)}…`;
    const expected =
      "# 11-24 13:05 · ask\n" +
      `${expectedLine(0)}\n` +
      `${expectedLine(1)}\n` +
      `${expectedLine(2)}\n` +
      `${expectedLine(3)}\n` +
      "> …\n" +
      `${expectedLine(6)}\n` +
      `${expectedLine(7)}\n` +
      `${expectedLine(8)}\n` +
      `${expectedLine(9)}\n` +
      "my answer";
    expect(text).toBe(expected);
  });

  it("does not truncate lines at 180 chars if kept lines are <= 1500 chars", () => {
    // 14 lines of 50 chars each = 700 chars total (< 1500 chars, but > 12 lines)
    const rawLines = Array.from({ length: 14 }, (_, i) => `line ${i + 1}: ${"a".repeat(40)}`);
    const stored: StoredQuote = {
      v: 1,
      sessionId: "ses_14_short",
      passages: [
        {
          header: "# Header",
          lines: rawLines,
          first: true,
        },
      ],
      total: 1,
    };
    const answers = new Map([[1, "answer"]]);
    const text = composeAnswer(stored, answers);

    // Kept lines (8 lines * 49 chars = ~392 chars <= 1500) -> not truncated at 180
    expect(text).toContain(`> line 1: ${"a".repeat(40)}`);
    expect(text).toContain("> …\n> line 11:");
  });
});

describe("splitCopyPost", () => {
  it("returns a single chunk when firstPrefix + text <= maxChunkLen", () => {
    const text = "Short answer";
    const chunks = splitCopyPost(text);
    expect(chunks).toEqual(["🧑 via /quote\nShort answer"]);
  });

  it("splits at paragraph breaks when text exceeds maxChunkLen", () => {
    const para1 = "A".repeat(2000);
    const para2 = "B".repeat(2000);
    const text = `${para1}\n\n${para2}`;
    const chunks = splitCopyPost(text, "🧑 via /quote\n", 3500);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`🧑 via /quote\n${para1}`);
    expect(chunks[1]).toBe(para2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(3500);
    }
  });

  it("splits at line breaks when no paragraph break fits", () => {
    const line1 = "A".repeat(2000);
    const line2 = "B".repeat(2000);
    const text = `${line1}\n${line2}`;
    const chunks = splitCopyPost(text, "🧑 via /quote\n", 3500);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`🧑 via /quote\n${line1}`);
    expect(chunks[1]).toBe(line2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(3500);
    }
  });

  it("splits at sentence boundaries when no line break fits", () => {
    const sent1 = "A".repeat(2000) + ".";
    const sent2 = "B".repeat(2000);
    const text = `${sent1} ${sent2}`;
    const chunks = splitCopyPost(text, "🧑 via /quote\n", 3500);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`🧑 via /quote\n${sent1}`);
    expect(chunks[1]).toBe(sent2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(3500);
    }
  });

  it("hard cuts without splitting surrogate pairs", () => {
    // 4000 emoji chars (each 2 code units)
    const text = "😀".repeat(2000);
    const chunks = splitCopyPost(text, "🧑 via /quote\n", 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
      // Ensure no dangling surrogate
      expect(c).toBe(c.toWellFormed());
    }
  });

  it("supports custom prefix such as replaced coordinator note", () => {
    const prefix = "(the quoted session was replaced; sent to the current one)\n🧑 via /quote\n";
    const text = "A".repeat(2000) + "\n\n" + "B".repeat(2000);
    const chunks = splitCopyPost(text, prefix, 3500);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`${prefix}${"A".repeat(2000)}`);
    expect(chunks[1]).toBe("B".repeat(2000));
    expect(chunks[0]!.length).toBeLessThanOrEqual(3500);
    expect(chunks[1]!.length).toBeLessThanOrEqual(3500);
  });
});

describe("notes-guided modal prefill and unmatched notes", () => {
  it("sets initial_value on prefilled passages and omits it on unprefilled ones", () => {
    const stored: StoredQuote = {
      v: 1,
      sessionId: "gse_1",
      passages: [
        { header: "# H1", lines: ["q1"], first: true, prefill: "approve PR 264" },
        { header: "# H1", lines: ["q2"], first: false },
      ],
      total: 2,
    };
    const view = buildAnswerModal("q1", "C1", stored);
    const a1 = view.blocks.find((b) => b.type === "input" && b.block_id === "a1");
    const a2 = view.blocks.find((b) => b.type === "input" && b.block_id === "a2");
    expect(a1 && a1.type === "input" && a1.element.initial_value).toBe("approve PR 264");
    expect(a2 && a2.type === "input" && a2.element.initial_value).toBeUndefined();
    expect(view.blocks.find((b) => b.type === "input" && b.block_id === "general")).toBeUndefined();
  });

  it("clamps initial_value at Slack's 3000-char limit without splitting surrogate pairs", () => {
    const longEmoji = "😀".repeat(2000); // 4000 UTF-16 code units
    const clamped = clampInitialValue(longEmoji);
    expect(clamped.length).toBeLessThanOrEqual(SLACK_INPUT_INITIAL_VALUE_MAX);
    expect(clamped.endsWith("…")).toBe(true);
    expect(clamped).toBe(clamped.toWellFormed());
  });

  it("adds a prefilled 'general' input block for unmatchedNotes and stays <= 100 blocks", () => {
    const passages = Array.from({ length: 55 }, (_, i) => ({
      header: `# H${i + 1}`,
      lines: [`line ${i + 1}`],
      first: true,
      ...(i === 52 ? { prefill: "note on omitted passage 53" } : {}),
    }));
    const stored: StoredQuote = {
      v: 1,
      sessionId: "gse_1",
      passages,
      total: 55,
      unmatchedNotes: ["general thought 1", "general thought 2"],
    };
    const view = buildAnswerModal("q2", "C1", stored);
    expect(view.blocks.length).toBeLessThanOrEqual(100);
    const general = view.blocks.find((b) => b.type === "input" && b.block_id === "general");
    expect(general).toBeDefined();
    expect(general && general.type === "input" && general.element.initial_value).toBe(
      "general thought 1\n\ngeneral thought 2\n\nnote on omitted passage 53",
    );
  });

  it("shows notesRaw at the top and splits >3000-char notes across general + general2 without truncation", () => {
    const noteA = "A".repeat(2500);
    const noteB = "B".repeat(2500);
    const longPrefill = "P".repeat(3500);
    const stored: StoredQuote = {
      v: 1,
      sessionId: "gse_1",
      passages: [{ header: "# H1", lines: ["q1"], first: true, prefill: longPrefill }],
      total: 1,
      unmatchedNotes: [noteA, noteB],
      notesRaw: "original note 1\noriginal note 2",
    };
    const view = buildAnswerModal("q_split", "C1", stored);
    expect(view.blocks.length).toBeLessThanOrEqual(100);
    // First block is read-only raw notes
    expect(view.blocks[0]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Your notes as typed:*\n> original note 1\n> original note 2",
      },
    });
    const a1 = view.blocks.find((b) => b.type === "input" && b.block_id === "a1");
    expect(a1 && a1.type === "input" && a1.label.text).toContain("draft from notes");
    expect(a1 && a1.type === "input" && a1.element.initial_value?.length).toBe(3000);

    const g1 = view.blocks.find((b) => b.type === "input" && b.block_id === "general");
    const g2 = view.blocks.find((b) => b.type === "input" && b.block_id === "general2");
    const g3 = view.blocks.find((b) => b.type === "input" && b.block_id === "general3");
    expect(g1 && g1.type === "input" && g1.element.initial_value).toBe(noteA);
    expect(g2 && g2.type === "input" && g2.element.initial_value).toBe(noteB);
    expect(g3 && g3.type === "input" && g3.element.initial_value).toBe("[cont. of #1] " + "P".repeat(500));
  });

  it("supports empty passages when unmatchedNotes is non-empty", () => {
    const stored: StoredQuote = {
      v: 1,
      sessionId: "gse_1",
      passages: [],
      total: 0,
      unmatchedNotes: ["just send this note"],
    };
    const view = buildAnswerModal("q3", "C1", stored);
    expect(view.blocks).toHaveLength(1);
    const general = view.blocks[0]!;
    expect(general.type).toBe("input");
    if (general.type === "input") {
      expect(general.block_id).toBe("general");
      expect(general.element.initial_value).toBe("just send this note");
    }
  });

  it("composeAnswer appends '# Other notes' when passages are also answered, or sends bare when alone", () => {
    const stored: StoredQuote = {
      v: 1,
      sessionId: "gse_1",
      passages: [{ header: "# H1", lines: ["q1"], first: true }],
      total: 1,
      unmatchedNotes: ["extra note"],
    };
    const withBoth = composeAnswer(stored, new Map([[1, "yes"]]), "extra note");
    expect(withBoth).toBe("# H1\n> q1\nyes\n\n# Other notes\nextra note");

    const generalOnly = composeAnswer(stored, new Map(), "extra note");
    expect(generalOnly).toBe("extra note");

    const neither = composeAnswer(stored, new Map(), "   ");
    expect(neither).toBeNull();
  });
});
