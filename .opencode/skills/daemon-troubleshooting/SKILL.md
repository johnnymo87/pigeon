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
    - notifier configuration missing or sops secret decryption failure
- reply commands not injected
  - adapter delivery failure or invalid transport metadata (check `backend_endpoint` on session)
- repeated command processing
  - inspect `inbox` status transitions and ack handling

## Question Reply Failures

- **"Unable to connect" on Telegram button press / swipe-reply**
  - The plugin's `onQuestionReply` must use the SDK client's in-process fetch, not `globalThis.fetch`. In TUI mode, no HTTP server listens on `ctx.serverUrl` (`localhost:4096`). See `opencode-plugin-architecture` skill for the `internalFetch` pattern.
  - If the plugin was recently changed, ensure `internalFetch` is extracted from `(ctx.client as any)._client?.getConfig?.().fetch`.
- **"Session expired" on Telegram button press**
  - Token mismatch: the worker must store the daemon's token from `callback_data`, not generate its own. Check `extractTokenFromCallbackData()` in `packages/worker/src/notifications.ts`.
- **"This question has already been answered"**
  - Normal behavior when the user answered in the TUI before pressing the Telegram button. The `pending_questions` row was already deleted.
- **Pending question not found after notification sent**
  - Check `pending_questions` table TTL (4h). Old questions are evicted.
  - Verify `/question-asked` was called (daemon has no HTTP request logging by default; add temporary logging if needed).

## Launch / Kill Failures

- **"opencode serve is not running on this machine"**
  - `opencode-serve.service` is down or unhealthy. Check: `systemctl status opencode-serve.service` and `curl http://127.0.0.1:4096/global/health`.
- **"Failed to launch session: createSession failed: ..."**
  - opencode serve rejected the session creation. Check the directory exists and opencode-serve logs: `journalctl -u opencode-serve.service -n 50`.
- **"Failed to kill session: deleteSession failed: ..."**
  - Session may already be terminated, or opencode serve is down. Check opencode-serve logs.
- **Launch succeeds but no Telegram notifications from the session**
  - The pigeon plugin in opencode-serve must detect and register the session. Check that the plugin symlink is intact: `ls -la ~/.config/opencode/plugins/opencode-pigeon.ts`.
  - Check opencode-serve logs for plugin initialization errors.
- **`/kill` returns "Session not found" from worker**
  - The session was never registered by the plugin, or was already unregistered. The plugin registers sessions via `/sessions/register` after late discovery. If `/kill` is sent immediately after `/launch`, there may be a race condition -- retry after a few seconds.

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
npm run --workspace @pigeon/daemon parity:harness
```
