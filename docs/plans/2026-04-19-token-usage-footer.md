# Token Usage Footer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Execution is **in the current session** (not a parallel session).

## Resumption Checklist (post-compaction)

If you're picking this up fresh:

1. **Read this whole plan file first**, top to bottom.
2. **Read the design doc** at `docs/plans/2026-04-19-token-usage-footer-design.md` for the "why".
3. **Check progress**: `git log --oneline origin/main..HEAD` — each completed task has its own commit.
4. **Check working tree**: `git status` should be clean when resuming between tasks.
5. **Working branch**: `main` (user explicitly chose to work on main, no feature branch — do NOT create one unless asked).
6. **Execution method**: subagent-driven-development skill. Dispatch one `implementer` subagent per task, then `spec-reviewer`, then `code-quality-reviewer`. Templates in `~/.config/opencode/skills/superpowers/subagent-driven-development/*.md`.
7. **Subagent type to use**: `general` (project has `general`, `explore`, `oracle`, `code-reviewer`, `implementer`, etc. — `implementer` or `general` both acceptable for implementer role; `code-reviewer` for quality review).
8. **Pass full task text to each subagent** — do not make them read the plan file. Copy the task's step-by-step text directly into the prompt.
9. **Stage only feature-related files** when committing. There are no other pending unrelated changes right now (tree was cleaned up before compaction), but stay disciplined.

### Progress tracker

| Task | Status | Commit |
|------|--------|--------|
| 1. `formatTokenCount` helper | ✅ done | d730782 |
| 2. `TokenTracker.onMessageUpdated` + `getSnapshot` | ✅ done | 903677a (+583503b tests) |
| 3. `ProviderCache` for context-limit lookups | ✅ done | 3840fe4 (+595fd96 docs) |
| 4. `TokenTracker.getFooter` | ⏳ not started | — |
| 5. Wire `TokenTracker` into the plugin | ⏳ not started | — |
| 6. End-to-end verification + `AGENTS.md` docs | ⏳ not started | — |

Update this table as tasks complete (e.g. `✅ done` + short SHA).

### Key context (non-obvious)

- **`ctx.client.config.providers()`** is the SDK method used to resolve model context limits. Returns `{ data: { providers: Array<{id, models: {[modelID]: {limit: {context, output}}}}> } }`. Plugin already has `ctx.client` in scope.
- **TUI reference implementation** lives at `~/projects/opencode/packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/context.tsx`. Matches the token formula exactly: `input + output + reasoning + cache.read + cache.write`, capture latest assistant message with `output > 0`.
- **Task 3 has a subtle test/impl mismatch**: the unknown-model test expects `calls() === 1`, and the plan's FIRST implementation sketch would make it `2`. The plan explicitly includes a correction under "Note on the 'one more refresh' behavior" — use the FINAL version in that task, not the first sketch.
- **Daemon side has zero changes**. Footer is appended plugin-side into the `message` field of `notifyStop`. Daemon already relays `body.message` straight to `formatTelegramNotification`.
- **Two `notifyStop` call sites** in `packages/opencode-plugin/src/index.ts`: the main stop flow (near line 346) AND the question.asked stop flush (near line 496). BOTH need the footer appended.
- **User preference**: keep it minimal. No cost tracking, no thresholds, no color. Just `📊 12.3K tokens · 7%`.

---

**Goal:** Append a compact `📊 12.3K tokens · 7%` footer to OpenCode stop notifications relayed to Telegram, mirroring the TUI sidebar context display.

**Architecture:** Plugin captures `tokens`, `providerID`, `modelID` from `message.updated` events for assistant messages. A lazy provider/model cache (one-shot `ctx.client.config.providers()` call) supplies the context window limit. Footer is formatted plugin-side and prepended into the existing `notifyStop` `message` field — daemon needs no changes.

**Tech Stack:** TypeScript, Vitest, OpenCode SDK v1, Node 20+.

**Design doc:** [docs/plans/2026-04-19-token-usage-footer-design.md](./2026-04-19-token-usage-footer-design.md)

**Relevant skills:**
- @.opencode/skills/opencode-plugin-development/SKILL.md — TDD workflow for plugin
- @.opencode/skills/opencode-plugin-architecture/SKILL.md — event lifecycle reference
- @.opencode/skills/opencode-plugin-deployment/SKILL.md — rollout

---

### Task 1: Number formatting helper

**Files:**
- Create: `packages/opencode-plugin/src/token-tracker.ts`
- Test: `packages/opencode-plugin/test/token-tracker.test.ts`

**Step 1: Write the failing tests**

Create `packages/opencode-plugin/test/token-tracker.test.ts`:

```ts
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
```

**Step 2: Run tests to verify they fail**

Run: `npm --workspace @pigeon/opencode-plugin run test -- token-tracker`
Expected: FAIL — `Cannot find module '../src/token-tracker'`

**Step 3: Implement `formatTokenCount`**

Create `packages/opencode-plugin/src/token-tracker.ts`:

```ts
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n < 1_000) return String(Math.floor(n))
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}
```

**Step 4: Run tests to verify they pass**

Run: `npm --workspace @pigeon/opencode-plugin run test -- token-tracker`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add packages/opencode-plugin/src/token-tracker.ts packages/opencode-plugin/test/token-tracker.test.ts
git commit -m "Add formatTokenCount helper for token tracker"
```

---

### Task 2: TokenTracker.onMessageUpdated + getSnapshot

**Files:**
- Modify: `packages/opencode-plugin/src/token-tracker.ts`
- Modify: `packages/opencode-plugin/test/token-tracker.test.ts`

**Step 1: Write failing tests**

Append to `packages/opencode-plugin/test/token-tracker.test.ts`:

```ts
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
```

**Step 2: Run tests to verify they fail**

Run: `npm --workspace @pigeon/opencode-plugin run test -- token-tracker`
Expected: FAIL — `TokenTracker is not defined` / `t.onMessageUpdated is not a function`

**Step 3: Implement TokenTracker class (snapshot only, no formatting yet)**

Append to `packages/opencode-plugin/src/token-tracker.ts`:

```ts
export type TokenTotals = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type MessageTokenInfo = {
  id: string
  sessionID: string
  role: string
  tokens?: TokenTotals
  providerID?: string
  modelID?: string
}

export type TokenSnapshot = {
  messageId: string
  total: number
  providerID: string
  modelID: string
}

function totalTokens(t: TokenTotals): number {
  return t.input + t.output + t.reasoning + t.cache.read + t.cache.write
}

export class TokenTracker {
  private snapshots = new Map<string, TokenSnapshot>()

  onMessageUpdated(info: MessageTokenInfo): void {
    if (info.role !== "assistant") return
    if (!info.tokens) return
    if (info.tokens.output <= 0) return
    if (!info.providerID || !info.modelID) return

    this.snapshots.set(info.sessionID, {
      messageId: info.id,
      total: totalTokens(info.tokens),
      providerID: info.providerID,
      modelID: info.modelID,
    })
  }

  getSnapshot(sessionID: string): TokenSnapshot | undefined {
    return this.snapshots.get(sessionID)
  }

  clear(sessionID: string): void {
    this.snapshots.delete(sessionID)
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npm --workspace @pigeon/opencode-plugin run test -- token-tracker`
Expected: PASS (10 tests total)

**Step 5: Commit**

```bash
git add packages/opencode-plugin/src/token-tracker.ts packages/opencode-plugin/test/token-tracker.test.ts
git commit -m "Add TokenTracker for capturing assistant message token usage"
```

---

### Task 3: ProviderCache for context-limit lookups

**Files:**
- Modify: `packages/opencode-plugin/src/token-tracker.ts`
- Modify: `packages/opencode-plugin/test/token-tracker.test.ts`

**Step 1: Write failing tests**

Append to `packages/opencode-plugin/test/token-tracker.test.ts`:

```ts
import { ProviderCache } from "../src/token-tracker"

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
```

**Step 2: Run tests to verify they fail**

Run: `npm --workspace @pigeon/opencode-plugin run test -- token-tracker`
Expected: FAIL — `ProviderCache is not defined`

**Step 3: Implement ProviderCache**

Append to `packages/opencode-plugin/src/token-tracker.ts`:

```ts
type ConfigProvidersResponse = {
  data?: {
    providers: Array<{
      id: string
      models: Record<string, { limit?: { context?: number } }>
    }>
  }
}

type SdkLike = {
  config: {
    providers: () => Promise<ConfigProvidersResponse>
  }
}

type LogFn = (message: string) => void

export class ProviderCache {
  private limits = new Map<string, number>() // key = `${providerID}/${modelID}`
  private loaded = false
  private failureLogged = false

  constructor(private log: LogFn = () => {}) {}

  async getContextLimit(client: SdkLike, providerID: string, modelID: string): Promise<number | undefined> {
    const key = `${providerID}/${modelID}`
    if (this.limits.has(key)) return this.limits.get(key)
    if (!this.loaded) {
      await this.refresh(client)
      if (this.limits.has(key)) return this.limits.get(key)
    }
    // Try one more refresh in case providers list changed since startup
    await this.refresh(client)
    return this.limits.get(key)
  }

  private async refresh(client: SdkLike): Promise<void> {
    try {
      const res = await client.config.providers()
      const providers = res?.data?.providers ?? []
      for (const p of providers) {
        for (const [modelID, model] of Object.entries(p.models ?? {})) {
          const ctx = model?.limit?.context
          if (typeof ctx === "number" && ctx > 0) {
            this.limits.set(`${p.id}/${modelID}`, ctx)
          }
        }
      }
      this.loaded = true
    } catch (err) {
      if (!this.failureLogged) {
        this.failureLogged = true
        const msg = err instanceof Error ? err.message : String(err)
        this.log(`token-tracker: provider list fetch failed: ${msg}`)
      }
    }
  }
}
```

**Note on the "one more refresh" behavior:** the unknown-model test expects `calls()===1`, not 2. That test would currently call refresh twice (once because `!loaded`, once at the end). Adjust the implementation so the trailing refresh only fires when `loaded` was already true on entry:

```ts
async getContextLimit(client: SdkLike, providerID: string, modelID: string): Promise<number | undefined> {
  const key = `${providerID}/${modelID}`
  if (this.limits.has(key)) return this.limits.get(key)
  const wasLoaded = this.loaded
  if (!wasLoaded) {
    await this.refresh(client)
    return this.limits.get(key)
  }
  // Already loaded once; try a refresh in case providers list changed
  await this.refresh(client)
  return this.limits.get(key)
}
```

Use this final version.

**Step 4: Run tests to verify they pass**

Run: `npm --workspace @pigeon/opencode-plugin run test -- token-tracker`
Expected: PASS (14 tests total)

**Step 5: Commit**

```bash
git add packages/opencode-plugin/src/token-tracker.ts packages/opencode-plugin/test/token-tracker.test.ts
git commit -m "Add ProviderCache for resolving model context limits"
```

---

### Task 4: TokenTracker.getFooter

**Files:**
- Modify: `packages/opencode-plugin/src/token-tracker.ts`
- Modify: `packages/opencode-plugin/test/token-tracker.test.ts`

**Step 1: Write failing tests**

Append to `packages/opencode-plugin/test/token-tracker.test.ts`:

```ts
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
})
```

**Step 2: Run tests to verify they fail**

Run: `npm --workspace @pigeon/opencode-plugin run test -- token-tracker`
Expected: FAIL — `t.getFooter is not a function`

**Step 3: Implement getFooter**

Add to the `TokenTracker` class in `packages/opencode-plugin/src/token-tracker.ts`:

```ts
async getFooter(sessionID: string, client: SdkLike, cache: ProviderCache): Promise<string> {
  const snap = this.snapshots.get(sessionID)
  if (!snap || snap.total <= 0) return ""

  const tokens = formatTokenCount(snap.total)
  const limit = await cache.getContextLimit(client, snap.providerID, snap.modelID)
  if (!limit || limit <= 0) {
    return `📊 ${tokens} tokens`
  }
  const percent = Math.round((snap.total / limit) * 100)
  return `📊 ${tokens} tokens · ${percent}%`
}
```

**Step 4: Run tests to verify they pass**

Run: `npm --workspace @pigeon/opencode-plugin run test -- token-tracker`
Expected: PASS (19 tests total)

**Step 5: Commit**

```bash
git add packages/opencode-plugin/src/token-tracker.ts packages/opencode-plugin/test/token-tracker.test.ts
git commit -m "Add TokenTracker.getFooter for formatted token summary"
```

---

### Task 5: Wire TokenTracker into the plugin

**Files:**
- Modify: `packages/opencode-plugin/src/index.ts`

**Step 1: Read the current plugin entry**

Read `packages/opencode-plugin/src/index.ts` to confirm:
- Where `MessageTail` is instantiated (top-level)
- Where `messageTail.onMessageUpdated` is called (in the `message.updated` handler around line 364–387)
- Both `notifyStop` call sites — one in the stop flow (~line 346), one in the question.asked flush (~line 496)
- Where `messageTail.clear` is called on session deletion (~line 405) and on session.error (~line 423–446)

**Step 2: Add tracker instances and wire events**

In `packages/opencode-plugin/src/index.ts`:

1. **Import** at the top (with other src/ imports):

```ts
import { TokenTracker, ProviderCache } from "./token-tracker"
```

2. **Instantiate** alongside the existing `MessageTail` instance (search for `new MessageTail`):

```ts
const tokenTracker = new TokenTracker()
const providerCache = new ProviderCache((msg) => log(msg))
```

(Use the same `log` reference the rest of the plugin uses. If `log` isn't in scope at module-top, instantiate inside the plugin factory where `messageTail` is created.)

3. **Capture tokens** in the `message.updated` handler. Find the block:

```ts
if (info?.id && info?.sessionID && info?.role) {
  lateDiscoverSession(info.sessionID)

  const role = info.role as string
  if (role === "user" || role === "assistant") {
    messageTail.onMessageUpdated({
      id: info.id,
      sessionID: info.sessionID,
      role,
    })
  }
```

Right after the `messageTail.onMessageUpdated(...)` call, add:

```ts
if (role === "assistant") {
  const assistantInfo = props?.info as {
    id: string
    sessionID: string
    role: string
    tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    providerID?: string
    modelID?: string
  }
  tokenTracker.onMessageUpdated(assistantInfo)
}
```

4. **Append footer in the main stop flow**. Find the block (near line 346):

```ts
const summary = messageTail.getSummary(sessionID) || "Task completed"
const files = messageTail.getFiles(sessionID)
log("sending notifyStop", { sessionID, summary: summary.slice(0, 100) })
notifyStop({
  sessionId: sessionID,
  message: summary,
  ...
```

Replace with:

```ts
const summary = messageTail.getSummary(sessionID) || "Task completed"
const files = messageTail.getFiles(sessionID)
const tokenFooter = await tokenTracker.getFooter(sessionID, ctx.client, providerCache)
const messageWithFooter = tokenFooter ? `${summary}\n\n${tokenFooter}` : summary
log("sending notifyStop", { sessionID, summary: summary.slice(0, 100), hasTokenFooter: !!tokenFooter })
notifyStop({
  sessionId: sessionID,
  message: messageWithFooter,
  ...
```

5. **Append footer in the question.asked stop flush**. Find the block (near line 496):

```ts
const currentMsgId = messageTail.getCurrentMessageId(sessionID)
if (sessionManager.shouldNotify(sessionID, currentMsgId)) {
  sessionManager.setNotified(sessionID, currentMsgId!)
  const summary = messageTail.getSummary(sessionID)
  if (summary) {
    const files = messageTail.getFiles(sessionID)
    notifyStop({
      sessionId: sessionID,
      message: summary,
      ...
```

Replace with:

```ts
const currentMsgId = messageTail.getCurrentMessageId(sessionID)
if (sessionManager.shouldNotify(sessionID, currentMsgId)) {
  sessionManager.setNotified(sessionID, currentMsgId!)
  const summary = messageTail.getSummary(sessionID)
  if (summary) {
    const files = messageTail.getFiles(sessionID)
    const tokenFooter = await tokenTracker.getFooter(sessionID, ctx.client, providerCache)
    const messageWithFooter = tokenFooter ? `${summary}\n\n${tokenFooter}` : summary
    notifyStop({
      sessionId: sessionID,
      message: messageWithFooter,
      ...
```

6. **Clear tracker on session lifecycle events**. Find each `messageTail.clear(sessionID)` call (session.deleted handler, session.error handler, twice in the latter) and add `tokenTracker.clear(sessionID)` immediately after each.

**Step 3: Run typecheck**

Run: `npm --workspace @pigeon/opencode-plugin run typecheck`
Expected: PASS — no type errors.

If `ctx.client` doesn't satisfy the `SdkLike` interface, widen the type in `token-tracker.ts` (e.g. `client: { config: { providers: (...args: any[]) => Promise<any> } }`) — do NOT add `as any` at call sites.

**Step 4: Run all plugin tests**

Run: `npm --workspace @pigeon/opencode-plugin run test`
Expected: PASS — all existing tests still green, no regressions.

**Step 5: Commit**

```bash
git add packages/opencode-plugin/src/index.ts packages/opencode-plugin/src/token-tracker.ts
git commit -m "Wire TokenTracker into stop notifications"
```

---

### Task 6: End-to-end verification

**Files:** none (verification only)

**Step 1: Run full repo checks**

Run in parallel:
- `npm run test`
- `npm run typecheck`

Expected: Both pass cleanly.

**Step 2: Manual verification (devbox)**

If devbox is available:
1. Build & deploy plugin per @.opencode/skills/opencode-plugin-deployment/SKILL.md
2. Send a real prompt to a Telegram-attached opencode session
3. Confirm the stop notification body now ends with a line like:
   ```
   📊 12.3K tokens · 7%
   ```
4. Cross-check against the TUI sidebar context numbers — they should match within rounding.

**Step 3: Document the change**

Update `AGENTS.md` "Notifications" section to mention the token footer:

In the existing "**Durable notification delivery**" paragraph or as a new bullet directly under it, add:

```markdown
**Token usage footer:** Stop notifications include a compact `📊 12.3K tokens · 7%` footer showing total tokens used by the latest assistant message and the percentage of the model's context window. Sourced from `message.updated` events; matches what the OpenCode TUI sidebar displays.
```

**Step 4: Commit docs**

```bash
git add AGENTS.md
git commit -m "Document token usage footer in stop notifications"
```

**Step 5: Final commit + push**

Run: `git status` to confirm clean tree, then push to remote per usual deploy flow.

---

## Definition of Done

- [ ] All new tests pass (`npm --workspace @pigeon/opencode-plugin run test`)
- [ ] All existing tests pass (`npm run test`)
- [ ] Typecheck passes (`npm run typecheck`)
- [ ] Plugin emits `📊 N tokens · P%` footer in stop notifications when tokens > 0
- [ ] Footer omitted entirely when no assistant message has been seen
- [ ] Percent omitted when model context limit cannot be resolved
- [ ] No daemon code changes
- [ ] AGENTS.md updated
