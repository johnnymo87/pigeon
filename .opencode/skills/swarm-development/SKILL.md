---
name: swarm-development
description: Use when implementing or testing swarm IPC features (new kinds, channels, plugin tools, or schema changes) with a TDD-first workflow
---

# Swarm IPC Development

## When To Use

Use this while adding or refactoring swarm subsystem behavior — new message kinds, broadcast channels, additional plugin tools, schema changes, or arbiter/registry tuning.

## Default Workflow

1. Add tests first in `packages/daemon/test/swarm-*.test.ts` (or `packages/opencode-plugin/test/swarm-tool.test.ts` for plugin-side changes).
2. Implement in the focused module (`storage/swarm-*`, `swarm/*`, `app.ts` route block, plugin `swarm-tool.ts`).
3. Run package checks (`npm run --workspace @pigeon/daemon test` and/or `--workspace @pigeon/opencode-plugin test`).
4. Run workspace checks if you touched a contract (`npm run test`, `npm run typecheck`).

## Test Patterns

The swarm subsystem has six test files at the time of writing. Each one demonstrates a specific test idiom; reuse them.

| Test file | Pattern |
|---|---|
| `test/swarm-repo.test.ts` | Pure SQLite round-trip via `openStorageDb(":memory:")`. Reach for this for any storage-layer change. |
| `test/swarm-envelope.test.ts` | Pure function tests for the renderer. No DB, no fakes. |
| `test/swarm-registry.test.ts` | TTL cache + injected `fetchFn` and `nowFn`. Use this pattern whenever testing time-sensitive caching. |
| `test/swarm-arbiter.test.ts` | Inject fakes for `opencodeClient` and `registry`. Use `vi.fn` for `sendPrompt` and assert call shape + state transitions. |
| `test/swarm-routes.test.ts` | Drive the route via `createApp(storage, opts)(new Request(...))`. Same pattern used by other route tests in the daemon. |
| `test/swarm-routes.integration.test.ts` | The race-fix proof. Fires concurrent POSTs, drives the arbiter via `processOnce()`, asserts no overlap by sorting `inflight[].startedAt` and checking `finishedAt[i] <= startedAt[i+1]`. |

## Test Pitfalls

- **`noUncheckedIndexedAccess` is ON in `tsconfig.json`.** Array indexing returns `T | undefined`. Test code that does `arr[0].foo` fails to compile; use `arr[0]!.foo` (non-null assertion). This bit Task 4 during initial development.
- **`StorageDb.swarm` is mandatory.** Any test that builds a `StorageDb` mock by hand needs to include a `swarm` field; usually easier to use `openStorageDb(":memory:")` instead.
- **Vitest has `import { vi } from "vitest"`.** Existing daemon tests use `vi.fn()` for stubs (see `model-ingest.test.ts` for a reference). Do not reach for `jest.fn`.
- **Real HTTP servers** are sometimes useful (e.g. for the registry talking to a fake opencode serve). The pattern is in `packages/opencode-plugin/test/daemon-client.test.ts`'s `createTestServer()` helper — copy it if needed; it bridges `node:http` to a `Request → Response` handler.

## Key Contracts To Preserve

- **`POST /swarm/send` returns 202 immediately.** Senders rely on fire-and-forget semantics; never await the actual delivery in the route handler.
- **`msg_id` is the idempotency key.** Inserting the same `msg_id` twice must be a no-op (the SQL has `INSERT OR IGNORE`). Tests should assert this.
- **Inbox returns only `handed_off` messages.** Don't accidentally include `queued` or `failed` — the inbox is the receiver's view of "what successfully arrived in my transcript", not a queue inspector.
- **Arbiter must not have two `prompt_async` calls in flight per target.** The `inflight: Map<target, Promise>` in `arbiter.ts` enforces this. Any refactor that loses this invariant must be caught by `swarm-routes.integration.test.ts` failing.
- **Envelope schema version `v="1"` is part of the wire contract.** A breaking change to envelope shape requires bumping `v` and a coordinated rollout (receiving agents need to know the new fields).

## Adding A New Message Kind

The kind is just a string; the daemon stores and forwards it without interpretation. To add a new kind:

1. Add it to the kinds table in `assets/opencode/skills/swarm-messaging/SKILL.md` (workstation repo) so receiving agents know about it.
2. Optionally add a smoke test in `swarm-routes.test.ts` that exercises the round-trip.
3. No daemon-code changes required — the routing is opaque.

## Adding A New Plugin Tool

If you want to add another swarm tool alongside `swarm.read` (e.g. `swarm.subscribe`, `swarm.list-channels`):

1. Define a pure helper in `packages/opencode-plugin/src/swarm-tool.ts` (or a new file) that takes injectable `fetchFn`. Test it with the patterns in `swarm-tool.test.ts`.
2. Add a `createSwarmXTool(daemonBaseUrl)` factory using `tool({...})` from `@opencode-ai/plugin/tool`.
3. Register it in the `Hooks.tool` map in `packages/opencode-plugin/src/index.ts`:
   ```ts
   tool: {
     "swarm.read": createSwarmReadTool(daemonUrl),
     "swarm.subscribe": createSwarmSubscribeTool(daemonUrl),
   },
   ```

**Critical import detail (gotcha):** import from `@opencode-ai/plugin/tool` (subpath), NOT `@opencode-ai/plugin`. The upstream package's compiled JS uses extensionless ESM imports (`import "./tool"`) which Node ESM rejects, but the explicit `./tool` subpath export resolves correctly. See `opencode-plugin-development` skill for more on this.

## Schema Changes

The daemon initializes the schema at startup via `initSwarmSchema(db)` (called from `openStorageDb()`). It's an idempotent `CREATE TABLE IF NOT EXISTS` — additive changes are simple, breaking changes need a real migration story (we don't have one yet).

**Prefer additive changes**:
- New nullable column → `ALTER TABLE swarm_messages ADD COLUMN ...` in `swarm-schema.ts` after the create-table.
- New index → another `CREATE INDEX IF NOT EXISTS`.
- New table → another `CREATE TABLE IF NOT EXISTS` block in `initSwarmSchema`.

## Common Commands

```bash
npm run --workspace @pigeon/daemon test
npm run --workspace @pigeon/daemon test -- swarm
npm run --workspace @pigeon/daemon typecheck

npm run --workspace @pigeon/opencode-plugin test
npm run --workspace @pigeon/opencode-plugin typecheck

npm run test                # workspace-wide
npm run typecheck           # workspace-wide
```

## Guardrails

- Never introduce blocking I/O in the route handler. POST returns 202; the arbiter does the work later.
- Never let a tight retry loop hammer opencode serve. The arbiter's `return` in the catch block stops the inner-loop drain on first error per target per tick — preserve this.
- Never call `sendPrompt` directly from the route handler. The arbiter is the single writer.
- Keep the registry TTL conservative (5min). Stale `directory` is the only thing that can cause envelope misdelivery; don't bump TTL without thinking through invalidation triggers.

## Verify

Expected:

- swarm tests pass (currently 28 across the 6 swarm test files)
- daemon and plugin typecheck pass
- no parity regressions in existing route tests
