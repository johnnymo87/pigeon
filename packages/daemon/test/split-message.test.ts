import { describe, expect, it } from "vitest";
import { splitTelegramMessage } from "../src/split-message";

describe("splitTelegramMessage", () => {
  const header = "HEADER";
  const footer = "FOOTER";
  // overhead = "HEADER" (6) + "\n\n" (2) + "\n\n" (2) + "FOOTER" (6) = 16

  it("returns single message when body fits", () => {
    const result = splitTelegramMessage(header, "Short body", footer, 100);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("HEADER\n\nShort body\n\nFOOTER");
  });

  it("splits on paragraph boundary (double newline)", () => {
    const body = "Paragraph one.\n\nParagraph two.";
    // overhead=16, so maxBody = 30 - 16 = 14. "Paragraph one." is 14 chars. Fits exactly.
    const result = splitTelegramMessage(header, body, footer, 30);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("HEADER\n\nParagraph one.\n\nFOOTER");
    expect(result[1]).toBe("HEADER\n\nParagraph two.\n\nFOOTER");
  });

  it("splits on line boundary when no paragraph break fits", () => {
    const body = "Line one.\nLine two.";
    // overhead=16, maxBody=26-16=10. "Line one." is 9 chars.
    const result = splitTelegramMessage(header, body, footer, 26);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("Line one.");
    expect(result[1]).toContain("Line two.");
  });

  it("splits on sentence boundary when no line break fits", () => {
    const body = "First sentence. Second sentence.";
    // overhead=16, maxBody=32-16=16. "First sentence." is 15 chars.
    const result = splitTelegramMessage(header, body, footer, 32);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("First sentence.");
    expect(result[1]).toContain("Second sentence.");
  });

  it("hard-cuts when no natural boundary found", () => {
    const body = "x".repeat(100);
    // overhead=16, maxBody=50-16=34
    const result = splitTelegramMessage(header, body, footer, 50);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
    // Verify all content is preserved
    const bodies = result.map(c => c.replace("HEADER\n\n", "").replace("\n\nFOOTER", ""));
    expect(bodies.join("")).toBe(body);
  });

  it("uses 4096 as default maxLen", () => {
    const body = "x".repeat(4000);
    const result = splitTelegramMessage(header, body, footer);
    expect(result).toHaveLength(1);
  });

  it("handles empty body", () => {
    const result = splitTelegramMessage(header, "", footer, 100);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("HEADER\n\n\n\nFOOTER");
  });

  it("handles body that is exactly maxBody size", () => {
    const overhead = header.length + footer.length + 4; // 4 for two "\n\n"
    const body = "x".repeat(100 - overhead);
    const result = splitTelegramMessage(header, body, footer, 100);
    expect(result).toHaveLength(1);
  });

  it("preserves content across all chunks (no data loss)", () => {
    const body = "Alpha.\n\nBravo.\n\nCharlie.\n\nDelta.\n\nEcho.";
    const result = splitTelegramMessage(header, body, footer, 32);
    const reconstructed = result
      .map(c => c.replace("HEADER\n\n", "").replace("\n\nFOOTER", ""))
      .join("\n\n");
    expect(reconstructed).toBe(body);
  });

  it("handles empty header and footer", () => {
    const body = "Some content";
    const result = splitTelegramMessage("", body, "", 100);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("\n\nSome content\n\n");
  });
});
