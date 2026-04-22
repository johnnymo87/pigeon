---
name: swarm-architecture
description: Use when you need to understand the swarm IPC subsystem — tables, routes, the per-target arbiter, the session→directory registry, and the wire envelope — before changing it
---

# Swarm IPC Architecture

## When To Use

Use this before changing the swarm tables, routes, arbiter scheduling, envelope shape, or session-directory resolution.

## Why It Exists

OpenCode serve's `POST /session/<id>/prompt_async` has a race: concurrent requests targeting the same session from **different** `x-opencode-directory` headers bypass the per-session busy guard, producing parallel LLM turns and 400 "does not support assistant message prefill" from Anthropic. This bit us in COPS-6107 when a swarm of 5 sessions tried to message each other directly.

The swarm subsystem fixes the race **architecturally** by making the daemon the single writer to opencode serve for cross-session messages: every `pigeon-send` call POSTs to the daemon, the daemon persists durably, and a per-target arbiter ensures at most one `prompt_async` is in flight per target session at any time.

It also gives us durable delivery, retry with backoff, replay via inbox, and an in-transcript `<swarm_message>` envelope that lets receiving agents distinguish swarm traffic from user prompts.

## Where The Code Lives

| File | Role |
|---|---|
| `packages/daemon/src/storage/swarm-schema.ts` | `initSwarmSchema(db)` — `swarm_messages` table + 3 indexes |
| `packages/daemon/src/storage/swarm-repo.ts` | `SwarmRepository` — typed accessor; constructed inside `openStorageDb()` and exposed as `storage.swarm` |
| `packages/daemon/src/swarm/envelope.ts` | `renderEnvelope({fields}, payload)` — produces the `<swarm_message>` XML the LLM sees |
| `packages/daemon/src/swarm/registry.ts` | `SessionDirectoryRegistry` — caches `sessionId → directory` (5min TTL) |
| `packages/daemon/src/swarm/arbiter.ts` | `SwarmArbiter` — per-target queue with at-most-one in-flight delivery and retry/backoff |
| `packages/daemon/src/app.ts` | `POST /swarm/send`, `GET /swarm/inbox` route blocks (flat `if`-style, mirrors existing routes) |
| `packages/daemon/src/index.ts` | Boots arbiter conditionally on `opencodeClient && config.opencodeUrl` |
| `packages/opencode-plugin/src/swarm-tool.ts` | `swarmRead()` helper + `createSwarmReadTool()` factory |

## Storage Schema

`swarm_messages` (in pigeon-daemon SQLite, same DB as outbox/sessions):

| Column | Type | Notes |
|---|---|---|
| `msg_id` | TEXT PRIMARY KEY | `msg_<base36-ts>_<uuid8>` from `makeMsgId()` in `app.ts`, or caller-supplied via `--msg-id` for idempotency |
| `from_session` | TEXT NOT NULL | sender's opencode session id |
| `to_session` | TEXT | direct-target id (mutually exclusive with `channel`) |
| `channel` | TEXT | broadcast channel name (mutually exclusive with `to_session`) |
| `kind` | TEXT NOT NULL | `chat`, `task.assign`, `status.update`, `clarification.{request,reply}`, `artifact.handoff` |
| `priority` | TEXT NOT NULL DEFAULT `'normal'` | `urgent` / `normal` / `low` |
| `reply_to` | TEXT | quotes a previous `msg_id` for threading |
| `payload` | TEXT NOT NULL | the actual message body |
| `state` | TEXT NOT NULL DEFAULT `'queued'` | `queued` → `handed_off` (terminal) or `failed` (terminal after MAX_ATTEMPTS) |
| `attempts` | INTEGER NOT NULL DEFAULT 0 | incremented on each retry |
| `next_retry_at` | INTEGER | unix-ms; `NULL` once terminal |
| `created_at` | INTEGER NOT NULL | first POST time |
| `updated_at` | INTEGER NOT NULL | bumped on every state transition |
| `handed_off_at` | INTEGER | unix-ms when `prompt_async` returned 2xx |

Indexes:
- `idx_swarm_target_state` on `(to_session, state, next_retry_at, created_at)` — what the arbiter scans
- `idx_swarm_inbox` on `(to_session, state, msg_id)` — what `GET /swarm/inbox` scans
- `idx_swarm_channel` on `(channel, state, created_at)` — for broadcast (v0.5)

`channel` is reserved for broadcast and **not used by MVP** (`POST /swarm/send` accepts it but no fanout is implemented yet).

## Wire Envelope

`renderEnvelope` produces this exact shape, which the LLM reads in the next user turn of the target session:

```xml
<swarm_message v="1" kind="task.assign"
               from="ses_abc..." to="ses_def..."
               msg_id="msg_..." priority="normal"
               reply_to="msg_xyz...">
The actual payload here.
</swarm_message>
```

Attributes:
- `v="1"` — schema version. Bump on breaking changes; receivers should fail loudly on unknown versions.
- `kind`, `from`, `to`, `msg_id`, `priority` — always present.
- `channel` — present instead of `to` when message originated as a broadcast (v0.5).
- `reply_to` — only present when set.

The payload is XML-escaped for `&`, `<`, `>` (see `envelope.ts` for the exact encoder).

## Routes

### `POST /swarm/send`

Request body (JSON):

```json
{
  "from": "ses_abc...",
  "to": "ses_def...",
  "kind": "chat",
  "priority": "normal",
  "payload": "the actual message",
  "reply_to": "msg_xyz...",
  "msg_id": "caller-supplied-id"
}
```

- Either `to` OR `channel` is required, not both.
- `from` and `payload` are required.
- `kind` defaults to `chat`, `priority` defaults to `normal`.
- `msg_id` is the idempotency key; if omitted the daemon generates one.

Response: HTTP 202 `{ "accepted": true, "msg_id": "msg_..." }` immediately. The daemon writes the row in `state='queued'`; the arbiter dispatches asynchronously.

Validation errors return 400 with `{ "error": "..." }`.

### `GET /swarm/inbox?session=<id>[&since=<msg_id>]`

Returns only messages with `state='handed_off'` (i.e. successfully delivered to the target's transcript). Use `since` as a cursor — only messages with `msg_id > since` are returned. Ordered by `msg_id` (which is monotonically time-sortable because of the base36 timestamp prefix).

Response shape:

```json
{
  "messages": [
    {
      "msg_id": "msg_...",
      "from": "ses_...",
      "to": "ses_...",
      "channel": null,
      "kind": "chat",
      "priority": "normal",
      "reply_to": null,
      "payload": "...",
      "created_at": 1776825743119,
      "handed_off_at": 1776825743596
    }
  ]
}
```

The inbox does **not** return `queued` or `failed` messages — it's an inbox, not a queue inspector. To see queued/failed messages, query the `swarm_messages` table directly via `sqlite3` (see `swarm-operations` skill).

## Arbiter

`SwarmArbiter` (`packages/daemon/src/swarm/arbiter.ts`):

- **Tick interval**: 500ms (configured in `index.ts`: `swarmArbiter.start(500)`).
- **Per-tick algorithm** (`processOnce`):
  1. `storage.swarm.listTargetsWithReady(now)` — find every distinct target with at least one `queued` message whose `next_retry_at <= now`.
  2. For each target in parallel: `drainTarget(target)`.
- **`drainTarget`** uses an in-process `Map<target, Promise>` to ensure at most one in-flight `prompt_async` per target. Concurrent calls collapse onto the same promise.
- **`drainTargetInner`** loops: pull one ready msg, resolve directory via the registry, render envelope, `opencodeClient.sendPrompt(target, directory, prompt)`. On success: `markHandedOff`. On failure: `markRetry` with backoff (or `markFailed` after `MAX_ATTEMPTS=10`). Failure stops the inner loop for this target until the next tick (so a stuck target doesn't burn CPU).

Backoff schedule (in `arbiter.ts`): `[1s, 2s, 5s, 15s, 60s]`. Attempt N uses `BACKOFF_SCHEDULE[min(N, 4)]` — i.e. attempt ≥5 stays at 60s. Total wall time before `failed`: ~15min.

**The race-fix property**: at most one `prompt_async` to the same target at any time. Proven both by integration test (`test/swarm-routes.integration.test.ts` — fires 4 concurrent POSTs and asserts no overlap via timestamps) and by live smoke (10 concurrent → arbiter events strictly 500ms apart, see `2026-04-21-swarm-ipc-plan.md` Task 12 results).

**Why a single in-flight per target is enough**: opencode serve's race occurs when two `prompt_async` calls land on the same session id from different `x-opencode-directory` headers. Since the daemon is the single writer and uses the registry to canonicalize the directory, all daemon-routed traffic always uses the same directory header. The race is gone for daemon-routed traffic. (`opencode-send --direct` bypasses the daemon and re-introduces the race; that's why Task 13 exists as a defense-in-depth follow-up.)

## Session Directory Registry

`SessionDirectoryRegistry` (`packages/daemon/src/swarm/registry.ts`):

- Constructed in `index.ts` with `baseUrl: config.opencodeUrl` and `ttlMs: 5 * 60 * 1000` (5min).
- `resolve(sessionId)`: returns cached directory if not expired; else `GET <baseUrl>/session/<id>`, parses `body.directory`, caches with TTL.
- `invalidate(sessionId)`: drops cache entry. Not currently called by the arbiter (a stale entry will be invalidated by the next 404 from `prompt_async` indirectly, since the next `getReadyForTarget` will likely re-resolve after retry backoff).

The registry is what makes the daemon "the canonical source of `directory` for a session" — `pigeon-send` callers don't pass `--cwd`; the daemon looks it up. This is the core of the protocol simplification (no more "remember to pass `--cwd <target's-own-dir>`").

## Boot Conditional

In `index.ts`:

```ts
const swarmArbiter = opencodeClient && config.opencodeUrl
  ? new SwarmArbiter({ ... })
  : undefined;

if (swarmArbiter) {
  swarmArbiter.start(500);
  console.log("[pigeon-daemon] swarm arbiter started (interval=500ms)");
} else {
  console.log("[pigeon-daemon] swarm arbiter NOT started (no opencodeUrl in config)");
}
```

The arbiter is opt-in: a daemon configured without `opencodeUrl` (e.g. a worker-only deployment) skips arbiter startup entirely. The routes (`POST /swarm/send`, `GET /swarm/inbox`) still work — messages will accumulate in `state='queued'` until an arbiter eventually drains them.

## OpenCode Plugin Tool

The plugin registers `swarm.read` as an opencode tool that calls `GET /swarm/inbox` on behalf of the calling session. See `opencode-plugin-architecture` for the tool registration mechanism. The pure helper (`swarmRead()`) and the factory (`createSwarmReadTool(daemonBaseUrl)`) live in `packages/opencode-plugin/src/swarm-tool.ts`.

## Sender CLI

Senders use `~/.local/bin/pigeon-send` (provisioned by workstation `users/dev/home.base.nix`). The wrapper POSTs to `/swarm/send` and pulls `--from` from `$OPENCODE_SESSION_ID` by default. The legacy `~/.local/bin/opencode-send` auto-routes to `pigeon-send` when the target matches `^ses_` and the daemon `/health` returns 2xx (with `--direct` as the escape hatch).

See workstation `assets/opencode/skills/swarm-messaging/` and `opencode-send/` for the user-facing skill docs.

## Verify

```bash
npm run --workspace @pigeon/daemon typecheck
npm run --workspace @pigeon/daemon test
```

Expected:

- typecheck passes
- swarm tests pass (`swarm-repo`, `swarm-envelope`, `swarm-registry`, `swarm-arbiter`, `swarm-routes`, `swarm-routes.integration`)
