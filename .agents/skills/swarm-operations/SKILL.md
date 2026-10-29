---
name: swarm-operations
description: Use for day-to-day swarm IPC ops — health checks, inspecting queued/handed-off/failed messages, debugging stuck deliveries, force-failing retry loops, tailing arbiter logs, and checking or debugging the cross-machine relay
---

# Swarm IPC Operations

## When To Use

Use this for day-to-day swarm ops: health-check the routes, inspect the inbox, see what's queued, debug stuck deliveries, force-fail a runaway retry loop, or tail arbiter logs.

## Health Checks

```bash
# Daemon up + swarm routes responding
curl -s http://127.0.0.1:4731/health
curl -s -X POST http://127.0.0.1:4731/swarm/send \
  -H "Authorization: Bearer $(cat /run/secrets/pigeon_daemon_auth_token)" \
  -H 'content-type: application/json' -d '{}'
# expect 400 {"error":"from is required"}, NOT 404 — proves /swarm/send route exists
curl -s -H "Authorization: Bearer $(cat /run/secrets/pigeon_daemon_auth_token)" 'http://127.0.0.1:4731/swarm/inbox?session=does_not_exist'
# expect {"messages":[]}
```

Boot log to confirm arbiter started:

```bash
journalctl --namespace=pigeon -u pigeon-daemon --no-pager -n 50 | grep '\[pigeon-daemon\]'
# expect: "[pigeon-daemon] swarm arbiter started (interval=500ms)"
# OR:     "[pigeon-daemon] swarm arbiter NOT started (no opencodeUrl in config)"
#         (the latter means swarm sends will queue forever — fix config)
```

## Inspecting Messages

The HTTP inbox returns ONLY `handed_off` (delivered) messages. To see queued/failed messages, query SQLite directly.

```bash
# All swarm messages for a target
nix-shell -p sqlite --run \
  "sqlite3 -readonly ~/projects/pigeon/packages/daemon/data/pigeon-daemon.db \
   \"SELECT msg_id, state, attempts, datetime(created_at/1000,'unixepoch') AS created \
     FROM swarm_messages WHERE to_session='ses_X' ORDER BY created_at DESC LIMIT 20;\""

# Stuck-in-queued messages (arbiter is failing to deliver)
nix-shell -p sqlite --run \
  "sqlite3 -readonly ~/projects/pigeon/packages/daemon/data/pigeon-daemon.db \
   \"SELECT msg_id, to_session, attempts, datetime(next_retry_at/1000,'unixepoch') AS retry_at \
     FROM swarm_messages WHERE state='queued' ORDER BY next_retry_at LIMIT 20;\""

# All failed messages (terminal — exhausted retries)
nix-shell -p sqlite --run \
  "sqlite3 -readonly ~/projects/pigeon/packages/daemon/data/pigeon-daemon.db \
   \"SELECT msg_id, from_session, to_session, attempts, datetime(updated_at/1000,'unixepoch') \
     FROM swarm_messages WHERE state='failed' ORDER BY updated_at DESC LIMIT 20;\""
```

The inbox HTTP view (for verifying what a target session has actually received):

```bash
curl -s -H "Authorization: Bearer $(cat /run/secrets/pigeon_daemon_auth_token)" 'http://127.0.0.1:4731/swarm/inbox?session=ses_X' | jq .
curl -s -H "Authorization: Bearer $(cat /run/secrets/pigeon_daemon_auth_token)" 'http://127.0.0.1:4731/swarm/inbox?session=ses_X&since=msg_abc' | jq .
```

## Reading The Arbiter Log

The arbiter logs every dispatch attempt:

```bash
journalctl --namespace=pigeon -u pigeon-daemon --no-pager --since '5 minutes ago' \
  | grep '\[swarm-arbiter\]'
```

Three event types:

| Log line | Meaning |
|---|---|
| `[swarm-arbiter] delivered {"msgId":"...","target":"..."}` | `prompt_async` returned 2xx; `state` flipped to `handed_off`. |
| `[swarm-arbiter] retry scheduled {"msgId":"...","attempts":N,"error":"..."}` | Delivery failed; arbiter incremented `attempts` and set `next_retry_at` per the backoff schedule `[1s, 2s, 5s, 15s, 60s]`. |
| `[swarm-arbiter] failed (max attempts) {"msgId":"...","error":"..."}` | Hit `MAX_ATTEMPTS=10`; `state` flipped to `failed` (terminal). |

For high-precision timing (arbiter runs at 500ms intervals — useful for proving serialization):

```bash
journalctl --namespace=pigeon -u pigeon-daemon --no-pager --since '2 minutes ago' -o short-precise \
  | grep swarm-arbiter
```

If you ever see two `delivered` events for the same target with timestamps closer together than the actual `prompt_async` round-trip, the at-most-one-in-flight invariant is broken — file an issue and check `arbiter.ts:inflight`.

## Tracing Telegram Swarm Posts

Swarm IPC messages are mirrored to the **receiver's** Telegram topic at insert time. Post delivery is best-effort via the daemon's outbox and independent of swarm IPC arbiter delivery — a missing or backlogged Telegram post does **not** mean the swarm message itself failed to reach the target's transcript.

### Outbox Querying

Swarm Telegram notifications use `notification_id` prefixes:
- `w:<msg_id>` — original swarm post notice
- `wc:<msg_id>` — cancellation retraction notice (`🚫 cancelled <msg_id>`)
- Multi-chunk posts suffix earlier chunks via `chunkNotificationId` (`w:<msg_id>:c0`, etc.)

Query outbox state for a given `msg_id`:

```bash
nix-shell -p sqlite --run \
  "sqlite3 -readonly ~/projects/pigeon/packages/daemon/data/pigeon-daemon.db \
   \"SELECT notification_id, kind, state, attempts, datetime(created_at/1000,'unixepoch') \
     FROM outbox WHERE notification_id LIKE 'w%:<msg_id>%' ORDER BY created_at DESC;\""
```

Outbox rows use `kind='swarm'` (24h TTL).

### Sub-Budget Deferral Logs

Swarm posts are rate-governed (`SWARM_SUB_BUDGET = 6` of the outbox governor's 12 sends/60s ceiling across `swarm`+`mirror` kinds) so swarm bursts cannot starve questions/stops or trigger Telegram topic rate limits (429s).

When the sub-budget is exhausted, the outbox sender logs a once-per-tick debug/info line:

```bash
journalctl --namespace=pigeon -u pigeon-daemon --no-pager --since '10 minutes ago' \
  | grep 'outbox sub-budget reached'
```

Deferring one low-priority entry also defers that session's subsequent entries to preserve per-session delivery order.

## Common Failure Modes

### "swarm arbiter NOT started" at boot

Cause: daemon config lacks `opencodeUrl`. The routes still accept POSTs but messages will queue forever.

Fix: set `opencodeUrl` in the daemon config and restart.

### Repeated `retry scheduled` with `session lookup failed: 404`

Since `pigeon-k0qn.2` a target with no local `sessions` row that every serve 404s fails at once (above). This retry loop is what remains: a target that still has a local `sessions` row (the locality check trusts the row and does not probe) but whose opencode session was deleted.

Cause: target session doesn't exist in opencode serve (probably never existed, or was killed).

Verify:

```bash
curl -s "http://127.0.0.1:4096/session/ses_X" | jq .
# 404 confirms it
```

If the target session was supposed to exist, check that opencode serve is up and the session id is correct. If the target was killed and the messages should be discarded, force-fail (below).

### `failed (permanent)` with `is not on this machine`

Cause: the target is not a session on this machine (`pigeon-k0qn`). The locality check got a 404 from the serve (or the target is a `gse_` id with no local row), so the row failed on its first attempt and the sender got a `delivery.failed`. If the worker knew the owner, the reason names it (`registered to cloudbox (last active …)`). With the relay off on this machine (`PIGEON_SWARM_RELAY_SEND` unset, the default) this is the intended outcome, not a fault. With it on, only rows the relay cannot carry end here: a `pigeon` or goose sender, a `gse_` target, or a row that itself arrived by relay (the text then says "relayed messages are never relayed again"). See "Cross-Machine Relay" below.

If the target *should* be local, check the id, then `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4096/session/ses_X`. A 404 there means no serve on this machine has the session.

### Repeated `retry scheduled` with `locality unknown`

Cause: no serve answered the read-only session lookup with 200 or 404 (all down, 5xx, or timing out). Treated as an outage and retried; it is never turned into a remote verdict. Check the serves' `/global/health`.

### Repeated `retry scheduled` with prefill 400

Cause: opencode serve race somehow re-emerged. This should be impossible for daemon-routed traffic (the arbiter ensures single-writer per target). If it happens, suspect:
- Someone is calling `prompt_async` from outside the daemon at the same time (a script POSTing to a serve directly).
- The `inflight` map was bypassed by a code change.

Check:

```bash
# Are there other clients hitting opencode serve?
ss -tnp | grep ':4096'
# Stop suspect senders, then watch for the prefill 400 to clear
```

### Inbox returns nothing but you know a message was sent

Causes (in order of likelihood):
1. Message is still `queued` (arbiter hasn't delivered yet — wait 500ms-1s).
2. Message `failed` (exhausted retries — check the SQLite query above).
3. Wrong `session` query param.

The HTTP inbox only returns `handed_off`. Use the SQLite query to see all states.

### Daemon DB grows unbounded

`SwarmRepository.cleanupOlderThan(beforeMs)` exists but is **not currently scheduled**. (As of this writing the daemon doesn't have a swarm cleanup tick — only the outbox cleanup runs.) If retention becomes a problem:

- Manually: `nix-shell -p sqlite --run "sqlite3 ~/.../pigeon-daemon.db 'DELETE FROM swarm_messages WHERE state IN (\"handed_off\",\"failed\") AND updated_at < <timestamp>;'"`
- Long-term: schedule `cleanupOlderThan` in `index.ts` alongside the outbox cleanup (every hour, 7d retention).

## Cross-Machine Relay

Mechanics are in `swarm-architecture` → "Cross-Machine Relay". Both halves are off unless the `pigeon-daemon` service sets `PIGEON_SWARM_RELAY_SEND=1` (send) or `PIGEON_SWARM_RELAY_ACCEPT_FROM=<machine,…>` (receive). The env comes from the workstation repo's host configuration. No machine sets either yet; enabling them is `pigeon-k0qn.11`.

### Is it on here?

```bash
journalctl --namespace=pigeon -u pigeon-daemon --no-pager --since today | grep '\[relay\] accept_from='
# "[relay] accept_from=cloudbox send=on". No line at all since the last boot means both are off.
```

What this machine's sessions would get from `swarm_send` to each other machine right now:

```bash
curl -s -H "Authorization: Bearer $(cat /run/secrets/pigeon_daemon_auth_token)" \
  'http://127.0.0.1:4731/swarm/remote-sessions?limit=5' | jq '{relay_send, machines}'
# relay_send: this daemon's PIGEON_SWARM_RELAY_SEND.
# machines[].relay: available | not_accepted | not_retired | offline | unknown
#   not_retired = that machine is not in the worker's SHARED_KEY_REFUSED_MACHINES yet
#   unknown     = the worker's relay tables are not applied
# 503 no_worker / 502 worker_error / 502 worker_unreachable: the daemon could not ask the worker.
# A 401 machine_credential_required inside worker_error: this daemon polls with the shared key, not a pgk_ key.
```

This is the same data agents get from `swarm_list remote: true`.

### Inspecting relayed rows

On the **sender**, a relayed row is `handed_off` with `verify_family='relayed'`. That means the worker stored it, not that the target read it:

```bash
nix-shell -p sqlite --run \
  "sqlite3 -readonly ~/projects/pigeon/packages/daemon/data/pigeon-daemon.db \
   \"SELECT msg_id, to_session, state, datetime(handed_off_at/1000,'unixepoch') \
     FROM swarm_messages WHERE verify_family='relayed' ORDER BY updated_at DESC LIMIT 20;\""
```

On the **receiver**, `swarm_relay_inbound` records every `msg_id` that arrived by relay. The message itself is an ordinary `swarm_messages` or `pull_inbox` row with the same `msg_id`. A non-null `fail_reason` means it failed here and is owed back to the sender. `fail_done_at` is set once reported, or once reporting was given up:

```bash
nix-shell -p sqlite --run \
  "sqlite3 -readonly ~/projects/pigeon/packages/daemon/data/pigeon-daemon.db \
   \"SELECT msg_id, from_machine, from_session, to_session, fail_reason, fail_attempts, \
            datetime(received_at/1000,'unixepoch'), datetime(fail_done_at/1000,'unixepoch') \
     FROM swarm_relay_inbound ORDER BY received_at DESC LIMIT 20;\""
```

### Log lines

```bash
journalctl --namespace=pigeon -u pigeon-daemon --no-pager --since '1 hour ago' \
  | grep -E '\[relay|\[swarm-arbiter\] (relay|retry scheduled.*relay)|\[poller\] relay|ownership refresh'
```

| Log line | Meaning |
|---|---|
| `[swarm-arbiter] relayed {msgId, target, toMachine, duplicate, marked}` | The worker took it (202). `duplicate: true` means an earlier identical attempt was already stored |
| `[swarm-arbiter] retry scheduled {… "error":"… relay of <msg> to <target> not accepted yet: worker answered 503 target_offline …"}` | Owner not polling (asleep or down); retried like an outage. `429 queue_full`, `503 relay_unavailable` and 5xx look the same. A row with `expires_at` logs `retry scheduled (uncounted)` instead |
| `[swarm-arbiter] relay refused (<code>) …` | Logged only for `same_machine`, `sender_not_yours` and `invalid`: two of our own views disagree with D1 or the worker's validator. Investigate; do not just resend |
| `[relay-receiver] received {msgId, fromMachine, to}` | Inserted here and acked `delivered` |
| `[relay-receiver] refused {msgId, fromMachine, reason}` | Acked `refused`; the sender gets a `delivery.failed` for `reason` |
| `[relay-receiver] item left unacked after an error …` | A transient local error; the worker re-offers it after the 60s lease |
| `[relay-receiver] relay failed at the receiver {msgId, machine, reason}` | (On the sender) a failure item matched a row we relayed; the sender was notified |
| `[relay-receiver] failure item matches no relay of ours; dropped` | A failure item for a row this machine did not relay; acked `no_matching_relay` |
| `[relay-fail] reported <msg> to <machine> (<reason>)` | A late failure of a relayed-in row went back to the worker |
| `[relay-fail] … its sender will not be told` | The worker no longer has the row (more than 7 days) or refused the report. Final |
| `[poller] relay items failed: …` | The relay callback threw. The poll's command still dispatched; unacked items will be re-offered |
| `[reaper] ownership refresh: <id> is registered to another machine: …` (with an alert) | Another machine holds a session this daemon runs. Relays to it go to that machine |

### Failure modes

- **Every cross-machine send fails at once with "Cross-machine swarm delivery is not supported".** Sending is off here. Expected until `pigeon-k0qn.11`.
- **`delivery.failed` saying the owner "cannot receive cross-machine messages yet (it still accepts the shared worker key)".** That is `receiver_not_retired`: add the owner to the worker's `SHARED_KEY_REFUSED_MACHINES` (`docs/runbooks/per-machine-credentials.md`).
- **"does not accept cross-machine messages from this machine".** That is `not_accepted`: the owner's `PIGEON_SWARM_RELAY_ACCEPT_FROM` lacks this machine, or its daemon is rolled back or polls without the header. The worker clears a machine's accept set on a header-less poll.
- **"the worker has no machine registered for it".** That is `unknown_session`: the target never registered (a subagent), or its daemon unregistered it after 7 idle days.
- **A send retries for ~15 minutes, then reports NOT received.** The owner was `offline` the whole time. For a scheduled row, retries continue until `expires_at`.
- **The sender heard nothing, but the receiver logged `received`.** The receiver's local delivery is stuck in a watchdog non-terminal state (blocked behind a turn, silent in flight). Relayed senders are verified at handoff, so nothing reports this (spec §7). Inspect the row on the receiver like any local row.

## Force-Failing A Stuck Retry Loop

If a target is unreachable and you want to stop the arbiter from retrying (e.g. test detritus targeting `ses_throwaway_smoke`):

```bash
nix-shell -p sqlite --run \
  "sqlite3 ~/projects/pigeon/packages/daemon/data/pigeon-daemon.db \
   \"UPDATE swarm_messages SET state='failed', next_retry_at=NULL, \
     updated_at=strftime('%s','now')*1000 \
     WHERE to_session='ses_throwaway_smoke' AND state='queued';\""
```

The arbiter picks up state changes on its next tick — no daemon restart needed.

## Restart Procedure

The arbiter's per-process `inflight` map is lost on restart, but the next tick resumes draining from the persisted SQLite state. No data loss, no duplicate deliveries (because `markHandedOff` is atomic and only happens after `prompt_async` returns 2xx).

```bash
sudo systemctl restart pigeon-daemon.service
journalctl --namespace=pigeon -u pigeon-daemon --no-pager --since '30 seconds ago' \
  | grep -E 'swarm arbiter|listening on'
# expect both:
#   "[pigeon-daemon] swarm arbiter started (interval=500ms)"
#   "[pigeon-daemon] listening on http://127.0.0.1:4731"
```

## Sender Smoke Test

End-to-end smoke from a shell:

```bash
SENTINEL="OPS-SMOKE-$(uuidgen | head -c 8)"
curl -s -X POST -H 'content-type: application/json' \
  -H "Authorization: Bearer $(cat /run/secrets/pigeon_daemon_auth_token)" \
  http://127.0.0.1:4731/swarm/send \
  -d "{\"from\":\"ses_ops_smoke\",\"to\":\"ses_target\",\"payload\":\"$SENTINEL: hello\"}"
# expect: {"accepted":true,"msg_id":"msg_..."}

# Wait one arbiter tick, then:
curl -s -H "Authorization: Bearer $(cat /run/secrets/pigeon_daemon_auth_token)" 'http://127.0.0.1:4731/swarm/inbox?session=ses_target' \
  | jq ".messages[] | select(.payload | contains(\"$SENTINEL\"))"
# expect the message back, with handed_off_at set
```

If the target session is real, `oc-search --types text "$SENTINEL"` will find the envelope landed in the target's transcript:

```bash
oc-search --types text "$SENTINEL"
# expect a row showing the target session id and a match count
```

For the raw envelope as it appears in the target's transcript:

```bash
nix-shell -p sqlite --run \
  "sqlite3 -readonly ~/.local/share/opencode/opencode.db \
   \"SELECT substr(p.data, 1, 800) FROM part p \
     JOIN message m ON p.message_id = m.id \
     WHERE m.session_id='ses_target' AND p.data LIKE '%$SENTINEL%' \
     ORDER BY p.id DESC LIMIT 1;\""
# expect a JSON blob containing <swarm_message v=\"1\" ... >$SENTINEL: hello</swarm_message>
```

## Verify

```bash
curl -s http://127.0.0.1:4731/health
curl -s -H "Authorization: Bearer $(cat /run/secrets/pigeon_daemon_auth_token)" 'http://127.0.0.1:4731/swarm/inbox?session=ops-smoke' | jq .
journalctl --namespace=pigeon -u pigeon-daemon --no-pager -n 30 | grep -E 'swarm arbiter|listening on'
```

Expected:

- daemon health 200
- inbox returns `{"messages":[]}` JSON shape
- boot log shows arbiter started and HTTP listener bound
