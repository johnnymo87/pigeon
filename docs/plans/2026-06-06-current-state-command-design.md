# `/current-state` Command Design

## Problem

When several opencode TUIs are open in the `main` tmux session on a machine,
there's no quick way from Telegram to see what they're all doing or to jump
back into one. The per-session stop/question notifications that act as
swipe-reply handles scroll out of reach over time, so re-engaging an older
session means hunting for its last notification or copy-pasting a session ID.

We want a single command that, on demand, surveys the current `main`-session
TUIs and drops a fresh, swipe-reply-able handle for each.

## Solution

Add `/current-state [machine]` (defaults to `cloudbox`). The worker routes it
to one machine's daemon, which:

1. Enumerates the `main` tmux session allowlist (same definition as
   `reset-workspace`: opencode TUIs whose process is a descendant of a `=main`
   tmux pane).
2. Enriches each session via opencode serve (title, dir, active/idle, last
   activity, a short snippet).
3. Sends a single **index header** message, then **one state card per session**.
   Each card is sent through the existing notification plumbing, so it doubles
   as a swipe-reply handle (token minted, `message_id → session` mapping stored)
   exactly like a stop notification.

"Active vs idle" and the per-session card are the user-facing payload; the
swipe-reply handle is the actionable part.

## Scope

- **Worker `webhook.ts`**: new `/current-state [machine]` regex, default
  machine, machine-liveness guard, queue a new `current_state` command type.
- **Worker types**: add `"current_state"` to the `CommandType` union; confirm
  D1 command insert accepts it.
- **Daemon**: new `current_state` dispatch branch in the poller →
  `ingestCurrentStateCommand`; new `main-session-allowlist.ts` (enumeration) and
  `current-state-ingest.ts` (orchestration); new `formatStateCard()` +
  `sendStateCard()` in `notification-service.ts`.
- **No D1 schema changes** — the existing `messages` table maps notification
  `message_id → session_id` for swipe-reply resolution; cards reuse it.
- **No new persistent daemon state.**

## Command surface & routing (worker)

Regex `^/current-state(?:\s+(\S+))?$`, matched ahead of the generic message
handler.

- `machineId = match[1] ?? "cloudbox"`.
- `isMachineRecent(db, machineId)` → "`<machine>` is not recently seen." on miss.
- `queueCommand(db, env, machineId, null, "", chatId, null, "current_state")`
  (sessionId null, empty command).
- Ack: "Fetching current state on `<machine>`…".

The daemon poller gains a `current_state` branch that calls
`ingestCurrentStateCommand`.

## Enumeration (daemon)

`main-session-allowlist.ts`, a pure function with injected `tmux` / `pgrep` /
`/proc` readers (so it is unit-testable without a live tmux server). Mirrors the
`reset-workspace` allowlist:

1. `tmux list-panes -s -t '=main' -F '#{pane_pid}'` → pane pids; walk each
   subtree via `pgrep -P` recursively → `MAIN_PIDS`.
2. **Strict/argv branch:** scan `pgrep -u dev -f 'opencode attach'`, keep pids in
   `MAIN_PIDS`, extract `--session ses_xxx` from `/proc/<pid>/cmdline`.
3. **Bare-cwd branch:** for bare `:te opencode` TUIs in `MAIN_PIDS` (no
   `--session`), resolve their `/proc/<pid>/cwd` to the most-recent root session
   via `GET /session?directory=…&roots=true&limit=1`.
4. Dedupe sids.

The daemon already reaches the user's tmux server when it spawns `oc-auto-attach`
for `/launch`, so socket access is a solved problem (same process env). If a
`main` session is absent the result is empty.

## Enrichment & active/idle (per sid)

- `GET /session/<sid>` → `title`, `directory`, `tokens` (context usage),
  `time.updated`.
- `GET /session/<sid>/message` → last message:
  - **🟢 active** = last message is an assistant message with no `time.completed`
    (still generating), or a user message with no assistant response yet.
  - **⚪ idle** = last message is a completed assistant message.
  - **snippet** = last assistant text part, trimmed (~200 chars).
  - **last-activity** = newest message timestamp, rendered relative ("2m ago").
- A sid that 404s (TUI alive, session gone from serve) is skipped and counted as
  "(N unreadable)".

## Output (index + cards)

- **Index header** — a plain message (no session binding), e.g.:

  ```
  📋 Current state — cloudbox
  3 main sessions · 1 🟢 active · 2 ⚪ idle

  1. <title> 🟢
  2. <title> ⚪
  3. <title> ⚪
  ```

- **State cards** — one per session, **ordered by last-activity descending**, no
  cap (every main session gets a card). `formatStateCard()` builds:

  ```
  🟢 <title>
  <snippet>

  📂 <dir-short> · 🖥 cloudbox
  🆔 <sid>
  ↩️ Swipe-reply to respond · 2m ago
  ```

  `sendStateCard()` reuses the token-mint + `message_id → session` registration
  that `sendStopNotification` already performs, so each card is a working
  swipe-reply handle.

## Error handling

- No `main` session / zero sids → single message "No main-session TUIs found on
  `<machine>`."
- opencode serve unreachable → "opencode serve is not running on `<machine>`."
  (mirrors `launch-ingest`'s health check).
- Individual card send failures are logged and best-effort; the index still
  goes out.

## Testing (vitest, TDD)

- Worker: `/current-state` regex + default machine + recent-machine guard +
  queued command type `current_state`.
- Enumeration: injected readers → main-subtree filtering, argv sid extraction,
  bare-cwd resolution, dedupe, no-main-session.
- Active/idle classifier: assistant-completed → idle; assistant-incomplete →
  active; user-last → active; empty history.
- Ingest: mocked `opencodeClient` + notifier → asserts index + N cards in
  last-activity order; 404/empty handling.
- `formatStateCard` output shape.

## Deployment

- Worker: `npm run --workspace @pigeon/worker deploy`.
- Daemon: `git pull && npm install` + restart the daemon service on cloudbox
  (per `cross-device-deployment`).

## Open risks

- **tmux reachability from the daemon.** De-risked by the `oc-auto-attach`
  precedent, but the enumeration must invoke tmux with the same socket the user's
  `main` session lives on; verify on cloudbox before relying on it.
- **Enumeration drift.** The ~20-line allowlist scan is duplicated from
  `reset-workspace`. If the "main TUI" definition churns, both must change. If
  this becomes a maintenance burden, lift the scan into a shared
  `main-session-sids` workstation binary (the rejected Approach B).

## Post-launch revision (2026-06-06): drop the bare-cwd branch

**Status: IMPLEMENTED & DEPLOYED** (pigeon `origin/main` @ `aff936c`; daemon
restarted on cloudbox 2026-06-06; live enumeration confirmed the lgtm/morning-agent
noise is gone — only deterministic `--session` sessions remain). The feature shipped and
deployed (pigeon `origin/main` @ `b001fb3`; workstation `43aa691`; worker
`ccr-router` v`a92b5348`; daemon restarted with `TMUX_BIN`/`PGREP_BIN`). A live
run surfaced a lot of automation-session noise (lgtm dispatch, morning-agent /
"context enrichment", review sessions).

**Root cause (debugged on cloudbox):** the **bare-cwd branch** is the noise
source. Bare `opencode` TUIs (`:te opencode`, no `--session`, genuine TUIs under
nvim panes in `main`) cd'd into broad project-root dirs resolve via
`GET /session?directory=<cwd>&roots=true&limit=1` to whatever root session most
recently ran in that dir — frequently automation (lgtm in `~/projects/lgtm`,
morning-agent in `~/projects/workstation`). Session metadata gives NO clean
filter signal: lgtm/morning-agent and real work are all `agent:"build"`,
`parentID:null`, random slugs. The morning-agent session lives in
`~/projects/workstation` (a real work dir), so a directory denylist can't remove
it without hiding workstation work. The structural signal is the branch itself:
the argv `--session` branch is deterministic and matches sessions the user's
tooling (oc-auto-attach / `/launch` / swarm) deliberately attached.

**Decision:** DROP the bare-cwd branch. `/current-state` shows only TUIs with an
explicit `--session ses_xxx` in argv. (The orphaned lgtm `--session` TUI whose
session 404s is already handled: counted "unreadable", no card.)

**Exact changes (TDD; one focused commit):**
1. `packages/daemon/src/main-session-allowlist.ts`: remove the bare branch from
   `enumerateMainSessionSids` (keep the argv `--session` branch, subtree walk,
   exe filter, regexes, `parsePids`). Remove `readCwd` and `resolveSidByDir` from
   `AllowlistDeps`. `makeLiveDeps` no longer builds those and no longer needs the
   opencodeClient arg → `makeLiveDeps(): AllowlistDeps`.
2. `packages/daemon/test/main-session-allowlist.test.ts`: invert/remove the
   bare-branch tests — a bare `…/opencode` TUI (no `--session`) now yields NO sid.
   Drop `readCwd`/`resolveSidByDir` from the mock deps. Keep argv / subtree /
   dedupe / empty / `-wrapped` / serve-excluded / sid-charset tests. The
   tail/vim/serve "contributes nothing" assertions still hold.
3. `packages/daemon/src/opencode-client.ts`: remove `listSessionsByDirectory`
   (added in Task 5 solely for `resolveSidByDir`; grep to confirm no other user).
4. `packages/daemon/test/opencode-client.test.ts`: remove its tests.
5. `packages/daemon/src/index.ts`: `makeLiveDeps(opencodeClient)` →
   `makeLiveDeps()`.
6. `current-state-enrich.ts` / `current-state-ingest.ts` / formatters: unchanged
   (`getSessionInfo` + `getSessionMessages` still used).

**Verify:** `npm run typecheck` + `npm run --workspace @pigeon/daemon test` green.
**Deploy (no Nix change this time):** push pigeon; on cloudbox
`cd ~/projects/pigeon && git pull` then `sudo systemctl restart
pigeon-daemon.service` (tsx reloads source; the unit is unchanged so NO
nixos-rebuild). Worker is unaffected (no worker change). Then user re-tests
`/current-state`.
