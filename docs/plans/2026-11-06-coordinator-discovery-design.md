# Coordinators: discoverable in swarm_list and reachable from other machines

Bead: `pigeon-a0o8`. Workstation side: PR #805 (skill on every host, `coordinator` on PATH).

## Problem

On 2026-11-05 a devbox session was asked to report a bug to the eternal-machinery
program's coordinator. It could not find it and guessed a recipient. The coordinator
existed and was reachable (`gse_c82dc1cc…`, label `📋 eternal-machinery`).

Pigeon's part of the cause:

1. **`swarm_list` lists opencode sessions only.** It reads the serve's
   `/experimental/session`. Coordinators are goose-acp sessions, so the tool every agent
   tries first cannot show them.
2. **Remote discovery leaves out every `gse_`.** The worker's `GET /sessions/remote`
   selects `substr(session_id,1,4)='ses_'` (`worker/src/remote-sessions.ts`).
3. **A coordinator refuses relayed messages until it has itself made remote contact.**
   `relay-receiver.ts` step 5 requires `swarm-remote` in `pull_sources` for any goose
   target, and that is granted only by an accepted outbound launch or relay (design
   2026-11-04 D2). That design left "should topic-bound coordinators be reachable" as an
   open question (its line 94). Jonathan answered it on 2026-11-06: cross-machine
   messages should be able to reach coordinators.

## What a coordinator is, to pigeon

A `sessions` row with `backend_kind = 'goose-acp'` whose `bound_topic_key` is
`stallwatch:<tag>` with a valid tag, i.e. `coordinatorProgramOf` (`tag-key.ts`) answers
`{program}`. A non-tag suffix (`stallwatch:_notices`) is not a coordinator, matching
honk's `coordinator_program`. On the worker the same fact is a `named_topic_bindings` row whose
`topic_key` starts `stallwatch:`. Such rows are pinned: never reaped, and re-registered
with the worker every hour, so D1 always knows which machine owns them.

## Decisions

### D1. Local `swarm_list` also lists this machine's goose sessions

- New daemon route `GET /swarm/goose-sessions` returns goose-acp rows that a local
  `swarm_send` can reach, by the same predicate `bankOrInsertSwarmMessage` uses (an
  endpoint, so pushed; or no endpoint and `"swarm"` in `pull_sources`, so banked):
  `{sessions: [{session_id, label, title, cwd, last_seen, program}]}`, where `program` is
  the `stallwatch:` suffix or null. Coordinators first, then by `last_seen` desc.
- The plugin's local `swarm_list` appends a second table, "Goose sessions on this
  machine", marking each coordinator `coordinator of <program>`.
- **Rotation.** A failed rebind leaves two pinned rows for one program until a bind
  succeeds. Both are listed, each marked `(rotation pending)` with a pointer to
  `coordinator <program>`, rather than guessing.
- The local listing always ends with one line pointing at `remote: true` for coordinators
  of programs run on other machines.
- **Failure never fails the tool.** A daemon error, timeout (2s) or 404 (old daemon)
  appends one line saying goose sessions could not be listed and why; the opencode table
  is still returned. The tool must not become less available than it is today.
- Not `GET /sessions`: that route is the legacy hook shape and carries endpoints; a
  purpose-built route keeps the agent-facing contract small.

### D2. A coordinator accepts relayed messages without prior contact

In `relay-receiver.ts` step 5, a target that is a coordinator (the predicate above) and
is locally reachable (D1's predicate) is accepted without `swarm-remote`. Everything else
is unchanged: other goose-acp rows and all pull sessions still need `swarm-remote`.

- **A rule, not a grant.** Nothing is written to `pull_sources`, so there is no
  migration, and unbinding the topic removes this route in. It does not revoke a
  `swarm-remote` grant the row earned by contacting another machine itself (2026-11-04
  D2); that grant lasts until the row is deleted, as before.
- **Exposure, accepted by Jonathan:** any session on a machine listed in this daemon's
  `PIGEON_SWARM_RELAY_ACCEPT_FROM` can prompt a coordinator, which is the exposure every
  opencode session already has under the full-mesh relay. The machine-level accept list,
  the worker's per-machine keys and the hop rule still apply.
- goose-pull sessions bound to a `stallwatch:` topic (the legacy coordinator shape) are
  **not** covered: a pull client may not understand relayed swarm rows. They keep the
  explicit `swarm-remote` opt-in.

### D3. Remote discovery lists coordinators

The worker's `GET /sessions/remote` also returns `gse_` rows that have a
`named_topic_bindings` row with `topic_key LIKE 'stallwatch:%'` and a valid tag suffix,
in a separate `coordinators` array (`{session_id, machine_id, program, label,
updated_at}`) that the `limit` does not apply to: cloudbox alone has ~430 `ses_` rows a
week, and coordinators must not be truncated off the end. Other `gse_` rows stay
unlisted: they would answer `remote_not_accepted`. Same horizon (7 days by `updated_at`,
which the hourly re-registration keeps fresh) and machine validation; ids validated with
the relay's own exported `TARGET_ID`. The binding's primary key is `(chat_id,
topic_key)`, so a failed rotation's second row is not listed here.

The plugin's remote renderer prints them first, as `coordinator of <program>`. honk's
`swarm_list remote` ignores the new array until it is taught it (follow-up).

### D4. Deployment order

Daemons first, **strictly**: every receiving daemon (cloudbox above all) must have D2
before the worker lists coordinators, because a send into an old receiver fails with
`remote_not_accepted`, worded "will fail the same way", and agents act on that by not
retrying. An old worker merely lists no coordinators. The plugin half of D1 appears after
each host's serve pool restarts; until then an old plugin lists what it lists today, and
a new plugin against an old daemon gets 404, which the fail-open line covers.

## Not in scope

- honk's local `swarm_list` (goose has no local opencode list to extend).
- Listing non-coordinator goose sessions remotely, or making them reachable.
- Authenticating which remote session may prompt a coordinator.

## Tasks

1. Daemon: `coordinatorOf(row)` (goose-acp + `coordinatorProgramOf` → program) and the
   shared local-reachability predicate, extracted from `bank-or-insert.ts`. Relay-receiver
   step 5 exemption, with tests: coordinator without `swarm-remote` accepted and pushed;
   unbound goose-acp, `_notices` binding, and goose-pull with a `stallwatch:` binding
   still refused; a relayed `/clear` payload reaches goose wrapped in `<swarm_message`.
2. Daemon: `GET /swarm/goose-sessions` route + test.
3. Plugin: local `swarm_list` appends the goose table; fail-open line on daemon
   error/404/timeout; tests.
4. Worker: `/sessions/remote` returns `coordinators`; tests (binding without a sessions
   row, non-`stallwatch:` key, `_notices`, own machine, horizon, not subject to limit).
5. Plugin: remote renderer marks coordinators; test.
6. Docs: AGENTS.md Swarm IPC bullets, `swarm-architecture` and `swarm-operations`
   skills, the 2026-11-04 design's open question, the worker comment that says a goose
   session cannot be a remote target.
7. Follow-ups outside this repo, after deploy: workstation `swarm-messaging` and
   `finding-program-coordinators` (swarm_list now shows coordinators; reachable from
   other machines), stall-watch `find_coordinator.py` exit-2 text ("this host cannot
   reach it" becomes "swarm_list remote: true lists it"), honk's remote renderer.
