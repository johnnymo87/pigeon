---
name: worker-architecture
description: Use when you need to understand worker architecture, endpoint flow, and command routing behavior before making changes
---

# Pigeon Worker Architecture

## When To Use

Use this skill when you need system-level understanding before debugging, deployment, or parity checks.

## Overview

`@pigeon/worker` is a Cloudflare Worker + Durable Object router.

- Worker script: `packages/worker/src/index.ts`
- Durable Object: `packages/worker/src/router-do.ts` (`RouterDO` export)
- Runtime state: SQLite tables inside the DO

## Core Flow

1. Session registers (`/sessions/register`) with `sessionId -> machineId`
2. Notification sent (`/notifications/send`) to Telegram and mapped as `chat_id + message_id -> sessionId + token`
3. User replies in Telegram webhook (`/webhook/telegram/...`)
4. Worker resolves session, queues command, delivers via WebSocket (`/ws?machineId=...`)
5. Machine agent sends `ack`, queue row becomes `acked`

## Token Handling

When the daemon sends a notification with inline buttons, the `callback_data` contains the daemon's token as `cmd:TOKEN:action`. The worker's `/notifications/send` handler **extracts this token** from the first button's `callback_data` and stores it in the `messages` table (instead of generating its own). This ensures that when the user clicks a button, the worker can look up the token and resolve it to the correct session.

If no `cmd:TOKEN:action` pattern is found in the `replyMarkup` (e.g. plain text notifications), the worker generates a fresh random token. See `extractTokenFromCallbackData()` in `notifications.ts`.

## R2 Media Bucket

The worker binds an R2 bucket (`MEDIA`, bucket `pigeon-media`) for bidirectional media relay between Telegram and OpenCode sessions.

- Binding: `env.MEDIA` (configured in `wrangler.toml`)
- Key format: `{direction}/{timestamp}-{id}/{filename}` where direction is `inbound` or `outbound`
- TTL: 24 hours — expired objects cleaned by hourly cron (`cleanupExpiredMedia` in `media.ts`)
- Max file size: 20 MB

### Media Endpoints

- `POST /media/upload` (Bearer) — multipart form with `key`, `mime`, `filename`, `file` fields. Returns `{ ok, key }`.
- `GET /media/<key>` (Bearer) — returns raw binary with `Content-Type` and `Content-Disposition` from R2 metadata.

### Inbound Flow (Telegram → R2)

1. `extractMedia()` in `webhook.ts` detects photo/document/audio/video/voice on incoming messages.
2. For photos: picks the largest Telegram variant where both dimensions are <= `MAX_IMAGE_DIMENSION` (1568px). If no variant fits, the media is skipped entirely (text command still goes through). This avoids Anthropic's 2000px multi-image limit and the latency penalty for images above 1568px.
3. `relayMediaToR2()` calls Telegram `getFile` API, downloads the binary, stores in R2 with key `inbound/<ts>-<fileUniqueId>/<filename>`.
4. A `MediaRef { key, mime, filename, size }` is serialized as `media_json` in the `command_queue` row.
5. WebSocket delivery includes `media: { key, mime, filename, size }` in the command payload.

**Image sizing trade-offs:** We rely on Telegram's pre-generated photo variants (~90px, ~320px, ~800px, ~1280px) rather than resizing ourselves. The ~1280px variant is typically selected, which is high quality for most use cases. If finer control is ever needed, daemon-side resizing with `sharp` (after R2 fetch) or worker-side WASM resizing can be layered on. See `docs/plans/2026-03-08-inbound-image-sizing-design.md`.

### Outbound Flow (R2 → Telegram)

1. Daemon uploads media via `POST /media/upload` with key `outbound/<ts>-<uuid>/<filename>`.
2. `POST /notifications/send` accepts an optional `media: Array<{ key, mime, filename }>` field.
3. Worker fetches each key from R2, sends as `sendPhoto` (images) or `sendDocument` (other types), each as a reply to the text notification message.
4. Media messages are stored in the `messages` table for reply routing.

## Durable Object Tables

- `sessions`: session-to-machine registry
- `messages`: Telegram message mapping for reply routing
- `command_queue`: pending/sent/acked command lifecycle (includes `media_json TEXT` column)
- `seen_updates`: Telegram update deduplication

## Endpoint Contracts

- `GET /health` -> `ok`
- `GET /sessions` (Bearer `CCR_API_KEY`) -> JSON list of session rows (`snake_case`)
- `POST /sessions/register` (Bearer) -> upsert session
- `POST /sessions/unregister` (Bearer) -> remove session
- `POST /notifications/send` (Bearer) -> send Telegram message + store mapping; optional `media[]` sends photos/documents as replies
- `POST /media/upload` (Bearer) -> upload file to R2 (multipart form)
- `GET /media/<key>` (Bearer) -> download file from R2
- `POST /webhook/telegram/{path}` (`X-Telegram-Bot-Api-Secret-Token`) -> process replies/callbacks
- `GET /ws?machineId=...` with upgrade + protocol `ccr,<CCR_API_KEY>` -> machine agent socket

## Telegram Commands

### `/launch <machine> <directory> <prompt>`

Starts a headless OpenCode session on a remote machine.

1. Worker parses machine, directory, and prompt from the message text.
2. Checks if the machine has an active WebSocket connection; replies "not connected" if not.
3. Queues a `"launch"` type command with `session_id = null` and the directory.
4. WebSocket message format: `{ type: "launch", commandId, directory, prompt, chatId }`
5. Daemon's `launch-ingest.ts` creates a session via `OpencodeClient.createSession()`, sends the prompt, and replies to Telegram with the session ID.
6. The pigeon plugin in opencode-serve detects the new session and registers it with the worker via `/sessions/register`.

### `/kill <session-id>`

Terminates a running OpenCode session.

1. Worker looks up the session in the `sessions` table to find the `machine_id`.
2. Replies "not found" if session doesn't exist, "not connected" if machine is offline.
3. Queues a `"kill"` type command.
4. WebSocket message format: `{ type: "kill", commandId, sessionId, chatId }`
5. Daemon's `kill-ingest.ts` calls `OpencodeClient.deleteSession()` and replies to Telegram with the result.

## Command Types

`CommandType = "execute" | "launch" | "kill"` (in `command-queue.ts`)

- `execute`: regular command injection into an existing session (default)
- `launch`: create a new headless session + send initial prompt
- `kill`: terminate an existing session via opencode API

## Command Queue Notes

- At-least-once behavior through persisted queue rows
- Alarm-driven cleanup + retry sweep runs hourly (`alarm()` in DO)
- Retry and backoff logic lives in `packages/worker/src/command-queue.ts`

## Cron

- Schedule: `0 * * * *` (hourly)
- Handler: `scheduled()` in `index.ts` calls `cleanupExpiredMedia(env)` which deletes R2 objects older than 24 hours under `inbound/` and `outbound/` prefixes

## Verify

Run:

```bash
npm run --workspace @pigeon/worker test
npm run --workspace @pigeon/worker typecheck
```

Expected:

- tests pass
- typecheck passes
