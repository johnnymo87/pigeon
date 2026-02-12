---
name: daemon-development
description: Use when implementing daemon route, service, storage, or worker changes with a test-first workflow
---

# Daemon Development Workflow

## When To Use

Use this skill while adding or refactoring daemon behavior.

## Default Workflow

1. Add/adjust tests first in `packages/daemon/test/*`.
2. Implement in a focused module (`app`, `storage`, `worker`, `notification-service`).
3. Run daemon package checks.
4. Re-run workspace checks when interface contracts changed.

## Key Contracts To Preserve

- Route response/status parity for legacy callers.
- Durable inbox semantics (`ack` then local processing).
- Worker protocol fields (`command`, `ack`, `commandResult`).

## Common Commands

```bash
bun run --filter '@pigeon/daemon' test
bun run --filter '@pigeon/daemon' typecheck
bun run test
bun run typecheck
```

## Guardrails

- Prefer additive schema changes with explicit cleanup rules.
- Keep route logic thin; push behavior into services/repos.

## Verify

Expected:

- daemon tests pass
- daemon typecheck passes
- no parity regressions in route shape
