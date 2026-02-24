# Pigeon Agent Guide

This repo uses agent skills in `.opencode/skills`.

Use this file as the quickstart and table of contents for agent-facing docs.

## Quickstart

- Install deps: `bun install`
- Run all tests: `bun run test`
- Run all typechecks: `bun run typecheck`
- Worker package path: `packages/worker`
- Daemon package path: `packages/daemon`
- OpenCode plugin package path: `packages/opencode-plugin`
- Worker health (deployed): `curl https://ccr-router.jonathan-mohrbacher.workers.dev/health`
- Daemon health (local): `curl http://127.0.0.1:4731/health`

## Skills TOC

### Worker

- `worker-architecture` -> `.opencode/skills/worker-architecture/SKILL.md`
  - Use when you need endpoint, table, and flow-level system understanding.
- `worker-deployment` -> `.opencode/skills/worker-deployment/SKILL.md`
  - Use when deploying to Cloudflare and validating production health/auth.
- `worker-operations` -> `.opencode/skills/worker-operations/SKILL.md`
  - Use for incident triage, log tailing, quick diagnostics, and rollback steps.
- `worker-troubleshooting` -> `.opencode/skills/worker-troubleshooting/SKILL.md`
  - Use when notifications, webhook auth, or command routing are failing.
- `worker-parity-checks` -> `.opencode/skills/worker-parity-checks/SKILL.md`
  - Use for authenticated parity verification, including notification+reply flow.

### Daemon

- `daemon-architecture` -> `.opencode/skills/daemon-architecture/SKILL.md`
  - Use for daemon module boundaries, storage model, and worker integration flow.
- `daemon-development` -> `.opencode/skills/daemon-development/SKILL.md`
  - Use when implementing or testing daemon routes/services/adapters.
- `daemon-operations` -> `.opencode/skills/daemon-operations/SKILL.md`
  - Use for daemon service health checks, restarts, logs, and burn-in checks.
- `daemon-troubleshooting` -> `.opencode/skills/daemon-troubleshooting/SKILL.md`
  - Use when daemon notifications, command ingest, or injections fail.
- `daemon-cutover-burnin` -> `.opencode/skills/daemon-cutover-burnin/SKILL.md`
  - Use for systemd cutover/revert steps and production stabilization checks.

### OpenCode Plugin

- `opencode-plugin-architecture` -> `.opencode/skills/opencode-plugin-architecture/SKILL.md`
  - Use for plugin event lifecycle, session state, and daemon contract understanding.
- `opencode-plugin-development` -> `.opencode/skills/opencode-plugin-development/SKILL.md`
  - Use when changing plugin handlers, tests, or daemon payload fields.
- `opencode-plugin-deployment` -> `.opencode/skills/opencode-plugin-deployment/SKILL.md`
  - Use when deploying or updating the OpenCode plugin on devbox or via Nix.

### Cross-Cutting

- `secrets-and-auth` -> `.opencode/skills/secrets-and-auth/SKILL.md`
  - Use for 1Password/sops secret flow, token sources, and auth boundaries.
- `machine-setup-devbox` -> `.opencode/skills/machine-setup-devbox/SKILL.md`
  - Use when onboarding or repairing devbox/macOS machine configuration.
