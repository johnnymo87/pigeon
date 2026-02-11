---
name: worker-parity-checks
description: Use when validating deployed worker parity through authenticated endpoint checks and a notification-plus-reply flow
---

# Worker Parity Checklist

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
