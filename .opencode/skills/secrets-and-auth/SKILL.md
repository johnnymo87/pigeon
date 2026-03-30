---
name: secrets-and-auth
description: Use when configuring or troubleshooting secrets, sops injection, and auth boundaries across daemon, worker, and Telegram
---

# Secrets And Auth

## When To Use

Use this for secret setup, auth failures, or token rotation.

## Secret Model

- sops-nix is source-of-truth for Linux machines. macOS uses Keychain. They are decrypted to `/run/secrets/` at boot on Linux.

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
- `ALLOWED_USER_IDS` (optional): comma-separated Telegram user IDs. If set, only these users can interact with the bot within allowed chats. If unset, all users in allowed chats are permitted.
- opencode serve (`http://127.0.0.1:4096`): **no auth** -- localhost-only, single-user machine; password was intentionally removed as marginal security value

## Quick Checks

```bash
cat /run/secrets/ccr_api_key | head -c5 && echo "...ok"
curl -s -o /tmp/sessions.json -w "%{http_code}" -H "Authorization: Bearer $(cat /run/secrets/ccr_api_key)" "https://ccr-router.jonathan-mohrbacher.workers.dev/sessions"
```

## Verify

Expected:

- secret file is readable
- authenticated worker request returns `200`
