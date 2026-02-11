---
name: hooks-session-lifecycle
description: Use when configuring or debugging Claude hook behavior and session start-stop lifecycle integration with Pigeon daemon
---

# Hooks And Session Lifecycle

## When To Use

Use this when hook-driven session registration or stop notifications fail.

## Lifecycle

1. Session start hook triggers daemon `/session-start`.
2. Session stop/idle flow triggers daemon `/stop`.
3. Daemon notification path emits Telegram message and reply token.
4. Worker routes replies/callbacks back to machine agent command ingest.

## Hook Debugging

Check runtime probes/logs:

```bash
ls -la ~/.claude/runtime/hook-debug/
```

Look for missing checkpoints in session-start or stop path.

## Daemon Route Checks

```bash
curl -s -X POST -H "Content-Type: application/json" http://127.0.0.1:4731/session-start --data '{"session_id":"hook-smoke","notify":false}'
curl -s -X POST -H "Content-Type: application/json" http://127.0.0.1:4731/stop --data '{"session_id":"hook-smoke","event":"Stop","message":"smoke"}'
curl -s -X DELETE http://127.0.0.1:4731/sessions/hook-smoke
```

## Common Failure Points

- missing hook install/config
- malformed hook payload fields (`session_id` required)
- daemon service unavailable
- missing notifier config causing `notified=false`

## Verify

Expected:

- `/session-start` returns `{ok:true}`
- `/stop` returns `ok` and expected notification behavior
