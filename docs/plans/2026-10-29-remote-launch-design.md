# Remote launch — design

Status: proposed 2026-10-29, not built. Adversarially reviewed the same day; its fixes are folded in. Bead `pigeon-k0qn.17`, epic `pigeon-k0qn`.

## Problem

Upgrading pigeon on 2026-10-29 (`pigeon-k0qn.11`) needed the same steps on three machines: pull,
`npm install`, restart the daemon and serve pool, check the logs, sometimes retry differently. From
cloudbox an agent could do its own machine. For devbox and the Mac, Jonathan pasted command blocks
and pasted the output back, and later asked an existing session on each machine to do the work.
Neither is wanted: the first costs the human, the second borrows a session that was doing something
else.

What is wanted: **an agent on machine A starts a fresh headless opencode session on machine B with a
prompt**, and hears back the new session's id (to swarm it) or why it could not start.

Pigeon can already start a session on any machine: Telegram `/launch <machine> <dir> <prompt>`
(worker `launch-command.ts`, daemon `launch-ingest.ts`). Only the Telegram webhook can queue that.
This design adds a second, agent-facing entry to the same launch code.

## Decisions taken with the human

- **No per-launch approval.** Jonathan, 2026-10-29: approval guard rails are not necessary. The
  gate is configuration: a machine runs remote launches only from machines it lists.
- **Fresh sessions only.** Never prompt an existing session to do the job.
- **The Mac's `darwin-rebuild` needs sudo** and a launched agent cannot do it. Accepted; out of scope.

## Shape

The cross-machine relay (`2026-10-20-cross-machine-swarm-design.md` §3) already solved the hard
parts: who the caller is (per-machine keys), whether the target machine opts in, whether it is
online, idempotency, and a receipt back to the sender for every outcome. Remote launch copies that
shape instead of using the `commands` queue.

```
agent on A --swarm_launch--> daemon A --POST /launch/relay--> worker (D1 remote_launch)
                                                                  |
                       poll response `launches: [...]` <----------+
daemon B: dedup, ingestLaunchCommand (existing), ack {launched, session_id} | {refused, reason}
                                                                  |
worker mints a result item for A --poll--> daemon A --> local swarm message to the agent
```

### Why not the `commands` queue

- `commands.chat_id` is `NOT NULL` and is the only result channel: every worker and daemon message
  about a launch goes to that chat. The worker has no machine→chat map, and a send failure is
  logged and dropped. An agent would get nothing back.
- A lost ack re-runs the launch after the 60 s lease: a second session. Nothing dedups by command id.
- Agent launches would share the 100-row per-machine cap and LIMIT-1 order with the human's
  commands.
- A command queued just before B went down lives 24 h and is then deleted without a receipt.

A separate table, handed out in batches on the poll like relay items, avoids all four and adds no
`ALTER` on an existing table.

## §1. Requesting (machine A)

- **Tool** `swarm_launch { machine, directory, prompt, tag? }` in the plugin, next to `swarm_send`.
  `from` is `ctx.sessionID`, resolved to its root session (a subagent is not registered with the
  worker, so nothing could answer it). The tool mints `launch_id` and reuses it across retries.
- **One call per launch.** An ambiguous failure (timeout, 5xx) is not reported as failure: the tool
  answers `pending: <launch_id>; the result arrives as a launch.result swarm message; do not call
  again`. Calling again would mint a new id and could start a second session.
- **Daemon** `POST /swarm/launch`: validates, resolves the requester's tag when `tag` is absent
  (`oc-tags which <from>`, session tags only, as `/launch` inheritance does today), then POSTs to
  the worker through the poller with the machine key. Answers `202 {launch_id}` or the worker's
  refusal. No local queue and no arbiter path: a launch is not deferred, and a transient worker
  failure is retried by the daemon with the same `launch_id` until the request's expiry.
- **Outbound row first.** The daemon writes `remote_launch_outbound` (`launch_id`, `from_session`,
  `to_machine`, `deadline`) before the POST, so a result for a request whose 202 was lost still
  matches. `deadline` = request expiry + one lease + grace; if no result has arrived by then, A mints
  its own `unconfirmed` notice (§4). Nothing waits forever.
- **Requires `PIGEON_REMOTE_LAUNCH_SEND=1`** on A, mirroring relay send. Off: `403
  launch_send_disabled` from the daemon.

## §2. Worker

- **Table** `remote_launch` (`CREATE TABLE IF NOT EXISTS`): PK `(from_machine, launch_id)`,
  `to_machine`, `from_session`, `directory`, `prompt`, `tag`, `body_sha256`, `status`
  (`queued` | `leased` | `launched` | `refused` | `expired`), `session_id`, `reason`, `lease_count`,
  `created_at`, `leased_at`, `expires_at`, `settled_at`, plus result-item columns (below).
- **`POST /launch/relay`**, machine key only (`requireMachinePrincipal`). Checks, in order. The
  duplicate check comes straight after validation, as in the relay (`relay.ts:246-252`), so a retry
  of a stored request gets `202 duplicate` even if B has since gone offline:
  1. body valid: `machine`, `directory` (non-empty, ≤ 512, no control characters, since it becomes
     an HTTP header on B), `prompt` (≤ 16 000 code points), `tag` (`isValidTag`), `from` is `ses_…`,
     `launch_id` without `:`;
  1a. same key, same hash → `202 duplicate`; same key, different hash → `409 launch_id_conflict`;
  2. `from` registered to another machine → `403 sender_not_yours` (as the relay);
  3. `to_machine` = caller → `409 same_machine` (use `opencode-launch` locally);
  4. target not in `SHARED_KEY_REFUSED_MACHINES` → `403 receiver_not_retired`;
  5. target's launch-accept set lacks the caller → `403 not_accepted`;
  6. target's last poll older than 60 s → `503 target_offline`;
  7. no return path: the relay from target to caller is not `available` (`relayReachability`: the
     target does not relay, or the caller does not accept relays from it) → `409 no_return_path`.
     The launched session must be able to `swarm_send` its report back;
  8. more than 10 queued for the target → `429 queue_full`; more than 30 accepted from the caller in
     the last hour → `429 rate_limited`.
- **Accept set.** The poll header grows a token: `X-Pigeon-Swarm-Relay: accept=…; launch=<m,…>;
  failures=1`. Stored in a new table `machine_launch_accept` (not a column on
  `machine_relay_accept`: no `ALTER`), written only when it changes, cleared by a poll without the
  token, and also when the whole header is absent (`handOutRelayItems` returns early there,
  `relay.ts:519-527`). Hand-out re-checks the live header, as for relay items. A daemon with no
  opencode client advertises an empty `launch=`.
- **Hand-out.** The poll response gains `launches: [...]`, **at most 1 per poll**, oldest first,
  never a row with less than one lease (60 s) of life left. Lease rules as for relay items: 60 s,
  at most 3. The daemon processes it after relay items and before the poll's command, under an
  overall deadline (§3), because the poll tick is serialised and a slow launch makes B look offline
  to every relay sender.
- **Expiry: 15 minutes**, not 24 h. A launch for an upgrade is stale quickly, and a late surprise
  session is worse than a refusal the agent can act on. Expired while queued → `never_collected`;
  while leased → `unconfirmed` (the session may exist). The hourly cron is too coarse for 15
  minutes, and the target's own poll is useless when the target is down, so expiry runs from the
  **requester's** poll (rows whose `from_machine` is the polling machine; one indexed update), with
  the cron as a backstop. A late `launched` ack from B upgrades an `expired`/`unconfirmed` row and
  mints a corrective result item, so a real session id is never lost to a race with expiry.
- **Results are rows, not prose.** Every terminal state mints a result row `r:<launch_id>` in the
  same table, addressed to `from_machine`, using the relay's failure-item model unchanged
  (`relay.ts:338-377`): same lease, ack and expiry queries. Handed out as `{item: "launch_result",
  launch_id, outcome, session_id?, reason?}` on A's poll whatever A's accept lists say (under
  `failures=1`). Never answered. The ack route checks the acker is the row's `to_machine`
  (`relay.ts:415`) and validates `reason` (`^[a-z0-9_]{1,64}$`) and `session_id` (`ses_` pattern),
  because B's key holder controls both.
- **Retention** 7 days, then pruned by the cron.

## §3. Receiving (machine B)

- **Opt-in** `PIGEON_REMOTE_LAUNCH_FROM=<machine,…>` (parsed like `PIGEON_SWARM_RELAY_ACCEPT_FROM`).
  Empty: the header's `launch=` is empty and nothing is handed out. Defence in depth: refuse an item
  whose `from_machine` is not listed (`not_accepted`).
- **Dedup before acting, with a lifecycle.** Insert `(from_machine, launch_id)` into a local
  `remote_launch_inbound` table first, state `received`. Write `created(session_id)` the moment
  `createSession` returns, and the outcome the moment `sendPrompt` resolves; ack **then**, before
  tagging or the Telegram notice. A re-handout that finds:
  - an outcome: re-ack it without launching;
  - `created(session_id)` with no outcome: ack `unconfirmed` with that `session_id`;
  - `received` only: ack `unconfirmed` without one.

  This is what stops a lost ack, or a mid-launch daemon restart (likely when the prompt is "upgrade
  pigeon here"), from making a second session or losing the id. Acks are retried from this table
  independently of re-handout. Retention: 7 days.
- **Directory.** Expand like `/launch` (`expandShorthand`, `resolveHome`), then require an absolute
  path that exists and is a directory (`no_such_directory`). A relative path would otherwise resolve
  against the daemon's cwd. No allowlist: the opt-in names machines the human
  trusts with any directory, as `/launch` does today.
- **Launch** through the existing `ingestLaunchCommand`, refactored so its steps report to the
  caller instead of only to Telegram (Telegram `/launch` keeps its messages):
  - hooks after `createSession` and after `sendPrompt`, for the lifecycle above;
  - the outcome decided from what happened, not from "nothing threw": today any later throw lands
    in the catch at `launch-ingest.ts:321-324` and says "Failed" while the session runs;
  - a `sendPrompt` **timeout** is `unconfirmed` with the session id (`prompt_async` does not dedup,
    and a timeout may mean processed). Only a clear 4xx or connection refusal is `refused`, and then
    the orphan session is deleted best-effort.
- **Deadline.** The whole launch runs under ~45 s (health check, create, prompt; each already 30 s
  bounded) so B keeps polling. A launch past it is acked `unconfirmed` with whatever id it has.
- **Telegram on B.** After the ack, a notice is enqueued on the durable alerts queue
  (`storage.alerts.enqueue`, drained by `swarm/alert-drainer.ts`) rather than sent directly: a direct
  send fails silently with no bot token (`index.ts:350`) and has no timeout. It goes to B's own chat
  (General) and names the requester: `🚀 Remote launch from cloudbox (ses_…): session ses_… in
  ~/projects/pigeon` plus the first 300 characters of the prompt (surrogate-safe `truncate`). With no approval gate, this is how the human sees what was
  started. The session itself notifies under the default policy, so it gets its own topic and its
  stops are visible, which is the point.
- **Prompt framing.** The prompt is sent as given, prefixed by one line:
  `[Remote launch requested by <from> on <machine>; report back with swarm_send to <from>.]` so the new
  session knows who to answer. It records in `injected_prompts` as today (no mirror echo).
- **Ack** `POST /launch/relay/ack {from_machine, launch_id, outcome, session_id?, reason?}`.
- **Not in v1:** goose backend (`--backend goose`), worktree creation (the prompt can run `work`),
  and suppressing `oc-auto-attach` (it opens a tmux window on B, same as `/launch`; harmless).

## §4. Result back to the requester (machine A)

The poller receives `launch_result` items. The daemon accepts one only if it matches a launch it
sent (`remote_launch_outbound`, same `to_machine`), then inserts a local swarm message from
`pigeon`, kind `launch.result`, to the outbound row's `from_session` (never a field of the item),
rendered from the code with `session_id` re-validated. A later corrective item for the same launch
(`unconfirmed` upgraded to `launched`) is delivered too. When the outbound `deadline` passes with no
result, the daemon mints `unconfirmed` itself.

- `launched`: `Remote launch <id> started ses_… on devbox in ~/projects/pigeon. Message it with swarm_send.`
- `refused`/`never_collected`: `… did NOT start on devbox (<reason>). Safe to retry.`
- `unconfirmed` with a session id: `… ses_… exists on devbox but its prompt may not have arrived. swarm_send it the task if it does not report in.`
- `unconfirmed` without one: `… may or may not have started on devbox. Check swarm_list remote: true before retrying.`

As with relay failure items, the text comes from the code, so a key holder cannot inject prose.

## §5. Using it for upgrades (and the trap)

A session launched on B to upgrade pigeon runs **inside B's opencode serve pool**. Restarting the
pigeon daemon is safe for it. Restarting the serve pool kills it mid-turn, and the Mac's
`opencode-serve-pool-restart` likewise. The upgrade prompt, and the skill that documents this tool,
must say: restart the pool last, from a delayed `systemd-run` job (or `launchd` equivalent), after
reporting results. A plugin change takes effect only after that restart, so a remote upgrade cannot
verify its own plugin, and its report says so. A daemon restart before B has acked the launch is
covered by the inbound lifecycle (§3), which acks right after `sendPrompt`. `cross-device-deployment` gains a "remote upgrade" recipe with that prompt.

Bootstrapping: the first deploy of this feature on each machine is still manual.

## §6. Auth and trust

- What changes: today only the Telegram webhook (chat and user allowlist) can start a session.
  After this, any process on A holding A's machine key can start a session with an arbitrary prompt
  in any directory on every machine that lists A. That is remote code execution across machines by
  design, accepted by the human in place of per-launch approval.
- What limits it: B's explicit `PIGEON_REMOTE_LAUNCH_FROM`; B must be retired from the shared key;
  machine keys only (the shared `CCR_API_KEY` gets 401); the per-caller hourly cap; the visible
  `🚀` notice and topic on B for every launch.
- Not added: directory allowlists, prompt filtering, approval. Each would protect against an agent
  the human already trusts with a shell on its own machine.
- Accepted residue: any key holder can name an unregistered (subagent) id as `from`, and a prompt
  can contain a fake second "[Remote launch requested by …]" line. Both are noise next to the
  accepted capability.
- devbox is personal. The human decides per machine whether to list it; the default is empty
  everywhere.

## §7. Size

Worker: one route pair (relay, ack), two tables, hand-out on poll, expiry — about the size of the
relay's message half. Daemon: route, header token, poller hand-in, inbound dedup, outbound match,
result rendering, `ingestLaunchCommand` result plumbing. Plugin: one tool. Docs: AGENTS.md,
swarm-architecture, swarm-operations, cross-device-deployment, workstation `swarm-messaging`. Two or
three PRs.

## §8. Deployment and rollback

1. Apply `d1-schema.sql` (new tables), then deploy the worker. Missing tables answer
   `503 launch_unavailable`.
2. Daemons on every machine (header token present but empty), then the serve pools for the plugin.
   The tool maps a 404 from an old daemon or worker to "pigeon on this machine is too old".
3. Per pair, receive first: B sets `PIGEON_REMOTE_LAUNCH_FROM`, then A sets
   `PIGEON_REMOTE_LAUNCH_SEND=1`. Precondition: the relay is on in both directions (§2 step 7).
4. Rollback for one machine: drop its two lines and rebuild. Queued launches for it expire as
   `never_collected`; A's outbound deadlines cover a worker rollback.
