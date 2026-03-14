# D1 + HTTP Polling Architecture Design

**Goal:** Replace the Durable Object + WebSocket relay with D1 + HTTP short polling, eliminating the dominant failure mode (DO host migration killing WebSocket connections every 30-70 minutes).

## Context

Boot ID tracking confirmed that ~100% of WebSocket disconnects are caused by Cloudflare migrating the Durable Object to a new host. This is documented platform behavior that cannot be prevented. We built extensive mitigation (command queue, ack/retry, reconnect backoff, heartbeats, hibernation workarounds, dual-path fallback) but the system remains fragile and complex.

The core insight: once you have a durable queue with ack/retry, the WebSocket is only shaving latency while adding failure surface. Replacing it with stateless HTTP polling removes the entire class of connection-lifecycle problems.

## Architecture

```
Current:
  Telegram → Webhook → Worker → Durable Object ↔ WebSocket ↔ Daemon → Plugin → Claude

Proposed:
  Telegram → Webhook → Worker → D1 (shared SQLite)
                                  ↑
               Daemon polls:  GET  /machines/:id/next    (every 5s)
               Daemon acks:   POST /commands/:id/ack
               Daemon sends:  POST /notifications/send
                                  ↓
                            Plugin → Claude
```

Each HTTP request is stateless and disposable. If the Worker restarts, the daemon's next poll succeeds against the new instance. No connection state to rebuild.

## Why D1 Instead of Cloudflare Queues

We initially considered Cloudflare Queues with HTTP pull consumers. However, Queues has no message filtering -- a pull returns whatever message is next, with no way to filter by machine ID. With a shared queue and multiple daemons, messages intended for machine A would be pulled by machine B and need to be retried, adding latency and wasted operations.

D1 (Cloudflare's serverless SQLite) solves this naturally: the Worker queries `WHERE machine_id = ? AND status = 'pending'`. Adding or removing machines requires no infrastructure changes -- just start or stop polling with a new machine ID.

## D1 Schema

Four tables, migrated from the DO's in-memory SQLite:

### commands

The central delivery table. Replaces the DO's `command_queue`.

| Column | Type | Notes |
|--------|------|-------|
| command_id | TEXT PK | UUID, set by Worker on ingest |
| machine_id | TEXT NOT NULL | Target daemon |
| session_id | TEXT | Target Claude session (null for launch) |
| type | TEXT NOT NULL | `execute`, `launch`, `kill` |
| payload | TEXT NOT NULL | JSON command body |
| status | TEXT NOT NULL | `pending`, `leased`, `done`, `failed` |
| created_at | INTEGER NOT NULL | Unix ms |
| leased_at | INTEGER | Unix ms, set when daemon pulls |
| acked_at | INTEGER | Unix ms, set when daemon acks |

Index: `(machine_id, status, created_at)` for the poll query.

Lease timeout: 60 seconds. If `status = 'leased'` and `leased_at` is older than 60s, the command becomes available again. This provides at-least-once delivery without custom queue code.

### sessions

Maps session IDs to machines. Replaces the DO's `sessions` table.

| Column | Type | Notes |
|--------|------|-------|
| session_id | TEXT PK | |
| machine_id | TEXT NOT NULL | |
| created_at | INTEGER NOT NULL | Unix ms |
| last_seen_at | INTEGER NOT NULL | Unix ms, updated on notifications |

### messages

Reply routing: maps Telegram messages to sessions. Replaces the DO's `messages` table.

| Column | Type | Notes |
|--------|------|-------|
| chat_id | TEXT NOT NULL | Telegram chat |
| message_id | TEXT NOT NULL | Telegram message |
| session_id | TEXT NOT NULL | |
| token | TEXT NOT NULL | Session token for auth |
| created_at | INTEGER NOT NULL | Unix ms |

PK: `(chat_id, message_id)`

### seen_updates

Telegram update deduplication. Replaces the DO's `seen_updates` table.

| Column | Type | Notes |
|--------|------|-------|
| update_id | INTEGER PK | Telegram update ID |
| created_at | INTEGER NOT NULL | Unix ms |

## Worker Changes

### Remove

- `RouterDurableObject` class and all WebSocket handling (router-do.ts)
- `CommandQueue` class (command-queue.ts)
- Durable Object binding and migration in wrangler.toml
- WebSocket upgrade endpoint (`/ws`)
- Boot ID generation
- Alarm handler (command retry logic moves to lease timeout in poll query)

### Add

- D1 binding in wrangler.toml
- `GET /machines/:id/next` -- poll endpoint
  - Query: select oldest pending command for machine, or leased command with expired lease
  - Atomically set status = leased, leased_at = now
  - Return command payload, or 204 if none
  - Auth: API key in Authorization header
- `POST /commands/:id/ack` -- acknowledge endpoint
  - Set status = done, acked_at = now
  - Auth: API key in Authorization header
- D1 migration SQL for schema creation

### Keep (mostly unchanged)

- Telegram webhook handler (writes to D1 instead of DO)
- `/notifications/send` endpoint (reads reply routing from D1 instead of DO)
- R2 media upload/download endpoints
- Cron handler (cleanup old commands and seen_updates from D1)
- Telegram API integration
- Chat/user allowlist checking

## Daemon Changes

### Remove

- `MachineAgent` WebSocket client (or gut it down to an HTTP poller)
- Heartbeat / ping / pong timers
- Reconnect backoff logic
- Pending commandResult buffer
- Boot ID tracking
- `FallbackNotifier` dual-path logic (the HTTP path becomes the only path)

### Add

- HTTP poller: `setInterval` that calls `GET /machines/:id/next` every 5 seconds
- On command received: ack, then deliver to plugin (same as today)
- On delivery failure: don't ack (lease expires, command becomes available again)

### Keep (unchanged)

- Local command inbox with dedup (INSERT OR IGNORE on command_id)
- Session storage and management
- Plugin delivery (DirectChannelAdapter, NvimRpcAdapter)
- Notification service (POST to Worker, now the only path)
- Media fetch from R2

## Polling Parameters

- **Interval:** 5 seconds
- **Free tier budget:** D1 allows 5M reads/day. One daemon at 5s = 17,280 reads/day. Three daemons = 51,840 reads/day. Well within limits.
- **Lease timeout:** 60 seconds
- **Latency:** Average 2.5s (half the polling interval). Acceptable for the <5s requirement.
- **Auth:** API key in `Authorization: Bearer <key>` header (same key as current WebSocket auth)

## What Gets Deleted (complexity payoff)

The following subsystems exist solely to cope with WebSocket unreliability and can be removed entirely:

- WebSocket connection management and state
- Heartbeat / keepalive / pong timeout logic
- Reconnect exponential backoff
- Hibernation workarounds (auto-response configuration, close handshake reciprocation)
- Dual-path notification fallback
- commandResult buffering during disconnects
- Dead socket cleanup
- Boot ID diagnostics
- Custom command queue with retry/backoff (replaced by lease timeout)

## Future Improvement: Long Polling

Cloudflare Queues does not support long polling, but we can build it at the Worker level as a latency optimization:

- `GET /machines/:id/next?timeout=25`
- Worker holds the connection open, polls D1 internally at 1s intervals
- Returns immediately when a command appears, or 204 after timeout
- Reduces daemon HTTP traffic from ~17K/day to ~3.5K/day per daemon
- Workers support up to 30s request duration on free plan, so `timeout=25` fits
- The daemon falls back to short polling if the long-poll request errors

This is not needed at our current scale but is a clean optimization if polling overhead ever matters.

## Migration Strategy

The migration can be done incrementally:

1. Create D1 database and schema
2. Add new Worker endpoints (poll, ack) alongside existing DO
3. Update daemon to use HTTP polling instead of WebSocket
4. Verify end-to-end flow
5. Remove DO code and binding from Worker
6. Deploy and monitor
