---
name: worker-operations
description: Use when handling day-to-day worker operations such as health checks, log triage, incident response, and rollback
---

# Worker Operations Runbook

## When To Use

Use this skill for production support and incident response, not feature implementation.

## Scope

Use this skill for active operations, not feature development.

- health checks
- production diagnostics
- tailing logs
- deploy verification
- rollback decisions

## Quick Operational Checks

```bash
curl -s https://ccr-router.jonathan-mohrbacher.workers.dev/health
```

Expected: `ok`

Authenticated check:

```bash
curl -s -o /tmp/worker_sessions.json -w "%{http_code}" \
  -H "Authorization: Bearer $(cat /run/secrets/ccr_api_key)" \
  "https://ccr-router.jonathan-mohrbacher.workers.dev/sessions"
```

Expected: HTTP `200`

## Incident Triage Sequence

1. Confirm worker health endpoint.
2. Confirm auth path (`/sessions` with valid bearer).
3. Confirm webhook auth behavior:
   - wrong secret -> `401`
   - correct secret -> `200`
4. Confirm notification path with a test session.
5. Confirm WebSocket clients are connected (if command delivery issues).

## Logs

```bash
cd ~/projects/pigeon/packages/worker
export CLOUDFLARE_API_TOKEN="$(cat /run/secrets/cloudflare_api_token)"
wrangler tail --format=pretty
```

When reading logs, prioritize:

- auth failures (401)
- webhook parse/validation failures
- Telegram API failures
- queue retry spikes

## Deploy Verification Checklist

After deploy:

1. `GET /health` returns `ok`.
2. Authenticated `/sessions` returns `200`.
3. Webhook secret check behaves as expected.
4. Notification send returns `{ ok: true, messageId, token }`.

## Safe Rollback Guidance

Use rollback if:

- health/auth paths regress,
- notification send fails broadly,
- webhook processing breaks for valid traffic.

Then:

1. Roll back worker using Cloudflare tooling.
2. Re-run quick operational checks.
3. Capture incident notes and root-cause breadcrumbs before re-deploy.

## Guardrails

- Do not rotate secrets during active incidents unless confirmed compromised.
- Keep DO class compatibility (`RouterDO`) intact across deploys.
- Prefer reading secrets from `/run/secrets/` files over manual exports or shell history.

## Verify

```bash
curl -s https://ccr-router.jonathan-mohrbacher.workers.dev/health
```

Expected: `ok`
