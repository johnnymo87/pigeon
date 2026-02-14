---
name: nvim-plugin-architecture
description: Use when you need to understand pigeon.lua dispatch protocol, instance registration, and the RPC contract between daemon and nvim
---

# Nvim Plugin Architecture

## When To Use

Use this before changing pigeon.lua, the NvimRpcAdapter, or the hook scripts that bridge them.

## Overview

`packages/nvim-plugin/lua/pigeon.lua` is the nvim-side plugin. It manages terminal buffer instances and dispatches commands via `chansend()`.

The daemon's `NvimRpcAdapter` calls pigeon.lua over nvim's RPC protocol:

```
Telegram reply -> Worker -> Daemon (command-ingest)
  -> NvimRpcAdapter
  -> nvim --headless --server <socket> --remote-expr "luaeval('require(\"pigeon\").dispatch(_A)', '<b64>')"
  -> pigeon.lua dispatch() -> chansend() to correct terminal buffer
```

## Instance Registration

On `TermOpen`, pigeon.lua registers each terminal buffer by its PTY path:

```lua
instances[info.pty] = { bufnr = bufnr, job_id = chan, registered_at = os.time() }
```

Instances are keyed by PTY device path (e.g., `/dev/pts/42`). Cleaned up on `TermClose`/`BufWipeout`.

## Dispatch Protocol

**Request:** base64-encoded JSON passed as `_A` argument to `luaeval`.

**Response:** base64-encoded JSON returned from `dispatch()`.

### Request Types

| type     | fields              | description                              |
|----------|---------------------|------------------------------------------|
| `send`   | `name`, `command`   | Send command to terminal instance by PTY |
| `tail`   | `name`, `lines?`    | Read last N lines from terminal buffer   |
| `list`   | (none)              | List registered instances                |

### Response Shape

```json
{"ok": true}
{"ok": false, "error": "unknown_instance"}
```

### Field Names

- `name` = PTY path (e.g., `/dev/pts/42`) — matches `instances[name]` key
- `command` = text to send via `chansend()` (Enter is sent separately after 100ms delay to avoid Ink paste detection)

## Session Registration Flow

1. User starts nvim with `--listen <socket>` (via `nvims` shell function)
2. `pigeon.setup()` is called from nvim init (auto-registers terminal buffers)
3. User opens `:terminal` and starts Claude Code
4. Claude's `on-session-start.sh` hook fires, sends `{nvim_socket: $NVIM, tty: <pty>}` to daemon
5. Daemon stores `nvim_socket` + `pty_path` on the session record
6. `selectAdapter()` picks `NvimRpcAdapter` when both fields are present

## Deployment

- `pigeon.lua` is deployed via workstation Nix config (`mkOutOfStoreSymlink` to pigeon repo)
- `require("pigeon").setup()` is called from nvim's `extraLuaConfig`
- Daemon systemd service needs `neovim` in its `path` for RPC calls

## Key Files

- `packages/nvim-plugin/lua/pigeon.lua` — nvim plugin
- `packages/daemon/src/adapters/nvim-rpc.ts` — daemon adapter
- `packages/daemon/src/worker/command-ingest.ts` — adapter selection (`selectAdapter`)
- `packages/hooks/on-session-start.sh` — hook that sends nvim_socket + tty to daemon

## User Commands

- `:PigeonList` — list registered terminal instances
- `:PigeonSend <name> <command>` — send command to instance

## Verify

```bash
# Check pigeon.lua is loaded in nvim
:PigeonList

# Test RPC from outside nvim
nvim --headless --server <socket> --remote-expr "luaeval('require(\"pigeon\").dispatch(_A)', '$(echo '{"type":"list"}' | base64 -w0)')"
```
