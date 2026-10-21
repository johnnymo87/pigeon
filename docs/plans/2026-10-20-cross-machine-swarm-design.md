# Cross-machine swarm messaging — design

Status: proposed, 2026-10-20. Phase 1 approved to build; Phase 2 waits on a human decision
(§0). Adversarially reviewed at plan time; the review's required changes are folded in.
Tracking: epic `pigeon-k0qn` in beads.

## Problem

Swarm messaging works only between sessions on the same machine. A session on the Mac that
sends to a cloudbox session today:

1. gets `202 accepted` from its local daemon;
2. causes a `w:` Telegram notice for the target to be posted **in the Mac's chat**. That is what
   destroyed a cloudbox topic mapping on 2026-10-20 (`pigeon-533h`, fixed worker-side); the
   daemon still emits it (`pigeon-qioa`);
3. retries for minutes against a session no local serve has heard of, writing a phantom
   `session_assignment` row (`ensureRouted` treats an unknown id as routable,
   `routing/opencode-routable.ts:20-36`);
4. ends in a `delivery.failed` that does not say why.

The original swarm design (workstation `docs/plans/2026-04-21-swarm-ipc-design.md:306`) deferred
cross-machine routing as "works for free later if we wire D1". The routing data exists; the
transport, the failure reporting and the trust model do not.

## §0. Two phases, and the decision between them

**Phase 1 — honest failure (build now).** A send to a session on another machine fails fast,
with no foreign Telegram notice, no phantom placement, and a `delivery.failed` that names the
owning machine: *"target ses_… is on cloudbox; cross-machine swarm is not supported."* This is
useful on its own and is a prerequisite of Phase 2.

**Phase 2 — the relay (decide first).** Actual cross-machine delivery through the worker.

Phase 2 waits on a human decision because:

- **Demand is unmeasured.** Production D1 holds ~770 cloudbox, ~45 devbox and ~10 macbook
  sessions. Phase 1's failures will show how often cross-machine sends are attempted.
  *Measured on 2026-10-20 (cloudbox journal, ~70 days back):* 7 swarm sends failed terminally on an
  unresolvable target.
  - **5 were provably not cross-machine:** three truncated ids of local sessions, a test id, and a
    goose-pull lane.
  - **2 are unprovable either way.** They are absent from cloudbox's opencode DB, and the worker
    sweeps its rows after 14 days.

  Since Phase 1 deployed, the only remote failures have been the deploy's own smoke tests. This is a
  lower bound on demand: agents have been told swarm is same-machine only, so wanted sends that
  were never attempted are invisible. devbox and macbook were not measured. The method and the ids
  are in a `bd` note on `pigeon-k0qn.4`.
- **It changes what the shared key can do.** Today `CCR_API_KEY` cannot inject a prompt into any
  session: only the Telegram webhook creates `execute` commands. A relay would let any holder of
  the key, on any machine, prompt sessions on every machine that accepts relays. The key is on
  devbox (personal) as well as on cloudbox and the Mac (work). See §6.

The decision bead records: build Phase 2 or not; and, if so, whether per-machine credentials
(§6) are built first or receiving is enabled without them under an explicit, per-machine waiver.

## Constraints that pick the transport

- **The machines cannot reach each other directly.** Mac → cloudbox is SSH over IAP only;
  cloudbox → Mac exists only during a human `cloudbox-cutover`; devbox ↔ cloudbox has no link.
  Every daemon binds loopback. An exposed daemon route was a security incident on 2026-09-12.
- **Every daemon already polls the worker** (`GET /machines/:id/next`, every 5s, outbound).
- **The worker already knows who owns a session**: D1 `sessions.machine_id` (last registrant
  wins), and whether that machine is alive (`machines.last_poll_at`).

So the worker is the rendezvous. Direct daemon-to-daemon transport is rejected: it would need new
network exposure on every host.

## §1. Locality (Phase 1)

Everything hangs on one tri-state predicate, evaluated in the arbiter before any delivery client
is built: **local**, **remote**, or **unknown**.

- `gse_…` targets: `storage.sessions` is authoritative (pigeon mints those ids). Row → local;
  no row → remote. **Never probe a serve for them** — opencode answers `GET /session/gse_…` with
  500, not 404, which would leave every remote goose target "unknown" forever.
- Any target with a `storage.sessions` row → local.
- Otherwise (`ses_…`): a read-only `GET <serve>/session/<id>` with no directory header. All serves
  on a machine read one `opencode.db` (verified on cloudbox, `:4096` and `:4099`; the directory
  registry already relies on it, `swarm/registry.ts:58-93`), so 200 → local (this includes
  subagent sessions, which are never registered), 404 → remote, anything else → unknown.
  This needs a tri-state variant of the registry lookup: `makeDirectoryResolver` folds every
  error into `undefined` (`routing/directory-resolver.ts:31-35`).

Rules:

- **Unknown is never treated as remote.** It is a transient failure and is retried, so a briefly
  sick serve cannot push local traffic off the machine.
- **Read-only.** The check runs before `clientForSession`, so a remote id never reaches
  `ensureRouted` and never gets a phantom placement. (The same phantom-placement hazard for
  *unknown local* ids is a separate bug, `pigeon-8dhq`, outside this epic.)
- **Not cached across ticks.** A session can come back (a reaped row revived), and a stale
  "remote" verdict would misroute it.
- Implementation must confirm the shared-data-dir assumption on devbox and macOS, not only
  cloudbox.

## §2. Phase 1 behaviour

- **No foreign Telegram notice** (`pigeon-qioa`, ships first, alone): `enqueueSwarmTelegramNotice`
  skips targets with no `storage.sessions` row. Every path that registers with the worker writes
  the local row first, and the reaper deletes both together (`session-reaper.ts:40-50`), so the
  only notices suppressed are ones that could never land correctly: foreign sessions and
  unregistered local ones (subagents, reaped), which the worker 404s anyway.
- **Remote → permanent failure, immediately.** A remote verdict fails the row on the first
  attempt (no retry budget), and `delivery.failed` names the owner. The owner comes from a new
  worker route, `GET /sessions/:id/owner` → `{machine_id, last_seen}` or 404. The lookup is
  decoration: it is bounded (2s) because it runs inside the target's in-flight slot, and on
  timeout, error or an old worker the notice says "not on this machine" without naming one. It
  never blocks the failure.

## §3. Phase 2 — the relay

### Shape

A row whose target is remote is inserted into the sender's `swarm_messages` like any other. When
the arbiter would deliver it, and `PIGEON_SWARM_RELAY_SEND=1`, it POSTs the row to the worker
instead of prompting a serve. The worker stores it in a **dedicated `swarm_relay` table** (not the
command queue) addressed to the owning machine. That machine's daemon receives a batch of relay
items in its ordinary poll response, re-validates each, inserts it with its original `msg_id`
through `bankOrInsertSwarmMessage`, and acks the batch. From there the receiver's own arbiter,
watchdog, inbox, pull banking and Telegram notice apply unchanged.

Keeping the relay as a delivery path in the arbiter keeps the existing contract: `/swarm/send`
still answers 202 at once, scheduled rows relay at `deliver_at` with no new clock, worker outages
are retried by the existing loop, and permanent refusals become `delivery.failed` through
`notifySenderOfFailure`.

### Why a separate table, not the command queue

Reusing `commands` with a `swarm` type was the first draft. It is rejected because:

- `Poller.dispatch` calls `onInboundForSession` → `markAllRead` for every command with a session
  id (`daemon/src/index.ts:466-474`), so each relayed message would clear the human's unread badge.
- The poller does not ack unknown types (`worker/poller.ts:498-507`); a receiver rolled back after
  advertising would be handed `swarm` commands every lease for 24h.
- One command per 5s poll: a 50-message burst takes ~4 minutes and delays human commands.
- `queueCommand`'s 100-row cap counts every row; `chat_id` is `NOT NULL`.

A separate table delivered in batches avoids all of these, needs no `ALTER` on an existing table
(`CREATE TABLE IF NOT EXISTS` is idempotent, unlike `ADD COLUMN`, `d1-schema.sql:102-104`), and
adds no extra request.

### §3.1 Sender daemon

- **Relay path.** Remote verdict + `PIGEON_SWARM_RELAY_SEND=1` → `POST /swarm/relay`. Without the
  flag, Phase 1 behaviour.
- **Hop rule, absolute.** A row that *arrived* by relay is never relayed again. If it is not local
  on the receiver it fails there. This closes multi-hop paths when D1 changes owner, including a
  row returning to its own sender, where `ON CONFLICT(msg_id)` would drop it. No exemption is
  needed for failure notices: they are minted and addressed by the worker (§3.2), not relayed.
- **Verification family.** On a 2xx, `markHandedOff(..., verify_family='relayed')` and stamp the
  row terminal-verified. Do not add a separate `handoff_kind` column: the watchdog treats a NULL
  family as `transcript` (`swarm/verify-family.ts:29-33`). A transcript check against a remote id
  gets a 404, reads as "confirmed gone", and tells the sender "safe to resend", which duplicates
  the prompt. Unverified `handed_off` rows are also never cleaned up (`swarm-repo.ts:576-588`).
  Because the row is stamped verified, a daemon rolled back over it never examines it at all,
  which is the safe outcome.
- **Worker answers:**

  | Answer | Meaning | Treatment |
  |---|---|---|
  | `202` | stored for the owner | handed off (`relayed`) |
  | `404 unknown_session` | nobody owns it | permanent → `delivery.failed` |
  | `409 same_machine` | D1 says it is ours | permanent; log loudly (locality and D1 disagree) |
  | `403 not_accepted` | owner does not accept relays from us | permanent |
  | `409 msg_id_conflict` | that id is taken by a different message | permanent |
  | `503 target_offline` | owner not polling | transient |
  | `429` / 5xx / transport | worker trouble or cap | transient |

### §3.2 Worker

- **`swarm_relay` table**: `(from_machine, msg_id)` primary key, `to_machine`, `to_session`,
  `body_json` (all fields below), `payload_sha256`, `status` (`queued` | `leased` | `delivered` |
  `refused` | `expired`), `created_at`, `leased_at`, `expires_at`. Keying on `from_machine` stops
  a different message that happens to reuse a caller-supplied `msg_id` (e.g. stall-watch
  `delegate.py:157`) from being silently swallowed; a same-key insert with a different
  `payload_sha256` answers `409 msg_id_conflict`, an identical one answers 202 (idempotent retry).
- **`POST /swarm/relay`** carries every field the receiver needs to rebuild the row faithfully:
  `msg_id, from, to, kind, priority, reply_to, payload, deliver_at, expires_at, ref, from_label`,
  plus `from_machine`. **`deliver_at` and `ref` are required**: without them the receiver loses
  `scheduled_for` / `delivered_late_ms` / `ref`, and `isSuppressedFromRecovery`
  (`delivery-policy.ts:52-56`) flips, making a scheduled non-`wake` row eligible for watchdog
  redelivery — duplicate injection. Checks, in order: validate ids (`ses_`/`gse_` target, `msg_id`
  without `:`, `from` is `ses_…`); owner from
  `sessions.machine_id` (absent → 404); owner = `from_machine` → 409; owner's accept set lacks
  `from_machine` → 403, or was last reported more than the 60s online threshold ago → 503;
  per-target-machine cap (50 queued) → 429. `from='pigeon'` is **not** accepted on this route:
  failure notices are minted by the worker itself (below), never by a caller.
- **Accept set storage.** `CREATE TABLE IF NOT EXISTS machine_relay_accept (machine_id PRIMARY KEY,
  accept_csv, seen_at)`, written from each poll's header. The relay route reads it, so a sender
  learns at once that the owner does not accept it; hand-out re-checks the live request header, so
  a rolled-back receiver stops receiving immediately.
- **Hand-out.** `GET /machines/:id/next` keeps its body and status codes; when the request carries
  `X-Pigeon-Swarm-Relay: accept=<machine,…>` the response gains `swarm: [...]`, up to 20 queued
  items for that machine from senders in that list. The gate is the *request's* header, read at
  hand-out time, so a rolled-back daemon stops receiving at once and its items expire (below). The
  same header carries `failures=1` whenever the daemon has relay *sending* enabled: failure items
  addressed to this machine are handed out whatever the accept list says, so a send-only machine
  still hears about its failures. A 204 today becomes a 200 with only `swarm` when there is no
  command; `handlePollNext` must attach `swarm` on every return path, including the 204s inside the
  unservable-launch refusal loop (`poll.ts:115-167`), and must skip items whose `expires_at` has
  passed (the expiry cron runs hourly). An old daemon never sends the header, so never sees the
  field.
- **Ack.** `POST /swarm/relay/ack` `{items: [{from_machine, msg_id, outcome}]}`, outcome
  `delivered` or `refused` with a reason. Leased items not acked within 60s are handed out again.
- **No silent loss.** Every message item ends in a state the sender hears about. An item that
  expires (`expires_at`, or 24h for unscheduled rows) or is refused, by the worker or by the
  receiver, becomes a **failure item**: `kind='delivery.failed'`, addressed to the original
  `from_machine` recorded on the row (never re-resolved through `sessions.machine_id`, which can be
  stale and does not cover unregistered senders such as subagents), carrying *structured* fields
  only: original `msg_id`, original `from` and `to`, reason code, machine. Reasons:
  `never_collected` (expired while queued; safe to resend), `unconfirmed` (expired while leased),
  or the receiver's refusal code. Failure items live in the same `swarm_relay` table (keyed
  `(from_machine, 'f:' || msg_id)`, `to_machine` = the original `from_machine`), so they get the
  same hand-out, lease and ack.
- **Failure items are never answered.** One that itself expires or is refused is logged and
  dropped. This is the worker-side loop guard.
- **Failure items are receipts, not prose.** The sending daemon accepts one only if its original
  `msg_id` names a row it relayed (`verify_family='relayed'`) from that same `from` to that same
  `to`; otherwise it drops and logs it. It then mints the local `delivery.failed` row itself
  through `notifySenderOfFailure`, with wording rendered from the reason code. So a key holder
  cannot inject free text into a session by posing as a failure notice.
- **Schema.** `CREATE TABLE IF NOT EXISTS` for `swarm_relay` and `machine_relay_accept`. The
  routes tolerate the tables being missing (the `named_topic_bindings` pattern) and answers 503, so a deploy that precedes the schema
  apply degrades to "relay unavailable", never to failing every poll.

### §3.3 Receiving daemon

- **Opt-in per machine, off by default.** `PIGEON_SWARM_RELAY_ACCEPT_FROM=<machine,…>` (empty →
  the header is not sent and nothing is relayed here). The daemon also rejects, on receipt, any
  item whose `from_machine` is not in its list — defence in depth, since the worker could be
  wrong or old.
- **Re-validate.** Items arrive by a second entry point that bypasses `/swarm/send`'s validator
  (`app.ts:141-246`); run the same validation (which rejects `from='pigeon'`), plus the hop rule
  (§3.1). Failure items take the receipt path in §3.2 instead.
- **Order within a poll.** Insert and ack every relay item *before* dispatching a command from the
  same response: `tick()` is serialised behind `polling`, and a launch can block 20s or more, which
  would let items outlive their 60s lease and be handed out again.
- **Pull sessions need a separate opt-in for remote senders.** `pull_sources: ["swarm"]` was a
  local-trust decision (eng-agent-platform `2026-10-06-lane-swarm-design.md:19`); remote senders
  require `"swarm-remote"`. Without it the item is refused → `delivery.failed` back.
- **Insert** with the original `msg_id`, `from`, `kind`, `priority`, `reply_to`, `payload`,
  `deliver_at`, `expires_at`, `ref`, and record `from_machine` / `from_label`. On `ON CONFLICT`,
  compare `from` and the payload hash with the existing row; a mismatch is refused
  (`msg_id_conflict`).
- **Any `refused` result from `bankOrInsertSwarmMessage`** (413 payload too large, 409 scheduled
  to a pull session) is acked as `refused` with its reason, which the worker turns into
  `delivery.failed` for the sender.
- **Late failures go back through the worker, not as a swarm row.** A relayed row that is inserted
  and then fails on this machine (retries exhausted, expired, watchdog confirmed-gone) must not run
  the ordinary `notifySenderOfFailure` insert: that would create a `from='pigeon'` row to a remote
  target, which the relay route refuses. Instead the daemon calls `POST /swarm/relay/fail`
  `{from_machine, msg_id, reason}`, and the worker mints the failure item exactly as for a refusal
  (§3.2). Retried with the outbox's backoff; an item the worker no longer has is a no-op.
- **No `markAllRead`.** Relay items never go through `Poller.dispatch`'s inbound hook.
- **Envelope.** Render `from_machine` as an envelope attribute; the Telegram notice uses
  `from_label` because the receiver has no row for a remote sender.

### §3.4 Discovery

`swarm_list` lists local sessions. Add `remote: true`, served by a daemon route that proxies a new
worker route listing sessions on *other* machines with `updated_at` in the last 7 days (D1 holds
~820 rows, many stale). Only main sessions are registered with the worker, which is the right set.

## §4. goose

| | today, same machine | with Phase 2 |
|---|---|---|
| goose-pull receive | works when opted in (`pull_sources: ["swarm"]`) | cross-machine only with the separate `"swarm-remote"` opt-in (§3.3) |
| goose-pull send | works via the lane wrapper | relays like any other sender |
| goose-acp receive | **does not work**: `gse_` fails `^ses_` (`app.ts:210`); the arbiter only knows `prompt_async` | unchanged by the relay; needs its own track (below), after which cross-machine follows from §3.3 |
| goose-acp send | not offered: SDD §5 "inbound yes, outbound no", narrowed by §13.6 to "neither, until a sender has an identity" | superseded: see §4.1 (the lane sends since 2026-10-06; eng-agent-platform #152 proposes a goose MCP `swarm_send`) |

The goose-acp receive track is independent of the relay, roughly the same size, and starts with a
spike: accepting `gse_` targets; a delivery path through `GooseSessionRunner` instead of
`prompt_async`, including what happens when a turn is already running; and an explicit per-session
opt-in, because goose-acp's trust model is built on Telegram sender ids, which a swarm message does
not have. The spike's output is §4.1.

### §4.1 goose sessions as swarm targets: pigeon's side of eng-agent-platform #152 (PROPOSED)

*Spike output for `pigeon-k0qn.12`, 2026-10-20. Nothing here is built. It is proposed pending
eng-agent-platform's agreement on the pigeon-side specifics below, especially the slice 2 admission
policy.*

**Where policy stands.** The §4 table quotes SDD 555 §5 and §13.6
(`eng-agent-platform/docs/plans/2026-08-23-555-goose-pigeon-integration-sdd.md`): "neither, until a
sender has an identity". That position has been superseded:

- **Superseded for the lane on 2026-10-06** (`2026-10-06-lane-swarm-design.md` §1). Jonathan
  decided the lane sends and receives swarm, and accepted that pigeon has one shared token and does
  not check `from`. Pigeon built the receiving half as `pull_sources: ["swarm"]` banking.
- **General capability, 2026-10-20.** eng-agent-platform's research doc
  `docs/research/2026-10-20-opencode-goose-pigeon-messaging.md` (#152, bead
  `eng-agent-platform-skai`) treats messaging as a general capability. It recommends:
  - `gse_` as the canonical address;
  - **slice 1**, a pull mailbox with no push, plus a goose MCP server offering `swarm_send`,
    `swarm_read` and `swarm_list`;
  - **slice 2**, push into goose-acp sessions;
  - **slice 3**, schedule, skills, and widening the lane's checks.

  It is explicitly *not* for stall-watch: worker replies must not wake coordinators.

This section does not reopen that policy. It adopts #152's slicing and specifies what pigeon builds
in each slice, including the defects a pigeon-side review found in a naive slice 2.

**What pigeon can and cannot offer on identity.** Nothing in this section authenticates a sender:

- **`from` is self-asserted.** The daemon checks one shared token (`auth.ts`). `from` need only be
  non-empty and not `pigeon` (`app.ts:197,207`).
- **The plugin fills in `from` honestly, but only for its own tool calls.** It sets it from
  `ctx.sessionID` (`swarm-send-tool.ts`), so the model cannot forge it there. Any process holding
  the token can still forge it.
- **A per-session capability token would not help** while issuing that token is gated by the same
  readable shared token.
- **The owner-only gate guards intent, not identity.** `goose/adapter.ts:81-105` keeps Telegram
  strangers out. Any `dev` process can already prompt a goose-acp session directly through honkd,
  with no envelope at all; stall-watch does (eng-agent-platform
  `stallwatch/honk_transport.py`). Swarm therefore adds no new
  hostile-process capability. What it adds is volume and influence from *well-meaning agents*,
  which is what the mitigations below bound.

**Slice 1: pull mailbox for goose-acp targets.** Pigeon changes:

1. **Accept `^gse_` as `to`** in `/swarm/send` (`app.ts:210`).
   - A `gse_` id with a local `goose-acp` row is banked through `bankOrInsertSwarmMessage` into
     `pull_inbox`, exactly as for an opted-in goose-pull session. That means `source: "swarm"`, the
     4000-code-point cap, and a `banked: true` response. The arbiter, watchdog and runner do not
     change, so nothing pushes and nothing can be falsely failed.
   - A `gse_` id with no local row keeps Phase 1's behaviour: an immediate remote failure.
2. **Refuse `/swarm/schedule` to `gse_`** with the existing pull 409. A wake that wakes nothing is
   worse than no wake.
3. **Let a goose-acp session drain its own mailbox.**
   - `/pull/drain`, `/pull/ack` and `/pull/pending` gain `goose-acp` as an allowed backend. Today
     they serve pull sessions.
   - The Telegram-reply rows that a bound goose-acp session already receives through honkd are
     *not* moved into this mailbox. Only swarm rows bank.
   - **Banking is opt-in, set by the reader.** A goose-acp mailbox banks only after something that
     will drain it says so. The natural place is the goose MCP server, on first start: it sends
     `pull_sources: ["swarm"]` on `POST /goose/sessions`, reset when absent, as for goose-pull.
     Without the opt-in, a `gse_` target gets an immediate refusal
     (`409 goose-acp session ses… has no swarm mailbox`), not a 202.
   - **Why not default-on.** Today's honk chat and `/launch --backend goose` sessions have no
     reader. Default-on would answer `202 banked:true` and then stay silent for the 7-day expiry.
     That is worse than today's immediate 400, and it is the failure pigeon's pull design already
     avoided ("non-opted-in pull sessions fail loudly").
4. **`delivery.failed` reaches `gse_` senders.** `notifySenderOfFailure` sends only to `ses_`
   senders today (`swarm/notify-sender.ts:140`). It is widened to bank the notice in a local `gse_`
   sender's mailbox through the same helper. Without this, a goose sender never learns that a
   message failed.
5. **`GET /sessions` stays the discovery surface** for the goose MCP `swarm_list`. It already
   returns `backend_kind` and `backend_session_id`. No change.

The goose MCP server, its `AGENT_SESSION_ID` → `gse_` resolution, and the per-session-vs-per-agent
extension-process hazard #152 names all belong to eng-agent-platform/honk, not pigeon.

**Slice 2: push into goose-acp sessions.** The four parts ship together (#152). A naive version
fails in specific ways, so these are requirements, not options:

1. **Arbiter branch, honkd sessions only.**
   - **Path.** For a `goose-acp` target, the arbiter calls `GooseSessionRunner.deliver` with
     `commandId = "sw:" + msgId`, never `prompt_async`.
   - **Why honkd only.** On a bare goose (non-honk) runner, the busy path *steers* into the foreign
     run (`session-runner.ts:1271-1290`), and nothing signals when that run ends.
   - **Non-honkd targets.** They stay slice 1 (banked).
2. **Queue-only, on every path.** A swarm item is never steered into a running turn. Steering would
   give a peer's text the weight of a human interjection. This covers:
   - the `deliver` steer branch (`:708-749`);
   - the bare-goose busy steer, which item 1 already excludes.
3. **The human never gets runner notices about a swarm item.**
   - **Which notices.** These posts all address the human about a message the human did not send:
     - "Queued" (`:789`) and its busy twin;
     - busy-recovered (`:1202`);
     - recovery-unsupported (`:563`);
     - unknown-request (`:1173`);
     - the 24h-stale notice (`recover-inflight.ts:83`).
   - **Where they go instead.** The inflight row records swarm origin. Every terminal path for such a
     row goes to `markFailed` and `notifySenderOfFailure`, so the *sender* learns the fate.
   - **What the human sees.** The human's view of what a peer made their session do is the
     `w:<msgId>` notice. It carries the full payload labelled with the sender
     (`telegram-notice.ts:47-60`). The turn hook's skip of enveloped prompts (`app.ts:1787-1791`)
     therefore loses nothing.
4. **Handed off at enqueue; verified at turn start, by in-process callback.**
   - **Arbiter.** The arbiter marks the row handed off with family `receipt` when the runner accepts
     it (`verify-family.ts` already maps `goose-acp`). Its job ends there, so it never re-picks a
     queued item and never spends attempts on `already-queued`.
   - **Pending check.** `isReceiptPending(msgId)` is true while a `goose_inflight` row for
     `sw:<msgId>` exists. That row is persisted, so the check survives a restart.
     `isReceiptPending` is not wired today (`delivery-watchdog.ts:545` defaults it to false). With
     it wired, a message queued behind a long turn is never failed by the 10-minute receipt grace
     (`DEFAULT_RECEIPT_GRACE_MS`).
   - **Verification.** When the runner starts the `sw:<msgId>` turn, its in-process callback calls
     `markVerified`, guarded on `to_session` and `state = 'handed_off'`. The row is therefore
     verified before its inflight row retires.
   - **Not `/goose/turn-event`.** Any token holder can post `client_req_ids: ["sw:<any msgId>"]`
     there, which is the forgery primitive SDD §13.2 describes. If the hook is ever used to
     corroborate, it must match `msg_id`, `to_session`, `state = 'handed_off'` and an existing
     inflight row for that session. Even then it can only suppress, never forge.
5. **Idempotent on `msg_id`.** With item 4, the only window is a crash between the runner's
   inflight insert and the arbiter's `markHandedOff`. On redelivery, the arbiter first checks for a
   `goose_inflight` row for `sw:<msgId>` or an outbox `s:<sid>:sw:<msgId>`, as the turn hook's
   own-turn check already does. It treats either as already handed off.
6. **The envelope is the first character, and the adapter is skipped deliberately.**
   - **The envelope invariant.** The pushed text is always the `<swarm_message …>` envelope
     (`swarm/envelope.ts`). Its first character is `<`, so `goose/builtin-commands.ts` can never run
     it as `/clear`, a recipe, or "Please compact this conversation". A test pins this.
   - **The adapter bypass.** The arbiter path does not go through `GooseAcpAdapter`. That is
     intended: the owner gate, the reply-context prefix and the pinned-session command refusal are
     all Telegram-shaped. Bypassing the adapter is what puts the envelope first.
   - **Data rule.** The envelope states that `from` is unauthenticated. The two-way lane design's
     §6.2 rule applies: a peer's text cannot widen the session's authority.
7. **Admission: the second question for eng-agent-platform.**
   - **#152's position.** Default-accept with a per-session opt-out (for example `/swarm off` in the
     topic), consistent with Jonathan's 2026-10-06 dial.
   - **Pigeon's alternative.** Opt-in on `POST /goose/sessions` (`swarm_push: true`, reset when
     absent, as `pull_sources` is). That makes the exposure a property the registering client chose
     rather than one the human must remember to remove.
   - **Pigeon can build either.** The choice is policy.
   - **Unattended sessions stay pull-only regardless.** That includes the lane (#152 Hazards).
8. **A per-pair rate cap** (N per sender→target per hour). It bounds the cost of an ack loop between
   agents that do not load the opencode message-economy skill (#152 Hazards). It applies to banked
   rows too.

**Same machine only.** Cross-machine delivery to any goose session comes only through Phase 2 §3.3
and its separate `"swarm-remote"` opt-in, after the Phase 2 decision (`pigeon-k0qn.4`).

**If eng-agent-platform declines push entirely**, slice 1 stands alone. If it declines slice 1 as
well, pigeon replaces today's misleading `400 to must be a session id starting with 'ses_'` for a
`gse_` target with an explicit refusal naming the policy. The plugin treats any non-5xx/429 as
permanent, so the status change is safe.

**Size.**
- **Slice 1, pigeon side:** small, about one PR (route, bank helper, pull-route backend check,
  notify-sender widening, tests).
- **Slice 2:** medium, one PR (arbiter branch, runner queue-only mode and swarm-origin routing,
  receipt callback and persisted pending check, idempotency check, admission flag, rate cap).
- **Filing beads:** under `pigeon-k0qn.13`, once eng-agent-platform agrees.

**What pigeon needs back from eng-agent-platform:**
- that the goose MCP server will opt its session's mailbox in (slice 1, item 3), and settle the
  extension-process hazard #152 names, before pigeon builds slice 1;
- push admission: default-accept with opt-out, or opt-in (slice 2, item 7);
- confirmation that the slice 2 requirements above match its intent.

**As built (slice 1).** Implemented per `docs/plans/2026-10-20-goose-swarm-slice1-plan.md` with these deviations:
- Opt-in uses a dedicated create-if-absent route (`POST /goose/swarm-mailbox`), called lazily by the MCP server, rather than `pull_sources` on `POST /goose/sessions` with reset-when-absent.
- `notify: false` goose-acp rows are completely Telegram-silent (turn-event mirror/stop and bank `w:` notice suppressed for goose-acp rows only).
- `GET /sessions` exposes `pull_sources` so `swarm_list` can detect mailbox availability without attempting sends.
- `gse_` targets with no local row are refused synchronously (409) rather than accepted and failed later by the arbiter.
- Outbox sender drops entries for `notify: false` goose-acp rows terminally with reason `notify_false_goose` as defence in depth.
- Opencode plugin renders `banked: true` as "waiting in <to>'s mailbox; it is read when that session calls swarm_read" instead of "Delivery is async".

## §5. Rejected alternatives

- **Reuse `execute`.** `command-ingest` lets a pending question capture plain text as its answer
  (`worker/command-ingest.ts:289-324`), and `execute` bypasses the arbiter, envelope and watchdog.
- **A `swarm` command type in `commands`.** See §3, "Why a separate table".
- **Relay from the `/swarm/send` route.** A second retry loop and clock, and a blocking route.
- **Daemon-to-daemon HTTP over SSH/Tailscale.** No link between all pairs; new exposure.

## §6. Auth

Today: each daemon trusts any local caller with its bearer token and does not verify `from`; the
worker trusts any holder of the single `CCR_API_KEY` and takes `machineId` from the URL.

Phase 2 makes `from_machine` matter, and with one shared key it is self-asserted: the receiving
allowlist (§3.3) is advisory until each machine has its own worker credential, so that the worker
— not the caller — establishes `from_machine`. **Per-machine credentials gate enabling *receive*
on any machine**, unless the Phase 2 decision explicitly waives them for named machines. Default
allowlists should not pair devbox with the work machines.

**Built (pigeon-k0qn.8):** per-machine keys hashed in D1 `machine_credentials`, enforcement on
poll/ack/register/unregister, `GET /whoami`, and shared-key retirement via
`SHARED_KEY_REFUSED_MACHINES`. Design `docs/plans/2026-10-21-per-machine-credentials.md`,
runbook `docs/runbooks/per-machine-credentials.md`. **The gate on receive is retirement, not
rotation:** until machine M is in `SHARED_KEY_REFUSED_MACHINES`, a shared-key holder can still
re-register M's sessions to itself, so receive on M requires M to be retired.

## §7. Known limits (accepted)

- Latency: one poll interval (≤5s) plus round trips; up to 60s after a receiver crash.
- Ordering across machines is best-effort.
- `reply_to` is carried verbatim, but each side's `swarm_read` shows only its own half of a thread.

- A session idle for more than 7 days is unregistered from D1 by its daemon's reaper, so remote
  sends to it fail with `unknown_session` while local sends still work.
- A sleeping Mac answers `target_offline`: ordinary sends fail when their attempts run out,
  scheduled sends retry until they expire.
- Fixed pull-lane ids (`ses_lane_maven_renovate`, `ses_stallwatch_*`) follow the last machine that
  registered them; if a lane ever runs on two machines, relays go to whichever registered last.
- Channels/broadcast are not delivered even locally (`pigeon-web`) and are not relayed.

## §8. Deployment order

Phase 1: worker owner route and daemon changes in any order (the daemon degrades without the
route).

Phase 2:
1. Apply `swarm_relay` DDL to D1, then deploy the worker.
2. Deploy receiving daemons; they receive nothing until `PIGEON_SWARM_RELAY_ACCEPT_FROM` is set.
3. Deploy sending daemons; they relay nothing until `PIGEON_SWARM_RELAY_SEND=1`.
4. Enable pairwise after the end-to-end check, receive side first.

## Tracking

Epic `pigeon-k0qn` in beads. `bd ready --parent=pigeon-k0qn` is the only answer to "what next"; the
epic's design field is the runbook. Children cite this document by section.
