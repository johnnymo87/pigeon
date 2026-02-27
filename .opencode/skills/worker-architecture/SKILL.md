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

## Durable Object Tables

- `sessions`: session-to-machine registry
- `messages`: Telegram message mapping for reply routing
- `command_queue`: pending/sent/acked command lifecycle
- `seen_updates`: Telegram update deduplication

## Endpoint Contracts

- `GET /health` -> `ok`
- `GET /sessions` (Bearer `CCR_API_KEY`) -> JSON list of session rows (`snake_case`)
- `POST /sessions/register` (Bearer) -> upsert session
- `POST /sessions/unregister` (Bearer) -> remove session
- `POST /notifications/send` (Bearer) -> send Telegram message + store mapping
- `POST /webhook/telegram/{path}` (`X-Telegram-Bot-Api-Secret-Token`) -> process replies/callbacks
- `GET /ws?machineId=...` with upgrade + protocol `ccr,<CCR_API_KEY>` -> machine agent socket

## Command Queue Notes

- At-least-once behavior through persisted queue rows
- Alarm-driven cleanup + retry sweep runs hourly (`alarm()` in DO)
- Retry and backoff logic lives in `packages/worker/src/command-queue.ts`

## Verify

Run:

```bash
bun run --filter '@pigeon/worker' test
bun run --filter '@pigeon/worker' typecheck
```

Expected:

- tests pass
- typecheck passes
