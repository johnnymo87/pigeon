---
name: daemon-architecture
description: Use when you need to understand daemon route flow, storage model, worker connectivity, and command injection architecture before making changes
---

# Pigeon Daemon Architecture

## When To Use

Use this skill before changing daemon routes, storage schema, worker integration, or injection behavior.

## Overview

`@pigeon/daemon` is the local control plane.

- API routes live in `packages/daemon/src/app.ts`
- Storage is SQLite-first in `packages/daemon/src/storage/*`
- Worker integration is in `packages/daemon/src/worker/*`

## Route Surface

- `GET /health`
- `POST /session-start`
- `POST /sessions/enable-notify`
- `GET /sessions`, `GET /sessions/:id`, `DELETE /sessions/:id`
- `POST /stop`
- `POST /question-asked` -- plugin reports AI asked a question; daemon stores pending question in outbox, returns 202 immediately; background OutboxSender delivers Telegram notification with inline option buttons
- `POST /question-answered` -- plugin reports question was answered locally; daemon clears the pending question
- `POST /cleanup`

## Storage Domains

- `sessions`: active session registry + transport metadata
- `session_tokens`: reply/command token validation state
- `reply_tokens`: message reply-key to token mapping
- `inbox`: durable local command ingest queue
- `pending_questions`: one pending question per session (PRIMARY KEY on `session_id`, 4h TTL). Stores the question's `request_id`, `options[]`, and `token` so the daemon can translate button presses (e.g. `q0`) back to option labels and route the answer to the correct plugin endpoint. Wizard columns: `current_step`, `answers_json_v2`, `version` for multi-question flows.
- `outbox`: durable notification delivery queue for both question and stop notifications. Keyed by `notification_id`, `kind` field (`"question"` or `"stop"`), state machine: queued → sending → sent (or failed). Background sender processes every 5s. Terminal entries cleaned after 1 hour.
- `model_override`: nullable TEXT column on `sessions` table. Stores `provider/model` string (e.g. `anthropic/claude-sonnet-4-20250514`). Read by `command-ingest.ts` and passed through the adapter to the plugin.

## Worker Integration: HTTP Polling

The daemon connects to the worker via HTTP short polling (no WebSocket, no long-lived connections).

- `Poller` class in `packages/daemon/src/worker/poller.ts`
- Polls `GET /machines/:machineId/next` every 5 seconds with Bearer auth
- On command received: dispatches to the appropriate callback, then acks via `POST /commands/:commandId/ack`
- On dispatch failure: does not ack -- the lease expires (60s) and the command becomes available again
- Also handles outbound HTTP: `registerSession`, `unregisterSession`, `sendNotification`, `editNotification`, `uploadMedia`

## Command Delivery Adapters

Command injection is routed through `packages/daemon/src/adapters/`:

- `CommandDeliveryAdapter` -- interface: `deliver(session, command) => Promise<Result>`
- `DirectChannelAdapter` -- HTTP POST to OpenCode plugin backend endpoint (uses `backend_endpoint` + `backend_auth_token` from session)
- `NvimRpcAdapter` -- shells out to `nvim --server <socket> --remote-expr` to call `pigeon.dispatch()` via RPC (uses `nvim_socket` + `pty_path` from session; payload/response are base64-encoded JSON)

**Routing priority:** direct-channel (if `backend_endpoint` set) > nvim (if `nvim_socket` set) > error.

Adapters also support `deliverQuestionReply(session, input)` for routing question answers back to the plugin. Only `DirectChannelAdapter` implements this (POSTs to `/pigeon/direct/question-reply`).

## Notification Service

`FallbackNotifier` (in `notification-service.ts`) implements both `StopNotifier` and `QuestionNotifier`:

- **Stop notifications**: plain text with inline "reply" button. May include outbound media (see Media Relay below). Routed through the durable outbox (same as questions).
- **Question notifications (single)**: formatted with the question text + inline keyboard buttons. Each option becomes a button with `callback_data: "cmd:TOKEN:q0"`, `"cmd:TOKEN:q1"`, etc.
- **Question notifications (multi/wizard)**: when multiple questions exist, rendered one at a time in a single Telegram message. Buttons use versioned callback data (`cmd:TOKEN:v{version}:q{index}`). As the user answers each step, the message is edited in-place via `POST /notifications/edit` to show the next question. On completion, the message is edited to "All answers submitted".
- **Message splitting**: when a notification body exceeds Telegram's 4096-character limit, `splitTelegramMessage()` splits it into multiple messages at natural boundaries (paragraph, line, sentence). Reply markup is attached only to the last chunk.

Both notification types display a session ID on its own line for easy copy-paste in Telegram.

The notifier tries the worker path first (`WorkerNotificationService`), falling back to direct Telegram API (`TelegramNotificationService`).

## Media Relay

The daemon mediates bidirectional media relay between the worker's R2 bucket and OpenCode sessions.

### Inbound (Telegram -> OpenCode)

When a worker command includes a `media: { key, mime, filename, size }` field:

1. `ingestWorkerCommand` in `command-ingest.ts` fetches the binary via `GET <workerUrl>/media/<key>` (Bearer auth).
2. Converts to a base64 data URI (`data:<mime>;base64,...`).
3. Passes `{ mime, filename, url }` through the adapter chain to the plugin's `/pigeon/direct/execute` endpoint.
4. On fetch failure, throws to skip ack -- the command lease expires and retries.

### Outbound (OpenCode -> Telegram)

When a stop notification includes media (files captured by the plugin):

1. `WorkerNotificationService.sendStopNotification` receives `media: Array<{ mime, filename, url }>` where `url` is a data URI.
2. For each file: base64-decodes, uploads to R2 via `POST <workerUrl>/media/upload` (multipart form) with key `outbound/<ts>-<uuid>/<filename>`.
3. Passes `mediaKeys: Array<{ key, mime, filename }>` to `sendNotification` which includes them in the worker's `/notifications/send` body.
4. Failed uploads are silently skipped -- text notification still goes through.

## OpenCode Serve Integration

The daemon communicates with a local `opencode serve` instance for headless session management. Configuration:

- `OPENCODE_URL` env var (e.g. `http://127.0.0.1:4096`) -- no authentication (localhost-only, single-user)
- `OpencodeClient` class in `packages/daemon/src/opencode-client.ts`
- Methods: `healthCheck()`, `createSession(directory)`, `sendPrompt(sessionId, directory, prompt)`, `deleteSession(sessionId)`, `getSessionMessages(sessionId)`, `summarize(sessionId, providerID, modelID)`, `mcpStatus()`, `mcpConnect(name)`, `mcpDisconnect(name)`, `listProviders()`

### Launch / Kill Ingest

Worker commands of type `"launch"` and `"kill"` are handled by dedicated ingest modules in `packages/daemon/src/worker/`:

- `launch-ingest.ts`: checks opencode health, creates session, sends prompt, replies to Telegram with session ID. Supports bare project name expansion (e.g. `pigeon` → `~/projects/pigeon`).
- `kill-ingest.ts`: calls `DELETE /session/<id>`, replies to Telegram with result
- `compact-ingest.ts`: fetches session messages, extracts the model from the last user message, calls `summarize()`
- `mcp-ingest.ts`: handles `mcp_list` (calls `mcpStatus()`), `mcp_enable` (calls `mcpConnect()`), `mcp_disable` (calls `mcpDisconnect()`)
- `model-ingest.ts`: handles `model_list` (calls `listProviders()`, filters to allowed providers) and `model_set` (validates model, stores as `model_override` on session)

All are dispatched by the Poller's command-type callbacks. Acking is handled by the Poller after successful dispatch.

## Integration Flow

### Stop Flow

1. Session start hits daemon route and writes session row.
2. Daemon registers session with worker (via Poller's `registerSession`).
3. Plugin POSTs to daemon `/stop` with `session_id`, `event`, `message`, `summary`.
4. Daemon generates stable `notification_id = s:{sessionId}:{now}`.
5. Daemon mints token, formats notification, stores in outbox with `kind: "stop"`. Returns HTTP 202.
6. Background OutboxSender delivers to Telegram with retry (same as question flow).
7. Worker delivers reply/callback as a command queued in D1.
8. Daemon polls, receives command, routes through adapter.

### Question Flow

1. AI calls the `question` tool in OpenCode.
2. Plugin receives `question.asked` event, enqueues in-memory retry queue (bypasses circuit breaker), calls `sendQuestionAsked` with 3s timeout.
3. Plugin POSTs to daemon `/question-asked` with `session_id`, `request_id`, `questions`.
4. Daemon generates stable `notification_id = q:{sessionId}:{requestId}`.
5. Daemon stores pending question, mints session token, creates outbox row (all in one SQLite operation).
6. Daemon returns 202 `{ok: true, deliveryState: "accepted", notificationId}` immediately.
7. Background OutboxSender (5s interval) reads queued entries, sends via worker's `/notifications/send` with `notificationId` for idempotency.
8. On success: marks `sent`. On failure: retries with backoff (5s, 10s, 30s, 60s, 120s). Terminal failure after 10 attempts or 15 minutes.
9. Worker deduplicates by `notificationId` -- if already delivered, returns `{ok: true, deduplicated: true}` without calling Telegram again.
10. User taps a button (`cmd:TOKEN:q0`) or swipe-replies with custom text.
11. Telegram webhook hits worker, which resolves session and queues command in D1.
12. Daemon polls, receives command. Command-ingest detects a pending question for the session:
    - Button press (`q0`, `q1`, ...): translates index to the original option label.
    - Custom text: uses the raw text as the answer.
13. **Single-question path**: daemon delivers the answer to the plugin via `DirectChannelAdapter.deliverQuestionReply()`.
14. **Multi-question wizard path**: daemon advances the wizard step, edits the Telegram message in-place to show the next question (via `POST /notifications/edit`). On the final step, all accumulated answers are delivered as a single `deliverQuestionReply` call with `answers: string[][]`.
15. Plugin calls OpenCode's `/question/{requestId}/reply` API to unblock the question tool.
16. If the user already answered locally, stale button presses return "This question has already been answered." Stale wizard versions (button from a previous step) are silently dropped.

### Session Reaper

A background hourly timer (`session-reaper.ts`, started in `index.ts`) cleans up stale sessions:

1. Lists sessions whose `last_seen` is older than `SESSION_TTL_MS` (1 week).
2. For each: deletes from opencode serve (`deleteSession`), removes from local storage, unregisters from worker.
3. Runs `cleanupExpired` for fully expired session records.

### Dead Session Cleanup

When `command-ingest.ts` detects a connection error (ECONNREFUSED, timeout, fetch failed, etc.) during command delivery, it removes the session from local storage. This prevents repeated delivery attempts to a dead plugin process -- subsequent commands get a clear "Session not found" instead.

## Future Improvement: Long Polling

Long polling at the Worker level would reduce daemon HTTP traffic. Not needed at current scale. See [design doc](docs/plans/2026-03-14-d1-polling-architecture-design.md).

## Verify

```bash
npm run --workspace @pigeon/daemon typecheck
npm run --workspace @pigeon/daemon test
```

Expected:

- typecheck passes
- tests pass
