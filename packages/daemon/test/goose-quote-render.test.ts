import { describe, expect, it } from "vitest";
import {
  capPassages,
  defuseBroadcasts,
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

  it("leaves header as sent without appending ' · in progress' when inProgress is true", () => {
    const result: QuoteResult = {
      summary: null,
      replies: [
        {
          header: "# 11-24 15:00 · ask · untrimmed",
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
    expect(passages[0]?.header).toBe("# 11-24 15:00 · ask · untrimmed");
  });

  it("splits passage lines on embedded newlines so lines are single lines", () => {
    const result: QuoteResult = {
      summary: null,
      replies: [
        {
          header: "# 11-24 15:00 · ask",
          passages: [["intro", "\n\n# heading", "outro"]],
          inProgress: false,
        },
      ],
      notices: [],
      warnings: [],
      empty: null,
      model: null,
    };

    const passages = flattenPassages(result);
    expect(passages).toHaveLength(1);
    expect(passages[0]?.lines).toEqual(["intro", "", "", "# heading", "outro"]);

    // Test rendered forms: each line gets its own > prefix, no bare # heading
    const text = quoteBodyText(result, "since", "label");
    expect(text).toContain("> intro\n>\n>\n> # heading\n> outro");

    const md = quoteBodyMarkdown(result, "since", "label");
    expect(md).not.toBeNull();
    expect(md).toContain("> intro  \n>  \n>  \n> \\# heading  \n> outro");
  });
});

describe("defuseBroadcasts", () => {
  it("defuses <!channel>, <!here>, <!everyone>, and <!subteam...>", () => {
    expect(defuseBroadcasts("hello <!channel> world")).toBe("hello <\u200d!channel> world");
    expect(defuseBroadcasts("check <!here>")).toBe("check <\u200d!here>");
    expect(defuseBroadcasts("hey <!everyone>")).toBe("hey <\u200d!everyone>");
    expect(defuseBroadcasts("team <!subteam^S12345>")).toBe("team <\u200d!subteam^S12345>");
    expect(defuseBroadcasts("team <!subteam^S12345|engineers>")).toBe("team <\u200d!subteam^S12345|engineers>");
    expect(defuseBroadcasts("space <!  channel>")).toBe("space <\u200d!  channel>");
  });

  it("defuses bare @channel, @here, @everyone", () => {
    expect(defuseBroadcasts("alert @channel")).toBe("alert @\u200dchannel");
    expect(defuseBroadcasts("ping @here now")).toBe("ping @\u200dhere now");
    expect(defuseBroadcasts("call @everyone")).toBe("call @\u200deveryone");
  });

  it("is case-insensitive for broadcast patterns", () => {
    expect(defuseBroadcasts("<!CHANNEL> and @HERE")).toBe("<\u200d!CHANNEL> and @\u200dHERE");
    expect(defuseBroadcasts("<!subTeam^abc>")).toBe("<\u200d!subTeam^abc>");
  });

  it("does not defuse normal emails or words containing channel/here/everyone", () => {
    expect(defuseBroadcasts("contact user@channel.com")).toBe("contact user@channel.com");
    expect(defuseBroadcasts("@channel_alert")).toBe("@channel_alert");
    expect(defuseBroadcasts("@here_we_go")).toBe("@here_we_go");
    expect(defuseBroadcasts("@everyone_group")).toBe("@everyone_group");
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

  it("caps a single stored passage at 6000 chars of lines, truncating lines and appending '…'", () => {
    const longLine1 = "a".repeat(4000);
    const longLine2 = "b".repeat(3000); // 4000 + 3000 = 7000 > 6000
    const passages: StoredQuotePassage[] = [
      { header: "h0", lines: [longLine1, longLine2, "c".repeat(100)], first: true },
    ];
    const capped = capPassages(passages);
    expect(capped.total).toBe(1);
    expect(capped.passages).toHaveLength(1);
    const lines = capped.passages[0]?.lines!;
    expect(lines).toHaveLength(3); // longLine1, truncated longLine2, "…"
    expect(lines[0]).toBe("a".repeat(4000));
    expect(lines[1]).toBe("b".repeat(2000)); // 4000 + 2000 = 6000
    expect(lines[2]).toBe("…");
    const charsWithoutEllipsis = lines.slice(0, 2).reduce((sum: number, l: string) => sum + l.length, 0);
    expect(charsWithoutEllipsis).toBe(6000);
  });

  it("caps at QUOTE_MAX_TOTAL_CHARS (100,000 chars)", () => {
    // 20 passages of 6000 chars each = 120,000 chars total -> only 16 fit (16 * 6000 = 96,000)
    const passages: StoredQuotePassage[] = Array.from({ length: 20 }, (_, i) => ({
      header: `h${i}`,
      lines: ["x".repeat(6000)],
      first: true,
    }));
    const capped = capPassages(passages);
    expect(capped.total).toBe(20);
    expect(capped.passages.length).toBe(16);
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

  it("defuses Slack broadcast mentions in quoted lines", () => {
    const result: QuoteResult = {
      summary: null,
      replies: [
        {
          header: "# 11-24 13:00 · ask",
          passages: [[
            "hey <!channel>",
            "look <!here>",
            "all <!everyone>",
            "group <!subteam^S123|team>",
            "ping @channel and @here and @everyone",
          ]],
          inProgress: false,
        },
      ],
      notices: [],
      warnings: [],
      empty: null,
      model: null,
    };

    const text = quoteBodyText(result, "since", "label");
    expect(text).toContain("> hey <\u200d!channel>");
    expect(text).toContain("> look <\u200d!here>");
    expect(text).toContain("> all <\u200d!everyone>");
    expect(text).toContain("> group <\u200d!subteam^S123|team>");
    expect(text).toContain("> ping @\u200dchannel and @\u200dhere and @\u200deveryone");
  });

  it("caps body post at 12000 chars and ends with '… <k> more passage(s): open them with Answer.'", () => {
    // 5 passages, each ~3500 chars. Total ~17500 chars.
    // Passages 1, 2, 3 fit (~10500 chars + header < 12000 chars).
    // Passage 4 would push plain body over 12000 chars, so it stops and omits 2 passages.
    const replies = Array.from({ length: 5 }, (_, i) => ({
      header: `# 11-24 13:0${i} · reply ${i + 1}`,
      passages: [[`line for p${i + 1}: ${"x".repeat(3400)}`]],
      inProgress: false,
    }));
    const result: QuoteResult = {
      summary: null,
      replies,
      notices: [],
      warnings: [],
      empty: null,
      model: null,
    };

    const text = quoteBodyText(result, "since", "label");
    expect(text.length).toBeLessThanOrEqual(12000);
    expect(text).toContain("[1] 11-24 13:00 · reply 1");
    expect(text).toContain("[2] 11-24 13:01 · reply 2");
    expect(text).toContain("[3] 11-24 13:02 · reply 3");
    expect(text).not.toContain("[4]");
    expect(text).not.toContain("[5]");
    expect(text).toMatch(/… 2 more passage\(s\): open them with Answer\.$/);
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
    // 6,000 '*' characters fit within single passage and plain body limits,
    // but escaping each '*' to '\*' doubles the length to 12,000 chars, which
    // with header lines exceeds SLACK_RICH_MAX_CHARS (12,000).
    const lineWithSpecial = "*".repeat(6000);
    const result: QuoteResult = {
      summary: "summary",
      replies: [
        {
          header: "# h",
          passages: [[lineWithSpecial]],
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

  it("defuses Slack broadcast mentions in quoted lines", () => {
    const result: QuoteResult = {
      summary: null,
      replies: [
        {
          header: "# 11-24 13:00 · ask",
          passages: [[
            "hey <!channel>",
            "look <!here>",
            "all <!everyone>",
            "group <!subteam^S123|team>",
            "ping @channel and @here and @everyone",
          ]],
          inProgress: false,
        },
      ],
      notices: [],
      warnings: [],
      empty: null,
      model: null,
    };

    const md = quoteBodyMarkdown(result, "since", "label");
    expect(md).not.toBeNull();
    expect(md).toContain("> hey <\u200d!channel>");
    expect(md).toContain("> look <\u200d!here>");
    expect(md).toContain("> all <\u200d!everyone>");
    expect(md).toContain("> group <\u200d!subteam^S123\\|team>");
    expect(md).toContain("> ping @\u200dchannel and @\u200dhere and @\u200deveryone");
  });
});
