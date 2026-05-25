# Does PR #28051 fix the dual-plugin-instance event-partition bug?

**Date:** 2026-05-25
**Investigator:** read-only code review across `opencode` v1.15.0 and v1.15.10
**Scope:** verify whether `fix: preserve bus instance context (#28051)` actually closes the bug where `message.updated` and `session.idle` reach disjoint plugin instances on the cloudbox build.

---

## 1. Verdict

> **#28051 alone does NOT fix the bug. v1.15.5+ (which contains #28051 PLUS the prerequisite #27825 PLUS #27959) DOES fix the `message.updated` half of the partition with high confidence. The `session.idle` half is fixed by the SAME work in aggregate, but the precise mechanism for the dual-plugin-instance partition is still partially hypothetical.**

- **#28051 in isolation:** would not even *compile* against v1.15.0 (it requires #27825 to land first).
- **v1.15.5 / v1.15.10 (which include #27825 + #28051 + #27959 + #28187):** unambiguously rewrite the `message.updated` publish path so publisher and subscriber resolve to the same `Bus.Service` and the same per-directory `state.wildcard` PubSub. **High confidence the `message.updated` half is fixed.**
- **`session.idle` half:** less obvious from code alone. The publisher (status.ts:81) already used the injected service, so the partition for `session.idle` must originate from a DIFFERENT mechanism than the message.updated one — most likely there are two distinct `state` cache entries per directory because the publisher and subscriber resolved `InstanceState.directory` differently. The whole-tree changes in v1.15.5 (especially `bridge.fork(Effect.gen(...))` with captured InstanceRef in #28187) plug the most plausible holes. **Medium confidence the `session.idle` half is also fixed.**

**Overall confidence v1.15.5+ ends the silent-stop-notifications symptom: high.**
**Overall confidence in the precise mechanism for the partition: medium.**

The user's chosen path (rebase to v1.15.5) is correct. A `#28051`-only cherry-pick would not have worked.

---

## 2. Evidence chain

### 2.1 Publishers — where `message.updated` originates

`MessageV2.Event.Updated` is defined as a **SyncEvent**, not a BusEvent:

- `packages/opencode/src/session/message-v2.ts:517-523` — `Updated: SyncEvent.define({ type: "message.updated", version: 1, aggregate: "sessionID", schema: UpdatedEventSchema })`
- `packages/opencode/src/session/session.ts:617-621` — `updateMessage` calls `yield* sync.run(MessageV2.Event.Updated, { sessionID, info })`
- `sync.run` is `SyncEvent.Service.run` at `packages/opencode/src/sync/index.ts:141`

At **v1.15.0**, `SyncEvent.run` → `process()` → `Database.effect(() => ...)`:

```ts
// packages/opencode/src/sync/index.ts:344-371 @ v1.15.0
Database.effect(() => {
  if (options?.publish) {
    ...
    const publish = (data: unknown) =>
      ProjectBus.publish(def, data as Properties<Def>, { id: event.id })  // ← MODULE-LEVEL
    ...
  }
})
```

`ProjectBus.publish` is the **module-level** function at `bus/index.ts:187-193`:

```ts
// packages/opencode/src/bus/index.ts:187-193 @ v1.15.0
export async function publish<D extends BusEvent.Definition>(...) {
  return runPromise((svc) => svc.publish(def, properties, options))  // ← bus's OWN ManagedRuntime
}
```

…where `runPromise` is from a **separate** `ManagedRuntime` at `bus/index.ts:179`:

```ts
const { runPromise, runSync } = makeRuntime(Service, layer)
```

### 2.2 Publishers — where `session.idle` originates

`session.idle` is defined as a **BusEvent**:

- `packages/opencode/src/session/status.ts:43-48` — `Idle: BusEvent.define("session.idle", Schema.Struct({ sessionID }))`

Published via the **service** interface, not module-level:

```ts
// packages/opencode/src/session/status.ts:77-86
const set = Effect.fn("SessionStatus.set")(function* (sessionID, status) {
  const data = yield* InstanceState.get(state)
  yield* bus.publish(Event.Status, { sessionID, status })
  if (status.type === "idle") {
    yield* bus.publish(Event.Idle, { sessionID })   // ← INJECTED bus service
    ...
  }
})
```

`bus` is captured from `yield* Bus.Service` at the SessionStatus layer level (status.ts:62). The fiber publishing `session.idle` was started by `SessionRunState.runner.onIdle` (run-state.ts:59-62), invoked via `Runner.startRun` → `Effect.forkIn(scope)`, where `scope` is the per-directory state scope.

### 2.3 Subscriber — the plugin

The pigeon plugin subscribes via `Plugin.layer` which uses `Bus.Service`:

```ts
// packages/opencode/src/plugin/index.ts:113, 117, 246-255
const bus = yield* Bus.Service
const state = yield* InstanceState.make<State>(
  Effect.fn("Plugin.state")(function* (ctx) {
    ...
    yield* bus.subscribeAll().pipe(  // (in patched build: yield* (yield* bus.subscribeAll()).pipe(...))
      Stream.runForEach((input) => Effect.sync(() => {
        for (const hook of hooks) void hook["event"]?.({ event: input as any })
      })),
      Effect.forkScoped,
    )
    return { hooks }
  }),
)
```

`bus.subscribeAll()` (`bus/index.ts:121-129` v1.15.0 or `bus/index.ts:130-136` patched) calls `InstanceState.get(state)` internally, which uses the **directory** from the current fiber's `InstanceRef` (or `Instance.current` ALS as fallback) as the cache key.

### 2.4 The cache key resolution at v1.15.0 (the suspect)

`packages/opencode/src/effect/instance-state.ts:28-30 @ v1.15.0`:

```ts
export const context = Effect.gen(function* () {
  return (yield* InstanceRef) ?? Instance.current
})
```

`Instance.current` reads from a Node `AsyncLocalStorage` (`packages/opencode/src/project/instance.ts:5-17`). So at v1.15.0, the cache key is whichever source has a value: prefer `InstanceRef`, fall back to ALS.

`packages/opencode/src/effect/instance-state.ts:61-64`:

```ts
export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.get(self.cache, yield* directory)
  })
```

So bus's per-directory `state` cache is keyed by whatever `InstanceState.directory` resolves to in the current fiber.

### 2.5 Why this CAN partition events

Two paths reach `InstanceState.get(busState)`:

1. **Subscriber path** (plugin):
   `Plugin.state` lookup → `bus.subscribeAll()` → `InstanceState.get(busState)` →
   directory is read from `InstanceRef` on the fiber that materialized `Plugin.state` for this directory.

2. **Publisher path for `message.updated`** (v1.15.0):
   `Session.updateMessage(msg)` → `sync.run(...)` → `Database.transaction(...)` → `Database.effect(fn)` queues `InstanceState.bind(fn)` → tx commits → bound callback fires → callback calls `ProjectBus.publish(...)` (module-level) → bus's own `ManagedRuntime.runPromise(...)` → `attach()` provides `InstanceRef` from `Instance.current` (ALS) or current fiber's `InstanceRef` → `svc.publish` runs → `InstanceState.get(busState)`.

The publisher path goes through TWO context-restoration hops (`InstanceState.bind` capture, then `attach()` re-capture) and uses a SEPARATE `ManagedRuntime`. Each hop is a place context can be lost or replaced.

3. **Publisher path for `session.idle`** (v1.15.0):
   `processor.set status idle` → `status.set(sessionID, idle)` → `bus.publish(Event.Idle, ...)` directly on the injected bus service → `svc.publish` runs in the SAME fiber → `InstanceState.get(busState)`.

The two publish paths land in fibers with potentially DIFFERENT `InstanceRef`/`Instance.current` resolution semantics — particularly because path #2 goes through `InstanceState.bind` → captured ctx → `Instance.restore` (ALS) → re-read by `attach()`, while path #3 stays in Effect-land the entire time.

**If the per-directory cache returns two distinct `state` objects** — one keyed by the version of directory string the subscriber saw, and one by the version the publisher fiber saw — you get exactly the observed partition.

### 2.6 Why `ScopedCache` doesn't necessarily save you

`InstanceState.make` (instance-state.ts:38-59) wraps each `state` in a `ScopedCache` keyed by `directory` string. With memoization, two `cache.get(key)` calls with the SAME key should return the same value.

But:

- `InstanceStore.load` has a TOCTOU race (`instance-store.ts:106-114`): `cache.get(dir); cache.set(dir, entry)` is not atomic across concurrent fibers, so two concurrent `load("/path/foo")` calls can produce two distinct `InstanceContext` objects sharing the same `.directory` string, both bootstrapped, both running `plugin.init()`. Reported in the handoff doc: "directory `mono/.worktrees/pr-3188` bootstrap TWICE within 18ms with the plugin loading both times."
- Even with two ctxs, both have the same `.directory` string, so PLUGIN's `state` cache SHOULD dedupe → only ONE plugin hook list, ONE `bus.subscribeAll()` call → ONE wildcard PubSub subscription.
- So a second plugin hook list would require either (a) cache invalidation between subscribers, (b) a distinct `Plugin.Service` instance per `boot()`, or (c) BUS having two `state` entries per directory.

Given the deterministic, perfectly-by-event-type partition (49/0 vs 0/1), option (c) is the most consistent with the data: **two `state` cache entries exist per directory, one populated by the message.updated publish path and one populated by the session.idle path. Each plugin instance subscribed to whichever wildcard was the "current" entry when its `bus.subscribeAll()` ran.**

This is consistent with a `ScopedCache` lookup that — under specific concurrency timing in v1.15.0's ALS-bridged callback path — slipped past dedup. I have not located the exact ScopedCache code path proving this, so the mechanism is hypothetical, but it matches the empirical signature exactly.

### 2.7 What v1.15.5 actually changes (and why this fixes it)

Five upstream commits land between v1.15.0 and v1.15.5 that touch this surface (full list from `git log v1.15.0..v1.15.5 -- packages/opencode/src/{sync,bus}`):

| Commit | PR | Title | Date | Effect |
|--------|-----|-------|------|--------|
| `12b666e2c` | #27714 | refactor(project): import instance context directly | May 15 | groundwork |
| `53849bd86` | **#27825** | **fix(sync): publish events on injected project bus** | **May 16** | **see below** |
| `23b594de6` | **#28051** | fix: preserve bus instance context | May 17 | adds `ctx: InstanceContext` param to module-level `Bus.publish` and 6 callsites |
| `cb3549324` | #27959 | fix(bus): acquire PubSub subscription eagerly | May 18 | eager subscribe (already in our patched build) |
| `159d271e1` | #28187 | refactor(sync): publish via EffectBridge.fork | May 18 | replaces #27825's attachWith with EffectBridge.fork |

The **load-bearing fix** for `message.updated` is **#27825**, not #28051:

```ts
// sync/index.ts after #27825 (line numbers per v1.15.5)
const bus = yield* ProjectBus.Service   // ← captured at layer init

// inside process():
const publish = (data: unknown) =>
  Effect.runPromise(
    attachWith(options.bus.publish(def, data as Properties<Def>, { id: event.id }), {
      instance: options.context?.instance,
      workspace: options.context?.workspace,
    }),
  )
```

This uses the SAME `Bus.Service` instance that subscribers use, and explicitly threads the captured `instance` context. No more module-level `ProjectBus.publish` for sync events, no more separate `ManagedRuntime`, no more reliance on `Instance.current` ALS surviving the Database.effect deferral.

**#27825 makes the cherry-pick of #28051 even possible**: without #27825, `sync/index.ts:351` would still call `ProjectBus.publish(def, data, {id})` with the OLD signature, which #28051 changes to require `ctx: InstanceContext` as the first parameter. The two commits are a pair — #27825 removes the old callsite, #28051 forces all remaining callers to thread context explicitly.

**#28187 is a refactor on top of #27825** using `EffectBridge.fork(Effect.gen(...))` with captured `InstanceRef`/`WorkspaceRef`/`Effect.context()`. Functionally equivalent for our purpose.

### 2.8 Other relevant v1.15.5 changes

- **`refactor(instance): remove legacy runtime fallback (#27757)`**, commit `0c9cfe923`, in v1.15.5+: removes the `Instance.current` ALS fallback from `InstanceState.context`. Post-#27757:

  ```ts
  // effect/instance-state.ts in v1.15.10
  export const context = Effect.gen(function* () {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die(new Error("InstanceRef not provided"))
    return ctx
  })
  ```

  This eliminates the entire "ALS fallback might resolve to a different ctx than InstanceRef" class of bugs. Combined with #27825 + #28051 it makes the publisher/subscriber context resolution deterministic.

- **`refactor(instance): remove remaining bind call sites (#27731)`**, commit `fa9a2cb24`: replaces `InstanceState.bind` with `EffectBridge.bind` in `storage/db.ts`. The new `EffectBridge.bind` (in v1.15.10's `effect/bridge.ts:27-37`) explicitly captures `InstanceRef` at registration time and re-provides it via `attachWith` at invocation time — same intent as v1.15.0's `Instance.restore(ctx, ...)`, but going through Effect-land instead of ALS.

---

## 3. The actual bug, in my assessment

**Two complementary bugs caused the symptom:**

### Bug A — `message.updated` publish runs on the wrong runtime / wrong context

In v1.15.0, `sync/index.ts:351` invoked the **module-level** `ProjectBus.publish(...)`, which calls `runPromise` on a SEPARATE `ManagedRuntime` (bus/index.ts:179). Even with `memoMap` deduping `Bus.layer` itself, this path adds two extra context-restoration hops:
1. `Database.effect(fn)` → `InstanceState.bind(fn)` captures ctx, returns a wrapper that does `Instance.restore(ctx, fn)` (sets ALS).
2. Wrapper invokes `ProjectBus.publish(...)` → bus's `runPromise(...)` → `attach()` re-reads ALS/`Fiber.getCurrent()` to provide `InstanceRef`.

In normal (sequential) operation this round-trips correctly. Under concurrency — particularly when transactions defer multiple `Database.effect` callbacks that fire in sequence on the same tick — the ALS state can become entangled with whichever fiber last entered the runtime, since the bus's runtime is shared across all directories. The resulting `InstanceState.directory` lookup may NOT match the directory the original `sync.run` was for.

**#27825 fixes this by removing the round-trip entirely**: sync now uses the injected `options.bus.publish` on the same `Bus.Service` the subscriber uses, with `attachWith({ instance: options.context?.instance, ... })` providing the captured ctx explicitly. **#28187 polishes the mechanism** to use `EffectBridge.fork` with full context capture.

### Bug B — Plugin's per-directory `state` was potentially materialized more than once

The empirical evidence shows TWO plugin instances per directory. Even with a deduplicating `ScopedCache`, this can happen if:
- `InstanceStore.load(dir)` races and creates two `InstanceContext` objects (the TOCTOU at instance-store.ts:106-114).
- Each bootstrap calls `plugin.init()` which calls `InstanceState.get(pluginState)`.
- If the two calls hit `pluginState.cache` with the directory string at slightly different times, AND if any other code path invalidates/repopulates between them, you could end up with two distinct `Plugin.state` materializations.

Each materialization runs `bus.subscribeAll()` independently. **If `bus.state.cache` ALSO has two entries** (due to publisher-side and subscriber-side directory resolution diverging), the two plugin instances end up subscribing to DIFFERENT `wildcard` PubSubs.

Then:
- All `message.updated` publishes (going through the indirect sync.ts path) land in PubSub-A → plugin-instance-A receives them.
- All `session.idle` publishes (going through the direct `bus.publish` path) land in PubSub-B → plugin-instance-B receives them.

The partition is deterministic and by-event-type precisely because the publisher-side `InstanceState.directory` resolution is consistent within a publish path (always uses path-1's bus-state-A entry for message.updated; always uses path-2's bus-state-B entry for session.idle).

**This is the missing piece I cannot fully prove from code alone** — I cannot find a definitive code path that creates two entries in `ScopedCache` for the same key. But it's the only hypothesis that fits the data, and the v1.15.5+ changes (#27825 + #27757 + #28051 + #28187) collectively eliminate every plausible mechanism that could create the divergence:
- #27825 removes the ALS-bridged separate-runtime publish path that was the most likely culprit for context divergence.
- #27757 removes the `Instance.current` ALS fallback entirely, so `InstanceState.directory` has exactly ONE source of truth (`InstanceRef`).
- #28051 forces remaining direct-publish callsites to thread `ctx` explicitly.
- #28187 captures full `Effect.context()` at bridge time, so the publish fiber inherits the entire publisher context including `InstanceRef`.

---

## 4. What would actually fix it

Three remediation options, in order of preference:

### Option A (chosen, recommended) — rebase to v1.15.5
Brings in all four fixes (#27757, #27825, #28051, #28187) as a coherent set. The user's existing plan in `2026-05-22-bus-fix-investigation-HANDOFF.md`. **This is the right answer.**

### Option B — minimal cherry-pick stack (not recommended)
If for some reason rebasing is impossible, the minimum viable cherry-pick chain would be:
1. `12b666e2c` (#27714) — refactor instance context import (probably required as prereq for the next ones)
2. `53849bd86` (#27825) — sync publishes on injected bus — **this is the core fix**
3. `0c9cfe923` (#27757) — remove legacy ALS fallback
4. `fa9a2cb24` (#27731) — replace `InstanceState.bind` with `EffectBridge.bind`
5. `23b594de6` (#28051) — preserve bus instance context

#28187 is optional (refactor on top of #27825). #27959 is already in the build.

This is fragile because each cherry-pick may touch unrelated files (e.g., #27757's diff is 47 files, including test infrastructure). **Rebasing to v1.15.5 is strictly easier.**

### Option C (NOT recommended) — cherry-pick only #28051
This **will not compile** because #27825 hasn't removed the v1.15.0 sync.ts callsite that calls `ProjectBus.publish(def, ...)` with the old (no-`ctx`) signature.

---

## 5. Open questions

What evidence would convert "medium" → "high" confidence on the mechanism?

1. **Direct observation of two `state.wildcard` PubSubs.** Instrument `bus/index.ts:52` to log the address (object identity) of the `state` object each time `InstanceState.get(state)` resolves it. If we observe two distinct `state` objects for the same directory string, Bug-B-via-cache-divergence is proven. If we observe ONE `state` but multiple subscriptions to its wildcard, the partition theory is wrong and we need to look at PubSub fan-out semantics.

2. **Direct observation of which fiber's `InstanceRef` `Bus.publish` resolves.** Wrap `bus/index.ts`'s `publish` (inside `Effect.gen`) with a log of `(yield* InstanceRef)?.directory` BEFORE the `InstanceState.get(state)` call. For each `message.updated` and `session.idle` event, log the resolved directory. If both resolve to the same directory string but to different `state` objects, that confirms the ScopedCache divergence.

3. **A reproducer in `packages/opencode/test/bus/bus-effect.test.ts` or `test/effect/instance-state.test.ts`** that demonstrates two concurrent `ScopedCache.get` calls for the same key producing two distinct cached values. I did NOT find an existing test exposing this, and I did NOT attempt to write one (per the read-only constraint). If such a test exists upstream and was added in v1.15.5, that would be the strongest evidence.

4. **Comparison with v1.15.5 SMOKE TEST results on cloudbox.** The user's plan says the validation criteria are:
   - `/launch cloudbox pigeon hi pigeon` produces a Telegram reply.
   - Plugin log shows `type=* subscribing` firing **once** per directory at startup.
   - Plugin log shows the full notification chain.

   If after deploying v1.15.5 the `subscribing` log fires exactly ONCE per directory and the partition disappears, that empirically proves the dual-instance cause is gone.

5. **Whether `Plugin.state` is materialized once or twice per directory in v1.15.5.** Add an instrumentation log at `plugin/index.ts:118` inside the `Effect.fn("Plugin.state")(function* (ctx) {...})` body, logging directory + a random instanceId. Count in the logs.

   If the diagnostic instrumentation in `git stash@{0}` is rebuilt and deployed on v1.15.5 and shows ONE instanceId per directory, that's the high-confidence signal.

---

## Appendix A — file/line references used

- **bus** v1.15.0: `/home/dev/projects/opencode/packages/opencode/src/bus/index.ts`
  - Service interface: lines 32-45
  - layer + state: lines 49-74
  - publish (service): lines 87-108
  - subscribe (lazy stream): lines 110-119
  - module-level publish: lines 187-193
  - separate ManagedRuntime: line 179
- **bus** v1.15.10: post-#28051 module-level `publish(ctx, def, ...)` at end of file.
- **sync** v1.15.0: `/home/dev/projects/opencode/packages/opencode/src/sync/index.ts`
  - `run`: lines 141-181
  - `process` calling module-level publish: lines 344-371 (line 351 is the smoking gun)
- **sync** v1.15.10: `process` uses `options.bridge.fork(Effect.gen(function* () { yield* options.bus.publish(...) }))`.
- **status** (publisher of `session.idle`): `/home/dev/projects/opencode/packages/opencode/src/session/status.ts:77-86`
- **message-v2** (defines `message.updated`): `/home/dev/projects/opencode/packages/opencode/src/session/message-v2.ts:517-523`
- **session.updateMessage**: `/home/dev/projects/opencode/packages/opencode/src/session/session.ts:617-621`
- **plugin layer & subscribe**: `/home/dev/projects/opencode/packages/opencode/src/plugin/index.ts:110-258`
- **instance-state** v1.15.0: `/home/dev/projects/opencode/packages/opencode/src/effect/instance-state.ts`
  - `context` with ALS fallback: lines 28-30
  - `bind`: lines 16-26
  - `get` keyed on directory: lines 61-64
- **instance-store** (TOCTOU race): `/home/dev/projects/opencode/packages/opencode/src/project/instance-store.ts:102-118`
- **Database.effect**: `/home/dev/projects/opencode/packages/opencode/src/storage/db.ts:169-176`
- **EffectBridge.bind** (v1.15.10): `packages/opencode/src/effect/bridge.ts:27-37`
- **run-service.attach**: `/home/dev/projects/opencode/packages/opencode/src/effect/run-service.ts:26-41`

## Appendix B — commit log between v1.15.0 and v1.15.10 (relevant files only)

```
$ git log --oneline v1.15.0..v1.15.10 -- packages/opencode/src/{bus,sync,event-v2-bridge,plugin,effect/instance-state,project/instance-store,storage/db}.ts packages/opencode/src/bus packages/opencode/src/sync packages/opencode/src/effect/instance-state.ts

b32debb8a  feat(opencode): add xAI Grok OAuth (#28557)            [bus/index.ts]
ddf18a7f9  test(server): port event SSE tests (#28569)             [bus]
661df8fcf  fix(opencode): register account events in EventV2 (#28555) [event-v2-bridge]
8643c0721  Rename v2 auth service to account (#28260)              [bus]
cb3549324  fix(bus): acquire PubSub subscription eagerly (#27959)  [bus]
23b594de6  fix: preserve bus instance context (#28051)             [bus]
0c9cfe923  refactor(instance): remove legacy runtime fallback (#27757) [instance-state]
12b666e2c  refactor(project): import instance context directly (#27714) [instance-state]
159d271e1  refactor(sync): publish via EffectBridge.fork (#28187)  [sync]
53849bd86  fix(sync): publish events on injected project bus (#27825) [sync]
fa9a2cb24  refactor(instance): remove remaining bind call sites (#27731) [db]
356f68418  refactor(flags): migrate skip migrations flag (#27705)  [db]
39ea816a7  refactor(opencode): roll out serviceUse proxy (#28576)  [instance-store]
```
