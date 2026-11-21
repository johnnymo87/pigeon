---
name: worker-deployment
description: Use when deploying or updating the worker on Cloudflare and validating production health and auth behavior
---

# Deploying the Pigeon Worker

## When To Use

Use this skill when releasing worker changes or validating production deploy safety.

## Prereqs

- Repo: `~/projects/pigeon`
- Package: `packages/worker`
- Cloudflare token in env (`CLOUDFLARE_API_TOKEN`)

On devbox, prefer:

```bash
export CLOUDFLARE_API_TOKEN="$(cat /run/secrets/cloudflare_api_token)"
```

## Deploy

> **⚠️ WARNING: The `[vars]` Deploy-Revert Trap**
>
> `ALLOWED_CHAT_IDS` and `TELEGRAM_TOPICS_ENABLED` live in `[vars]` in `packages/worker/wrangler.toml`.
> **Running `wrangler deploy` re-asserts `[vars]` from `wrangler.toml`**, silently overwriting any variables modified directly in the Cloudflare Dashboard UI.
>
> To update worker environment variables, edit `wrangler.toml` directly, preview with `npm run --workspace @pigeon/worker deploy -- --dry-run`, and then deploy.
>
> Slack config is **not** in `[vars]`: each machine's workspace is a worker *secret* `SLACK_WORKSPACE_<MACHINE>` (JSON `{teamId, appId, domain, botToken, userToken, signingSecret, ownerUserId}`), put only by `packages/worker/scripts/slack-flip.mjs <machine> on` (never by hand, never at deploy: putting it is what flips the machine to Slack). `SLACK_NOTIFY_OWNER` (owner @-mention categories, unset = no pushes) and `SLACK_MARKDOWN_BLOCKS` (`off` = no Slack markdown blocks) are optional and deliberately not in `wrangler.toml`; `keep_vars = true` keeps what is deployed. **Apply `d1-schema.sql` (the `slack_conversations`, `slack_posts`, `slack_seen_events` tables) before any such secret exists.**

```bash
cd ~/projects/pigeon
npm run --workspace @pigeon/worker deploy
```

## Chat Transport Runbooks

- Telegram Forum Topics (historical: no machine uses Telegram since 2026-11-21; the rollback path until `pigeon-4ogz.13`): `docs/runbooks/telegram-forum-migration.md`
- Slack workspace and app setup for a machine, and the flip (`slack-flip.mjs`): `docs/runbooks/slack-workspace-setup.md`

## R2 Bucket

The worker requires an R2 bucket named `pigeon-media` for media relay. This is a one-time setup:

```bash
npx wrangler r2 bucket create pigeon-media
```

The binding is configured in `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "MEDIA"
bucket_name = "pigeon-media"
```

If the bucket doesn't exist, deploy will succeed but media upload/download will fail at runtime.

## D1 Database

The worker uses D1 (Cloudflare's serverless SQLite) for state. The database `pigeon-router` is configured in `wrangler.toml`.

Schema is at `packages/worker/src/d1-schema.sql`. To apply schema changes:

```bash
npx wrangler d1 execute pigeon-router --remote --file=packages/worker/src/d1-schema.sql
```

To inspect production data:

```bash
npx wrangler d1 execute pigeon-router --remote --command "SELECT * FROM machines"
```

## Validate Deployment

```bash
curl -s https://ccr-router.jonathan-mohrbacher.workers.dev/health
```

Expected: `ok`

## Secret-driven Auth Checks

```bash
curl -s -H "Authorization: Bearer $(cat /run/secrets/ccr_api_key)" \
  "https://ccr-router.jonathan-mohrbacher.workers.dev/sessions"
```

## Webhook Checks

### Slack

Slack routes take no bearer, only Slack's signature, so the deploy check without the signing secret is the negative one: `POST /slack/<machine>/events` with no `X-Slack-Signature` returns `401` for a machine that has a `SLACK_WORKSPACE_<MACHINE>` secret and the router's `404` for one that does not (`GET /whoami` with that machine's key shows which: `transport: "slack"`). A positive check is the Slack app's *Event Subscriptions* page showing the request URL *Verified* (see the runbook's "At the flip").

### Telegram

> **Note:** `TELEGRAM_WEBHOOK_SECRET` is a worker-only Cloudflare secret, not in sops.
> Set it manually: `export TELEGRAM_WEBHOOK_SECRET="<value>"` before running.

```bash
curl -s -o /tmp/webhook-auth-check.txt -w "%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
  "https://ccr-router.jonathan-mohrbacher.workers.dev/webhook/telegram/parity" \
  --data '{"update_id":999999001}'
```

Expected: HTTP `200`.

## Verify

Run these in order:

```bash
curl -s https://ccr-router.jonathan-mohrbacher.workers.dev/health
curl -s -o /tmp/deploy_sessions.json -w "%{http_code}" -H "Authorization: Bearer $(cat /run/secrets/ccr_api_key)" "https://ccr-router.jonathan-mohrbacher.workers.dev/sessions"
```

Expected:

- health returns `ok`
- authenticated `/sessions` returns HTTP `200`

Also verify the cron trigger is active (visible in deploy output as `schedule: 0 * * * *`). This runs hourly R2 media cleanup.
