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

Without the flag `journalctl -u pigeon-daemon.service` returns **zero entries and
no error**, which is indistinguishable from "the daemon logged nothing". Add
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

## Emergency: re-enable the quiet-title layer (lgtm notification spam)

Symptom: routine lgtm PR-review sessions are posting Stop notifications to Telegram again.
As of `pigeon-qdcb.5` the legacy title-regex layer is **off by default** — suppression now comes
from `session_origin` rows written by lgtm at spawn time. If those writes stop landing, the regex
safety net is no longer there to catch it, and the spam is the expected symptom.

Prefer fixing the origin writer. Use this lever only to stop the bleeding, and remember it
re-enables a heuristic that also silences *genuine work on lgtm itself* whose title matches.

The unit is NixOS-generated with `Environment=` baked into its store path and no
`EnvironmentFile`, so you cannot just export a variable — you need a drop-in:

```bash
sudo systemctl edit pigeon-daemon.service   # opens a drop-in, not the unit
# add exactly:
#   [Service]
#   Environment=PIGEON_QUIET_TITLE_LAYER=on
sudo systemctl restart pigeon-daemon.service
systemctl show pigeon-daemon.service -p Environment | tr ' ' '\n' | grep QUIET_TITLE  # verify
```

The variable is read at call time (`decideNotify`'s `env = process.env` default), so one restart
is sufficient — no rebuild.

**The drop-in is unmanaged drift on NixOS.** It survives rebuilds and will silently outlive the
incident. Remove it (`sudo systemctl revert pigeon-daemon.service` + restart) once the origin
writer is fixed, and note that the regex is scheduled for deletion — after which this lever
stops existing and the drop-in becomes a no-op that looks like it is still protecting you.

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
