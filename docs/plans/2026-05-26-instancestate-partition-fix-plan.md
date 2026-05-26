# InstanceState Partition Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the duplicate `InstanceStore.Service` materialization that causes `Question` tool prompts to hang and (historically) Telegram stop-notifications to drop, then burn the fix in on cloudbox and deploy to devbox.

**Architecture:** Diagnostic-first approach. Step 1 captures stack traces at every `creating instance` event to identify which of three hypotheses (memoMap dedup failure / explicit second runtime / real race in load()) is real. Steps 2–4 implement the targeted fix and a regression test based on the diagnosed hypothesis. Steps 5–8 build, deploy, burn-in, and devbox roll-out. Steps 9–11 file the upstream issue + PR after the multi-day burn-in passes.

**Tech Stack:** TypeScript / Effect.ts (`packages/opencode`), Bun test runner, Nix flake (`workstation`), patch system (`opencode-patched`), systemd service (`opencode-serve`), pigeon plugin TypeScript (`pigeon/packages/opencode-plugin`).

---

## Repository layout reference

Three repositories are involved:

- **`/home/dev/projects/opencode`** — Upstream `anomalyco/opencode` checkout (origin), with `sst/opencode` as the `upstream` remote (the original). Currently `HEAD detached at v1.15.10`. Read-only source of truth. Run tests here with `bun test`. PRs (#27825, #28051, etc.) referenced throughout this plan are anomalyco/opencode PR numbers; Tasks 10+11 file the upstream issue and PR at `anomalyco/opencode`.
- **`/home/dev/projects/opencode-patched`** — Our local fork with `patches/*.patch` and `apply.sh`. Builds release tarballs uploaded to GitHub releases. Currently at `main` commit `051f7c2` (v1.15.10 rebase). All new patches go here.
- **`/home/dev/projects/pigeon`** — This repo. Holds the design + plan, the pigeon plugin source, and `home.base.nix` references through the workstation repo. Logs and burn-in evidence live here.
- **`/home/dev/projects/workstation`** — Nix configuration. `users/dev/home.base.nix` pins `opencode-patched` version + SRI hashes. `home-manager switch` deploys.

Key paths:
- Diagnostic patch target: `opencode/packages/opencode/src/project/instance-store.ts`
- Layer with hypothesis A vulnerability: `opencode/packages/opencode/src/project/instance-layer.ts`
- Test location for regression test: `opencode/packages/opencode/test/project/instance.test.ts`
- Pigeon plugin instrumentation (already deployed): `pigeon/packages/opencode-plugin/src/index.ts`
- Cloudbox active log dir: `~/.local/share/opencode/log/`
- Cloudbox systemd service: `opencode-serve`

Design reference: [`docs/plans/2026-05-26-instancestate-partition-fix-design.md`](./2026-05-26-instancestate-partition-fix-design.md).

---

## Task 1: Build & deploy the diagnostic patch

**Goal:** Get a build of `opencode-patched` with stack-capturing instrumentation at the `creating instance` log line, deployed on cloudbox.

**Files:**
- Create: `/home/dev/projects/opencode-patched/patches/instance-store-diagnostic.patch`
- Modify: `/home/dev/projects/opencode-patched/apply.sh` (add the new patch to the list)
- Reference (read-only): `/home/dev/projects/opencode/packages/opencode/src/project/instance-store.ts:36-120` (the target lines we'll diff against)

### Step 1.1: Inspect the target file to confirm line numbers

```bash
sed -n '30,125p' /home/dev/projects/opencode/packages/opencode/src/project/instance-store.ts
```

Confirm these landmarks exist:
- Around line 36-40: opening of the `Effect.gen` body in `InstanceStore.layer`. We'll insert a `serviceId` constant just after the existing `const project = yield* Project.Service` line.
- Around lines 113-117: the `cache.set(directory, entry)` and `Effect.logInfo("creating instance")` block. We'll rewrite to add annotations.

If line numbers shifted, adjust the patch hunks accordingly.

### Step 1.2: Author the diagnostic patch

Create `/home/dev/projects/opencode-patched/patches/instance-store-diagnostic.patch` with this content:

```diff
diff --git a/packages/opencode/src/project/instance-store.ts b/packages/opencode/src/project/instance-store.ts
--- a/packages/opencode/src/project/instance-store.ts
+++ b/packages/opencode/src/project/instance-store.ts
@@ -36,6 +36,9 @@ export const layer: Layer.Layer<Service, never, Project.Service | InstanceBootstrap.Service> = Layer.effect(
     const project = yield* Project.Service
     const bootstrap = yield* InstanceBootstrap.Service
     const scope = yield* Scope.Scope
     const cache = new Map<string, Entry>()
+
+    // DIAGNOSTIC: tag each InstanceStore.Service instance to detect duplicates.
+    const serviceId = Math.random().toString(36).slice(2, 10)

     const boot = (input: LoadInput & { directory: string }) =>
       Effect.gen(function* () {
@@ -109,9 +112,18 @@ export const layer: Layer.Layer<Service, never, Project.Service | InstanceBootstrap.Service> = Layer.effect(
           const existing = cache.get(directory)
           if (existing) return yield* restore(Deferred.await(existing.deferred))

           const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>() }
+          const cacheHadBefore = cache.has(directory)
+          const cacheSizeBefore = cache.size
           cache.set(directory, entry)
           yield* Effect.gen(function* () {
-            yield* Effect.logInfo("creating instance").pipe(Effect.annotateLogs("directory", directory))
+            yield* Effect.logInfo("creating instance").pipe(
+              Effect.annotateLogs("directory", directory),
+              Effect.annotateLogs("serviceId", serviceId),
+              Effect.annotateLogs("cacheHadBefore", String(cacheHadBefore)),
+              Effect.annotateLogs("cacheSizeBefore", String(cacheSizeBefore)),
+              Effect.annotateLogs("stack", new Error().stack?.split("\n").slice(0, 15).join(" | ") ?? "no-stack"),
+            )
             yield* completeLoad(directory, input, entry)
           }).pipe(Effect.forkIn(scope, { startImmediately: true }))
           return yield* restore(Deferred.await(entry.deferred))
```

### Step 1.3: Add the patch to `apply.sh`

```bash
grep -n "patches/" /home/dev/projects/opencode-patched/apply.sh | head
```

Find the existing patch list (probably an array or sequential `patch -p1 <` invocations). Append `instance-store-diagnostic.patch` to the list in the same style as the other patches. The exact pattern depends on the script's structure — match it.

### Step 1.4: Test the patch applies cleanly

```bash
cd /home/dev/projects/opencode
git stash  # save anything uncommitted
cd /home/dev/projects/opencode-patched
bash apply.sh /home/dev/projects/opencode  # or whatever the apply invocation is
cd /home/dev/projects/opencode
git diff packages/opencode/src/project/instance-store.ts
```

Expected: the diff matches the patch contents above. If apply fails, fix the patch hunks (probably line-number drift).

### Step 1.5: Revert the patch test

```bash
cd /home/dev/projects/opencode
git checkout packages/opencode/src/project/instance-store.ts
git stash pop  # if you stashed earlier
```

### Step 1.6: Commit the diagnostic patch to opencode-patched

```bash
cd /home/dev/projects/opencode-patched
git add patches/instance-store-diagnostic.patch apply.sh
git commit -m "patch: add instance-store diagnostic to identify dual-boot cause

Captures serviceId, cacheHadBefore, cacheSizeBefore, and a 15-frame stack
trace at every 'creating instance' event. Used once to identify which of
three hypotheses causes the dual InstanceStore.Service materialization;
will be removed once the root cause is fixed.

Refers to pigeon/docs/plans/2026-05-26-instancestate-partition-fix-design.md
Section 3."
```

Do NOT push yet — this is a research-only patch that we'll remove before pushing the real fix.

### Step 1.7: Build a local diagnostic release

The opencode-patched build process produces tarballs for 4 platforms. For diagnostic purposes we only need `linux-x64` (cloudbox). Build it locally:

```bash
cd /home/dev/projects/opencode-patched
# Inspect the build entry point first
ls build-*.sh 2>/dev/null
# OR check the CI workflow for build commands
cat .github/workflows/build-release.yml | grep -A3 'run:'
```

Run whatever produces a linux-x64 tarball at `dist/` or similar. Most likely:

```bash
# Adjust this command based on what build-release.yml or apply.sh uses
bash build.sh linux-x64
# OR
bun run build:linux-x64
```

You should end up with a tarball like `dist/opencode-patched-1.15.10.1-linux-x64.tar.gz` (or similar). Note its path; we'll use it in Step 1.8.

### Step 1.8: Override the workstation Nix derivation to use the local build

The cleanest path: copy the tarball to a known location, compute its SRI hash, and temporarily override `home.base.nix`.

```bash
# Compute SRI hash of the local build
nix hash file --type sha256 --base64 \
  /home/dev/projects/opencode-patched/dist/opencode-patched-1.15.10.1-linux-x64.tar.gz
```

Take the resulting `sha256-...=` and update `workstation/users/dev/home.base.nix` temporarily:
- Find the `linux-x64` entry (around line 200ish based on prior session memory).
- Replace the `hash = "sha256-...=";` value.
- Replace the `url = "...";` to a `file://` URL or a temporary HTTP server URL.

Alternative (simpler): if home.base.nix supports a local-path override mechanism, use that. Check:

```bash
grep -A20 "linux-x64\|fetchurl" /home/dev/projects/workstation/users/dev/home.base.nix | head -40
```

If there's no clean override path, use the **alternative deployment** described in design Section 3: chmod +w on the running Nix store path and edit `instance-store.ts` directly. ~2 minutes start to finish:

```bash
RUNNING_BIN=$(readlink -f /home/dev/.nix-profile/bin/opencode)
NIX_STORE_DIR=$(dirname $(dirname $RUNNING_BIN))
INSTANCE_STORE_PATH="$NIX_STORE_DIR/lib/node_modules/opencode-patched/packages/opencode/src/project/instance-store.ts"
# Inspect what's there
ls -la $INSTANCE_STORE_PATH
```

If the path doesn't exist (because the running binary is bundled, not a tree), abandon this alternative and stick with the proper-patch flow.

### Step 1.9: Deploy + restart

If using proper-patch flow:

```bash
cd /home/dev/projects/workstation
git diff users/dev/home.base.nix  # confirm temporary hash override is staged
home-manager switch --flake .#dev@cloudbox  # or relevant flake target
# Verify new binary
readlink -f /home/dev/.nix-profile/bin/opencode
# Restart serve
/run/wrappers/bin/sudo systemctl restart opencode-serve
sleep 5
curl -sf http://127.0.0.1:4096/global/health
```

Expected: `{"healthy":true,"version":"1.15.10"}`.

### Step 1.10: Commit + don't merge

```bash
# Do NOT commit the workstation override; we'll revert it after the diagnostic is done.
# Just leave the working-tree change uncommitted.
cd /home/dev/projects/workstation
git status  # confirm we have only the temporary override unstaged
```

---

## Task 2: Reproduce + diagnose

**Goal:** Capture the two `creating instance` events with diagnostic data, identify the hypothesis.

**Files:**
- Read-only: latest `~/.local/share/opencode/log/<YYYY-MM-DDTHHMMSS>.log`
- Reference: design doc Section 3 (decision table)

### Step 2.1: Identify the active log file

```bash
ls -t ~/.local/share/opencode/log/ | head -3
```

Note the newest filename. It should be from within the last few minutes (since the restart in Step 1.9).

### Step 2.2: Extract the two `creating instance` events

```bash
LATEST=$(ls -t ~/.local/share/opencode/log/*.log | head -1)
grep "creating instance" $LATEST | head -10
```

Expected output: 2 events per directory at startup. Each line should have `directory=...`, `serviceId=...`, `cacheHadBefore=...`, `cacheSizeBefore=...`, `stack=...`.

### Step 2.3: Apply the decision table from design doc Section 3

Compare the two events:

| Condition | Hypothesis |
|---|---|
| Both events have **same** `serviceId`, both `cacheHadBefore=false` | C (real race in load()) |
| Different `serviceId`, stacks show one from `AppRuntime.runPromise` and one from HTTP handler | A (memoMap dedup failure) |
| Different `serviceId`, one stack shows `makeRuntime` / `Bus.publish` / etc. | B (explicit second runtime) |

### Step 2.4: Document the finding

Append to `/home/dev/projects/pigeon/docs/plans/2026-05-26-instancestate-partition-fix-design.md` a new section:

```markdown
## Diagnostic finding (2026-05-XX)

**Hypothesis confirmed:** [A | B | C]

**Evidence (excerpt from `~/.local/share/opencode/log/<file>.log`):**

```
[paste the two creating instance lines verbatim]
```

**Analysis:** [one paragraph explaining what the data shows]

**Fix to build:** [refer to Section 4 fix sketch for the matching hypothesis]
```

Commit the design update:

```bash
cd /home/dev/projects/pigeon
git add docs/plans/2026-05-26-instancestate-partition-fix-design.md
git commit -m "docs(design): diagnostic finding — hypothesis [A|B|C] confirmed"
```

### Step 2.5: Revert the diagnostic patch

```bash
cd /home/dev/projects/opencode-patched
# Drop the diagnostic patch — it's served its purpose
git rm patches/instance-store-diagnostic.patch
# Restore apply.sh to its pre-diagnostic state
git checkout HEAD~1 -- apply.sh
git commit -m "patch: remove instance-store-diagnostic (research complete)"
```

Note: don't actually deploy this yet — we'll deploy the real fix in a single bundle in Task 5.

---

## Task 3: Write the regression test (TDD)

**Goal:** Add a failing test that proves the dual-boot bug exists, will pass once the fix lands.

**Files:**
- Modify: `/home/dev/projects/opencode/packages/opencode/test/project/instance.test.ts`

### Step 3.1: Read the existing test file

```bash
sed -n '1,50p' /home/dev/projects/opencode/packages/opencode/test/project/instance.test.ts
```

Understand the test framework used (`testEffect`, `it.live`, `it.instance` from `test/lib/effect.ts`).

### Step 3.2: Write the failing test

Add a new `it.live` block to the existing `describe("InstanceStore", ...)` block. Test name depends on hypothesis:

**For Hypothesis A** ("memoMap dedup failure"):

```typescript
it.live("dedupes InstanceStore.Service across runtimes sharing memoMap", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    let initialized = 0

    yield* setBootstrap(
      Effect.sync(() => {
        initialized++
      }),
    )

    // Build the layer twice via two ManagedRuntimes both using the shared memoMap.
    // This mirrors how AppRuntime and the HTTP webHandler both use memoMap.
    const { memoMap } = await import("@opencode-ai/core/effect/memo-map")
    const { ManagedRuntime } = await import("effect")
    const rt1 = ManagedRuntime.make(InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)), { memoMap })
    const rt2 = ManagedRuntime.make(InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)), { memoMap })

    const ctx1 = await rt1.runPromise(InstanceStore.Service.use((s) => s.load({ directory: dir })))
    const ctx2 = await rt2.runPromise(InstanceStore.Service.use((s) => s.load({ directory: dir })))

    expect(ctx1).toBe(ctx2)
    expect(initialized).toBe(1)

    await rt1.dispose()
    await rt2.dispose()
  }),
)
```

**For Hypothesis B / C:** Adapt the test to whatever the diagnostic showed. The pattern is the same: exercise the production code path that currently causes the dual boot, assert one bootstrap call and identical InstanceContext.

### Step 3.3: Run the test and verify it fails

```bash
cd /home/dev/projects/opencode
bun test test/project/instance.test.ts -t "dedupes InstanceStore.Service"
```

Expected: FAIL with mismatched contexts or `initialized=2`.

### Step 3.4: Commit the failing test

```bash
cd /home/dev/projects/opencode
git add packages/opencode/test/project/instance.test.ts
git commit -m "test(instance-store): regression test for dual-service materialization

Asserts InstanceStore.Service is deduped across runtimes sharing memoMap,
and that the bootstrap init runs once per directory. Currently FAILS on
v1.15.10 — see pigeon/docs/plans/2026-05-26-instancestate-partition-fix-design.md
Section 4."
```

Don't push yet. This commit will be part of the upstream PR; lives in `opencode/`, not `opencode-patched/`.

---

## Task 4: Implement the fix

**Goal:** Make the regression test pass.

**Files:**
- Modify: depends on hypothesis. See design Section 4 for the exact diff per hypothesis.

### Step 4.1: Apply the fix from design Section 4

**For Hypothesis A:**

Modify `/home/dev/projects/opencode/packages/opencode/src/project/instance-layer.ts`. Try Option 1 first (eager import); if it causes an import cycle, fall back to Option 2 (lazy with memoization).

Option 1 attempt:

```typescript
import { Effect, Layer } from "effect"
import { InstanceStore } from "./instance-store"
import { InstanceBootstrap } from "./bootstrap"

export const layer = InstanceStore.defaultLayer.pipe(Layer.provide(InstanceBootstrap.defaultLayer))

export * as InstanceLayer from "./instance-layer"
```

```bash
cd /home/dev/projects/opencode
bun run typecheck  # or whatever the typecheck command is
```

If it fails with import-cycle errors, revert and apply Option 2:

```typescript
import { Effect, Layer } from "effect"
import { lazy } from "@/util/lazy"
import { InstanceStore } from "./instance-store"

const resolveLayer = lazy(async () => {
  const { InstanceBootstrap } = await import("./bootstrap")
  return InstanceStore.defaultLayer.pipe(Layer.provide(InstanceBootstrap.defaultLayer))
})

export const layer = Layer.unwrap(Effect.promise(resolveLayer))

export * as InstanceLayer from "./instance-layer"
```

**For Hypothesis B/C:** Apply the matching fix from design Section 4.

### Step 4.2: Run the regression test (expect pass)

```bash
cd /home/dev/projects/opencode
bun test test/project/instance.test.ts -t "dedupes InstanceStore.Service"
```

Expected: PASS.

### Step 4.3: Run the full existing test file

```bash
cd /home/dev/projects/opencode
bun test test/project/instance.test.ts
```

Expected: ALL pass. The pre-existing tests (`loads instance context`, `caches loaded instance context by directory`, `dedupes concurrent loads while init is in flight`, etc.) must still pass.

### Step 4.4: Run broader regression tests

```bash
cd /home/dev/projects/opencode
bun test test/project/
bun test test/effect/instance-state.test.ts
bun test test/server/httpapi-event-diagnostics.test.ts
```

All should pass.

### Step 4.5: Commit the fix

```bash
cd /home/dev/projects/opencode
git add packages/opencode/src/project/instance-layer.ts
# include any other files that the diagnosed hypothesis required touching
git commit -m "fix(instance): eliminate dual InstanceStore.Service materialization

[explain the root cause and the precise fix in 3-5 sentences. Reference
PR #27825 which fixed the bus.publish symptom of the same partition.]

Closes the upstream PR (to be opened): [link added later]
Resolves the Question tool hang reproduced in test/project/instance.test.ts.
Pigeon project burn-in plan in pigeon/docs/plans/2026-05-26-instancestate-partition-fix-design.md."
```

---

## Task 5: Package as opencode-patched patch + build release

**Goal:** Produce the patch file in `opencode-patched`, build a tagged release for cloudbox+devbox deployment.

**Files:**
- Create: `/home/dev/projects/opencode-patched/patches/instance-state-partition.patch`
- Modify: `/home/dev/projects/opencode-patched/apply.sh`
- Modify: `/home/dev/projects/opencode-patched/.github/workflows/check-sunset.yml`

### Step 5.1: Generate the patch file

```bash
cd /home/dev/projects/opencode
git diff HEAD~1 HEAD -- packages/opencode/src/project/instance-layer.ts > /tmp/instance-state-partition.patch
# Verify the patch
cat /tmp/instance-state-partition.patch
# Move into opencode-patched
mv /tmp/instance-state-partition.patch /home/dev/projects/opencode-patched/patches/
```

If multiple files changed in Task 4's fix commit, include all of them in the patch by widening the `git diff` arguments.

### Step 5.2: Add to `apply.sh`

```bash
cd /home/dev/projects/opencode-patched
grep -n "patches/" apply.sh | head
```

Add the new patch to the list. Match the existing style.

### Step 5.3: Add to `check-sunset.yml`

```bash
sed -n '1,40p' .github/workflows/check-sunset.yml
```

The sunset check verifies whether each of our patches has been merged upstream. Add `instance-state-partition` to whatever the list-format is. It will fail-loudly when upstream merges our PR, prompting us to drop the local patch.

### Step 5.4: Verify the patch applies cleanly to a fresh v1.15.10 checkout

```bash
cd /home/dev/projects/opencode
git checkout v1.15.10
git stash  # if there's any uncommitted noise
cd /home/dev/projects/opencode-patched
bash apply.sh /home/dev/projects/opencode  # or whatever runs the apply
cd /home/dev/projects/opencode
git diff packages/opencode/src/project/instance-layer.ts | head -30
```

Expected: the diff matches our intended fix.

Then revert:

```bash
cd /home/dev/projects/opencode
git checkout packages/opencode/src/project/instance-layer.ts
```

### Step 5.5: Commit + push opencode-patched

```bash
cd /home/dev/projects/opencode-patched
git add patches/instance-state-partition.patch apply.sh .github/workflows/check-sunset.yml
git commit -m "fix(instance): eliminate dual InstanceStore.Service per directory

[same body as the upstream fix commit]"
git push origin main
```

### Step 5.6: Build all 4 platform releases via CI

```bash
cd /home/dev/projects/opencode-patched
# Trigger a new release. Usually a tag push or a workflow_dispatch on build-release.yml.
git tag v1.15.10-patched.2
git push origin v1.15.10-patched.2
# Watch the CI run
gh run watch
```

If the CI uses `workflow_dispatch`, trigger it manually:

```bash
gh workflow run build-release.yml -f version=v1.15.10-patched.2
```

Wait for all 4 platforms (linux-x64, linux-arm64, darwin-x64, darwin-arm64) to succeed.

### Step 5.7: Verify release published

```bash
gh release view v1.15.10-patched.2 --repo johnnymo87/opencode-patched
```

Expected: 4 tarballs + 4 sha256 files, plus the release notes.

### Step 5.8: Capture SRI hashes for workstation Nix update

```bash
for arch in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
  URL="https://github.com/johnnymo87/opencode-patched/releases/download/v1.15.10-patched.2/opencode-patched-1.15.10.2-${arch}.tar.gz"
  echo "=== ${arch} ==="
  nix-prefetch-url --unpack $URL 2>&1 | tail -1 | xargs -I{} nix hash to-sri --type sha256 {}
done
```

Save the 4 hashes; you'll plug them into `home.base.nix` in Task 6.

---

## Task 6: Deploy to cloudbox + run Tier 1 validation

**Goal:** Update workstation Nix, deploy on cloudbox, validate the fix at the immediate-pass tier.

**Files:**
- Modify: `/home/dev/projects/workstation/users/dev/home.base.nix`

### Step 6.1: Update workstation `home.base.nix`

```bash
grep -B1 -A5 "upstreamVersion\|sha256" /home/dev/projects/workstation/users/dev/home.base.nix | head -30
```

Bump `upstreamVersion` from `1.15.10` to whatever the new patch-suffixed version naming convention is (likely `1.15.10.2` or `1.15.10-patched.2`). Replace the 4 SRI hashes with the ones captured in Step 5.8.

### Step 6.2: Commit + push workstation

```bash
cd /home/dev/projects/workstation
git status --short
git diff users/dev/home.base.nix
git add users/dev/home.base.nix
git commit -m "feat(opencode): bump to v1.15.10-patched.2 with InstanceState partition fix

Pulls in johnnymo87/opencode-patched v1.15.10-patched.2 which adds
instance-state-partition.patch. See pigeon design doc for the fix story.
Burn-in plan: cloudbox first, then devbox after brief sanity check."
git push origin main
```

### Step 6.3: Run home-manager switch on cloudbox

```bash
cd /home/dev/projects/workstation
home-manager switch --flake .#dev@cloudbox  # adjust flake target
# Verify new binary
readlink -f /home/dev/.nix-profile/bin/opencode
# Expected: a new Nix store path containing "opencode-patched-1.15.10.2"
```

### Step 6.4: Restart opencode-serve

```bash
/run/wrappers/bin/sudo systemctl restart opencode-serve
sleep 5
curl -sf http://127.0.0.1:4096/global/health
```

Expected: `{"healthy":true,"version":"1.15.10"}`. (The `version` field reports upstream version, not patch suffix.)

### Step 6.5: Tier 1 validation step 1 — single boot per directory

```bash
LATEST=$(ls -t ~/.local/share/opencode/log/*.log | head -1)
grep "creating instance" $LATEST
```

Expected: ONE `creating instance` event per directory. If two events fire for the same directory, the fix didn't work — go back to Task 4 / Task 2 to re-investigate.

### Step 6.6: Tier 1 validation step 2 — Question tool flow

In an opencode session, type a prompt that triggers the `Question` tool:

> "I have a question for you: do you prefer option A, option B, or option C? Use the Question tool to ask me."

When the question UI appears, pick any option. Expected behavior:
- Form dismisses cleanly after submit.
- No `reply for unknown request` in the log.

```bash
grep "reply for unknown request\|reject for unknown request" $LATEST
```

Expected: zero matches. If any appear, the fix is incomplete.

### Step 6.7: Tier 1 validation step 3 — repeat the Question test 5 times

Re-ask 5 Question-tool questions in sequence. Each must dismiss cleanly. Track manually.

If 5/5 pass, Tier 1 is GREEN. Document:

```bash
cd /home/dev/projects/pigeon
cat >> docs/plans/2026-05-26-instancestate-partition-fix-design.md <<EOF

## Tier 1 validation result (2026-05-XX)

- ✅ One \`creating instance\` per directory at startup
- ✅ Question tool form dismissed cleanly (5/5)
- ✅ No \`reply for unknown request\` warnings during validation
- ✅ Existing test suite still passes (\`bun test test/project/\`)
- ✅ New regression test passes

Proceeding to brief sanity check (a few hours) before devbox deploy.
EOF
git add docs/plans/2026-05-26-instancestate-partition-fix-design.md
git commit -m "docs(design): Tier 1 validation passed"
```

### Step 6.8: Brief cloudbox sanity check (~2-4 hours of normal use)

Use the system normally. Watch for:
- Any new `reply for unknown request` warnings.
- Any new dual `creating instance` events.
- Any sudden TUI weirdness, MCP issues, vim issues, etc.

If anything looks wrong, halt and re-investigate.

---

## Task 7: Deploy to devbox

**Goal:** Roll the fix out to devbox once cloudbox sanity check is clean.

**Files:** No new files. Just devbox-side commands.

### Step 7.1: On devbox, pull workstation main

```bash
ssh devbox  # or however the user connects
cd ~/projects/workstation
git pull
```

### Step 7.2: home-manager switch on devbox

```bash
home-manager switch --flake .#dev@devbox  # adjust flake target if different
readlink -f ~/.nix-profile/bin/opencode
```

### Step 7.3: Restart devbox opencode-serve

```bash
sudo systemctl restart opencode-serve
sleep 5
curl -sf http://127.0.0.1:4096/global/health
```

### Step 7.4: Run Tier 1 validation on devbox

Same checks as Step 6.5 / 6.6 / 6.7 but in devbox's log dir.

### Step 7.5: Document devbox deploy

```bash
cd ~/projects/pigeon  # on devbox or wherever
cat >> docs/plans/2026-05-26-instancestate-partition-fix-design.md <<EOF

## Devbox deploy (2026-05-XX)

home-manager switch ran cleanly. Tier 1 checks pass on devbox. Burn-in
continues across both machines.
EOF
git add docs/plans/2026-05-26-instancestate-partition-fix-design.md
git commit -m "docs(design): devbox deploy complete, multi-machine burn-in active"
git push  # if appropriate
```

---

## Task 8: Tier 2 burn-in (24 hours)

**Goal:** Confirm partition is eliminated across longer wall-clock + more sessions.

**Files:** No new files. Just monitoring + a log spot-check.

### Step 8.1: After ~24 hours, audit cloudbox logs

```bash
# Find all logs from the past 24 hours
LOGS=$(find ~/.local/share/opencode/log/ -name "*.log" -mtime -1)
# How many "creating instance" events fired in total
grep -c "creating instance" $LOGS | awk -F: '{sum+=$2} END {print sum}'
# How many unique directories
grep -h "creating instance" $LOGS | grep -oE "directory=[^ ]+" | sort -u | wc -l
# Any "reply for unknown request" warnings
grep -c "reply for unknown request\|reject for unknown request" $LOGS | awk -F: '{sum+=$2} END {print sum}'
```

Expected:
- Total `creating instance` events ≈ number of unique directories visited (no duplicates).
- Zero `reply for unknown request` / `reject for unknown request` warnings.

### Step 8.2: Plugin instrumentation audit

```bash
# Unique pigeon plugin instanceId per directory across all 24h logs
grep -h "plugin instance materialized" $LOGS | \
  grep -oE "\[i=[a-z0-9]{8} d=[^]]+\]" | sort -u
```

Expected: ONE instanceId per directory. If two appear for the same directory, the fix didn't fully resolve the partition.

### Step 8.3: Same audit on devbox

Repeat Steps 8.1 + 8.2 in devbox's log dir.

### Step 8.4: Tier 2 result documentation

```bash
cd /home/dev/projects/pigeon
cat >> docs/plans/2026-05-26-instancestate-partition-fix-design.md <<EOF

## Tier 2 validation result (2026-05-XX, +24 hours)

- ✅ N total \`creating instance\` events for M unique directories (N == M, no duplicates)
- ✅ Zero \`reply for unknown request\` warnings on cloudbox or devbox over 24h
- ✅ One pigeon plugin instanceId per directory across both machines
- ✅ No new regressions noticed

Proceeding to revert plugin diagnostic instrumentation.
EOF
git add docs/plans/2026-05-26-instancestate-partition-fix-design.md
git commit -m "docs(design): Tier 2 validation passed — partition is gone"
```

### Step 8.5: Revert plugin diagnostic instrumentation

```bash
cd /home/dev/projects/pigeon
# Revert the uncommitted instrumentation in the plugin
git diff packages/opencode-plugin/src/index.ts | head -50  # confirm what we're reverting
git checkout packages/opencode-plugin/src/index.ts
# Confirm it's gone
grep "instanceId\|DEBUG event entry" packages/opencode-plugin/src/index.ts | head
```

Expected: zero matches (instrumentation removed).

Confirm pigeon plugin still loads — restart opencode-serve and check it materializes once per directory:

```bash
/run/wrappers/bin/sudo systemctl restart opencode-serve
sleep 5
NEWLOG=$(ls -t ~/.local/share/opencode/log/*.log | head -1)
grep "service=opencode-pigeon" $NEWLOG | head -5
# Should see plugin events without [i=...d=...] prefixes
```

```bash
cd /home/dev/projects/pigeon
git status --short  # confirm clean working tree
```

No commit needed (the changes were never committed).

---

## Task 9: Tier 3 burn-in (3-5 days)

**Goal:** Build sufficient evidence to file the upstream issue + PR.

**Files:** No new files. Just monitoring + final write-up.

### Step 9.1: Use the system normally for 3-5 days

During this time:
- Use opencode for real work (PR reviews, coding sessions, etc.) on both machines.
- Use pigeon Telegram bot for at least a handful of sessions (with varied load: parallel sessions, fast follow-ups, big tool outputs).
- Watch for ANY anomalies: stop notifications dropping, mode-switch hangs, MCP weirdness, etc.

### Step 9.2: Daily spot-checks

Every day, run a quick audit:

```bash
TODAY=$(date +%Y-%m-%d)
grep -h "creating instance\|reply for unknown request\|reject for unknown request" \
  ~/.local/share/opencode/log/*.log | \
  grep $TODAY
```

Should be empty (zero warnings). Document any anomalies in a daily note.

### Step 9.3: After 3-5 days, write the burn-in summary

```bash
cd /home/dev/projects/pigeon
cat >> docs/plans/2026-05-26-instancestate-partition-fix-design.md <<EOF

## Tier 3 burn-in result (2026-05-XX through 2026-05-XX, +5 days)

**Cloudbox:**
- N opencode sessions, M tool invocations, K Question prompts (all dismissed cleanly).
- L Telegram stop notifications, J% delivery success rate.
- Zero "reply for unknown request" warnings.
- Zero dual-boot \`creating instance\` events.
- No new regressions observed.

**Devbox:**
- (same metrics)

**Verdict:** fix is stable, multi-day evidence. Proceeding to upstream PR.
EOF
git add docs/plans/2026-05-26-instancestate-partition-fix-design.md
git commit -m "docs(design): Tier 3 burn-in passed — ready for upstream PR"
```

---

## Task 10: File upstream issue

**Goal:** File the issue first per the upstream-PR plan.

**Files:** None local.

### Step 10.1: Draft the issue body

Use `gh` CLI to draft. Template:

```markdown
**Bug:** `InstanceStore.Service` materializes twice per directory at startup, causing the `Question` tool to hang on submit.

**Reproduction:**
1. Start `opencode serve` and connect via TUI.
2. Trigger any single-option `Question` tool prompt (e.g., user-facing flow that calls the tool with `questions: [{...}]` where `options` has multiple items).
3. Pick an option.
4. Observe in server logs: `service=question requestID=que_... reply for unknown request`.
5. The form does not dismiss.

**Root cause (confirmed via diagnostic):**

[paste the relevant diagnostic finding from design Section 3 — which hypothesis was confirmed, with log excerpt]

**Why this happens architecturally:**

`Question.ask` (called from a tool-execution fiber) stores in pending-map A. `Question.reply` (called from an HTTP-handler fiber) reads from pending-map B. The two maps are owned by different `Question.Service` instances because the underlying `InstanceStore.Service` materialized twice — each `Question.layer` initialization created its own `InstanceState` ScopedCache.

**Why PR #27825 didn't fix this:**

PR #27825 fixed the `bus.publish` symptom of this partition by capturing the `Bus.Service` at layer-init and threading `InstanceContext` via `attachWith`. That makes `Bus.publish` resolve consistently across fibers. But `Question.ask` and `Question.reply` access `Question.Service` (not `Bus.Service`), and the partition exists at the `InstanceStore`/`InstanceState` layer below the bus.

**Proposed fix:**

[describe the fix shape matching the confirmed hypothesis — see PR draft to follow]

**Burn-in evidence (local patch):**

Deployed as a local patch in `opencode-patched` since 2026-05-XX. Five days of normal use across two machines (cloudbox + devbox), zero recurrence of:
- Dual `creating instance` events for the same directory.
- `reply for unknown request` warnings.
- Telegram stop-notification drops (this fix also addresses a partition-related symptom in our pigeon integration).

**Question for maintainers:**

Happy to open a PR with the fix. Would prefer feedback on the fix direction before opening it. Should the fix sit at `instance-layer.ts` (Hypothesis A), at the offending runtime's layer composition (Hypothesis B), or at `instance-store.ts` directly (Hypothesis C)?

Reference: pigeon project's design + plan docs for this fix at [link to commit on this repo].
```

### Step 10.2: File the issue

```bash
gh issue create --repo anomalyco/opencode \
  --title "Bug: InstanceStore.Service materializes twice per directory, causing Question tool to hang on submit" \
  --body-file /tmp/upstream-issue.md
```

Save the issue URL.

---

## Task 11: File upstream PR

**Goal:** Submit the actual fix as a PR linked to the issue.

**Files:**
- The opencode/ commit from Task 4 (fix) + Task 3 (test).

### Step 11.1: Open a feature branch

```bash
cd /home/dev/projects/opencode
git checkout v1.15.10  # base branch
git checkout -b fix/instance-state-partition
# Cherry-pick or rebase the Task 3 test commit + Task 4 fix commit onto this branch
git cherry-pick <commit-hash-of-task-3>
git cherry-pick <commit-hash-of-task-4>
```

### Step 11.2: Push the branch to a fork

```bash
gh repo fork anomalyco/opencode --remote --remote-name fork
git push fork fix/instance-state-partition
```

### Step 11.3: Open the PR

```bash
gh pr create --repo anomalyco/opencode \
  --title "fix(instance): eliminate dual InstanceStore.Service materialization per directory" \
  --body-file /tmp/upstream-pr.md \
  --head fork:fix/instance-state-partition
```

PR body template (matches design Section 6 structure):

```markdown
**Closes:** #[issue-number-from-Task-10]

## Bug

[1 sentence user-visible + 1 sentence root]

## Reproduction

[failing test included at `test/project/instance.test.ts`]

## Root cause

[reference the confirmed hypothesis]

## Fix

[1 paragraph explaining the precise change]

## Test

[explain what the new test covers + why it failed without the fix]

## Connection to existing fixes

PR #27825 fixed the bus.publish manifestation of this partition. This PR fixes the partition itself, which also resolves the Question hang and prevents future partition-induced bugs in other services using InstanceState.

## Burn-in evidence

Deployed as a local patch since 2026-05-XX, N days of normal use across 2 machines. Zero recurrence of:
- Dual `creating instance` events
- `reply for unknown request` warnings
- (downstream pigeon integration:) Telegram notification drops

Plan: pigeon docs at [permalink if appropriate].
```

### Step 11.4: Wait for review

Use the `shepherding-pull-requests` skill if needed — it covers the PR-shepherding flow.

### Step 11.5: After merge, drop the local patch

Once upstream merges:

```bash
cd /home/dev/projects/opencode-patched
git rm patches/instance-state-partition.patch
# Remove from apply.sh and check-sunset.yml
git add apply.sh .github/workflows/check-sunset.yml
git commit -m "patch: drop instance-state-partition (merged upstream as #XXXXX)"
git push origin main
```

Then bump opencode-patched to the new upstream version that includes the fix, following the standard rebase flow (see `bus-fix-investigation HANDOFF` for the procedure used in the v1.15.10 rebase).

---

## Decision log placeholders

To be filled in as the plan executes:

- [ ] Hypothesis confirmed: [A | B | C]
- [ ] Fix applied: [Option 1 eager import / Option 2 lazy / etc.]
- [ ] opencode-patched release tag: v1.15.10-patched.2
- [ ] Cloudbox deploy date: ____
- [ ] Tier 1 pass date: ____
- [ ] Devbox deploy date: ____
- [ ] Tier 2 pass date: ____
- [ ] Tier 3 pass date: ____
- [ ] Upstream issue URL: ____
- [ ] Upstream PR URL: ____
- [ ] Upstream merge date: ____
- [ ] Local patch dropped date: ____
