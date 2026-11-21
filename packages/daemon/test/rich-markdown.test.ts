import { describe, expect, it } from "vitest";
import {
  RICH_MAX_COLUMNS,
  SLACK_RICH_MAX_CHARS,
  buildRichMarkdown,
  hasPipeTable,
  maxTableColumns,
  sanitizeBodyMarkdown,
  chatMessageToMarkdown,
} from "../src/rich-markdown";
import { ChatMessageBuilder, type ChatMessage } from "../src/chat-message";

const plain = (text: string): ChatMessage => ({ text, entities: [] });
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

describe("sanitizeBodyMarkdown (Slack: plain GFM, layout fixes only)", () => {
  it("puts a blank line before a heading under a non-blank line", () => {
    // "- done\n# Heading" would fold the heading into the list item.
    expect(sanitizeBodyMarkdown("- done\n# Heading\ntext")).toBe("- done\n\n# Heading  \ntext");
    expect(sanitizeBodyMarkdown("para\n### Sub")).toBe("para\n\n### Sub");
  });

  it("ends a quote before an unquoted line, so the reply is not drawn inside the quote", () => {
    expect(sanitizeBodyMarkdown("> You said: ship it\nI'll ship it now.")).toBe(
      "> You said: ship it\n\nI'll ship it now.",
    );
    expect(sanitizeBodyMarkdown("> one\n> two\nafter")).toBe("> one  \n> two\n\nafter");
    expect(sanitizeBodyMarkdown("- item\n  > q\n  more")).toBe("- item  \n  > q\n\n  more");
  });

  it("leaves heading-like lines that are not headings alone", () => {
    expect(sanitizeBodyMarkdown("see\n#5387 merged")).toBe("see  \n#5387 merged");
    expect(sanitizeBodyMarkdown("```\nx\n# not a heading\n```")).toBe("```\nx\n# not a heading\n```");
  });

  it("applies none of the chat's escapes or spacers", () => {
    const text = "costs $5 and $10 == a || b <T> &amp; ![x](y)";
    expect(sanitizeBodyMarkdown(text)).toBe(text);
    expect(sanitizeBodyMarkdown("para one\n\npara two")).toBe("para one\n\npara two");
    expect(sanitizeBodyMarkdown("a\n\n\n\nb")).toBe("a\n\n\n\nb");
  });

  it("does not flatten nested lists or escape a leading #", () => {
    expect(sanitizeBodyMarkdown("- a\n  - b\n- c")).toBe("- a  \n  - b  \n- c");
    expect(sanitizeBodyMarkdown("#5620 is ready")).toBe("#5620 is ready");
  });

  it("leaves fenced code byte-identical, including its newlines", () => {
    const fenced = "```ts\nconst a = $b || c;\nlet x: Array<T>;\n```";
    expect(sanitizeBodyMarkdown(fenced)).toBe(fenced);
  });

  it("turns a lone newline into a hard break", () => {
    expect(sanitizeBodyMarkdown("line one\nline two")).toBe("line one  \nline two");
  });

  it("recognises a fence opened on a list-marker line, so code inside is untouched", () => {
    const md = "- ```bash\n  #!/bin/bash\n\n  echo $X\n  ```\n\nafter";
    expect(sanitizeBodyMarkdown(md)).toBe(md);
  });

  it("closes a fence the agent left open, so the footer is not swallowed into it", () => {
    expect(sanitizeBodyMarkdown("text\n\n```\ncode")).toBe("text\n\n```\ncode\n```");
    expect(sanitizeBodyMarkdown("~~~~\ncode")).toBe("~~~~\ncode\n~~~~");
  });

  it("does not close a fence left open inside a quote or list item, which their end closes", () => {
    expect(sanitizeBodyMarkdown("> ```\n> code")).toBe("> ```\n> code");
    expect(sanitizeBodyMarkdown("- ```\n  code")).toBe("- ```\n  code");
  });

  it("does not add hard breaks inside a table", () => {
    const table = "| a | b |\n|---|---|\n| $1 || x |";
    expect(sanitizeBodyMarkdown(table)).toBe(table);
  });

  it("separates a table from adjacent prose with blank lines", () => {
    expect(sanitizeBodyMarkdown("Results:\n" + TABLE + "\nDone.")).toBe(
      "Results:\n\n" + TABLE + "\n\nDone.",
    );
  });

  it("does not add hard breaks around fence lines", () => {
    expect(sanitizeBodyMarkdown("intro\n```\ncode\n```\nafter")).toBe("intro\n```\ncode\n```\nafter");
  });

  it("does not read line-start inline code (```x```) as a fence", () => {
    expect(sanitizeBodyMarkdown("```npm test``` passes\n$5")).toBe("```npm test``` passes  \n$5");
  });

  it("keeps a --- separator under prose from turning the prose into a heading", () => {
    expect(sanitizeBodyMarkdown("Summary\n---\nmore")).toBe("Summary\n\n---\n\nmore");
  });
});

describe("chatMessageToMarkdown", () => {
  it("escapes markdown-significant characters in plain text, and only those", () => {
    expect(chatMessageToMarkdown(plain("✅ fix_the *thing* [x] $5 a|b <c> R&D"))).toBe(
      "✅ fix\\_the \\*thing\\* \\[x\\] $5 a\\|b <c> R&D",
    );
  });

  it("renders code entities as code spans (Slack has no copy button)", () => {
    const msg = new ChatMessageBuilder().append("📂 ").appendCode("projects/my_repo").build();
    expect(chatMessageToMarkdown(msg)).toBe("📂 `projects/my_repo`");
  });

  it("uses a longer fence for code that contains backticks", () => {
    const msg = new ChatMessageBuilder().appendCode("a`b".repeat(100)).build();
    expect(chatMessageToMarkdown(msg)).toBe("``" + "a`b".repeat(100) + "``");
  });

  it("pads code that starts or ends with a backtick", () => {
    const msg = new ChatMessageBuilder().appendCode("`a".repeat(200)).build();
    expect(chatMessageToMarkdown(msg)).toBe("`` " + "`a".repeat(200) + " ``");
  });

  it("renders bold, italic and pre", () => {
    const msg = new ChatMessageBuilder()
      .appendBold("B_")
      .append(" ")
      .appendItalic("I")
      .newline()
      .appendPre("x = 1")
      .build();
    expect(chatMessageToMarkdown(msg)).toBe("**B\\_** _I_  \n```\nx = 1\n```");
  });

  it("turns newlines in plain text into hard breaks", () => {
    const footer = new ChatMessageBuilder()
      .append("📂 ")
      .appendCode("a/b")
      .append(" · 🖥 cloudbox")
      .newline()
      .append("🆔 ")
      .appendCode("ses_123")
      .build();
    expect(chatMessageToMarkdown(footer)).toBe("📂 `a/b` · 🖥 cloudbox  \n🆔 `ses_123`");
  });

  it("returns null for overlapping entities", () => {
    expect(
      chatMessageToMarkdown({
        text: "abcdef",
        entities: [
          { offset: 0, length: 4, type: "bold" },
          { offset: 2, length: 3, type: "code" },
        ],
      }),
    ).toBeNull();
  });
});

describe("buildRichMarkdown (always the Slack dialect)", () => {
  const header = plain("✅ my_session");
  const footer = new ChatMessageBuilder().append("🆔 ").appendCode("ses_1").build();

  it("returns null when the body has no table", () => {
    expect(buildRichMarkdown(header, plain("just **prose**"), footer)).toBeNull();
  });

  it("accepts a body without a table when a table is not required", () => {
    expect(buildRichMarkdown(header, plain("just **prose** at $5"), footer, { requireTable: false })).toBe(
      "✅ my\\_session\n\njust **prose** at $5\n\n🆔 `ses_1`",
    );
  });

  it("has no Telegram artefacts: no tg-button, no spacer paragraphs, no entity escapes", () => {
    const md = buildRichMarkdown(
      header,
      plain("Costs $5 == a || b <T>\n" + TABLE),
      footer,
    )!;
    expect(md).not.toContain("tg-button");
    expect(md).not.toContain("&nbsp;");
    expect(md).not.toContain("\\$");
    expect(md).not.toContain("&lt;");
    expect(md).not.toContain("\\=");
    expect(md).toContain("Costs $5 == a || b <T>");
    expect(md).toContain("`ses_1`");
    expect(md).toContain(TABLE);
  });

  it("still applies the limits when a table is not required", () => {
    const big = "x".repeat(SLACK_RICH_MAX_CHARS + 1);
    expect(buildRichMarkdown(header, plain(big), footer, { requireTable: false })).toBeNull();
    const n = RICH_MAX_COLUMNS + 1;
    const wide = `|${" h |".repeat(n)}\n|${"---|".repeat(n)}\n|${" 1 |".repeat(n)}`;
    expect(buildRichMarkdown(header, plain(wide), footer, { requireTable: false })).toBeNull();
  });

  it("joins header, sanitized body and footer with blank lines", () => {
    expect(buildRichMarkdown(header, plain("Total $5:\n" + TABLE), footer)).toBe(
      "✅ my\\_session\n\nTotal $5:\n\n" + TABLE + "\n\n🆔 `ses_1`",
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

  it("limits a markdown block to 12000 characters", () => {
    const big = plain(`| a |\n|---|\n| ${"x".repeat(13_000)} |`);
    expect(buildRichMarkdown(header, big, footer)).toBeNull();
  });

  it("counts code points, not UTF-16 units, against the character limit", () => {
    // 1 emoji = 2 UTF-16 units but 1 code point.
    const overhead = buildRichMarkdown(header, plain(TABLE + "\n\nx"), footer)!;
    const room = SLACK_RICH_MAX_CHARS - [...overhead].length + 1;
    const body = TABLE + "\n\n" + "😀".repeat(room);
    expect(buildRichMarkdown(header, plain(body), footer)).not.toBeNull();
  });

  it("returns null when the header cannot be converted", () => {
    const bad: ChatMessage = {
      text: "abcdef",
      entities: [
        { offset: 0, length: 4, type: "bold" },
        { offset: 2, length: 3, type: "code" },
      ],
    };
    expect(buildRichMarkdown(bad, plain(TABLE), footer)).toBeNull();
  });
});
