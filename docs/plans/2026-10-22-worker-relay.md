# Worker relay (pigeon-k0qn.5)

Implements §3.2 of `2026-10-20-cross-machine-swarm-design.md`, plus the four rules the
per-machine-credentials review (`.8`) handed to this bead. The design document is the contract;
this note records only the decisions it leaves open. Where this note departs from the design,
the design has been edited to match in the same PR.

## Scope

Worker:

- `swarm_relay` and `machine_relay_accept` tables. Both are `CREATE TABLE IF NOT EXISTS`; no
  existing table is altered.
- `POST /swarm/relay`, `POST /swarm/relay/ack`, `POST /swarm/relay/fail`.
- The `swarm` field on `GET /machines/:id/next`, and the accept-set write from its header.
- An hourly expiry step that mints failure items and prunes terminal rows.
- Register's read-then-upsert made conditional.

Daemon (rule 2):

- A session registers with the worker whatever its `notify` flag.
- The hourly reaper re-registers each live session about once a day.
- The reaper alerts when the worker says another machine owns a session held here.

Out of scope: the daemon's send side (`.7`) and receive side (`.6`). Nothing here changes
behaviour until a daemon sends `X-Pigeon-Swarm-Relay`. No daemon does yet.

## The four `.8` rules

1. **Receive requires retirement.** `/swarm/relay` refuses `403 receiver_not_retired` when the
   owner is not in `SHARED_KEY_REFUSED_MACHINES` (`*` counts). Until it is, a shared-key holder
   can re-register the owner's sessions to itself and collect what is queued for them.
2. **First-registrant claim.** The worker cannot tell an owner's row from a squatter's: both are
   written by a machine credential, each as its own machine. So the fix belongs to the owner.
   - **Register everything.** `/session-start` now registers every session, not only `notify=true`
     ones. The opencode plugin already sends `notify: true`, so this changes few sessions today
     (1 of 676 on cloudbox).
   - **Keep rows fresh.** A worker row's `updated_at` moves only on register, notifications and
     Telegram routing. A session that never notifies would go stale: another machine could take it
     over after 7 days, and the worker sweep deletes it at 14. So the reaper re-registers every
     live, unpinned session once its last successful registration is 20 h old.
     - State is in memory; a restart refreshes everything again.
     - At most 100 per hourly cycle, 10 s per call.
     - The cycle stops at the first transport failure.
   - **Detect a squat.** A `409 owned_by_other_machine` during the refresh means another machine
     holds a session this daemon runs. The reaper sends a plain alert, once per session per daemon
     lifetime.
   - **What remains** is a session idle 7 days or more, which the daemon reaper unregisters. It is
     recorded in the design's §7.
   - Subagents never reach `/session-start` and are not registered. Relays to them answer
     `404 unknown_session`, as designed.
3. **Machine principal everywhere.** All three relay routes use `requireMachinePrincipal`. The
   hand-out and the accept-set write run only for a machine principal.
   - `from_machine` is the principal. A body naming a different one gets `403 machine_mismatch`.
   - Ack and fail touch only rows whose `to_machine` is the principal.
4. **Conditional register.** The upsert's `DO UPDATE` carries the ownership condition, so a
   racing register cannot overwrite between the read and the write.
   - Machine principal: same owner, or a row idle past `REGISTER_TAKEOVER_STALE_MS`.
   - Shared principal: the existing owner is not retired.
   - If no row changed, the request answers `409 owned_by_other_machine`, or `401` for the shared
     key.

## Decisions the design leaves open

- **Conflict hash.** `payload_sha256` covers `from`, `to`, `kind`, `reply_to` and `payload`: what
  makes a message the same message. It deliberately excludes `from_label`, so a sender renamed
  between retries is still idempotent.
- **Check order on `/swarm/relay`:**
  1. Validate the body.
  2. Look up the existing `(from_machine, msg_id)` row.
     - Identical hash → `202 {duplicate: true}`, without re-running the checks below: the first
       attempt already passed them.
     - Different hash → `409 msg_id_conflict`.
  3. Sender: a `from` registered to another machine gets `403 sender_not_yours`. An unregistered
     `from`, such as a subagent, passes.
  4. Owner (`404 unknown_session`).
  5. Same machine (`409 same_machine`).
  6. Retirement (`403 receiver_not_retired`).
  7. Accept set: no row or not listed → `403 not_accepted`. Owner's last poll older than 60 s →
     `503 target_offline`.
  8. Cap (`429`).
  9. `INSERT ... ON CONFLICT DO NOTHING`. If it lost a race, re-read and apply step 2.
- **Validation.**
  - `to` is `ses_`/`gse_` plus at least 8 id characters.
  - `from` is `ses_` plus the same.
  - `msg_id` is 1–128 characters with no `:`.
  - `priority` is urgent, normal or low.
  - The `payload` is a string of at most 64 KiB in UTF-8. That bounds the D1 row; the pull-session
    limit stays with the receiver.
  - `deliver_at` and `ref` must be present, either value or null.
  - `expires_at` is null or in the future. A past value gets `410 expired`, not 400, because a
    scheduled send retried to its end lands there normally.
  - `from='pigeon'` fails the `ses_` rule.
- **Expiry.** The worker's deadline is the sender's `expires_at` capped at now + 24 h, or now + 24 h
  when null. It is stored in the column and handed out as `relay_expires_at`. The item's
  `expires_at` stays the sender's value, null included, because the receiver's arbiter picks its
  retry policy by whether a row has one. The
  hand-out skips expired rows. The hourly step turns them into failure items:
  - queued → `never_collected`;
  - leased → `unconfirmed`.

  Failure items live 24 h and are never answered.
- **Hand-out.**
  - Up to 20 items, oldest first.
  - Selected and leased in one `UPDATE ... RETURNING`, so two overlapping polls cannot claim the
    same item.
  - Eligible rows are queued, or leased for more than 60 s, and not expired.
  - Message items must come from a machine in the request's `accept=` list. Failure items need
    `failures=1`.
  - The poll's status codes are unchanged except that a 204 with items becomes
    `200 {swarm: [...]}` with no `commandId`. Items are claimed once per poll, before the command
    loop, and attached to whichever response that loop returns.
  - A missing table or a D1 error in this step is logged, and the poll proceeds without `swarm`.
    The relay must never cost a command.
- **Accept set.**
  - A poll with the header upserts `(machine_id, accept_csv, seen_at)`.
  - A machine-principal poll without it clears an existing non-empty set. A rolled-back receiver
    then answers `403 not_accepted` at once, rather than `503 target_offline`, which senders would
    keep retrying.
- **Ack.**
  - At most 100 items per call. Each returns `ok`, `not_found` or `not_yours`.
  - Accepted from `queued` or `leased`, so a late ack after a lapsed lease still settles the row.
  - Repeating an ack is a no-op.
  - `refused` on a message item mints a failure item carrying the receiver's reason code
    (`[a-z0-9_]{1,64}`). On a failure item it only logs.
- **Fail.**
  - Mints the failure item for a message row the principal received, in any state.
  - A queued or leased row becomes `refused`, so it is not handed out again.
  - The `f:` primary key makes every path idempotent: at most one failure item per message.
  - An unknown row answers `200 {ok: true, noop: true}`.
- **Retention.** Delivered, refused and expired rows are deleted 7 days after creation. That covers
  the sender's retry window, so an idempotent retry still finds its row.
- **Missing tables.** The three routes answer `503 relay_unavailable`, and the poll omits `swarm`.
  A deploy that precedes the schema apply degrades to "relay unavailable".
