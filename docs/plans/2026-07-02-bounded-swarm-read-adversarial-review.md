# Adversarial review: bounded swarm_read (design + plan)

Reviewed: `2026-07-02-bounded-swarm-read-design.md`, `2026-07-02-bounded-swarm-read-plan.md`
Against: `packages/daemon/src/storage/swarm-repo.ts`, `packages/daemon/src/app.ts`,
`packages/opencode-plugin/src/swarm-tool.ts`, `packages/daemon/src/ids.ts`,
`packages/daemon/src/storage/swarm-schema.ts`, all three named test suites, plus
`swarm-routes.integration.test.ts`, `app.test.ts`, and repo-wide grep for other callers.

## Verdict

**Sound with fixes.** The core mechanism (DESC+LIMIT+reverse on a covering index,
server-side default, graceful two-way deploy skew) checks out against the actual
code. But the design bounds *message count* while its own problem statement is
*context bytes*, and the breadcrumb's cursor advice can silently skip messages
under truncation — both are cheap to fix now and expensive to discover in
production. Fix those two before building; the rest is polish.

## Confirmed sound (verified by reading, not assumed)

1. **msg_id lexicographic order == chronological order, until 2059.**
   `makeMsgId()` is `msg_${Date.now().toString(36)}_${randomUUID().slice(0,8)}`
   (`packages/daemon/src/ids.ts:9-11`; sender-side mirror at
   `packages/opencode-plugin/src/swarm-send-tool.ts:75-77`). Today's epoch-ms is 8
   base36 digits and stays 8 digits until `36^8` ms = **2059-05-25T17:38:27Z**
   (computed, not guessed). Fixed length + lowercase base36 + SQLite BINARY
   collation ('0'-'9' < 'a'-'z' in ASCII) ⇒ string order equals numeric order.
   Same-millisecond messages tiebreak on the random hex suffix — arbitrary but
   stable; acceptable. The new DESC+LIMIT makes *selection* (not just ordering)
   depend on this, and it genuinely holds — for daemon- and plugin-minted ids
   (see Flaw 6 for the caller-supplied exception).

2. **`getInbox` really has exactly one production caller.** Repo-wide grep:
   `packages/daemon/src/app.ts:190` is the only non-test call site. `formatInbox`
   and `swarmRead` are used only by `swarm-tool.ts` and its test. The return-shape
   change is as low-blast-radius as claimed.

3. **No hidden test breakage.** `swarm-routes.integration.test.ts` touches only
   `/swarm/send` + `listTargetsWithReady`; `app.test.ts` never mentions
   `/swarm/inbox`. The plan's Task 5 caution is satisfied trivially. The existing
   route test (`swarm-routes.test.ts:217-266`, 2 messages) and the existing
   `formatInbox` block-count test (meta arg optional) stay green as the plan says.

4. **COUNT/SELECT coherence needs no transaction.** `getInbox` runs both
   statements synchronously on better-sqlite3 inside a single JS turn; the daemon
   is one Node process (arbiter included), so nothing can interleave between the
   COUNT and the SELECT. `total < returned` etc. cannot happen.

5. **Index support is real.** `idx_swarm_inbox (to_session, state, msg_id)`
   (`swarm-schema.ts:26-27`) serves the DESC+LIMIT via reverse index scan (no
   sort) and the COUNT as an index-only range scan. "Cheap" is honest at current
   scale (see Flaw 4 for the long-run caveat).

6. **Deploy skew is handled in both directions, and rollback is safe.**
   New plugin → old daemon: old route ignores `limit` and omits `total`;
   the plan's `body.total ?? messages.length` fallback degrades to exactly
   today's behavior. Old plugin → new daemon: `messages` array shape unchanged
   (verified against `swarm-tool.ts:65-66`, which reads only `body.messages`).
   Rolling the daemon back restores the status quo without stranding the plugin.

7. **The "retention is wired in name only" claim is true.**
   `swarm.cleanupOlderThan` (`swarm-repo.ts:172-180`) has zero production
   callers; the hourly cleanup at `index.ts:308` calls only
   `outbox.cleanupOlderThan`. The `swarm-tool.ts:15-18` docstring's "default 7
   days" is indeed false today.

8. **`since` semantics compose correctly when not truncated.** Exclusive
   `msg_id > since` + "pass newest msg_id as since" gives no overlap and no gap
   in the non-truncated case. The off-by-one is not there.

## Flaws, ranked by severity

### 1. The bound is on message count, but the stated failure mode is bytes (Medium-High, verified)

The design's own framing: "The failure mode is context **volume**"
(design.md:46), evidenced by a **331,262-byte** dump (design.md:30-34). The fix
caps *count* at 25 and claims this "hard-caps the item count regardless of how
chatty the swarm was" (design.md:48-49) — true, but chattiness is not the only
axis. Payloads are unbounded: `POST /swarm/send` validates presence and the
close-tag, never size (`app.ts:140-183`), and `formatInbox` renders every
payload untruncated (`swarm-tool.ts:74-87`, unchanged by the plan except the
breadcrumb). 25 messages × a few 10KB worker reports ≈ the same firehose. The
count bound is a good proxy that will work most days; it is not the guarantee
the design's language implies.

Worse, the interaction with the tool-output layer inverts the intent: messages
render oldest→newest with the breadcrumb *last*, so if 25 large messages exceed
the tool-output cap, the truncation layer (which the design itself observed
cutting output, design.md:32-33) eats **the newest messages and the breadcrumb**
— exactly the content this change exists to protect.

Cheap fix: a per-message payload render cap in `formatInbox` (e.g. first ~2-4KB
+ `…[payload truncated, N chars — msg_id=X]`), or a total byte budget. Either
turns the count bound into an actual volume bound.

### 2. Tail-biased `since`+`limit` silently skips messages if the agent follows the cursor advice (Medium-High, verified by reading the proposed SQL/wording)

`since`+`limit` returns "the N most recent that are newer than since"
(design.md:91-92). If >25 messages arrived since the cursor, the response
contains the newest 25 and *hides the oldest ones after the cursor* — the gap
is in the middle. The breadcrumb then advises: "Newest msg_id: msg_xxx — pass
as since= next time to fetch only newer" (design.md:126-128). An agent that
takes that advice advances its cursor **past the hidden messages, permanently**.
For the motivating consumer — a coordinator catching up on worker results —
that's silently dropped work reports. The breadcrumb does disclose the count,
but it simultaneously hands the agent a cursor that destroys the evidence.

Tail-bias is the right default for the bare call (oldest-first pagination would
force a resuming session to wade through stale pages to reach the present). The
flaw is the breadcrumb's *advice*, not the ordering. Fix the wording: when
truncated, say "to backfill the N hidden, call again with the **same** since=
and limit=<total>; only advance since= once you've seen everything you care
about." One sentence prevents a lost-message class of bug.

Related nit: "Pass limit=340 to include them" is only correct if the caller
also keeps the same `since`; bare `limit=340` returns a different set.

### 3. The old-plugin interim is silent truncation with a lying docstring — not "strictly better" (Medium, verified)

Design.md:62-63 claims old plugins "lose only the breadcrumb — strictly better
than the firehose." What actually happens: the deployed plugin renders 25
messages with **no indication** that more exist, while its tool description
still tells the model the inbox covers "the start of retention (default 7
days)" (`swarm-tool.ts:16-17`). An agent reasoning "worker X never reported —
its message isn't in my inbox" is now silently wrong in a way it couldn't be
before. The design itself says serve-pool reloads are disruptive and deferred
(design.md:60-62), so this window is not brief. It's a defensible trade —
bounded context for occasional silently-wrong completeness assumptions — but
call it a trade and shorten it (schedule the pool reload with the daemon
restart), don't call it strictly better.

### 4. Punted retention makes the breadcrumb a monotonically-growing firehose invitation (Medium, verified)

With `cleanupOlderThan` unwired, `total` only ever grows. The breadcrumb will
eventually read "25 of 1,340 — pass limit=1340 to include them." LLM agents are
suggestible; a breadcrumb phrased as an instruction is a standing invitation to
re-create the exact 331KB dump, now opt-in. Meanwhile the per-read `COUNT(*)`
scans that session's entire index range — fine at hundreds of rows,
measurable-but-tolerable at 100k, and growing forever by construction.

Punting the *deletion* is reasonable risk-sequencing. Punting it **untracked**
is not: the plan lists retention under "follow-ups if desired" (plan.md:613-615)
and the design says "Filed as a follow-up" (design.md:165) while the bead field
says "(none yet)" (design.md:4). File the bead as part of this change, and
phrase the breadcrumb neutrally (report the count; don't imperative-mood the
escape hatch — e.g. "315 older messages exist; limit=<total> retrieves all,
which may be very large").

### 5. The repo-layer default is *unbounded* — the footgun is moved, not removed (Low-Medium, verified in plan code)

Plan's `getInbox`: `opts.limit === undefined ? null : opts.limit` → an omitted
`limit` means **full history** (plan.md:102, 119-124). The safety therefore
lives only in the route. Any future caller of `storage.swarm.getInbox(id, {})`
(a reaper, a debug endpoint, a channel feature) silently reintroduces the
firehose at the storage layer. Since no production path needs unbounded-by-
default (the route always passes a number; "everything" is expressed as
`limit=<total>`), invert it: default to `DEFAULT_INBOX_LIMIT` in the repo and
require an explicit `limit: null` to mean unbounded. Costs one line.

### 6. Caller-supplied msg_id can hijack the "most recent" window (Low, verified mechanism / suspected exploitability)

`POST /swarm/send` accepts a caller-supplied `msg_id` with no format check
(`app.ts:141,177` — the idempotency tests use `msg_caller`). Before this change
a weird msg_id only mis-*ordered* the inbox; after it, a msg_id that sorts high
(e.g. `msg_zzzz…`) permanently occupies the "most recent N" window and evicts a
real message from every default read. All production senders mint well-formed
ids (`ids.ts:9-11`, `swarm-send-tool.ts:143`), so this needs an ad-hoc curl to
trigger — but the fix (reject caller msg_ids not matching
`^msg_[0-9a-z]+_[0-9a-f]+$` at enqueue, same fail-fast rationale as the
existing `ses_` check at `app.ts:153-158`) is tiny.

### 7. The plan updates the workstation skill but not pigeon's own agent-facing docs (Low-Medium, verified)

This repo treats `.opencode/skills/` as operative agent documentation, and four
of them will state a false contract after this ships:

- `swarm-architecture/SKILL.md:109` — route signature without `limit`, no
  `total`/`returned` in the response contract.
- `opencode-plugin-architecture/SKILL.md:63-64` — documents
  `swarmRead({...}, since?)` (old positional signature) and
  `formatInbox(messages)` (no meta).
- `daemon-architecture/SKILL.md:30,184` — inbox described as "full inbox".
- `swarm-operations/SKILL.md:20-21` — "expect `{"messages":[]}`" becomes
  literally wrong (response gains `total`/`returned`/`limit`).

Task 4 covers only the workstation skill. Add a Task 4b for these.

### Nits

- Design.md:134-136 claims the tool `description` (swarm-tool.ts:96-99) contains
  the false 7-days claim; it doesn't — only the header docstring (15-18) does.
- Breadcrumb says "of 340 **delivered** messages", but under `since` the total
  is "newer than the cursor", not all delivered. Minor wording confusion.
- Plan.md:163 says the inbox describe closes at `swarm-routes.test.ts:274`; it's
  275. Harmless.

## Missing cases

- **Byte-level truncation interaction** (see Flaw 1): what happens when 25
  messages still exceed the tool-output cap — the current ASC-with-trailing-
  breadcrumb layout loses the newest content first. Silent in both docs.
- **No payload size cap at enqueue** anywhere in the system; the count bound
  quietly assumes payloads stay small.
- **Channel-addressed messages**: `getInbox` filters `to_session = ?`, so
  channel messages (to_session NULL) never appear in any inbox read. Unchanged
  by this design, but worth one line stating it's out of scope on purpose.
- **Clock regression**: an NTP step-back makes new msg_ids sort *before* older
  ones, briefly corrupting selection (not just order). Pre-existing exposure,
  low frequency, acceptable — but now it affects which messages you see.
- **Migration/rollback**: genuinely fine — no schema change, both skew
  directions verified (Confirmed #6). Not missing; noting it was checked.

## Recommendations

1. **Add a per-message payload render cap in `formatInbox`** (~2-4KB + explicit
   truncation marker). This is the change that actually addresses the stated
   failure mode; the count limit alone is a proxy. (Flaw 1)
2. **Reword the breadcrumb** to (a) instruct "same `since=`, `limit=<total>`"
   for backfill, (b) warn that advancing the cursor skips the hidden messages,
   (c) drop the imperative "Pass limit=<total>" phrasing in favor of a neutral
   statement of fact. (Flaws 2, 4)
3. **File the retention bead now** (`bd create`), referenced from the design
   doc's `Bead:` line, so "punted" ≠ "forgotten". Retention is what stops
   `total` from growing without bound. (Flaw 4)
4. **Default `getInbox` to bounded at the repo layer**; require explicit
   `limit: null` for full history. (Flaw 5)
5. **Extend Task 4** to update the four pigeon-local skills listed in Flaw 7.
6. Optionally: validate caller-supplied `msg_id` format at `POST /swarm/send`
   (separate, tiny change). (Flaw 6)
7. In the deploy notes, schedule the serve-pool reload with the daemon restart
   rather than framing the old-plugin window as harmless. (Flaw 3)

None of these change the architecture. The decision hierarchy — bound the read,
server-side default, count-based, breadcrumb escape hatch — survives scrutiny;
the fixes are all at the "one sentence / one line" level, which is exactly why
they're worth making before the code exists.
