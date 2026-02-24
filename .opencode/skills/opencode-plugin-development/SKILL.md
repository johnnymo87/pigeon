---
name: opencode-plugin-development
description: Use when developing or refactoring OpenCode plugin handlers, tests, and daemon integration payloads
---

# OpenCode Plugin Development

## When To Use

Use this while implementing plugin behavior changes.

## Workflow

1. Start with tests around event and state transitions.
2. Update daemon client payloads only when route contracts require it.
3. Re-run plugin tests and typecheck.

## Test Focus Areas

- environment detection behavior
- daemon client retries/fallbacks
- message summary extraction
- session state transitions and dedup logic

## Commands

```bash
bun run --filter '@pigeon/opencode-plugin' test
bun run --filter '@pigeon/opencode-plugin' typecheck
```

## Guardrails

- keep plugin runtime small and dependency-light
- preserve payload compatibility with daemon routes
- avoid introducing blocking network behavior in event handlers

## Verify

Expected:

- tests pass
- typecheck passes
- no daemon contract regressions
