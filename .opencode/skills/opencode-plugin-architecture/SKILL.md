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
4. Idle/stop events enqueue the final notification payload in the stop retry queue (bypasses the circuit breaker) → `sendStop` → daemon `/stop`.
5. `question.asked` events enqueue question in in-memory retry queue (bypasses circuit breaker) → `sendQuestionAsked` with 3s timeout → daemon `/question-asked`.
6. `question.replied` / `question.rejected` events notify daemon the question is resolved (`/question-answered`).

## Important Behavior

- head-first message capture for summary fidelity
- dedup to avoid repeated notifications
- environment detection for local transport metadata (tty)
- circuit-breaker around daemon HTTP calls (does NOT apply to question OR stop delivery)

## Stop Delivery (Reliability Design)

`pigeon-mavq`: a stop was a single fire-and-forget POST gated by the circuit breaker, so a
stop that fired while the breaker was open was dropped with no retry and no outbox row. The
breaker had been opened by an unrelated session's `/session-start`; two sessions lost their
answers. The daemon's outbox is durable, but only from its front door inward -- this hop was
the gap.

- **StopDeliveryQueue** (`stop-queue.ts`, cap 32, 10-min TTL) on the shared `DeliveryQueue`.
  Enqueue is synchronous, delivery asynchronous with jittered backoff, no breaker.
- **Client idempotency key**, `s:<sessionId>:<dedupToken>.<seq>`, minted by `StopKeyMinter` and
  sent as `notification_id`. The daemon uses it as the outbox key, which is what makes a retry
  a no-op rather than a second Telegram message. The `seq` is required: a late `message.updated`
  clears the dedup guard and the next idle legitimately re-notifies the SAME message with newly
  accumulated text, which a message-id-only key would swallow.
- **`sendStop` classifies outcomes**: any 2xx is success (including `{ok:true, notified:false}`
  for a quiet session -- retrying a *decision* would burn the TTL then raise a false alarm);
  5xx/transport retry; **404 returns `unregistered`**, which the caller repairs by
  re-registering and retrying once (the daemon's reaper drops a row after 7d idle while the
  plugin still thinks it is registered); other 4xx is terminal.
- **Deploy skew guard**: against a daemon that ignores the key, a *timeout* is ambiguous
  (it may mean processed), so it stays terminal until a response has echoed our key back.
  The skew window degrades to today's behaviour, never to duplicates.
- **Retry (rate-limit) notifications are not queued** -- single attempt. A storm emits one per
  session every 30-60s and they are stale immediately; queueing them would evict real answers.
- **Not gated on `isRegistered`** -- for stops and errors only. `question.asked` and
  `session.status` still are, so `ensureRegistered`'s retry still matters. A failed registration
  used to suppress every later notification for the session (`shouldNotify` checked it too).
  Enqueue and repair daemon-side instead; note the repair itself goes through the breaker-gated
  `registerSession`, so a failed re-registration retries rather than dropping.

## Circuit Breaker (what it may conclude)

It answers exactly one question -- *is the daemon reachable?* -- and is kept only because
`ensureRegistered` is awaited inside the event handlers. It trips on transport failure alone:
never on an HTTP status (a 404 for one reaped session used to silence every session on the
serve for 30s) and never on a `SyntaxError` from a truncated body (headers arrived; that is
what opened it in the incident). Trips log `breaker opened {route, reason, openUntil}`.

## Question Delivery (Reliability Design)

Question notifications use a dedicated path that bypasses the circuit breaker to avoid question delivery being blocked by unrelated daemon HTTP failures:

- **QuestionDeliveryQueue**: a `DeliveryQueue` instance initialized at plugin startup. Identity
  and success-classification are injected per instance, not shared: the question classifier
  treats a response with no `deliveryState` and no `notified` as a failure, which is exactly
  what `/stop` returns for a quiet session. When `question.asked` fires, the question is enqueued immediately (synchronous) and delivered asynchronously with retries.
- **`sendQuestionAsked`**: calls daemon `/question-asked` with a 3s timeout. Does not affect circuit breaker state -- success or failure is recorded only in the retry queue.
- **Decoupled stop flush**: the question is enqueued FIRST, then any pending stop text is
  enqueued from a detached closure that nothing awaits, so a slow footer cannot delay the
  question. The footer fetch itself is bounded by `footerFor` (2s race, never throws) because it
  sits between `consume()` -- which clears the text -- and the enqueue, so a hang there would
  lose the whole notification rather than just its footer.
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
