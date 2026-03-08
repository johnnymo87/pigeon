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

## Usage

Pigeon is a Telegram bot that routes commands to machines running opencode.
Messages flow: Telegram → Worker (Cloudflare) → Daemon (local) → opencode serve.

### Commands

| Command | Example | What it does |
|---------|---------|--------------|
| *(plain message)* | `fix the failing test in src/auth.ts` | Executes in the current opencode TUI session via the plugin |
| `/launch <machine> <dir> <prompt>` | `/launch devbox ~/projects/pigeon "say hello"` | Starts a headless opencode session on the specified machine |
| `/kill <session-id>` | `/kill sess-abc123` | Terminates a headless session (machine looked up automatically) |

### Attaching to a headless session

From a terminal on the machine, connect to a session launched via `/launch`:

```
opencode attach http://localhost:4096 --session <session-id>
```

The session ID is included in the Telegram confirmation message.

### Notifications

Opencode events (stop, question, error) are sent back to Telegram as replies, tagged with the machine name. Each notification includes the session ID on its own line for easy copy-paste.

### Media Relay

Photos, documents, audio, video, and voice messages sent to the Telegram bot are relayed to OpenCode sessions via R2:

- **Inbound**: Telegram media → Worker (downloads from Telegram API, stores in R2) → Daemon (fetches from R2, converts to data URI) → Plugin (sends as file part to `prompt_async`)
- **Outbound**: OpenCode file attachments → Plugin (captures FileParts and tool attachments) → Daemon (uploads to R2) → Worker (sends as `sendPhoto`/`sendDocument` reply in Telegram)

Media is stored temporarily in the `pigeon-media` R2 bucket with a 24-hour TTL, cleaned hourly by cron.

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
  - Use for 1Password/sops secret flow, token sources, and auth boundaries.
- [machine-setup-devbox](.opencode/skills/machine-setup-devbox/SKILL.md)
  - Use when onboarding or repairing devbox/macOS machine configuration.
- [cross-device-deployment](.opencode/skills/cross-device-deployment/SKILL.md)
  - Use when deploying pigeon code changes across all machines after merging to main.
