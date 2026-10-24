# Daemon relay: send and receive (pigeon-k0qn.6 + .7)

Contract: design §3.1–§3.3 (`2026-10-20-cross-machine-swarm-design.md`). Wire shapes: the worker,
`packages/worker/src/relay.ts`, which is the source of truth. This note records the decisions the
design leaves to the daemon.

Both halves ship dark. Nothing changes until a machine sets `PIGEON_SWARM_RELAY_SEND=1` or a
non-empty `PIGEON_SWARM_RELAY_ACCEPT_FROM`. Turning them on is `.11`.

## One table records "this row arrived by relay"

`swarm_relay_inbound(msg_id PRIMARY KEY, from_machine, from_label, received_at, fail_reason,
fail_attempts, fail_next_at, fail_done_at)`, a new `CREATE TABLE IF NOT EXISTS`.

A side table rather than columns on `swarm_messages` because a relayed message can land in either
of two tables: `swarm_messages` (arbiter), or `pull_inbox` (a banking pull or goose session). Both
key on the original `msg_id`, so one side table serves both. Three readers:

- **The hop rule.** The arbiter never relays a row with an inbound record. A relayed row that is
  not local here fails here (the Phase 1 remote failure, routed back as below).
- **Late failures.** `notifySenderOfFailure` is the single funnel every late failure passes
  through: arbiter expiry, the attempt budget, permanent errors, the watchdog's terminals, and
  pull-inbox expiry. When the failed `msg_id` has an inbound record, it does not insert a local
  `from='pigeon'` row. That row would be addressed to a remote session, and the relay route refuses
  `from='pigeon'`. It stamps `fail_reason` on the inbound record instead. A sender loop POSTs
  `/swarm/relay/fail` with backoff and stamps `fail_done_at`. Stamping is idempotent
  (`WHERE fail_reason IS NULL`), so a row that fails twice reports once.
- **The envelope.** The arbiter renders `from_machine="…"` from the record.

Failure reason codes sent by the receiver are derived the same way `formatFailureNotice` decides
"landed": `unconfirmed_on_receiver` when the payload was handed to the target, else
`not_delivered_on_receiver`. A target that is not here at all (the hop rule) sends
`not_on_receiver`.

Retention is bounded by the worker. It forgets a settled relay row 7 days after it was relayed
(`RELAY_RETENTION_MS`), after which `/swarm/relay/fail` answers a no-op. So:
- inbound records are pruned at 8 days, but only once their message is gone from both tables,
  because the hop rule and the `/fail` diversion read them;
- a relayed message banked in a pull inbox gets a 5-day TTL instead of 7. It may have waited up
  to 24 hours at the worker before being banked, and its expiry must still be reportable;
- a `noop` or a 4xx from `/fail` is final and logged as "its sender will not be told".

## Receiving (`.6`)

Every poll sends `X-Pigeon-Swarm-Relay: accept=<csv>; failures=1`, with an empty list unless
`PIGEON_SWARM_RELAY_ACCEPT_FROM` names machines (self is dropped).

`failures=1` is sent always, not only while sending is on. A failure item lives 24 hours at the
worker, so turning sending off must not strand ones already owed. It stays inert until this
machine has relayed something. A 200 with no
`commandId` is no command.

In `Poller.tick`, relay items are processed and acked **before** the command from the same
response is dispatched. Processing is synchronous SQLite work; only the ack is network. The relay
callback never throws into the poll.

Per message item, in order (first refusal wins, acked `refused` with the code):

1. `from_machine` not in the accept list → `not_accepted`.
2. Shape: `parseSwarmSendBody` (rejects `from='pigeon'`, reserved kinds, `:` in msg_id, close
   tag), plus `from` must be `ses_`, priority valid, `deliver_at`/`expires_at` number-or-null →
   `invalid`.
3. `from` is a session on this machine → `from_is_local`. That covers two cases:
   - it has a `sessions` row;
   - the arbiter's locality check answers `local`. This catches subagents and reaped sessions,
     which have no row. Replies route by id, so they would otherwise reach our own session.

   Senders are probed in parallel before the synchronous pass, so a batch costs one round of
   probes (about 3 seconds at worst). `unknown` passes, so that a sick serve does not hold relays
   hostage and expire them as "unconfirmed".
4. `msg_id` already exists here, in either table, or in the inbound records. It is a duplicate
   (a re-handout after a lost ack, acked `delivered`) only if an inbound record exists with the
   same `from_machine`, `from` and `to`, and the stored payload is the same. Anything else is
   `msg_id_conflict`, including a local row with a reused caller-supplied id.
5. Target is a pull or goose session that lacks either `swarm` or `swarm-remote` in
   `pull_sources` → `remote_not_accepted`. `swarm-remote` alone banks nothing, because banking
   keys on `swarm`.
6. Insert, in one transaction, through `bankOrInsertSwarmMessage` with the original fields
   (`expires_at` unchanged, `relay_expires_at` ignored) plus the inbound record. A `refused`
   result is acked `refused` with its reason (`scheduled`, `payload_too_large`, `no_mailbox`,
   `no_session`).

Then acked `delivered`. An item whose processing throws (a transient SQLite error) is left out
of the ack, so the worker offers it again; acking it `refused` would make a transient fault
permanent.

The Telegram notice names a remote sender as `<from_label> (<from_machine>)`, because there is no
local session row for it. `swarm-remote` joins `ALLOWED_PULL_SOURCES`.

## Sending (`.7`)

In the arbiter, on a `remote` verdict with relay enabled:

- The row has an inbound record (hop rule) → the existing remote failure.
- The sender is not `ses_` (a `pigeon` notice, a goose sender), or the target fails the
  worker's `TARGET_ID` (`ses_abc`) → the existing remote failure. The worker would answer 400,
  and for a short id the Phase 1 path gives the right "check the id" advice.
- Otherwise POST `/swarm/relay`:
  - Any 202, duplicate or not → `markRelayed`: `handed_off` + `verified_at` +
    `verify_family='relayed'`, in one statement.
  - Permanent answers (§3.1 table) → `RelayRefusedError` (permanent), notice worded per code.
    `404 unknown_session` for an id shaped like a truncation → the existing incomplete-id notice.
  - Transient answers (503, 429, 5xx, transport, 401) → `TargetUnavailableError`, so the
    existing retry and budget rules apply unchanged.

`relayed` joins `VERIFY_FAMILIES`. The watchdog never sees such rows, because they are verified
at handoff. If one ever does arrive, the watchdog refuses it with the unknown-family alarm rather
than fetching a transcript, since a silent skip would leave the row immortal.

A cancel that lands during the POST loses: the row is stamped relayed from `cancelled`.

**Failure items** (`item: "failure"`), received in the same poll. Accepted only if:

- `from_machine` is this machine;
- the row's `from` and `to` match the item's;
- the original row is in one of these states:
  - `relayed` and `handed_off`;
  - still `queued`. A relay whose 202 was lost leaves the row queued while the worker holds the
    message, and the receiver can refuse it before the retry's `202 duplicate`. The item is the
    worker's proof that we relayed it.
  - already `failed`. This is acked with no change.

Accepting moves the row to `failed`. A relayed row goes through its own guarded method, because
`markFailed` refuses verified rows; a queued row goes through `markFailed`. A re-handout is a no-op
that is still acked `delivered`. It then calls
`notifySenderOfFailure` with text rendered from the reason code only. An unrecognised code is
named as a code, never as prose. A non-matching item is acked `refused`
(`no_matching_relay`), which the worker logs and drops.

Notice wording by code:

- `never_collected`: NOT received, safe to resend.
- `not_delivered_on_receiver`: NOT received, safe to resend.
- `unconfirmed`: UNCONFIRMED, resend only if a duplicate is harmless.
- `unconfirmed_on_receiver`: UNCONFIRMED, do not resend.
- Every other refusal: NOT received, and resending will fail the same way.

A wake or scheduled row whose relay failed also raises a `wake-relay-failed` alert, the relay
analogue of `wake-permanent`.

## Known limits

- **A relayed-in row that never reaches a terminal state reports nothing.** These are the
  watchdog's non-terminal states: blocked behind a turn, silent in flight, no healthy serve, and
  a 404 with no second opinion. A local send in these states is equally silent, but its sender's
  row is at least unverified. A relayed sender's row is verified at handoff, so that sender hears
  nothing at all.
- **Failures after 7 days are lost** (retention above).
- **An ambiguous relay can mislead after a timeout.** If a relay timed out after the worker had
  stored it, every later attempt hits a transient error, and the receiver never answers, then the
  attempt budget ends with "NOT received, safe to resend" while the worker still holds the
  message. If the receiver *does* answer, it is handled (the queued-row case above).
- **Remote `gse_` targets are unreachable.** `/swarm/send` on the sender refuses a `gse_` id with
  no local row (`bank-or-insert.ts`, `no_session`), so a goose session cannot be a cross-machine
  target. Goose swarm targets are `pigeon-k0qn.13`'s scope.
- **Goose senders cannot relay.** The worker takes `ses_` senders only, so they keep the Phase 1
  failure.

## Testing

`test/swarm-relay.test.ts` has the unit tests. `test/swarm-relay-e2e.test.ts` runs two daemons
(devbox and cloudbox) against the worker's REAL `handleRelay`, `handleRelayAck`,
`handleRelayFail` and `handlePollNext`. Those run on a better-sqlite3 shim of the D1 API with the
production `d1-schema.sql`, so no part of the wire contract is re-implemented in the test.
