# Pigeon Agent Guide

This repo uses agent skills in `.agents/skills`.

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

- `worker-architecture` -> `.agents/skills/worker-architecture/SKILL.md`
  - Use when you need endpoint, table, and flow-level system understanding.
- `worker-deployment` -> `.agents/skills/worker-deployment/SKILL.md`
  - Use when deploying to Cloudflare and validating production health/auth.
- `worker-operations` -> `.agents/skills/worker-operations/SKILL.md`
  - Use for incident triage, log tailing, quick diagnostics, and rollback steps.
- `worker-troubleshooting` -> `.agents/skills/worker-troubleshooting/SKILL.md`
  - Use when notifications, webhook auth, or command routing are failing.
- `worker-parity-checks` -> `.agents/skills/worker-parity-checks/SKILL.md`
  - Use for authenticated parity verification, including notification+reply flow.

### Daemon

- `daemon-architecture` -> `.agents/skills/daemon-architecture/SKILL.md`
  - Use for daemon module boundaries, storage model, and worker integration flow.
- `daemon-development` -> `.agents/skills/daemon-development/SKILL.md`
  - Use when implementing or testing daemon routes/services/adapters.
- `daemon-operations` -> `.agents/skills/daemon-operations/SKILL.md`
  - Use for daemon service health checks, restarts, logs, and burn-in checks.
- `daemon-troubleshooting` -> `.agents/skills/daemon-troubleshooting/SKILL.md`
  - Use when daemon notifications, command ingest, or injections fail.
- `daemon-cutover-burnin` -> `.agents/skills/daemon-cutover-burnin/SKILL.md`
  - Use for systemd cutover/revert steps and production stabilization checks.

### OpenCode Plugin

- `opencode-plugin-architecture` -> `.agents/skills/opencode-plugin-architecture/SKILL.md`
  - Use for plugin event lifecycle, session state, and daemon contract understanding.
- `opencode-plugin-development` -> `.agents/skills/opencode-plugin-development/SKILL.md`
  - Use when changing plugin handlers, tests, or daemon payload fields.
- `opencode-plugin-deployment` -> `.agents/skills/opencode-plugin-deployment/SKILL.md`
  - Use when deploying or updating the OpenCode plugin on devbox or via Nix.

### Cross-Cutting

- `secrets-and-auth` -> `.agents/skills/secrets-and-auth/SKILL.md`
  - Use for 1Password/sops secret flow, token sources, and auth boundaries.
- `machine-setup-devbox` -> `.agents/skills/machine-setup-devbox/SKILL.md`
  - Use when onboarding or repairing devbox/macOS machine configuration.
- `hooks-session-lifecycle` -> `.agents/skills/hooks-session-lifecycle/SKILL.md`
  - Use for Claude hook setup, session-start/stop flow, and hook debugging.

## Notes

- We keep skills in `.agents/skills` as the canonical source.
- `.claude/skills` is a symlink to `.agents/skills` for Claude compatibility.
- `CLAUDE.md` is a symlink to this file for legacy workflows.
