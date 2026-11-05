import { describe, expect, it } from "vitest";
import {
  RICH_MAX_BLOCKS,
  RICH_MAX_CHARS,
  RICH_MAX_COLUMNS,
  buildRichMarkdown,
  hasPipeTable,
  maxTableColumns,
  sanitizeBodyMarkdown,
  tgMessageToMarkdown,
} from "../src/rich-markdown";
import { TgMessageBuilder, type TgMessage } from "../src/telegram-message";

const plain = (text: string): TgMessage => ({ text, entities: [] });
const TABLE = "| a | b |\n|---|:-:|\n| 1 | 2 |";

describe("hasPipeTable", () => {
  it("detects a table with outer pipes", () => {
    expect(hasPipeTable(TABLE)).toBe(true);
  });

  it("detects a table without outer pipes and with alignment colons", () => {
    expect(hasPipeTable("x\n\na | b\n:-- | --:\n1 | 2")).toBe(true);
  });

  it("detects a one-column table, which needs both outer pipes", () => {
    expect(hasPipeTable("| a |\n|---|\n| 1 |")).toBe(true);
    expect(hasPipeTable("a |\n---\n1")).toBe(false);
  });

  it("requires the header to have as many cells as the delimiter row", () => {
    expect(hasPipeTable("a | b\n|---|\nc")).toBe(false);
  });

  it("ignores a lone pipe line", () => {
    expect(hasPipeTable("run `a | b` then\nsomething else")).toBe(false);
  });

  it("ignores a delimiter-like row with no header row above it", () => {
    expect(hasPipeTable("|---|---|\n| 1 | 2 |")).toBe(false);
  });

  it("ignores a horizontal rule under prose", () => {
    expect(hasPipeTable("some prose\n---\nmore")).toBe(false);
  });

  it("ignores a table inside a fenced code block", () => {
    expect(hasPipeTable("```\n| a | b |\n|---|---|\n```")).toBe(false);
  });

  it("detects a table after a closed fence", () => {
    expect(hasPipeTable("```\ncode\n```\n\n" + TABLE)).toBe(true);
  });
});

describe("maxTableColumns", () => {
  it("returns the widest table's column count", () => {
    expect(maxTableColumns(TABLE + "\n\n| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |")).toBe(3);
  });

  it("returns 0 when there is no table", () => {
    expect(maxTableColumns("no table")).toBe(0);
  });
});

describe("sanitizeBodyMarkdown", () => {
  it("puts a blank line before a heading under a non-blank line", () => {
    // Probed: Telegram folds "- done\n# Heading" into the list item.
    expect(sanitizeBodyMarkdown("- done\n# Heading\ntext")).toBe("- done\n\n# Heading  \ntext");
    expect(sanitizeBodyMarkdown("para\n### Sub")).toBe("para\n\n### Sub");
  });

  it("ends a quote before an unquoted line, so the reply is not drawn inside the quote", () => {
    // Probed: "> a  \nb" is one blockquote paragraph (lazy continuation).
    expect(sanitizeBodyMarkdown("> You said: ship it\nI'll ship it now.")).toBe(
      "> You said: ship it\n\nI'll ship it now.",
    );
    expect(sanitizeBodyMarkdown("> one\n> two\nafter")).toBe("> one  \n> two\n\nafter");
    expect(sanitizeBodyMarkdown("- item\n  > q\n  more")).toBe("- item  \n  > q\n\n  more");
  });

  it("leaves heading-like lines that are not headings alone", () => {
    // Telegram makes even a lazy `#5387` line a heading, so it is escaped (pigeon-ravn).
    expect(sanitizeBodyMarkdown("see\n#5387 merged")).toBe("see  \n\\#5387 merged");
    expect(sanitizeBodyMarkdown("a\n\n# H")).toBe("a\n\n&nbsp;\n\n# H");
    expect(sanitizeBodyMarkdown("```\nx\n# not a heading\n```")).toBe("```\nx\n# not a heading\n```");
  });

  it("escapes dollar signs so amounts are not read as math", () => {
    expect(sanitizeBodyMarkdown("costs $5 and $10")).toBe("costs \\$5 and \\$10");
  });

  it("escapes < so generics are not read as HTML", () => {
    // Probed against Telegram: "\\<void>" renders "\\" and DROPS "<void>"; "&lt;" renders "<".
    expect(sanitizeBodyMarkdown("returns Promise<void>")).toBe("returns Promise&lt;void>");
  });

  it("escapes == (marked text) and || (spoiler) in prose", () => {
    expect(sanitizeBodyMarkdown("a == b || c")).toBe("a \\=\\= b \\|\\| c");
  });

  it("leaves a single = and a single | alone", () => {
    expect(sanitizeBodyMarkdown("x = 1 | 2")).toBe("x = 1 | 2");
  });

  it("leaves inline code spans byte-identical", () => {
    expect(sanitizeBodyMarkdown("run `a || $b <c>` now $")).toBe("run `a || $b <c>` now \\$");
  });

  it("matches inline code by backtick run length", () => {
    expect(sanitizeBodyMarkdown("``a ` $b`` $")).toBe("``a ` $b`` \\$");
  });

  it("treats an unmatched backtick as literal and keeps escaping", () => {
    expect(sanitizeBodyMarkdown("a ` $b")).toBe("a ` \\$b");
  });

  it("leaves fenced code byte-identical, including its newlines", () => {
    const fenced = "```ts\nconst a = $b || c;\nlet x: Array<T>;\n```";
    expect(sanitizeBodyMarkdown(fenced)).toBe(fenced);
  });

  it("keeps an existing backslash escape as is", () => {
    expect(sanitizeBodyMarkdown("\\$5")).toBe("\\$5");
  });

  it("turns a lone newline into a hard break", () => {
    expect(sanitizeBodyMarkdown("line one\nline two")).toBe("line one  \nline two");
  });

  // pigeon-ravn: Telegram draws rich paragraphs with no gap between them, so a blank line
  // in the source showed as nothing. An empty (&nbsp;) paragraph gives back the empty line
  // plain text showed.
  it("keeps a paragraph break visible with an empty paragraph", () => {
    expect(sanitizeBodyMarkdown("para one\n\npara two")).toBe("para one\n\n&nbsp;\n\npara two");
  });

  it("collapses a run of blank lines into one spacer", () => {
    expect(sanitizeBodyMarkdown("a\n\n\n\nb")).toBe("a\n\n&nbsp;\n\nb");
  });

  it("puts spacers before and after a list, but not between its items", () => {
    expect(sanitizeBodyMarkdown("intro\n\n- a\n\n- b\n\n1. c\n\n2. d\n\nend")).toBe(
      "intro\n\n&nbsp;\n\n- a\n\n- b\n\n1. c\n\n2. d\n\n&nbsp;\n\nend",
    );
  });

  it("adds no spacer before an indented continuation of a list item", () => {
    expect(sanitizeBodyMarkdown("- a\n\n  more of a\n- b")).toBe("- a\n\n  more of a  \n- b");
  });

  it("adds no spacer inside fenced code", () => {
    expect(sanitizeBodyMarkdown("```\nx\n\ny\n```")).toBe("```\nx\n\ny\n```");
  });

  it("adds no spacer where it inserted a blank line itself", () => {
    expect(sanitizeBodyMarkdown("text\n# Heading")).toBe("text\n\n# Heading");
  });

  // pigeon-ravn: Telegram reads `#` followed by text at the start of a line as a heading,
  // where GFM needs a space: "#5620 is ready" rendered as a giant heading.
  it("escapes a line-start # that GFM would not read as a heading", () => {
    expect(sanitizeBodyMarkdown("#5620 is ready")).toBe("\\#5620 is ready");
    expect(sanitizeBodyMarkdown("##5620 x")).toBe("\\##5620 x");
    expect(sanitizeBodyMarkdown("   #tag x")).toBe("   \\#tag x");
    expect(sanitizeBodyMarkdown("- #5620 merged")).toBe("- \\#5620 merged");
    expect(sanitizeBodyMarkdown("1. #5620 merged")).toBe("1. \\#5620 merged");
    expect(sanitizeBodyMarkdown("> #5620 merged")).toBe("> \\#5620 merged");
  });

  it("leaves real headings and mid-line # alone", () => {
    expect(sanitizeBodyMarkdown("# Title")).toBe("# Title");
    expect(sanitizeBodyMarkdown("#\tTitle")).toBe("#\tTitle");
    expect(sanitizeBodyMarkdown("see #5620")).toBe("see #5620");
    expect(sanitizeBodyMarkdown("```\n#include x\n```")).toBe("```\n#include x\n```");
  });

  it("does not add hard breaks inside a table, and keeps || (empty cell) in table rows", () => {
    const table = "| a | b |\n|---|---|\n| $1 || x |";
    expect(sanitizeBodyMarkdown(table)).toBe("| a | b |\n|---|---|\n| \\$1 || x |");
  });

  it("separates a table from adjacent prose with blank lines", () => {
    expect(sanitizeBodyMarkdown("Results:\n" + TABLE + "\nDone.")).toBe(
      "Results:\n\n" + TABLE + "\n\nDone.",
    );
  });

  it("does not add hard breaks around fence lines", () => {
    expect(sanitizeBodyMarkdown("intro\n```\ncode\n```\nafter")).toBe("intro\n```\ncode\n```\nafter");
  });

  it("treats an unclosed fence as running to the end", () => {
    expect(sanitizeBodyMarkdown("```\n$a\nb")).toBe("```\n$a\nb");
  });

  it("does not read line-start inline code (```x```) as a fence", () => {
    expect(sanitizeBodyMarkdown("```npm test``` passes\n$5")).toBe("```npm test``` passes  \n\\$5");
  });

  it("recognises fences indented under list items", () => {
    const md = "1. step\n\n    ```\n    a $b <c>\n    ```";
    expect(sanitizeBodyMarkdown(md)).toBe(md);
  });

  it("recognises fences inside blockquotes", () => {
    const md = "> ```\n> a $b\n> ```";
    expect(sanitizeBodyMarkdown(md)).toBe(md);
  });

  it("keeps a --- separator under prose from turning the prose into a heading", () => {
    expect(sanitizeBodyMarkdown("Summary\n---\nmore")).toBe("Summary\n\n---\n\nmore");
  });

  it("encodes & so entities stay literal, as plain text showed them", () => {
    // Probed against Telegram: "\\&" keeps its backslash; "&amp;" renders "&".
    expect(sanitizeBodyMarkdown("a &amp; b &rarr; c &#60; d & e")).toBe("a &amp;amp; b &amp;rarr; c &amp;#60; d & e");
  });

  it("leaves a lone & alone, so query strings in links keep working", () => {
    expect(sanitizeBodyMarkdown("see https://x/?a=1&b=2 and [q](https://x/?a=1&b=2), R&D")).toBe(
      "see https://x/?a=1&b=2 and [q](https://x/?a=1&b=2), R&D",
    );
  });

  it("does not let an agent's own backslash swallow < or &", () => {
    expect(sanitizeBodyMarkdown("a \\<b> \\&lt;")).toBe("a \\&lt;b> \\&amp;lt;");
  });

  it("encodes < and & inside table cells too", () => {
    expect(sanitizeBodyMarkdown("| a |\n|---|\n| Promise<T> &amp; x |")).toBe("| a |\n|---|\n| Promise&lt;T> &amp;amp; x |");
  });

  it("escapes inline images so Telegram does not fetch them as media", () => {
    expect(sanitizeBodyMarkdown("badge ![ci](https://x/y.svg) ok")).toBe("badge \\![ci](https://x/y.svg) ok");
  });
});

describe("tgMessageToMarkdown", () => {
  it("escapes markdown-significant characters in plain text", () => {
    expect(tgMessageToMarkdown(plain("✅ fix_the *thing* [x] $5 a|b <c> R&D"))).toBe(
      "✅ fix\\_the \\*thing\\* \\[x\\] \\$5 a\\|b &lt;c\\> R&D",
    );
  });

  // pigeon-ravn: a plain message's code entity copies with one tap; rich inline code does not.
  // A copy_text button does.
  it("renders code entities as copy buttons", () => {
    const msg = new TgMessageBuilder().append("📂 ").appendCode("projects/my_repo").build();
    expect(tgMessageToMarkdown(msg)).toBe(
      '📂 <tg-button type="copy_text" text="projects/my_repo">projects/my\\_repo</tg-button>',
    );
  });

  it("escapes the copy text as an attribute and the label as markdown", () => {
    const msg = new TgMessageBuilder().appendCode('a"b&c<d`e*').build();
    expect(tgMessageToMarkdown(msg)).toBe(
      '<tg-button type="copy_text" text="a&quot;b&amp;c&lt;d`e*">a"b&c&lt;d\\`e\\*</tg-button>',
    );
  });

  it("falls back to a code span when the text is too long for a copy button", () => {
    const long = "x".repeat(257);
    const msg = new TgMessageBuilder().appendCode(long).build();
    expect(tgMessageToMarkdown(msg)).toBe("`" + long + "`");
    const max = "x".repeat(256);
    expect(tgMessageToMarkdown(new TgMessageBuilder().appendCode(max).build())).toContain("<tg-button");
  });

  it("uses a longer fence for code that contains backticks", () => {
    const msg = new TgMessageBuilder().appendCode("a`b".repeat(100)).build();
    expect(tgMessageToMarkdown(msg)).toBe("``" + "a`b".repeat(100) + "``");
  });

  it("pads code that starts or ends with a backtick", () => {
    const msg = new TgMessageBuilder().appendCode("`a".repeat(200)).build();
    expect(tgMessageToMarkdown(msg)).toBe("`` " + "`a".repeat(200) + " ``");
  });

  it("renders bold, italic and pre", () => {
    const msg = new TgMessageBuilder()
      .appendBold("B_")
      .append(" ")
      .appendItalic("I")
      .newline()
      .appendPre("x = 1")
      .build();
    expect(tgMessageToMarkdown(msg)).toBe("**B\\_** _I_  \n```\nx = 1\n```");
  });

  it("turns newlines in plain text into hard breaks", () => {
    const footer = new TgMessageBuilder()
      .append("📂 ")
      .appendCode("a/b")
      .append(" · 🖥 cloudbox")
      .newline()
      .append("🆔 ")
      .appendCode("ses_123")
      .build();
    expect(tgMessageToMarkdown(footer)).toBe(
      '📂 <tg-button type="copy_text" text="a/b">a/b</tg-button> · 🖥 cloudbox  \n' +
        '🆔 <tg-button type="copy_text" text="ses_123">ses\\_123</tg-button>',
    );
  });

  it("returns null for overlapping entities", () => {
    expect(
      tgMessageToMarkdown({
        text: "abcdef",
        entities: [
          { offset: 0, length: 4, type: "bold" },
          { offset: 2, length: 3, type: "code" },
        ],
      }),
    ).toBeNull();
  });
});

describe("buildRichMarkdown", () => {
  const header = plain("✅ my_session");
  const footer = new TgMessageBuilder().append("🆔 ").appendCode("ses_1").build();
  const ID_BUTTON = '<tg-button type="copy_text" text="ses_1">ses\\_1</tg-button>';

  it("returns null when the body has no table", () => {
    expect(buildRichMarkdown(header, plain("just **prose**"), footer)).toBeNull();
  });

  it("accepts a body without a table when a table is not required", () => {
    expect(buildRichMarkdown(header, plain("just **prose** at $5"), footer, { requireTable: false })).toBe(
      "✅ my\\_session\n\n&nbsp;\n\njust **prose** at \\$5\n\n&nbsp;\n\n🆔 " + ID_BUTTON,
    );
  });

  it("still applies the limits when a table is not required", () => {
    const big = "x".repeat(RICH_MAX_CHARS + 1);
    expect(buildRichMarkdown(header, plain(big), footer, { requireTable: false })).toBeNull();
    const n = RICH_MAX_COLUMNS + 1;
    const wide = `|${" h |".repeat(n)}\n|${"---|".repeat(n)}\n|${" 1 |".repeat(n)}`;
    expect(buildRichMarkdown(header, plain(wide), footer, { requireTable: false })).toBeNull();
  });

  it("joins header, sanitized body and footer with spacer paragraphs", () => {
    expect(buildRichMarkdown(header, plain("Total $5:\n" + TABLE), footer)).toBe(
      "✅ my\\_session\n\n&nbsp;\n\nTotal \\$5:\n\n" + TABLE + "\n\n&nbsp;\n\n🆔 " + ID_BUTTON,
    );
  });

  it("skips empty header and footer", () => {
    expect(buildRichMarkdown(plain(""), plain(TABLE), plain(""))).toBe(TABLE);
  });

  it("returns null when a table has more than the column limit", () => {
    const n = RICH_MAX_COLUMNS + 1;
    const wide = `|${" h |".repeat(n)}\n|${"---|".repeat(n)}\n|${" 1 |".repeat(n)}`;
    expect(buildRichMarkdown(header, plain(wide), footer)).toBeNull();
  });

  it("accepts a table at exactly the column limit", () => {
    const n = RICH_MAX_COLUMNS;
    const wide = `|${" h |".repeat(n)}\n|${"---|".repeat(n)}\n|${" 1 |".repeat(n)}`;
    expect(buildRichMarkdown(header, plain(wide), footer)).not.toBeNull();
  });

  it("returns null when the estimated block count exceeds the limit", () => {
    const rows = Array.from({ length: RICH_MAX_BLOCKS }, (_, i) => `| ${i} | x |`).join("\n");
    expect(buildRichMarkdown(header, plain(TABLE + "\n" + rows), footer)).toBeNull();
  });

  it("counts a list item as two blocks (item plus paragraph)", () => {
    const items = Array.from({ length: RICH_MAX_BLOCKS / 2 }, (_, i) => `- item ${i}`).join("\n");
    expect(buildRichMarkdown(plain(""), plain(TABLE + "\n\n" + items), plain(""))).toBeNull();
  });

  it("returns null when the markdown exceeds the character limit", () => {
    const big = TABLE + "\n\n" + "x".repeat(RICH_MAX_CHARS);
    expect(buildRichMarkdown(header, plain(big), footer)).toBeNull();
  });

  it("counts code points, not UTF-16 units, against the character limit", () => {
    // 1 emoji = 2 UTF-16 units but 1 code point.
    const overhead = buildRichMarkdown(header, plain(TABLE + "\n\nx"), footer)!;
    const room = RICH_MAX_CHARS - [...overhead].length + 1;
    const body = TABLE + "\n\n" + "😀".repeat(room);
    expect(buildRichMarkdown(header, plain(body), footer)).not.toBeNull();
  });

  it("returns null when the header cannot be converted", () => {
    const bad: TgMessage = {
      text: "abcdef",
      entities: [
        { offset: 0, length: 4, type: "bold" },
        { offset: 2, length: 3, type: "code" },
      ],
    };
    expect(buildRichMarkdown(bad, plain(TABLE), footer)).toBeNull();
  });
});
