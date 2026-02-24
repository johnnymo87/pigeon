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
```

Expected:

- service is active/running
- health returns `{"ok":true,"service":"pigeon-daemon"}`

## Operational Logs

```bash
journalctl -u pigeon-daemon.service -n 100 --no-pager
```

Look for:

- machine-agent connect/reconnect messages
- worker register/unregister success
- notification send failures

## Restart Procedure

```bash
sudo systemctl restart pigeon-daemon.service
systemctl status pigeon-daemon.service --no-pager
```

## Verify

Run health + one route smoke call:

```bash
curl -s -X POST -H "Content-Type: application/json" http://127.0.0.1:4731/session-start --data '{"session_id":"ops-smoke","notify":false}'
curl -s -X DELETE http://127.0.0.1:4731/sessions/ops-smoke
```
