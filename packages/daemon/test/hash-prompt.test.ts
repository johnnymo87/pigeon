import { describe, expect, it } from "vitest";
import { hashPrompt } from "../src/hash-prompt";
import { createHash } from "node:crypto";

describe("hashPrompt", () => {
  it("returns sha256 hex digest of input string", () => {
    const text = "Hello world!";
    const expected = createHash("sha256").update(text).digest("hex");
    expect(hashPrompt(text)).toBe(expected);
  });

  it("handles empty string", () => {
    const expected = createHash("sha256").update("").digest("hex");
    expect(hashPrompt("")).toBe(expected);
  });
});
