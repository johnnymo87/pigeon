---
name: secrets-and-auth
description: Use when configuring or troubleshooting secrets, 1Password injection, and auth boundaries across daemon, worker, and Telegram
---

# Secrets And Auth

## When To Use

Use this for secret setup, auth failures, or token rotation.

## Secret Model

- 1Password is source-of-truth for app secrets.
- Devbox bootstrap secret is `/run/secrets/op_service_account_token`.
- Use `op run --env-file=/home/dev/projects/pigeon/.env.1password -- ...` for runtime injection.

## Core Secrets

- `CCR_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_CHAT_ID` / `TELEGRAM_GROUP_ID`
- `CLOUDFLARE_API_TOKEN`

## Auth Boundaries

- worker API routes require bearer `CCR_API_KEY` (poll, ack, sessions, notifications, media)
- daemon poller authenticates via `Authorization: Bearer CCR_API_KEY` header
- Telegram webhook requires `X-Telegram-Bot-Api-Secret-Token`
- opencode serve (`http://127.0.0.1:4096`): **no auth** -- localhost-only, single-user machine; password was intentionally removed as marginal security value

## Quick Checks

```bash
cd ~/projects/pigeon
op run --env-file=.env.1password -- sh -c 'echo ${CCR_API_KEY:+ok}'
op run --env-file=.env.1password -- sh -c 'curl -s -o /tmp/sessions.json -w "%{http_code}" -H "Authorization: Bearer $CCR_API_KEY" "https://ccr-router.jonathan-mohrbacher.workers.dev/sessions"'
```

## Verify

Expected:

- key injection works in non-interactive shell
- authenticated worker request returns `200`
