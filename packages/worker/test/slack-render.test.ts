/**
 * Slack rendering (bead pigeon-4ogz.3, task 1): Telegram entities → rich_text, inline keyboards →
 * actions blocks, markdown blocks, and the whole-message builder. Pure functions, no fetch.
 * Plan: "Rendering" in docs/plans/2026-11-20-slack-outbound-plan.md plus review delta 8.
 */
import { describe, it, expect } from "vitest";
import {
  SLACK_MARKDOWN_MAX,
  buildSlackMessage,
  entitiesToRichText,
  keyboardToBlocks,
  markdownBlock,
} from "../src/chat/slack-render";

const t = (text: string, style?: Record<string, boolean>) => (style ? { type: "text", text, style } : { type: "text", text });

describe("entitiesToRichText", () => {
  it("renders entity-less text as one plain section", () => {
    expect(entitiesToRichText("hello world", undefined)).toEqual({
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements: [t("hello world")] }],
    });
    expect(entitiesToRichText("hello", [])).toEqual(entitiesToRichText("hello", undefined));
  });

  it("styles bold, italic and code runs", () => {
    const block = entitiesToRichText("a bold b it c code d", [
      { type: "bold", offset: 2, length: 4 },
      { type: "italic", offset: 9, length: 2 },
      { type: "code", offset: 14, length: 4 },
    ]);
    expect(block.elements).toEqual([
      {
        type: "rich_text_section",
        elements: [
          t("a "),
          t("bold", { bold: true }),
          t(" b "),
          t("it", { italic: true }),
          t(" c "),
          t("code", { code: true }),
          t(" d"),
        ],
      },
    ]);
  });

  it("segments overlapping and nested entities at every boundary", () => {
    const block = entitiesToRichText("abcdef", [
      { type: "bold", offset: 0, length: 4 },
      { type: "italic", offset: 2, length: 4 },
    ]);
    expect(block.elements).toEqual([
      {
        type: "rich_text_section",
        elements: [t("ab", { bold: true }), t("cd", { bold: true, italic: true }), t("ef", { italic: true })],
      },
    ]);
  });

  it("merges adjacent segments that end up with the same style", () => {
    const block = entitiesToRichText("abcd", [
      { type: "bold", offset: 0, length: 2 },
      { type: "bold", offset: 2, length: 2 },
    ]);
    expect(block.elements).toEqual([{ type: "rich_text_section", elements: [t("abcd", { bold: true })] }]);
  });

  it("counts offsets in UTF-16 code units, so an emoji before an entity shifts it by two", () => {
    const text = "😀 bold";
    const block = entitiesToRichText(text, [{ type: "bold", offset: 3, length: 4 }]);
    expect(block.elements).toEqual([{ type: "rich_text_section", elements: [t("😀 "), t("bold", { bold: true })] }]);
  });

  it("does not split a surrogate pair when an offset lands inside one", () => {
    const block = entitiesToRichText("a😀b", [{ type: "bold", offset: 2, length: 1 }]);
    const flat = JSON.stringify(block);
    expect(flat).not.toMatch(/\\ud[89ab][0-9a-f]{2}"/i);
    expect(JSON.parse(flat)).toEqual(block);
  });

  it("renders pre as rich_text_preformatted between sections", () => {
    const text = "before\nconst x = 1;\nafter";
    const block = entitiesToRichText(text, [{ type: "pre", offset: 7, length: 12, language: "ts" }]);
    expect(block.elements).toEqual([
      { type: "rich_text_section", elements: [t("before")] },
      { type: "rich_text_preformatted", elements: [t("const x = 1;")] },
      { type: "rich_text_section", elements: [t("after")] },
    ]);
  });

  it("drops inline styles inside a pre and ignores overlapping pre ranges", () => {
    const block = entitiesToRichText("abcdef", [
      { type: "pre", offset: 1, length: 3 },
      { type: "bold", offset: 0, length: 6 },
      { type: "pre", offset: 2, length: 3 },
    ]);
    expect(block.elements).toEqual([
      { type: "rich_text_section", elements: [t("a", { bold: true })] },
      { type: "rich_text_preformatted", elements: [t("bcd")] },
      { type: "rich_text_section", elements: [t("ef", { bold: true })] },
    ]);
  });

  it("ignores unknown entity types, and out-of-range or degenerate ones", () => {
    const block = entitiesToRichText("hello", [
      { type: "text_link", offset: 0, length: 5, url: "https://x.test" },
      { type: "bold", offset: 10, length: 3 },
      { type: "bold", offset: 1, length: 0 },
      { type: "italic", offset: -2, length: 4 },
      { type: "bold", offset: Number.NaN, length: 2 },
    ]);
    expect(block.elements).toEqual([
      { type: "rich_text_section", elements: [t("he", { italic: true }), t("llo")] },
    ]);
  });

  it("clamps an entity that runs past the end", () => {
    const block = entitiesToRichText("abc", [{ type: "bold", offset: 1, length: 99 }]);
    expect(block.elements).toEqual([{ type: "rich_text_section", elements: [t("a"), t("bc", { bold: true })] }]);
  });

  it("never emits an empty text element, and has no elements at all for empty text", () => {
    expect(entitiesToRichText("", [{ type: "bold", offset: 0, length: 3 }]).elements).toEqual([]);
    const text = "x";
    const block = entitiesToRichText(text, [{ type: "pre", offset: 0, length: 1 }]);
    expect(block.elements).toEqual([{ type: "rich_text_preformatted", elements: [t("x")] }]);
    const flat = JSON.stringify(block);
    expect(flat).not.toContain('"text":""');
  });
});

describe("keyboardToBlocks", () => {
  it("makes one actions block per row, with callback and url buttons", () => {
    const blocks = keyboardToBlocks({
      inline_keyboard: [
        [
          { text: "Yes", callback_data: "cmd:T:v1:q0:0" },
          { text: "No", callback_data: "cmd:T:v1:q0:1" },
        ],
        [{ text: "Open", url: "https://t.me/c/1/2" }],
      ],
    });
    expect(blocks).toEqual([
      {
        type: "actions",
        elements: [
          { type: "button", action_id: "b0_0", text: { type: "plain_text", text: "Yes", emoji: true }, value: "cmd:T:v1:q0:0" },
          { type: "button", action_id: "b0_1", text: { type: "plain_text", text: "No", emoji: true }, value: "cmd:T:v1:q0:1" },
        ],
      },
      {
        type: "actions",
        elements: [{ type: "button", action_id: "b1_0", text: { type: "plain_text", text: "Open", emoji: true }, url: "https://t.me/c/1/2" }],
      },
    ]);
  });

  it("returns [] for no keyboard, a malformed one, or empty rows", () => {
    expect(keyboardToBlocks(undefined)).toEqual([]);
    expect(keyboardToBlocks(null)).toEqual([]);
    expect(keyboardToBlocks({})).toEqual([]);
    expect(keyboardToBlocks({ inline_keyboard: "x" })).toEqual([]);
    expect(keyboardToBlocks({ inline_keyboard: [[], "x", [{ text: "no action" }]] })).toEqual([]);
  });

  it("keeps the row index in the action id when an earlier row is skipped", () => {
    const blocks = keyboardToBlocks({ inline_keyboard: [[], [{ text: "A", callback_data: "a" }]] });
    expect((blocks[0] as { elements: Array<{ action_id: string }> }).elements[0]!.action_id).toBe("b1_0");
  });

  it("splits a row longer than 25 elements, keeping column ids unique", () => {
    const row = Array.from({ length: 30 }, (_, i) => ({ text: `B${i}`, callback_data: `c${i}` }));
    const blocks = keyboardToBlocks({ inline_keyboard: [row] }) as Array<{ elements: Array<{ action_id: string }> }>;
    expect(blocks.map((b) => b.elements.length)).toEqual([25, 5]);
    const ids = blocks.flatMap((b) => b.elements.map((e) => e.action_id));
    expect(new Set(ids).size).toBe(30);
    expect(ids[25]).toBe("b0_25");
  });

  it("truncates a label to 75 code points with an ellipsis", () => {
    const long = "😀".repeat(80);
    const [block] = keyboardToBlocks({ inline_keyboard: [[{ text: long, callback_data: "x" }]] }) as Array<{
      elements: Array<{ text: { text: string } }>;
    }>;
    const label = block!.elements[0]!.text.text;
    expect([...label].length).toBe(75);
    expect(label.endsWith("…")).toBe(true);
    const exact = "a".repeat(75);
    const [b2] = keyboardToBlocks({ inline_keyboard: [[{ text: exact, callback_data: "x" }]] }) as Array<{
      elements: Array<{ text: { text: string } }>;
    }>;
    expect(b2!.elements[0]!.text.text).toBe(exact);
  });

  it("never emits an empty button label", () => {
    const [block] = keyboardToBlocks({ inline_keyboard: [[{ text: "", callback_data: "x" }]] }) as Array<{
      elements: Array<{ text: { text: string } }>;
    }>;
    expect(block!.elements[0]!.text.text.length).toBeGreaterThan(0);
  });

  it("caps at 50 blocks", () => {
    const rows = Array.from({ length: 60 }, (_, i) => [{ text: "x", callback_data: `c${i}` }]);
    expect(keyboardToBlocks({ inline_keyboard: rows })).toHaveLength(50);
  });
});

describe("markdownBlock", () => {
  it("wraps text in a markdown block", () => {
    expect(markdownBlock("# hi")).toEqual({ type: "markdown", text: "# hi" });
  });
  it("limits cumulative markdown to 12000", () => {
    expect(SLACK_MARKDOWN_MAX).toBe(12000);
  });
});

describe("buildSlackMessage", () => {
  const OWNER = "U0OWNER";

  it("rich_text path: fallback text plus a rich_text block", () => {
    const m = buildSlackMessage({ text: "hello *x*", entities: [{ type: "bold", offset: 0, length: 5 }] });
    expect(m.text).toBe("hello *x*");
    expect(m.blocks).toEqual([entitiesToRichText("hello *x*", [{ type: "bold", offset: 0, length: 5 }])]);
  });

  it("escapes & < > in the fallback text only", () => {
    const m = buildSlackMessage({ text: "a < b && c > d" });
    expect(m.text).toBe("a &lt; b &amp;&amp; c &gt; d");
    expect(JSON.stringify(m.blocks)).toContain("a < b && c > d");
  });

  it("caps the fallback text at 40000 characters without leaving a half entity", () => {
    const m = buildSlackMessage({ text: "&".repeat(50_000) });
    expect(m.text.length).toBeLessThanOrEqual(40_000);
    expect(m.text).toMatch(/(&amp;)+$/);
  });

  it("appends the keyboard as actions blocks after the body", () => {
    const m = buildSlackMessage({
      text: "pick",
      replyMarkup: { inline_keyboard: [[{ text: "A", callback_data: "a" }]] },
    });
    expect(m.blocks.map((b) => b.type)).toEqual(["rich_text", "actions"]);
  });

  it("prefixes the mention and leads the first section with a user element when notifyOwner", () => {
    const m = buildSlackMessage({ text: "done", ownerUserId: OWNER, notifyOwner: true });
    expect(m.text).toBe("<@U0OWNER> done");
    expect(m.blocks).toEqual([
      {
        type: "rich_text",
        elements: [{ type: "rich_text_section", elements: [{ type: "user", user_id: OWNER }, t(" "), t("done")] }],
      },
    ]);
  });

  it("puts the mention in its own section when the text starts with a pre or is empty", () => {
    const pre = buildSlackMessage({
      text: "code",
      entities: [{ type: "pre", offset: 0, length: 4 }],
      ownerUserId: OWNER,
      notifyOwner: true,
    });
    expect((pre.blocks[0] as { elements: unknown[] }).elements).toEqual([
      { type: "rich_text_section", elements: [{ type: "user", user_id: OWNER }] },
      { type: "rich_text_preformatted", elements: [t("code")] },
    ]);
    const empty = buildSlackMessage({ text: "", ownerUserId: OWNER, notifyOwner: true });
    expect(empty.blocks).toEqual([
      { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "user", user_id: OWNER }] }] },
    ]);
    expect(empty.text).toBe("<@U0OWNER> ");
  });

  it("does not mention without notifyOwner or without a usable owner id", () => {
    expect(buildSlackMessage({ text: "x", ownerUserId: OWNER }).text).toBe("x");
    expect(buildSlackMessage({ text: "x", notifyOwner: true }).text).toBe("x");
    expect(buildSlackMessage({ text: "x", notifyOwner: true, ownerUserId: "U1> <!channel" }).text).toBe("x");
  });

  it("markdown path: markdown block, with an optional leading mention section", () => {
    const plain = buildSlackMessage({ text: "fallback", markdown: "**hi**" });
    expect(plain.blocks).toEqual([{ type: "markdown", text: "**hi**" }]);
    expect(plain.text).toBe("fallback");
    const mention = buildSlackMessage({ text: "fallback", markdown: "**hi**", ownerUserId: OWNER, notifyOwner: true });
    expect(mention.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "<@U0OWNER>" } },
      { type: "markdown", text: "**hi**" },
    ]);
    expect(mention.text).toBe("<@U0OWNER> fallback");
  });

  it("markdown path keeps the keyboard", () => {
    const m = buildSlackMessage({
      text: "f",
      markdown: "md",
      replyMarkup: { inline_keyboard: [[{ text: "A", url: "https://x.test" }]] },
    });
    expect(m.blocks.map((b) => b.type)).toEqual(["markdown", "actions"]);
  });

  it("falls back to rich_text when the markdown is empty or over the limit", () => {
    expect(buildSlackMessage({ text: "plain", markdown: "  \n" }).blocks[0]!.type).toBe("rich_text");
    const big = "x".repeat(SLACK_MARKDOWN_MAX + 1);
    expect(buildSlackMessage({ text: "plain", markdown: big }).blocks[0]!.type).toBe("rich_text");
    const ok = "x".repeat(SLACK_MARKDOWN_MAX);
    expect(buildSlackMessage({ text: "plain", markdown: ok }).blocks[0]!.type).toBe("markdown");
    // The limit counts code points, not UTF-16 units.
    const emoji = "😀".repeat(SLACK_MARKDOWN_MAX);
    expect(buildSlackMessage({ text: "plain", markdown: emoji }).blocks[0]!.type).toBe("markdown");
  });

  it("never sends an empty text and no empty text elements", () => {
    const m = buildSlackMessage({ text: "" });
    expect(m.text.length).toBeGreaterThan(0);
    expect(m.blocks).toEqual([]);
  });

  it("caps the total at 50 blocks, keeping the body and trimming buttons", () => {
    const rows = Array.from({ length: 60 }, (_, i) => [{ text: "x", callback_data: `c${i}` }]);
    const m = buildSlackMessage({ text: "body", replyMarkup: { inline_keyboard: rows } });
    expect(m.blocks).toHaveLength(50);
    expect(m.blocks[0]!.type).toBe("rich_text");
    const md = buildSlackMessage({
      text: "b",
      markdown: "md",
      ownerUserId: OWNER,
      notifyOwner: true,
      replyMarkup: { inline_keyboard: rows },
    });
    expect(md.blocks).toHaveLength(50);
    expect(md.blocks.slice(0, 2).map((b) => b.type)).toEqual(["section", "markdown"]);
  });
});
