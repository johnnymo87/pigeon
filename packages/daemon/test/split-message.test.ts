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

  function hasLoneSurrogate(str: string): boolean {
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        if (i + 1 >= str.length) return true;
        const next = str.charCodeAt(i + 1);
        if (next < 0xdc00 || next > 0xdfff) return true;
        i++;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  }

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

  describe("degenerate-budget fixes (T1.0b)", () => {
    it("handles overhead > maxLen (header 4200 chars) by truncating header and staying <= maxLen", () => {
      const header = plainBody("H".repeat(4200));
      const body = plainBody("B".repeat(500));
      const footer = plainBody("F".repeat(10));
      const result = splitTelegramMessage(header, body, footer, 4096);
      expect(result.length).toBeGreaterThan(0);
      for (const chunk of result) {
        expect(chunk.text.length).toBeLessThanOrEqual(4096);
      }
    });

    it("handles maxBody === 0 exactly (header 4092, body 2, footer 0, maxLen 4096)", () => {
      const header = plainBody("H".repeat(4092));
      const body = plainBody("Hi");
      const footer = plainBody("");
      const result = splitTelegramMessage(header, body, footer, 4096);
      expect(result.length).toBeGreaterThan(0);
      for (const chunk of result) {
        expect(chunk.text.length).toBeLessThanOrEqual(4096);
      }
    });

    it("prevents chunk explosion when maxBody is small (header 4080, body 10000, maxLen 4096)", () => {
      const header = plainBody("H".repeat(4080));
      const body = plainBody("B".repeat(10000));
      const footer = plainBody("");
      const result = splitTelegramMessage(header, body, footer, 4096);
      expect(result.length).toBeLessThan(60);
      for (const chunk of result) {
        expect(chunk.text.length).toBeLessThanOrEqual(4096);
      }
    });

    it("enforces maxLen invariant and bounds chunk count when footer alone exceeds maxLen", () => {
      const header = plainBody("HEADER");
      const body = plainBody("B".repeat(10000));
      const footer = plainBody("F".repeat(5000));
      const result = splitTelegramMessage(header, body, footer, 4096);
      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThan(60);
      for (const chunk of result) {
        expect(chunk.text.length).toBeLessThanOrEqual(4096);
      }
    });

    it("keeps entity offsets within range after header truncation", () => {
      const header: TgMessage = {
        text: "H".repeat(4200),
        entities: [{ offset: 0, length: 4200, type: "bold" }],
      };
      const body: TgMessage = {
        text: "B".repeat(500),
        entities: [{ offset: 10, length: 100, type: "code" }],
      };
      const footer: TgMessage = {
        text: "F".repeat(10),
        entities: [{ offset: 0, length: 10, type: "italic" }],
      };
      const result = splitTelegramMessage(header, body, footer, 4096);
      expect(result.length).toBeGreaterThan(0);
      for (const chunk of result) {
        expect(chunk.text.length).toBeLessThanOrEqual(4096);
        for (const entity of chunk.entities) {
          expect(entity.offset).toBeGreaterThanOrEqual(0);
          expect(entity.offset + entity.length).toBeLessThanOrEqual(chunk.text.length);
        }
      }
    });

    it("never splits surrogate pairs on body hard-cut and reconstructs original body", () => {
      const originalBodyText = "x".repeat(4085) + "😀" + "y".repeat(200);
      const header = plainBody("Hdr");
      const footer = plainBody("Ftr");
      const result = splitTelegramMessage(header, plainBody(originalBodyText), footer, 4096);

      expect(result.length).toBeGreaterThan(1);
      for (const chunk of result) {
        expect(chunk.text.length).toBeLessThanOrEqual(4096);
        expect(hasLoneSurrogate(chunk.text)).toBe(false);
      }

      // Reconstruct body text from chunks and verify byte-for-byte equivalence
      const reconstructedBody = result
        .map((chunk) => {
          const prefix = "Hdr\n\n";
          const suffix = "\n\nFtr";
          return chunk.text.slice(prefix.length, chunk.text.length - suffix.length);
        })
        .join("");

      expect(reconstructedBody).toBe(originalBodyText);
    });

    it("returns without infinite loop on tiny maxLen", () => {
      const header = plainBody("Header");
      const body = plainBody("hello");
      const footer = plainBody("Footer");
      const result = splitTelegramMessage(header, body, footer, 3);
      expect(result.length).toBeGreaterThan(0);
      for (const chunk of result) {
        expect(chunk.text.length).toBeLessThanOrEqual(3);
        expect(hasLoneSurrogate(chunk.text)).toBe(false);
      }
    });

    it("property sweep: satisfies maxLen, chunk count bounds, entity bounds, and surrogate integrity for all size combinations", () => {
      const maxLen = 4096;
      const minBodyBudget = Math.min(200, Math.floor(maxLen / 4));
      for (const headerLen of [0, 50, 4000, 4092, 4200]) {
        for (const footerLen of [0, 10, 100, 5000]) {
          for (const bodyLen of [0, 2, 500, 10000]) {
            const h: TgMessage = {
              text: "H".repeat(headerLen),
              entities: headerLen > 0 ? [{ offset: 0, length: headerLen, type: "bold" }] : [],
            };
            const f: TgMessage = {
              text: "F".repeat(footerLen),
              entities: footerLen > 0 ? [{ offset: 0, length: footerLen, type: "italic" }] : [],
            };
            const b: TgMessage = {
              text: "B".repeat(bodyLen),
              entities: bodyLen > 10 ? [{ offset: 2, length: Math.min(8, bodyLen - 2), type: "code" }] : [],
            };
            const result = splitTelegramMessage(h, b, f, maxLen);
            expect(result.length).toBeGreaterThan(0);
            const expectedMaxChunks = bodyLen === 0 ? 1 : Math.ceil(bodyLen / minBodyBudget) + 5;
            expect(result.length).toBeLessThanOrEqual(expectedMaxChunks);
            for (const chunk of result) {
              expect(chunk.text.length).toBeLessThanOrEqual(maxLen);
              expect(hasLoneSurrogate(chunk.text)).toBe(false);
              for (const entity of chunk.entities) {
                expect(entity.offset).toBeGreaterThanOrEqual(0);
                expect(entity.offset + entity.length).toBeLessThanOrEqual(chunk.text.length);
              }
            }
          }
        }
      }
    });
  });
});
