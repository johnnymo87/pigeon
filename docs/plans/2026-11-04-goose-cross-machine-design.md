# Goose sessions own cross-machine work — design

Bead: honk-9qf.29 (honk tracker). Reported by goose session `gse_df575c91-…` (bead
eng-agent-platform-1jrt.1), which had to use an opencode relay session to launch a Mac session and
forward its replies. Jonathan approved building it 2026-11-04.

## Goal

A goose session (a `gse_…` id, reached through honkd) can:

1. `swarm_launch` a session on another machine, and `swarm_schedule` / `swarm_scheduled` wakes;
2. receive the launched session's replies (and any reply to a message it relayed out);
3. send follow-ups to that remote session.

## What blocks it today (pigeon e769b91, honk 4685dca)

| # | Blocker | Where |
|---|---|---|
| B1 | honk's swarm MCP has no `swarm_launch`, `swarm_schedule`, `swarm_scheduled`, and `swarm_list` has no `remote` | honk `crates/honk/src/swarm_mcp.rs` `get_tools` |
| B2 | Launch requester refuses a `gse_` `from` | daemon `remote-launch-requester.ts:23,124`; worker `remote-launch.ts:96`; target daemon `remote-launch-receiver.ts:29,222` |
| B3 | Tag inheritance asks session-tags about the raw `gse_` id, which answers `auto:` | daemon `index.ts:546-557` |
| B4 | A `launch.result` that `bankOrInsertSwarmMessage` refuses is acked `delivered` and lost silently | requester `:368,:410,:520` |
| B5 | On the remote machine, `/swarm/send` to a `gse_` with no local row is refused 409 before the arbiter (which would relay it) sees it | `bank-or-insert.ts:62-69` |
| B6 | Mailbox-only goose sessions (honk chat, any session whose identity comes from `/goose/swarm-mailbox`) are not registered in the worker's D1 `sessions` when created; the reaper's hourly ownership refresh registers every local row (`session-reaper.ts:116-164`), so a new one is `unknown_session` for up to an hour | `app.ts:1827-1857` |
| B7 | **The real gate.** The receiving daemon requires `swarm` + `swarm-remote` in a goose row's `pull_sources`; no route sets `swarm-remote` on a goose row | `relay-receiver.ts:192-196` |
| B8 | A `gse_` sender cannot be relayed | arbiter `RELAY_SENDER_ID` `:147,:601`; worker `relay.ts:52,149`; receiver `relay-receiver.ts:27,149` |

Scheduling to a local `gse_` already works (push rows skip the "scheduled to a pull session"
refusal). The plugin tools' contracts are in `packages/opencode-plugin/src/swarm-{launch,schedule,scheduled}-tool.ts`.

## Design

### D1. Accept a `gse_` launch requester (B2, B3, B4)

- A separate `REQUESTER_ID` constant (never widen the shared `ses_` ones: the requester's
  `SESSION_ID_RE` also validates the launched id, the receiver's validates the ack, the worker's
  `SENDER_ID` validates launch acks and remote discovery). A launch-specific requester regex `^(ses|gse)_[A-Za-z0-9_-]{8,128}$` in the daemon requester,
  the worker's `/launch/relay` validator, and the target daemon's receiver. The shared worker
  `SENDER_ID` is not widened for this (it also validates the launched session id, which stays
  `ses_`: the launched session is opencode).
- Tag inheritance maps the requester through `whichKeyFor` (→ `goose:<native>`, or ask nothing
  for an unmappable `gse_`) before `oc-tags which`. A coordinator requester inherits its program, as `/launch` does
  (`coordinatorProgramOf`). Explicit `tag` still wins.
- A refused `launch.result` insert is logged loudly (`console.warn` with launch id, reason). It
  stays acked: the worker cannot do anything better with it, and re-handing it out would loop.
- The framed prompt on the target already names the requester:
  `[Remote launch requested by gse_… on cloudbox; report back with swarm_send to gse_….]`.

### D2. Make the requester reachable from other machines (B5, B6, B7)

**Rule: a goose session becomes reachable from other machines when it first reaches out to one —
by requesting a remote launch, or by having a message relayed.** At that moment the daemon:

1. adds `"swarm-remote"` to the row's `pull_sources` (alongside `"swarm"`, which the mailbox
   route guarantees), and
2. registers the session with the worker (`onSessionStart` → `/sessions/register`, the same call
   `/goose/sessions` makes), so D1 knows which machine owns the `gse_` id.

One helper, `markGooseRemoteReachable(id)`, injected into the requester and the arbiter:

- The `pull_sources` write is additive and synchronous: read the row's effective list (NULL →
  `["telegram-reply"]`), add `swarm` and `swarm-remote`, write back with no `await` between.
  Nothing else rewrites the column for goose rows (`sessions.upsert` never writes it;
  `ensureGooseSwarmMailbox` only appends `swarm`; `registerGooseSession` doesn't touch it).
- Registration is awaited with a ~5 s bound, once per daemon lifetime per id (an in-memory set);
  the reaper keeps D1 fresh after that. Worker `/sessions/register` is a pure D1 upsert with
  ownership checks; it creates no Telegram topic.
- It runs **before** the worker request: in `RemoteLaunchRequester.handleRequest` after
  validation and before `client.request` (a `pending` request accepted later in `tick()` would
  otherwise never mark), and in the arbiter's remote branch before `relayRow` when the sender is
  `gse_`. Marking on a request that is later refused is harmless: the session did reach out.
- Registration failure is logged, not fatal; the reply would then fail `unknown_session` until the
  reaper's next refresh, and the remote sender gets `delivery.failed`.

The requester refuses a `gse_` `from` with no local goose row (409 `no_session`): there would be
nothing to mark and the `launch.result` could not be delivered. honk's tools always call
`/goose/swarm-mailbox` first, so this only rejects hand-crafted calls.

Revocation and exposure (accepted, documented):

- A mailbox row idle 7 days is reaped and unregistered; re-created, it comes back without
  `swarm-remote`. Reaping is the revocation.
- Topic-bound coordinators are never reaped (`repos.ts:233-237`): one that reaches out once stays
  reachable from other machines while it is pinned.
- Once reachable, **any** session on any machine this one accepts relays from
  (`PIGEON_SWARM_RELAY_ACCEPT_FROM`) can prompt it, not only the one it launched — the same exposure
  every opencode session has. If remote prompt injection into a coordinator becomes a concern,
  narrow acceptance to contacted peers or give the opt-in a TTL.
- `from` on `/swarm/send` and `/swarm/launch` is unauthenticated locally (one shared bearer
  token), so a local process can mark any `gse_` row; it could already prompt that row locally.

Why implicit-on-contact and not an explicit opt-in or a blanket exemption:

- The per-session `swarm-remote` opt-in exists (design 2026-10-20 §3.3, §4) because goose's trust
  model was built on Telegram sender ids. Reaching out is the clearest possible statement that
  the session wants answers; it needs no new flag the model would have to know to set.
- A blanket exemption for every pushed goose row (treat like opencode, gated only by the
  machine-level `PIGEON_SWARM_RELAY_ACCEPT_FROM`) would open stall-watch's coordinators and every
  honk chat session to other machines without anyone asking. Not done here; it is a one-line
  policy change later if wanted.
- Registering every mailbox session on every swarm tool call would add a worker round trip to
  each `swarm_send`. Registering at contact time costs one call per cross-machine contact.

Send side on the remote machine (B5): `bankOrInsertSwarmMessage` keeps refusing a `gse_` with no
local row **only for relayed-in rows** (`relay-receiver.ts`, hop rule) **or when relay send is
off**. A local sender's `/swarm/send` or `/swarm/schedule` to an unknown `gse_` with relay send on
is inserted, and the arbiter's existing locality check (`gse_` with no row → remote, never probed,
`locality.ts:97-98`) relays it. The worker answers `unknown_session` for a `gse_` that no machine
registered, which comes back to the sender as `delivery.failed` — the same outcome as an unknown
`ses_`. An input flag (`allowRemoteGoose`) on `BankOrInsertInput` carries the decision. It is set
**only** by `/swarm/send` and `/swarm/schedule` in `app.ts`, from the relay-send config — never by
`notify-sender`, the launch requester, the delivery watchdog or the relay receiver, which keeps
the hop rule and keeps `pigeon` notices from being inserted for unreachable targets.

To keep a typo'd or stale `gse_` an immediate error rather than a later `delivery.failed`, the
route first asks the worker who owns it (`poller.lookupSessionOwner`): not found, or owned by this
machine (a reaped local row whose unregister failed) → keep the 409; owned elsewhere → insert;
worker unreachable → fail open and insert.

Scheduled messages to a remote target are held by the **sender**: the ready queries filter on
`deliver_at <= now` (`swarm-repo.ts:150,167`), so the arbiter relays only due rows, forwarding the
original `deliver_at`. The sender's daemon must be up when the wake is due; `swarm_scheduled`
list/cancel works on the sender until it is relayed; `delivered_late_ms` includes relay latency.

### D3. Relay `gse_` senders (B8)

- arbiter `RELAY_SENDER_ID` → `^(ses|gse)_…`; worker `validateRelayBody` `from` → `^(ses|gse)_…`
  (a new `RELAY_SENDER_ID` constant in `relay.ts`; `SENDER_ID` is left alone for discovery and
  launch-ack validation); the receiver's sender check (`relay-receiver.ts:149`) and its sender
  pre-probe (`:79`) likewise — `localityOf` answers `remote` for an unknown `gse_` without probing.
- The failure path already handles a `gse_` sender: worker failure items don't validate
  `from_session`, `receiveFailure` matches the stored row, `notifySenderOfFailure` accepts `gse_`.
- Before relaying a row whose sender is `gse_`, the arbiter applies D2's rule to the sender (an
  injected `markGooseRemoteReachable(sessionId)`), so the reply has a way back.
- The receiver's `from_is_local` check and the worker's `sender_not_yours` check already work for
  `gse_` (they key on the id). Stable `gse_` ids embed the machine id in the uuidv5 input
  (`goose/session-id.ts`), so two machines cannot mint the same id.
- `pigeon` notices still never relay.

### D4. honk swarm MCP tools (B1)

In `crates/honk/src/swarm_mcp.rs`, ported from the opencode plugin's tools, with `from` = the
session's `gse_` id from `ensure_mailbox`:

- `swarm_launch {machine, directory, prompt, tag?}` → `POST /swarm/launch`
  `{launch_id, from, machine, directory, prompt[, tag]}` with `Content-Type: application/json` and
  no `Origin`. `launch_id` = `rl_<base36 ms>_<8 hex>`, minted once per call and reused on retry.
  Same retry/terminal classification as the plugin (6 attempts, 500 ms doubling to 8 s; 4xx except
  429 terminal; 429 `queue_full`/`rate_limited` terminal; 503 `target_offline`/
  `launch_unavailable`/`no_worker` terminal; other 5xx or a non-refused transport error →
  `pending` on the last attempt, never "failed"). Result text tells the model the
  `launch.result` arrives as a swarm message and not to call again on `pending`.
- `swarm_schedule {message, at|after, to?, kind?, priority?, expires_in?, ref?}` →
  `POST /swarm/schedule`, `to` defaulting to itself; `msg_id` minted per call; a 409 on a retry
  with the same `msg_id` is success.
- `swarm_scheduled {action: list|cancel, msg_id?}` → `GET /swarm/scheduled?session=<gse>` /
  `POST /swarm/scheduled/<id>/cancel {from}`.
- `swarm_list {remote?: true}` → `GET /swarm/remote-sessions`, rendered like the plugin's
  remote view (id, updated, machine, label, relay reachability), so a goose session can find a
  target machine.

Tool descriptions carry the plugin's guidance (call `swarm_launch` once; self-contained wake
payloads with durable pointers; `after` preferred over `at`).

The MCP client's 15 s request timeout stays; the launch tool overrides it per request to 30 s
like the plugin. The daemon's `handleRequest` (oc-tags `which` timeout + ~5 s registration bound +
worker call) must stay under that. honkd has no tool allowlist; honk's tests pin the tool list.

### Not in scope

- Remote discovery (`swarm_list remote`) listing goose sessions (`worker/remote-sessions.ts:79`).
  Remote sessions learn the `gse_` id from the launch framing or the envelope's `from`.
- Launching a **goose** session on the remote machine (`honk launch` remotely). The launched
  session is opencode, as today.
- Making every goose session remotely reachable without contact (see D2).

## Rollout

All three components must be deployed for the end-to-end path; each refuses clearly until then.

1. Cloudflare worker (accepts `gse_` launch `from` and relay `from`). Old daemons never send
   these, so it is backward compatible.
2. pigeon daemon on every machine (cloudbox, devbox, Mac). An old target daemon refuses a `gse_`
   launch `invalid`; an old requester daemon refuses the request 400. Both are explicit.
3. honk (the new tools), via workstation's honk pin + home-manager switch. Against an old pigeon
   the tool reports pigeon's 400 verbatim.

Each deploy needs Jonathan's OK.

## Docs to update with the code

pigeon `AGENTS.md` (§ "What never relays", launch results), `.agents/skills/swarm-architecture`,
`swarm-operations`, design 2026-10-20 §4/§7 and 2026-10-29 "Not in v1"; workstation
`swarm-messaging` skill ("gse_ ids can't be reached from other machines") after deploy.
