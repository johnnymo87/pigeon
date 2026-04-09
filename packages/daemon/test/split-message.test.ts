import { describe, expect, it } from "vitest";
import { splitTelegramMessage } from "../src/split-message";
import type { TgMessage } from "../src/telegram-message";

describe("splitTelegramMessage", () => {
  const header: TgMessage = {
    text: "HEADER",
    entities: [{ offset: 0, length: 6, type: "bold" }],
  };
  const footer: TgMessage = {
    text: "FOOTER",
    entities: [{ offset: 0, length: 6, type: "code" }],
  };
  const plainHeader: TgMessage = { text: "HEADER", entities: [] };
  const plainFooter: TgMessage = { text: "FOOTER", entities: [] };
  const plainBody = (text: string): TgMessage => ({ text, entities: [] });

  it("returns single message when body fits", () => {
    const result = splitTelegramMessage(plainHeader, plainBody("Short body"), plainFooter, 100);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("HEADER\n\nShort body\n\nFOOTER");
    expect(result[0]!.entities).toHaveLength(0);
  });

  it("adjusts header and footer entity offsets in combined message", () => {
    const body = plainBody("hello");
    const result = splitTelegramMessage(header, body, footer, 100);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("HEADER\n\nhello\n\nFOOTER");
    // header bold: offset 0, length 6
    // footer code: offset = 6 + 2 + 5 + 2 = 15, length 6
    expect(result[0]!.entities).toEqual([
      { offset: 0, length: 6, type: "bold" },
      { offset: 15, length: 6, type: "code" },
    ]);
  });

  it("splits on paragraph boundary and duplicates header/footer entities", () => {
    const body = plainBody("Paragraph one.\n\nParagraph two.");
    // overhead = 6 + 6 + 4 = 16, maxBody = 30 - 16 = 14
    const result = splitTelegramMessage(header, body, footer, 30);
    expect(result).toHaveLength(2);
    expect(result[0]!.text).toContain("Paragraph one.");
    expect(result[1]!.text).toContain("Paragraph two.");
    // Both chunks should have header bold entity at offset 0
    expect(result[0]!.entities[0]).toEqual({ offset: 0, length: 6, type: "bold" });
    expect(result[1]!.entities[0]).toEqual({ offset: 0, length: 6, type: "bold" });
  });

  it("splits on line boundary when no paragraph break fits", () => {
    const body = plainBody("Line one.\nLine two.");
    const result = splitTelegramMessage(plainHeader, body, plainFooter, 26);
    expect(result).toHaveLength(2);
    expect(result[0]!.text).toContain("Line one.");
    expect(result[1]!.text).toContain("Line two.");
  });

  it("splits on sentence boundary when no line break fits", () => {
    const body = plainBody("First sentence. Second sentence.");
    const result = splitTelegramMessage(plainHeader, body, plainFooter, 32);
    expect(result).toHaveLength(2);
    expect(result[0]!.text).toContain("First sentence.");
    expect(result[1]!.text).toContain("Second sentence.");
  });

  it("hard-cuts when no natural boundary found", () => {
    const body = plainBody("x".repeat(100));
    const result = splitTelegramMessage(plainHeader, body, plainFooter, 50);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.text.length).toBeLessThanOrEqual(50);
    }
  });

  it("uses 4096 as default maxLen", () => {
    const body = plainBody("x".repeat(4000));
    const result = splitTelegramMessage(plainHeader, body, plainFooter);
    expect(result).toHaveLength(1);
  });

  it("handles empty body", () => {
    const result = splitTelegramMessage(plainHeader, plainBody(""), plainFooter, 100);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("HEADER\n\n\n\nFOOTER");
  });

  it("preserves body entities within a single chunk", () => {
    const body: TgMessage = {
      text: "plain then code_thing plain",
      entities: [{ offset: 11, length: 10, type: "code" }],
    };
    const result = splitTelegramMessage(plainHeader, body, plainFooter, 200);
    expect(result).toHaveLength(1);
    // body entity offset shifts by header + "\n\n" = 8
    expect(result[0]!.entities).toEqual([
      { offset: 19, length: 10, type: "code" },
    ]);
  });
});
