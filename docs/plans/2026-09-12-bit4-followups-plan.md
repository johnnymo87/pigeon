# bit4 follow-ups: make the next episode explain itself

**Beads:** `pigeon-malt` (P3), `pigeon-t5bd` (P3), `pigeon-jahv` (P3), `pigeon-qpel` (P4).
Adjacent and deliberately out of this batch: `pigeon-nb6a` (P2), `pigeon-g6o9`, `pigeon-jw53`.
**Predecessor:** `pigeon-bit4`, shipped in #142; plan
`docs/plans/2026-09-12-topic-fallback-visibility-plan.md`, corrected in #143.
**Scope:** `packages/worker` for malt/t5bd/qpel; `packages/daemon` for jahv.
**Status:** steps 1 and 2 built; steps 3 and 4 decided and closed without a behaviour change.
Reviewed twice by `adversarial-reviewer-fable` (design, then diff) and once by `oracle-fable`.

## Why these four, and why in this order

The bit4 incident cost a day of forensics because **no instrument could say which hop was slow or
where a message actually went**. bit4 fixed the behaviour and added the placement columns. What it
did not do is give anyone a reason to *look*. Three of these four close that gap; the fourth is a
correctness tail bit4 created.

Ordered by confidence and by what unblocks what:

| # | Bead | Package | Why here |
|---|---|---|---|
| 1 | `pigeon-malt` | worker | Blocks `g6o9` and `jw53`. Zero behaviour change, zero hazard. **Built.** |
| 2 | `pigeon-t5bd` | worker | Gives the bit4 columns a consumer before the rows reap. **Built, in a different shape than planned.** |
| 3 | `pigeon-jahv` | daemon | Correctness tail bit4 introduced; needs a judgement call. **Closed — premise was wrong; measured instead.** |
| 4 | `pigeon-qpel` | worker | P4. Possibly *document only* — decide, do not default to building. **Closed as documented.** |

Two of the four turned out not to need code, and the one that did need code needed a different
design than the plan specified. That is the intended yield of the review steps, not a detour.

## Step 1 — `pigeon-malt`: per-call Telegram timing

Nothing measures a single Telegram call. `wallTimeMs` covers a whole invocation — up to two
`sendMessage` calls plus D1, sometimes `createForumTopic` — which is exactly why the plan's
"What remains unmeasured" section still lists two readings that both fit the evidence.

Wrap the `fetch` in `telegram.ts` (around `:183`) with a `Date.now()` delta; log method name plus
elapsed ms when it crosses a threshold. **No abort, no timeout, no behaviour change** — that is
the whole point, and it is why this ships before the two timeout beads that depend on it.

Open questions for implementation:
- One threshold constant, or log every call at `console.log` and let Workers Logs filter? Logs are
  sampled at `head_sampling_rate = 1` today, so volume is a real cost consideration.
- Does the timing wrapper belong around each method, or once inside a shared request helper?
  `telegram.ts` has several `fetch` sites; a per-method wrapper risks missing one.

## Step 2 — `pigeon-t5bd`: give the placement columns a consumer

`intended IS NOT NULL AND actual IS NULL` is a relocation. Nothing runs it, and `messages` rows
reap with their sessions (~7d), so a relocation nobody asks about inside a week leaves no trace.
Same signal-without-a-consumer shape as `pigeon-8l7` — which is the whole reason `nb6a` exists.

**Built differently from this, after review. The cron aggregate was the wrong answer twice over.**

First, it adds no consumer: bit4 already emits a per-event `console.warn` at every fallback site,
to the same sink, with more detail. An hourly count to Workers Logs is a second, lossier copy of a
signal that is already pushed.

Second, and decisively, **it would have been blind to the case that matters**. The undercount
caveat is not a footnote — the three `topic-manager.ts` paths (`create_failed`,
`finalize_lost_no_winner`, `poll_exhausted`) never resolve a thread id, so they record NULL/NULL.
`poll_exhausted` is the per-session, transient, silent fallback that happens under exactly the
Telegram latency that caused the incident. An aggregate over the column pair fires on chat-wide
breakage, which is obvious anyway, and sleeps through that one.

So the shipped shape is an **event-time Telegram message** to the first `ALLOWED_CHAT_IDS` entry
(the operator's own chat, the destination `checkSessionHighWaterAlert` already uses), driven off a
new `reason` returned by `resolveTopic` rather than off the columns. That covers all five paths
with no window, no watermark and no new state. It is deliberately not throttled: relocations
should be near zero, and if they are not, the volume is itself the alarm.

This did **not** fold into `nb6a`. A relocation is not a terminal drop, and Telegram is provably
reachable when one happens (the General send succeeded), so `nb6a`'s argument for a non-Telegram
surface does not apply.

## Step 3 — `pigeon-jahv`: bound the undefined-`error_code` retry

bit4 classifies `kind:"error"` with `errorCode === undefined` as transient (502 → outbox retries).
Right for the incident — the alternative guarantees a misfile — but a 502 is a transport failure,
so **no attempt is ever charged**. If an unparseable-200 condition persists, the row retries every
5–120s to the 24h cap: ~700 sends, each of which Telegram may have processed, all into the correct
topic. Pre-bit4 the same condition cost two copies and stopped.

**Closed without the behaviour change, on an `oracle-fable` consult that corrected the premise.**

The paragraph above is wrong where it says pre-bit4 "cost two copies and stopped". An unparseable
200 is a response-transport artefact and has nothing to do with `message_thread_id`, so a
*persistent* one would have hit the General send too and retried identically. Pre-bit4 the same
condition was worth roughly 1,400 copies, half of them misfiled; post-bit4 it is ~720, all in the
right topic. **bit4 halved this tail rather than creating it.** Do not re-derive the ~700 figure
later and file it as a bit4 regression.

The trigger also turns out to be implausible as a persistent condition: it requires HTTP 200 with
a body that yields no `error_code`, which in practice means headers delivered and the body
truncated mid-stream. That is a per-request blip. A systemic version of it would hit every send on
every session — an outage, not a one-row storm.

Charging an attempt was rejected on its own merits too: the daemon would have to key on the
*absence* of `details.error_code` in a 502 body (fragile against any future `TgResult` kind), and
it would mix an ambiguous-outcome count into the shared attempt budget, which review has already
rejected once elsewhere.

What shipped instead is a `console.warn` in `parseTgResponse` for exactly that shape, so the base
rate stops being unmeasured. **If that line ever shows the same notification twice in a row,
reopen `pigeon-jahv`** and build a separate ambiguous-outcome counter — not a charge against
`attempts`.

## Step 4 — `pigeon-qpel`: decide, do not default to building

A permanent 4xx can still tear one notification across two threads (chunk 0 in the topic, the
final `reply_markup`-bearing chunk in General). Arguably correct — delivering the rest beats
dropping it — which is why it is P4. bit4 made it *visible*: the S2 warn fires and the two rows for
one notification id disagree on `actual_thread_id`.

**Closed as documented.** Delivering the remaining chunks to General beats dropping them, bit4
already made the tear visible (the `send_failed` warn fires, the chunk rows disagree on
`actual_thread_id`), and the relocation alert added in step 2 now pushes it to a human as well. If
it is ever built, the shape is: decide relocation once for the whole notification before sending
chunk 0, not per chunk.

## Facts carried forward (verified, do not re-derive)

- `strip_entities` charges **one** attempt and deletes the entities from the stored payload
  (`outbox-sender.ts:632-637`), so `payloadHasEntities` (`:483`) is false next pass and rule 6
  stops matching. Consequence is a permanently format-stripped message, **not** a terminal drop.
  `worker-health.ts:218-226` states this; an earlier draft of the bit4 plan contradicted it.
- `isPermanentTopicFailure`'s `switch` ends `default: return true`. Any **new** `TgResult` kind is
  therefore treated as a permanent topic failure and relocated to General. This is a live trap for
  `g6o9`, and for anything else that adds a kind.
- A ≥500 from the worker is a transport failure daemon-side: `countAttempt=false`
  (`outbox-sender.ts:664`), backoff caps at 120s, terminal only on the age cap
  (`:358`, `expiryForKind` `:67-77` — question 4h, stop/swarm/card 24h, mirror 6h).
- Each chunk carries its own `notification_id` (`notifications.ts:293-303`, matched at
  `outbox-sender.ts:465`), so a 502 retry re-sends only the failed chunk.
- The worker test suite is **order-dependent** (`pigeon-dpi6`): interceptors leak between tests.
  Four bit4 tests deliberately leave one interceptor unconsumed as the assertion that no second
  send happened — do not "clean those up".
- **A single-shot undici interceptor cannot prove a negative here.** An unwanted extra send finds
  no mock, undici rejects, the caller's `try/catch` swallows it, and the assertion passes for the
  wrong reason. Two of this batch's own tests shipped that way and were caught in review: persist
  the interceptor and assert the send *count*. Confirm by mutation, not by reading.
- `messages` rows are deleted when their session unregisters (`sessions.ts:161`) — on `/kill`
  immediately, via the daemon's 7-day reaper, or via the worker's 14-day stale sweep. So the table
  is not a 39-day history: **any rate derived from the whole table is biased low**, because older
  days are survivors only. Over the last 7 days it is 293 rows/day, peaking at 617.

## Verification bar

`npm run typecheck` and `npm run test` at the repo root (worker 450+, daemon 1747, plugin 467).
The daemon's `lease-cas-concurrency` test flakes under load and passes standalone
(`pigeon-1lha`, `pigeon-t4h3`); re-run it alone before treating a failure there as real.
