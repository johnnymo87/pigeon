---
name: worker-parity-checks
description: Use when validating deployed worker parity with authenticated checks and an end-to-end notification and reply flow
---

# Worker Parity Checklist

## When To Use

Use this skill after deploys or refactors to confirm endpoint auth, webhook behavior, and reply routing parity.

Run from `~/projects/claude-code-remote` so `op run --env-file=.env.1password` can inject secrets.

## Baseline

```bash
op run --env-file=.env.1password -- sh -c '
  BASE="https://ccr-router.jonathan-mohrbacher.workers.dev"
  curl -s "$BASE/health"
  curl -s -o /tmp/parity_sessions.json -w "%{http_code}" \
    -H "Authorization: Bearer $CCR_API_KEY" "$BASE/sessions"
'
```

## Endpoint Auth/Validation

Verify unauthorized behavior:

- `/sessions` with bad bearer -> `401`
- `/notifications/send` with bad bearer -> `401`
- `/notifications/send` missing required fields -> `400`
- webhook with wrong Telegram secret -> `401`

## Real Notification + Reply Routing

1. Register a temporary session
2. Send notification to allowed chat ID
3. Capture returned `messageId`
4. Post simulated webhook reply with `reply_to_message.message_id = messageId`
5. Unregister the session

## Example Script

```bash
op run --env-file=.env.1password -- bash -lc '
set -euo pipefail
BASE="https://ccr-router.jonathan-mohrbacher.workers.dev"
AUTH="Authorization: Bearer ${CCR_API_KEY}"
CHAT_ID="8248645256"
SID="parity-$(date +%s)"

curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/sessions/register" \
  --data "{\"sessionId\":\"$SID\",\"machineId\":\"devbox-parity\",\"label\":\"Parity\"}"

curl -s -o /tmp/parity_notify.json -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/notifications/send" \
  --data "{\"sessionId\":\"$SID\",\"chatId\":\"$CHAT_ID\",\"text\":\"Parity check\"}"

MSGID=$(python - <<"PY"
import json
print(json.load(open('/tmp/parity_notify.json'))['messageId'])
PY
)

curl -s -X POST -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
  "$BASE/webhook/telegram/parity" \
  --data "{\"update_id\":9101234,\"message\":{\"message_id\":777,\"chat\":{\"id\":$CHAT_ID},\"text\":\"echo parity\",\"reply_to_message\":{\"message_id\":$MSGID}}}"

curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/sessions/unregister" \
  --data "{\"sessionId\":\"$SID\"}"
'
```

## Pass Criteria

- Notification send returns `{ ok: true, messageId, token }`
- Webhook reply returns `ok` (`200`)
- Session is removable (`/sessions/unregister` returns `{ ok: true }`)

## Plugin-Direct Variant

For OpenCode sessions using the direct command channel (`backend_kind: "opencode-plugin-direct"`),
use the daemon parity harness with `PARITY_MODE=direct`:

```bash
op run --env-file=.env.1password -- bash -lc '
  cd ~/projects/pigeon/packages/daemon
  PARITY_MODE=direct bun run parity:harness
'
```

This variant:
- Spins up a `startDirectChannelServer` instead of a tmux session
- Registers the session with `backend_kind`, `backend_protocol_version`, `backend_endpoint`, `backend_auth_token`
- Verifies that webhook reply commands are delivered directly to the plugin server's `onExecute` callback
- Does **not** require tmux to be installed

The legacy (tmux) variant remains the default when `PARITY_MODE` is unset or `"legacy"`.

### Manual Plugin-Direct Registration

To register a plugin-direct session manually via curl:

```bash
curl -s -X POST -H "Content-Type: application/json" \
  "http://127.0.0.1:4731/session-start" \
  --data '{
    "session_id": "direct-parity-test",
    "notify": true,
    "label": "Direct Parity",
    "backend_kind": "opencode-plugin-direct",
    "backend_protocol_version": 1,
    "backend_endpoint": "http://127.0.0.1:PORT/pigeon/direct/execute",
    "backend_auth_token": "YOUR_TOKEN"
  }'
```

## Verify

Run the Example Script and confirm all three pass criteria.
For plugin-direct, also run `PARITY_MODE=direct bun run parity:harness` and confirm it passes.
