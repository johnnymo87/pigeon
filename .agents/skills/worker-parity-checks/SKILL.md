---
name: worker-parity-checks
description: Use when validating deployed worker parity with authenticated checks and an end-to-end notification and reply flow
---

# Worker Parity Checklist

## When To Use

Use this skill after deploys or refactors to confirm endpoint auth, webhook behavior, and reply routing parity. The example script below is the **Telegram** path (shared key, a numeric `chatId`, a simulated Telegram webhook). A machine on Slack has its own end-to-end check, in "Slack Machine" below.

## Prerequisites

Daemon secrets (`CCR_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and on a Slack machine the per-machine `pigeon_worker_key`) are in sops at `/run/secrets/`.
`TELEGRAM_WEBHOOK_SECRET` is a worker-only Cloudflare secret, not in sops. Set it manually before running webhook checks:
```bash
export TELEGRAM_WEBHOOK_SECRET="<value>"
```

## Baseline

```bash
BASE="https://ccr-router.jonathan-mohrbacher.workers.dev"
curl -s "$BASE/health"
curl -s -o /tmp/parity_sessions.json -w "%{http_code}" \
  -H "Authorization: Bearer $(cat /run/secrets/ccr_api_key)" "$BASE/sessions"
```

## Endpoint Auth/Validation

Verify unauthorized behavior:

- `/sessions` with bad bearer -> `401`
- `/notifications/send` with bad bearer -> `401`
- `/notifications/send` missing required fields -> `400`
- webhook with wrong Telegram secret -> `401`
- Slack route `POST /slack/<machine>/events` with no/bad `X-Slack-Signature` -> `401` (machine has a `SLACK_WORKSPACE_<MACHINE>` secret) or `404` (it does not)

## Real Notification + Reply Routing

1. Register a temporary session
2. Send notification to allowed chat ID
3. Capture returned `messageId`
4. Post simulated webhook reply with `reply_to_message.message_id = messageId`
5. Unregister the session

## Example Script

```bash
set -euo pipefail
BASE="https://ccr-router.jonathan-mohrbacher.workers.dev"
AUTH="Authorization: Bearer $(cat /run/secrets/ccr_api_key)"
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
```

## Pass Criteria

- Notification send returns `{ ok: true, messageId, token }`
- Webhook reply returns `ok` (`200`)
- Session is removable (`/sessions/unregister` returns `{ ok: true }`)

## Slack Machine

A Slack machine's end-to-end check is a **channel**, not a topic, and the shared key and the numeric `chatId` above do not apply: the worker resolves the destination itself (the machine's own `slack:<teamId>`, whatever `chatId` was sent), and the shared key never reaches Slack: for a stored `slack:<team>` address it is refused (`chat_not_allowed`), and a worker-resolved `/notifications/send` with the shared key goes down the Telegram path (an allowlisted numeric `chatId`, else `403`; `chat/address.ts` `resolveWorkerTarget`). So every Slack check here must use the MACHINE key (`/run/secrets/pigeon_worker_key` on devbox/cloudbox, Keychain `pigeon-worker-key` on the Mac; `docs/runbooks/per-machine-credentials.md`), not `CCR_API_KEY`.

1. `GET /whoami` with the machine key answers `{"credential":"machine","machine_id":"<m>","transport":"slack"}`. `"credential":"shared"` means you sent the wrong key (it says nothing about the machine's transport); a machine answer with no `transport` field means the worker sees no valid `SLACK_WORKSPACE_<MACHINE>` secret (rolled back to Telegram, or a broken secret).
2. With the machine key, register a temporary session whose `machineId` is that machine (a machine key may only act as itself), then `POST /notifications/send` for it (`chatId` is still a required body field, but any value is ignored for a machine on Slack). The first notification creates a channel named `<title-slug>-<sid8>` in that machine's workspace; the response `messageId` is a handle >= 2^40 (`slack_posts`). Confirm in D1: `topics` has a row with `chat_id = 'slack:<teamId>'` for the session, and `slack_conversations` maps its handle to a channel id.
3. Reply path: a message typed in that channel (or a thread reply under the post) becomes a `commands` row for the session. Slack requests are signed, so this is checked live in Slack rather than simulated with curl; slash commands are typed in the channel (not a thread), and `/kill`, `/interrupt`, `/compact`, `/mcp`, `/model` also work from `#alerts` as `/kill <session-id>`.
4. Unregister the session. Its channel is archived by the nightly orphan-closer (04:00 UTC), not at unregister; remove the test channel by hand if it matters (bots cannot delete channels).

## Question Notification Token Parity

When sending a notification with inline buttons (question notifications), verify the returned `token` matches the daemon's token embedded in the `callback_data`. The worker should extract the token from `cmd:TOKEN:action` in the first button's `callback_data` instead of generating its own.

Test: send a notification with `replyMarkup` containing `cmd:MY_TOKEN:q0` in a button's `callback_data`. The response `token` field must equal `MY_TOKEN`.

## Media Relay Parity

### Upload + Download Round-Trip

```bash
BASE="https://ccr-router.jonathan-mohrbacher.workers.dev"
AUTH="Authorization: Bearer $(cat /run/secrets/ccr_api_key)"
KEY="parity/test-$(date +%s)/hello.txt"

# Upload
echo -n "parity check" > /tmp/parity-media.txt
curl -s -o /tmp/parity_upload.json -X POST -H "$AUTH" \
  "$BASE/media/upload" \
  -F "key=$KEY" -F "mime=text/plain" -F "filename=hello.txt" -F "file=@/tmp/parity-media.txt"
cat /tmp/parity_upload.json

# Download
curl -s -o /tmp/parity-download.txt -H "$AUTH" "$BASE/media/$KEY"
cat /tmp/parity-download.txt
```

Expected: upload returns `{ ok: true, key: "parity/..." }`, download returns the original content.

### Notification with Media

To verify end-to-end media in notifications, send a photo to the Telegram bot as a reply to an active session notification (on Slack: attach an image to a message in the session's channel). The bot should:

1. Detect the photo, relay it to R2
2. Deliver the command (with media) to the daemon via WebSocket
3. Daemon fetches from R2, converts to data URI, delivers to the plugin

## Plugin-Direct Variant

For OpenCode sessions using the direct command channel (`backend_kind: "opencode-plugin-direct"`),
use the daemon parity harness with `PARITY_MODE=direct`:

```bash
cd ~/projects/pigeon/packages/daemon
PARITY_MODE=direct npm run parity:harness
```

This variant:
- Spins up a `startDirectChannelServer`
- Registers the session with `backend_kind`, `backend_protocol_version`, `backend_endpoint`, `backend_auth_token`
- Verifies that webhook reply commands are delivered directly to the plugin server's `onExecute` callback

### Manual Plugin-Direct Registration

To register a plugin-direct session manually via curl:

```bash
curl -s -X POST -H "Authorization: Bearer $(cat /run/secrets/pigeon_daemon_auth_token)" -H "Content-Type: application/json" \
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
For plugin-direct, also run `PARITY_MODE=direct npm run parity:harness` and confirm it passes.
