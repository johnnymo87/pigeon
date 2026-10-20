# goose swarm messaging, slice 1 — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A goose session run by honkd can `swarm_send`, `swarm_read` and `swarm_list` like an
opencode session, and receive swarm messages into a pull mailbox it drains with `swarm_read`.

**Architecture:** Two PRs. pigeon (this repo) accepts `gse_` targets and banks them into the
existing `pull_inbox` for goose-acp sessions that opted in, through a new create-if-absent
registration route the MCP server calls. honk ships `honk swarm-mcp`, a stdio MCP server that
honkd offers as a built-in `/mcp` entry named `swarm`; `honk chat --new` enables it by default.

**Tech stack:** pigeon: TypeScript, vitest (`npm test` in `packages/daemon`). honk: Rust 2024,
`cargo test --workspace`, clippy `-D warnings`.

Spec: `docs/plans/2026-10-20-cross-machine-swarm-design.md` §4.1 (slice 1). Beads: under
`pigeon-k0qn.13`.

---

## Decisions that differ from §4.1, and why

1. **Opt-in is a new route, `POST /goose/swarm-mailbox`, not `pull_sources` on
   `POST /goose/sessions` with reset-when-absent.**
   - `/goose/sessions` overwrites the row wholesale and forces `notify: true`. honk chat and
     `honk telegram` re-register without any `pull_sources`; reset-when-absent would silently
     close a mailbox the MCP server opened, between two of its calls.
   - The MCP server must work for `honk chat --new --no-telegram` sessions, which have no pigeon
     row. Registering them through `/goose/sessions` would set `notify: true`, and the session's
     first honkd turn hook would create a Telegram topic the human said they did not want.
   - The new route is **create-if-absent**: with no row it creates a `notify: false` goose-acp row
     (endpoint and honkd token supplied by the caller, so slice 2 can push); with a row it never
     touches anything but `pull_sources` and its liveness (`touch`). It only ever **adds** `swarm`
     to `pull_sources`. It uses the same lookup as `registerGooseSession`
     (`getByBackendSessionId ?? get`, so a legacy row whose pigeon id is goose's id is reused, not
     duplicated). It is idempotent, synchronous (no `await` between lookup and upsert), and the MCP
     server calls it **lazily**, on `swarm_send` / `swarm_read` only — never at start-up — so only
     sessions that actually use swarm get a mailbox.
   - A later `/goose/sessions` (honk telegram) upgrades the row to `notify: true` and keeps
     `pull_sources` (the upsert already leaves it alone).
   - Closing a mailbox is not built (YAGNI): disabling the `swarm` extension leaves it open; banked
     rows expire after 7 days with a `delivery.failed` to the sender. Recorded as a known limit.
2. **A `notify: false` goose-acp row is Telegram-silent.** `/stop` and `/question` already return
   early. Two goose-only paths do not, and would create a topic: the honkd turn hook's prompt
   mirror and turn-end Stop (`/goose/turn-event` → `handleMirrorBody`), and the `w:` swarm feed
   notice on bank. Both gain a `notify` check **for goose-acp rows only**; opencode behaviour does
   not change.
3. **`GET /sessions` gains `pull_sources`** so `swarm_list` can say which goose sessions accept
   messages, instead of letting the sender discover a 409.
4. **A `gse_` target with no local row is refused synchronously** (409 "no goose session … on
   this machine"), not accepted and failed later by the arbiter. Today that `to` is a 400, so this
   is not a behaviour regression, and a goose sender would otherwise only learn of the failure by
   polling its mailbox. (Phase 2 will revisit when it routes `gse_` cross-machine.)
5. **Defence in depth in the outbox sender:** an outbox entry whose session is a goose-acp row with
   `notify: false` is dropped terminally (`notify_false_goose`) before any send or re-register, so
   no future producer can create a topic for a `--no-telegram` session.
6. **The opencode plugin renders `banked: true`** as "waiting in <to>'s mailbox; it is read when
   that session calls swarm_read", instead of "Delivery is async".

Everything else is §4.1 slice 1 as written: `^gse_` accepted as `to`; bank a goose-acp target that
opted in, immediate `409 … has no swarm mailbox` for one that did not; `/swarm/schedule` to `gse_`
refused (the bank helper's existing "scheduled" 409); `/pull/drain` allows `goose-acp`;
`delivery.failed` reaches local `gse_` senders.

## Subagents (honk side)

goose delegate subagents inherit the parent's extensions and spawn their own extension processes
under their **own** session id. Without a guard a subagent's `swarm_send` would mint a new mailbox
and replies would bank where nobody reads. So honkd bakes the owning session's goose id into the
extension's args (`--session <id>`) when it enables `swarm` for that session; the server refuses
any call whose caller id (`_meta` / env) differs, naming the owning session.

## Caller identity (honk side)

goose (patched-1.54.0.9) runs one stdio extension process per (connection, session) and puts the
caller's goose id in **every** MCP request's `params._meta["agent-session-id"]`
(`crates/goose/src/agents/mcp_client.rs`), as well as `AGENT_SESSION_ID` in the process env. The
server uses `_meta` per call and falls back to the env; it maps goose id → `gse_` by calling
`/goose/swarm-mailbox` (no caching), so `from` is always the calling session's own `gse_`.

## Tasks — PR A (pigeon)

### Task A1: accept `gse_` targets; bank or refuse goose-acp

**Files:** `packages/daemon/src/app.ts` (`parseSwarmSendBody` ~:210),
`packages/daemon/src/swarm/bank-or-insert.ts` (~:56), tests
`packages/daemon/test/swarm-goose-acp-mailbox.test.ts` (new).

Tests first (use `createApp(openStorageDb(":memory:"))`, a goose row via `registerGooseSession`
with an injected `gse_` id, and `storage.sessions.setPullSources`):

- `/swarm/send` to an opted-in goose-acp `gse_` → 202 `banked: true`; row in `pull_inbox` with
  `source: "swarm"`; nothing in `swarm_messages`.
- not opted in → 409, error names the session and "no swarm mailbox"; nothing stored anywhere.
- `gse_` with no row → 409 "no goose session … on this machine"; nothing stored.
- `/swarm/schedule` to an opted-in `gse_` → 409 scheduled.
- `ses_` and goose-pull behaviour unchanged (existing tests).
- `to` matching neither prefix → 400 naming both prefixes.

Implementation: regex `^(ses|gse)_[A-Za-z0-9_-]+$`; in the bank helper a target is bankable when
`isPullBackend(t) || t.backendKind === GOOSE_BACKEND_KIND` and `pullSources.includes("swarm")`; a
goose-acp target **without** the opt-in returns `refused` / `no_mailbox` / 409 (new reason); a
`gse_` target with no row returns `refused` / `no_session` / 409.

### Task A2: `POST /goose/swarm-mailbox`

**Files:** `packages/daemon/src/goose/swarm-mailbox.ts` (new, `ensureGooseSwarmMailbox`),
`app.ts` route, tests in the same new test file.

Body `{session_id: <goose id>, endpoint, auth_token?, cwd?, label?}`; `session_id` and `endpoint`
required (400). A `gse_` in `session_id` → 400 (same refusal as `registerGooseSession`). A
non-goose row at that key → 409.

Tests: legacy row (pigeon id == goose id, NULL backend id) is reused, not duplicated; `touch` is
applied (last_seen advances); absent → creates `notify: false` row with endpoint/token/backend id, `pull_sources`
`["telegram-reply","swarm"]`, returns `{ok, session_id: gse_…, backend_session_id, created: true,
notify: false}`; present (registered via `/goose/sessions`) → `created: false`, `notify: true`,
endpoint/token/label untouched, `swarm` added; repeat call idempotent; a later `/goose/sessions`
keeps `pull_sources` and sets `notify: true`; `onSessionStart` is **not** called for a created row.

### Task A3: notify=false goose-acp rows stay off Telegram

**Files:** `app.ts` `/goose/turn-event` (~:1753), `swarm/telegram-notice.ts`.

Tests: turn-event `turn.started` / `turn.ended` for a `notify: false` goose row → `{ok, ignored:
"notify=false"}` and no outbox row; a bank into a `notify: false` goose row writes no `w:` outbox
row; a `notify: true` goose row still gets both (existing tests); an opencode `notify: false`
target still gets its `w:` notice (behaviour unchanged). Outbox sender: an entry for a
`notify: false` goose-acp row is marked terminal `notify_false_goose` without calling the worker
or re-register (test in the outbox-sender tests).

### Task A4: goose-acp may drain its mailbox

**Files:** `app.ts` `/pull/drain` (~:1211). Tests: drain/ack for an opted-in goose-acp session
returns and acks the banked swarm rows; drain for an opencode session still 409s.

### Task A5: `delivery.failed` to `gse_` senders; `pull_sources` in `GET /sessions`

**Files:** `swarm/notify-sender.ts:140`, `app.ts` `toLegacySession`. Tests: a failure for a
message from an opted-in `gse_` sender banks a `delivery.failed` into its mailbox; from a
non-opted-in `gse_` sender it is refused and logged, nothing inserted (no arbiter retry loop);
`GET /sessions` rows carry `pull_sources`.

### Task A6: plugin description, spec note, typecheck, full suite

`packages/opencode-plugin/src/swarm-send-tool.ts`: `to` description mentions `gse_` (goose session,
reached via its mailbox), and a `banked: true` response renders as described in decision 6 (test in
the plugin's tests). Append "as built" notes to §4.1. `npm run typecheck && npm test` at the
root.

## Tasks — PR B (honk)

### Task B1: `honk swarm-mcp` stdio server (crate `honk`, module `swarm_mcp`)

Hand-rolled newline-delimited JSON-RPC 2.0 (no new dependency): `initialize` (echo the client's
`protocolVersion`, `capabilities.tools`), `notifications/initialized` (ignored), `ping`,
`tools/list`, `tools/call`; unknown method → -32601.

Flags: `--session <goose id>` (owning session, required), `--pigeon-url`, `--pigeon-token-file`,
`--honk-url` (honkd's ACP URL; converted with `pigeon::acp_endpoint` to the ws endpoint handed to
pigeon, same as `honk telegram`), `--honk-secret-file`. Token files are read on every call (so a
rotation needs no restart). Caller id: `params._meta["agent-session-id"]`, else `AGENT_SESSION_ID`;
neither, or differing from `--session` → tool error naming the owning session ("swarm tools
belong to goose session X; subagents cannot use them").

Tools (descriptions carry the message-economy rules, shortened from the opencode plugin's):
- `swarm_send {to, message, kind?, priority?, reply_to?}` → ensure mailbox → `POST /swarm/send`
  with `from: <gse_>` → `Queued msg_… -> to` (+ "(waiting in its mailbox)" when banked) or the
  pigeon error text; then `GET /pull/pending` for self and append "You have N unread swarm
  messages — call swarm_read." when N > 0 (this is how a goose sender learns of a delivery.failed).
- `swarm_read {limit?}` → ensure → `POST /pull/drain` → `POST /pull/ack` of what was returned →
  each message rendered as a `<swarm_message v="1" kind= from= msg_id= reply_to=>` envelope (plus
  the `[pigeon]` message-economy line the opencode receive path appends); "Inbox is empty." when
  none; note `pending_total` beyond the page.
- `swarm_list {limit?}` → `GET /sessions?active=true` (does **not** ensure) → one line per
  session: id, kind (opencode / goose: mailbox|no mailbox), updated, cwd, title; the caller's own
  row (matched by `backend_session_id`) marked "(you)".

Tests: protocol unit tests over in-memory reader/writer; tool tests against an axum pigeon stub
(as `crates/honk/tests/support/pigeon_stub.rs`) asserting request bodies (from = gse_ returned by
the stub's swarm-mailbox; ack ids = drained ids; 409 text surfaced).

### Task B2: honkd built-in `swarm` catalog entry

Flags `--swarm-mcp-bin <path>` (required to enable; workstation passes a stable profile path
such as `/etc/profiles/per-user/dev/bin/honk`, **never** a `/nix/store` path, because goose
persists the command in the session's `extension_data` and re-spawns it after restarts),
`--swarm-pigeon-url`, `--swarm-pigeon-token-file`. When both bin and url are set, `hub.mcp` exists
even without `--mcp-catalog`, and the catalog loaded **per operation** (`session.rs:2456`) gains a
supported local entry `swarm` (no env, so no `/bin/sh` wrapper): `<bin> swarm-mcp --session <sid>
--pigeon-url … --pigeon-token-file … --honk-url http://<listen>/acp --honk-secret-file
<state>/secret`, where `<sid>` is the session being enabled. `swarm` is implicitly no-confirm and
overrides a same-named catalog entry. Tests in `mcp/catalog.rs` / `ops.rs` for the merge, the
per-session arg, no-catalog-file operation, and the generated `extensions/add` JSON.

### Task B3: `honk chat --new` enables `swarm` by default

`--no-swarm` opts out. **Not** via `_meta.honk.mcp.names`: `ops::enable` validates the whole
batch first (`ops.rs:327-336`), so an unknown `swarm` would also block the user's `--mcp X`, and a
honkd with no catalog fails every launch. Instead, after `session/new` returns, honk chat sends a
separate best-effort `_honk/mcp/enable {names:["swarm"]}`; failure (honkd without the entry, old
honkd) is a one-line dim notice, never an error. Test in the driver tests.

### Task B3b: `honk telegram` upgrades a swarm-only row

`pigeon::find_registered` skips rows with `notify: false`, so `honk telegram <id>` registers
(upgrading the mailbox-only row to `notify: true`) instead of refusing with "already registered;
pass --force". Test against the pigeon stub.

### Task B4: live e2e (gated on `HONK_GOOSE_BIN`) — optional

As `honkd/tests/mcp_live.rs`: enable `swarm` against a pigeon stub, `tools/list` shows the three
tools.

## Deploy (Jonathan-gated)

pigeon: merge, `git pull` + `npm install` in the primary root, restart the daemon. honk: merge,
bump workstation `flake.lock`, add the three `--swarm-*` flags to honkd's ExecStart
(`users/dev/home.cloudbox.nix`), `home-manager switch`, `systemctl --user restart honkd` —
**restarting honkd interrupts every live goose session, including 20261016_222.** Existing
sessions then get the tools with `/mcp enable swarm` in honk chat.

## Known limits (accepted for slice 1)

- Pull only: a goose session sees messages when it calls `swarm_read`. Push is slice 2.
- `from` is unauthenticated (§4.1). The MCP server fills it honestly from goose's per-call `_meta`.
- Disabling the extension does not close the mailbox (above). An abandoned session that once used
  swarm keeps banking until the 7-day expiry (`delivery.failed` to the sender then). Push (slice 2)
  removes this for honkd sessions.
- `swarm_read` acks immediately after draining: at-most-once if goose drops the tool result.
- If the server dies between drain and ack, pigeon's unacked-claim alert posts to Telegram General.
- opencode's `swarm_list` lists opencode sessions only; goose sessions are reachable from opencode
  by the `gse_` id in a received envelope's `from`. Widening it is slice 3.
