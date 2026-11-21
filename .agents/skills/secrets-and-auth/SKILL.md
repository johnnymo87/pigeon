---
name: secrets-and-auth
description: Use when configuring or troubleshooting secrets, sops injection, and auth boundaries across daemon, worker, Slack, and Telegram
---

# Secrets And Auth

## When To Use

Use this for secret setup, auth failures, or token rotation.

## Secret Model

- sops-nix is source-of-truth for Linux machines. macOS uses Keychain. They are decrypted to `/run/secrets/` at boot on Linux.

## Core Secrets

- `CCR_API_KEY` (shared worker key; still accepted, see below)
- `pigeon_worker_key` / Keychain `pigeon-worker-key` (per-machine worker key, once rotated)
- `PIGEON_DAEMON_AUTH_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_CHAT_ID` / `TELEGRAM_GROUP_ID`
- `CLOUDFLARE_API_TOKEN`
- `PIGEON_SLACK_ALARM_WEBHOOK_URL` (daemon env; sops `pigeon_slack_alarm_webhook`, Keychain `pigeon-slack-alarm-webhook` on the Mac): the `#alerts` incoming-webhook URL for the daemon's direct Slack alarm. It is a credential (never print it); anything that is not an `https://hooks.slack.com/...` URL is ignored
- `PIGEON_SLACK_OWNER_USER_ID`, `PIGEON_SLACK_NOTIFY_OWNER` (daemon env, optional): the owner's Slack user id and an `=1` switch for the direct alarm's owner mention (off by default)
- `SLACK_WORKSPACE_<MACHINE>` (a **worker** secret, one per machine, machine id upper-cased with `-` as `_`): JSON `{teamId, appId, domain, botToken, userToken, signingSecret, ownerUserId}`. Its presence is what puts that machine on Slack. Staged in workstation sops `secrets/devbox.yaml` as `pigeon_slack_workspace_<machine>` and put into the worker only by `packages/worker/scripts/slack-flip.mjs` (never printed; `node packages/worker/scripts/slack-manifest.mjs check-config <file>` checks a staged file's shape). Setup: `docs/runbooks/slack-workspace-setup.md`

## Auth Boundaries

- worker API routes require a bearer that is either the shared `CCR_API_KEY` or a **per-machine key** (`pgk_...`, pigeon-k0qn.8). Per-machine keys are stored hashed in D1 `machine_credentials`; with one, poll, command ack, session register and unregister refuse to act as any other machine. The shared key keeps last-registrant-wins behaviour until it is retired per machine via the worker var `SHARED_KEY_REFUSED_MACHINES`. The cross-machine swarm relay routes (`/swarm/relay`, `/ack`, `/fail`) and `GET /sessions/remote` accept only per-machine keys (401 `machine_credential_required` for the shared key), and a machine can receive relays only once it is retired from the shared key (see `swarm-architecture` → Cross-Machine Relay).
- `GET /whoami` on the worker says which principal a key resolves to; the daemon logs it at startup as `[worker-identity] ...`
- daemon poller authenticates via `Authorization: Bearer $CCR_API_KEY`; the daemon's start script decides whether that variable holds the shared key or the machine key
- Minting, registering, rotating, revoking and retiring: **`docs/runbooks/per-machine-credentials.md`**. Never print a key; `packages/worker/scripts/machine-key.mjs` writes keys to a 0600 file and prints only the hash.
- daemon API routes (`http://127.0.0.1:4731`): require `Authorization: Bearer <PIGEON_DAEMON_AUTH_TOKEN>` when `PIGEON_DAEMON_AUTH_TOKEN` is set, EXCEPT `GET /health` which remains anonymous by design
- Telegram webhook requires `X-Telegram-Bot-Api-Secret-Token`
- Slack routes (`POST /slack/<machine>/{events,commands,interactivity}`) take no bearer: the v0 `X-Slack-Signature` is checked on the raw body against that machine's `signingSecret` (+-5 min, else 401), then `team_id`/`api_app_id` against the same secret (403), then the sender must be `ownerUserId` (anyone else is dropped with a silent 200). A machine with no valid `SLACK_WORKSPACE_<MACHINE>` secret gets 404. A `slack:<teamId>` chat address needs a machine key (the shared key is refused); another machine's key is honoured for a stored Slack address only with a recent `commands` row for that channel addressed to it
- `ALLOWED_USER_IDS` (optional): comma-separated Telegram user IDs. If set, only these users can interact with the bot within allowed chats. If unset, all users in allowed chats are permitted. It does not apply to Slack, where the single allowed sender is the workspace secret's `ownerUserId`, and `ALLOWED_CHAT_IDS` does not govern `slack:` addresses either.
- Daemon `PIGEON_PULL_ALLOWED_USER_IDS` (comma list) is compared with each inbound message's `senderId`, which on Slack is the Slack user id: for a machine on Slack it must contain the owner's Slack user id (`ownerUserId`), or goose-pull banking and topic/channel-bound goose sessions refuse the owner's replies. Empty means nobody for those sessions.
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
