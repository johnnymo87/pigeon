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

```bash
cd ~/projects/pigeon
npm run --workspace @pigeon/worker deploy
```

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

## Durable Object Compatibility

Current production uses DO class `RouterDO`.

- Keep `packages/worker/wrangler.toml` with:
  - `class_name = "RouterDO"`
  - migration `new_sqlite_classes = ["RouterDO"]`
- Keep `RouterDO` export in `packages/worker/src/index.ts`

If this drifts, deploy can fail with Cloudflare DO class mismatch errors.

## Validate Deployment

```bash
curl -s https://ccr-router.jonathan-mohrbacher.workers.dev/health
```

Expected: `ok`

## Secret-driven Auth Checks

Use 1Password injection instead of storing `CCR_API_KEY` in shell history:

```bash
cd ~/projects/pigeon
op run --env-file=.env.1password -- sh -c '
  curl -s -H "Authorization: Bearer $CCR_API_KEY" \
    "https://ccr-router.jonathan-mohrbacher.workers.dev/sessions"
'
```

## Telegram Webhook Check

```bash
cd ~/projects/pigeon
op run --env-file=.env.1password -- sh -c '
  curl -s -o /tmp/webhook-auth-check.txt -w "%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
    "https://ccr-router.jonathan-mohrbacher.workers.dev/webhook/telegram/parity" \
    --data "{\"update_id\":999999001}"
'
```

Expected: HTTP `200`.

## Verify

Run these in order:

```bash
curl -s https://ccr-router.jonathan-mohrbacher.workers.dev/health
cd ~/projects/pigeon
op run --env-file=.env.1password -- sh -c 'curl -s -o /tmp/deploy_sessions.json -w "%{http_code}" -H "Authorization: Bearer $CCR_API_KEY" "https://ccr-router.jonathan-mohrbacher.workers.dev/sessions"'
```

Expected:

- health returns `ok`
- authenticated `/sessions` returns HTTP `200`

Also verify the cron trigger is active (visible in deploy output as `schedule: 0 * * * *`). This runs hourly R2 media cleanup.
