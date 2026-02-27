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

- **Stop notifications**: plain text, no inline buttons (old Continue/Yes/No/Exit buttons were removed).
- **Question notifications**: formatted with the question text + inline keyboard buttons. Each option becomes a button with `callback_data: "cmd:TOKEN:q0"`, `cmd:TOKEN:q1"`, etc. Only the first question's options get buttons; remaining questions are shown as text and must be answered in the TUI.

The notifier tries the worker path first (`WorkerNotificationService`), falling back to direct Telegram API (`TelegramNotificationService`).

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
