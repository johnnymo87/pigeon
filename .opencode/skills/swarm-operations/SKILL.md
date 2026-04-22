---
name: swarm-operations
description: Use for day-to-day swarm IPC ops — health checks, inspecting queued/handed-off/failed messages, debugging stuck deliveries, force-failing retry loops, tailing arbiter logs
---

# Swarm IPC Operations

## When To Use

Use this for day-to-day swarm ops: health-check the routes, inspect the inbox, see what's queued, debug stuck deliveries, force-fail a runaway retry loop, or tail arbiter logs.

## Health Checks

```bash
# Daemon up + swarm routes responding
curl -s http://127.0.0.1:4731/health
curl -s -X POST http://127.0.0.1:4731/swarm/send \
  -H 'content-type: application/json' -d '{}'
# expect 400 {"error":"from is required"}, NOT 404 — proves /swarm/send route exists
curl -s 'http://127.0.0.1:4731/swarm/inbox?session=does_not_exist'
# expect {"messages":[]}
```

Boot log to confirm arbiter started:

```bash
journalctl -u pigeon-daemon --no-pager -n 50 | grep '\[pigeon-daemon\]'
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
curl -s 'http://127.0.0.1:4731/swarm/inbox?session=ses_X' | jq .
curl -s 'http://127.0.0.1:4731/swarm/inbox?session=ses_X&since=msg_abc' | jq .
```

## Reading The Arbiter Log

The arbiter logs every dispatch attempt:

```bash
journalctl -u pigeon-daemon --no-pager --since '5 minutes ago' \
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
journalctl -u pigeon-daemon --no-pager --since '2 minutes ago' -o short-precise \
  | grep swarm-arbiter
```

If you ever see two `delivered` events for the same target with timestamps closer together than the actual `prompt_async` round-trip, the at-most-one-in-flight invariant is broken — file an issue and check `arbiter.ts:inflight`.

## Common Failure Modes

### "swarm arbiter NOT started" at boot

Cause: daemon config lacks `opencodeUrl`. The routes still accept POSTs but messages will queue forever.

Fix: set `opencodeUrl` in the daemon config and restart.

### Repeated `retry scheduled` with `session lookup failed: 404`

Cause: target session doesn't exist in opencode serve (probably never existed, or was killed).

Verify:

```bash
curl -s "http://127.0.0.1:4096/session/ses_X" | jq .
# 404 confirms it
```

If the target session was supposed to exist, check that opencode serve is up and the session id is correct. If the target was killed and the messages should be discarded, force-fail (below).

### Repeated `retry scheduled` with prefill 400

Cause: opencode serve race somehow re-emerged. This should be impossible for daemon-routed traffic (the arbiter ensures single-writer per target). If it happens, suspect:
- Someone is calling `prompt_async` from outside the daemon at the same time (e.g. an `opencode-send --direct ses_X` race).
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
journalctl -u pigeon-daemon --no-pager --since '30 seconds ago' \
  | grep -E 'swarm arbiter|listening on'
# expect both:
#   "[pigeon-daemon] swarm arbiter started (interval=500ms)"
#   "[pigeon-daemon] listening on http://127.0.0.1:4731"
```

## Sender Smoke Test

End-to-end smoke from a shell:

```bash
SENTINEL="OPS-SMOKE-$(uuidgen | head -c 8)"
~/.local/bin/pigeon-send --from ses_ops_smoke ses_target "$SENTINEL: hello"
# expect: "Queued msg_... -> ses_target ..."

# Wait one arbiter tick, then:
curl -s 'http://127.0.0.1:4731/swarm/inbox?session=ses_target' \
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
curl -s 'http://127.0.0.1:4731/swarm/inbox?session=ops-smoke' | jq .
journalctl -u pigeon-daemon --no-pager -n 30 | grep -E 'swarm arbiter|listening on'
```

Expected:

- daemon health 200
- inbox returns `{"messages":[]}` JSON shape
- boot log shows arbiter started and HTTP listener bound
