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

- machine-agent connect/reconnect messages
- worker register/unregister success
- notification send failures
- launch-ingest: `session started sessionId=... directory=...`
- kill-ingest: `session terminated sessionId=...`

## Restart Procedure

```bash
sudo systemctl restart pigeon-daemon.service
systemctl status pigeon-daemon.service --no-pager
# If opencode serve needs restart:
sudo systemctl restart opencode-serve.service
systemctl status opencode-serve.service --no-pager
```

## Verify

Run health + one route smoke call:

```bash
curl -s -X POST -H "Content-Type: application/json" http://127.0.0.1:4731/session-start --data '{"session_id":"ops-smoke","notify":false}'
curl -s -X DELETE http://127.0.0.1:4731/sessions/ops-smoke
```
