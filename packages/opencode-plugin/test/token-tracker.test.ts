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

import { TokenTracker } from "../src/token-tracker"

describe("TokenTracker.onMessageUpdated", () => {
  test("ignores non-assistant messages", () => {
    const t = new TokenTracker()
    t.onMessageUpdated({
      id: "m1",
      sessionID: "s1",
      role: "user",
      tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
    expect(t.getSnapshot("s1")).toBeUndefined()
  })

  test("ignores assistant messages with output=0", () => {
    const t = new TokenTracker()
    t.onMessageUpdated({
      id: "m1",
      sessionID: "s1",
      role: "assistant",
      tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
    expect(t.getSnapshot("s1")).toBeUndefined()
  })

  test("captures latest assistant message with output>0", () => {
    const t = new TokenTracker()
    t.onMessageUpdated({
      id: "m1",
      sessionID: "s1",
      role: "assistant",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 5 } },
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
    const snap = t.getSnapshot("s1")
    expect(snap).toEqual({
      messageId: "m1",
      total: 165,
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
  })

  test("replaces snapshot when newer assistant message arrives", () => {
    const t = new TokenTracker()
    t.onMessageUpdated({
      id: "m1",
      sessionID: "s1",
      role: "assistant",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
    t.onMessageUpdated({
      id: "m2",
      sessionID: "s1",
      role: "assistant",
      tokens: { input: 200, output: 100, reasoning: 5, cache: { read: 20, write: 0 } },
      providerID: "anthropic",
      modelID: "claude-opus-4-5",
    })
    expect(t.getSnapshot("s1")).toEqual({
      messageId: "m2",
      total: 325,
      providerID: "anthropic",
      modelID: "claude-opus-4-5",
    })
  })

  test("scopes snapshots per session", () => {
    const t = new TokenTracker()
    t.onMessageUpdated({
      id: "m1",
      sessionID: "s1",
      role: "assistant",
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
    t.onMessageUpdated({
      id: "m2",
      sessionID: "s2",
      role: "assistant",
      tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      providerID: "anthropic",
      modelID: "claude-opus-4-5",
    })
    expect(t.getSnapshot("s1")?.total).toBe(15)
    expect(t.getSnapshot("s2")?.total).toBe(30)
  })

  test("clear removes session", () => {
    const t = new TokenTracker()
    t.onMessageUpdated({
      id: "m1",
      sessionID: "s1",
      role: "assistant",
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
    t.clear("s1")
    expect(t.getSnapshot("s1")).toBeUndefined()
  })
})
