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
- swarm tool: pure helper happy path, `since` cursor passthrough, HTTP error surfacing, formatter output, factory wiring through `ToolContext.sessionID`. Pattern: see `test/swarm-tool.test.ts`. Use `tool({...})` from `@opencode-ai/plugin/tool` and patch `globalThis.fetch` only when exercising the factory's execute callback (the pure helper takes an injectable `fetchFn`).

## Commands

```bash
npm run --workspace @pigeon/opencode-plugin test
npm run --workspace @pigeon/opencode-plugin typecheck
```

## Guardrails

- keep plugin runtime small and dependency-light
- preserve payload compatibility with daemon routes
- avoid introducing blocking network behavior in event handlers
- **never use raw `globalThis.fetch` to call OpenCode APIs** -- in TUI mode no HTTP server is running on `ctx.serverUrl`. Use the SDK client's in-process fetch extracted at init time (see `opencode-plugin-architecture` skill)
- when calling OpenCode's Hono app via `internalFetch`, pass a `new Request(url.toString(), init)` object, not a bare `URL` -- the in-process Hono `.fetch()` requires a `Request`
- **import `tool` and `ToolDefinition` from `@opencode-ai/plugin/tool` (subpath), NOT `@opencode-ai/plugin`.** The upstream package's compiled JS uses extensionless ESM imports (`import "./tool"`) which Node ESM rejects but the explicit `./tool` subpath export resolves correctly. Bun handles the extensionless form fine; vitest under Node does not. If you ever see `Cannot find module '/.../@opencode-ai/plugin/dist/tool'` from a test or runtime, you imported from the bare package name — switch to the subpath.
- when calling daemon HTTP from a tool's execute callback, use `globalThis.fetch` (the daemon listens on real TCP at `127.0.0.1:4731`, unlike opencode serve in TUI mode). The pure helper should still accept an injectable `fetchFn` for tests.

## Verify

Expected:

- tests pass
- typecheck passes
- no daemon contract regressions
