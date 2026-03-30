---
name: worker-architecture
description: Use when you need to understand worker architecture, endpoint flow, and command routing behavior before making changes
---

# Pigeon Worker Architecture

## When To Use

Use this skill when you need system-level understanding before debugging, deployment, or parity checks.

## Overview

`@pigeon/worker` is a Cloudflare Worker backed by D1 (serverless SQLite).

- Worker script: `packages/worker/src/index.ts`
- D1 operations: `packages/worker/src/d1-ops.ts`
- D1 schema: `packages/worker/src/d1-schema.sql`
- Runtime state: D1 database `pigeon-router`

## Core Flow

1. Session registers (`/sessions/register`) with `sessionId -> machineId`
2. Notification sent (`/notifications/send`) to Telegram and mapped as `chat_id + message_id -> sessionId + token`
3. User replies in Telegram webhook (`/webhook/telegram/...`)
4. Worker resolves session, queues command in D1 `commands` table
5. Daemon polls `GET /machines/:id/next`, receives command, delivers to plugin
6. Daemon acks via `POST /commands/:id/ack`, command marked `done`

## Token Handling

When the daemon sends a notification with inline buttons, the `callback_data` contains the daemon's token as `cmd:TOKEN:action`. The worker's `/notifications/send` handler **extracts this token** from the first button's `callback_data` and stores it in the `messages` table (instead of generating its own). This ensures that when the user clicks a button, the worker can look up the token and resolve it to the correct session.

If no `cmd:TOKEN:action` pattern is found in the `replyMarkup` (e.g. plain text notifications), the worker generates a fresh random token. See `extractTokenFromCallbackData()` in `notifications.ts`.

## R2 Media Bucket

The worker binds an R2 bucket (`MEDIA`, bucket `pigeon-media`) for bidirectional media relay between Telegram and OpenCode sessions.

- Binding: `env.MEDIA` (configured in `wrangler.toml`)
- Key format: `{direction}/{timestamp}-{id}/{filename}` where direction is `inbound` or `outbound`
- TTL: 24 hours -- expired objects cleaned by hourly cron (`cleanupExpiredMedia` in `media.ts`)
- Max file size: 20 MB

### Media Endpoints

- `POST /media/upload` (Bearer) -- multipart form with `key`, `mime`, `filename`, `file` fields. Returns `{ ok, key }`.
- `GET /media/<key>` (Bearer) -- returns raw binary with `Content-Type` and `Content-Disposition` from R2 metadata.

### Inbound Flow (Telegram -> R2)

1. `extractMedia()` in `webhook.ts` detects photo/document/audio/video/voice on incoming messages.
2. For photos: picks the largest Telegram variant where both dimensions are <= `MAX_IMAGE_DIMENSION` (1568px). If no variant fits, the media is skipped entirely (text command still goes through). This avoids Anthropic's 2000px multi-image limit and the latency penalty for images above 1568px.
3. `relayMediaToR2()` calls Telegram `getFile` API, downloads the binary, stores in R2 with key `inbound/<ts>-<fileUniqueId>/<filename>`.
4. A `MediaRef { key, mime, filename, size }` is serialized as `media_json` in the `commands` row.
5. Poll response includes `media: { key, mime, filename, size }` in the command payload.

**Image sizing trade-offs:** We rely on Telegram's pre-generated photo variants (~90px, ~320px, ~800px, ~1280px) rather than resizing ourselves. The ~1280px variant is typically selected, which is high quality for most use cases. If finer control is ever needed, daemon-side resizing with `sharp` (after R2 fetch) or worker-side WASM resizing can be layered on. See `docs/plans/2026-03-08-inbound-image-sizing-design.md`.

### Outbound Flow (R2 -> Telegram)

1. Daemon uploads media via `POST /media/upload` with key `outbound/<ts>-<uuid>/<filename>`.
2. `POST /notifications/send` accepts an optional `media: Array<{ key, mime, filename }>` field.
3. Worker fetches each key from R2, sends as `sendPhoto` (images) or `sendDocument` (other types), each as a reply to the text notification message.
4. Media messages are stored in the `messages` table for reply routing.

## D1 Tables

- `commands`: command delivery queue with lease-based polling (pending/leased/done lifecycle)
- `sessions`: session-to-machine registry
- `messages`: Telegram message mapping for reply routing. Includes `notification_id TEXT` (nullable, unique index where not null) for idempotent notification delivery -- if a `notificationId` is provided on `/notifications/send` and already exists in this table, the request is deduplicated without calling Telegram again.
- `seen_updates`: Telegram update deduplication
- `machines`: daemon last-poll-at tracking for online detection

## Endpoint Contracts

- `GET /health` -> `ok`
- `GET /machines/:id/next` (Bearer `CCR_API_KEY`) -> poll for next command (204 if none, JSON if available)
- `POST /commands/:id/ack` (Bearer) -> acknowledge a command (mark done)
- `GET /sessions` (Bearer) -> JSON list of session rows
- `POST /sessions/register` (Bearer) -> upsert session
- `POST /sessions/unregister` (Bearer) -> remove session
- `POST /notifications/send` (Bearer) -> send Telegram message + store mapping; optional `media[]` sends photos/documents as replies; optional `notificationId` enables idempotent delivery (returns `{ok: true, messageId, deduplicated: true}` if already delivered, without calling Telegram)
- `POST /notifications/edit` (Bearer) -> edit an existing Telegram message by `notificationId`; looks up `(chat_id, message_id)` from the `messages` table. Used by the daemon for wizard step transitions.
- `POST /media/upload` (Bearer) -> upload file to R2 (multipart form)
- `GET /media/<key>` (Bearer) -> download file from R2
- `POST /webhook/telegram/{path}` (`X-Telegram-Bot-Api-Secret-Token`) -> process replies/callbacks

## Telegram Commands

### `/launch <machine> <directory> <prompt>`

Starts a headless OpenCode session on a remote machine.

1. Worker parses machine, directory, and prompt from the message text.
2. Checks if the machine has polled recently (within 30s); replies "machine offline" if not.
3. Queues a `"launch"` type command in D1.
4. Daemon picks it up on next poll. Poll response: `{ commandType: "launch", commandId, directory, prompt, chatId }`
5. Daemon's `launch-ingest.ts` creates a session via `OpencodeClient.createSession()`, sends the prompt, and replies to Telegram with the session ID.
6. The pigeon plugin in opencode-serve detects the new session and registers it with the worker via `/sessions/register`.

### `/kill <session-id>`

Terminates a running OpenCode session.

1. Worker looks up the session in the `sessions` table to find the `machine_id`.
2. Replies "not found" if session doesn't exist, "machine offline" if not recently polled.
3. Queues a `"kill"` type command in D1.
4. Daemon picks it up. Poll response: `{ commandType: "kill", commandId, sessionId, chatId }`
5. Daemon's `kill-ingest.ts` calls `OpencodeClient.deleteSession()` and replies to Telegram with the result.

### `/compact` (reply-based)

Summarizes a session's conversation to reduce context.

1. User replies `/compact` to any session notification in Telegram.
2. Worker resolves the session from the replied-to message via `messages` table lookup.
3. Queues a `"compact"` type command in D1.
4. Daemon's `compact-ingest.ts` fetches session messages, finds the last user message's model, and calls `OpencodeClient.summarize()`.

### `/mcp list|enable|disable <args>`

Manages MCP server connections for a session.

- `/mcp list <session-id>`: lists all MCP servers with status (connected, disabled, failed, needs_auth).
- `/mcp enable <server> <session-id>`: connects (or reconnects if already connected) an MCP server.
- `/mcp disable <server> <session-id>`: disconnects an MCP server.

All three variants check the session exists and the machine is online before queuing. Daemon's `mcp-ingest.ts` calls `OpencodeClient.mcpStatus()`, `mcpConnect()`, or `mcpDisconnect()`.

### `/model <args>`

Lists or sets the model for a session.

- `/model <session-id>`: lists available models from allowed providers (anthropic, openai, google, vertex) with the current default.
- `/model <provider/model> <session-id>`: validates the model exists, then stores it as a `model_override` on the session in daemon SQLite.

The override is applied on subsequent command deliveries -- `command-ingest.ts` reads it and passes it through the adapter as `metadata.model`. The plugin includes it in the `prompt_async` request body.

## Command Types

`CommandType = "execute" | "launch" | "kill" | "compact" | "mcp_list" | "mcp_enable" | "mcp_disable" | "model_list" | "model_set"` (in `webhook.ts`)

- `execute`: regular command injection into an existing session (default)
- `launch`: create a new headless session + send initial prompt
- `kill`: terminate an existing session via opencode API
- `compact`: summarize/compact a session's conversation
- `mcp_list`: list MCP servers with connection status
- `mcp_enable`: connect (or reconnect) an MCP server
- `mcp_disable`: disconnect an MCP server
- `model_list`: list available models from allowed providers
- `model_set`: set a per-session model override

## Command Delivery (Lease-Based)

- Commands are inserted with `status = 'pending'`
- `GET /machines/:id/next` atomically sets `status = 'leased'` and `leased_at = now`
- `POST /commands/:id/ack` sets `status = 'done'` and `acked_at = now`
- If a leased command is not acked within 60 seconds, it becomes available again (lease expires)
- Hourly cron cleans up: acked commands older than 1 hour, stuck commands older than 24 hours

## Cron

- Schedule: `0 * * * *` (hourly)
- Handler: `scheduled()` in `index.ts` calls:
  - `cleanupExpiredMedia(env)` -- deletes R2 objects older than 24 hours
  - `cleanupCommands(env.DB)` -- deletes old acked and stuck commands from D1
  - `cleanupSeenUpdates(env.DB)` -- deletes old Telegram dedup entries from D1

## Future Improvement: Long Polling

Long polling at the Worker level (`GET /machines/:id/next?timeout=25`) would reduce daemon HTTP traffic from ~17K/day to ~3.5K/day per daemon. Workers support up to 30s request duration on the free plan. Not needed at current scale.

## Verify

Run:

```bash
npm run --workspace @pigeon/worker test
npm run --workspace @pigeon/worker typecheck
```

Expected:

- tests pass
- typecheck passes
