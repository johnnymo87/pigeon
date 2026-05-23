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

## Fix options (current best understanding)

1. **Pigeon plugin workaround (lowest risk):** stuff `messageTail` + `sessionManager` + `tokenTracker` in a `globalThis.__pigeonState` Map keyed by `ctx.directory` so both plugin instances share state. No opencode changes needed.
2. **opencode-patched deeper fix:** make `InstanceState.make`'s `ScopedCache.make.lookup` actually single-flight per directory (via `Effect.cached` or explicit mutex), OR make `publish()` fan out to all known wildcard PubSubs across cached InstanceStates.

Recommended starting point: option 1 plus a workstation-side issue filed upstream describing option 2.

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
