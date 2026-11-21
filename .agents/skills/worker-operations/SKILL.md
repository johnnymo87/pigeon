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
   - Telegram: wrong secret -> `401`, correct secret -> `200`
   - Slack (a machine with a `SLACK_WORKSPACE_<MACHINE>` secret): `POST /slack/<machine>/events` with a bad or missing `X-Slack-Signature` -> `401`; a machine with no secret -> the router's ordinary `404`
4. Confirm notification path with a test session. On a Slack machine the proof is a post in that session's channel (or `#alerts` for an unthreaded send), not a topic.
5. Confirm daemon is polling (check `machines` table for recent `last_poll_at`).

## Logs

```bash
cd ~/projects/pigeon/packages/worker
export CLOUDFLARE_API_TOKEN="$(cat /run/secrets/cloudflare_api_token)"
wrangler tail --format=pretty
```

When reading logs, prioritize:

- auth failures (401)
- webhook parse/validation failures
- Telegram API failures, and on Slack the `[worker] slack ...` lines (`slack rejected the blocks, retrying as plain text`, `slack owner invite failed`, `slow slack call`, `slack workspace secret ignored` for a malformed `SLACK_WORKSPACE_<MACHINE>`). Failure responses on Slack carry a top-level `errorClass` (`rate_limited`, `conversation_gone`, `rejected_format`, `upstream`)
- queue retry spikes

## Deploy Verification Checklist

After deploy:

1. `GET /health` returns `ok`.
2. Authenticated `/sessions` returns `200`.
3. Webhook secret check behaves as expected.
4. Notification send returns `{ ok: true, messageId, token }` (on Slack the `messageId` is a handle >= 2^40 from `slack_posts`).

## Where To Look When A Slack Post Is Missing

1. `GET /whoami` with the MACHINE key (`/run/secrets/pigeon_worker_key` on devbox/cloudbox, Keychain `pigeon-worker-key` on the Mac): `transport: "slack"` or not. `"credential":"shared"` means the wrong key. A machine answer with no `transport` means the worker sees no valid secret for that machine and would post to Telegram (rolled back, or a broken secret).
2. `wrangler tail` for `[worker] slack ...` and the `[worker] request outcome` lines (status >= 400) on `/notifications/send` and `/messages/send`; read the response `errorClass`.
3. D1: the chat id is `slack:<teamId>`. `SELECT * FROM topics WHERE chat_id LIKE 'slack:%' AND session_id = '<sid>'` gives the session's channel handle, and `slack_conversations` maps that handle to the Slack channel id (`slack_posts` maps post handles to channel + `ts`). Apply the schema (`slack_conversations`, `slack_posts`, `slack_seen_events`) before creating any secret; a missing table shows as a quiet `retention skipped: table missing` log line in the cron.
4. No mention or push is expected by default: `SLACK_NOTIFY_OWNER` is deliberately unset (empty means no owner mention at all).

## Safe Rollback Guidance

Use rollback if:

- health/auth paths regress,
- notification send fails broadly,
- webhook processing breaks for valid traffic.

Then:

1. Roll back worker using Cloudflare tooling. **Not past pigeon-k0qn.8 (per-machine
   credentials) while any daemon uses its own `pgk_` key**: an older worker refuses those keys
   on every route. Move those daemons to the shared key first (marker file in
   `docs/runbooks/per-machine-credentials.md`, "Rollback").
2. Re-run quick operational checks.
3. Capture incident notes and root-cause breadcrumbs before re-deploy.

## Guardrails

- Do not rotate secrets during active incidents unless confirmed compromised.
- Keep D1 schema migrations backward-compatible across deploys.
- Prefer reading secrets from `/run/secrets/` files over manual exports or shell history.

## Verify

```bash
curl -s https://ccr-router.jonathan-mohrbacher.workers.dev/health
```

Expected: `ok`
