# InstanceState partition fix — design

**Status:** Approved design. Implementation plan pending in companion doc.
**Date:** 2026-05-26
**Author:** Jonathan + opencode session `ses_1ae86b8b4ffetT0PJXWmeNM63O`

This design addresses the residual `InstanceState` partition bug that PR #27825 (in v1.15.10) did NOT fix. See the [bus fix investigation handoff](2026-05-22-bus-fix-investigation-HANDOFF.md) for the full investigation history and the [v1.15.10 verification report](2026-05-25-28051-verification-report.md) for what #27825 did and didn't change.

## 1. Problem statement

### Symptoms

Two confirmed user-visible failure modes from one underlying cause:

**Failure mode A: Question dialogs hang.** The TUI shows a prompt from the `Question` tool. User picks an option. Server-side `Question.reply` logs `reply for unknown request` because the pending-question map is empty for that request ID. The `Question.ask` Deferred never resolves; no `question.replied` event fires; the TUI never dismisses the prompt. User cannot submit a different answer, cannot Esc, cannot Ctrl-C. Recovery: kill the parent terminal.

Reproduction: ANY single-option question via the `Question` tool. Deterministic, immediate.

Evidence from log `2026-05-26T025259.log`, question `que_e623a2ff20011WCv63s7EeQW9X`:

```
03:00:41  service=question id=que_e623a2ff... questions=1 asking
03:00:49  service=question requestID=que_e623a2ff... reply for unknown request
03:01:23  service=question requestID=que_e623a2ff... reply for unknown request
03:01:41–03:02:09  22 "reject for unknown request" warnings over 30s
```

User mashed submit then escape repeatedly. None reached the registered `ask`.

**Failure mode B: Random Telegram stop-notification drops under load (historical).** Prior to v1.15.10, the bus partition (#27825) meant `message.updated` events landed on one plugin instance while `session.idle` landed on another. PR #27825 made each session's events route consistently to a single instance. That paper-fixed failure mode B for the bus path, but the underlying `InstanceState` partition still exists and will manifest in any other code path that crosses fiber boundaries (e.g., HTTP-handler fiber ↔ tool-execution fiber).

### Root mechanism

`creating instance` log events fire TWICE for the same directory string at startup, within ~50ms, with no `disposing instance` between them:

```
02:53:02  service=default directory=/home/dev/projects/pigeon creating instance
02:53:02  service=default directory=/home/dev/projects/pigeon creating instance
```

Reproduced for `/home/dev/projects/pigeon`, `/home/dev/projects/mono`, and `/home/dev/projects/mono/.worktrees/pr-3188`.

Two `Plugin.layer` initializations follow, each materializing a separate pigeon plugin instance (plugin instrumentation confirms: instances `qpoj5ido` and `hwdykzwf` both for `/home/dev/projects/pigeon`). Each `Plugin.layer` init creates its own `InstanceState` ScopedCache. Each `Question.layer` init does the same. The result: two parallel "instance trees" per directory, each with its own pending-question map.

When `Question.ask` runs from a tool-execution fiber, it stores in pending map A. When `Question.reply` runs from an HTTP-handler fiber, it reads from pending map B. The request ID is not in B → `reply for unknown request` → form hangs.

### Architectural invariant violation

The codebase's documented invariant is "one `InstanceContext` per directory" ([packages/opencode/specs/effect/instance-context.md](../../../opencode/packages/opencode/specs/effect/instance-context.md)). The two-`creating instance`-events-per-directory behavior violates that invariant. The system *appears* to work because each session's events consistently land in one of the two instances — but boundary-crossing code paths (HTTP ↔ tool, plugin ↔ service) can resolve to different instances.

### Out of scope

- Fixing the bus-publish partition: already done in v1.15.10 via #27825/#28051.
- Refactoring `InstanceState` semantics: too broad a change. We're keeping the contract, fixing the violation.
- Auditing every `InstanceState.make` callsite for partition vulnerability: each will be fixed by the root fix.

## 2. Hypothesis space

Three candidate causes for the dual `InstanceStore.Service` materialization. The diagnostic step (Section 3) tells us which is real.

### Hypothesis A — memoMap dedup failure for `InstanceLayer`

The process-wide `memoMap` ([core/src/effect/memo-map.ts](../../../opencode/packages/core/src/effect/memo-map.ts)) is supposed to dedupe Layer outputs across runtimes built with `{ memoMap }`. Both `AppRuntime` ([effect/app-runtime.ts:119](../../../opencode/packages/opencode/src/effect/app-runtime.ts)) and the HTTP `webHandler` ([server/server.ts:247](../../../opencode/packages/opencode/src/server/server.ts), via [routes/.../server.ts:250](../../../opencode/packages/opencode/src/server/routes/instance/httpapi/server.ts)) pass it.

`InstanceLayer.layer` ([project/instance-layer.ts:4](../../../opencode/packages/opencode/src/project/instance-layer.ts)) is defined as `Layer.unwrap(Effect.promise(async () => { ... }))`. The async import inside the promise may produce a fresh inner `Layer` instance per evaluation. If memoMap keys on the outer Layer's identity and that identity is stable but the inner one isn't, memoMap might not dedupe `InstanceStore.Service` across the two runtimes.

**Diagnostic signal:** Two `creating instance` events show DIFFERENT `serviceId` values (each runtime has its own `InstanceStore.Service` instance). Stack traces show one call-tree from `AppRuntime.runPromise` (or an HTTP handler tree that resolved AppRuntime's binding) and one from a different routing path.

### Hypothesis B — Explicit second runtime via `makeRuntime`

`Bus.layer` is wrapped in its own `ManagedRuntime` via `makeRuntime` ([bus/index.ts:192](../../../opencode/packages/opencode/src/bus/index.ts), `effect/run-service.ts:33`). Other services do the same: `lsp/client.ts:31`, `installation/index.ts:336`, `cli/cmd/tui/config/tui.ts:300`. If a module-level side-effecting call at startup triggers one of these runtimes to construct, and that runtime's Layer dependency closure includes `InstanceStore`, it materializes its own.

**Diagnostic signal:** Different `serviceId`s; one stack shows the side-effecting code that triggered the makeRuntime, the other shows the regular request flow.

### Hypothesis C — Real race in a single `InstanceStore.Service`

`InstanceStore.load` ([project/instance-store.ts:105-121](../../../opencode/packages/opencode/src/project/instance-store.ts)) does `cache.get`/`cache.set` synchronously inside `Effect.gen`. The test `dedupes concurrent loads while init is in flight` ([test/project/instance.test.ts:84-119](../../../opencode/packages/opencode/test/project/instance.test.ts)) proves this works. So a real race within one Service should be impossible.

But `AppFileSystem.resolve(input.directory)` runs on line 106, *outside* the `Effect.uninterruptibleMask`/`Effect.gen` body. If `resolve` is async or yields the event loop in some way, a second `load` call can race into the cache lookup before the first commits its `cache.set`.

**Diagnostic signal:** Two `creating instance` events with the SAME `serviceId`. `cacheHadBefore: false` for both. Both stack traces look like normal HTTP request handlers.

## 3. Diagnostic plan

### Goal

Identify which of the three hypotheses is real before designing the fix. Cheap and fast: a 5-minute roundtrip from diagnostic-patch-apply to log-read.

### Patch (temporary, diagnostic-only)

File: `packages/opencode/src/project/instance-store.ts`.

Add inside `InstanceStore.layer`'s `Effect.gen` body, near the top (around the existing line 36-40 block):

```typescript
const serviceId = Math.random().toString(36).slice(2, 10)
```

Replace the existing `creating instance` log block (around lines 113-117) with:

```typescript
const cacheHadBefore = cache.has(directory)
const cacheSizeBefore = cache.size
cache.set(directory, entry)
yield* Effect.gen(function* () {
  yield* Effect.logInfo("creating instance").pipe(
    Effect.annotateLogs("directory", directory),
    Effect.annotateLogs("serviceId", serviceId),
    Effect.annotateLogs("cacheHadBefore", String(cacheHadBefore)),
    Effect.annotateLogs("cacheSizeBefore", String(cacheSizeBefore)),
    Effect.annotateLogs(
      "stack",
      new Error().stack?.split("\n").slice(0, 15).join(" | ") ?? "no-stack",
    ),
  )
  yield* completeLoad(directory, input, entry)
}).pipe(Effect.forkIn(scope, { startImmediately: true }))
```

Five new annotations: `serviceId`, `cacheHadBefore`, `cacheSizeBefore`, `stack`.

### Deployment

Path of least friction: write the diagnostic directly into the running Nix store path with `chmod +w`, restart `opencode-serve`, read the log, revert. ~2 minutes. The file is `${OPENCODE_PATCHED_NIX_STORE_PATH}/lib/.../instance-store.ts` — exact path resolved from the running binary's process tree.

Alternative if Nix-store edit is too uncomfortable: properly land the diagnostic as a patch in `opencode-patched/patches/instance-store-diagnostic.patch`, build a `v1.15.10-patched.2-diagnostic` version, deploy via `home-manager switch`, restart serve. ~30 minutes.

Recommendation: alternative path. Slightly slower but cleaner; avoids contaminating the Nix store; the proper-patch workflow is already well-practiced from the v1.15.10 rebase.

### Analysis

After restart, fetch the latest log:

```bash
grep "creating instance" ~/.local/share/opencode/log/<latest>.log
```

Decision table:

| serviceId comparison | cacheHadBefore | Stack signature | Verdict |
|---|---|---|---|
| Same | false, false | Both HTTP-handler-ish | Hypothesis C |
| Different | varies | One AppRuntime-ish, one HTTP | Hypothesis A |
| Different | varies | One from makeRuntime/Bus/etc., one normal | Hypothesis B |

Two-event minimum; if only one fires, the bug doesn't reproduce that boot and we restart.

### Cleanup

Once the hypothesis is identified, revert the diagnostic patch and proceed to the fix patch.

## 4. Fix architecture

Three sketches, one per hypothesis. We build one based on diagnostic findings. Documenting all three so the decision tree is recorded.

### Hypothesis A fix — Stabilize `InstanceLayer.layer` for memoMap

**Current:**

```typescript
export const layer = Layer.unwrap(
  Effect.promise(async () => {
    const { InstanceBootstrap } = await import("./bootstrap")
    return InstanceStore.defaultLayer.pipe(Layer.provide(InstanceBootstrap.defaultLayer))
  }),
)
```

**Option 1 — eager import:**

```typescript
import { InstanceBootstrap } from "./bootstrap"
import { InstanceStore } from "./instance-store"

export const layer = InstanceStore.defaultLayer.pipe(Layer.provide(InstanceBootstrap.defaultLayer))
```

Risk: if `Layer.unwrap` was used to avoid an import cycle, this breaks the build. Verify by grepping for cycles before committing.

**Option 2 — lazy with memoization:**

```typescript
import { lazy } from "@/util/lazy"

const resolveLayer = lazy(async () => {
  const { InstanceBootstrap } = await import("./bootstrap")
  return InstanceStore.defaultLayer.pipe(Layer.provide(InstanceBootstrap.defaultLayer))
})

export const layer = Layer.unwrap(Effect.promise(resolveLayer))
```

The `lazy` from `@/util/lazy` caches the Promise result, so repeated calls return the same Layer. memoMap sees a stable identity and dedupes.

Size: ~10 lines. Risk: low. Add test: build the Layer twice via two different ManagedRuntimes both sharing memoMap, assert returned `InstanceStore.Service` references are identical.

### Hypothesis B fix — Bridge the rogue runtime

If the diagnostic shows boots coming from two distinct runtimes (one being a `makeRuntime`-style synthetic), fix the offender:

**Option 1 (preferred): remove `InstanceStore` from the rogue runtime's dependency closure.** Audit the runtime's Layer `R` type. If `InstanceStore` is required at layer-init, refactor to defer the requirement to call-time via `attachWith` (same pattern as #27825).

**Option 2: make `makeRuntime` accept a parent runtime.** Add an optional `parent` parameter that, when provided, reuses the parent's `InstanceStore.Service` instance. More general but touches infrastructure.

Size: 20-50 lines depending on offender. Risk: medium — needs careful audit of all services using `makeRuntime` to ensure we don't break their isolation.

### Hypothesis C fix — Make `load` atomic across `AppFileSystem.resolve`

Move the `AppFileSystem.resolve` call inside the `Effect.uninterruptibleMask`/`Effect.gen` body:

```typescript
const load = (input: LoadInput): Effect.Effect<InstanceContext> => {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const directory = AppFileSystem.resolve(input.directory)
      const existing = cache.get(directory)
      if (existing) return yield* restore(Deferred.await(existing.deferred))
      // ... rest as before
    }),
  ).pipe(Effect.withSpan("InstanceStore.load"))
}
```

Same change for `reload`.

Size: ~5 lines per function, two functions. Risk: very low.

### Why we don't pre-commit to one

All three fix shapes are small and targeted. The diagnostic literally tells us which to build. Pre-deciding wastes effort and risks designing the wrong fix.

### Common requirements regardless of hypothesis

1. **Regression test:** New test in `test/project/instance.test.ts` (or adjacent). Build the Layer composition exactly as production. Make two `load(directory)` calls (or whatever the diagnostic shows). Assert exactly ONE `creating instance` event fires. Assert both calls return the same `InstanceContext` reference. Test must fail on v1.15.10 unmodified and pass with the fix applied.

2. **Patch landed in `opencode-patched/patches/`** as `instance-state-partition.patch`. Listed in `apply.sh` and `check-sunset.yml`.

3. **No version bump** during cloudbox burn-in (use a `dev`-suffixed version locally). Bump to a clean version (e.g., `v1.15.10-patched.2`) only after Tier 1 + brief sanity check pass.

## 5. Burn-in & validation

### Pre-fix baseline

Capture current state before fix lands:

1. **Question-hang repro proof.** Trigger a Question via the `Question` tool, observe `reply for unknown request` in log, confirm form hangs. Save log snippet to `docs/plans/2026-05-26-instancestate-partition-fix/baseline-hang.log`.
2. **Dual-instance evidence.** Fresh `opencode-serve` restart, two `creating instance` events captured. Save to `baseline-dual-boot.log`.
3. **Telegram-drop running count.** Maintained in [bus-fix-investigation HANDOFF](2026-05-22-bus-fix-investigation-HANDOFF.md) §Burn-in.

### Tier 1 — Immediate (~30 min post-fix-deploy)

All must pass before claiming "fix works":

- Restart `opencode-serve`. Exactly ONE `creating instance` event per directory at startup. No second boot within 60 seconds.
- Use the `Question` tool to ask a single-option question. Pick an option. Form dismisses cleanly. No `reply for unknown request` warning. No "rejected for unknown request" cascade.
- Repeat the Question test 5 times. All 5 dismiss cleanly.
- Existing test `dedupes concurrent loads while init is in flight` still passes (`bun test test/project/instance.test.ts`).
- New regression test (Section 4) passes.

### Tier 2 — Cloudbox 24-hour burn-in

All must pass before reverting plugin diagnostic instrumentation:

- Plugin instrumentation shows ONE `instanceId` per directory across all observed sessions.
- No `reply for unknown request` warnings in any log over 24+ hours.
- Multiple parallel sessions in different directories (e.g., `pigeon`, `mono`, worktrees) all show single boots and single instanceIds.

### Tier 3 — Multi-day burn-in (3-5 days, both cloudbox & devbox)

All must pass before filing the upstream PR:

- No Telegram stop-notification drops under varied load (single sessions, parallel sessions, fast follow-ups, big tool outputs).
- No new regressions: model selection, MCP enable/disable, vim mode, cache behavior, no perf cliff.
- No upstream-patch-incompatibility issues surface.

### Failure modes & rollback

- **Tier 1 fails:** Drop the patch from `opencode-patched/patches/`, rebuild, redeploy. Existing v1.15.10-patched.1 is the known baseline.
- **Tier 2 fails:** Fix was incomplete. Re-investigate. Plugin instrumentation is the safety net.
- **Tier 3 fails:** Rollback, file regression as new bead, decide whether to retry or accept the bug.

### Deployment cadence (revised per user feedback 2026-05-26)

1. Diagnostic patch → cloudbox only → read logs → identify hypothesis.
2. Fix patch → cloudbox only → run Tier 1.
3. **Brief cloudbox sanity** (a few hours of normal use, no Question hangs, no dual-boots in logs).
4. Build proper version (`v1.15.10-patched.2`), push GitHub release, update workstation `home.base.nix`.
5. Deploy to devbox per `cross-device-deployment` skill.
6. Continue Tier 2/3 burn-in on BOTH machines for 3-5 more days.
7. After Tier 3 passes: file upstream issue + PR with the multi-day evidence.

Earlier draft had devbox deployment waiting until full Tier 3 completion; user opted to deploy to devbox after brief cloudbox sanity since both machines share fate from a code perspective.

### Burn-in monitoring

Keep plugin diagnostic instrumentation in place through Tier 2. Revert after Tier 2 passes. Tier 3 monitors via normal logs.

## 6. Upstream PR shape

### Linked issue first

File an issue before opening the PR. Title: `Bug: InstanceStore.Service materializes twice per directory, causing Question tool to hang on submit`.

Contents: bug statement, reproduction (the Question-hang repro), root cause (whichever hypothesis the diagnostic confirmed, with log excerpt), request for guidance ("Happy to PR; would prefer feedback on the fix direction first").

This is upstream-courteous and gives Dax / sst maintainers the chance to redirect us before we open the PR.

### PR structure

1. **Bug statement.** User-visible: Question tool prompts hang on submit. Root: `Question.ask` and `Question.reply` resolve to different `Question.Service` instances because the underlying `InstanceStore.Service` materializes twice per directory at startup.

2. **Reproduction.** Minimal repro using the `Question` tool. Deterministic. Doesn't require external services. Could be a failing test in `test/project/instance.test.ts`.

3. **Root cause.** One paragraph explaining the confirmed hypothesis, with the exact line numbers and a log excerpt showing two `creating instance` events.

4. **Fix.** The actual diff. Small. Targeted. Annotated.

5. **Test.** Regression test that fails on `main` before the fix and passes after.

6. **Connection to existing fixes.** Reference #27825 explicitly: "PR #27825 fixed the bus.publish manifestation of this partition. This PR fixes the partition itself, which also resolves the `Question` hang and prevents future partition-induced bugs in other services using `InstanceState`."

7. **Burn-in evidence.** "Deployed locally as a patch since 2026-05-XX. N days of normal use across M directories. No recurrence of the dual-boot event. No `reply for unknown request` warnings. No Telegram notification drops." Specific numbers from our burn-in logs.

### What we DON'T include in the upstream PR

- Pigeon-specific evidence (Telegram drops, plugin `instanceId` tagging). Not upstream's concern.
- The diagnostic patch. Research scaffolding, not a fix.
- Opinions on how `InstanceState`-using services should be redesigned. Scope creep.
- Speculation about other partition-victim services. If asked, answer "likely affected by the same mechanism but I haven't reproduced symptoms on them — happy to follow up if confirmed."

### Why this shape suits anomalyco/opencode

Recent merged fixes (#27825, #28051, #28693, #28187) are small, targeted, include tests, reference each other. Dax prefers tight diffs with clear cause-effect over architectural overhauls. Our planned fix matches that style.

(All "upstream" references in this design \u2014 issue + PR filing in Section 6 \u2014 target `anomalyco/opencode`, the fork our opencode-patched tracks. v1.15.10 itself originated in `sst/opencode` and is mirrored at the same commit hash into anomalyco; the active PR space lives in anomalyco.)

### Carrying the patch until upstream merges

- File: `opencode-patched/patches/instance-state-partition.patch`.
- Listed in `apply.sh` and `check-sunset.yml`.
- Rebase on each upstream version bump like any other patch.

### Risk if upstream doesn't merge

We keep carrying it. Worst case: rebase conflict on a future version. The fix's surface area is small enough that rebases should be cheap.

## Decision log

- **2026-05-26 ~22:00 EDT** — User chose "strike at the root" over symptom-fix approaches (per session). All 6 design sections approved sequentially. Devbox deployment timing relaxed to "after brief cloudbox sanity check" rather than "after full Tier 3."
- **2026-05-26 ~22:00 EDT** — Hypothesis identification deferred to implementation step 1 (diagnostic patch). Design records all three candidate fixes so the decision tree is preserved.
- **2026-05-26 ~22:00 EDT** — Upstream PR filing gated on Tier 3 completion (3-5 days of multi-machine burn-in).

## Diagnostic finding (2026-05-26 ~15:30 EDT)

### Verdict

**Hypothesis A confirmed, with an architectural twist.** The fundamental cause is `InstanceLayer.layer = Layer.unwrap(Effect.promise(...))` defeating memoMap dedup — which by itself would cause Hypothesis A. But the production environment additionally has **two independent HTTP-handling pipelines** (the TCP listener and the in-process `Default` webHandler used by the SDK client's "internal fetch"), each with its own runtime and memoMap. Even a memoMap-friendly `InstanceLayer` wouldn't fully unify them.

### Evidence

The diagnostic patch was deployed on cloudbox at 2026-05-26 15:30:25 EDT (post-`systemctl restart opencode-serve`). Log file: `~/.local/share/opencode/log/2026-05-26T153025.log`. Within 4 seconds of boot, two `creating instance` events fired for the same directory:

```
INFO 2026-05-26T15:30:33 +3913ms service=default
  stack=Error |     at <anonymous> (/$bunfs/root/chunk-8zr1qt7x.js:2:2488)
        |     at ~effect/Effect/successCont (/$bunfs/root/chunk-qv8cq7ep.js:25:7808)
        |     at runLoop (/$bunfs/root/chunk-qv8cq7ep.js:25:2045)
        |     ...
        |     at emit (node:events:98:22)
        |     at onNodeHTTPRequest (node:_http_server:373:22)
  cacheSizeBefore=0 cacheHadBefore=false
  serviceId=cy5eoxd9
  directory=/home/dev/projects/pigeon
  creating instance

INFO 2026-05-26T15:30:33 +3ms service=default
  stack=Error |     at <anonymous> (/$bunfs/root/chunk-8zr1qt7x.js:2:2488)
        |     ...
        |     at fetch (/$bunfs/root/chunk-wv3z9c79.js:657:9882)
        |     at <anonymous> (/$bunfs/root/chunk-wv3z9c79.js:402:6271)
        |     at async <anonymous> (/home/dev/projects/pigeon/packages/opencode-plugin/src/index.ts:231:53)
        |     at async <anonymous> (/home/dev/projects/pigeon/packages/opencode-plugin/src/index.ts:295:16)
        |     at async <anonymous> (/home/dev/projects/pigeon/packages/opencode-plugin/src/index.ts:376:18)
        |     at processTicksAndRejections (native:7:39)
  cacheSizeBefore=0 cacheHadBefore=false
  serviceId=uabp6bnk
  directory=/home/dev/projects/pigeon
  creating instance
```

**Two distinct serviceIds**: `cy5eoxd9` and `uabp6bnk`. **Both saw empty cache** (`cacheHadBefore=false`, `cacheSizeBefore=0`). Same directory.

### Mechanism

Three relevant code sites:

1. **`packages/opencode/src/project/instance-layer.ts:4`** — `InstanceLayer.layer = Layer.unwrap(Effect.promise(async () => { ... }))`. Every time this layer is built, the unwrap re-evaluates the async closure, producing a fresh `InstanceStore.defaultLayer.pipe(Layer.provide(InstanceBootstrap.defaultLayer))` — a NEW Layer object identity. memoMap keys by Layer reference, so it can't dedupe.

2. **`packages/opencode/src/server/server.ts:104,129`** — The TCP listener uses `HttpRouter.serve(createRoutes(opts), {...})` built with `Layer.makeMemoMapUnsafe()` (a fresh per-listener memoMap). External HTTP requests (e.g. `opencode attach` reconnecting) hit this pipeline.

3. **`packages/opencode/src/server/server.ts:247-253`** — A separate `webHandler = lazy(() => HttpRouter.toWebHandler(routes, { memoMap, ... }))` uses the SHARED `memoMap` (the one from `@opencode-ai/core/effect/memo-map`). This is what `Server.App().fetch()` resolves to. The plugin's `ctx.client.session.get(...)` doesn't make a real network call — per the plugin source at `pigeon/packages/opencode-plugin/src/index.ts:21-26`, the SDK client uses a "custom in-process fetch that calls `Server.App().fetch()` directly (no network I/O)". So plugin-originated requests go through the webHandler pipeline, NOT the listener pipeline.

Event 1 (cy5eoxd9, short stack ending at `onNodeHTTPRequest`) is the **listener** materializing its `InstanceStore.Service` on its first request. Event 2 (uabp6bnk, plugin stack ending in `fetch`) is the **webHandler** materializing its `InstanceStore.Service` when the plugin's first in-process SDK call hits it.

These two pipelines fundamentally cannot share `InstanceStore.Service` as currently structured, because:
- They use different memoMaps (fresh-per-listener vs shared).
- Even with shared memoMaps, `InstanceLayer.layer`'s `Layer.unwrap(Effect.promise(...))` produces fresh inner Layers, defeating dedup.

### Why the form hangs (mechanism reaffirmed)

`Question.ask` from a tool-execution fiber runs inside whatever runtime hosts the tool (typically the listener runtime if the user triggered it via `opencode attach`). `Question.reply` from an HTTP-handler fiber runs inside the runtime that received the reply HTTP request (could be the listener OR the webHandler depending on caller). If the two end up on different pipelines, they reach different `Question.Service` instances and therefore different pending-request maps. The reply is rejected as `reply for unknown request`.

### Implications for the fix (SUPERSEDED — see "Diagnostic finding revised" below)

The "Option 1: eager import" / "Option 2: lazy with memoization" sketches in Section 4 fix **half** the problem — they make `InstanceLayer.layer` memoMap-friendly. That eliminates the dedup failure WITHIN a single pipeline that uses the shared memoMap (e.g., AppRuntime + webHandler).

But the listener still uses its own fresh memoMap (server.ts:129). To unify the listener and webHandler we need either:
- **Fix B-1:** Switch the listener to use the shared memoMap. One-line change: `Layer.buildWithMemoMap(listenerLayer(opts, port), memoMap, scope)` where `memoMap` is imported from `@opencode-ai/core/effect/memo-map`. Combined with the InstanceLayer fix, this should produce ONE `InstanceStore.Service` shared by both pipelines.
- **Fix B-2:** Extract `InstanceStore.Service` to a process-wide singleton outside the Effect layer system. Heavier surgery.

**Recommended fix path:** Combine "Option 1: eager import" for `InstanceLayer.layer` + "Fix B-1: switch listener to shared memoMap". Together they ensure both pipelines materialize ONE `InstanceStore.Service` that any directory load operation can see.

**Risk note:** changing the listener's memoMap from per-listener to shared has implications if anything in the codebase deliberately relies on per-listener isolation. Need to audit before committing. The current behavior of using a fresh memoMap per `startListener` appears intentional (a fresh `ConfigProvider` is also installed per listener at server.ts:116), so there may be reasons. To minimize risk, the regression test in Task 3 should exercise both pipelines and verify they share `InstanceStore.Service`.

### Fix to build (SUPERSEDED — see "Diagnostic finding revised" below)

- File: `packages/opencode/src/project/instance-layer.ts` — switch to eager import (Option 1 from Section 4).
- File: `packages/opencode/src/server/server.ts:129` — `Layer.buildWithMemoMap(..., memoMap, scope)` using the shared memoMap import.
- Test: extend `test/project/instance.test.ts` to assert that two ManagedRuntimes sharing the same memoMap produce the same `InstanceStore.Service` for the same directory. Also assert: that two distinct pipelines built via the production-shape composition (one via webHandler, one via listener-shape `HttpRouter.serve`) produce the same `InstanceStore.Service` when sharing the same memoMap.

## Diagnostic finding revised (2026-05-26 ~17:00 EDT)

The original finding above (Hypothesis A "with architectural twist") is partly wrong. Empirical testing revealed Issue 1 (the `Layer.unwrap(Effect.promise(...))` memoMap-hostility) **does not actually manifest**. Effect's memoMap dedupes `InstanceLayer.layer` correctly within a single shared memoMap. The dual-boot in production is caused **entirely by Issue 2** — the listener and webHandler use SEPARATE memoMaps.

### What changed my mind

While writing the regression test for Task 3, I wrote a minimal test that builds `InstanceLayer.layer` twice through the same `memoMap` and asserts the resulting `InstanceStore.Service` is the same reference:

```typescript
test("InstanceLayer.layer deduplicates across runtimes sharing memoMap", async () => {
  const a = await Effect.runPromise(buildIntoFreshScope())
  const b = await Effect.runPromise(buildIntoFreshScope())
  expect(a.store).toBe(b.store)
})
```

Running this against unmodified v1.15.10 (no fix applied):

```
 1 pass, 0 fail, 1 expect() calls
```

The test PASSED. So `Layer.unwrap(Effect.promise(...))` IS memoMap-friendly when builds share the memoMap. memoMap caches the *build result* (Context) keyed by Layer reference; the outer `Layer.unwrap(...)` is a stable top-level binding, so memoMap returns the cached Context on the second build. The inner Layer re-evaluation inside the unwrap closure doesn't matter because it's not re-executed once memoMap has a hit.

### Corrected mechanism

The production bug is purely **Issue 2: listener vs webHandler use separate memoMaps.**

- `packages/opencode/src/server/server.ts:129`: `Layer.buildWithMemoMap(listenerLayer(opts, port), Layer.makeMemoMapUnsafe(), scope)` — listener has its OWN fresh memoMap.
- `packages/opencode/src/server/server.ts:247-253`: `webHandler = lazy(() => HttpRouter.toWebHandler(routes, { memoMap, ... }))` — webHandler uses the SHARED memoMap from `@opencode-ai/core/effect/memo-map`.

Two memoMaps → two memoization caches → two `InstanceStore.Service` instances for the same directory.

External HTTP traffic (`opencode attach`) goes through the listener. In-process traffic (pigeon plugin's `ctx.client.session.get(...)`, per the plugin source comment at `pigeon/packages/opencode-plugin/src/index.ts:21-26`) goes through `Server.App().fetch()` which is the webHandler. Different pipelines, different Services, split state.

### Why the form hangs (unchanged from above)

The mechanism is the same: `Question.ask` (called from a tool fiber, hosted by whichever pipeline routed the original prompt) and `Question.reply` (called from an HTTP-handler fiber, hosted by whichever pipeline received the reply) end up on different `Question.Service` instances because the two pipelines have different `InstanceStore.Service` → different `InstanceState` ScopedCaches → different per-question pending-request maps. The reply is rejected as `reply for unknown request`.

### Revised fix shape

**One-line code change.** At `packages/opencode/src/server/server.ts:129`:

```typescript
// Before:
return Layer.buildWithMemoMap(listenerLayer(opts, port), Layer.makeMemoMapUnsafe(), scope).pipe(

// After:
return Layer.buildWithMemoMap(listenerLayer(opts, port), memoMap, scope).pipe(
```

(plus an import: `import { memoMap } from "@opencode-ai/core/effect/memo-map"` at the top of `server.ts`).

No change to `instance-layer.ts`. No change to `instance-store.ts`.

### Risk assessment for the one-line fix

The current per-listener `Layer.makeMemoMapUnsafe()` IS deliberate in spirit — server.ts also installs a fresh `ConfigProvider` per listener (line 116) for env-isolation reasons. So this isn't an accidental bug; it's a design choice that has the side effect of partitioning `InstanceStore.Service`.

Risks of moving the listener to the shared memoMap:
- **Service identity bleeding across listeners** — if anything depends on "fresh services per listener," it'll regress. The codebase has very few callers of `startListener` (it's the entrypoint), so this seems unlikely to break. But worth a careful audit.
- **Lifecycle / disposal subtleties** — services built via the shared memoMap are owned by the shared memoMap's lifecycle, not the per-listener scope. Disposing a listener shouldn't dispose services held by the shared memoMap. The current code at server.ts uses `Scope.makeUnsafe()` per listener; the scope finalizer would still run for listener-specific things, but services pulled from the shared memoMap survive. This MIGHT be the intended behavior or might break expectations.

Mitigation: the regression test (Option A integration test, see below) exercises both pipelines end-to-end and verifies dual-boot is gone. Tier 1 + Tier 2 burn-in catches any breakage we missed.

### Revised regression test approach (Option A — integration test)

The narrow unit test ("InstanceLayer.layer deduplicates ... shared memoMap") passes both before and after the fix, so it's an invariant test, not a regression. Useful to keep, but doesn't catch the actual bug.

The real regression test exercises the production-shape architecture: instantiate a real HTTP listener (via `NodeHttpServer.layerTest`, like `httpapi-instance-context.test.ts` does) AND access the in-process `webHandler` (`HttpApiApp.Default` / `Server.App().fetch()`). Trigger a directory load through both. Assert they observe the same `InstanceContext`.

**Test location:** `packages/opencode/test/server/httpapi-instance-store-partition.test.ts` (new file).

**Sketch:**

```typescript
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Server } from "../../src/server/server"
import { testEffectShared } from "../lib/effect"
// ... fixtures

describe("InstanceStore partition (listener vs in-process webHandler)", () => {
  it.live("listener and Default webHandler share the same InstanceStore.Service for the same directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })

      // Start a real HTTP listener.
      const listener = yield* Effect.promise(() =>
        Server.listen({ port: 0, hostname: "127.0.0.1" }),
      )

      // Probe 1: hit the listener over real HTTP.
      const listenerResponse = yield* HttpClientRequest.get(`${listener.url.toString()}probe`).pipe(
        HttpClientRequest.setHeader("x-opencode-directory", dir),
        HttpClient.execute,
      )

      // Probe 2: hit the Default in-process webHandler.
      const inProcessHandler = HttpApiApp.Default
      const inProcessResponse = yield* Effect.promise(() =>
        inProcessHandler.app.fetch(
          new Request(`http://localhost/probe`, {
            headers: { "x-opencode-directory": dir },
          }),
        ),
      )

      // Both probes return the same project ID → both saw the same
      // InstanceContext → both reached the same InstanceStore.Service.
      const listenerJson = yield* listenerResponse.json
      const inProcessJson = yield* Effect.promise(() => inProcessResponse.json())
      expect(listenerJson.projectID).toBe(inProcessJson.projectID)

      // Also check the log for only ONE "creating instance" event for this dir.
      // (Need to either pipe the logger to a buffer, or instrument differently.)
    }),
  )
})
```

The exact wire-up (probe route, logger capture, listener lifecycle) needs investigation; this is the spec. Before the fix, the listener and webHandler use different `InstanceStore.Service` instances, so the same `dir` is loaded twice — same `projectID` (because project lookup is deterministic) but two different `InstanceContext` references. After the fix, both share.

For the "only one creating instance" assertion, simpler: add a counter in a test-only `bootstrap.run` and assert it's called once.

### Revised fix to build

- **One-line code change** to `packages/opencode/src/server/server.ts:129` (use shared memoMap).
- **Integration test** at `packages/opencode/test/server/httpapi-instance-store-partition.test.ts` exercising listener + webHandler.
- (Optional) Keep the invariant test at `packages/opencode/test/project/instance.test.ts` documenting that `InstanceLayer.layer` dedupes across shared memoMap. Useful as defensive documentation for any future refactor of `instance-layer.ts`.

## Tier 1 validation result (2026-05-26, cloudbox, v1.15.10-patched.2)

- ✅ **One `creating instance` per directory** across 4 distinct directories observed during the test window (including `/tmp/tier1-test` which received both listener and in-process webHandler traffic, and three real worktrees handling independent sessions). Pre-fix, the test directory alone would have produced 2 events.
- ✅ **5/5 Question tool form submissions dismissed cleanly** in both Telegram and TUI surfaces. (Test driven by a headless opencode session launched into `/tmp/tier1-test`, which used the Question tool 11 times in sequence — more than the 5 we asked for, because the model retried twice after garbled tool-call attempts. All 11 question.asked → user-pick → reply cycles completed cleanly.)
- ✅ **Zero `reply for unknown request` / `reject for unknown request` warnings** in the full cloudbox log during the validation window.
- ✅ Production binary running: `/nix/store/3wsn446fbhyahc5fbwqlq561mv9rnpzf-opencode-patched-1.15.10.2/bin/opencode` (verified via `/proc/<pid>/exe`).
- ✅ Health endpoint: `{"healthy":true,"version":"1.15.10"}`.

The Tier 1 deployment is the architectural confirmation the fix works in production. The most diagnostic single line:

```
INFO 2026-05-26T21:09:02 service=default directory=/tmp/tier1-test creating instance
```

…followed by 11 question.asked → delivered → user-pick → reply cycles for the same directory, with no second `creating instance` event ever appearing for `/tmp/tier1-test`. Pre-fix, the listener (curl probes, headless attach client) and in-process webHandler (pigeon plugin's `ctx.client.session.get`) would have materialized two separate `InstanceStore.Service` instances and split the `Question.Service` pending-request map. Post-fix, both share.

Note (unrelated): the launched test AI emitted two malformed tool-call attempts as plain text — Gemini's internal XML tool-call grammar leaked through the prose channel. This is a model-side glitch (likely small-context drift on Gemini 3.5 Flash) and unrelated to the InstanceState fix. The subsequent Question tool calls in the same session worked fine, proving the tool plumbing remained healthy.

Proceeding to brief cloudbox sanity check (a few hours of normal use), then Task 7 (devbox deploy).

## Companion documents

- [bus-fix-investigation HANDOFF](2026-05-22-bus-fix-investigation-HANDOFF.md) — full investigation history, durable state record, current burn-in status.
- [v1.15.10 verification report](2026-05-25-28051-verification-report.md) — what #27825 did and didn't fix.
- Implementation plan: `docs/plans/2026-05-26-instancestate-partition-fix-plan.md` (to be written next via the `writing-plans` skill).
