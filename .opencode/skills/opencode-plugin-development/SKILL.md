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
- question reply handler (daemon contract + OpenCode API call)

## Commands

```bash
bun run --filter '@pigeon/opencode-plugin' test
bun run --filter '@pigeon/opencode-plugin' typecheck
```

## Guardrails

- keep plugin runtime small and dependency-light
- preserve payload compatibility with daemon routes
- avoid introducing blocking network behavior in event handlers
- **never use raw `globalThis.fetch` to call OpenCode APIs** -- in TUI mode no HTTP server is running on `ctx.serverUrl`. Use the SDK client's in-process fetch extracted at init time (see `opencode-plugin-architecture` skill)
- when calling OpenCode's Hono app via `internalFetch`, pass a `new Request(url.toString(), init)` object, not a bare `URL` -- the in-process Hono `.fetch()` requires a `Request`

## Verify

Expected:

- tests pass
- typecheck passes
- no daemon contract regressions
