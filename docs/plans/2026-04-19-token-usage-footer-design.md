# Token Usage Footer in Telegram Notifications

**Date:** 2026-04-19
**Status:** Design approved

## Goal

Add a compact token-usage footer to Telegram stop notifications that mirrors
what the OpenCode TUI displays in its sidebar context panel. Users get at-a-
glance visibility into context consumption for each completed turn without
switching to the terminal.

## Scope

**In scope:**
- Token count + percentage of context window, appended to stop notifications
- Plugin-side tracking via `message.updated` events
- Lazy fetch of provider/model context limits from the OpenCode server

**Out of scope (YAGNI):**
- Cumulative session cost ($ spent) — TUI shows this, but we skip to avoid
  cross-message state. The `stats` CLI already covers session-end review.
- Adding token info to question, retry, or error notifications
- Per-message deltas (tokens used since the last notification)
- Warning thresholds / visual indicators at high context usage

## Format

Appended as a single line to the existing stop notification body:

```
<original summary text>

📊 12.3K tokens · 7%
```

Rules:
- Numbers: `999`, `1.5K`, `12.3K`, `1.5M` (human-friendly, k/M suffix)
- Percent: omitted if model context limit cannot be resolved
- Footer omitted entirely when total tokens = 0 (e.g. error-only turns,
  sessions with no assistant message yet)

## Data source (matching TUI)

The TUI's `sidebar-context.tsx` reads from the last assistant message in the
session with `tokens.output > 0`:

```ts
total = input + output + reasoning + cache.read + cache.write
percent = round(total / model.limit.context * 100)
```

The plugin listens to `message.updated` events (already does, for the text
tail) and captures `info.tokens`, `info.providerID`, `info.modelID` for
assistant messages.

## Architecture

### Plugin side (`packages/opencode-plugin`)

**New module: `token-tracker.ts`**

Per-session state:
```ts
type SessionTokens = {
  messageId: string
  tokens: { input; output; reasoning; cache: { read; write } }
  providerID: string
  modelID: string
}
```

API:
- `onMessageUpdated(info)` — capture tokens when assistant message with
  output>0 arrives; replaces tracker entry (matches TUI's "findLast" semantics)
- `getFooter(sessionID): string` — returns formatted footer line, or `""`
  when no tokens or session unknown
- `clear(sessionID)` — called on session deletion
- Eviction: piggyback on `MessageTail`'s pattern (periodic sweep of stale
  sessions) — since token state is tiny, can use same interval

**Provider/model cache**

One lazy HTTP call per plugin process: `ctx.client.config.providers()`.
Result keyed by `${providerID}/${modelID}` → `limit.context`. Cache miss on
unknown model triggers one refetch attempt; repeated misses fall back to
tokens-only output.

**Integration point: `index.ts`**

Two call sites in the plugin emit `notifyStop`:
1. `session.idle` handler (main stop flow)
2. `question.asked` handler (flush assistant text before question)

Both pass `message` to `notifyStop`. Append the token footer right before
calling `notifyStop`:

```ts
const summary = messageTail.getSummary(sessionID) || "Task completed"
const tokenFooter = await tokenTracker.getFooter(sessionID, ctx.client)
const message = tokenFooter ? `${summary}\n\n${tokenFooter}` : summary
notifyStop({ ..., message, ... })
```

### Daemon side

**No changes.** The daemon's `/stop` route already passes `body.message`
straight into `formatTelegramNotification` as the `summary`. Pre-formatting
in the plugin keeps this a dumb relay and avoids a coordinated deploy.

## Edge cases

| Case | Behavior |
|------|----------|
| Zero tokens (error-only turn, no assistant reply) | No footer appended |
| Unknown provider/model | Show tokens, omit `%` |
| `config.providers()` call fails | Show tokens, omit `%`, log once |
| Session reset / new assistant message | Tracker replaces prior entry (latest wins, matches TUI) |
| Subagent messages | Only main-session stop notifications go out; tracker only captures messages for sessions we notify about, but tracking is per-sessionID so it is naturally scoped |
| Retry / error notifications | Not modified (footer only applies to the two `notifyStop` call sites in the stop flow) |

## Testing

Unit tests (`packages/opencode-plugin/test`):
- `formatTokenCount`: 0, 999, 1_000, 1_500, 12_345, 1_500_000 → "0", "999",
  "1.0K", "1.5K", "12.3K", "1.5M"
- `TokenTracker.getFooter`:
  - no data → `""`
  - zero tokens → `""`
  - tokens + known model → `"📊 12.3K tokens · 7%"`
  - tokens + unknown model (cache miss) → `"📊 12.3K tokens"`
  - model cache throws → `"📊 12.3K tokens"`, logs once
- `TokenTracker.onMessageUpdated`: new message replaces prior entry; user
  messages ignored

Integration (manual or in daemon burn-in):
- Send a real prompt through Telegram, verify stop notification includes the
  footer and numbers roughly match the TUI display.

## Rollout

- Plugin-only change. Ship via existing plugin deploy flow
  ([opencode-plugin-deployment](../../.opencode/skills/opencode-plugin-deployment/SKILL.md)).
- No daemon restart required.
- Backward compatible: daemon ignores any extra whitespace/lines in the
  summary.
