# Relay hold for a sleeping machine — design

Status: approved by adversarial review with changes (folded in below; see §Review). Awaiting go-ahead to build. Bead `pigeon-k0qn.22`, epic `pigeon-k0qn`.

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

- **No `machines` row / no last poll: refuse as today**, `503 target_offline`. This is a guard,
  not a path anyone takes: `machines.last_poll_at` is `NOT NULL`, nothing deletes `machines`
  rows, `machine_relay_accept` is only written by a poll (so `not_accepted` fires first), and
  `to_machine` comes from D1 `sessions.machine_id`, not from caller input.
- **Last poll older than `RELAY_GONE_MS` (7 days): refuse**, `503 target_offline` with a detail
  saying how long it has been silent. The case this serves is a decommissioned or renamed machine
  id, whose accept row and `sessions` rows survive until the 14-day sweep (`d1-ops.ts`); holding
  for it would turn a ~6-minute failure into a ~25-hour one. (The session reaper is no reason: it
  runs on the sleeping machine and cannot unregister anything while it sleeps.)
- **Otherwise (polled within 7 days but not within 60 s): accept and queue** exactly as for an
  online target. This covers a machine that is down (daemon stopped, crash-looping, host off) as
  well as one asleep: both used to fail in ~6 minutes and now wait up to 24 h. The `queue_full` cap (50 queued/leased per target) still applies, so a long sleep
  cannot grow the queue without bound; a sender past the cap gets `429 queue_full`, retried like
  an outage and then failed, as today. The cap counts all senders together, so one chatty sender
  can fill it overnight for everyone; accepted and documented, no per-sender sub-cap (YAGNI at
  three machines).

`relayReachability` itself is unchanged: it still reports `offline` for a machine not polling in
the last 60 s. It is shared with `GET /sessions/remote` (what `swarm_list remote: true` shows) and
with remote launch's return-path check (`/launch/relay` check 9), and both want the
descriptive answer. Only `handleRelay` reinterprets it.

Ordering and receipts are unchanged: items are handed out by `created_at` on the owner's polls; a
held item expires at `min(msg.expires_at, now + 24h)` and returns `never_collected` to the sender.
A scheduled send is already accepted with its own `expires_at` cap.

### Age of a held message (`relayed_at`)

A held message must not arrive looking fresh. The worker's hand-out query already reads the row's
`created_at` and drops it; it now sends it as `relayed_at` on each message item. The receiving
daemon stores it on its inbound record and the arbiter renders it in the envelope as
`held_ms="<ms>"` (time between the worker accepting the relay and this delivery attempt) when it
exceeds 60 s, beside the existing `from_machine`. Old receivers ignore the extra field (the
receiver reads named fields only), and a new receiver with an old worker simply has no
`relayed_at` and renders nothing. The workstation `swarm-messaging` skill tells receivers what
`held_ms` means: the sender wrote this that long ago; re-check before acting on anything
time-sensitive.

### Receipt wording (`relay-notice.ts`)

`never_collected` now usually means "held 24 h for a machine that never woke", and its current
text ("Nothing was written to the target, so it is safe to resend") invites a resend that would be
held again. The text, still rendered from the code alone, becomes: the worker held it for
<machine> and <machine> never collected it (asleep, down, or gone); nothing was written to the
target; check `swarm_list remote: true` and resend only if it is still relevant. Same treatment for
the `queue_full` exhaustion text where it says "safe to resend".

### Daemon and plugin

- No sender change. A held relay is a 202, so the row becomes `handed_off` and verified
  (`verify_family='relayed'`) at once, as for any relay.
- `swarm_list remote: true` (`swarm-list-tool.ts`): the `offline` wording uses the
  `last_poll_at` the plugin already receives: "offline, last polled 9h ago; a message sent now is
  held up to 24h and delivered if it wakes in time". A machine silent for more than 7 days gets
  "offline for N days; sends are refused". The status value stays `offline`, so an old plugin
  against a new worker and vice versa both still work. The plugin's header line ("available means
  the worker will queue it") and `relayReachability`'s docstring ("cannot drift") are corrected:
  for a send, `offline` now means held, and the reinterpretation lives in `handleRelay`. The skill table in workstation
  `swarm-messaging` says the same, and drops "do not send, not even to an `offline` machine".

### Docs

`AGENTS.md` (Swarm IPC relay bullets, including "`target_offline` … retried like any outage",
now only for a machine silent over 7 days), `swarm-architecture` (check-order line, the
`relay`-per-machine line that says the two "cannot drift", Known limits), `swarm-operations` (the
`target_offline` log row and the "retries for ~6 minutes" row), the cross-machine design's §7
limit line, workstation `swarm-messaging` ("Sessions on other machines": the status table, the
"falls asleep around the time you send" paragraph, and `held_ms`). Remote launch docs are untouched
except to say launches still refuse an offline target.

## Deployment and rollback

The worker deploy alone switches the hold on; no schema change. The wording ships with the next
daemon/plugin deploy and is cosmetic. Rollback: redeploy the previous worker; items already queued
for a sleeping machine stay queued and are delivered or expire as normal.

## Tests

Worker: stale-but-recent target → 202 and a `queued` row; no `machines` row → 503
`target_offline`; the exact `RELAY_GONE_MS` boundary (just inside → 202, just past → 503); a
machine silent over 7 days that is also `not_accepted`/`not_retired` still gets those first;
`queue_full` applies to a sleeping target; an item accepted while the target was offline is handed
out through `handlePollNext` on its next poll, carrying `relayed_at`; `/launch/relay` to a sleeping
target still → 503 `target_offline`; `GET /sessions/remote` still reports `offline`.
Daemon: `relayed_at` is stored and rendered as `held_ms` only above 60 s, absent when missing;
the new `never_collected` / `queue_full` receipt text. Plugin: the new `offline` wording, with and
without `last_poll_at`, and the 7-day refused text.

## Known limits

- The sender's agent is not told that its message is waiting for a sleeping machine. It learns
  either nothing (delivered on wake) or, ~25 h later, `never_collected`.
- A message whose meaning is time-sensitive may arrive hours late; the receiver sees `held_ms`.
- Suspected, unverified: if the Mac's daemon polls during a macOS dark wake (Power Nap), held items
  are collected then and their turns may freeze when it sleeps again. Idempotent re-handout covers
  duplicates; check `pmset -g log | grep DarkWake` against the daemon log if it shows up.
- A machine asleep for more than 7 days refuses again; one asleep between 24 h and 7 days accepts
  and then returns `never_collected` unless it wakes in time.

## Review

Adversarial review (2026-10-30) approved with changes; all are folded in above: `relayed_at` /
`held_ms` so a held message does not look fresh; receipt wording that does not invite a re-held
resend; "asleep or down" and the shared queue cap stated; `swarm_list` rendering `last_poll_at`
and the "cannot drift" docstring corrected; the NULL branch and the 7-day cutoff re-justified; the
extra tests and doc lines. It confirmed that nothing after acceptance assumes the owner was polling
at accept time (`to_machine` is fixed at accept; hand-out never re-reads `sessions`; re-handout is
idempotent; pull banking's 5-day TTL already allows for the 24 h wait; a reaped or not-yet-served
target is handled by locality), that remote launch check 9 is unaffected, and that every version
skew is safe.
