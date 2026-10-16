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
- `PIGEON_DAEMON_AUTH_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_CHAT_ID` / `TELEGRAM_GROUP_ID`
- `CLOUDFLARE_API_TOKEN`

## Auth Boundaries

- worker API routes require bearer `CCR_API_KEY` (poll, ack, sessions, notifications, media)
- daemon poller authenticates via `Authorization: Bearer CCR_API_KEY` header
- daemon API routes (`http://127.0.0.1:4731`): require `Authorization: Bearer <PIGEON_DAEMON_AUTH_TOKEN>` when `PIGEON_DAEMON_AUTH_TOKEN` is set, EXCEPT `GET /health` which remains anonymous by design
- Telegram webhook requires `X-Telegram-Bot-Api-Secret-Token`
- `ALLOWED_USER_IDS` (optional): comma-separated Telegram user IDs. If set, only these users can interact with the bot within allowed chats. If unset, all users in allowed chats are permitted.
- opencode serve (`http://127.0.0.1:4096`): **no auth** -- localhost-only, single-user machine; password was intentionally removed as marginal security value

## Calling the Daemon

When `PIGEON_DAEMON_AUTH_TOKEN` is set (e.g. on cloudbox), daemon routes except `/health` require bearer auth. The secret is deployed to `/run/secrets/pigeon_daemon_auth_token` (dev-readable, mode 0400, no sudo needed).

```bash
# Health check (anonymous by design):
curl -s http://127.0.0.1:4731/health

# Authenticated daemon request:
curl -s -H "Authorization: Bearer $(cat /run/secrets/pigeon_daemon_auth_token)" http://127.0.0.1:4731/sessions
```

On hosts without `/run/secrets/pigeon_daemon_auth_token` (e.g., devbox/macOS back-compat), daemon auth is disabled; passing the header is harmless and unnecessary.

## Quick Checks

```bash
cat /run/secrets/ccr_api_key | head -c5 && echo "...ok"
curl -s -o /tmp/sessions.json -w "%{http_code}" -H "Authorization: Bearer $(cat /run/secrets/ccr_api_key)" "https://ccr-router.jonathan-mohrbacher.workers.dev/sessions"
curl -s -o /tmp/daemon_sessions.json -w "%{http_code}" -H "Authorization: Bearer $(cat /run/secrets/pigeon_daemon_auth_token)" "http://127.0.0.1:4731/sessions"
```

## Verify

Expected:

- secret file is readable
- authenticated worker request returns `200`
- authenticated daemon request returns `200`
