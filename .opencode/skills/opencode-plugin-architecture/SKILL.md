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
5. `question.asked` events enqueue question in in-memory retry queue (bypasses circuit breaker) → `sendQuestionAsked` with 3s timeout → daemon `/question-asked`.
6. `question.replied` / `question.rejected` events notify daemon the question is resolved (`/question-answered`).

## Important Behavior

- head-first message capture for summary fidelity
- dedup to avoid repeated notifications
- environment detection for local transport metadata (tty)
- circuit-breaker around daemon HTTP calls (does NOT apply to question delivery)

## Question Delivery (Reliability Design)

Question notifications use a dedicated path that bypasses the circuit breaker to avoid question delivery being blocked by unrelated daemon HTTP failures:

- **QuestionDeliveryQueue**: in-memory retry queue initialized at plugin startup. When `question.asked` fires, the question is enqueued immediately (synchronous) and delivered asynchronously with retries.
- **`sendQuestionAsked`**: calls daemon `/question-asked` with a 3s timeout. Does not affect circuit breaker state -- success or failure is recorded only in the retry queue.
- **Decoupled stop flush**: before enqueuing the question, any pending stop notification is fire-and-forgot (not awaited). This prevents a slow stop flush from delaying question delivery.
- **Backward-compatible response**: the daemon returns `{ok: true, deliveryState: "accepted", notificationId}` (HTTP 202). The plugin handles both this format and the legacy `{notified: true}` (HTTP 200) shape.
- **`notifyQuestionAsked` from daemon-client is no longer used for question events.** It remains available but the plugin routes question delivery through `sendQuestionAsked` instead.

## Question Reply (Direct Channel)

The plugin's direct channel server (`direct-channel.ts`) exposes `/pigeon/direct/question-reply` for the daemon to deliver answers back from Telegram. The handler calls OpenCode's `/question/{requestId}/reply` API to unblock the question tool.

**Critical: in-process fetch.** In TUI mode, OpenCode does NOT run an HTTP server. The SDK client injected into plugins uses a custom `fetch` that calls `Server.App().fetch()` in-process (bypassing the network). `ctx.serverUrl` resolves to `http://localhost:4096` but nothing listens there.

The plugin extracts the SDK client's internal fetch at init time:

```typescript
const sdkClientConfig = (ctx.client as any)._client?.getConfig?.()
const internalFetch: typeof fetch = sdkClientConfig?.fetch ?? globalThis.fetch
```

The `onQuestionReply` handler uses `internalFetch` (with a `new Request(...)`) to call the OpenCode API. Using raw `globalThis.fetch` would fail with "Unable to connect" because no HTTP server is running.

## Swarm IPC Tool (`swarm.read`)

The plugin registers `swarm.read` as an opencode tool the LLM can call to fetch its swarm inbox from the local pigeon daemon. This is the receiver side of the swarm IPC subsystem (sender side is `pigeon-send`; full subsystem in `swarm-architecture`).

- `packages/opencode-plugin/src/swarm-tool.ts`:
  - `swarmRead({daemonBaseUrl, sessionId, fetchFn?}, since?)` -- pure helper. `GET /swarm/inbox?session=<id>[&since=<msg_id>]`. Returns the parsed messages array.
  - `formatInbox(messages)` -- renders the messages as compact text blocks for the LLM.
  - `createSwarmReadTool(daemonBaseUrl)` -- returns a `ToolDefinition` that captures `daemonBaseUrl` from closure and reads `sessionID` from `ToolContext` at execute-time.

Registered in `index.ts` via the `Hooks.tool` map:

```ts
return {
  tool: {
    "swarm.read": createSwarmReadTool(daemonUrl),
  },
  event: async (input) => { ... },
}
```

`Hooks.tool` is `{ [key: string]: ToolDefinition }` from `@opencode-ai/plugin/tool`. The `tool({description, args, execute})` factory accepts zod-described args via `tool.schema.string().optional()`. The execute callback receives `(args, ToolContext)` where `ToolContext.sessionID` is the calling session — so the tool always reads its OWN inbox, no spoofing.

**Critical: import from `@opencode-ai/plugin/tool` (subpath), NOT `@opencode-ai/plugin`.** The upstream package's compiled JS uses extensionless ESM imports (`import "./tool"`) which Node ESM rejects, but the explicit `./tool` subpath export resolves correctly. See `opencode-plugin-development` for the gotcha details.

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
- `/question-asked` payload includes `session_id`, `request_id`, `questions[]` (with `question`, `header`, `options[]`, `custom?`, `multiple?`), and `label`. Response: HTTP 202 `{ok: true, deliveryState: "accepted", notificationId}`. Daemon stores durably in SQLite outbox and returns immediately; background OutboxSender delivers to Telegram.
- `/question-answered` payload includes `session_id`.

## Verify

```bash
npm run --workspace @pigeon/opencode-plugin test
npm run --workspace @pigeon/opencode-plugin typecheck
```
