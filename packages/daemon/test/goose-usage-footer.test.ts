import { describe, expect, it } from "vitest";
import {
  formatGooseUsageFooter,
  parseGooseUsage,
  type GooseUsage,
} from "../src/goose/usage-footer.js";

describe("parseGooseUsage", () => {
  it("parses valid hook usage object with cost", () => {
    const raw = {
      used: 45231,
      size: 200000,
      cost: { amount: 1.84, currency: "USD" },
    };
    expect(parseGooseUsage(raw)).toEqual({
      used: 45231,
      size: 200000,
      cost: { amount: 1.84, currency: "USD" },
    });
  });

  it("parses valid usage_update update object", () => {
    const raw = {
      sessionUpdate: "usage_update",
      used: 53000,
      size: 200000,
      cost: { amount: 0.045, currency: "USD" },
    };
    expect(parseGooseUsage(raw)).toEqual({
      used: 53000,
      size: 200000,
      cost: { amount: 0.045, currency: "USD" },
    });
  });

  it("treats missing, null, or invalid size as 0", () => {
    expect(parseGooseUsage({ used: 812 })).toEqual({
      used: 812,
      size: 0,
    });
    expect(parseGooseUsage({ used: 812, size: null })).toEqual({
      used: 812,
      size: 0,
    });
    expect(parseGooseUsage({ used: 100, size: -5 })).toEqual({
      used: 100,
      size: 0,
    });
    expect(parseGooseUsage({ used: 100, size: "200000" })).toEqual({
      used: 100,
      size: 0,
    });
    expect(parseGooseUsage({ used: 100, size: NaN })).toEqual({
      used: 100,
      size: 0,
    });
    expect(parseGooseUsage({ used: 100, size: Infinity })).toEqual({
      used: 100,
      size: 0,
    });
    expect(parseGooseUsage({ used: 100, size: -Infinity })).toEqual({
      used: 100,
      size: 0,
    });
    expect(parseGooseUsage({ used: 100, size: {} })).toEqual({
      used: 100,
      size: 0,
    });
    expect(parseGooseUsage({ used: 100, size: [] })).toEqual({
      used: 100,
      size: 0,
    });
    expect(parseGooseUsage({ used: 100, size: true })).toEqual({
      used: 100,
      size: 0,
    });
  });

  it("omits cost when absent, null, or malformed, keeping token count and size", () => {
    expect(parseGooseUsage({ used: 12300, size: 200000 })).toEqual({
      used: 12300,
      size: 200000,
    });
    expect(parseGooseUsage({ used: 100, size: 200, cost: null })).toEqual({
      used: 100,
      size: 200,
    });
    expect(parseGooseUsage({ used: 100, cost: "free" })).toEqual({
      used: 100,
      size: 0,
    });
    expect(parseGooseUsage({ used: 100, cost: 123 })).toEqual({
      used: 100,
      size: 0,
    });
    expect(parseGooseUsage({ used: 100, cost: true })).toEqual({
      used: 100,
      size: 0,
    });
    expect(parseGooseUsage({ used: 100, cost: [] })).toEqual({
      used: 100,
      size: 0,
    });
    expect(parseGooseUsage({ used: 100, cost: { currency: "USD" } })).toEqual({
      used: 100,
      size: 0,
    });
    expect(
      parseGooseUsage({ used: 100, cost: { amount: "1.84", currency: "USD" } }),
    ).toEqual({
      used: 100,
      size: 0,
    });
    expect(
      parseGooseUsage({ used: 100, cost: { amount: NaN, currency: "USD" } }),
    ).toEqual({
      used: 100,
      size: 0,
    });
    expect(
      parseGooseUsage({ used: 100, cost: { amount: Infinity, currency: "USD" } }),
    ).toEqual({
      used: 100,
      size: 0,
    });
    expect(
      parseGooseUsage({ used: 100, cost: { amount: -Infinity, currency: "USD" } }),
    ).toEqual({
      used: 100,
      size: 0,
    });
    expect(parseGooseUsage({ used: 100, cost: { amount: 1.84 } })).toEqual({
      used: 100,
      size: 0,
    });
    expect(
      parseGooseUsage({ used: 100, cost: { amount: 1.84, currency: "" } }),
    ).toEqual({
      used: 100,
      size: 0,
    });
    expect(
      parseGooseUsage({ used: 100, cost: { amount: 1.84, currency: 123 } }),
    ).toEqual({
      used: 100,
      size: 0,
    });
  });

  it("keeps valid cost even if size is null or invalid", () => {
    expect(
      parseGooseUsage({
        used: 500,
        size: null,
        cost: { amount: 0.05, currency: "USD" },
      }),
    ).toEqual({
      used: 500,
      size: 0,
      cost: { amount: 0.05, currency: "USD" },
    });
    expect(
      parseGooseUsage({
        used: 500,
        size: -10,
        cost: { amount: 0.05, currency: "USD" },
      }),
    ).toEqual({
      used: 500,
      size: 0,
      cost: { amount: 0.05, currency: "USD" },
    });
  });

  it("returns undefined for non-objects or null/arrays", () => {
    expect(parseGooseUsage(null)).toBeUndefined();
    expect(parseGooseUsage(undefined)).toBeUndefined();
    expect(parseGooseUsage("string")).toBeUndefined();
    expect(parseGooseUsage(123)).toBeUndefined();
    expect(parseGooseUsage([])).toBeUndefined();
  });

  it("returns undefined when used is missing, string, negative, NaN, or non-finite", () => {
    expect(parseGooseUsage({})).toBeUndefined();
    expect(parseGooseUsage({ size: 1000 })).toBeUndefined();
    expect(parseGooseUsage({ used: "100", size: 1000 })).toBeUndefined();
    expect(parseGooseUsage({ used: -1, size: 1000 })).toBeUndefined();
    expect(parseGooseUsage({ used: NaN, size: 1000 })).toBeUndefined();
    expect(parseGooseUsage({ used: Infinity, size: 1000 })).toBeUndefined();
    expect(parseGooseUsage({ used: -Infinity, size: 1000 })).toBeUndefined();
    expect(parseGooseUsage({ used: null })).toBeUndefined();
    expect(parseGooseUsage({ used: undefined })).toBeUndefined();
    expect(parseGooseUsage({ used: {} })).toBeUndefined();
  });
});

describe("formatGooseUsageFooter", () => {
  it("formats example 1: used=45231, size=200000, cost=1.84 USD", () => {
    const usage: GooseUsage = {
      used: 45231,
      size: 200000,
      cost: { amount: 1.84, currency: "USD" },
    };
    expect(formatGooseUsageFooter(usage)).toBe("📊 45.2K tokens · 23% · $1.84");
  });

  it("formats example 2: used=812, size=0", () => {
    const usage: GooseUsage = {
      used: 812,
      size: 0,
    };
    expect(formatGooseUsageFooter(usage)).toBe("📊 812 tokens");
  });

  it("formats example 3: used=12300, size=200000", () => {
    const usage: GooseUsage = {
      used: 12300,
      size: 200000,
    };
    expect(formatGooseUsageFooter(usage)).toBe("📊 12.3K tokens · 6%");
  });

  it("formats non-USD currency via Intl (e.g. EUR)", () => {
    const usage: GooseUsage = {
      used: 5000,
      size: 10000,
      cost: { amount: 2.5, currency: "EUR" },
    };
    expect(formatGooseUsageFooter(usage)).toBe("📊 5.0K tokens · 50% · €2.50");
  });

  it("falls back to `${amount.toFixed(2)} ${currency}` when Intl throws on bogus currency", () => {
    const usage: GooseUsage = {
      used: 10000,
      size: 50000,
      cost: { amount: 1.84, currency: "BOGUS_CURRENCY" },
    };
    expect(formatGooseUsageFooter(usage)).toBe("📊 10.0K tokens · 20% · 1.84 BOGUS_CURRENCY");
  });

  it("omits cost segment when amount is 0 or negative", () => {
    const usageZero: GooseUsage = {
      used: 500,
      size: 1000,
      cost: { amount: 0, currency: "USD" },
    };
    expect(formatGooseUsageFooter(usageZero)).toBe("📊 500 tokens · 50%");

    const usageNeg: GooseUsage = {
      used: 500,
      size: 1000,
      cost: { amount: -0.5, currency: "USD" },
    };
    expect(formatGooseUsageFooter(usageNeg)).toBe("📊 500 tokens · 50%");
  });

  it("returns undefined when used is 0", () => {
    const usage: GooseUsage = {
      used: 0,
      size: 200000,
      cost: { amount: 1.84, currency: "USD" },
    };
    expect(formatGooseUsageFooter(usage)).toBeUndefined();
  });

  it("handles percentage exceeding 100", () => {
    const usage: GooseUsage = {
      used: 250000,
      size: 200000,
    };
    expect(formatGooseUsageFooter(usage)).toBe("📊 250.0K tokens · 125%");
  });

  it("formats large token count (>= 1M) with M suffix", () => {
    const usage: GooseUsage = {
      used: 1500000,
      size: 2000000,
    };
    expect(formatGooseUsageFooter(usage)).toBe("📊 1.5M tokens · 75%");
  });
});
