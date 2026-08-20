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
journalctl --namespace=pigeon -u pigeon-daemon.service -n 100 --no-pager
journalctl -u opencode-serve.service -n 100 --no-pager
```

**Note the `--namespace=pigeon` on the first line and its absence on the second.**
On the NixOS hosts (devbox, cloudbox) pigeon-daemon logs to a private journal
namespace (`LogNamespace = "pigeon"`, workstation-9f7a) so its retention is
independent of noisier units — 90 days, against roughly a week in the shared
journal. `opencode-serve` is not namespaced.

Without the flag `journalctl -u pigeon-daemon.service` returns **no error and no
application output**. It is worse than empty: PID 1 is not namespaced, so systemd's
own `Started` / `Stopped` / `Consumed … CPU time` lines still land in the default
journal while every line the daemon writes goes to the namespace. Measured at the
2026-08-11 cutover: 5 systemd lines in the default journal, 0 in the namespace, and
0 application lines in the default journal afterwards.

So the un-namespaced query looks like a daemon that is running but silent — a much
easier thing to believe than an empty result, and the wrong conclusion ("it must be
wedged") is one step away. Add
`--namespace=pigeon` to anything reading pigeon's logs, including unit-less
sweeps like `journalctl --since` or `-p err`, which otherwise skip pigeon
entirely. This also covers `oc-auto-attach`, which pigeon spawns.

To see everything in the namespace regardless of unit:

```bash
journalctl --namespace=pigeon --since '1 hour ago' --no-pager
journalctl --namespace=pigeon --disk-usage      # its own quota, not the main one
```

History written before this landed stays in the default journal, so evidence
from before the cutover needs the un-namespaced form.

Look for:

- poller tick errors: `[poller] tick error:` or `[poller] poll failed:`
- poller dispatch errors: `[poller] dispatch error (skipping ack)`
- worker register/unregister success: `[poller] registerSession`
- notification send failures
- launch-ingest: `session started sessionId=... directory=...`
- kill-ingest: `session terminated sessionId=...`
- compact-ingest: `session compacted commandId=... sessionId=...`
- mcp-ingest: `enable commandId=... server=... session=...` or `disable commandId=...`
- model-ingest: `set commandId=... model=... session=...`
- session reaper: `[reaper] reaped stale session ...` or `[reaper] cleaned N expired session records`
- dead session cleanup: `[command-ingest] removing dead session sessionId=...` (connection error)
- wizard advancement: `[command-ingest] wizard advanced to step N`
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
curl -s -X POST -H "Authorization: Bearer $(cat /run/secrets/pigeon_daemon_auth_token)" -H "Content-Type: application/json" http://127.0.0.1:4731/session-start --data '{"session_id":"ops-smoke","notify":false}'
curl -s -X DELETE -H "Authorization: Bearer $(cat /run/secrets/pigeon_daemon_auth_token)" http://127.0.0.1:4731/sessions/ops-smoke
```
