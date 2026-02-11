---
name: worker-deployment
description: Use when deploying or updating the Pigeon worker on Cloudflare and validating production health
---

# Deploying the Pigeon Worker

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
bun run --filter '@pigeon/worker' deploy
```

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
cd ~/projects/claude-code-remote
op run --env-file=.env.1password -- sh -c '
  curl -s -H "Authorization: Bearer $CCR_API_KEY" \
    "https://ccr-router.jonathan-mohrbacher.workers.dev/sessions"
'
```

## Telegram Webhook Check

```bash
cd ~/projects/claude-code-remote
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
