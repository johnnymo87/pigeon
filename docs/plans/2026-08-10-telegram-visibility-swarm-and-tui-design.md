# Telegram visibility: swarm messages and TUI-typed prompts — design

## Problem

A Telegram forum topic is supposed to be the human-readable record of a session.
Today it is missing two of the three inputs that drive a session:

1. **Swarm messages.** Cross-session IPC (`packages/daemon/src/swarm/arbiter.ts`)
   injects prompts straight into a target session's transcript. Telegram never
   sees them, so a topic shows a session suddenly working with no visible cause.
2. **Prompts typed in the TUI.** The plugin drops user message text
   (`packages/opencode-plugin/src/message-tail.ts:55`). A topic therefore shows
   the agent's stop notifications with no visible question — one-sided.

The result is a topic that reads as a monologue punctuated by unexplained work.

## Volume baseline

Measured from the production daemon DB, 7 days to 2026-08-10:

| Metric | Value |
|---|---|
| Swarm messages | 2,609 / 7d (~373/day) |
| Busiest hour | 133 messages → 170 Telegram chunks |
| Busiest minute | 12 chunks — **100% of the outbox governor's window budget** |
| Mean payload | 2,840 chars; max 16.7K; 28% span ≥2 chunks |
| Cancelled rows | 159 / 2,614 (6%) |
| Distinct targets | 185, of which 12 had no local session row |
| Existing outbox volume for comparison | ~40 stop/question rows / week |

This feature multiplies outbox volume roughly **65×**. Aggregate throughput fits
(170 chunks/hr against a 720/hr budget), so this is not a DoS — but bursts
saturate the window, and that drives the governor design below.

Full unfiltered payloads are an explicit decision, made with these numbers in
hand.

## Requirements

- Delivered to Telegram, threaded into the **receiver's** topic, so cause sits
  immediately above effect.
- Full payload, split at Telegram's 4096-char limit (existing splitter).
- No filtering by kind, priority, or sender. Everything shows.
- Zero regression risk to swarm IPC itself: a Telegram problem must never fail
  or delay a swarm delivery.
- A live question must never queue behind swarm chatter.
- No echo: a prompt that originated in Telegram must not be mirrored back.
- No kill-switch flag (explicit decision — disabling is a code change).

## Phase 1 — swarm messages in Telegram

### Hook point: insert, not handoff

The obvious hook is arbiter success (`arbiter.ts:213`, `markHandedOff`). Rejected.

`docs/plans/2026-08-09-swarm-quiet-messages-design.md` (on hold, not implemented)
would make agent-to-agent sends quiet by default: a new `held` state that never
reaches `handed_off` unless escalated after 6h or read. Under that design a
handoff-hooked feed goes near-empty for exactly the chatter this feature exists
to surface. Hooking insert is invariant to that change — held rows are still
inserts.

Insert-time also covers messages that later fail, which handoff-time cannot.

The cost is honesty about semantics: the post means **sent**, not **reached the
transcript**. Wording reflects that, and retractions are posted explicitly (see
"Cancellation" below).

### Flow

```
POST /swarm/send              (app.ts:270)
POST /swarm/schedule          (app.ts:294)
notifySenderOfFailure         (swarm/notify-sender.ts:90)
delivery-watchdog nudge       (swarm/delivery-watchdog.ts:1443)
        │
        └─► enqueueSwarmTelegramNotice(storage, row)   [try/catch, best-effort]
                 └─► storage.outbox.upsert  kind="swarm", sessionId = row.to_session
                          └─► OutboxSender → POST /notifications/send
                                   └─► worker resolveTopic(to_session) → receiver thread

POST /swarm/cancel            (app.ts:439) ─► enqueueSwarmCancelNotice(...)
```

Explicit call sites rather than a hook inside `SwarmRepository.insert`. The repo
stays a dumb accessor, and the set of things that post to Telegram is greppable.
All four insert sites are hooked — the watchdog's `swarm.nudge` rows included,
since the requirement is "everything shows".

Enqueue only when `insert` actually inserted. `/swarm/send` currently ignores
the return value (`app.ts:277`); a duplicate caller-supplied `msg_id` would
otherwise re-enqueue `w:<msg_id>`, and if the earlier post had terminally
failed, the outbox's failed→queued reset (`outbox-repo.ts:81`) would re-post it.

### Notification shape

- `notificationId`: `w:<msg_id>`. Idempotent; the outbox upsert no-ops unless the
  row is `failed` (`outbox-repo.ts:72-81`) and the worker dedupes by
  `notification_id` (`notifications.ts:212-223`). Chunks derive ids via
  `chunkNotificationId` (`outbox-sender.ts:113`).
- Header: `📨 swarm · <kind> · <priority>` then `from <sender display name>`,
  then the message's **event time** (`created_at`). The event time is not
  decoration: within-session ordering lets a conversational row preempt a
  backlogged swarm post (see "Scheduling fairness"), so a post can arrive below
  the stop it caused. Always printing the event time makes that legible rather
  than misleading — no overtake detection needed.
  Rows with a future `deliver_at` add `⏰ scheduled <time>`.
- Body: full payload, unmodified.
- Footer: `🆔 <to_session>`, `msg_id`, and the standard swipe-reply hint.
- `title` / `dir`: read from the local `sessions` row for the **target**, same
  as stop notifications (`app.ts:876`). Topic resolution and naming are then
  byte-identical to the existing path.
- `threaded: true`. No `replyMarkup` and no reply token — swipe-reply still
  works because the worker inserts a `messages` row binding `message_id →
  session_id` (`notifications.ts:356`).

Sender display name: `displayName()` (`notification-service.ts:26`) against the
local sessions row for `from_session`; falls back to `from.slice(0,8)`.
`from = 'pigeon'` renders literally.

### Cancellation

6% of production rows are cancelled, and cancel-and-reschedule is the documented
recommended pattern for correcting a queued wake (`scheduling-wakes` skill). An
insert-time post for a later-cancelled scheduled message is a **permanent false
claim** in the receiver's topic — worse than an undelivered one, since a genuine
delivery failure at least produces a `delivery.failed` notice to the sender.

`POST /swarm/scheduled/:msgId/cancel` (`app.ts:439-441`, `markCancelled` at
`:462`) therefore gets its own hook, posting `🚫 cancelled <msg_id>` into the
same topic. Retraction is posted, not implied.

The cancellation notice needs its **own** `notificationId` — `wc:<msg_id>`.
Reusing `w:<msg_id>` would dedupe it into oblivion against the original post's
worker-side `messages` row (`notifications.ts:212-223`).

### Scheduling fairness

Two independent problems, two fixes.

**Per-row kind ordering.** `getReady` orders by *per-session best kind*
(`outbox-repo.ts:113-114`): a subquery takes `MIN(CASE kind ...)` across the
session's queued rows, so every queued row of a session that has any queued
question inherits priority 1 — **including that session's swarm rows** — and
`created_at ASC` then puts swarm rows enqueued *before* the question ahead of
it. This is the common case: a worker sprayed with status updates (41 messages
to one session in one hour, observed) then asks a question, and the question
waits behind the backlog at 12 sends/min.

Fix: add a per-row secondary sort — but a **two-tier** one, not a full ladder.

```
ORDER BY <per-session best-kind subquery, full ladder> ASC,
         <per-row tier: conversational 1, record 2> ASC,
         created_at ASC,
         rowid ASC
```

The subquery keeps the full ladder — question 1, stop 2, card 3, swarm 4,
mirror 5, `ELSE` strictly lowest (6), since the current `ELSE 4` would tie a
future kind with swarm. Session ranking never affects within-session order, and
it is what preserves cross-session question preemption.

The **per-row** CASE has only two values: `question`/`stop`/`card` → 1,
everything else → 2. This is load-bearing, and the reason is `pigeon-81p`
(commit `816f0d7`, "preserve per-session causal ordering in outbox delivery"): a
production defect where message-class priority sent a question ahead of the
earlier stop that explained it, and a human answered a question whose context had
not arrived. Within a session, order must stay `created_at` **per tier**:

- Ordering conversational kinds among themselves by class re-commits `81p`
  exactly.
- Ordering *record* kinds among themselves by class commits the same sin with new
  kinds: a `mirror` enqueued before a `swarm` row (user types "do X", coordinator
  then messages the session) would deliver after it.

Accepted consequence, arbitrated deliberately: during a burst, a swarm post can
appear **below** the stop notification it caused — the sub-budget drains a
41-message backlog over roughly ten minutes. This is in tension with the
feature's own "cause above effect" purpose, and the trade is made knowingly: the
notification rail's first duty is interactivity, and a delayed *question* is
user-blocking in a way a late record entry is not. Option B (pure `created_at`
within a session, causality always correct) was rejected because it leaves a
live question waiting 7-10 minutes behind its own session's backlog — and the
sprayed-at session is precisely the one likely to ask.

To keep the permitted inversion honest, swarm posts carry their **event time**
in the header (see below). An annotated late post is a readable record; a
silently reordered one lies.

**Burst budget.** Ordering alone is not enough: the governor is 12 sends / 60s
(`outbox-sender.ts:88`) checked per *entry*, not per chunk
(`outbox-sender.ts:239-243`), so one 16.7K payload burns five slots at once.
Worse, each `threaded` send may trigger `createForumTopic` / `reopenForumTopic`
inside the worker (`notifications.ts:245`, `topic-manager.ts:128`) — Telegram
calls the governor never counts — and any resulting 429 pauses the **entire**
outbox for up to 5 minutes (`outbox-sender.ts:349-357`).

Fix: carve out a sub-budget in `processOnce`. `swarm` + `mirror` may occupy at
most 6 of the 12 slots per window; the remainder is reserved for
question/stop/card. A swarm burst can then never saturate the window, and the
65× volume increase cannot proportionally increase 429-pause frequency.

Two implementation constraints, both verified against `processOnce`:

- **Skip, not break.** The existing governor-full branch is `break batchLoop`
  (`outbox-sender.ts:243-249`). A sub-budget-full swarm entry must `continue` —
  breaking would abandon lower-ranked but still-eligible question/stop rows in
  the same batch.
- **Check post-parse.** The global check runs *before* payload parse (`:243`),
  but chunk count (`messages.length`) only exists after (`:273-287`). The
  swarm/mirror check must therefore be duplicated post-parse:
  `swarmWindow.length + messages.length > 6 → skip`. This preserves the
  no-torn-message property — a whole entry starts or it doesn't.

Swarm sends still count toward the global `sendTimestamps`, and question/stop/
card keep the full 12 when no swarm work is queued.

### Edge cases

| Case | Behaviour |
|---|---|
| Channel broadcast (`to_session IS NULL`) | Skipped — no topic to post into. Logged. |
| Self-wake (`from == to`) | Posts into own topic. Intended. |
| Target unknown to worker | 404 → `reregister` **only if a local session row exists** (`worker/delivery-policy.ts:112-120`); otherwise a terminal drop after burning governor slots (`outbox-sender.ts:305` pushes the timestamp before the failed send). 12 of 185 targets in 7 days had no local row. Accepted. |
| Enqueue throws | Caught, logged, swarm path continues. Swarm delivery must never regress on a Telegram fault. |

## Phase 2 — mirror TUI-typed prompts

Independently shippable. Shares the outbox rail and topic routing.

### Prerequisite spike: question replies

Telegram question answers travel via `POST /question/{id}/reply`
(`opencode-plugin/src/index.ts:156-214`), **not** `prompt_async`, so they sit
outside every recorded injection path below. If opencode materialises an answer
as a user-role message, each button press and wizard step mirrors back into the
topic.

This must be verified before any Phase 2 code is written. If replies do produce
user messages, record them at the reply site too.

### Capture

The plugin already receives everything needed and throws it away:

- `message.updated` with `info.role === "user"` (`index.ts:463`), currently
  early-returned at `message-tail.ts:55`.
- `message.part.updated` (`index.ts:492`) carries the text, discarded because
  `currentMessageId` only ever tracks an assistant message (`message-tail.ts:105`).

Add a user branch that accumulates parts keyed by `messageID`, flushes after
500ms of quiescence, then `POST /mirror` on the daemon.

Skip subagent sessions (those with a `parentID`).

Exclude parts marked `synthetic: true`. Phase 2 is **not** invariant to the quiet
design: its §7 hook appends a synthetic text part to incoming user messages, and
reassembling it into the hash would mismatch on *every* injected prompt while
unread > 0 — mirroring all of them, and leaking the synthetic note into Telegram.

### Echo suppression: daemon-side store

Prompt text carries no provenance into the event stream, and four paths inject
prompts that would otherwise look TUI-typed:

| Path | Injector |
|---|---|
| Swarm envelope | `swarm/arbiter.ts:212` → `opencode-client.sendPrompt` |
| `/launch` initial prompt | `worker/launch-ingest.ts:63` → same |
| Telegram command when plugin dead | `worker/revive-and-deliver.ts:84` → same |
| Telegram command via plugin | daemon direct-channel dispatch → plugin `index.ts:84` |

Grep confirms those are the only daemon `sendPrompt` callers, so two record sites
cover all four:

1. `opencode-client.sendPrompt` (`opencode-client.ts:322`)
2. daemon direct-channel dispatch, where `ExecuteCommandEnvelope` is built

Placing this in the daemon rather than the plugin is what makes it complete: two
of the four paths never touch the plugin at all. The plugin stays dumb — it
reports "user said X" and the daemon decides whether that was really the user.

Store: `injected_prompts (session_id, text_hash, count, created_at)`, PK
`(session_id, text_hash)`, TTL 15 min, swept by the existing hourly reaper.

Two properties the naive version gets wrong:

- **Counted, not single-use.** Record increments `count`; `POST /mirror`
  decrements on a hit and deletes at zero. A plain PK row would be consumed by
  the first of two identical prompts ("continue" twice within 15 min is routine),
  and the second would echo. Same failure via arbiter retry: `prompt_async` is
  non-idempotent and a 30s timeout may mean *processed*
  (`worker/delivery-policy.ts:17`, `opencode-client.ts:47`), so a
  timeout-then-retry injects identical bytes twice.
- **Recorded before the HTTP call**, not after the response. A prompt that timed
  out but was processed fires its events ~30s before a response-time record
  would exist, and the mirror wins the race.

Hash is over exact injected bytes. If plugin-side reassembly ever drifts
(whitespace), the match fails and the prompt is mirrored — failing toward noise,
never toward suppressing a real user prompt.

### Notification shape

- New daemon route `POST /mirror`, sibling of `POST /stop` (`app.ts:760`), but
  without the quiet-policy gate, reply token, or reply markup.
- Outbox `kind: "mirror"`, lowest real priority, expiry **6h** (a stale prompt
  mirror has no value), inside the swarm+mirror sub-budget.
- `notificationId`: `m:<sessionId>:<messageId>`.
- Header `🧑 <session display name>`, body = prompt text, no footer.

## Testing

Phase 1:
- Repo, **B1 regression**: same session, two swarm rows enqueued *before* a
  question; assert `getReady` returns the question first. (A cross-session or
  question-first arrangement passes even on the buggy ordering — the test must
  be same-session and swarm-older.)
- Repo: `ELSE` kind sorts below `mirror`.
- Governor: a burst of swarm entries cannot consume more than 6 slots per window;
  a question enqueued mid-burst sends within the same window.
- Governor: a single multi-chunk payload does not exceed the sub-budget.
- Unit: `formatSwarmNotification` header/footer per kind, priority, and the
  scheduled variant.
- Unit: channel-broadcast row produces no outbox entry.
- Integration: `POST /swarm/send` → exactly one outbox row, `kind='swarm'`,
  `sessionId = to_session`, `threaded: true`.
- Integration: duplicate caller `msg_id` → no second enqueue.
- Integration: `POST /swarm/cancel` on a posted scheduled row → exactly one
  cancellation notice in the same topic.
- Integration: outbox enqueue throwing does not fail the swarm POST (202 still).

Phase 2:
- Unit: part accumulation reassembles multi-part user text; debounce flushes once;
  `synthetic: true` parts excluded.
- Integration, one per injection path: inject, assert no mirror outbox row.
- Integration: **duplicate identical command twice within TTL → zero mirrors.**
- Integration: **arbiter retry after a timeout that was actually processed →
  zero mirrors.**
- Integration: **question reply → zero mirrors** (shape depends on the spike).
- Integration: TUI-typed prompt (no suppression row) produces exactly one row.
- Integration: after count reaches zero, the same text typed in the TUI mirrors.
- Unit: subagent session produces no mirror.

## Risks

| Risk | Mitigation |
|---|---|
| Swarm burst starves questions | per-row kind sort (fixes the per-session-best-kind flaw) **plus** a 6-of-12 sub-budget; both are tested |
| Topic-creation 429 pauses the whole outbox 5 min | sub-budget bounds how often swarm traffic can provoke it; pre-existing behaviour otherwise |
| Post says "sent" but message never lands | accepted and reflected in wording; cancellation is posted explicitly; delivery failures already alert separately |
| Suppression store misses a future injection path | new injection paths must route through `opencode-client.sendPrompt`; add a test asserting no other direct `prompt_async` call sites in daemon src |
| Question replies echo | resolved by the prerequisite spike before code is written |
| Hash mismatch causes echo | fails toward noise, not silence; observable and fixable |
| Quiet-swarm design later revived | Phase 1 invariant by construction; Phase 2 handled by the synthetic-part exclusion |
| Doubled reporting of pigeon's own failure notices | `delivery.failed` posts to the topic *and* alerts to General; accepted (explicit "post all" decision) |

## Success criteria

- Reading a session's topic explains why the session did what it did, without
  attaching to the TUI.
- Zero swarm deliveries fail or slow because of Telegram.
- No question notification is delayed more than one governor window by swarm
  traffic. (Holds while queued question+stop+card ≤ 6 per window — ~40 such rows
  per week today, so the boundary is far off.)
- No prompt appears twice in a topic.
- No uncorrected scheduled-wake claim survives a cancellation.

## Out of scope

- Kill-switch config flag (explicitly declined).
- Payload truncation (explicitly declined, with volume numbers in hand).
- Mirroring TUI-attached media / file parts — text only.
- Mirroring assistant output beyond existing stop notifications.
- A dedicated cross-session swarm topic.
- Editing the Phase 1 post in place with later delivery state.
