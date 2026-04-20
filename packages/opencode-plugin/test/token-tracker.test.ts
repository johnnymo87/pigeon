import { describe, expect, test } from "vitest"
import { formatTokenCount } from "../src/token-tracker"

describe("formatTokenCount", () => {
  test("returns plain number under 1000", () => {
    expect(formatTokenCount(0)).toBe("0")
    expect(formatTokenCount(1)).toBe("1")
    expect(formatTokenCount(999)).toBe("999")
  })

  test("uses K suffix for thousands", () => {
    expect(formatTokenCount(1_000)).toBe("1.0K")
    expect(formatTokenCount(1_500)).toBe("1.5K")
    expect(formatTokenCount(12_345)).toBe("12.3K")
    expect(formatTokenCount(999_999)).toBe("1000.0K")
  })

  test("uses M suffix for millions", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0M")
    expect(formatTokenCount(1_500_000)).toBe("1.5M")
    expect(formatTokenCount(12_345_678)).toBe("12.3M")
  })

  test("handles negative or NaN as 0", () => {
    expect(formatTokenCount(-1)).toBe("0")
    expect(formatTokenCount(NaN)).toBe("0")
  })
})
