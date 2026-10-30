# Relay hold for a sleeping machine — design

Status: proposed, awaiting adversarial review. Bead `pigeon-k0qn.22`, epic `pigeon-k0qn`.

## Problem

A `swarm_send` to a session on a machine that is asleep (the Mac with its lid closed) fails.
Worker `POST /swarm/relay` answers `503 target_offline` when the owner's `machines.last_poll_at`
is more than 60 s old (`RELAY_ONLINE_MS`, `relay.ts` `relayReachability` and `handleRelay`). The
sender's daemon retries that as an outage and, after its 10-attempt budget (about 6 minutes),
fails the row with "was never delivered and was NOT received … safe to resend". Observed
2026-10-30: `msg_mvvh2gei_048f0444` to a Mac session failed within minutes of the lid closing.
The cross-machine design lists this as a known limit (`2026-10-20-cross-machine-swarm-design.md`
§7, "A sleeping Mac answers `target_offline`").

What Jonathan wants: the message is held and delivered when the machine wakes, for up to 24 h.

Once the worker has accepted a relay, all the machinery for that already exists: the row waits in
D1 `swarm_relay` up to `RELAY_MAX_TTL_MS` (24 h), is handed out on the owner's next poll (at most
20 per poll), and if it is never collected the hourly expiry mints a `never_collected` failure item
that reaches the sender as "NOT received … safe to resend". Only the refusal at the door is missing.

## Decisions taken with the human

- **Messages only.** Remote launches (`/launch/relay`) keep refusing a target that is not polling
  (`target_offline`, `LAUNCH_ONLINE_MS`). A held launch could start a shell-holding session up to a
  day after the request, when its context is stale.
- **24 h.** The existing `RELAY_MAX_TTL_MS`; no new clock.

## Approaches considered

1. **Worker accepts for a known-but-sleeping machine (chosen).** One line of policy at the door;
   everything downstream (queue, hand-out, expiry receipt) is reused.
2. **Sender keeps retrying `target_offline` for 24 h, worker unchanged.** Two clocks, D1 traffic on
   every backoff for a day, and it cannot work when the *sender* is the machine that sleeps.
3. **Worker holds, and the sender is told it is held** (a `held: true` in the 202 surfaced to the
   agent). Rejected for now: the sender's agent got `Queued msg_…` long before the relay attempt (the
   daemon relays asynchronously), so surfacing it costs an extra message per send. `swarm_list
   remote: true` already shows `offline` for the machine.

## Design

### Worker (`packages/worker/src/relay.ts`)

`handleRelay` keeps every check and its order, and changes what an `offline` reachability means:

- **`last_poll_at` is NULL (never polled, or no `machines` row): refuse as today**, `503
  target_offline`. A machine id that has never polled is a typo, or a machine not yet set up; a
  fast refusal is the useful answer. (In practice `not_accepted` usually fires first, because
  `machine_relay_accept` is written from the poll header, but the check stays.)
- **Last poll older than `RELAY_GONE_MS` (7 days): refuse**, `503 target_offline` with a detail
  saying it has not polled for N days. A machine silent that long is more likely decommissioned
  than asleep; holding would turn a ~6-minute failure into a ~25-hour one for nothing. 7 days is
  also the session reaper's TTL, after which the target session would be unregistered anyway.
- **Otherwise (polled within 7 days but not within 60 s): accept and queue** exactly as for an
  online target. The `queue_full` cap (50 queued/leased per target) still applies, so a long sleep
  cannot grow the queue without bound; a sender past the cap gets `429 queue_full`, retried like
  an outage and then failed, as today.

`relayReachability` itself is unchanged: it still reports `offline` for a machine not polling in
the last 60 s. It is shared with `GET /sessions/remote` (what `swarm_list remote: true` shows) and
with remote launch's return-path check (`/launch/relay` check 9), and both want the
descriptive answer. Only `handleRelay` reinterprets it.

Ordering and receipts are unchanged: items are handed out by `created_at` on the owner's polls; a
held item expires at `min(msg.expires_at, now + 24h)` and returns `never_collected` to the sender.
A scheduled send is already accepted with its own `expires_at` cap.

### Daemon and plugin

- No sender change. A held relay is a 202, so the row becomes `handed_off` and verified
  (`verify_family='relayed'`) at once, as for any relay.
- `swarm_list remote: true` (`swarm-list-tool.ts`): the `offline` wording changes from
  "not polling the worker; asleep or down" to say a message sent now is held up to 24 h and
  delivered when it wakes, or comes back as never collected. The status value stays `offline`, so
  an old plugin against a new worker and vice versa both still work. The skill table in workstation
  `swarm-messaging` says the same, and drops "do not send, not even to an `offline` machine".

### Docs

`AGENTS.md` (Swarm IPC relay bullets), `swarm-architecture` (check-order line, Known limits),
`swarm-operations` (the "retries for ~6 minutes" row), the cross-machine design's §7 limit line,
workstation `swarm-messaging` ("Sessions on other machines"). Remote launch docs are untouched
except to say launches still refuse an offline target.

## Deployment and rollback

The worker deploy alone switches the hold on; no schema change. The wording ships with the next
daemon/plugin deploy and is cosmetic. Rollback: redeploy the previous worker; items already queued
for a sleeping machine stay queued and are delivered or expire as normal.

## Tests

Worker (`relay` tests): stale-but-recent target → 202 and a `queued` row; `last_poll_at` NULL → 503
`target_offline`; last poll older than 7 days → 503 `target_offline`; `queue_full` applies to a
sleeping target; `/launch/relay` to a sleeping target still → 503 `target_offline`; `GET
/sessions/remote` still reports `offline`. Plugin: the new `offline` wording.

## Known limits

- The sender's agent is not told that its message is waiting for a sleeping machine. It learns
  either nothing (delivered on wake) or, ~25 h later, `never_collected`.
- A message whose meaning is time-sensitive may arrive hours late. The skill already tells senders
  to say when a payload was written.
- A machine asleep for more than 7 days refuses again; one asleep between 24 h and 7 days accepts
  and then returns `never_collected` unless it wakes in time.
