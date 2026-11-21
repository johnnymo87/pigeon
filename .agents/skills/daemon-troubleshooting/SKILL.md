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
journalctl --namespace=pigeon -u pigeon-daemon.service -n 120 --no-pager   # on devbox: sudo journalctl --namespace=pigeon ...
curl -s http://127.0.0.1:4731/health
```

## Common Failure Patterns

- service up but no worker flow
  - missing/invalid `CCR_API_KEY`, `CCR_WORKER_URL`, or `CCR_MACHINE_ID`
- unexpected 401 response from :4731
  - caller is not sending the bearer token (`Authorization: Bearer $(cat /run/secrets/pigeon_daemon_auth_token)`), NOT that the daemon is broken (except `/health`, all daemon routes require auth when token is set)
- stop notifications not sent
    - notifier configuration missing or sops secret decryption failure
- reply commands not injected
  - adapter delivery failure or invalid transport metadata (check `backend_endpoint` on session)
- repeated command processing
  - inspect `inbox` status transitions and ack handling

## Question Reply Failures

- **"Unable to connect" on a chat button press / reply (a Slack thread reply)**
  - The plugin's `onQuestionReply` must use the SDK client's in-process fetch, not `globalThis.fetch`. In TUI mode, no HTTP server listens on `ctx.serverUrl` (`localhost:4096`). See `opencode-plugin-architecture` skill for the `internalFetch` pattern.
  - If the plugin was recently changed, ensure `internalFetch` is extracted from `(ctx.client as any)._client?.getConfig?.().fetch`.
- **"Session expired" on a button press** (Slack: an ephemeral note in the channel)
  - Token mismatch: the worker must store the daemon's token from `callback_data`, not generate its own. Check `extractTokenFromCallbackData()` in `packages/worker/src/notifications.ts`.
- **"This question has already been answered"**
  - Normal behavior when the user answered in the TUI before pressing the chat button. The `pending_questions` row was already deleted.
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
- **Launch succeeds but no chat notifications from the session (no Slack channel appears)**
  - The pigeon plugin in opencode-serve must detect and register the session. Check that the plugin symlink is intact: `ls -la ~/.config/opencode/plugins/opencode-pigeon.ts`.
  - Check opencode-serve logs for plugin initialization errors.
- **`/kill` returns "Session not found" from worker**
  - The session was never registered by the plugin, or was already unregistered. The plugin registers sessions via `/sessions/register` after late discovery. If `/kill` is sent immediately after `/launch`, there may be a race condition -- retry after a few seconds.

## A Slack Post Is Missing

The worker owns the Slack call, so start there, then the daemon:

1. Does the worker know the machine's workspace? `curl -s -H "Authorization: Bearer $(cat /run/secrets/pigeon_worker_key)" https://ccr-router.jonathan-mohrbacher.workers.dev/whoami` (the MACHINE key: `/run/secrets/pigeon_worker_key` on devbox/cloudbox, Keychain `pigeon-worker-key` on the Mac) must show `"transport":"slack"`. `"credential":"shared"` means you used the wrong key. A machine answer with no `transport` means the worker sees no valid `SLACK_WORKSPACE_<MACHINE>` secret (missing or broken), and `/notifications/send` answers `503 no_transport`. The daemon logs `[chat] Slack only (Telegram removed, pigeon-4ogz.13)` at startup (a daemon that logs anything else is an old build) and does not track the transport (`whoami.transport` is informational).
2. Outbox: the notification is queued, retrying or dropped? Look at the daemon's `outbox` row (`notification_id`, `state`, `attempts`) as in `swarm-operations` "Outbox Querying". A `topic_unavailable` 502 is a deliberate per-session hold (channel creation failed or was rate-limited), not an outage.
3. The worker's answer carries a top-level `errorClass` on provider failures: `rate_limited`, `conversation_gone` (channel missing or archived: the worker unarchives, joins or recreates it once), `rejected_format` (Slack refused the blocks: for a plain `sendMessage` the WORKER retries once with no blocks, logging `[worker] slack rejected the blocks, retrying as plain text`, so the daemon never sees it; only if the plain retry also fails does the worker answer 502 with `errorClass: rejected_format`, which the daemon's outbox handles by resending without entities, `delivery-policy.ts` rule 6), `upstream` (a dead token, scope or Slack trouble: retried, never relocated). Read them in `wrangler tail` (see `worker-operations`; worker log lines are prefixed `[worker] slack ...`).
4. A conversation lives in D1 `topics` (`chat_id = 'slack:<teamId>'`, `message_thread_id` = a handle >= 2^40) and `slack_conversations` (handle to Slack channel id). A channel that was archived by hand or by the nightly orphan-closer is reopened on the next post.
5. Operational alerts that skip the worker (worker down) go direct to `#alerts` through `PIGEON_SLACK_ALARM_WEBHOOK_URL`; startup logs `[alert] direct path: slack=set|unset|INVALID (ignored)`. No pushes are expected: `SLACK_NOTIFY_OWNER` is unset by default, so nothing mentions the owner and a post only shows as an unread badge.

## Nvim Adapter Failures

- **Check `nvim_socket` is set on session:**
  ```bash
  curl -s -H "Authorization: Bearer $(cat /run/secrets/pigeon_daemon_auth_token)" http://127.0.0.1:4731/sessions | jq '.[] | {id, nvim_socket}'
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
