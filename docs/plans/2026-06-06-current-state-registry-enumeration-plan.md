# Registry-based /current-state enumeration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (this session) or superpowers:executing-plans (separate session) to implement this plan task-by-task.

**Goal:** Make `/current-state` report every opencode TUI live in the `main` tmux session and the session each shows — including bare `opencode` TUIs — by resolving each live TUI pid to a session via a layered lookup (exact-focus runtime file → daemon `sessions` registry → argv).

**Architecture:** Keep the `main`-subtree process walk, but use it only to get the set of live opencode pids in `main`. Resolve each pid → one session by precedence: (a) `$RUNTIME/opencode/tui/<pid>.json` written by an opencode-patched core patch [Phase 2]; (b) newest `sessions` registry row for that pid [Phase 1]; (c) `--session` in argv [existing]. One card per pid. Enrichment/index/cards unchanged.

**Tech Stack:** TypeScript, Node, `better-sqlite3`, vitest, bun-compiled opencode (patched), neovim/tmux on Linux.

**Design:** `docs/plans/2026-06-06-current-state-registry-enumeration-design.md`. Prior context: `docs/plans/2026-06-06-current-state-command-design.md`.

**Repo / host:** pigeon = `/home/dev/projects/pigeon` (branch `main`, host cloudbox). opencode-patched = `/home/dev/projects/opencode-patched` (separate repo, Phase 2 only). workstation = `/home/dev/projects/workstation` (Phase 2 deploy only).

---

## CRITICAL process rules (every task)

- **TDD:** write failing test → run red → minimal impl → run green → commit.
- **Commit only; never push** (the orchestrator pushes). One commit per task.
- **Never `git add -A`/`git add .`** — stage only the exact files in the task.
- **Do NOT touch these pre-existing, unrelated working-tree changes:**
  `packages/opencode-plugin/src/index.ts`, anything under `.beads/`,
  `.opencode/package-lock.json`. After staging, run `git status` and confirm the
  staged set is exactly the task's files.
- **Verify before commit:** `npm run typecheck` and
  `npm run --workspace @pigeon/daemon test` green.

---

# PHASE 1 — pigeon only (ships first, no opencode change)

## Task 1: Extract a shared "live opencode pids in main" helper

**Files:**
- Modify: `packages/daemon/src/main-session-allowlist.ts`
- Test: `packages/daemon/test/main-session-allowlist.test.ts`

Refactor the subtree walk out of `enumerateMainSessionSids` into a reusable
exported helper (no behavior change to `enumerateMainSessionSids`).

**Step 1 — test (red):** add a test asserting the helper returns only subtree
pids whose `readCmdline` is non-empty (i.e. opencode processes), walking
children:

```ts
it("collectMainSubtreeOpencodePids returns opencode pids in the main subtree", async () => {
  const deps = makeDeps({
    mainPanePids: [1000],
    children: { 1000: [1001, 1002] },
    cmdlines: {
      1000: "bash",                                   // not opencode -> excluded
      1001: "/home/dev/.nix-profile/bin/opencode",    // opencode -> included
      1002: "/home/dev/.nix-profile/bin/opencode attach --session ses_A", // included
    },
  });
  const pids = await collectMainSubtreeOpencodePids(deps);
  expect(pids.sort()).toEqual([1001, 1002]);
});
```

Note: `readCmdline` already returns `""` for non-opencode exes (it does the
`/proc/<pid>/exe` basename check), so "non-empty cmdline" == "is opencode".

**Step 2 — run red:** `npm run --workspace @pigeon/daemon test main-session-allowlist` → fails (helper undefined).

**Step 3 — implement:** export `collectMainSubtreeOpencodePids(deps: AllowlistDeps): Promise<number[]>` doing the existing `seen`/`stack` walk, then filtering to pids where `await deps.readCmdline(pid)` is non-empty. Refactor `enumerateMainSessionSids` to call it (then run its argv match over those pids) so existing tests still pass.

**Step 4 — run green:** the file's whole suite passes.

**Step 5 — commit:** `git add packages/daemon/src/main-session-allowlist.ts packages/daemon/test/main-session-allowlist.test.ts && git commit -m "refactor(daemon): extract collectMainSubtreeOpencodePids helper"`

## Task 2: Layered resolver `resolveMainSessionSids`

**Files:**
- Modify: `packages/daemon/src/main-session-allowlist.ts`
- Test: `packages/daemon/test/main-session-allowlist.test.ts`

Add a resolver that maps live main-subtree opencode pids → deduped session ids
using registry-newest then argv. Inject the registry as a plain function for
testability.

Signature:
```ts
export interface RegistrySession { sessionId: string; pid: number | null; lastSeen: number; }
export async function resolveMainSessionSids(
  deps: AllowlistDeps,
  listActiveSessions: () => RegistrySession[],
): Promise<{ sids: string[]; homeScreenCount: number }>
```

Logic: build `byPidNewest: Map<pid, RegistrySession>` (max `lastSeen`). For each
pid from `collectMainSubtreeOpencodePids`: resolve `sid` = registry row for pid,
else argv (`ATTACH_RE.test(cmd)` + `SID_RE` match). Collect sids in insertion
order, dedup via a `Set`. Count pids that resolved to **no** sid as
`homeScreenCount`. Return `{ sids: [...set], homeScreenCount }`.

**Step 1 — tests (red):** cover:
- registry-newest: two rows for pid 1001 (older `ses_OLD`, newer `ses_NEW`) → resolves `ses_NEW`.
- argv fallback: pid 1002 has no registry row but argv `--session ses_B` → `ses_B`.
- precedence: pid 1003 has BOTH a registry row `ses_R` and argv `--session ses_C` → registry wins (`ses_R`).
- dedup: two pids resolve to same `ses_X` → appears once.
- home-screen count: a bare opencode pid with no registry row and no `--session` argv → contributes to `homeScreenCount`, not to `sids`.
- non-opencode pids excluded (no cmdline).

Use a fake `listActiveSessions` returning `RegistrySession[]`, and `makeDeps` for procfs/tmux.

**Step 2 — run red.** **Step 3 — implement.** **Step 4 — run green.**

**Step 5 — commit:** `... -m "feat(daemon): layered resolveMainSessionSids (registry-newest then argv)"`

## Task 3: Surface home-screen count in the index

**Files:**
- Modify: `packages/daemon/src/notification-service.ts` (`formatCurrentStateIndex`)
- Modify: `packages/daemon/src/worker/current-state-ingest.ts`
- Test: the corresponding `*.test.ts` for each

`formatCurrentStateIndex` currently takes `{ machineId, sessions, unreadable }`.
Add optional `homeScreen?: number`; when `> 0`, append `· N on home screen` to
the index summary line (mirror the `unreadable` treatment).

**Step 1 — test (red):** index formatter includes "1 on home screen" when `homeScreen: 1`. **Steps 2-4** as usual. **Commit** with both files + tests.

## Task 4: Wire the resolver into `onCurrentState`

**Files:**
- Modify: `packages/daemon/src/worker/current-state-ingest.ts`
- Modify: `packages/daemon/src/index.ts` (`onCurrentState`, ~line 173-191)
- Test: `packages/daemon/test/current-state-ingest.test.ts`

Change the ingest to obtain `{ sids, homeScreenCount }` from an injected
`enumerate` and thread `homeScreenCount` into `formatCurrentStateIndex`. Keep
all existing invariants (healthCheck; index-before-cards; registerSession before
sendCard; per-record try/catch; sort by lastActivity).

In `index.ts`, build the enumerate closure (confirm the SessionRepository
accessor — likely `storage.sessions`):
```ts
enumerate: () => resolveMainSessionSids(
  makeLiveDeps(),
  () => storage.sessions.list({ active: true })
     .map(s => ({ sessionId: s.sessionId, pid: s.pid, lastSeen: s.lastSeen })),
),
```
(Confirm `storage.sessions.list({active:true})` exists and returns `SessionRecord[]` with `sessionId/pid/lastSeen`; adapt mapping if names differ.)

**Step 1 — test (red):** update/extend ingest tests for the new `enumerate`
return shape and that `homeScreenCount` reaches the index. **Steps 2-4.**
**Step 5 — commit** (`index.ts`, `current-state-ingest.ts`, ingest test).

## Task 5: Phase-1 verification + deploy

- Run `npm run typecheck` and `npm run --workspace @pigeon/daemon test` — all green.
- **Orchestrator pushes**, then on cloudbox `sudo systemctl restart pigeon-daemon.service` (tsx reloads; no nixos-rebuild). Verify active/listening.
- Live check: run the resolver against the live box (or trigger `/current-state`)
  and confirm the bare mono sessions now appear (e.g. ses_17ca3cca / ses_1afc6c44
  / ses_167e5e92), with one card per live TUI and no `lgtm`-session noise.

---

# PHASE 2 — exact focus via opencode-patched runtime file

## Task 6: Runtime-file path + reader (pigeon)

**Files:**
- Create: `packages/daemon/src/tui-runtime-file.ts`
- Test: `packages/daemon/test/tui-runtime-file.test.ts`

Implement:
```ts
export function resolveTuiRuntimeDir(env = process.env): string // ${XDG_RUNTIME_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/opencode/run}/opencode/tui
export interface FocusFile { v: number; pid: number; startTime?: string; sessionID: string; directory?: string; updatedAt?: number; }
export async function readFocusedSession(pid: number, deps: { readFile, statStartTime }): Promise<string | null>
```
`readFocusedSession` reads `<dir>/<pid>.json`, parses, returns `sessionID` only
if (a) JSON valid, (b) `sessionID` matches `/^ses_[A-Za-z0-9_-]+$/`, and (c) if
`startTime` present, it equals the `/proc/<pid>/stat` field-22 start time from
`deps.statStartTime(pid)` (PID-reuse guard). Else `null`.

**Step 1 — tests (red):** valid file → sid; missing file → null; malformed JSON
→ null; bad sid format → null; startTime mismatch → null; startTime match → sid.
Inject `readFile`/`statStartTime` fakes. **Steps 2-4. Commit.**

## Task 7: Insert runtime-file as resolution layer (a) (pigeon)

**Files:**
- Modify: `packages/daemon/src/main-session-allowlist.ts` (`resolveMainSessionSids`)
- Modify: `packages/daemon/src/index.ts` (wire the reader deps)
- Test: `packages/daemon/test/main-session-allowlist.test.ts`

Add an injected `readFocus?: (pid:number)=>Promise<string|null>` to the resolver;
per pid try `readFocus(pid)` FIRST, then registry, then argv. Keep
`homeScreenCount` (pid that resolves to nothing in all three).

**Step 1 — tests (red):** focus-file present → wins over registry+argv; focus
null → falls back to registry; focus+registry both null → argv. **Steps 2-4.
Commit** (resolver + index wiring + tests).

## Task 8: opencode-patched core patch (separate repo)

**Repo:** `/home/dev/projects/opencode-patched` (own branch/commit/PR flow).

- Add a patch to the reactive current-session effect in
  `packages/opencode/src/cli/cmd/tui/app.tsx` (~455-476, where it calls
  `renderer.setTerminalTitle("OC | …")`). On a `session` route, atomically write
  `<runtimedir>/opencode/tui/<process.pid>.json` = `{ v:1, pid, startTime (read
  /proc/self/stat field 22), sessionID: route.data.sessionID, directory,
  updatedAt: Date.now() }` (write temp + rename). On `home` route / process exit,
  best-effort unlink. **The runtime-dir resolution MUST byte-match
  `resolveTuiRuntimeDir` in pigeon.**
- Register the patch in `apply.sh`; rebuild per the repo's README; smoke test:
  open a bare `opencode`, switch sessions, confirm the file appears/updates and
  is removed on quit.
- Commit/PR in opencode-patched; cut a release.

## Task 9: Deploy Phase 2 (workstation)

- Bump the opencode-patched release/hash in workstation `home.base.nix` (or let
  `.github/workflows/update-opencode-patched.yml` open the PR), merge, then on
  cloudbox `sudo nixos-rebuild switch --flake .#cloudbox` and re-apply
  home-manager if needed.
- Restart any opencode instances so the patched build runs; live-verify
  `/current-state` now resolves the exact focused session per TUI and includes
  idle-but-showing-a-session TUIs.

---

## Execution notes
- Phases are independent: Phase 1 delivers most of the value with zero opencode
  changes and should be shipped + verified before starting Phase 2.
- After Phase 1 lands, update the design doc status line and (optionally) the
  original `current-state-command-design.md` cross-reference.
