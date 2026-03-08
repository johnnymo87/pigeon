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
- `POST /question-asked` -- plugin reports AI asked a question; daemon stores pending question + sends Telegram notification with inline option buttons
- `POST /question-answered` -- plugin reports question was answered locally; daemon clears the pending question
- `POST /cleanup`

## Storage Domains

- `sessions`: active session registry + transport metadata
- `session_tokens`: reply/command token validation state
- `reply_tokens`: message reply-key to token mapping
- `inbox`: durable local command ingest queue
- `pending_questions`: one pending question per session (PRIMARY KEY on `session_id`, 4h TTL). Stores the question's `request_id`, `options[]`, and `token` so the daemon can translate button presses (e.g. `q0`) back to option labels and route the answer to the correct plugin endpoint.

## Command Delivery Adapters

Command injection is routed through `packages/daemon/src/adapters/`:

- `CommandDeliveryAdapter` — interface: `deliver(session, command) => Promise<Result>`
- `DirectChannelAdapter` — HTTP POST to OpenCode plugin backend endpoint (uses `backend_endpoint` + `backend_auth_token` from session)
- `NvimRpcAdapter` — shells out to `nvim --server <socket> --remote-expr` to call `pigeon.dispatch()` via RPC (uses `nvim_socket` + `pty_path` from session; payload/response are base64-encoded JSON)

**Routing priority:** direct-channel (if `backend_endpoint` set) > nvim (if `nvim_socket` set) > error.

Adapters also support `deliverQuestionReply(session, input)` for routing question answers back to the plugin. Only `DirectChannelAdapter` implements this (POSTs to `/pigeon/direct/question-reply`).

## Notification Service

`FallbackNotifier` (in `notification-service.ts`) implements both `StopNotifier` and `QuestionNotifier`:

- **Stop notifications**: plain text, no inline buttons (old Continue/Yes/No/Exit buttons were removed). May include outbound media (see Media Relay below).
- **Question notifications**: formatted with the question text + inline keyboard buttons. Each option becomes a button with `callback_data: "cmd:TOKEN:q0"`, `cmd:TOKEN:q1"`, etc. Only the first question's options get buttons; remaining questions are shown as text and must be answered in the TUI.

Both notification types display a session ID on its own line (`🆔 \`sess-abc\``) for easy copy-paste in Telegram.

The notifier tries the worker path first (`WorkerNotificationService`), falling back to direct Telegram API (`TelegramNotificationService`).

## Media Relay

The daemon mediates bidirectional media relay between the worker's R2 bucket and OpenCode sessions.

### Inbound (Telegram → OpenCode)

When a worker command includes a `media: { key, mime, filename, size }` field:

1. `ingestWorkerCommand` in `command-ingest.ts` fetches the binary via `GET <workerUrl>/media/<key>` (Bearer auth).
2. Converts to a base64 data URI (`data:<mime>;base64,...`).
3. Passes `{ mime, filename, url }` through the adapter chain to the plugin's `/pigeon/direct/execute` endpoint.
4. On fetch failure, sends `commandResult` with `success: false` — the command is not retried.

### Outbound (OpenCode → Telegram)

When a stop notification includes media (files captured by the plugin):

1. `WorkerNotificationService.sendStopNotification` receives `media: Array<{ mime, filename, url }>` where `url` is a data URI.
2. For each file: base64-decodes, uploads to R2 via `POST <workerUrl>/media/upload` (multipart form) with key `outbound/<ts>-<uuid>/<filename>`.
3. Passes `mediaKeys: Array<{ key, mime, filename }>` to `sendNotification` which includes them in the worker's `/notifications/send` body.
4. Failed uploads are silently skipped — text notification still goes through.

## OpenCode Serve Integration

The daemon communicates with a local `opencode serve` instance for headless session management. Configuration:

- `OPENCODE_URL` env var (e.g. `http://127.0.0.1:4096`) -- no authentication (localhost-only, single-user)
- `OpencodeClient` class in `packages/daemon/src/opencode-client.ts`
- Methods: `healthCheck()`, `createSession(directory)`, `sendPrompt(sessionId, directory, prompt)`, `deleteSession(sessionId)`

### Launch / Kill Ingest

Worker commands of type `"launch"` and `"kill"` are handled by dedicated ingest modules in `packages/daemon/src/worker/`:

- `launch-ingest.ts`: acks immediately, checks opencode health, creates session, sends prompt, replies to Telegram with session ID
- `kill-ingest.ts`: acks immediately, calls `DELETE /session/<id>`, replies to Telegram with result

Both are wired through `machine-agent.ts` message handlers (alongside the existing `"command"` type for regular command injection).

## Integration Flow

### Stop Flow

1. Session start hits daemon route and writes session row.
2. Daemon registers session with worker (if configured).
3. Stop event sends notification and mints token.
4. Worker delivers reply/callback as `command` message over WS.
5. Daemon acks, routes command through adapter, sends `commandResult`.

### Question Flow

1. AI calls the `question` tool in OpenCode.
2. Plugin receives `question.asked` event, POSTs to daemon `/question-asked`.
3. Daemon stores pending question in `pending_questions` table and sends Telegram notification with inline option buttons.
4. User taps a button (`cmd:TOKEN:q0`) or swipe-replies with custom text.
5. Telegram webhook hits worker, which resolves session and sends command to daemon via WS.
6. Daemon's command-ingest detects a pending question for the session:
   - Button press (`q0`, `q1`, ...): translates index to the original option label.
   - Custom text: uses the raw text as the answer.
7. Daemon delivers the answer to the plugin via `DirectChannelAdapter.deliverQuestionReply()`.
8. Plugin calls OpenCode's `/question/{requestId}/reply` API to unblock the question tool.
9. If the user already answered locally, stale button presses return "This question has already been answered."

## Verify

```bash
bun run --filter '@pigeon/daemon' typecheck
bun run --filter '@pigeon/daemon' test
```

Expected:

- typecheck passes
- tests pass
