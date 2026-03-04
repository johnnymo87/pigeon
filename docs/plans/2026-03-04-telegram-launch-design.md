# Telegram-Triggered Headless OpenCode Sessions

## Problem

Today, launching an AI coding session requires an interactive terminal. The developer must SSH into a machine, navigate to a project, and start opencode manually. This is friction when an idea or task comes to mind while away from a workstation -- the developer cannot kick off work from their phone.

## Solution

Add a `/launch` command to Telegram that starts a headless opencode session on any machine, in any project directory, with a given prompt. The existing pigeon notification flow handles the rest: stop/question/error notifications arrive in Telegram, and the developer can reply to steer the session or `opencode attach` from a terminal later.

## Architecture

No new infrastructure. The feature adds a new command type through the existing three-layer stack:

```
Telegram /launch devbox ~/projects/foo "fix tests"
  -> Cloudflare Worker (parses command, routes by machineId)
  -> pigeon-daemon on target machine (receives via WebSocket)
  -> opencode serve API on localhost:4096 (creates session + sends prompt)
  -> pigeon opencode-plugin (picks up session, sends notifications back)
```

### Data Flow

1. User sends `/launch devbox ~/projects/foo "fix tests"` in Telegram.
2. Telegram webhook hits the Cloudflare Worker.
3. Worker parses the command: machine=`devbox`, dir=`~/projects/foo`, prompt=`fix tests`.
4. Worker validates that `devbox` is a connected machine (WebSocket is live).
5. Worker queues a `launch` command for the `devbox` machineId.
6. Worker sends an immediate Telegram ack: "Launching on devbox in ~/projects/foo..."
7. Daemon receives the command via WebSocket.
8. Daemon health-checks the local opencode serve (`GET /global/health`).
   - If down: replies to Telegram with an error message and stops.
9. Daemon calls `POST /session` with `x-opencode-directory: ~/projects/foo` header.
10. Daemon calls `POST /session/{id}/prompt_async` with the prompt.
11. Daemon replies to Telegram confirming session creation (includes session ID).
12. The pigeon opencode-plugin detects `session.created`, registers the session.
13. Normal pigeon flow from here: idle/question/error notifications, reply-to-command.
14. Developer can optionally `opencode attach http://localhost:4096 --session <id>` via SSH.

## Component Changes

### Cloudflare Worker (`packages/worker`)

Minimal change. Parse `/launch <machine> <dir> <prompt>` in the webhook handler. Create a command with `type: "launch"` (new type alongside existing `"execute"`). The command payload includes `directory` and `prompt` fields. Route via the existing command queue to the target machineId.

Validate that the machineId corresponds to a connected machine. If not, reply immediately with an error (machine offline).

### pigeon-daemon (`packages/daemon`)

The main work. Add an opencode API client and a launch command handler.

**New module: opencode API client.** HTTP client for the local opencode serve. Needs:
- `GET /global/health` -- health check
- `POST /session` -- create session (with `x-opencode-directory` header)
- `POST /session/{id}/prompt_async` -- send prompt

Configured via two env vars:
- `OPENCODE_URL` (default `http://127.0.0.1:4096`)
- `OPENCODE_PASSWORD` (from sops, same secret as `OPENCODE_SERVER_PASSWORD`)

The client sends HTTP Basic Auth on every request when a password is configured.

**command-ingest.ts change.** Add a branch for `type: "launch"` commands. Instead of routing to an adapter (DirectChannel/NvimRpc), call the opencode API client to create a session and send the prompt. On success, send a Telegram confirmation. On failure (opencode serve down, API error), send a Telegram error message.

### opencode serve (no changes)

Already supports everything needed. Multi-directory via `x-opencode-directory` header. Session creation, prompt_async, health check all exist.

### opencode-plugin / pigeon plugin (no changes)

Already handles `session.created` events and the full notification lifecycle. New sessions launched via the API are indistinguishable from sessions created by the TUI.

### workstation (`~/projects/workstation`)

**New: persistent opencode serve systemd service.** Deployed to all machines.

- Binary: `~/.nix-profile/bin/opencode`
- Command: `opencode serve --port 4096 --hostname 127.0.0.1`
- User: `dev`
- Environment: `OPENCODE_SERVER_PASSWORD` from sops (`/run/secrets/opencode_server_password`)
- `Restart=always`, `RestartSec=10`
- Working directory: `$HOME` (each request specifies its own directory)

**New secret:** `opencode_server_password` in sops (`secrets/devbox.yaml`), declared in NixOS config, read from `/run/secrets/` at runtime. Same secret shared between the opencode serve service and the pigeon-daemon.

## Telegram UX

### Command Format

```
/launch <machineId> <directory> <prompt>
```

Examples:
```
/launch devbox ~/projects/my-podcasts "fix the failing tests in test_consumer.py"
/launch macbook ~/Code/pigeon "add retry logic to the webhook handler"
/launch cloudbox ~/projects/workstation "update the flake inputs"
```

The prompt is everything after the directory. Quotes are optional (the entire remainder of the message after the directory is the prompt).

### Response Flow

1. Immediate ack from worker: "Launching on devbox in ~/projects/my-podcasts..."
2. Session created confirmation from daemon (includes session ID for attach)
3. Normal pigeon notifications from the plugin (stop, question, error)
4. User replies to steer the session, or attaches from a terminal

### Error Cases

- Machine offline: "devbox is not connected."
- opencode serve down: "opencode serve is not running on devbox."
- API error: "Failed to create session: <error details>"

## Security

- opencode serve binds to `127.0.0.1` only. No network exposure.
- `OPENCODE_SERVER_PASSWORD` set via sops on every machine, used by both the opencode serve service and the pigeon-daemon.
- Remote `opencode attach` goes through SSH port-forwarding (or Tailnet in the future).
- No TLS needed since traffic never leaves loopback.
- Telegram-side security unchanged: webhook secret verification, chat ID allowlisting, update deduplication.

## Out of Scope

- **my-podcasts migration**: The podcast pipeline keeps its own `opencode serve` on port 5555. Consolidation to the shared server is a future task.
- **Live streaming**: No live progress streaming to Telegram beyond existing stop/question events.
- **Shortcut aliases**: No pre-configured named tasks (`/launch podcasts-fix`). Plain command only for now.
- **Multi-machine daemon deployment**: The design assumes daemon-per-machine (already the direction). Actually deploying daemons to macOS and cloudbox is a follow-up.
