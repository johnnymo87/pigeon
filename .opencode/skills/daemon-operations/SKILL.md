---
name: daemon-operations
description: Use for daemon service health checks, runtime diagnostics, restart procedures, and burn-in monitoring
---

# Daemon Operations

## When To Use

Use this skill for day-to-day daemon ops and post-deploy checks.

## Service Identity

- Active service name on devbox: `pigeon-daemon.service`
- Service now runs Pigeon daemon entrypoint from `packages/daemon/src/index.ts`

## Health Checks

```bash
systemctl status pigeon-daemon.service --no-pager
curl -s http://127.0.0.1:4731/health
systemctl status opencode-serve.service --no-pager
curl -s http://127.0.0.1:4096/global/health
```

Expected:

- pigeon-daemon is active/running, health returns `{"ok":true,"service":"pigeon-daemon"}`
- opencode-serve is active/running, health returns `{"healthy":true,...}`

## Operational Logs

```bash
journalctl -u pigeon-daemon.service -n 100 --no-pager
journalctl -u opencode-serve.service -n 100 --no-pager
```

Look for:

- poller tick errors: `[poller] tick error:` or `[poller] poll failed:`
- poller dispatch errors: `[poller] dispatch error (skipping ack)`
- worker register/unregister success: `[poller] registerSession`
- notification send failures
- launch-ingest: `session started sessionId=... directory=...`
- kill-ingest: `session terminated sessionId=...`
- media fetch failures: `Failed to fetch media from R2` in command-ingest logs
- media upload failures: silent (text notification still sends), but `uploadMedia` errors appear in daemon stderr

## Restart Procedure

```bash
sudo systemctl restart pigeon-daemon.service
systemctl status pigeon-daemon.service --no-pager
# If opencode serve needs restart:
sudo systemctl restart opencode-serve.service
systemctl status opencode-serve.service --no-pager
```

## Media Relay Diagnostics

If media isn't arriving in Telegram or OpenCode:

1. **Check worker R2 bucket exists**: `npx wrangler r2 bucket list` should show `pigeon-media`.
2. **Check worker deploy has MEDIA binding**: deploy output should show `env.MEDIA (pigeon-media)`.
3. **Inbound (Telegram→OpenCode)**: daemon logs will show media fetch errors if the worker URL or API key is wrong.
4. **Outbound (OpenCode→Telegram)**: daemon uploads silently skip failures — check worker `/media/upload` auth if media never appears in Telegram.
5. **Cron cleanup**: if media disappears before delivery, check that the 24h TTL in `cleanupExpiredMedia` is sufficient.

## Verify

Run health + one route smoke call:

```bash
curl -s -X POST -H "Content-Type: application/json" http://127.0.0.1:4731/session-start --data '{"session_id":"ops-smoke","notify":false}'
curl -s -X DELETE http://127.0.0.1:4731/sessions/ops-smoke
```
