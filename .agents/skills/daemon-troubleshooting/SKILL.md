---
name: daemon-troubleshooting
description: Use when daemon notifications, worker command ingest, session routes, or local injection behavior are failing
---

# Daemon Troubleshooting

## When To Use

Use this when daemon behavior regresses in production or parity tests.

## Fast Triage

1. Check service and health endpoint.
2. Check worker connectivity logs.
3. Check route contract (`/session-start`, `/stop`, `/sessions`).
4. Check command delivery path.

## Commands

```bash
systemctl status pigeon-daemon.service --no-pager
journalctl -u pigeon-daemon.service -n 120 --no-pager
curl -s http://127.0.0.1:4731/health
```

## Common Failure Patterns

- service up but no worker flow
  - missing/invalid `CCR_API_KEY`, `CCR_WORKER_URL`, or `CCR_MACHINE_ID`
- stop notifications not sent
  - notifier configuration missing or 1Password env injection failure
- reply commands not injected
  - no WS command delivery or invalid transport metadata
- repeated command processing
  - inspect `inbox` status transitions and ack handling

## Nvim Adapter Failures

- **Check `nvim_socket` is set on session:**
  ```bash
  curl -s http://127.0.0.1:4731/sessions | jq '.[] | {id, nvim_socket}'
  ```
- **Check pigeon.lua is loaded in nvim:**
  ```bash
  nvim --server /tmp/nvim.sock --remote-expr "luaeval('require(\"pigeon\").list()')"
  ```
  Should return registered PTY instances. Empty/error means plugin not loaded.
- **Check PTY registration:** the `list()` call above shows registered instances. If empty, the Claude session didn't register its PTY.
- **Common errors:**
  - `"nvim RPC timed out"` — nvim process unresponsive or socket stale
  - `"instance not found"` — session PTY not registered in pigeon.lua; check hook ran after nvim loaded plugin

## Verify

Use parity harness for full-path validation:

```bash
cd ~/projects/pigeon
bun run --filter '@pigeon/daemon' parity:harness
```
