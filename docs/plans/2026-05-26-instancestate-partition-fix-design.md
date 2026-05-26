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

## Companion documents

- [bus-fix-investigation HANDOFF](2026-05-22-bus-fix-investigation-HANDOFF.md) — full investigation history, durable state record, current burn-in status.
- [v1.15.10 verification report](2026-05-25-28051-verification-report.md) — what #27825 did and didn't fix.
- Implementation plan: `docs/plans/2026-05-26-instancestate-partition-fix-plan.md` (to be written next via the `writing-plans` skill).
