import { describe, it, expect } from "vitest";
import {
  parseQuoteResult,
  QuoteUnsupportedError,
  isValidQuotePick,
  isValidQuoteMetadata,
  type QuoteResult,
} from "../src/goose/quote-types.js";

describe("QuoteUnsupportedError", () => {
  it("defaults to expected message and name", () => {
    const err = new QuoteUnsupportedError();
    expect(err.name).toBe("QuoteUnsupportedError");
    expect(err.message).toBe("honkd does not support _honk/quote");
  });

  it("preserves custom message", () => {
    const err = new QuoteUnsupportedError("custom error");
    expect(err.message).toBe("custom error");
  });
});

describe("parseQuoteResult", () => {
  const validResult: QuoteResult = {
    summary: "# honk: trimmed by claude-opus-5-5, kept 12 of 80 lines",
    replies: [
      {
        header: "# 11-24 13:05 (wake: mail) · ask",
        passages: [["line 1", "", "line 2"], ["line 3"]],
        inProgress: false,
      },
    ],
    notices: ["fell back to last 3"],
    warnings: ["trim failed on 1 passage"],
    empty: null,
    model: "claude-opus-5-5",
  };

  it("parses a valid QuoteResult", () => {
    const parsed = parseQuoteResult(validResult);
    expect(parsed).toEqual(validResult);
  });

  it("normalizes optional/nullable fields when null or omitted", () => {
    const minimal = {
      replies: [
        {
          header: "reply 1",
          passages: [],
          inProgress: true,
        },
      ],
    };
    const parsed = parseQuoteResult(minimal);
    expect(parsed).toEqual({
      summary: null,
      replies: [
        {
          header: "reply 1",
          passages: [],
          inProgress: true,
        },
      ],
      notices: [],
      warnings: [],
      empty: null,
      model: null,
    });
  });

  it("accepts all valid empty reasons", () => {
    const reasons = [
      "no_replies",
      "never_spoke",
      "nothing_since",
      "one_prompt",
      "nothing_kept",
    ] as const;

    for (const empty of reasons) {
      const parsed = parseQuoteResult({ replies: [], empty });
      expect(parsed.empty).toBe(empty);
    }
  });

  it("throws on non-object or null input", () => {
    expect(() => parseQuoteResult(null)).toThrow(/malformed _honk\/quote result/);
    expect(() => parseQuoteResult(undefined)).toThrow(/malformed _honk\/quote result/);
    expect(() => parseQuoteResult("string")).toThrow(/malformed _honk\/quote result/);
    expect(() => parseQuoteResult(123)).toThrow(/malformed _honk\/quote result/);
  });

  it("throws on missing or non-array replies", () => {
    expect(() => parseQuoteResult({})).toThrow(/malformed _honk\/quote result/);
    expect(() => parseQuoteResult({ replies: "not-an-array" })).toThrow(/malformed _honk\/quote result/);
  });

  it("throws on invalid reply header or inProgress", () => {
    expect(() =>
      parseQuoteResult({
        replies: [{ passages: [], inProgress: false }],
      }),
    ).toThrow(/malformed _honk\/quote result/);

    expect(() =>
      parseQuoteResult({
        replies: [{ header: 123, passages: [], inProgress: false }],
      }),
    ).toThrow(/malformed _honk\/quote result/);

    expect(() =>
      parseQuoteResult({
        replies: [{ header: "h", passages: [], inProgress: "yes" }],
      }),
    ).toThrow(/malformed _honk\/quote result/);
  });

  it("throws on non-array passages or passage containing non-string", () => {
    expect(() =>
      parseQuoteResult({
        replies: [{ header: "h", inProgress: false }],
      }),
    ).toThrow(/malformed _honk\/quote result/);

    expect(() =>
      parseQuoteResult({
        replies: [{ header: "h", passages: ["not an array of arrays"], inProgress: false }],
      }),
    ).toThrow(/malformed _honk\/quote result/);

    expect(() =>
      parseQuoteResult({
        replies: [{ header: "h", passages: [[123]], inProgress: false }],
      }),
    ).toThrow(/malformed _honk\/quote result/);

    expect(() =>
      parseQuoteResult({
        replies: [{ header: "h", passages: [[null]], inProgress: false }],
      }),
    ).toThrow(/malformed _honk\/quote result/);
  });

  it("throws on invalid empty reason", () => {
    expect(() =>
      parseQuoteResult({
        replies: [],
        empty: "invalid_reason",
      }),
    ).toThrow(/malformed _honk\/quote result/);
  });

  it("throws on invalid summary or model", () => {
    expect(() =>
      parseQuoteResult({
        replies: [],
        summary: 123,
      }),
    ).toThrow(/malformed _honk\/quote result/);

    expect(() =>
      parseQuoteResult({
        replies: [],
        model: {},
      }),
    ).toThrow(/malformed _honk\/quote result/);
  });

  it("throws on invalid notices or warnings", () => {
    expect(() =>
      parseQuoteResult({
        replies: [],
        notices: "not-an-array",
      }),
    ).toThrow(/malformed _honk\/quote result/);

    expect(() =>
      parseQuoteResult({
        replies: [],
        notices: [123],
      }),
    ).toThrow(/malformed _honk\/quote result/);

    expect(() =>
      parseQuoteResult({
        replies: [],
        warnings: [null],
      }),
    ).toThrow(/malformed _honk\/quote result/);
  });
});

describe("isValidQuotePick and isValidQuoteMetadata", () => {
  it("validates quote picks", () => {
    expect(isValidQuotePick({ kind: "since" })).toBe(true);
    expect(isValidQuotePick({ kind: "prev" })).toBe(true);
    expect(isValidQuotePick({ kind: "last", n: 3 })).toBe(true);
    expect(isValidQuotePick({ kind: "last", n: 0 })).toBe(false);
    expect(isValidQuotePick({ kind: "last", n: -1 })).toBe(false);
    expect(isValidQuotePick({ kind: "last", n: 1.5 })).toBe(false);
    expect(isValidQuotePick({ kind: "unknown" })).toBe(false);
    expect(isValidQuotePick(null)).toBe(false);
    expect(isValidQuotePick("since")).toBe(false);
  });

  it("validates quote metadata", () => {
    expect(isValidQuoteMetadata({ pick: { kind: "since" }, full: false })).toBe(true);
    expect(isValidQuoteMetadata({ pick: { kind: "prev" }, full: true })).toBe(true);
    expect(isValidQuoteMetadata({ pick: { kind: "last", n: 5 }, full: false })).toBe(true);
    expect(isValidQuoteMetadata({ pick: { kind: "since" } })).toBe(false);
    expect(isValidQuoteMetadata({ pick: "since", full: false })).toBe(false);
    expect(isValidQuoteMetadata(null)).toBe(false);
    expect(isValidQuoteMetadata({})).toBe(false);
  });
});
