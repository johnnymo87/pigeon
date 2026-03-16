# Design: Question Notification Reliability Overhaul

## Problem

OpenCode questions sometimes never reach Telegram. Five verified silent drop points exist in the plugin-to-daemon-to-worker notification pipeline:

1. **Shared circuit breaker** silently blocks questions after any daemon call failure (30-60s window)
2. **Awaited stop flush** before question send can trip the breaker, cascading into question loss
3. **Daemon masks failures as HTTP 200** with `{ok: true, notified: false}` -- plugin sees success
4. **Store-before-send** creates orphaned pending questions when Telegram send fails
5. **Fire-and-forget** with no retry -- dropped questions are permanently lost

The root cause: question delivery is treated as a best-effort side effect, but questions are state transitions that block the conversation.

## Design Principle

Promote question delivery to a first-class, durable workflow with idempotent ownership transfer:

- **Before daemon ack:** best effort with retry (plugin in-memory queue)
- **After daemon ack:** durable eventual delivery (daemon SQLite outbox)

## Architecture

```
Plugin                          Daemon                          Worker
------                          ------                          ------
question.asked event
  |
  v
in-memory retry queue ------> POST /question-asked
  |                              |
  |                              v
  |                           SQLite transaction:
  |                             - upsert pending_questions
  |                             - mint session_token
  |                             - insert outbox (state=queued)
  |                              |
  |                              v
  |<---- 202 Accepted -------- return immediately
  |
  v
dequeue (daemon owns it)
                                 |
                              outbox sender (background loop, 5s)
                                 |
                                 v
                              POST /notifications/send -------> Telegram API
                                 |                               (with notification_id
                                 v                                for idempotency)
                              outbox state = sent
```

## Plugin Changes

### A. Remove questions from shared circuit breaker

`notifyQuestionAsked` bypasses the module-level circuit breaker entirely. It uses its own bounded retry queue. Stop/session-start/question-answered keep the existing breaker (best-effort).

### B. In-memory retry queue

When `question.asked` fires, the question is enqueued immediately (before any stop flush). A delivery loop retries against the daemon with exponential backoff:

- Schedule: 0.5s, 1s, 2s, 4s, 8s, 15s, 30s
- Jitter: yes (random 0-50% of interval)
- Dedup key: `(sessionId, requestId)`
- Max retry window: 2 minutes
- Queue bound: 20 entries (oldest evicted on overflow)

### C. Decouple stop flush from question path

The `notifyStop` call before a question becomes fire-and-forget (not awaited). Its success or failure cannot cascade into the question delivery path. Ordering preserved: stop flush fires first, question enqueues immediately after without waiting.

### D. Response handling

Plugin treats daemon responses as:
- 2xx with `deliveryState: "accepted"` or `"sent"`: success, dequeue
- Non-2xx or network error: retry-eligible, keep in queue
- Backward compat: if response lacks `deliveryState`, fall back to `notified: true/false`

### E. Logging

- Log when question enqueued (info)
- Log each retry attempt (info, with attempt count)
- Log delivery success (info)
- Log retry window exhaustion (warn -- question permanently lost)

## Daemon Changes

### A. Durable accept on `/question-asked`

The endpoint performs a single SQLite transaction:

1. Upsert `pending_questions` row keyed by `(session_id, request_id)`
2. Generate and store token in `session_tokens`
3. Insert `outbox` row with state `queued`, stable `notification_id = hash(session_id, request_id)`
4. Return 202 `{ ok: true, deliveryState: "accepted" }` immediately

No worker/Telegram call inline. The daemon takes durable ownership.

### B. Outbox table

```sql
CREATE TABLE IF NOT EXISTS outbox (
  notification_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'question',
  state TEXT NOT NULL DEFAULT 'queued',
  payload TEXT NOT NULL,
  token TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_retry
  ON outbox(state, next_retry_at);
```

States: `queued` | `sending` | `sent` | `failed`

`payload` is JSON containing the pre-formatted notification text, reply markup, label, session metadata -- everything needed to call the worker without re-reading pending_questions.

### C. Background outbox sender

A loop (5s interval, runs alongside the existing poller) processes outbox rows:

1. Query: `SELECT * FROM outbox WHERE state IN ('queued') AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY created_at LIMIT 5`
2. For each row:
   - Set `state = 'sending'`, `updated_at = now`
   - Attempt `sendViaWorker(...)` with `notification_id` in payload
   - On success: `state = 'sent'`, clear `next_retry_at`
   - On transient failure: `state = 'queued'`, increment `attempts`, set `next_retry_at` with backoff (5s, 10s, 30s, 60s, 120s)
   - On terminal failure (attempts >= 10 or age > 15 minutes): `state = 'failed'`, log error

Guard against overlapping runs (same pattern as poller's `polling` flag).

### D. Response semantics

| Status | Body | Meaning |
|--------|------|---------|
| 202 | `{ok: true, deliveryState: "accepted"}` | Durably queued, will deliver |
| 200 | `{ok: true, deliveryState: "sent"}` | Already delivered (idempotent retry) |
| 200 | `{ok: true, deliveryState: "queued"}` | Already queued, still retrying |
| 400 | `{error: "..."}` | Validation error |
| 404 | `{error: "Session not found"}` | Session expired/unknown |
| 503 | `{error: "..."}` | Cannot persist (SQLite error) |

Removes the pattern of returning 200 `{ok: true, notified: false}` for failures.

### E. Idempotent upsert

If the plugin retries with the same `(session_id, request_id)`:
- Outbox row exists and is `sent`: return 200 `{deliveryState: "sent"}`
- Outbox row exists and is `queued`/`sending`: return 202 `{deliveryState: "queued"}` (already processing)
- Outbox row exists and is `failed`: reset to `queued`, return 202 (re-attempt)
- No outbox row: create new, return 202

### F. Cleanup

Outbox rows in terminal state (`sent`, `failed`) older than 1 hour are deleted by a periodic sweep (piggyback on existing session cleanup or dedicated timer).

## Worker Changes

### A. Notification idempotency

`POST /notifications/send` accepts an optional `notificationId` field.

Before sending to Telegram:
1. Check D1 `messages` table for a row with matching `notification_id`
2. If found: return existing message data (idempotent, no duplicate Telegram message)
3. If not: send to Telegram, store row with `notification_id`

Schema change: add `notification_id TEXT` column to `messages` table (nullable, unique index where not null).

### B. No other changes

Webhook path (button press -> command queue) and poll path remain unchanged.

## Observability

| Layer | Event | Level | Fields |
|-------|-------|-------|--------|
| Plugin | question enqueued | info | sessionId, requestId, queueSize |
| Plugin | delivery attempt | info | sessionId, requestId, attempt, backoffMs |
| Plugin | delivery success | info | sessionId, requestId, deliveryState |
| Plugin | retry exhausted | warn | sessionId, requestId, totalAttempts |
| Daemon | outbox row created | info | notificationId, sessionId, requestId |
| Daemon | outbox send attempt | info | notificationId, attempt |
| Daemon | outbox send success | info | notificationId |
| Daemon | outbox send failed (retryable) | warn | notificationId, attempt, nextRetryAt |
| Daemon | outbox terminal failure | error | notificationId, attempts, age |
| Daemon | idempotent duplicate | info | notificationId, existingState |

## Backward Compatibility

- **Plugin**: detects new vs old daemon by presence of `deliveryState` in response body. Falls back to `notified: true/false` for old daemon.
- **Worker**: `notification_id` column is nullable. Old daemon calls without it skip dedup (same as today).
- **Daemon**: outbox table is additive. No existing table modifications. `/question-asked` response shape changes from `{ok, notified}` to `{ok, deliveryState}` -- plugin handles both.

## Testing Strategy

- **Plugin**: unit test retry queue (enqueue, dequeue on success, retry on failure, max retries, idempotency). Test that stop flush failure doesn't block question delivery. Test backward compat response handling.
- **Daemon**: unit test outbox state machine (queued -> sending -> sent, retry backoff, terminal failure, idempotent upsert). Integration test: `/question-asked` returns 202 without calling worker.
- **Worker**: unit test notification idempotency (duplicate `notificationId` returns existing data).
- **End-to-end**: manual test on devbox: trigger question, verify Telegram delivery. Kill daemon mid-flow, restart, verify question still delivers.

## Documentation Updates

After implementation:
- Update `AGENTS.md` question flow description to reflect outbox architecture
- Update `.claude/skills/daemon-architecture/SKILL.md` -- add outbox table, background sender, new response semantics
- Update `.claude/skills/opencode-plugin-architecture/SKILL.md` -- add retry queue, breaker bypass, decoupled flush
- Update `.claude/skills/worker-architecture/SKILL.md` -- add notification idempotency
