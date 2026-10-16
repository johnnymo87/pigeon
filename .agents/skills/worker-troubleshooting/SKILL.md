---
name: worker-troubleshooting
description: Use when worker endpoints fail, notifications are not sent, webhook auth breaks, or command routing regresses
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
curl -s -o /tmp/sessions.json -w "%{http_code}" \
  -H "Authorization: Bearer $(cat /run/secrets/ccr_api_key)" \
  "https://ccr-router.jonathan-mohrbacher.workers.dev/sessions"
```

Expected: HTTP `200`.

## Common Failures

- `401` on `/sessions` or `/notifications/send`
    - Wrong/missing CCR_API_KEY
    - Check /run/secrets/ccr_api_key exists and is readable
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
- Confirm machine is polling recently (`machines` table `last_poll_at` within 30s)

## Question Button Callbacks

For question notifications, the daemon embeds its token in button `callback_data` as `cmd:TOKEN:q0`, `cmd:TOKEN:q1`, etc. The worker extracts this token via `extractTokenFromCallbackData()` in `notifications.ts` and stores it in the `messages` table. This ensures button press lookups succeed.

If button presses return "Session expired":
- The stored token doesn't match the callback_data token.
- Verify `extractTokenFromCallbackData()` is parsing the `replyMarkup` correctly.
- Check the `messages` table has the daemon token, not a worker-generated one.

## Verify

```bash
curl -s https://ccr-router.jonathan-mohrbacher.workers.dev/health
```

Expected: `ok`
