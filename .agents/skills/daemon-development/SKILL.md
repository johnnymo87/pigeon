---
name: daemon-development
description: Use when implementing daemon route, service, storage, worker, or injector changes with a test-first workflow
---

# Daemon Development Workflow

## When To Use

Use this skill while adding or refactoring daemon behavior.

## Default Workflow

1. Add/adjust tests first in `packages/daemon/test/*`.
2. Implement in a focused module (`app`, `storage`, `worker`, `notification-service`, `adapters`).
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

## Adapter Pattern

- `CommandDeliveryAdapter` interface lives in `adapters/`. New delivery transports implement it.
- Routing logic selects adapter based on session transport metadata.
- Testing: inject `createAdapter` factory for routing tests; inject `exec` for nvim subprocess tests (avoid real nvim in CI).

## Guardrails

- Prefer additive schema changes with explicit cleanup rules.
- Keep route logic thin; push behavior into services/repos.

## Verify

Expected:

- daemon tests pass
- daemon typecheck passes
- no parity regressions in route shape
