import { describe, it, expect } from "vitest";
import { buildAnswerModal, composeAnswer } from "../src/slack-quote-modal";
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
});
