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
5. On a Slack machine: `GET /whoami` (`transport`), then the Slack section below

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
  - On Slack: read the response's top-level `errorClass` (`upstream` = bad token/scope or Slack trouble, `conversation_gone`, `rejected_format`, `rate_limited`), and `wrangler tail` for `[worker] slack ...`

## Slack Failures

- `404` on `POST /slack/<machine>/...`: the worker holds no valid `SLACK_WORKSPACE_<MACHINE>` secret for that machine (absent, unparseable or missing a field; the last is logged once as `slack workspace secret ignored`). `GET /whoami` then shows no `transport`.
- `401` on a Slack route: the v0 signature failed against that machine's `signingSecret` (wrong secret in the config, or a clock skew over 5 minutes). `403`: `team_id` or `api_app_id` does not match the secret.
- A message typed in a channel does nothing: only the owner (`ownerUserId`) is heard, bots and message subtypes other than `file_share`/`thread_broadcast` are ignored, and a channel pigeon never addressed has no handle and is ignored. A slash command echo (a message starting with one of the app's commands) is dropped on purpose; slash commands do not work in threads.
- `403 chat_not_allowed` on `/messages/send` with a `slack:<team>` chat id: the shared key is refused for Slack addresses (use a machine key), and another machine's key needs a recent `commands` row for that channel.
- Where the state is: D1 `topics`/`named_topics` rows with `chat_id = 'slack:<teamId>'`, `slack_conversations` (handle to channel id), `slack_posts` (handle to channel + ts, 30 days), `slack_seen_events` (event dedup, 48 h).

## Worker Logs

```bash
cd ~/projects/pigeon/packages/worker
export CLOUDFLARE_API_TOKEN="$(cat /run/secrets/cloudflare_api_token)"
wrangler tail --format=pretty
```

## Command Routing Checks

- Confirm session exists in `/sessions` (response uses `session_id`, `machine_id`)
- Confirm webhook payload has (Telegram):
  - `message.reply_to_message.message_id`, or
  - `/cmd <token> <command>`, or
  - callback data `cmd:<token>:<action>`
- On Slack the session comes from, in order: the thread parent's post (`slack_posts` then `messages`), the channel's `topics` row, a bound named channel. A `block_actions` button's `value` is the same `cmd:<token>:<action>` string
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
