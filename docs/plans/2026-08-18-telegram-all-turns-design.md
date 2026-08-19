# Telegram: show all of a turn's agent narration, not just the last step — design

## Problem

A Telegram forum topic shows only the text of the **final** assistant message of a
turn. Everything the agent said along the way is invisible, so a human reading the
topic misses messages that were genuinely addressed to them.

Root cause, verified rather than assumed: **opencode creates one assistant message
per step, not one per turn.** Measured over 7 days on cloudbox, main sessions only:
19,161 assistant messages against 19,140 `step-start` parts and 1,319 user
messages — roughly 14.5 assistant messages per prompt.

`MessageTail.onMessageUpdated` wipes `tail.text` and `tail.files` whenever a new
assistant message id appears (`packages/opencode-plugin/src/message-tail.ts:127-132`),
and `session.idle` sends `messageTail.getSummary()`
(`packages/opencode-plugin/src/index.ts:488`). Every earlier step's prose is
therefore discarded **inside the plugin**, before the daemon outbox or the worker
ever sees it. This is not a governor problem and not a worker problem.

A real turn from production (`ses_ff02c2555ffeMI6LjKfqIVsjga`), median-sized:

```
seg 0 (146ch)  "Approved — executing carefully. Safety first: the W5 commits go to the remote…"
seg 1 (166ch)  "W5 commits (3, not 4 — I miscounted earlier) are safe on the remote…"
seg 2 (117ch)  "PR #4258 restored to its original 5 commits, OPEN and MERGEABLE…"
seg 3 (2597ch) "Done. Both PRs are clean and separate. | PR | base | …"
```

Telegram showed seg 3 only. Segs 0-2 are the missed messages.

This design reverses one line of `docs/plans/2026-08-10-telegram-visibility-swarm-and-tui-design.md`:
its "Out of scope: mirroring assistant output beyond existing stop notifications".
That exclusion was written to avoid new outbox volume. The option chosen here adds
**no notifications at all** — only longer bodies — so the reasoning behind the
exclusion does not apply to it.

## Volume baseline

### Method warning: do not measure this from the daemon outbox

`OUTBOX_RETENTION_MS = 60 * 60 * 1000` (`packages/daemon/src/storage/schema.ts:8`).
Sent outbox rows are deleted after **one hour**; only `failed` rows persist for 7
days. A `SELECT ... WHERE created_at > now - 7d` against the daemon outbox
therefore returns roughly one hour of traffic while *looking* like a week of it,
and the surviving `failed` rows supply a 7-day-old `MIN(created_at)` that makes the
window look real.

The first draft of this design did exactly that and understated current volume by
**33×**. It was caught only because re-running the same query ten minutes later
returned a different row count *and a different session list*.

**The authoritative census is the worker's D1 `messages` table**, which holds one
row per Telegram message actually sent, keyed by `notification_id`
(`packages/worker/src/d1-schema.sql:31`). Query it with
`npx wrangler d1 execute pigeon-router --remote --command "..."`.

### Current volume (7 days to 2026-08-18, worker D1)

| Notification id prefix | Chunks / 7d |
|---|---|
| `s:` stop | 1,972 |
| `m:` mirror | 427 |
| `w:` swarm | 369 |
| `q:` question | 68 |
| `wc:` swarm retraction | 34 |
| **Total** | **2,870** (~410/day, ~17/hour) |

Stops: **1,704 notifications across 177 sessions**, 1,968 chunks — 1.15 chunks per
stop.

Governor for comparison: `OUTBOX_RATE_LIMIT = 12` sends / 60s
(`packages/daemon/src/worker/outbox-sender.ts:94`), with `SWARM_SUB_BUDGET = 6`
reserved-against for kinds `swarm` and `mirror` (`:103-104`). That is 720 sends/hour.

### Options measured

Modelled from opencode transcripts (`~/.local/share/opencode/opencode.db`, tables
`message` and `part`) for the 94 of those 177 loud sessions present on this machine.
A "turn" is approximated as the run of assistant messages between user-role
messages.

| Option | Posts / 7d | Chunks / 7d | Peak chunks/min | Fits governor? |
|---|---|---|---|---|
| **A.** every assistant text message, live | 1,973 | 2,005 | **20** | **No** — peak hour 442 chunks = 61% of the whole rail |
| **B. (chosen)** whole turn batched into the existing stop | 966 | 1,345 (**+24%**) | 7 | Yes — peak hour 86 of 720 |
| C. live, only messages ≥1,000 chars | 208 | 239 | 7 | Yes |
| E. live, coalesced per session per 5 min | 470 | 535 | 9 | Yes |

**A does not fit and is rejected on measurement, not taste:** 20 chunks in the
busiest minute against a 12/min window, in a rail where swarm traffic can already
saturate that window alone. The rejection gets stronger at the true session count
(177, not the 18 the flawed baseline suggested).

B costs only +24% because intermediate segments are small (median 128 chars) while
the final segment already dominates. The per-message overhead that makes A
expensive is exactly what B does not pay.

Model validation: the model predicts 1,089 "today" chunks for those 94 sessions
where D1 recorded 1,327. Within ~20%, so the user-message-boundary approximation of
`session.idle` is good enough for sizing. It diverges where several prompts queue
and merge into one idle (378 swarm injections in 7d create user-message boundaries
with no idle between), which makes the model predict *more, smaller* posts than
reality — i.e. it overstates post count and understates per-post size.

### Turn shape (all history, 22,923 turns, all main sessions)

- chars: median 2,679 · p90 8,668 · p99 18,708 · p99.9 40,620 · max 246,079
- segments per turn: median 3 · p90 17 · p99 63 · max 212
- chunks per turn under a 40K cap: 67% are 1 chunk, 88% ≤2, 98.25% ≤4, 0.45% >6, max 11
- media: tool-part attachments = **8 in 30 days** across 111,079 tool parts;
  standalone `file` parts = 1 in 7 days

## Chosen design — option B

Accumulate every assistant message's text across a turn and send it in the **same
single stop notification** that already fires at `session.idle`.

Notification **count** is unchanged. No new outbox kind, no ancillary-gate change,
no topic-model change. Only bodies get longer. That is what makes the experiment
cheap to revert.

### Mechanism

Confined to `packages/opencode-plugin/src/message-tail.ts` except for fix (2) below.

1. `SessionTail` gains `segments: string[]` alongside the existing `text`.
2. `onMessageUpdated`, on a new assistant message id: push the current `tail.text`
   into `segments` if it is non-empty **after stripping**, then reset `text`.
   `files` accumulate the same way instead of being reset.
3. `getSummary` returns `[...segments, text]` joined by `\n\n———\n\n`.
4. New `consume(sessionID)` returns the joined summary **and clears** segments,
   text and files. Called at the send sites.

`consume` rather than a read-only `getSummary` is load-bearing. The pre-question
flush (`index.ts:650-675`) sends mid-turn and the turn then continues; without
clearing, the next idle re-posts text the human already read. Clear-on-send makes
"sent exactly once" structural rather than a dedup rule.

### Send sites (all three consume)

| Site | File | Behaviour |
|---|---|---|
| `session.idle` | `index.ts:488` | consume → body |
| pre-question flush | `index.ts:653` | consume → body; turn continues with new message ids |
| `session.error` | `index.ts:588` | consume output **prepended** to the error body |

The error site is a change of position from the first draft, which claimed
dropping the buffer there was "no regression" because today's code drops it too.
That was wrong in degree: the *value* destroyed grows ~14× with the message count
per turn, and interrupt/error is precisely when "what was it doing" matters most.

### Cap

40K chars, enforced at **push** time, not read time, so plugin RAM is bounded
(40K × ≤100 retained sessions ≈ 4 MB). Over the cap, drop **oldest** segments and
prepend `… <n> earlier steps omitted`.

40K is p99.9: exceeded by **26 of 22,923 turns (0.11%)** in all history.

**Accepted limit, stated rather than implied:** dropping oldest-first does not
bound a giant *final* segment. History already contains a single 64-chunk stop
(246K chars). The cap bounds what this change adds; it never truncates the
conclusion, and it is not a fix for the pre-existing tail.

### Explicitly not doing

- **No filtering of short segments.** Median segment is 128 chars, and that is most
  of the missed content — filtering it would reintroduce the defect. Decided
  deliberately, not by omission.
- **No switch to C or E.** C reintroduces the loss for all sub-threshold narration.
  E buys liveness the problem statement never asked for, at the cost of a new
  outbox kind, an ancillary-gate interaction, and ~2× the posts.

## Hazards found by adversarial review, and their guards

### 1. Late `message.updated` flip-back — measured, blocking

`onMessageUpdated` treats any assistant `message.updated` whose id ≠
`currentMessageId` as a new message (`message-tail.ts:127-132`). If a late update
for a completed message A arrives after message B has started, the sequence is:
push B's partial text as a segment, flip current → A, then on B's next update push
again and flip back to B with `text = ""`.

Today that only *wipes* text — invisible loss. Under this design it becomes
**visible duplicated and torn segments** in the topic.

Measured across all history: **6,698 of 278,433 consecutive assistant message pairs
(2.41%) have the earlier message's `time_updated` later than the next message's
`time_created`**, with a worst observed lag of **37 seconds**. This is a real event
class, not a theoretical one.

**Guard:** a per-tail set of already-pushed assistant message ids, cleared at
consume. An assistant id already pushed is ignored — never flip back.

### 2. Governor overshoot on multi-chunk stops

The governor checks *before* an entry and is deliberately chunk-atomic
(`outbox-sender.ts:263-273`): at `sendTimestamps.length === 11 < 12`, an 11-chunk
stop starts anyway, producing 22 sends in the window against a Telegram supergroup
cap of ~20/min shared with uncounted producers (wizard edits, topic management). A
resulting 429 pauses the **entire** outbox for up to `MAX_PAUSE_MS`
(`outbox-sender.ts:86, 406-414`), delaying questions in every session.

That trade was priced when multi-chunk stops were rare. This design changes the
distribution: 33% of stops become >1 chunk, p99 turn ≈ 18.7K ≈ 5-6 chunks.

**Fix:** defer the entry when `sendTimestamps.length + messages.length >
OUTBOX_RATE_LIMIT`, mirroring the sub-budget's existing post-parse pattern
(`outbox-sender.ts:334-337`). Still chunk-atomic, no torn message. ~3 lines in the
daemon; the only part of this design outside the plugin.

### 3. Suppressed stop — rationale corrected

The first draft claimed a suppressed stop is safe because "same message id means
nothing new was produced". `shouldNotify` has four false branches
(`session-state.ts:236-243`), and only the last has that property:

- **same-as-last-notified** — genuinely safe. A new assistant message would have
  changed `currentMessageId`, and consume already emptied segments.
- **not registered / no entry / `currentMessageId === undefined`** — the buffer
  persists, and the next turn's stop leads with the *previous* turn's narration.
  Not duplication (it was never sent), but stale carryover.

Accepted, pinned by test, and stated here rather than claimed away.

### 4. Ordering — no pigeon-81p re-commit, but a criterion erodes

Stop and question share per-row tier 1, ordered by `created_at` within the tier
(`outbox-repo.ts:126-130`). A large stop **delays** a question; it never
**reorders** one. `pigeon-81p` was an inversion, and no inversion is reintroduced.

However, the 2026-08-10 design's success criterion — "no question delayed more than
one governor window, holds while queued question+stop+card ≤ 6 per window" — loses
its arithmetic when one p99 stop is itself ~6 chunks. Worst realistic delay for a
user-blocking question is about one window plus a tick (~65s), more if hazard 2
fires. **That criterion is hereby amended, not silently broken.**

Adjacent pre-existing wart this magnifies, recorded for later: the pre-question
flush awaits `tokenTracker.getFooter` before POSTing (`index.ts:657-660`) while the
question was enqueued first (`index.ts:640`), so the question's row usually carries
the earlier `created_at` and delivers *before* the narration explaining it. It is
81p-shaped, it exists today, and the inverted context is now a whole turn.

### 5. Confirmed sound (checked, not assumed)

- **The user-text leak vector is not widened.** Segments never pass through role
  classification. The leak path is the `roleInfo === undefined` branch
  (`message-tail.ts:194`) and its guard at `:239` is unchanged, so a late part for
  an already-pushed message is dropped, not appended. `messageRoles` eviction
  pressure is unchanged — segments live in `SessionTail`, not `messageRoles`.
- **Telegram side is untouched by longer bodies.** The worker inserts a `messages`
  row per chunk (`notifications.ts:392-399`), so swipe-reply to any chunk resolves;
  chunk retry dedupes via `#c{i}` (`outbox-sender.ts:128-135`); topic creation and
  the unpin-once behaviour key off the first send, not body length; reply markup
  stays last-chunk-only.
- **Compaction marker mid-turn** is a user-role message with no text part, so it
  does not touch the assistant tail. The turn spans it.
- **`/kill` / `session.deleted`** call `messageTail.clear` (`index.ts:556`) and
  discard the buffer without posting. Intentional.
- **Swarm or Telegram prompts arriving mid-turn** are user-role and never touch the
  assistant tail; queued prompts merge into one idle and one larger stop.

### 6. Minor, accepted

- **Separator is `\n\n———\n\n`**, not `\n———\n`, so the splitter's paragraph-boundary
  preference (`split-message.ts:246-248`) cuts at separators for free instead of
  stranding a bare rule as a chunk's last line.
- **Strip before push**, since a segment that is only a code fence strips to empty
  (`message-tail.ts:6-16`) and would otherwise contribute a stray rule.
- **Subagent tails accumulate segments that are never consumed** — idle returns
  early for non-main sessions (`index.ts:476`). Bounded by the 40K cap and existing
  eviction. Recorded so nobody rediscovers it as a leak.
- **Consume happens before a successful POST**, so a daemon-down idle loses the
  buffer. Same exposure as today, and loss-over-duplicate is this codebase's stated
  bias. Deliberate; documented by test.
- **Chunk arithmetic is a floor.** The effective body budget is
  `4096 − header − footer` (`split-message.ts:35-67`) and natural-boundary cuts land
  at the last paragraph break in the window, so real chunk counts run slightly
  above the model. The 11-chunk worst case may be 12-14. This does not change any
  conclusion, since the cap bounds chunks per entry either way.

## Open questions for implementation

1. **Does `/interrupt` surface as `session.idle`, `session.error`, or both**, in the
   deployed opencode version, and in what order? This decides whether the
   error-path consume (send site 3) is a rare path or a routine one. No
   `MessageAbortedError` filtering exists in the plugin today.
2. **Confirm the effective body budget** against the 3,700-char figure used in
   modelling.

## Testing

Unit-level in `packages/opencode-plugin/test/`, plus one daemon test for the
governor fix.

- Two assistant messages with text in one turn → both returned, rule-joined, in order.
- Single-message turn → **byte-identical to today**. Regression guard.
- `consume` clears: a second call returns empty.
- Pre-question flush, then more assistant text, then idle → flushed text does not
  appear twice.
- **Flip-back guard:** `message.updated` for an already-pushed assistant id is
  ignored; no duplicate segment, no torn text. Pins the 2.41% event class.
- Whitespace-only intermediate → no segment, no stray rule.
- **Markdown-only intermediate** (bare code fence) → no segment, no stray rule.
- Push-time cap: >40K drops oldest and prepends `… <n> earlier steps omitted`.
- Final segment alone exceeding the cap → **not** truncated. Pins the accepted limit.
- `session.error` body carries the accumulated narration ahead of the error text.
- Late-registration carryover: buffer survives a not-registered idle and appears in
  the next stop. Pins the accepted behaviour from hazard 3.
- Daemon-unreachable idle loses the buffer. Pins the accepted trade.
- `files` accumulate across a turn and clear on consume.
- Subagent sessions produce no notification change.
- **Governor:** an entry whose chunk count would exceed the remaining window is
  deferred, not started; a question enqueued behind it still sends in the next window.

## Success criteria

- Reading a topic shows every intermediate thing the agent said in a turn, not only
  its last step.
- Stop notification **count** is unchanged; chunk volume rises ~24%, verified against
  D1 after a week.
- No segment is ever posted twice.
- No new 429-induced outbox pause attributable to stop size.
