import { describe, expect, it } from "vitest";
import {
  capPassages,
  emptyText,
  flattenPassages,
  pickLabel,
  quoteBodyMarkdown,
  quoteBodyText,
} from "../src/goose/quote-render";
import {
  QUOTE_MAX_PASSAGES,
  QUOTE_MAX_TOTAL_CHARS,
  type QuoteResult,
  type StoredQuotePassage,
} from "../src/goose/quote-types";
import { SLACK_RICH_MAX_CHARS } from "../src/rich-markdown";

describe("pickLabel", () => {
  it("renders since your last message", () => {
    expect(pickLabel({ kind: "since" }, false)).toBe("since your last message");
    expect(pickLabel({ kind: "since" }, true)).toBe("since your last message (full)");
  });

  it("renders since your previous message", () => {
    expect(pickLabel({ kind: "prev" }, false)).toBe("since your previous message");
    expect(pickLabel({ kind: "prev" }, true)).toBe("since your previous message (full)");
  });

  it("renders last N", () => {
    expect(pickLabel({ kind: "last", n: 3 }, false)).toBe("last 3");
    expect(pickLabel({ kind: "last", n: 5 }, true)).toBe("last 5 (full)");
  });
});

describe("flattenPassages", () => {
  it("flattens passages across replies and sets first flag", () => {
    const result: QuoteResult = {
      summary: "Trimmed",
      replies: [
        {
          header: "# 11-24 13:00 · ask",
          passages: [
            ["line 1", "line 2"],
            ["line 3"],
          ],
          inProgress: false,
        },
        {
          header: "# 11-24 14:00 · ask",
          passages: [["line 4"]],
          inProgress: false,
        },
      ],
      notices: [],
      warnings: [],
      empty: null,
      model: "claude-opus-5-5",
    };

    const passages = flattenPassages(result);
    expect(passages).toEqual([
      {
        header: "# 11-24 13:00 · ask",
        lines: ["line 1", "line 2"],
        first: true,
      },
      {
        header: "# 11-24 13:00 · ask",
        lines: ["line 3"],
        first: false,
      },
      {
        header: "# 11-24 14:00 · ask",
        lines: ["line 4"],
        first: true,
      },
    ]);
  });

  it("appends ' · in progress' when inProgress is true and not present in header", () => {
    const result: QuoteResult = {
      summary: null,
      replies: [
        {
          header: "# 11-24 15:00 · ask",
          passages: [["running now"]],
          inProgress: true,
        },
      ],
      notices: [],
      warnings: [],
      empty: null,
      model: null,
    };

    const passages = flattenPassages(result);
    expect(passages[0]?.header).toBe("# 11-24 15:00 · ask · in progress");
  });

  it("does not duplicate 'in progress' if already present in header", () => {
    const result: QuoteResult = {
      summary: null,
      replies: [
        {
          header: "# 11-24 15:00 · ask · in progress",
          passages: [["running now"]],
          inProgress: true,
        },
      ],
      notices: [],
      warnings: [],
      empty: null,
      model: null,
    };

    const passages = flattenPassages(result);
    expect(passages[0]?.header).toBe("# 11-24 15:00 · ask · in progress");
  });
});

describe("capPassages", () => {
  it("keeps uncapped total and passages within limits", () => {
    const passages: StoredQuotePassage[] = [
      { header: "h1", lines: ["a", "b"], first: true },
      { header: "h1", lines: ["c"], first: false },
    ];
    const capped = capPassages(passages);
    expect(capped.total).toBe(2);
    expect(capped.passages).toEqual(passages);
  });

  it("caps at QUOTE_MAX_PASSAGES (45)", () => {
    const passages: StoredQuotePassage[] = Array.from({ length: 50 }, (_, i) => ({
      header: `h${i}`,
      lines: [`line ${i}`],
      first: true,
    }));
    const capped = capPassages(passages);
    expect(capped.total).toBe(50);
    expect(capped.passages.length).toBe(QUOTE_MAX_PASSAGES);
    expect(capped.passages[0]?.lines).toEqual(["line 0"]);
    expect(capped.passages[44]?.lines).toEqual(["line 44"]);
  });

  it("caps at QUOTE_MAX_TOTAL_CHARS (100,000 chars)", () => {
    // 3 passages of 40,000 chars each = 120,000 chars total -> only 2 fit
    const longLine = "x".repeat(40_000);
    const passages: StoredQuotePassage[] = [
      { header: "h0", lines: [longLine], first: true },
      { header: "h1", lines: [longLine], first: true },
      { header: "h2", lines: [longLine], first: true },
    ];
    const capped = capPassages(passages);
    expect(capped.total).toBe(3);
    expect(capped.passages.length).toBe(2);
  });
});

describe("emptyText", () => {
  it("renders nothing_since with notices", () => {
    const result: QuoteResult = {
      summary: null,
      replies: [],
      notices: ["fell back to the last 3"],
      warnings: [],
      empty: "nothing_since",
      model: null,
    };
    expect(emptyText(result)).toBe(
      "ℹ️ fell back to the last 3\nNothing has replied since your last message. Try /quote 3 or /quote prev.",
    );
  });

  it("renders nothing_kept", () => {
    const result: QuoteResult = {
      summary: null,
      replies: [],
      notices: [],
      warnings: [],
      empty: "nothing_kept",
      model: null,
    };
    expect(emptyText(result)).toBe(
      "The trim found nothing that needs you (/quote full shows everything).",
    );
  });

  it("renders never_spoke", () => {
    const result: QuoteResult = {
      summary: null,
      replies: [],
      notices: [],
      warnings: [],
      empty: "never_spoke",
      model: null,
    };
    expect(emptyText(result)).toBe(
      "No messages from you found in this session. Try /quote 3.",
    );
  });

  it("renders one_prompt", () => {
    const result: QuoteResult = {
      summary: null,
      replies: [],
      notices: [],
      warnings: [],
      empty: "one_prompt",
      model: null,
    };
    expect(emptyText(result)).toBe("Only one prompt found in this session.");
  });

  it("renders no_replies", () => {
    const result: QuoteResult = {
      summary: null,
      replies: [],
      notices: [],
      warnings: [],
      empty: "no_replies",
      model: null,
    };
    expect(emptyText(result)).toBe("No replies found in this session.");
  });

  it("includes warnings if present", () => {
    const result: QuoteResult = {
      summary: null,
      replies: [],
      notices: [],
      warnings: ["trim failed"],
      empty: "nothing_since",
      model: null,
    };
    expect(emptyText(result)).toBe(
      "⚠️ trim failed\nNothing has replied since your last message. Try /quote 3 or /quote prev.",
    );
  });
});

describe("quoteBodyText", () => {
  it("renders plain body post format", () => {
    const result: QuoteResult = {
      summary: "# honk: kept 3 of 10 lines",
      replies: [
        {
          header: "# 11-24 13:05 (wake: mail) · ask",
          passages: [
            ["line 1", "", "line 2"],
            ["line 3"],
          ],
          inProgress: false,
        },
        {
          header: "# 11-24 14:00 · ask",
          passages: [["line 4"]],
          inProgress: false,
        },
      ],
      notices: ["fell back to the last 3"],
      warnings: ["model trim degraded"],
      empty: null,
      model: "claude-opus-5-5",
    };

    const text = quoteBodyText(result, "since your last message", "my_session");
    expect(text).toBe(
      "📋 /quote since your last message · my_session\n" +
        "honk: kept 3 of 10 lines\n" +
        "⚠️ model trim degraded\n" +
        "ℹ️ fell back to the last 3\n\n" +
        "[1] 11-24 13:05 (wake: mail) · ask\n" +
        "> line 1\n" +
        ">\n" +
        "> line 2\n" +
        "[2] …\n" +
        "> line 3\n" +
        "[3] 11-24 14:00 · ask\n" +
        "> line 4",
    );
  });

  it("falls back to 'quoted in full' when summary is null", () => {
    const result: QuoteResult = {
      summary: null,
      replies: [
        {
          header: "# 11-24 13:05 · ask",
          passages: [["full line"]],
          inProgress: false,
        },
      ],
      notices: [],
      warnings: [],
      empty: null,
      model: null,
    };

    const text = quoteBodyText(result, "last 1 (full)", "session_a");
    expect(text).toContain("quoted in full");
    expect(text).toContain("[1] 11-24 13:05 · ask\n> full line");
  });
});

describe("quoteBodyMarkdown", () => {
  it("renders GFM with bold header lines and escaped untrusted quote lines", () => {
    const result: QuoteResult = {
      summary: "# honk: trimmed",
      replies: [
        {
          header: "# 11-24 13:05 (wake: mail) · ask",
          passages: [
            [
              "# Heading",
              "- list item",
              "*bold*",
              "_italic_",
              "`code`",
              "> quote",
              "1. numbered",
              "plain line",
              "",
              "another line",
            ],
            ["gap line"],
          ],
          inProgress: false,
        },
      ],
      notices: [],
      warnings: [],
      empty: null,
      model: null,
    };

    const md = quoteBodyMarkdown(result, "since your last message", "my_session");
    expect(md).not.toBeNull();
    // Headers are bold
    expect(md).toContain("**[1] 11-24 13:05 (wake: mail) · ask**");
    expect(md).toContain("**[2] …**");
    // Underscore in label is escaped
    expect(md).toContain("my\\_session");
    // Quote lines are escaped and prefixed with >
    expect(md).toContain("> \\# Heading");
    expect(md).toContain("> \\- list item");
    expect(md).toContain("> \\*bold\\*");
    expect(md).toContain("> \\_italic\\_");
    expect(md).toContain("> \\`code\\`");
    expect(md).toContain("> \\> quote");
    expect(md).toContain("> 1\\. numbered");
    // Empty line is a quote line
    expect(md).toContain(">  \n");
  });

  it("returns null when length exceeds SLACK_RICH_MAX_CHARS", () => {
    const hugeLine = "a".repeat(SLACK_RICH_MAX_CHARS);
    const result: QuoteResult = {
      summary: "summary",
      replies: [
        {
          header: "# h",
          passages: [[hugeLine]],
          inProgress: false,
        },
      ],
      notices: [],
      warnings: [],
      empty: null,
      model: null,
    };

    const md = quoteBodyMarkdown(result, "since", "label");
    expect(md).toBeNull();
  });
});
