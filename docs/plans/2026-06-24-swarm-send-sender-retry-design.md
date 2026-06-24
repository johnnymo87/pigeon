# swarm_send sender-side retry (design)

Date: 2026-06-24
Bead: workstation-s08x
Scope: `packages/opencode-plugin/src/swarm-send-tool.ts` (sender side only)

## Problem

`swarmSend()` does a single `fetchFn` POST to the daemon's `/swarm/send` with no
try/catch and no retry. When the pigeon daemon (:4731) is briefly down — e.g. a
routine `pigeon-daemon` restart during a deploy — `fetch` rejects with
ECONNREFUSED, `execute()` throws, and the message is **lost**: never persisted to
`swarm_messages`, no spool, no resend. The tool description claims "Delivery is
asynchronous with retry", but that retry is **daemon-side** (the arbiter
redelivers an already-persisted message). The **sender-side** POST that persists
the message has zero retry.

Evidence (2026-06-24): a `pigeon-daemon` restart ate a peer's reply mid-send; it
never reached `swarm_messages` (not even `state=failed`), so a human relayed it
via a `/tmp` file.

## Decision: bounded retry-with-backoff only (no durable spool)

Two options were considered:

1. **Retry-with-backoff only** (chosen). Wrap the POST in a bounded retry loop
   that retries transient failures over a ~15s budget. Simple, self-contained,
   no new persistence surface.
2. **Retry + durable local spool-and-resend.** More robust for a *long* daemon
   outage, but adds real complexity: where to spool, a background flush loop
   (which this per-serve-loaded plugin has no natural home for), dedup, and
   lifecycle. Over-engineered for "survive a routine ~2s restart".

Pigeon restarts are brief (~2s). A backoff schedule of `500ms, 1s, 2s, 4s, 8s`
across 6 attempts (~15.5s of sleeping) covers ~7× the expected downtime with
margin. If the daemon is dead longer than that, we surface the error inline (the
LLM sees it) rather than silently dropping — strictly better than today.

### Idempotency key (cheap correctness add-on)

Retrying a persistence POST is at-least-once delivery. Without a stable id, the
rare "daemon persisted the row then the connection dropped before the 202 was
read" case would re-POST and the daemon would mint a *second* `msg_id` → the peer
receives a duplicate. We therefore generate the `msg_id` **client-side** (mirror
of the daemon's `msg_${base36(now)}_${uuid8}` format) and send it in the body.
The daemon already accepts a caller-supplied `msg_id` and dedups via
`INSERT OR IGNORE`, so the same id across retries is deduped → effectively-once.

## Retry policy

Retry only on **transient** failures:
- fetch rejection (ECONNREFUSED / "fetch failed" / network reset / DNS / timeout)
- HTTP 5xx
- HTTP 429

Do **not** retry on other 4xx (e.g. the 400 for a literal `</swarm_message>` close
tag, bad `ses_` shape). Those are permanent; preserve the current inline-error
behavior: throw `swarm_send failed: <status> <body>` immediately.

Named constants:
- `SWARM_SEND_MAX_ATTEMPTS = 6` (1 initial + 5 retries)
- `SWARM_SEND_INITIAL_BACKOFF_MS = 500`
- `SWARM_SEND_BACKOFF_FACTOR = 2`
- `SWARM_SEND_MAX_BACKOFF_MS = 8000`

Backoff before attempt N+1 = `min(INITIAL * FACTOR^(N-1), MAX)` →
`500, 1000, 2000, 4000, 8000`.

## LLM-facing result

`SwarmSendResult` gains an optional `attempts: number`. `formatSendResult` appends
a note when `attempts > 1` ("Accepted after N attempts — transient daemon errors
were retried.") so the agent knows the send was flaky but succeeded.

## Testability

`swarmSend()` already injects `fetchFn`. Add two more injectable seams used only
by tests (production defaults are real):
- `sleepFn?: (ms) => Promise<void>` — tests inject a no-op recorder so they don't
  actually wait ~15s and can assert the backoff schedule.
- `makeMsgId?: () => string` — tests inject a fixed id to prove the same id is
  reused across retries (idempotency).

## Out of scope

- Daemon-side delivery retry (the arbiter already does this).
- Disk spool / persistence on the sender.
- Aborting the retry loop on `ctx.abort` (possible follow-up; not needed for the
  routine-restart case).

## Deploy caveat

This plugin is loaded by each opencode **serve** (pool 4096–4099). The fix only
takes effect after the serve pool reloads the plugin, which is disruptive and
currently entangled with a separate leak investigation (workstation-lyj0).
Restarting `pigeon-daemon` alone does **not** load this plugin. Land the code;
schedule the serve-pool reload separately.
