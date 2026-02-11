---
name: worker-architecture
description: Use when you need to understand how the Pigeon worker routes Telegram replies, manages sessions, and delivers commands to machine agents
---

# Pigeon Worker Architecture

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

## Verify Understanding

Run:

```bash
bun run --filter '@pigeon/worker' test
bun run --filter '@pigeon/worker' typecheck
```
