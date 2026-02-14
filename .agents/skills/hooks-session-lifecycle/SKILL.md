---
name: hooks-session-lifecycle
description: Use when configuring or debugging Claude hook behavior and session start-stop lifecycle integration with Pigeon daemon
---

# Hooks And Session Lifecycle

## When To Use

Use this when hook-driven session registration or stop notifications fail.

## Lifecycle

1. Session start hook triggers daemon `/session-start`.
2. Session stop/idle flow triggers daemon `/stop`.
3. Daemon notification path emits Telegram message and reply token.
4. Worker routes replies/callbacks back to machine agent command ingest.

## Hook Scripts

Hook scripts live in `packages/hooks/` in the pigeon repo. The workstation Nix config wraps these for deployment (installs them into the correct paths with proper env). Edit hooks in `packages/hooks/`, not in the Nix derivation.

## Hook Debugging

Check runtime probes/logs:

```bash
ls -la ~/.claude/runtime/hook-debug/
```

Look for missing checkpoints in session-start or stop path.

## Daemon Route Checks

```bash
curl -s -X POST -H "Content-Type: application/json" http://127.0.0.1:4731/session-start --data '{"session_id":"hook-smoke","notify":false}'
curl -s -X POST -H "Content-Type: application/json" http://127.0.0.1:4731/stop --data '{"session_id":"hook-smoke","event":"Stop","message":"smoke"}'
curl -s -X DELETE http://127.0.0.1:4731/sessions/hook-smoke
```

## PTY Detection (nvim sessions)

When `$NVIM` is set, the hook detects the PTY device path for nvim RPC instance matching:

- **Linux:** `readlink /proc/$ppid/fd/0` — reads parent's stdin fd symlink
- **macOS:** `lsof -nP -w -p $ppid -a -d 0 -F n` — reads parent's fd 0 device via lsof (machine-parseable `-F n` output). `ps -o tty=` does NOT work on macOS because nvim terminal processes have no controlling tty (`??`), even though fd 0 is connected to the PTY slave.

The detected path must match what nvim reports via `nvim_get_chan_info(chan).pty` (e.g., `/dev/pts/42` on Linux, `/dev/ttys048` on macOS).

## Hook Deployment

Hook scripts live in `packages/hooks/`. Workstation `claude-hooks.nix` creates thin Nix wrappers that add PATH deps (jq, curl, coreutils) and exec the pigeon scripts at runtime. Updating the pigeon repo is sufficient — no `home-manager switch` needed for hook content changes.

## Common Failure Points

- missing hook install/config
- malformed hook payload fields (`session_id` required)
- daemon service unavailable
- missing notifier config causing `notified=false`
- **empty `pty_path`** — PTY detection failed; check `lsof`/`readlink` output for parent PID
- **`unknown_instance`** — PTY path doesn't match pigeon.lua registration; compare hook debug log `tty` field with `:PigeonList` output

## Verify

Expected:

- `/session-start` returns `{ok:true}`
- `/stop` returns `ok` and expected notification behavior
