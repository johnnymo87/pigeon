# Pigeon Agent Guide

This repo uses agent skills in `.agents/skills`.

Use this file as the quickstart and table of contents for agent-facing docs.

## Quickstart

- Install deps: `bun install`
- Run all tests: `bun run test`
- Run all typechecks: `bun run typecheck`
- Worker package path: `packages/worker`
- Worker health (deployed): `curl https://ccr-router.jonathan-mohrbacher.workers.dev/health`

## Skills TOC

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

## Notes

- We keep skills in `.agents/skills` as the canonical source.
- `.claude/skills` is a symlink to `.agents/skills` for Claude compatibility.
- `CLAUDE.md` is a symlink to this file for legacy workflows.
