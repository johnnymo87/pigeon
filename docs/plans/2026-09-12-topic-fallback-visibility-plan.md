# Topic→General relocation: retry what is transient, and make the relocation visible

**Beads:** `pigeon-bit4` (P1, this plan). `pigeon-kyhf` folds into it — see §Cause.
**Scope:** `packages/worker` (deploys centrally, no per-machine restart).
**Status:** S1-S3 implemented in PR #142 (branch `bit4-topic-fallback`). The two prod `ALTER`s are
applied. Remaining: merge, deploy, then the S4 verification query. S5 deliberately not built.
Three `adversarial-reviewer-fable` rounds — two on this plan (round 2: SHIP WITH NAMED EDITS and a
reorder) and one on the built diff (SHIP WITH NAMED EDITS; see §Implementation notes). Every named
edit is folded in. **Do not restore the original ordering** — it led with the least-established
change.
**TDD:** failing test first, every step.

## The incident

2026-09-11, session `ses_f7837a8f3ffe09XunP0EhzJsyx`. The user asked a question at 17:03:46 EDT and
never saw the answer. Every hop reported success — plugin enqueued, daemon queued, outbox reported
sent, worker inserted a D1 `messages` row with Telegram `message_id` 20746.

A Bot API probe (`sendMessage` with `reply_to_message_id`; there is no read-a-message-by-id call)
returned `reply_to_message.message_thread_id = null`: it went to **General**, not the session's
topic (19303, `state='open'` throughout). The user reads topics.

## Cause

### It is an episode, not one message

Workers Logs, `POST /notifications/send`, 17:00–17:20 EDT (`wallTimeMs`):

```
17:01:07   1042    17:04:44  43645  <- the incident     17:12:47  41898
17:01:17   1727    17:05:41  50551                      17:13:10  22121
17:02:43    453    17:06:23  42402                      17:16:45  54569
17:03:11   1006    17:06:27   1053                      17:18:23  65697
                   17:10:56   5821                      17:19:07  11265
```

Eight stalls over fifteen minutes, across four sessions, interleaved with sub-second sends. CPU time
was 3ms against 43.6s wall on the incident invocation: pure I/O wait inside the worker.

### Most stalled sends *succeeded* — which kills the obvious fix

Probing four of the stalled messages for their thread (then deleting each probe):

| msg | stall | landed | |
|---|---|---|---|
| 20747 | 55s | **topic 19617** | slow but correct |
| 20749 | 42s | **topic 18463** | slow but correct |
| 20756 | 42s | **topic 18320** | slow but correct |
| 20746 | 43.6s | **General** | the incident |
| 20748 | +42s | **General** | see below |

So the failure mode is *not* "a hang, therefore a relocation". It is a slow Telegram episode in
which most sends eventually succeeded in the right topic and two did not. **A short timeout would
have aborted the successful ones** — this is why D3 below is a backstop and not the fix, reversing
the first draft of this plan.

### 20748 is worse than 20746 and was not in the original bug report

20747 and 20748 are the *same notification*: `s:ses_f748edd54…:1789160686130#c0` and `…:1789160686130`.
Chunk 0 landed in topic 19617; the final chunk landed in **General**. One logical message split
across two threads — and the last chunk is the one that carries `reply_markup`, so the buttons went
to General while the text stayed in the topic. Chunked notifications can be torn in half by this
bug, which no part of the system notices.

### What remains unmeasured

No log names the Telegram error that triggered either relocation, because nothing logs it. Two
readings still fit (threaded send stalls then fails, vs. fails fast then the General send stalls),
and **both end in a 5xx or an undefined error code**, so D1 repairs the incident either way. A 4xx
is excluded: a persistent 4xx would have failed the neighbouring sends in the same topic too.
This is stated as unmeasured rather than resolved.

### `pigeon-kyhf` (the "46s daemon stall") is this, not a second bug

The 46s was one worker invocation, not a slow daemon→worker hop. Workers Logs measures it already
(`wallTimeMs`); a daemon-side timer would have instrumented the hop that was not the problem. Bead
folds in. **The table above is quoted here because the `messages` rows reap in ~7 days and the
Workers Logs retention expires ~2026-09-18.**

## Design

Ordered by confidence, which is the order they ship in.

### D1 — Retry what is transient; relocate only what is permanent *(the fix)*

Relocating to General is right only when the topic is permanently unusable (rights revoked, forum
mode off). For anything transient the outbox already retries, and it will deliver to the right place.

| Telegram result | Today | Proposed |
|---|---|---|
| `error_code >= 500`, or **`error_code === undefined`** | relocate to General | **502 → outbox retries** |
| 429 | 429 → daemon pauses | unchanged |
| `thread not found` | recreate topic, retry once | unchanged, but log the outcome |
| 4xx (403, not-a-forum, rights revoked) | relocate to General | unchanged — the real never-drop case |

`error_code === undefined` is named explicitly: a 200 with an unparseable body yields `kind:"error"`
with no code (`telegram.ts:127`), which most likely means *processed*. Retrying risks a duplicate in
the right topic; relocating guarantees a misfile. Retry is the better-placed risk.

Verified daemon-side rather than assumed: `delivery-policy.ts` rule 7 maps 502 → `retry`; a ≥500 is
a transport failure so `attempts` is **not** incremented; backoff caps at 120s; terminal only on age
(stop/swarm 24h). `markRetry` is per row, so no head-of-line blocking. A transport *throw* already
becomes a 500 and is already retried (`telegram.ts:183` → `index.ts:92`) — unchanged by this.

### D2 — Log every relocation, at all six sites

| Site | Today |
|---|---|
| `notifications.ts:331-346` (the incident) | silent |
| `notifications.ts:308-311` — recreate failed → General, *outside* the block above | silent |
| `topic-manager.ts:224`, `:262`, `:315` — three `messageThreadId: null` returns (`:315` is poll-exhausted after 5×100ms, plausible under exactly this kind of load) | silent |
| `notifications.ts:425` media loop `catch { continue }` | silent drop |

One `console.warn` each, carrying `{sessionId, messageThreadId, kind, errorCode, description}`.
Fixing one and leaving five lets this recur wearing a different hat.

### D3 — Record where a message actually went

One column cannot express this: `message_thread_id IS NULL` would be five-way ambiguous
(relocated / `threaded:false` quiet questions / topics disabled / `resolveTopic` returned null /
media row). Two columns:

```sql
ALTER TABLE messages ADD COLUMN intended_thread_id INTEGER;   -- what resolveTopic returned
ALTER TABLE messages ADD COLUMN actual_thread_id   INTEGER;   -- what the send used
```

Relocation is exactly `intended IS NOT NULL AND actual IS NULL`; a recreate is both non-null and
different; a torn chunk set is two rows for one notification id disagreeing. Written for media rows too.

**Write them with a best-effort `UPDATE` in a `try/catch` after the unchanged `INSERT`.** Not as new
INSERT columns, because `send.insertMessage` runs *after* Telegram has accepted
(`notifications.ts:271` → `:393`): a missing column would throw → `withD1` → 503 → daemon retries →
the idempotency lookup finds no row → **it sends again**, every 5–120s for 24h. On the order of 700
copies per message, in every topic. The best-effort `UPDATE` degrades to a null plus a warn, and
makes the step revertible in either order. Additionally gate the `ALTER` on `PRAGMA table_info(messages)`
(pattern in `docs/runbooks/telegram-forum-migration.md:343-350`); the schema lives in three places
(`src/d1-schema.sql:31`, `test/worker.test.ts:104`, `:3448`) and test-has / prod-lacks is exactly the
skew the suite cannot catch.

### D4 — A timeout as a backstop, not as the fix *(revalued; ship last, or not at all)*

`AbortSignal.timeout` on **`sendMessage` only**, with the value taken from the observed tail
(episode max 65.7s) plus margin — **90s**, not the 20s the first draft proposed. At 20s it would
have aborted seven sends in fifteen minutes that went on to succeed, turning correct-but-slow
deliveries into duplicates. At 90s it never fires on the observed mode and exists only to stop an
indefinite hang.

Scoped to `sendMessage` deliberately: `sendPhoto`/`sendDocument` stream up to 50MB from R2, and a
`createForumTopic` timeout feeds `runCreatorFlow` → `:224` → General silently *and* can orphan a
topic that was actually created.

Two things it must carry:

- **A `timeout` arm in `getTelegramErrorDetails`.** Today that function synthesizes
  `error_code: 400` for any kind that is not `error`/`rate_limited` (`telegram.ts:97-111`). A new
  `kind:"timeout"` would therefore produce a 502 whose body says 400 → daemon rule 6
  (`delivery-policy.ts:183-190`) → `strip_entities`, which stops always have (`app.ts:926`). Every
  timeout would permanently strip formatting *and* charge an attempt (`outbox-sender.ts:641,652`),
  so ten stalls would terminal-drop the message. Omit the code, or use 504.
- **An injectable `timeoutMs`.** `AbortSignal.timeout` is native in the workerd pool and vitest fake
  timers will not drive it; a test would either hang for the real duration or pass vacuously.

## Steps

Each independently shippable and revertible. **Order is by confidence, not by size.**

**S1 — retry instead of relocate (D1).** Test: threaded send returns a 502-shaped result (pattern at
`worker.test.ts:1212`); assert the handler returns 502 and **no second `sendMessage` was issued**.
Second test for `errorCode === undefined`. The existing fallback test at `:8229` uses a 400, so it
stays green and keeps asserting the 4xx relocation — which is still correct behaviour.

**S2 — log all six sites (D2).** Test: `vi.spyOn(console, "warn")` (supported in this pool —
`worker.test.ts:5980`), one assertion per site.

**S3 — intended/actual columns (D3).** Test: threaded send → both equal; relocation → intended set,
actual null; **columns missing → the row still inserts and a warn fires**. Then the best-effort
`UPDATE`, then the PRAGMA-gated `ALTER`s against prod.

**S4 — deploy + verify.** `npm run --workspace @pigeon/worker deploy`; confirm both columns populate;
query `intended IS NOT NULL AND actual IS NULL` for the first real relocation rate we have ever had.

**S5 — the 90s backstop (D4), optional.** Only with the `getTelegramErrorDetails` arm, the injectable
timeout, and a `console.warn` naming the `notificationId` on fire.

**Cut — "TOPIC_CLOSED reopens the topic."** Killed on this repo's own evidence: `bd show pigeon-cev`
item 3 records a live probe (2026-07-28) showing `sendMessage` into a *closed* topic returns `ok:true`
and delivers, because the bot is an admin. `TOPIC_CLOSED` can only fire if the bot lost
`can_manage_topics`, in which case `reopenForumTopic` fails identically — and `resolveTopic` already
reopens a D1-closed row at `topic-manager.ts:129`. A new parse kind and branch protecting nothing,
plus a real conflict with the topic reaper.

## Risks

- **S5 duplicates.** A hang that Telegram processed becomes a duplicate on retry. The window is
  [Telegram accepts, `insertMessage` at `:393`] and **cannot be closed worker-side** — the Bot API
  has no idempotency key and the PK is `(chat_id, message_id)`, which does not exist until Telegram
  answers. Not a new failure *kind* (a transport throw has the same window today), but S5 changes its
  *frequency*, which is why the value is 90s.
- **Duplicates are invisible in D3.** A retried notification inserts one row under one
  `notification_id`; the columns record placement, not duplication. Visibility comes from the
  `kind:"timeout"` warn correlated against the retry in Workers Logs. (The earlier draft of this plan
  claimed the columns would show it. They will not.)
- **S3 ordering** — mitigated by the best-effort `UPDATE` plus the PRAGMA gate. Do not ship the write
  without both.
- **We are fixing a trigger we inferred.** No log names the error. S2 is what makes the next one
  self-explaining.

## Out of scope, noted

- Nothing pages on `outbox terminal drop`, and S1 lengthens the path to it. Follow-up bead.
- The daemon→worker fetch (`poller.ts:598`) has no timeout either; undici's 300s default is why a 46s
  call looked unremarkable from the daemon side.

## Compaction survival

This file is the durable artifact; the Workers Logs table and the probe results are quoted here
because both sources expire. A resuming session needs only: this plan, `bd show pigeon-bit4`, and a
worktree. Start at **S1**.

## Appendix — how the evidence above was obtained

Recorded because a fresh session cannot reconstruct these, and because **both sources expire**
(Workers Logs ~2026-09-18; `messages` rows reap with their sessions, ~7d).

**Workers Logs.** `[observability] enabled = true, head_sampling_rate = 1` in `wrangler.toml:22-24`.
`wrangler` has no historical query (only live `tail`), so go at the API directly. The token is on
cloudbox at `/run/secrets/cloudflare_api_token` (needs `sudo cat`); account
`3b6b247e124787ccf95772b6432fefe4`:

```bash
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/observability/telemetry/query" \
  -H "Authorization: Bearer $CF" -H 'content-type: application/json' \
  -d '{"queryId":"q","timeframe":{"from":<ms>,"to":<ms>},
       "parameters":{"datasets":["cloudflare-workers"],
         "filters":[{"key":"$metadata.message","operation":"includes",
                     "value":"notifications/send","type":"string"}]},
       "limit":50,"view":"events"}'
```

Read `$workers.wallTimeMs`, `.cpuTimeMs`, `.outcome`, and `event.response.status` off each event.

**Two traps in that API, both hit while gathering the table above.** A *wide* timeframe is
server-sampled — a 7-day query returned 20 events and claimed one slow invocation, while a 20-minute
query over the same data returned all 17 and eight slow ones. And a `$workers.wallTimeMs` `gt` filter
silently failed to match events that a narrow unfiltered query proves are there. **Query narrow
windows and filter client-side**; do not compute a rate from a wide window.

**Which thread a message actually landed in.** There is no read-a-message-by-id call in the Bot API.
Reply to it and read the echo:

```bash
curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" -H 'content-type: application/json' \
  -d '{"chat_id":"<chat>","reply_to_message_id":<id>,"allow_sending_without_reply":false,"text":"probe"}'
```

The response carries `result.reply_to_message.message_thread_id` (**null means General**), plus
`.date` and `.text`, which is how the misfiled message was identified. `allow_sending_without_reply:false`
matters — without it a deleted target silently posts a normal message and you learn nothing.
**Delete the probe afterwards** (`deleteMessage`), and prefer `copyMessage` into the correct thread
if the point is to give a human back a message they never saw.

Token and chat id: `/run/secrets/telegram_bot_token`, `/run/secrets/telegram_chat_id`.

**Local sqlite.** No `sqlite3` on PATH on cloudbox; use
`/nix/store/23991vk4j7h9wqg7d1y5gvlyn9c0cywr-sqlite-3.53.3-bin/bin/sqlite3` and open the daemon DB
**read-only** (`"file:/home/dev/projects/pigeon/packages/daemon/data/pigeon-daemon.db?mode=ro"`) —
it has ~15 concurrent writers.

## Implementation notes (what the build changed about the plan)

Three things the plan got wrong or left out, found while building and in the review of the diff.

**The lost-CAS warn site is deterministically testable.** The plan (and the S2 commit message)
said it needed an isolate-level race and would be inspection-only. It does not: `finalize`'s CAS
also returns false when the reservation row has been **deleted**, so an injected `tgClient` whose
`createForumTopic` deletes the row reaches the branch in a plain unit test. All six sites have
tests. Treat "needs a race" as a claim to check, not a reason to skip.

**The media wrappers threw the error away.** `sendTelegramPhoto` / `sendTelegramDocument` collapsed
every failure to a bare `{ ok: false }`, so the warn S2 added to that loop had nothing to report.
Both now carry the Telegram detail through. A logging change is worth nothing if the thing it logs
was discarded one frame down.

**Two 502 shapes, not one.** A Telegram gateway error arrives as HTML or an empty body and takes
the `res.status` branch of `parseTgResponse`, not the `data.error_code` branch. The first test
covered only the JSON shape — i.e. not the shape the incident actually produced. Both are tested,
and both now assert `details.error_code`, which is what keeps a future change from routing a 502
into the daemon's `strip_entities` rule.

Also from the review, and now enforced in `d1-schema.sql`: the `(intended, actual)` pair is **not**
a complete relocation count. The three `topic-manager.ts` paths never produce an intended id, so
they record NULL/NULL and are indistinguishable from `threaded:false`. Their `console.warn` is the
only signal for them, and the S4 query undercounts by exactly that set.
