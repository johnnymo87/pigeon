# bit4 follow-ups: make the next episode explain itself

**Beads:** `pigeon-malt` (P3), `pigeon-t5bd` (P3), `pigeon-jahv` (P3), `pigeon-qpel` (P4).
Adjacent and deliberately out of this batch: `pigeon-nb6a` (P2), `pigeon-g6o9`, `pigeon-jw53`.
**Predecessor:** `pigeon-bit4`, shipped in #142; plan
`docs/plans/2026-09-12-topic-fallback-visibility-plan.md`, corrected in #143.
**Scope:** `packages/worker` for malt/t5bd/qpel; `packages/daemon` for jahv.
**Status:** scoped, pre-implementation. Not yet reviewed by `adversarial-reviewer-fable`.

## Why these four, and why in this order

The bit4 incident cost a day of forensics because **no instrument could say which hop was slow or
where a message actually went**. bit4 fixed the behaviour and added the placement columns. What it
did not do is give anyone a reason to *look*. Three of these four close that gap; the fourth is a
correctness tail bit4 created.

Ordered by confidence and by what unblocks what:

| # | Bead | Package | Why here |
|---|---|---|---|
| 1 | `pigeon-malt` | worker | Blocks `g6o9` and `jw53`. Zero behaviour change, zero hazard. |
| 2 | `pigeon-t5bd` | worker | Gives the bit4 columns a consumer before the rows reap. |
| 3 | `pigeon-jahv` | daemon | Correctness tail bit4 introduced; needs a judgement call. |
| 4 | `pigeon-qpel` | worker | P4. Possibly *document only* — decide, do not default to building. |

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

Cheapest shape: fold the count into the worker's existing hourly cron and `console.warn` when
non-zero. **Carry the undercount caveat into whatever surfaces it**: the three `topic-manager.ts`
paths never produce an intended id, so they write NULL/NULL and are indistinguishable from a
deliberately unthreaded send. Their `console.warn` is the only signal for those.

Decide explicitly whether this belongs here or inside `nb6a`'s alerting work. Two half-consumers
would be worse than one.

## Step 3 — `pigeon-jahv`: bound the undefined-`error_code` retry

bit4 classifies `kind:"error"` with `errorCode === undefined` as transient (502 → outbox retries).
Right for the incident — the alternative guarantees a misfile — but a 502 is a transport failure,
so **no attempt is ever charged**. If an unparseable-200 condition persists, the row retries every
5–120s to the 24h cap: ~700 sends, each of which Telegram may have processed, all into the correct
topic. Pre-bit4 the same condition cost two copies and stopped.

Candidate fix: charge an attempt on the undefined-code branch specifically, so it terminates on the
normal attempt budget rather than the age cap, leaving 5xx retries untouched.

**This one deserves an `oracle-fable` consult before implementation.** It is a genuine trade
between duplicate volume and delivery probability, it changes daemon retry semantics rather than
adding an observation, and the likelihood of the triggering condition is unmeasured. Do not build
it on the strength of the arithmetic alone.

## Step 4 — `pigeon-qpel`: decide, do not default to building

A permanent 4xx can still tear one notification across two threads (chunk 0 in the topic, the
final `reply_markup`-bearing chunk in General). Arguably correct — delivering the rest beats
dropping it — which is why it is P4. bit4 made it *visible*: the S2 warn fires and the two rows for
one notification id disagree on `actual_thread_id`.

The honest default is to leave it filed and closed-as-documented unless the fix is genuinely
cheap. If it is built, the shape is: decide relocation once for the whole notification before
sending chunk 0, not per chunk.

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

## Verification bar

`npm run typecheck` and `npm run test` at the repo root (worker 450+, daemon 1747, plugin 467).
The daemon's `lease-cas-concurrency` test flakes under load and passes standalone
(`pigeon-1lha`, `pigeon-t4h3`); re-run it alone before treating a failure there as real.
