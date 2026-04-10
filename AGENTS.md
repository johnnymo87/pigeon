# Pigeon Agent Guide

This repo uses agent skills in `.opencode/skills`.

Use this file as the quickstart and table of contents for agent-facing docs.

## Quickstart

- Install deps: `npm install`
- Run all tests: `npm run test`
- Run all typechecks: `npm run typecheck`
- Worker package path: `packages/worker`
- Daemon package path: `packages/daemon`
- OpenCode plugin package path: `packages/opencode-plugin`
- Worker health (deployed): `curl https://ccr-router.jonathan-mohrbacher.workers.dev/health`
- Daemon health (local): `curl http://127.0.0.1:4731/health`
- OpenCode serve health (local): `curl http://127.0.0.1:4096/global/health`
- Deploy worker: `npm run --workspace @pigeon/worker deploy`
- Deploy daemon/plugin: `git pull && npm install` then restart service per machine (see [cross-device-deployment](.opencode/skills/cross-device-deployment/SKILL.md))

## Architecture

Pigeon is a Telegram bot that routes commands to machines running opencode.

```
Telegram → Webhook → Worker → D1 (SQLite)
                                 ↑
              Daemon polls:  GET  /machines/:id/next    (every 5s)
              Daemon acks:   POST /commands/:id/ack
              Daemon sends:  POST /notifications/send
                                 ↓
                           Plugin → OpenCode
```

Messages flow: Telegram → Worker (Cloudflare) → D1 ← Daemon (polls every 5s) → opencode serve.

The worker stores commands in D1 (Cloudflare's serverless SQLite). The daemon short-polls for commands via HTTP. No long-lived connections. If the worker restarts, the next poll succeeds against the new instance. If the daemon restarts, pending commands wait in D1 until it comes back.

**Future improvement (noted, not planned):** Long polling at the Worker level (`GET /machines/:id/next?timeout=25`) to reduce polling traffic. Not needed at current scale. See [design doc](docs/plans/2026-03-14-d1-polling-architecture-design.md).

### Model Override

The `/model` command sets a per-session model override stored in the daemon's SQLite `sessions` table. When a command is delivered, the override is read and passed through the adapter to the plugin, which includes it in the `prompt_async` request body. The override persists until the session ends or a new `/model` command changes it.

### Commands

| Command | Example | What it does |
|---------|---------|--------------|
| *(plain message)* | `fix the failing test in src/auth.ts` | Executes in the current opencode TUI session via the plugin |
| `/launch <machine> <dir> <prompt>` | `/launch devbox pigeon "say hello"` | Starts a headless opencode session on the specified machine |
| `/kill` | *(reply to a session notification)* | Terminates the session (resolved from replied-to message) |
| `/compact` | *(reply to a session notification)* | Summarizes (compacts) the session's conversation to reduce context |
| `/mcp list` | *(reply to a session notification)* | Lists MCP servers with connection status |
| `/mcp enable <server>` | *(reply to a session notification)* | Connects (or reconnects) an MCP server |
| `/mcp disable <server>` | *(reply to a session notification)* | Disconnects an MCP server |
| `/model` | *(reply to a session notification)* | Lists available models from allowed providers |
| `/model <provider/model>` | *(reply to a session notification)* | Sets model override for the session |

**`/launch` directory shorthand:** A bare word like `pigeon` expands to `~/projects/pigeon`. Full paths (`~/projects/pigeon`) and `~`-prefixed paths also work.

### Attaching to a headless session

From a terminal on the machine, connect to a session launched via `/launch`:

```
opencode attach http://localhost:4096 --session <session-id>
```

The session ID is included in the Telegram confirmation message.

### Notifications

Opencode events (stop, question, error) are sent back to Telegram as replies, tagged with the machine name. Each notification includes the session ID on its own line for easy copy-paste.

**Durable notification delivery:** Both stop and question notifications are routed through the daemon's durable outbox. The daemon accepts the event (HTTP 202), stores it in a SQLite outbox, and returns immediately. A background OutboxSender delivers to Telegram every 5s, retrying with backoff on failure. The worker deduplicates by `notificationId` so retries are safe.

**Question notification reliability:** When the plugin receives a `question.asked` event, it enqueues the question in an in-memory retry queue that bypasses the circuit breaker and calls `sendQuestionAsked` with a 3s timeout.

**Multi-question wizard:** When a question has multiple sub-questions, the daemon renders them one at a time in a single Telegram message that is edited in-place as the user answers each step. Button callbacks include a version number (`cmd:TOKEN:v{version}:q{index}`) to prevent stale presses. On the final step, all accumulated answers are delivered to the plugin as a single reply.

**Rate limit retry notifications:** When OpenCode hits a rate limit and retries, the plugin detects `session.status` events of type `"retry"` and sends a notification with the attempt number, error message, and next retry time.

**Message splitting:** When a notification body exceeds Telegram's 4096-character limit, it is split into multiple messages at natural boundaries (paragraph breaks, line breaks, sentence ends). Reply markup is attached only to the last chunk.

### Media Relay

Photos, documents, audio, video, and voice messages sent to the Telegram bot are relayed to OpenCode sessions via R2:

- **Inbound**: Telegram media → Worker (downloads from Telegram API, stores in R2) → Daemon (fetches from R2, converts to data URI) → Plugin (sends as file part to `prompt_async`)
- **Outbound**: OpenCode file attachments → Plugin (captures FileParts and tool attachments) → Daemon (uploads to R2) → Worker (sends as `sendPhoto`/`sendDocument` reply in Telegram)

Media is stored temporarily in the `pigeon-media` R2 bucket with a 24-hour TTL, cleaned hourly by cron.

### Session Reaper

A background hourly timer in the daemon cleans up stale sessions. Sessions whose `last_seen` is older than `SESSION_TTL_MS` (1 week) are deleted from opencode serve, removed from local storage, and unregistered from the worker.

### Dead Session Cleanup

When command delivery fails with a connection error (ECONNREFUSED, timeout, etc.), the daemon automatically removes the session from local storage. This prevents repeated delivery attempts to a dead plugin process.

Health check URLs are listed in the Quickstart section above.

## Skills TOC

### Worker

- [worker-architecture](.opencode/skills/worker-architecture/SKILL.md)
  - Use when you need endpoint, table, and flow-level system understanding.
- [worker-deployment](.opencode/skills/worker-deployment/SKILL.md)
  - Use when deploying to Cloudflare and validating production health/auth.
- [worker-operations](.opencode/skills/worker-operations/SKILL.md)
  - Use for incident triage, log tailing, quick diagnostics, and rollback steps.
- [worker-troubleshooting](.opencode/skills/worker-troubleshooting/SKILL.md)
  - Use when notifications, webhook auth, or command routing are failing.
- [worker-parity-checks](.opencode/skills/worker-parity-checks/SKILL.md)
  - Use for authenticated parity verification, including notification+reply flow.

### Daemon

- [daemon-architecture](.opencode/skills/daemon-architecture/SKILL.md)
  - Use for daemon module boundaries, storage model, and worker integration flow.
- [daemon-development](.opencode/skills/daemon-development/SKILL.md)
  - Use when implementing or testing daemon routes/services/adapters.
- [daemon-operations](.opencode/skills/daemon-operations/SKILL.md)
  - Use for daemon service health checks, restarts, logs, and burn-in checks.
- [daemon-troubleshooting](.opencode/skills/daemon-troubleshooting/SKILL.md)
  - Use when daemon notifications, command ingest, or injections fail.
- [daemon-cutover-burnin](.opencode/skills/daemon-cutover-burnin/SKILL.md)
  - Use for systemd cutover/revert steps and production stabilization checks.

### OpenCode Plugin

- [opencode-plugin-architecture](.opencode/skills/opencode-plugin-architecture/SKILL.md)
  - Use for plugin event lifecycle, session state, and daemon contract understanding.
- [opencode-plugin-development](.opencode/skills/opencode-plugin-development/SKILL.md)
  - Use when changing plugin handlers, tests, or daemon payload fields.
- [opencode-plugin-deployment](.opencode/skills/opencode-plugin-deployment/SKILL.md)
  - Use when deploying or updating the OpenCode plugin on devbox or via Nix.

### Cross-Cutting

- [secrets-and-auth](.opencode/skills/secrets-and-auth/SKILL.md)
  - Use for sops secret flow, token sources, and auth boundaries.
- [machine-setup-devbox](.opencode/skills/machine-setup-devbox/SKILL.md)
  - Use when onboarding or repairing devbox/macOS machine configuration.
- [cross-device-deployment](.opencode/skills/cross-device-deployment/SKILL.md)
  - Use when deploying pigeon code changes across all machines after merging to main.
