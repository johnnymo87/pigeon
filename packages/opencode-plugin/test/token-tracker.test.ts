import { describe, expect, test } from "vitest"
import { formatTokenCount, TokenTracker, ProviderCache } from "../src/token-tracker"

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

  test("ignores assistant message with no tokens field", () => {
    const t = new TokenTracker()
    t.onMessageUpdated({
      id: "m1",
      sessionID: "s1",
      role: "assistant",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
    expect(t.getSnapshot("s1")).toBeUndefined()
  })

  test("ignores assistant message missing providerID or modelID", () => {
    const t = new TokenTracker()
    t.onMessageUpdated({
      id: "m1",
      sessionID: "s1",
      role: "assistant",
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "claude-sonnet-4-5",
    })
    expect(t.getSnapshot("s1")).toBeUndefined()

    t.onMessageUpdated({
      id: "m2",
      sessionID: "s2",
      role: "assistant",
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      providerID: "anthropic",
    })
    expect(t.getSnapshot("s2")).toBeUndefined()
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

describe("ProviderCache.getContextLimit", () => {
  function makeFakeClient(providers: Array<{
    id: string
    models: Record<string, { limit: { context: number; output: number } }>
  }>, opts: { fail?: boolean } = {}) {
    let calls = 0
    return {
      calls: () => calls,
      client: {
        config: {
          providers: async () => {
            calls += 1
            if (opts.fail) throw new Error("network down")
            return { data: { providers, default: {} } }
          },
        },
      },
    }
  }

  test("returns context limit for known model", async () => {
    const fake = makeFakeClient([
      { id: "anthropic", models: { "claude-sonnet-4-5": { limit: { context: 200_000, output: 8_000 } } } },
    ])
    const cache = new ProviderCache()
    const limit = await cache.getContextLimit(fake.client as any, "anthropic", "claude-sonnet-4-5")
    expect(limit).toBe(200_000)
  })

  test("caches result across calls", async () => {
    const fake = makeFakeClient([
      { id: "anthropic", models: { "claude-sonnet-4-5": { limit: { context: 200_000, output: 8_000 } } } },
    ])
    const cache = new ProviderCache()
    await cache.getContextLimit(fake.client as any, "anthropic", "claude-sonnet-4-5")
    await cache.getContextLimit(fake.client as any, "anthropic", "claude-sonnet-4-5")
    expect(fake.calls()).toBe(1)
  })

  test("returns undefined for unknown model after one refresh attempt", async () => {
    const fake = makeFakeClient([
      { id: "anthropic", models: { "claude-sonnet-4-5": { limit: { context: 200_000, output: 8_000 } } } },
    ])
    const cache = new ProviderCache()
    const limit = await cache.getContextLimit(fake.client as any, "anthropic", "claude-opus-4-5")
    expect(limit).toBeUndefined()
    expect(fake.calls()).toBe(1)
  })

  test("returns undefined and logs once when fetch fails", async () => {
    const fake = makeFakeClient([], { fail: true })
    const logs: string[] = []
    const cache = new ProviderCache((msg) => logs.push(msg))
    const limit1 = await cache.getContextLimit(fake.client as any, "anthropic", "claude-sonnet-4-5")
    const limit2 = await cache.getContextLimit(fake.client as any, "anthropic", "claude-sonnet-4-5")
    expect(limit1).toBeUndefined()
    expect(limit2).toBeUndefined()
    expect(logs.length).toBe(1)
  })
})

describe("TokenTracker.getFooter", () => {
  function makeFakeClient(contextLimit: number | undefined) {
    return {
      config: {
        providers: async () => ({
          data: {
            providers: contextLimit !== undefined
              ? [{ id: "anthropic", models: { "claude-sonnet-4-5": { limit: { context: contextLimit, output: 8_000 } } } }]
              : [],
            default: {},
          },
        }),
      },
    } as any
  }

  test("returns empty string when no snapshot", async () => {
    const t = new TokenTracker()
    const cache = new ProviderCache()
    const footer = await t.getFooter("s1", makeFakeClient(200_000), cache)
    expect(footer).toBe("")
  })

  test("returns tokens + percent when limit known", async () => {
    const t = new TokenTracker()
    const cache = new ProviderCache()
    t.onMessageUpdated({
      id: "m1",
      sessionID: "s1",
      role: "assistant",
      tokens: { input: 12_000, output: 300, reasoning: 0, cache: { read: 45, write: 0 } },
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
    const footer = await t.getFooter("s1", makeFakeClient(200_000), cache)
    expect(footer).toBe("📊 12.3K tokens · 6%")
  })

  test("returns tokens-only when model unknown", async () => {
    const t = new TokenTracker()
    const cache = new ProviderCache()
    t.onMessageUpdated({
      id: "m1",
      sessionID: "s1",
      role: "assistant",
      tokens: { input: 12_000, output: 300, reasoning: 0, cache: { read: 45, write: 0 } },
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
    const footer = await t.getFooter("s1", makeFakeClient(undefined), cache)
    expect(footer).toBe("📊 12.3K tokens")
  })

  test("returns tokens-only when provider fetch throws", async () => {
    const t = new TokenTracker()
    const cache = new ProviderCache()
    const failing = {
      config: { providers: async () => { throw new Error("boom") } },
    } as any
    t.onMessageUpdated({
      id: "m1",
      sessionID: "s1",
      role: "assistant",
      tokens: { input: 12_000, output: 300, reasoning: 0, cache: { read: 45, write: 0 } },
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
    const footer = await t.getFooter("s1", failing, cache)
    expect(footer).toBe("📊 12.3K tokens")
  })

  test("rounds percent to nearest integer", async () => {
    const t = new TokenTracker()
    const cache = new ProviderCache()
    t.onMessageUpdated({
      id: "m1",
      sessionID: "s1",
      role: "assistant",
      tokens: { input: 7_000, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
    // 7001 / 200000 = 3.5005% → rounds to 4
    const footer = await t.getFooter("s1", makeFakeClient(200_000), cache)
    expect(footer).toBe("📊 7.0K tokens · 4%")
  })

  test("returns empty string when snapshot total is NaN", async () => {
    const t = new TokenTracker()
    // Inject a NaN-total snapshot directly; guards against a pathological SDK
    // payload even though onMessageUpdated wouldn't normally create one.
    ;(t as any).snapshots.set("s1", {
      messageId: "m1",
      total: NaN,
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
    const footer = await t.getFooter("s1", makeFakeClient(200_000), new ProviderCache())
    expect(footer).toBe("")
  })
})
