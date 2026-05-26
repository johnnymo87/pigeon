# Bus race fix: deployed, but symptom NOT fixed — investigation handoff

**Update 2026-05-23 ~08:43 EDT**: Root cause empirically identified — **dual plugin instance per directory with event-type partitioning**. See "Root cause confirmed" section at top. Bus #27959 fix is necessary but not sufficient. Don't revert it.

## Root cause confirmed (2026-05-23)

opencode-serve loads TWO pigeon plugin instances per directory. Per-instance `instanceId` tagging in the plugin (uncommitted, see `stash@{0}`) shows a strict partitioning across all observed sessions:

| Instance | message.updated events | session.idle events |
|----------|------------------------|----------------------|
| pigeon i=onfylxgl | 49 | 0 |
| pigeon i=3xw2dzab | 0 | 1 |
| mono i=1r6zgdfs | 33 | 0 |
| mono i=zxksf4ui | 0 | 1 |

The instance that builds the MessageTail is NEVER the one that handles session.idle. So `getCurrentMessageId(sessionID)` returns undefined → `shouldNotify=false` → bail → no notification.

The partition is deterministic (not race-y) in the post-restart run. Likely cause: `Bus.layer`'s `InstanceState.make` creates TWO `{wildcard, typed}` state objects per directory, and `publish()` writes to one or the other based on the publishing fiber's `InstanceState.context`. Different code paths (session-mgmt fibers vs message-mgmt fibers) consistently observe different state objects.

See bead `ccr-mu1` for the full updated root cause writeup. Original 2026-05-22 hypothesis (lazy subscribe race) is **incomplete** — kept for history.

## Upstream search (2026-05-23): the fix is PR #28051 already in v1.15.5+

Searched sst/opencode for the same symptom — **no existing issues match the dual-plugin-instance / event partition signature.** Closest cluster of related bugs is the SSE `/event` endpoint instance-context family (#27391, #27023, #26697, #26635, all closed by #27425 + #27959 + #28051). Of those, only #27959 is currently in our patched build.

**PR #28051 "fix: preserve bus instance context" (merged 2026-05-17, shipped v1.15.5)** by Dax is the exact fix. Description: "Thread instance context through `Bus.publish` so event publication preserves `InstanceRef`. Update file watcher and LSP update events to publish with the active instance context." The bus/index.ts diff threads `ctx: InstanceContext` through `publish()` and uses `Effect.provideService(InstanceRef, ctx)` so subscribers and publishers resolve to the same `s={wildcard, typed}` bus state.

This maps 1:1 to our empirical finding: publishers in different code paths (session-mgmt vs message-mgmt fibers) had different `InstanceRef` context → resolved to different cached bus InstanceStates → routed events to disjoint plugin instances.

## Chosen path: Option 2 — rebase opencode-patched to v1.15.10

User chose Option 2. Target version updated from v1.15.5 → **v1.15.10** on 2026-05-25 after a re-fetch confirmed:
- v1.15.10 (published 2026-05-23) is the latest tagged release. No release since.
- 60 commits on `upstream/dev` since v1.15.10 — none in bus/instance/plugin/event paths. Nothing tagged.
- v1.15.10 contains both #27959 and #28051 (since they shipped in v1.15.5+).
- Going to v1.15.10 vs v1.15.5 adds 5 days of incremental fixes (mostly TUI/desktop/native-llm refactors and a handful of fix-PRs) for the same risk profile against our patch stack — none of the v1.15.5..v1.15.10 commits touch the files our patches edit. The marginal cost of v1.15.10 over v1.15.5 is essentially zero.

### Pre-execution verification (completed 2026-05-25)

A verification subagent (`ses_19eb9b736ffev5kBSnfqqHq1xV`, vertex opus 4.7) ran a
read-only investigation in `~/projects/pigeon` and produced a full report at
`docs/plans/2026-05-25-28051-verification-report.md`.

**Verdict: v1.15.5+ DOES fix the bug. High confidence on symptom, medium on
mechanism. The load-bearing fix is NOT #28051 — it's PR #27825 ("fix(sync):
publish events on injected project bus"), with #27757, #28051, and #28187 as
supporting changes.**

Key corrections to the earlier analysis in this doc:

- The `message.updated` publisher path in v1.15.0 IS using the module-level
  `ProjectBus.publish`, but indirectly: `Session.updateMessage` →
  `sync.run(MessageV2.Event.Updated, ...)` → `Database.effect(fn)` →
  `InstanceState.bind(fn)` (ALS bridge) → `process()` →
  `ProjectBus.publish(def, data, {id})` at `sync/index.ts:351` (v1.15.0). The
  module-level publish uses a SEPARATE `ManagedRuntime` (`bus/index.ts:179`),
  and the round-trip through `Instance.restore` (ALS) and `attach()` is where
  context gets lost / divergent.
- `session.idle` publisher path is different: stays in Effect-land entirely,
  via `SessionStatus.set` → injected `bus.publish(Event.Idle, ...)` on the same
  `Bus.Service`. Path looks clean by itself.
- The deterministic by-event-type partition (49/0 vs 0/1) is consistent with
  there being TWO `state` cache entries in the bus's per-directory ScopedCache
  — one each path populates as it resolves `InstanceState.directory`. The
  mechanism for how `ScopedCache` ends up with two entries for the same key
  remains hypothetical (the verifier could not locate the definitive code
  path), but it's the only hypothesis that fits the data.
- **#28051-only cherry-pick onto v1.15.0 is NOT VIABLE** — it would not even
  compile, because #27825 must land first to remove the `sync/index.ts:351`
  call to `ProjectBus.publish(def, ...)` that uses the old (no-`ctx`)
  signature. The two PRs are a pair.

**v1.15.5+ collectively eliminates every plausible context-divergence
mechanism:**
- **#27825** removes the ALS-bridged separate-runtime publish path that was the
  most likely culprit for context divergence in `message.updated`.
- **#27757** removes the `Instance.current` ALS fallback entirely — `InstanceState.directory`
  now has exactly ONE source of truth (`InstanceRef`).
- **#28051** forces remaining direct-publish callsites to thread `ctx` explicitly.
- **#28187** captures full `Effect.context()` at bridge time, so the publish
  fiber inherits the entire publisher context.

**Validation must include the dual-plugin-instance check.** Beyond the original
three criteria, post-deploy we must verify with the diagnostic instrumentation
(uncommitted at `packages/opencode-plugin/src/index.ts`, also `git stash@{0}`)
that exactly ONE `instanceId` is logged per directory at startup. If two
instances per directory still exist, the partition theory is wrong and we need
to investigate further even if notifications work.

### Execution plan (post-verification)

**v1.15.0 → v1.15.10 scope: 385 commits over 8 days.** Many internal refactors (`refactor(repository): add cache service`, `refactor(reference): split materialization state`, etc.) that may invalidate our existing patch stack. Concrete migration risk:
- Our `cache-aligned-compaction.patch`, `prompt-loop-cache.patch` touch `session/prompt.ts` and `session/compaction.ts` — both heavily refactored in v1.15.0..v1.15.5 (e.g. `refactor(session): extract prompt tool resolution (#28204)`, `refactor(session): extract reference prompt helpers (#28197)`, `refactor(session): move prompt reminders out of core loop (#28082)`). Expect rework.
- `bus-eager-subscribe.patch` will become a NO-OP / conflict — drop it (already upstream as #27959 in v1.15.5+).
- `prefill-fix.patch`, `gemini-empty-parts.patch`, `tool-fix.patch`, `mcp-reconnect.patch` etc. need re-evaluation against the new base.
- The `caching.patch` lives in a separate repo (`opencode-cached`, at `/home/dev/projects/opencode-cached`) — needs its own rebase to v1.15.10 before our `opencode-patched` rebase can succeed. Confirmed conflicts on `config/agent.ts`, `provider/transform.ts`, `session/prompt.ts`.

Operate in `/home/dev/projects/opencode-patched`. Steps:

1. **Rebase `opencode-cached`/`caching.patch` to v1.15.10 first.** This is the upstream dependency of our apply.sh. Different repo, different commit, different push.
2. **Branch the work** in opencode-patched. Don't commit straight to main; `git checkout -b v1.15.10-rebase`.
3. **Update `patches/apply.sh`** to target v1.15.10 instead of v1.15.0. Update README sunset/version refs.
4. **For each existing patch in `patches/*.patch`**, in apply.sh order:
   a. Try `git apply --check $PATCH` against v1.15.10 — if clean, no work needed.
   b. If conflicts, regenerate the patch by:
      - Cherry-picking the corresponding upstream commit (if applicable) — preferred when the patch is an upstream backport.
      - Otherwise manually rebase: apply against v1.15.0 first, then carry the diff forward to v1.15.10 via three-way merge.
5. **Drop `bus-eager-subscribe.patch` entirely** — it's superseded by #27959 in v1.15.5+ base.
6. **Add no new patch for #28051** — also already in v1.15.5+ base.
7. **Update `.github/workflows/check-sunset.yml`**: PR #27959 and PR #28051 are now CLOSED-AS-MERGED in the base, so remove their monitors. Add sunset criterion for the next layer of patches if any.
8. **Update `.github/workflows/build-release.yml`** version tag scheme: `v1.15.10-patched.1`.
9. **Push branch, trigger CI, validate the build artifacts on all 4 platforms.**
10. **Update workstation `home.base.nix`** with `upstreamVersion="1.15.10"`, `patchedRevision="1"`, new SRI hashes from CI.
11. **Deploy to cloudbox via home-manager-switch**, restart opencode-serve, run the smoke test (`/launch cloudbox pigeon hi pigeon`), expect a real Telegram notification.

### Validation criteria

End-to-end smoke test fully passes only when:
- `/launch cloudbox pigeon hi pigeon` from Telegram produces a Telegram reply when the session reaches idle (not silent).
- Plugin log shows `type=* subscribing` firing exactly **ONCE** per directory at startup (not 2x — the partition behavior is gone).
- Plugin log shows `messageTail.onMessageUpdated done` followed by `session.idle` with `currentMsgId` populated, leading to `sending notifyStop` then `notifyStop daemon response`.

Do NOT claim "fixed" before all three are observed in the live log.

----

## (Old 2026-05-22) Bus race fix: deployed, but symptom NOT fixed

**Status as of 2026-05-22 ~21:00 EDT, cloudbox**: Patch deployed end-to-end (opencode-patched v1.15.0-patched.1 built + released, workstation Nix flake updated, opencode-serve restarted twice). User-visible symptom is **unchanged**: `/launch cloudbox pigeon hi pigeon` at ~21:00 spawned `ses_1acf75778ffeetvtWL5NhRCOHN`, the TUI shows the session running fine, but no Telegram reply came back when it reached idle.

My initial root-cause hypothesis (PR #27959 / commit `cb3549324` — lazy `bus.subscribeAll()` losing events) is at minimum incomplete and probably wrong. The patch IS applied (verified — see below), but plugin behavior is identical: every `session.idle` still bails with `shouldNotify=false; returning` because `messageTail.currentMessageId` is still `undefined`.

## What's been done (shipped + verified)

- **Beads filed** in `.beads/issues.jsonl`:
  - `ccr-mu1` (P1, bug): the original "message.updated events not reaching plugin" hypothesis. **The description in the bead is now WRONG about root cause** — needs updating once we find the actual cause.
  - `ccr-mu2` (P2): cloudbox opencode-serve memory pressure + nx-mcp orphans (independent issue, still open).
  - `ccr-mu3` (P3): opencode.db at 4.5GB (independent, still open).
- **opencode-patched repo** commit `e93452a` pushed to `main`:
  - `patches/bus-eager-subscribe.patch` (cherry-pick of `cb3549324`)
  - `patches/apply.sh` extended with the new patch + SUNSET CRITERION comment
  - `README.md` documents the patch with sunset criterion
  - `.github/workflows/build-release.yml` accepts new optional `revision` input (`v1.15.0-patched.N`)
  - `.github/workflows/check-sunset.yml` now tracks PR #27959 status monthly
- **Release** `v1.15.0-patched.1` published with all 4 platform binaries — CI green.
- **workstation repo** commit `4ae235a` pushed to `main`:
  - `users/dev/home.base.nix` restructured to split `upstreamVersion` and `patchedRevision` with explicit sunset comments
  - All 4 platform hashes updated
- **cloudbox deploy**: `nix run home-manager -- switch --flake .#cloudbox` ran successfully. `/home/dev/.nix-profile/bin/opencode` now resolves to `/nix/store/1qk7rrp2icgavyh8xlwq2hs865niwpnr-opencode-patched-1.15.0.1/bin/opencode`.
- **opencode-serve restarted** (user did the second restart manually after my sudo broke post-switch). Currently running the new binary — verify with `/run/wrappers/bin/sudo readlink /proc/$(pgrep -f '.opencode-wrapp' | head -1)/exe`.

## Evidence the patch IS active

The bus log now shows `service=bus type=<name> subscribing` lines at startup — that log line comes from `log.info("subscribing", { type: def.type })` inside the NEW `Effect.gen(function* () { ... yield* PubSub.subscribe(ps) ... })` body. The OLD code's identically-worded log was inside `Stream.unwrap(...)`, which only ran on first pull. So the eager-subscribe behavior IS in effect. The bus race wasn't (the whole) problem.

## What's NOT working (verbatim symptom)

In `/home/dev/.local/share/opencode/log/2026-05-23T002559.log` (the new serve's log), every `session.idle` for every session still produces:

    DEBUG session.idle after awaitRegistration {isMain:true, isRegistered:true}
    DEBUG session.idle shouldNotify=false; returning

Just like before. `messageTail.currentMessageId` is still undefined when `session.idle` fires. So the plugin's `event` handler is either (a) never receiving `message.updated`, or (b) receiving it but discarding it via the `if (info?.id && info?.sessionID && info?.role)` filter at `packages/opencode-plugin/src/index.ts:412`, or (c) receiving + processing it but for a DIFFERENT plugin/messageTail instance than the one handling session.idle for the same session.

## Instrumentation I added but didn't get to observe

I edited `packages/opencode-plugin/src/index.ts` to add a `log("DEBUG message.updated raw", { hasInfo, id, sessionID, role, propsKeys })` at the top of the `message.updated` branch (around line 410-417). This is currently UNCOMMITTED in the working tree. After opencode-serve was restarted by the user, new instances will pick up the instrumented plugin. **Critically**: only opencode App.Instances created AFTER the restart will have the new code. Existing instances already have the OLD plugin closures in memory.

To test:
1. Verify the instrumentation is still in the working tree: `grep "DEBUG message.updated raw" /home/dev/projects/pigeon/packages/opencode-plugin/src/index.ts` — should show the log line.
2. Launch a fresh session in a directory that didn't have an active instance: `/launch cloudbox <somedir-not-yet-loaded> ...` OR send a prompt to `ses_1acf75778ffeetvtWL5NhRCOHN` (the post-restart-but-no-notification session in `/home/dev/projects/pigeon`).
3. Find the new opencode-serve PID: `pgrep -f '.opencode-wrapp' | head -1`
4. Find its open log via `/run/wrappers/bin/sudo ls -la /proc/<pid>/fd/ | grep .log`
5. Grep for `DEBUG message.updated raw` in that log:
   - If lines appear: handler IS being called, narrow on which sessions or which payload shape causes the filter to drop them.
   - If lines do NOT appear despite `service=bus type=message.updated publishing` lines: the plugin handler is not being dispatched. Look deeper into the bus/plugin wiring.

## Investigation next steps (priority order)

1. **Confirm whether `DEBUG message.updated raw` ever fires.** This single data point splits the diagnosis tree.
2. **Compare plugin instance counts to App.Instance counts.** Each directory's bootstrap should load one pigeon plugin instance. Earlier I saw a directory (`mono/.worktrees/pr-3188`) bootstrap TWICE within 18ms with the plugin loading both times. If two plugin instances exist per directory, both subscribe to the same bus, but they have separate `sessionManager`/`messageTail` state. Each receives the events independently. That alone wouldn't cause undefined `currentMessageId`, but it would help understand event flow.
3. **Check the SDK Event payload shape for `message.updated`.** In v1.15.0, did the event payload structure change such that `event.properties.info` is no longer what `UpdatedEventSchema` says it is? The schema is `Schema.Struct({ sessionID, info: Info })`. Look at how `sync.run` shapes the payload before publishing.
4. **Diff `convertEvent` for `message.updated`.** `packages/opencode/src/server/projectors.ts:11` shows a `convertEvent` that reshapes `session.updated` but passes other events through unchanged. Verify that.
5. **Restart opencode-serve once more if necessary** with the instrumented plugin to force fresh instances. Currently running serve was restarted ~21:00 by the user, so it MAY already have the instrumented plugin if my edit was in place at that time (it was — I added the debug log around 20:24 EDT). Check log timestamps to confirm.

## Sibling sessions on this machine

- `ses_1ad924e42ffeQnQXV874SLFoBt` ("Collaboration test" in /home/dev/projects/workstation) — pinged me via swarm earlier confirming pigeon daemon is reachable. May have additional context if asked.
- `ses_1acf75778ffeetvtWL5NhRCOHN` ("hi pigeon") — the failing /launch the user just sent. Its idle event SHOULD have fired notifyStop and didn't. Inspect its opencode-serve view + look for it in the latest serve log:
    curl -s "http://127.0.0.1:4096/session/ses_1acf75778ffeetvtWL5NhRCOHN" -H "x-opencode-directory: /home/dev/projects/pigeon" | jq .
    grep "ses_1acf75778" ~/.local/share/opencode/log/<latest>.log

## Don'ts

- **DON'T** restart opencode-serve again unless you have a clear reason. Each restart cuts over the entire system; the user has been patient.
- **DON'T** assume the bus race fix is "the cause". The patch is correctly applied — the symptom persists. Treat root cause as still unknown.
- **DON'T** revert the patch yet. It might still be necessary even if insufficient. Verify any new hypothesis BEFORE proposing a rollback.

## Pre-cutover post-cutover verification recipe

I left a verification recipe at `/tmp/post-cutover-verification.md` written before the cutover. Some of it (the smoke test) is now outdated since the smoke test failed.

## Files modified in this session (uncommitted!)

- `/home/dev/projects/pigeon/packages/opencode-plugin/src/index.ts` — added `log("DEBUG message.updated raw", ...)` instrumentation. **Uncommitted.** Should stay uncommitted until the bug is actually identified and a real fix lands.

---

## 2026-05-25 ~23:00 EDT — Post-cutover burn-in (in progress)

### Cutover status: SHIPPED, NOT VALIDATED

The v1.15.10 cutover completed on cloudbox:
- `opencode-serve` running `opencode-patched-1.15.10.1`, both health endpoints green.
- workstation `home.base.nix` bumped to `upstreamVersion = "1.15.10"`, all 4 SRI hashes refreshed (commit `e525d02`, pushed to workstation main).
- `opencode-patched` main @ `051f7c2` (9 patches rebased to v1.15.10, `bus-eager-subscribe.patch` deleted as #27959 ships upstream from v1.15.5).
- `opencode-cached` main @ `6e5d1c0` (caching.patch rebased to v1.15.10).
- Release `v1.15.10-patched.1` published with all 4 platform assets.

**Devbox is intentionally NOT updated.** Still on v1.15.0 as a known-good fallback while cloudbox burns in.

### Empirical observations under light traffic

| Criterion | Result | Notes |
|-----------|--------|-------|
| (a) Telegram reply on stop notification | **✅ user confirmed** | "they indeed ring on my phone" — multiple stop notifications during this session |
| (b) `bus type=* subscribing` fires once per directory | **❌** | Still fires twice (once per plugin instance) |
| (c) `message.updated` + `session.idle` + `notifyStop` in same instance per session | **✅** | Each session sticks to one instance end-to-end, no cross-instance partition |
| (d) One `instanceId` per directory | **❌** | Two instances (`qpoj5ido`, `hwdykzwf`) materialize per `/home/dev/projects/pigeon` |

**Key finding:** The dual-plugin-instance materialization is STILL happening in v1.15.10 — same empirical signature as v1.15.0. BUT v1.15.10's bus fix (#27825/#28051) ensures both instances receive both event types via `attachWith` sync publish, so each session's events route to a single instance consistently. The cross-instance EVENT PARTITION is gone even though the dual instance materialization itself persists.

### What we did NOT prove

The original bug as the user described it was **intermittent under load** — random Telegram messages dropping during heavy/concurrent activity. What we observed today is light-traffic delivery success. That doesn't refute the bug exists nor prove v1.15.10 fixes it. v1.15.0 could likely have delivered the same two light-traffic notifications.

### Burn-in plan (CURRENT STATE)

**Verdict status: PENDING. Burn-in in progress.**

- **Cloudbox**: v1.15.10 in normal use. Diagnostic instrumentation REMAINS in `packages/opencode-plugin/src/index.ts` (uncommitted). Watch for Telegram drops over 3-5 days of normal use.
- **Devbox**: stays on v1.15.0. Update procedure when ready (after cloudbox burn-in passes):
  1. `cd ~/projects/workstation && git pull` (picks up `e525d02`).
  2. `home-manager switch --flake .#dev@devbox` (or applicable flake target).
  3. `sudo systemctl restart opencode-serve`.
  4. Verify `curl http://127.0.0.1:4096/global/health` returns `"version":"1.15.10"`.
  5. See `cross-device-deployment` skill for the careful version.

### Burn-in success criteria

- ✅ No random Telegram drops over 3-5 days of normal pigeon use under varied load (single sessions, multiple parallel sessions, fast follow-ups).
- ✅ No new regressions introduced by v1.15.10 (model selection, MCP, vim mode, cache behavior).
- ✅ No upstream patch-incompatibility issues surface.

If all pass: revert diagnostic instrumentation (`git checkout -- packages/opencode-plugin/src/index.ts`), then update devbox.

### Burn-in failure modes to watch for

If drops happen during burn-in, **immediately** grab the active log from `~/.local/share/opencode/log/` before it rotates (logs rotate on opencode-serve restart). The instrumentation will capture:
- `[i=<id> d=<dir>]` tag on every plugin log line.
- `DEBUG event entry` for every event the plugin sees.
- `DEBUG message.updated raw` showing `hasInfo`, `role`, `propsKeys`.
- `DEBUG messageTail.onMessageUpdated done` showing `msgId`, `tailCurrent`.
- `DEBUG session.idle received` and `DEBUG session.idle after awaitRegistration` showing `currentMsgId`.

If a session shows `message.updated` going to one `instanceId` and `session.idle` going to a different `instanceId`, the partition theory is right and v1.15.10 didn't fix it. If both go to the same `instanceId` but `currentMsgId` is undefined or `notifyStop` is never sent, there's a different bug.

### Open beads / tracking

- `ccr-mu1` was claimed in the resumption prompt as the durable tracker but **does not exist** in `.beads/beads.left.jsonl` (only `ccr-mud` and unrelated IDs found 2026-05-25). This HANDOFF doc is the authoritative tracker for now. If beads come back online, file a fresh bead pointing at this doc.

### Known TUI bug investigated 2026-05-25 23:08 EDT — **NOT** a TUI bug

User reported a form-submit hang: after answering a question via the `Question` tool, the form stays up; cannot submit a different answer; cannot escape; cannot Ctrl-C. Recovery requires killing the parent terminal.

**Investigation (2026-05-25 23:08 EDT) found this is the SAME bug as the Telegram-stop notification race.** Same root cause (`InstanceState` partition across fibers), different symptom.

#### Evidence

Server log `2026-05-26T025259.log` for question `que_e623a2ff20011WCv63s7EeQW9X`:

```
03:00:41  service=question id=que_e623a2ff... questions=1 asking            ← Question.ask creates pending entry in InstanceState A
03:00:41  service=opencode-pigeon ... question.asked (i=hwdykzwf)            ← bus event fires
03:00:49  service=question requestID=que_e623a2ff... reply for unknown request  ← user picks option → Question.reply runs in fiber that resolves to InstanceState B → pending.get returns undefined
03:01:23  service=question requestID=que_e623a2ff... reply for unknown request  ← user retries submit → same NotFound
03:01:41  service=question requestID=que_e623a2ff... reject for unknown request ← user mashes Esc
03:01:42  (3 more rejects in 700ms)
03:01:57–03:02:09  (15 more rejects over ~12s — user mashing keys, all NotFound)
```

22 rejects over 30s, all returning "not found" for a question that exists in *some* InstanceState. The TUI form stays up because no `question.replied`/`question.rejected` bus event ever publishes — the server's `Deferred` in InstanceState A is never resolved.

#### Root cause

`packages/opencode/src/question/index.ts` uses `InstanceState.make<State>` (line 136) and `InstanceState.get(state)` (lines 160, 186, 203, 219) to access the pending map. When `Question.ask` runs from a tool-execution fiber and `Question.reply` runs from an HTTP-handler fiber, they resolve `InstanceRef` from their respective fiber contexts. These can resolve to DIFFERENT InstanceState objects when multiple plugin instances materialize per directory (the same dual-instance materialization confirmed in instrumentation).

PR #27825/#28051 in v1.15.10 only patched `Bus.publish` to thread `InstanceContext`. They did NOT patch other services that call `InstanceState.get` from fibers different than the `InstanceState.make` site. Any such service can hit the same partition.

The Question service is currently the most visible victim. Other services with the same pattern (Permission, Session, etc.) are likely affected too but produce less user-visible symptoms.

#### Implication for v1.15.10 burn-in

The "bus race fix" we just deployed is **incomplete**. v1.15.10 fixes ONE symptom (cross-instance event partition in `bus.publish`) but does NOT fix the underlying InstanceState partition. The Telegram stop notifications happen to work in v1.15.10 because that specific code path goes through `bus.publish`, which now threads context.

Question dialogs and any other code path that calls `InstanceState.get` from a non-tool, non-session fiber is still broken.

**The Telegram drop bug user remembers MAY return** if any plugin event handler reaches for `InstanceState.get`-backed services from a context-mismatched fiber. The current passing test (notifications worked under light load today) is not conclusive — we'd need to know whether under heavy load the bus.publish path is still the *only* hop, or whether additional InstanceState-dependent code paths get exercised.

#### Upstream status

- v1.15.10 already includes PR #28693 "fix(httpapi): return request not found errors" (Dax, 2026-05-22) which is the surface fix. It does NOT fix the root cause; it just maps `Question.NotFoundError` → `QuestionNotFoundError` HTTP error properly. The TUI doesn't react to that error specifically.
- `git log v1.15.10..upstream/dev -i --grep=instance` shows no pending root-cause fixes on `dev`. None of the 28 commits since v1.15.10 touch `instance-state.ts` or `question/index.ts`.
- This bug has not been reported upstream (or is hidden in the existing instance-context cluster #27391/#27023/#26697/#26635/#27425/#27959/#28051). Worth filing.

#### Test for "is this fixed?"

A reliable repro test: ask a single-option question (single, not multiple) and immediately pick an option. If the form dismisses cleanly, the InstanceState partition is gone for the question path. If "reply for unknown request" appears in the server log, the bug persists.

This is a STRONGER test than the Telegram-drop test because:
- Deterministic — fails on first picky-question hang.
- Symptom is immediate and obvious (form hangs).
- Requires no load.

#### Next-step options

1. Live with it — workaround is kill terminal + re-attach. Not great but not catastrophic.
2. File upstream issue with reproducible log evidence. Push for a real `InstanceState` fix.
3. Patch our `opencode-patched` to thread `InstanceContext` through more services (mirror what #27825 did for bus). High effort, high risk of upstream patch conflicts later.
4. Wait for upstream — they're aware of the instance-context cluster and may converge on a deeper fix.

Recommended: **2 + 1**. File upstream with full evidence; live with it locally until they ship a real fix.
