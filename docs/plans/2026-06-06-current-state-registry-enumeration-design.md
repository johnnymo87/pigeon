# /current-state registry-based enumeration + exact-focus runtime files

Date: 2026-06-06
Status: APPROVED (design); implementation pending
Follows: `2026-06-06-current-state-command-design.md` (original feature + the
bare-cwd-branch removal)

## Problem

`/current-state` surveys the opencode TUIs in the user's `main` tmux session and
sends one status card per session. After we removed the unreliable "bare-cwd"
resolution branch, `/current-state` only reports TUIs launched as
`opencode attach … --session ses_X` (the sid is in argv). It is **blind to bare
`opencode` TUIs** (launched as plain `opencode`, typically via `:terminal
opencode` in neovim) — which is how the user runs much of their work (e.g. 6 bare
TUIs in the `mono` repo root, each showing a different session). Those sessions
(e.g. "COPS-4774 simulation reboot", "runaway gemini") never appear.

A bare TUI's session id is **not** in its argv/cwd/environ/fds, and (opencode
1.16.2) the bare TUI serves its API only in-process via bun Worker RPC against a
fake `http://opencode.internal` base URL — its one real listening port is
**pigeon's own `direct-channel` server** (`/pigeon/direct/execute`), which is why
that port 404s on `/session`. So there is no opencode-native way to ask a bare
TUI which session it is showing.

## Key discovery

We do not need title-scraping or to build a new registry. **Pigeon already has
one.** The pigeon opencode plugin runs inside every opencode instance (including
bare TUIs) and calls `registerSession({ sessionId, pid, ppid, cwd, tty,
backendEndpoint, … })` for each root session on activity (`session.created` /
late discovery on `session.idle` / `message.updated` / …). The daemon persists
these in a SQLite `sessions` table (`storage/schema.ts`) keyed by `session_id`
with `pid`, `ppid`, `cwd`, `pty_path`, `backend_endpoint`, `state`, `last_seen`.

Verified: all 4 of the user's missing sessions are in that table, and 3 of 4 map
exactly to the live bare-TUI pids found in the `main` subtree (146150, 94273,
144689); the 4th maps to a now-orphaned pid (its TUI was replaced) — the idle/
stale-focus gap that Phase 2 closes.

A ChatGPT/source consult (see `/tmp/research-opencode-tui-session-*.md`)
confirmed there is no first-class opencode mechanism, and that the cleanest way
to get the *exact, current* focused session is to export it from inside the TUI.
Because the user already maintains an `opencode-patched` stack, a tiny core patch
is acceptable and is the most robust option.

## Decisions

1. **One card per live TUI**, showing the **most-recently-active** session for
   that pid when several are registered (Phase 1). Phase 2 makes it the exact
   focused session.
2. **Phase 2 mechanism = tiny core patch → per-pid runtime file.** Hook the
   existing reactive "current session" effect in opencode's TUI (`app.tsx`,
   ~lines 455–476, already runs on every focus change) to atomically write/remove
   `$RUNTIME/opencode/tui/<pid>.json = { sessionID, … }`; the daemon reads it
   directly. (Chosen over sid-in-title + nvim scrape, and over a TUI plugin.)
3. **Home-screen TUIs** (live TUI with no session — never opened one): omit the
   card, but include a count in the index ("N TUIs on home screen").

## Architecture — layered resolution per live TUI pid

Keep the `main`-subtree process walk, but use it only to produce the **set of
live opencode pids in `main`** (ground truth for "what TUIs are running"). Then
resolve each pid → session by precedence (first hit wins):

- **(a) exact focus [Phase 2]:** read `$RUNTIME/opencode/tui/<pid>.json` →
  `{sessionID, startTime}`; validate `startTime` against `/proc/<pid>` to defeat
  PID reuse. Exact, current, covers idle-but-showing-a-session TUIs.
- **(b) registry newest [Phase 1]:** `SessionRepository`, rows with `pid==<pid>`
  and `state='running'`, pick `max(last_seen)`.
- **(c) argv [existing]:** `--session ses_X` in the process cmdline.

Then: dedup by `sessionID`; one card per pid; enrich (`getSessionInfo` +
messages) and render exactly as today (index-before-cards; register-before-card).

## Components & changes

### Phase 1 — pigeon only (no opencode change; ships first)

- New layered resolver, e.g. `resolveMainSessionRecords(deps, sessionRepo)`,
  returning `Array<{ pid, sid, source }>`:
  - reuse the subtree walk (`listMainPanePids` + `childrenOf` + exe filter) for
    the live-pid set;
  - for each pid resolve via registry-newest (b) then argv (c);
  - dedup by sid; one record per pid.
- Wire the daemon `SessionRepository` into the `/current-state` path
  (`index.ts onCurrentState`).
- Keep the existing argv allowlist code as resolution layer (c) — do not delete.
- `current-state-ingest.ts`: accept resolved records (minor signature change);
  keep enrichment/sort/index/card logic and all invariants.

### Phase 2 — opencode-patched + pigeon + workstation

- **opencode-patched:** new patch in the reactive current-session effect
  (`packages/opencode/src/cli/cmd/tui/app.tsx`, ~455–476). On a `session` route,
  atomically write `…/opencode/tui/<process.pid>.json`; on `home`/exit, remove
  it. ~10–20 lines. Tested via the repo's `apply.sh` + a smoke check.
- **pigeon daemon:** add resolution layer (a): a runtime-file reader (path
  convention below; `startTime`-validated). Slots in front of (b)/(c).
- **workstation:** bump the opencode-patched release/hash (existing auto-update
  pipeline) and rebuild.

## Path & file convention (shared by patch + daemon)

Path: `${XDG_RUNTIME_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/opencode/run}/opencode/tui/<pid>.json`
(both sides MUST resolve identically). Content:

```json
{ "v": 1, "pid": 146150, "startTime": "<proc stat field 22>",
  "sessionID": "ses_…", "directory": "/home/dev/projects/mono",
  "updatedAt": 1780000000000 }
```

Write atomically (write temp + rename). Best-effort remove on exit / on
navigating to home.

## Filtering / correctness

- Only pids in the live `main`-subtree opencode set are ever consulted →
  excludes the `lgtm` tmux session, detached `serve`, and dead pids **by
  construction** (re-confirms the earlier noise fix).
- Stale registry rows are ignored (their pid isn't in the live set).
- PID reuse: defeated by the live-opencode-in-main gate plus `startTime`
  validation (Phase 2). For Phase 1, the live-gate alone is sufficient in
  practice (a reused pid would have to be another live opencode in `main`).
- Home-screen / unresolvable live TUIs: omitted from cards, counted in the index.

## Error handling

- Per-pid resolution is isolated (try/catch); one bad pid never aborts the
  command.
- Bad/missing runtime file → fall through to registry → argv.
- Registry error → fall through to argv (today's behavior).
- Preserve `healthCheck`, index-before-cards, and register-before-card
  invariants.

## Testing

- **Phase 1:** unit-test the resolver — precedence order, registry-newest pick,
  dedup, pid filtering (live-set gate), argv fallback — with injected fake
  `SessionRepository` + procfs/tmux deps. Adapt `current-state-ingest` tests to
  the records shape. Full daemon suite + typecheck green.
- **Phase 2:** unit-test the runtime-file reader (valid / missing / stale
  startTime / malformed JSON). Smoke-test the opencode patch (writes on navigate,
  removes on exit) via `apply.sh`. Verify path resolution parity between patch
  and daemon.

## Rollout

1. Ship Phase 1 (pigeon-only): commit, push, restart `pigeon-daemon` on cloudbox
   (tsx reloads source; no nixos-rebuild). Covers active TUIs incl. ~3 of the 4
   missing sessions.
2. Ship Phase 2: cut an opencode-patched release with the patch → workstation
   auto-update bumps the hash → `nixos-rebuild`. Closes the idle / stale-focus
   gap and makes the resolved session exact.
