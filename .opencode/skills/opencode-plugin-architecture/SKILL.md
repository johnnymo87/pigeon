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

## Media Handling

### Outbound (OpenCode → Telegram)

`MessageTail` in `message-tail.ts` captures files from AI responses:

- **FileParts**: when a message part has `type: "file"` with `mime` and `url`, pushed to `tail.files`.
- **Tool attachments**: when a tool result has `status: "completed"` and `attachments[]`, each attachment's `{ mime, filename, url }` is captured.

On `session.idle`, the plugin includes `media: FileInfo[]` (data URIs) in the `/stop` payload. The daemon uploads these to R2 and the worker sends them to Telegram as photo/document replies.

### Inbound (Telegram → OpenCode)

When the daemon delivers an execute command with a `media` field (from a Telegram photo/document relayed through R2):

1. The direct channel server receives the `ExecuteCommandEnvelope` at `/pigeon/direct/execute`.
2. The `onExecute` handler builds a `parts` array for OpenCode's `prompt_async` endpoint:
   - `{ type: "text", text: command }` if text is present
   - `{ type: "file", mime, filename, url }` if media is present (data URI from daemon's R2 fetch)
3. POSTs `{ parts, noReply: false }` to `/session/<id>/prompt_async`.

## Daemon Contracts

- `/session-start` payload includes session/process/transport context.
- `/stop` payload includes event + summary/message, label context, and optional `media: Array<{ mime, filename, url }>` (data URIs from captured files).
- `/question-asked` payload includes `session_id`, `request_id`, `questions[]` (with `question`, `header`, `options[]`, `custom?`, `multiple?`), and `label`.
- `/question-answered` payload includes `session_id`.

## Verify

```bash
npm run --workspace @pigeon/opencode-plugin test
npm run --workspace @pigeon/opencode-plugin typecheck
```
