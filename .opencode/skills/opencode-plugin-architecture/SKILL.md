---
name: opencode-plugin-architecture
description: Use when you need to understand the OpenCode plugin event lifecycle, session state transitions, and daemon API contracts
---

# OpenCode Plugin Architecture

## When To Use

Use this before changing plugin event handling or daemon payload contracts.

## Package

- `@pigeon/opencode-plugin`
- source and tests live in `packages/opencode-plugin`

## Core Lifecycle

1. Session created event initializes state.
2. Plugin registers main sessions with daemon (`/session-start`).
3. Message updates feed summary extraction.
4. Idle/stop events send final notification payload to daemon (`/stop`).
5. `question.asked` events send question details to daemon (`/question-asked`).
6. `question.replied` / `question.rejected` events notify daemon the question is resolved (`/question-answered`).

## Important Behavior

- head-first message capture for summary fidelity
- dedup to avoid repeated notifications
- environment detection for local transport metadata (tty)
- circuit-breaker around daemon HTTP calls

## Question Reply (Direct Channel)

The plugin's direct channel server (`direct-channel.ts`) exposes `/pigeon/direct/question-reply` for the daemon to deliver answers back from Telegram. The handler calls OpenCode's `/question/{requestId}/reply` API to unblock the question tool.

**Critical: in-process fetch.** In TUI mode, OpenCode does NOT run an HTTP server. The SDK client injected into plugins uses a custom `fetch` that calls `Server.App().fetch()` in-process (bypassing the network). `ctx.serverUrl` resolves to `http://localhost:4096` but nothing listens there.

The plugin extracts the SDK client's internal fetch at init time:

```typescript
const sdkClientConfig = (ctx.client as any)._client?.getConfig?.()
const internalFetch: typeof fetch = sdkClientConfig?.fetch ?? globalThis.fetch
```

The `onQuestionReply` handler uses `internalFetch` (with a `new Request(...)`) to call the OpenCode API. Using raw `globalThis.fetch` would fail with "Unable to connect" because no HTTP server is running.

## Daemon Contracts

- `/session-start` payload includes session/process/transport context.
- `/stop` payload includes event + summary/message and label context.
- `/question-asked` payload includes `session_id`, `request_id`, `questions[]` (with `question`, `header`, `options[]`, `custom?`, `multiple?`), and `label`.
- `/question-answered` payload includes `session_id`.

## Verify

```bash
bun run --filter '@pigeon/opencode-plugin' test
bun run --filter '@pigeon/opencode-plugin' typecheck
```
