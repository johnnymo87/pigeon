# Swarm quiet messages (held class) — design

## Problem

Every swarm message is push-delivered to the target session via `prompt_async`
(`packages/daemon/src/swarm/arbiter.ts:212`). Message velocity between agent
sessions is high enough that receivers are continually pulled off their tracked
work and down whatever the last speaker happened to mention.

Note the mechanism precisely, because it constrains the fix. Prompting a **busy**
session writes the payload into its transcript and silently discards the run
(pigeon-usbg, documented at `packages/daemon/src/swarm/delivery-policy.ts:92-97`).
So a swarm message does not interrupt mid-turn. It takes effect when the receiver
is **idle** — the agent finishes a turn and is immediately handed a new one. That
is the derailment. "Defer push until the target is idle" therefore buys nothing:
idle is already when it fires.

The fix has to reduce how many swarm turns get started at all, not reschedule them.

## Constraint that dominates the design

This subsystem's engineering history is a series of fixes for silent drops
(pigeon-s9d, pigeon-fww, the delivery watchdog, the nudge mechanism). Five loops
assume `state = 'queued'` is transient:

| Loop | File | Breaks if `queued` can be permanent |
|---|---|---|
| `listOverdueQueued` | `swarm-repo.ts:~333` | fires a false `error` page: "delivery loop stopped or wedged" |
| `listExpired` / `sweepExpired` | `swarm-repo.ts:~242`, `arbiter.ts:142` | destroys the row on a 6h fuse + Telegram alert |
| `listTargetsWithReady` | `swarm-repo.ts:~149` | n/a (would push it) |
| `cleanupOlderThan` | `swarm-repo.ts:~523` | never deletes `queued` → immortal rows |
| `getInbox` | `swarm-repo.ts:463` | see below |

And the blocker for the naive version: `getInbox` selects on
`(state = 'handed_off' OR handed_off_at IS NOT NULL)` — deliberately, meaning
*"this payload provably reached your transcript."* A message that is never pushed
is never handed off, so **`swarm_read` cannot see it**. "Sits in the inbox" is not
a state the current inbox can represent.

Therefore: a quiet class must be a **new state with its own terminal clock**, not
a suppressed `queued`, and it must degrade to *delayed delivery*, never to a drop.

## Requirements

- A message may be sent quiet: it lands in the receiver's inbox without starting a turn.
- Quiet is the default **for agent-to-agent sends**. It is not the default for
  humans or for pigeon's own machinery.
- No message can be silently lost. Every quiet message has a bounded clock after
  which it is delivered the normal, loud way.
- `swarm_read` must be able to see quiet mail, and callers must still be able to
  tell "reached your transcript" from "did not".
- The existing watchdog / expiry / retry / nudge loops keep working unmodified.

## Design

### 1. `notify` column, fail-loud default

```sql
ALTER TABLE swarm_messages ADD COLUMN notify INTEGER NOT NULL DEFAULT 1
```

SQL default is **1**, so any insert that forgets the field stays loud, and
existing rows need no backfill. The default-quiet decision lives at the callers,
explicitly — never in the storage layer.

`SwarmRepo.insert` additionally forces `notify = 1` when `kind` starts with
`swarm.` or equals `delivery.failed`. Those are pigeon's own safety messages
(`notify-sender.ts:8`, `delivery-policy.ts:102`) and a quiet one is a
contradiction: the nudge's entire semantic is *"you have unread mail."* The
`swarm.` namespace is rejected at ingress (`app.ts:123`), so it is trustworthy
as an internal marker.

### 2. Where the default flips: the plugin tool, not the wire

| Caller | `notify` default | Rationale |
|---|---|---|
| `swarm_send` plugin tool | **false** | agent-to-agent chatter — the actual problem |
| `swarm_schedule` plugin tool | **true** | a wake is by definition an interrupt |
| `POST /swarm/send` (wire) | **true** | keeps `pigeon-send` / `opencode-send` loud |
| internal minting sites | **true** (forced) | see §1 |

Keeping the wire default loud means **no cross-repo change** to the workstation
CLIs and no deploy-skew window where a human's "stop, wrong approach" silently
no-ops. The blast radius is exactly the population we want quieter.

### 3. `held` state, not suppressed `queued`

Quiet rows are inserted with `state = 'held'`. Every existing query filters
`state = 'queued'`, so all five loops above skip held rows **with no edits** —
no false watchdog pages, no 6h expiry fuse, no ready-queue wedging.

State machine:

```
held ──escalate_at reached──> queued ──> handed_off ──> (verified)
  └──swarm_read──> read (terminal)
  └──cancel──────> cancelled (terminal)
```

### 4. Escalation is the terminal clock (this is the crux)

New column `escalate_at INTEGER`. It is **NOT NULL for every `held` row** —
enforced at the insert site, since SQLite cannot express a conditional NOT NULL
cheaply.

A sweep in the arbiter (alongside `sweepExpired`) promotes due held rows:

```
UPDATE swarm_messages
SET state='queued', escalate_at=NULL, updated_at=?, expires_at=?
WHERE state='held' AND escalate_at <= ?
```

After promotion the row is an ordinary queued message and inherits the entire
existing delivery, retry, expiry, watchdog and nudge apparatus. This is the
single change that makes the feature defensible: unread quiet mail becomes
**late** mail, never lost mail.

Default `escalate_after` = 6h, overridable per message.

Deliberately: a held row carries `expires_at = NULL`. `parseScheduleTime`
otherwise defaults it to `deliver_at + 6h`, which would expire quiet scheduled
mail out from under the receiver and page about it. `expires_at` is set **at
promotion**, not at insert.

For a quiet *scheduled* message, `deliver_at` is when it becomes visible in the
inbox, and `escalate_at = deliver_at + escalate_after`.

### 5. Inbox widening, with an honest `delivered` flag

`getInbox` predicate becomes:

```
to_session = ?
AND ( state = 'handed_off' OR handed_off_at IS NOT NULL
      OR state IN ('held','read') )
```

The response gains an explicit per-message `delivered: boolean`
(`handed_off_at !== null`). This preserves the one property the old predicate
guaranteed — operators and the jq delivery-check in the `swarm-messaging` skill
can still separate "in the target's transcript" from "not". The doc comment at
`swarm-repo.ts:430-438` must be rewritten; it currently asserts the narrow
invariant.

### 6. Reading

New column `read_at INTEGER`. `swarm_read` marks the held rows it **returned**
as `state='read', read_at=?`, which cancels their escalation.

Paging caveat, called out because it is a real failure mode: `swarm_read`
returns a window (default 10). Marking only the returned window read means a
50-message inbox drops to 40, and an agent may stop there. The tool description
must instruct draining forward with `since` until `hasMore` is false. Rows not
returned keep their `escalate_at`, so the un-drained remainder still escalates
rather than rotting.

`cleanupOlderThan` gains `'read'` to its terminal-state list. `held` is never
deleted — it always has a live `escalate_at`.

### 7. Discovery — supplement, never the guarantee

`GET /swarm/unread?session=` → `{ count }`, counting
`state='held' AND (deliver_at IS NULL OR deliver_at <= now)`.

The plugin registers a `chat.message` hook that, on an incoming user message,
appends a synthetic text part noting N unread swarm messages. This piggybacks on
a turn the session was already going to run, so it costs zero extra interrupts,
and it fires for TUI-typed, Telegram-relayed and `prompt_async` prompts alike.

It is explicitly **not** the delivery guarantee — escalation (§4) is. The hook's
trigger is anti-correlated with need: a head-down session receives no user
messages for hours, and a headless `/launch` worker receives exactly one, ever.
That is acceptable only because escalation backstops it.

Hard requirements on the hook, from the runtime's shape:

- **Never reject.** `Plugin.trigger` wraps hooks in `Effect.promise`, where a
  rejection is a *defect*, not a typed failure — contrast the `config` hook,
  which uses `tryPromise(...).pipe(tapError, ignore)`. An unhandled throw
  plausibly kills the `SessionPrompt` fiber, i.e. the user's message fails.
  Wrap everything in try/catch.
- **`AbortSignal.timeout(250)`, fail open.** Hooks are awaited sequentially on
  the critical path of every message. A *down* daemon is benign (refused
  connect); a *wedged* one hangs the prompt.
- **`output.parts.push(...)` only.** Reassigning `output.parts` is a no-op; the
  call site re-reads its own binding.
- **Fully-formed part.** Parts are normalised *before* the trigger, so a part
  pushed inside the hook skips normalisation. Supply
  `{ id, messageID, sessionID, type: "text", synthetic: true, text }`.
- **Skip subagents** (cf. `opencode-beads`' `shouldInject`), whose unread count
  is structurally 0.
- Short-TTL plugin-side cache.

Spike first: `opencode-beads` faced this exact need and chose *not* to mutate
parts, injecting a separate `noReply` prompt instead. Understand why before
committing to part mutation.

### 8. `priority` vs `notify`

`priority` becomes **ordering only**. `notify` is the sole push-or-hold control.
The `swarm-messaging` skill currently documents `low` as "chatter the receiver
can pull on demand" — that was never true (low priority still pushes) and must
be corrected in the same change.

## Alternatives considered

- **Sender-side `notify` on a suppressed `queued` row** (the original proposal).
  Rejected: `swarm_read` cannot see it (§ blocker), and it turns the five loops
  above into false alarms, immortal rows and a 6h destruction fuse.
- **Push-on-idle.** Rejected: idle is already when the interrupt happens
  (pigeon-usbg), so it changes nothing.
- **Coalescing N ready rows into one envelope.** Not rejected — genuinely
  attacks velocity and preserves every invariant. Deferred to a follow-up; it
  composes well with escalation (escalate a batch, deliver one turn).
- **Sender-side discipline only** (tighten the skill's message economy). Already
  tried; velocity is still too high.

## Risks

| Risk | Mitigation |
|---|---|
| Quiet mail never read → coordination deadlock | escalation (§4) converts it to delayed push |
| `chat.message` hook kills user prompts | try/catch + timeout + never reject (§7) |
| Agents reflexively set `notify: true` | tool description frames it as an interrupt cost; revisit with metrics |
| Docs disagree with behaviour across machines | daemon and workstation skills deploy from different repos — sequence the skill edits with the daemon rollout |
| Inbox consumers break on widened predicate | explicit `delivered` flag preserves the distinction |
| Held rows leak if `escalate_at` is ever NULL | enforce at insert; add a repo test asserting no `held` row has NULL `escalate_at` |

## Success criteria

- Swarm-initiated turns per receiver session per hour drops materially.
- Zero messages reach a terminal state without either being read or being
  delivered loudly.
- No new watchdog alerts attributable to held rows.
- `swarm_read` returns quiet mail, and `delivered` correctly separates the two
  populations.

## Out of scope / follow-ups

- Coalescing multiple ready rows into one envelope.
- Receiver-side mute policy (`swarm_sessions`-level opt-out).
- Channel messages (`to_session IS NULL`) already sit queued forever —
  pre-existing hole, untouched here.
