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
| `packages/daemon/src/swarm/telegram-notice.ts` | `enqueueSwarmTelegramNotice()` — helper enqueuing best-effort Telegram outbox notice |
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

## Turn-Preemption Policy (pigeon-0gxy)

**Delivery never preempts a running turn.** If a message is queued behind the
target's in-flight turn, the `DeliveryWatchdog` **waits indefinitely**. It
raises a one-shot advisory alert once `stuckAlertMs` passes (labelling the
blocker `ACTIVE` or `SILENT` per `STUCK_ABORT_SILENCE_MS`), and when the turn
ends the row is picked up on a later cycle and **nudged** — never re-injected,
per the "one payload injection per `msg_id`, forever" invariant.

**The rule, scoped.** Aborting a turn requires either (a) an explicit **human**
command targeting one named session, or (b) **lifecycle** termination of the
session itself (serve drain, `/kill`). *Delivery latency is never sufficient
cause* — no priority, no `urgent` kind, no operator-configurable bypass. And a
lifecycle cause must originate in the session's **own lifecycle state**, never
in any message's delivery state: "this delivery is stuck, so presume the
session wedged, so lifecycle-terminate it" is the banned move wearing a hat.

(The session reaper is *not* an example of (b): `reapStaleSessions` deletes
local routing rows and unregisters from the worker after a week idle. It never
terminates a session or its turn — its optional `deleteSession` dep is never
called and `index.ts` does not even pass it.)

**Why no automated exception, including for urgent mail.** opencode's
`runLoop()` re-reads the full transcript on every step, so a turn already
running **sees** a message injected after it started and can act on it
mid-turn. The turn blocking our message may be *the very turn processing it* —
and from outside, that case is byte-identical to an unrelated turn. Urgency
makes this worse, not better: the worst outcome for an urgent message is
killing the turn already handling it. Priority cannot buy information the
daemon does not have. Waiting costs latency; aborting destroys a peer's tool
calls, reasoning and partial answer irreversibly.

**The authorized override already exists**: the Telegram `/interrupt` command
(`worker/interrupt-ingest.ts` → `OpencodeClient.abortSession`). A human with
context decides, targets one session, and owns the consequence.

**No deadlock risk from waiting.** An agent awaiting a reply does so by *ending
its turn* (going idle), so "both busy" means both are working, not circularly
waiting; work terminates and mail then delivers. A mid-turn poller is covered
too, since `swarm_read` hits `GET /swarm/inbox` directly and bypasses the
prompt queue entirely — though `getInbox` filters on `handed_off`, so a poller
sees a row only once the arbiter has handed it off (~one 500ms tick). During a
serve outage neither path delivers, which is an availability problem, not a
deadlock.

**Enforcement, and exactly what it covers.** There are two automated paths that
could preempt, and each is guarded differently:

- **The watchdog** — a mutation-tested assertion fence: test 15 in
  `test/delivery-watchdog.test.ts` ("INVARIANT: abortSession is never called,
  for any row shape, ever") plus ~24 sibling assertions. Reintroducing
  `for (const c of clients.all) await c.abortSession(sessionId)` at the wait
  site fails 11 tests. `WatchdogClient.abortSession` is retained *deliberately*
  so that fence stays expressible — read its docblock before "cleaning up" the
  unused member.
- **The arbiter** — a structural fence: `ArbiterClient` (`arbiter.ts`) exposes
  only `sendPrompt`, so an abort in the delivery loop is a **compile error**.
  It has no "never called" assertions, which is precisely why the capability is
  withheld here instead.

Neither fence constrains code that builds its own HTTP call to
`POST /session/:id/abort` rather than going through a client. That residue is
covered by policy and review, not by a test.

## Session Directory Registry

`SessionDirectoryRegistry` (`packages/daemon/src/swarm/registry.ts`):

- Constructed in `index.ts` with `baseUrl: config.opencodeUrl` and `ttlMs: 5 * 60 * 1000` (5min).
- `resolve(sessionId)`: returns cached directory if not expired; else `GET <baseUrl>/session/<id>`, parses `body.directory`, caches with TTL.
- `invalidate(sessionId)`: drops cache entry. Not currently called by the arbiter (a stale entry will be invalidated by the next 404 from `prompt_async` indirectly, since the next `getReadyForTarget` will likely re-resolve after retry backoff).

The registry is what makes the daemon "the canonical source of `directory` for a session" — `pigeon-send` callers don't pass `--cwd`; the daemon looks it up. This is the core of the protocol simplification (no more "remember to pass `--cwd <target's-own-dir>`").

### Two hazards before you build any pre-flight gate

Both measured live on cloudbox. Both fail in the direction that *looks* like success, which is why they are here and not only in a code comment.

**1. `GET /session/status` is INSTANCE-SCOPED, and absent means idle (pigeon-unlw).**

Measured 2026-08-03, same serve, same moment, same session:

```
curl :4096/session/status
  -> {}
curl :4096/session/status -H 'x-opencode-directory: /home/dev/projects/pigeon'
  -> {"ses_035c43657ffexoUZgTYsjMgDES":{"type":"busy"}}
```

The status map lives in `InstanceState` and opencode partitions instances by working directory, so the header selects *which map you read*. Worse, `status.set()` **deletes** the key when a session goes idle — so an empty map is indistinguishable from "all sessions idle" **by design**. The failure mode is: correct endpoint, correct serve, wrong instance, answer looks healthy. Nothing in the response tells you that you asked the wrong map.

A busy-gate built without the header is therefore **a silent no-op that reports "idle", passes, and drops the prompt exactly as before.** Rules for any consumer:

- send the session's directory header, the *same* directory the delivery will use (`directoryForSession`);
- assert the serve you asked actually **owns** the session — a non-owning serve also answers `{}` rather than erroring;
- treat **absent as UNKNOWN, not IDLE**, unless both hold.

There is currently **no consumer of this endpoint in the daemon** — the only mention is a REFUSED DESIGN OPTION comment in `delivery-watchdog.ts`. If you adopt it, note that an unknown may only *delay or suppress* an alert (failing open into alerting is the safe direction); it may never justify a terminal.

**2. `prompt_async` does NOT validate the working directory (pigeon-0ay7).**

Measured 2026-08-10: against a session whose directory had been deleted, `prompt_async` returned **HTTP 204**. The turn then failed internally with `PlatformError: NotFound: FileSystem.realPath(<dir>)`, visible only on the plugin's event stream — never as an HTTP error. So a naive delivery records `handed_off` for a message the agent never saw, and the sender is told nothing.

The arbiter therefore stats the directory before sending (`swarm/directory-check.ts`) and throws `TargetUnavailableError` when it is provably absent, which the existing outage path turns into a retry rather than a terminal.

**The rule that governs both, and the one to carry forward:** a filesystem check may **refuse a future send**; it may never **re-interpret a turn already dispatched**. The same `stat` is sanctioned in the arbiter preflight and forbidden in the watchdog's silent-in-flight branch for exactly that reason.

## Telegram Topic Mirroring

Every swarm IPC message is mirrored to the **receiver's** Telegram forum topic thread so operators can see why a session started working.

### Hook Sites & Guarantees
- **Hooked at insert, not delivery**: Swarm rows enqueue a Telegram outbox notice at creation time across four insertion sites (`POST /swarm/send`, `POST /swarm/schedule`, `notifySenderOfFailure`, and `delivery-watchdog` nudges). Cancellations (`POST /swarm/scheduled/:msgId/cancel`) post a `🚫 cancelled <msg_id>` retraction notice.
- **Why insert-time**: Chosen to survive the on-hold quiet-swarm design under which agent-to-agent rows would never reach `handed_off`. Consequence: a Telegram post indicates **sent/enqueued**, NOT that the message reached the target session's transcript.
- **Fault isolation**: The `enqueueSwarmTelegramNotice` helper (`packages/daemon/src/swarm/telegram-notice.ts`) is wrapped in an internal `try/catch`. A Telegram/outbox failure MUST NEVER regress or fail swarm IPC, even when called inside `db.transaction`.
- **Channel broadcasts**: Skipped (`to_session IS NULL` has no topic).

### Notification Outbox & Rate Governance
- **Outbox Kind & IDs**: Outbox `kind='swarm'` (24h expiry; `mirror` reserved for Phase 2). IDs are `w:<msg_id>` for posts and `wc:<msg_id>` for retractions. Multi-chunk posts suffix earlier chunks via `chunkNotificationId` (`w:<msg_id>:c0`, etc.).
- **Sub-Budget Ceiling**: `SWARM_SUB_BUDGET = 6` of the governor's 12 sends/60s ceiling for `swarm`+`mirror` kinds. Prevents swarm bursts from starving questions/stops or provoking topic-creation 429 rate limits. An entry larger than the budget is allowed through an empty window. Deferring one entry also defers subsequent entries for that session to preserve per-session order.
- **Outbox Ordering Invariant**: `getReady` sorts by session rank → per-row tier (conversational: question/stop/card vs record: everything else) → `created_at` within tier (pigeon-81p invariant). Because conversational rows preempt backlogged swarm posts within a session, a swarm post may land **below** the stop notification it caused. Every post carries its event time.

### Production Baseline (7d Measured)
- Volume: 2,609 messages (~373/day, peak hour 133).
- Payload: mean 2,840 chars; 28% multi-chunk.
- Cancellations: ~6% of production rows.

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
