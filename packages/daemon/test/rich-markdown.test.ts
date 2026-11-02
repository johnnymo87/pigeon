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
  it("escapes dollar signs so amounts are not read as math", () => {
    expect(sanitizeBodyMarkdown("costs $5 and $10")).toBe("costs \\$5 and \\$10");
  });

  it("escapes < so generics are not read as HTML", () => {
    expect(sanitizeBodyMarkdown("returns Promise<void>")).toBe("returns Promise\\<void>");
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

  it("leaves paragraph breaks alone", () => {
    expect(sanitizeBodyMarkdown("para one\n\npara two")).toBe("para one\n\npara two");
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
});

describe("tgMessageToMarkdown", () => {
  it("escapes markdown-significant characters in plain text", () => {
    expect(tgMessageToMarkdown(plain("✅ fix_the *thing* [x] $5 a|b <c>"))).toBe(
      "✅ fix\\_the \\*thing\\* \\[x\\] \\$5 a\\|b \\<c\\>",
    );
  });

  it("renders code entities as backtick spans without escaping inside", () => {
    const msg = new TgMessageBuilder().append("📂 ").appendCode("projects/my_repo").build();
    expect(tgMessageToMarkdown(msg)).toBe("📂 `projects/my_repo`");
  });

  it("uses a longer fence for code that contains backticks", () => {
    const msg = new TgMessageBuilder().appendCode("a`b").build();
    expect(tgMessageToMarkdown(msg)).toBe("``a`b``");
  });

  it("pads code that starts or ends with a backtick", () => {
    const msg = new TgMessageBuilder().appendCode("`a").build();
    expect(tgMessageToMarkdown(msg)).toBe("`` `a ``");
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
    expect(tgMessageToMarkdown(footer)).toBe("📂 `a/b` · 🖥 cloudbox  \n🆔 `ses_123`");
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

  it("returns null when the body has no table", () => {
    expect(buildRichMarkdown(header, plain("just **prose**"), footer)).toBeNull();
  });

  it("joins header, sanitized body and footer with blank lines", () => {
    expect(buildRichMarkdown(header, plain("Total $5:\n" + TABLE), footer)).toBe(
      "✅ my\\_session\n\nTotal \\$5:\n\n" + TABLE + "\n\n🆔 `ses_1`",
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

  it("returns null when the markdown exceeds the character limit", () => {
    const big = TABLE + "\n\n" + "x".repeat(RICH_MAX_CHARS);
    expect(buildRichMarkdown(header, plain(big), footer)).toBeNull();
  });

  it("counts code points, not UTF-16 units, against the character limit", () => {
    // 1 emoji = 2 UTF-16 units but 1 code point.
    const overhead = buildRichMarkdown(header, plain(TABLE + "\n\n"), footer)!;
    const room = RICH_MAX_CHARS - [...overhead].length;
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
