---
name: worker-troubleshooting
description: Use when worker endpoints fail, Telegram notifications do not send, or command routing is broken
---

# Troubleshooting Pigeon Worker

## When To Use

Use this skill for diagnosing regressions in auth, notifications, webhook processing, or command delivery.

## Fast Triage

1. Health check
2. Auth check (`CCR_API_KEY`)
3. Webhook secret check
4. Logs (`wrangler tail`)

## Health + Auth

```bash
curl -s https://ccr-router.jonathan-mohrbacher.workers.dev/health
```

Authenticated endpoint check:

```bash
cd ~/projects/claude-code-remote
op run --env-file=.env.1password -- sh -c '
  curl -s -o /tmp/sessions.json -w "%{http_code}" \
    -H "Authorization: Bearer $CCR_API_KEY" \
    "https://ccr-router.jonathan-mohrbacher.workers.dev/sessions"
'
```

Expected: HTTP `200`.

## Common Failures

- `401` on `/sessions` or `/notifications/send`
  - Wrong/missing `CCR_API_KEY`
  - Check `.env.1password` mapping in `~/projects/claude-code-remote`
- `401 Unauthorized` on webhook route
  - `X-Telegram-Bot-Api-Secret-Token` mismatch
- Notification send fails
  - Bot token issue or Telegram API error
  - Validate with a real `/notifications/send` call to allowed chat

## Worker Logs

```bash
cd ~/projects/pigeon/packages/worker
export CLOUDFLARE_API_TOKEN="$(cat /run/secrets/cloudflare_api_token)"
wrangler tail --format=pretty
```

## Command Routing Checks

- Confirm session exists in `/sessions` (response uses `session_id`, `machine_id`)
- Confirm webhook payload has:
  - `message.reply_to_message.message_id`, or
  - `/cmd <token> <command>`, or
  - callback data `cmd:<token>:<action>`
- Confirm machine agent connects to `/ws?machineId=<id>` with protocol `ccr,<CCR_API_KEY>`

## Durable Object Mismatch on Deploy

If deploy fails with DO class mismatch, verify:

- `wrangler.toml` uses `RouterDO`
- `src/index.ts` exports `RouterDO`

## Verify

```bash
curl -s https://ccr-router.jonathan-mohrbacher.workers.dev/health
```

Expected: `ok`
