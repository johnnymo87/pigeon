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
