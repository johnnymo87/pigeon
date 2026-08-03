# Roadmap: Devbox Forum Split — Post-Migration Defect Cleanup

**Spine bead:** `pigeon-k4c` (epic). Every work item hangs off it.
**Status at authoring:** migration DONE and HEALTHY. This roadmap covers only the defects
found while validating it.

If you are reading this after a compaction and have no other context, read
[§1 Where things stand](#1-where-things-stand) then run `bd show pigeon-k4c` and
`bd ready`. That pair is authoritative; this file is the narrative.

> **Read priorities and status from `bd`, never from this file.** The `P` and `State` columns in §3
> are snapshots taken when each row was written. Borrowed from the sibling roadmap below, which
> logged this as its ninth correction after its own inline labels drifted from the tracker and sent a
> reader at the wrong item.

### Sibling tracks — read before touching shared code

This is **not** the whole backlog, and it is not the only spine touching this subsystem.

| Track | Spine | Overlap with this file |
|---|---|---|
| Delivery hardening (post-forum-topics) | `docs/plans/2026-07-31-delivery-hardening-roadmap.md`, Cycles 0–7 | **High.** Its Cycle 6 and this track both edit `packages/daemon/src/worker/command-ingest.ts`. |
| Swarm delivery semantics | epic `pigeon-fnx` | Low — same thesis, different subsystem. |
| Serve routing | epic `pigeon-u1u` | None. |

**The overlap is not theoretical, and do not take false comfort from how it went.** PR #45 (this
track) and PR #46 (delivery hardening) independently rewrote the same question-reply path in parallel.
They merged textually clean — **silently**. Nothing warned either author.

Do not confuse this with the `sendBestEffort` collision, which was **intra-track**: #45 duplicated a
helper from my own open #43 on purpose, so whichever landed second got a hard
`Duplicate function implementation` error. That tripwire was deliberate, and it worked — but it says
nothing about cross-track safety, because #46 never touched that helper. **A cross-track collision
here has no tripwire at all**; the only thing that checked #45 against #46 was a manual test-merge in
a throwaway worktree, and it is not automatic. Before opening any cycle here, run:

```
git log origin/main -- packages/daemon/src/worker/command-ingest.ts
```

**A sibling's fix can close or re-scope an item here without either bead noticing.** #46 closed most of
`pigeon-k4c.4` as a side effect. Re-verify a bead against current `main` before working it — this epic
has now overturned a bead's own stated conclusion four times (§7, §9, and both re-verifications in
§10).

---

## 1. Where things stand

Devbox was moved onto its own Telegram forum supergroup, separate from cloudbox.

| Fact | Value |
|---|---|
| Devbox supergroup | `-1004232934695` ("Pigeon Devbox", forum on, bot admin w/ `can_manage_topics`) |
| Cloudbox supergroup | `-1004391832753` (unchanged) |
| Old DM chat | `8248645256` — deliberately still in the allowlist |
| Worker deployed version | `2ec415ef-fafb-43d0-b756-c2f0b9c49ce1` |
| `wrangler.toml` commit | `54d2aa3` on `main`, **not pushed** at authoring time |
| Devbox pigeon HEAD | `54d2aa3` (was `0bd1484` pre-migration, 255 commits behind) |

**The migration is not a rollback candidate.** Verified healthy: 6 devbox topics, 0
unfinalized, F1 topic names correct (`title · ~/dir`), notifications delivering including a
9-chunk split, no 403s, no rate limits, no outbox retries. Worker and daemon both healthy.

Nothing in this roadmap is an outage. The worst item is a silent-drop design flaw (W2) that
predates the migration.

### What the worker deploy did and did not change

`ALLOWED_CHAT_IDS` gained `-1004232934695`. That is the entire worker change; the worker is
chat-agnostic by construction (`chatId` arrives per-notification from the daemon, every
`topics` row carries its own `chat_id`, the reaper reads `row.chat_id`). A second supergroup
needed no code change.

**Do not remove the DM chat id from the allowlist as part of any rollback.** See the trap
documented in `docs/runbooks/telegram-forum-migration.md` — narrowing the allowlist while a
daemon is still pointed at the old chat burns the outbox's 10-attempt / 15-minute budget in
about 14 minutes and permanently loses queued notifications.

---

## 2. The unifying defect

Every work item below is a facet of one thing:

> The inbound command path has **no input hygiene** and **no user feedback**. Malformed or
> machine-generated messages are queued into D1, rejected by the plugin, and silently acked
> into the void.

W2 is the design flaw. W1, W3, W4 are symptoms that were invisible *because* of W2.

---

## 3. Work items

Full detail lives in the beads. Read those before implementing — they carry the traps.

| ID | Item | P | State |
|----|------|---|-------|
| `pigeon-az8` | **W0 GATE** — prove a normal text command works in a devbox topic | P1 | ✅ **PASSED** 2026-08-02 |
| `pigeon-2k1` | W2 — terminal rejection silently acked, no feedback, leaks inbox row | P1 | ✅ merged (#39, `3fa7a7c`) |
| `pigeon-mmu` | W1 — `forum_topic_created` service message queued as empty command | P2 | ✅ merged (#39, `3fa7a7c`) |
| `pigeon-k4c.1` | W2b — question-reply path silent drops + unguarded revive sends | P1 | ✅ merged (#42, `03b5c14`) |
| `pigeon-k4c.2` | W2c — wizard soft-locks when `editNotification` fails (ignored `ok`) | P1 | 🔵 in review (#43) |
| `pigeon-k4c.3` | W2d — genuinely-gone question hijacks messages for up to 4h | P2 | ready |
| `pigeon-k4c.4` | W2e — stale wizard button answers a NEW single question (guard skipped when `!isWizard`) | P2 | ready |
| `pigeon-tyk` | W3 — caption-less media dropped (not silently — see §9) | P2 | 🔵 in review (#45) |
| `pigeon-bru` | W4 — text-less message submits an EMPTY ANSWER to a pending question | P2 | 🔵 in review (#45) |
| `pigeon-k4c.5` | R2 media fetch treats a 404 as transient and retries forever | P2 | ready |

### Why W0 gated everything — and how it resolved

Post-migration the daemon logged 0 successful deliveries and 6 failures. The tempting read was
"command delivery is broken." **That read was wrong.** All 6 failures are self-inflicted (W1),
and there were zero attempts at a normal text command in the window — the ratio was **0-of-0,
not 0-of-N**. Absence of daemon logs cannot distinguish "nobody typed anything" from "the
worker dropped it upstream", because worker-side failures never reach `journalctl`.

**Resolved 2026-08-02 ~10:58 EDT. Gate PASSED:**

```
[command-ingest] delivered commandId=41dda1476493fc538cab1f77754682aa
                 adapter=direct-channel sessionId=ses_040adb83dffeNcmJh5sUiN8VfH attempts=1
```

A plain `ping` typed into thread 6 of the devbox supergroup traversed Telegram → worker → D1 →
daemon → plugin and reached the session, on attempt 1, with no `INVALID_PAYLOAD`.

Normal text delivery on `-1004232934695` is therefore **proven working**, not merely
un-disproven. The forum split introduced no delivery regression, the 6 failures really are
confined to W1's empty commands, and this roadmap's premise holds. W1–W4 are unblocked.

### Order, and how it has changed (updated 2026-08-02)

The original plan was: W2 first (the design flaw, which makes the rest observable), then W1
(the only known live producer), then W3 and W4 as verification. W2 and W1 shipped together in
PR #39 for the reason recorded in §6.

**Two corrections to that plan, both learned by doing:**

1. **"W1 also closes W4" was wrong.** W1's guard removed W4's easy repro without fixing the
   bug. The live path is now a caption-less media reply to a question, which submits an empty
   answer *and* discards the file. W4 is therefore not verification work — it is real, and it
   now overlaps W3's media handling.
2. **Fixing the execute path exposed a sibling path.** W2's audit only covered execute;
   the question-reply path had the same defect class (W2b, PR #42), and fixing *that* exposed
   two more (W2c, W2d). Each fix in this epic has surfaced its own neighbours, so treat the
   list as open rather than closed.

**Remaining order:**

| Next | Why |
|------|-----|
| `pigeon-k4c.4` (W2e) | Small and well-scoped: apply the version guard whenever the payload is wizard-shaped, not only when the *current* question is a wizard. Pairs naturally with W2d since both concern stale question state. |
| `pigeon-k4c.3` (W2d) | Noisy rather than silent, and strictly better than what it replaced. |
| `pigeon-k4c.5` | Independent of the question path entirely — a stuck-retry bug in the media fetch. Can be done any time, by anyone. |

All three P1s are now merged or in review; everything remaining is P2. Status column mirrors
`bd`: ✅ = closed, 🔵 = in_progress (PR open, bead stays open until it merges), ready = open.
Squash SHAs are recorded because the repo is squash-merge only — working SHAs do not survive.

---

## 4. Per-item process

Apply to each work item. Skip a step only when it genuinely does not apply, and say so in the
bead when you skip it.

1. **Compact** if context is long — use the `preparing-for-compaction` skill, and make the
   resumption prompt point at this file plus the bead id.
2. **Oracle consult** (`oracle-fable`) — optional. Use it where the design choice is genuinely
   open (W3's placeholder-vs-contract-relaxation is the obvious candidate).
3. **SDD** — subagent-driven development where the item decomposes cleanly. W2 and W1 are each
   small enough to do directly; use judgement.
4. **Adversarial review** (`adversarial-reviewer-fable`) — required before PR. It caught two
   real defects during this epic's diagnosis that I had missed (W4 entirely, and the
   `markDone` leak in W2), and correctly demolished my overbroad headline.
5. **PR** if the change warrants one.
6. **Update this roadmap** — tick the item, record the commit/PR, and file new beads for
   anything discovered. Keep the table in §3 in sync with `bd list`.

---

## 5. Evidence appendix

Kept because it is expensive to re-derive and cheap to store.

### W1: the 1:1 correlation that identified the producer

Local time is UTC−4. Every topic creation is followed by an empty command exactly 5 seconds
later — 5s is the daemon poll interval.

```
topic created 21:30:54  ->  empty cmd 21:30:59
topic created 21:42:44  ->  empty cmd 21:42:49
topic created 22:19:29  ->  empty cmd 22:19:34
topic created 03:05:00  ->  empty cmd 03:05:05
topic created 10:35:27  ->  empty cmd 10:35:32
topic created 10:44:27  ->  empty cmd 10:44:32
```

6 topics, 6 failures, no exceptions. The producer is machine-generated, not a user sticker.

### The failing chain, line by line

```
webhook.ts:369        text = message.text || message.caption || ''        -> ''
webhook.ts:396-400    Try 2 topic branch returns { command: text }, unguarded
webhook.ts:920        queued with commandType 'execute'
adapter.ts:64         envelope built with command: input.command
contracts.ts:149      isNonEmptyString(record.command) fails  (it TRIMS)
direct-channel.ts:170 -> 400 INVALID_PAYLOAD
command-ingest.ts:400 classified terminal
command-ingest.ts:583 acked and dropped, no reply sent
```

### Proof this was not caused by the deploy

`git diff 0bd1484..HEAD -- packages/daemon/src/opencode-direct/ packages/opencode-plugin/src/direct-channel.ts`
is **0 lines changed**, and `0bd1484` is a true ancestor of HEAD (`git log HEAD..0bd1484` is
empty — without that check the range comparison would be meaningless). Old plugin and new
daemon carry byte-identical contracts.

The version/source-mismatch hypothesis is definitively dead: `OPENCODE_DIRECT_PROTOCOL_VERSION`
and `OpencodeDirectSource` are unchanged across the range. By construction the daemon cannot
produce any other validator failure — requestId/commandId are UUIDs, sessionId is non-empty,
`issuedAt` is `Date.now()`, source is a constant, `deadlineMs` is omitted, and the body is
`JSON.stringify` output. **By elimination, empty/whitespace `command` is the only reachable
`INVALID_PAYLOAD` on this code.** Proven directly for 1 of 6, by elimination for the rest.

Caveat worth remembering: `webhook.ts` had 11 commits and `daemon/src/worker/` + `adapters/`
had 26 in that range. Checking two files was thin. The correct claim is "the failing path is
unchanged", not "the deploy changed nothing relevant".

### Corrections to my own diagnosis

Recorded so nobody re-derives the wrong version from a stale summary:

- **"Telegram → session commands are failing" was WRONG.** Overbroad. It is one bogus command
  per topic creation. Zero evidence any real command failed.
- **I undercounted 5 failures; there were 6.** The sixth landed after my grep window.
- **The adversarial reviewer was itself wrong on one point.** It claimed devbox ran topics all
  day pre-deploy and therefore my "exposed by forum topics" story had a timeline hole. Devbox
  was on DM `8248645256` until 21:30, so Try-2 topic routing was unreachable there; the 23
  clean pre-deploy deliveries were DM swipe-replies. The exposure thesis holds.
- **W3 (media) is a code-proven prediction, not an observed incident.** All 6 observed failures
  had `media_json NULL`. Keep the claims separate.

### Operational notes

- `wrangler` stalls when run in the foreground from an opencode bash call. Background it to a
  log and poll. Consistent with the bash-environment note in the user-level `AGENTS.md`.
- `sops` is not on the non-interactive PATH. Build it (`nix build nixpkgs#sops`) and run it as
  root with `SOPS_AGE_KEY_FILE=/persist/sops-age-key.txt`; devbox's `secrets/devbox.yaml` is
  encrypted to the devbox age key only. Restore file ownership to `dev:dev` afterwards.
- Devbox daemon logs `auth: disabled` — no `PIGEON_DAEMON_AUTH_TOKEN` set. Pre-existing and
  out of scope here, but it means the daemon's non-health routes are unauthenticated on that
  box. Not filed as a bead; raise separately if it matters.

---

## 6. W2 + W1 outcome (PR #39, branch `fix/silent-command-drop`)

Shipped together. W2 alone would have been a UX regression: with the producer still
in place, every newly created topic would have opened with a visible
`INVALID_PAYLOAD` error. W1 removes the producer, so there is no noisy window.

**Scope grew during implementation.** The bead named one silent-drop site; an audit
found four, all the same shape (bare return → Poller acks → no reply, no `markDone`).
All four now route through a shared `dropCommand()`.

**Ten pre-existing tests asserted the leak as correct** (`listUnfinished() === 1`).
All ten flipped to `0`. This is the kind of edit that can launder a regression into a
green suite, so it was verified twice: each failed on that one assertion and nothing
else (10/10 identical messages), and the adversarial review added the decisive check —
`listUnfinished()` has no runtime consumers, so those assertions never protected a
recovery mechanism.

**Process notes.** Oracle consult skipped (step 2) — the design was constrained and
the fix mechanical; recorded in the bead. Adversarial review (step 4) found no
must-fix but produced four real improvements, the best being a test gap: the
`isServiceMessage` unit tests passed even when the guard was never *called*. The
end-to-end test added to close that is mutation-checked.

### Discovered, filed, not fixed

- `pigeon-k4c.1` (W2b, P1) — the question-reply path has three silent drops of the
  same class as W2. The wizard case is worst: it drops every accumulated answer,
  leaves the `pendingQuestions` row, and never edits the notification, soft-locking
  the question behind buttons that now fail the stale-version check. Also folds in
  the three revive branches that hand-roll `dropCommand` with an unguarded send —
  latent today only because the production sender happens never to throw.
- `pigeon-bru` (W4) — **annotated, scope changed.** This PR's guard removes W4's easy
  repro without fixing it. The live path is now a caption-less media reply to a
  question, which submits an empty answer *and* silently discards the file (that
  second half overlaps `pigeon-tyk`/W3).

---

## 7. W2b outcome (PR #42, branch `fix/question-reply-silent-drop`)

Same defect class as W2, one path over: the question-reply path dropped four
things silently. Worse than W2, because what vanishes is an answer the user
actually typed rather than machine-generated noise.

**The bead's acceptance criterion was wrong, and the fix inverts it.** The
criterion — written by the adversarial review of #39 — said the wizard
final-step failure soft-locks the question and demanded the row be deleted and
the notification edited to a terminal state. But the final step builds its
answers locally and never calls `advanceStep`, which is the only thing that
bumps `version`; a failure therefore leaves the row untouched and the on-screen
keyboard still valid. The state was always retry-able and the defect is silence
alone.

The evidence is mechanical, not rhetorical. The test `still accepts the same
button press after a final-step failure` **passes against unfixed code**, and
the review's mutation run showed that implementing the original criterion breaks
two tests — converting a working retry into a silent drop. So the row is
preserved and the keyboard left alone.

**The asymmetry is the other half.** The adapter-lacks sites do the opposite:
delete the row *and* clear the keyboard. An oracle consult caught what the
implementer had missed — a live `pendingQuestions` row hijacks every plain-text
message to that session, so preserving it on a permanent condition blocks normal
command flow until the 4h TTL. The keyboard clear then came out of review:
deleting the row alone left buttons that resolve to nothing, reintroducing the
defect being fixed. The original criterion's edit-the-notification instinct was
wrong for one branch and right for the other.

Also collapsed the three revive branches into `dropCommand`; they hand-rolled it
with an unguarded send, latent only because the production sender never throws.

**Process notes.** The oracle consult (step 2) earned its slot for the first time
this epic — it both confirmed the refutation and supplied the hijack asymmetry.
The adversarial review (step 4) returned no must-fix but ran its own five-mutation
check in a throwaway worktree, all five killed, which is a stronger form of the
verification used in §6. One should-fix (the dead keyboard) was taken; two
findings were filed rather than absorbed.

Unlike §6, **zero pre-existing assertions needed flipping** and all 49 existing
tests still passed. That was flagged as potentially suspicious and checked: it is
legitimate, because the old silent drops were simply untested — which is why they
stayed silent.

### Discovered, filed, not fixed

- `pigeon-k4c.2` (W2c, P1) — the wizard non-final step mutates via `advanceStep`
  then ignores `editNotification`'s `{ok:false}`. Storage advances while the
  user's screen does not, and every later press dies on the stale-version guard.
  Review found a second entrance: if the edit *throws*, the ack is skipped and
  the retry hits the same stale guard. Any fix must close both doors. Rollback,
  reorder, and throw-to-retry were each considered and rejected on the bead.
- `pigeon-k4c.3` (W2d, P2) — the residual cost of the inversion. A question that
  is genuinely gone keeps its row, hijacks every message for up to 4h, and
  answers each one with a retry hint that can never succeed. Noisy rather than
  silent, so still better than the behaviour it replaced.

---

## 8. W2c outcome (PR #43, `pigeon-k4c.2`)

The wizard's non-final step mutated storage (`advanceStep` bumps `currentStep` **and** `version`)
and then awaited `editNotification` while discarding the result. On edit failure, storage sat at
step N+1/version V+1 while the screen still showed step N with version-V buttons, so every later
press died on the stale-version guard. Typed text bypasses that guard and is stored against the
*current* step, so a typed answer was silently recorded against a question the user never saw.

**The fix keeps storage authoritative and apologises in prose.** It checks the result and, on
failure, sends a plain-text restatement of the step the wizard actually wants. Rolling the advance
back was rejected because `{ok:false}` is ambiguous — the daemon's fetch can die *after* Telegram
applied the edit — so a rollback creates the same skew in the opposite direction.

### What the oracle changed

Consulted on scope, retry, and wording. It earned the slot by **correcting me on scope**: I had
read a failed *completion* edit as garbage-injection, believing the stale button payload `v3:q1`
would reach opencode as a literal prompt. Wrong — the stale-option guard at `:318-321` catches it
and drops it. I verified the correction myself before building on it. The completion site was still
worth fixing, just for a smaller reason: the keyboard outlives a wizard that no longer exists.

It also **declined the retry** the bead had left open (`editNotification` collapses every failure
class into a bare `{ok:false}`, so you cannot retry only-transient without changing its signature),
and caught two things that would have made the fallback text actively misleading: it must point at
the *original* question message (the fallback has no `messages` row, so swipe-replying to it
resolves nothing) and must ask for the option *text*, not its number (typed answers are stored
verbatim, so `2` records the literal `"2"`).

### What the review changed

Six mutations, two suite holes. The serious one is worth remembering as a testing lesson:

> Every test returned a literal `{ok:false}` — but that shape never occurs in production.
> `poller.editNotification` returns the worker's JSON verbatim regardless of HTTP status, and every
> worker failure path answers `{error:...}` with **no `ok` field**. So relaxing `ok === true` to
> `ok !== false` reads `undefined` as success and **restores the soft-lock** for the most
> persistent failure there is — a 404 for a swept `messages` row — with the entire suite green.

The tests mocked a shape the system does not produce. Both mutations were re-run locally after
adding the pinning tests, and both now fail.

### Process notes

- **Zero pre-existing assertions changed**, as in W2b (#39 needed ten). Four of the nine new tests
  pass against unfixed code by design, pinning behaviour that must *not* change — chiefly that no
  rollback occurs.
- Mutation testing has now earned its place three cycles running. Treat "the suite is green" as
  unproven until a mutation has failed it.

### The rebase found one more

PR #42 merged while this was in review, so #43 was rebased onto it. The rebase surfaced a defect
**in #42's own new helper**: `dropUnanswerableQuestion` deletes the pending row and then clears the
keyboard with an unguarded `editNotification` call. A throw there escapes before `dropCommand`
runs — row already deleted, command never acked, user never told — and the retry then finds no
pending question, so a typed answer falls through to the execute path and reaches opencode as a
**stray prompt**. Fixed in #43 rather than filed, since it is the same class, in the same file, and
the containment helper already existed.

That is the third consecutive cycle in which fixing one path exposed a neighbour — and the first in
which the *fix itself* introduced the next instance. §3's "treat the list as open rather than
closed" is holding up.

### Discovered, not fixed

`pigeon-k4c.4` (W2e): a stale wizard button can answer a **new single question**, because the
version guard at `:148` only runs when the *current* question is a wizard. A wizard-shaped payload
arriving for a single question is stale by definition, but its version is never examined.

---

## 9. W3 + W4 outcome (PR #45, `pigeon-tyk` + `pigeon-bru`)

Shipped together because they are **one repro**: a caption-less photo replying to a question
notification submits `''` as the answer (W4) *and* discards the file (W3). Fixing either alone
leaves that user action broken.

W4 is the nastiest shape this epic has produced. Every other item fails loudly or silently;
this one **succeeds with garbage** — the wizard advances, the answer is recorded, and nothing
anywhere reports a problem. The validator permitted it because `answers` only has to satisfy
`Array.isArray`.

### The fork resolved to an option that was not on the bead

The bead offered (a) synthesize a placeholder caption at the worker, or (b) relax the contract
to allow an empty command iff media is present. The answer was **neither**: synthesize in the
*daemon*, on the execute path, after both question branches have returned.

(a) is actively unsafe in a way the bead did not anticipate — worker-synthesized text flows
into the question path and becomes a question's **answer**, manufacturing a fresh instance of
the very bug W4 fixes. (b) is safe but ineffective: the plugin is loaded into long-lived
opencode TUI processes holding the old validator, so it would take effect only as each TUI
restarted, and a media-only prompt reaches opencode with no text context at all.

A third option — carry the file *as* the answer — was ruled **impossible here**, not merely
expensive. The plugin's `onQuestionReply` POSTs `{answers}` to opencode's own
`/question/:id/reply`, which has no file channel. That is an upstream opencode change.

### Both beads were wrong about something, in opposite directions

- **`pigeon-bru` had the fix layer inverted.** It argued "only a worker-side guard closes it".
  The worker *cannot*: `resolveMessageSession` sets `questionRequestId` only for swipe-replies
  to a `q:` notification, so topic-routed messages carry no question context — yet
  `getBySessionId` hijacks them into the question path anyway. Only the daemon knows a
  question is pending. A worker guard would be a sieve.
- **`pigeon-tyk` was stale on severity.** "Silently dropped" stopped being true at #39, which
  made terminal rejections reply `Command rejected: Invalid execute envelope`. Loud, cryptic,
  and still lossy.

That is now **three consecutive cycles** in which a bead's own stated conclusion had to be
overturned by reading the code (W2b's inverted criterion, W4's repro change, and now W4's
layer claim). Beads record what was believed when they were filed; verify before obeying.

### What the review changed

The "your file wasn't delivered" warning originally fired at question-path *entry*. Two ways
that misleads, both the same class this epic exists to kill: a transient failure throws so the
Poller retries the whole command, re-sending the warning once per lease cycle **unbounded**;
and on the metadata-fallback branch a terminal failure falls through to regular delivery which
*does* carry the file, making the warning an outright lie. It now fires only where an answer
has actually been accepted.

### Mutation testing, fourth cycle running

Ten mutants, **one survivor**: reverting the revive-path "file could not be delivered" notice
left the suite entirely green — that string appeared in zero tests. The lesson is the same one
as §8's, in a new costume: the code was *correct* and completely unprotected, so the next
refactor would have silently removed it.

Zero pre-existing assertions changed, verified rather than assumed — `main` has no test
asserting empty-answer acceptance, and its media tests are all captioned.

### Discovered, filed, not fixed

`pigeon-k4c.5` (P2): the R2 media fetch throws on any non-`ok` response, which the ingest
contract reads as transient. A 404 — the *normal* outcome once R2's 24h TTL sweeps the object —
therefore retries forever and is never acked. Pre-existing; unchanged by this PR.

### A note on `pigeon-m68`, and a wrong call I made about it

Mid-cycle I recorded that `lease-cas-concurrency.test.ts` had stopped being flaky and now
failed **deterministically**, on the strength of 3 consecutive failures — one full-suite, one in
isolation, one in a throwaway worktree at clean `origin/main`. I wrote that into both the bead
and this file.

**It was wrong.** The same test later passed 1/1 in a full-suite run and 8/8 in isolation. All
three failures happened while the machine was loaded (npm installs and other suites running);
all nine passes happened while it was idle. It is a load-sensitive flake in a concurrency
proof — exactly the original characterisation, not a regression from it.

Three consecutive failures felt like proof and were not. The retraction is recorded here rather
than quietly edited away, because this cycle's whole theme is beads and notes asserting more
than their evidence supports — and I did it too, in the middle of writing that up.

Practical guidance: a red there is not necessarily real, but re-run it on an **idle** machine.
Re-running while the rest of the suite is still going will often reproduce the failure and
convince you it is genuine.

---

## 10. Re-verification against post-#46 `main` (2026-08-03)

PR #46, from the delivery-hardening track, rewrote the question-reply path this epic has been working
all week. Both remaining question-path beads were re-verified **by probe test, not by reading**,
because this epic has repeatedly punished reasoning. Probed against `origin/main` at `e373821`, which
includes #45, #46, #47 and #51–#53 — not against #46's own commit, which is what the beads describe.

### `pigeon-k4c.4` (W2e) — mostly closed by someone else's PR, and the residue is the interesting part

#46 made `resolveCallbackSession` return `questionRequestId` (webhook.ts:611-618), so **button presses
now carry question identity**, and added a supersede check that rejects an answer whose requestId does
not match the pending row. The probe, run both ways against `origin/main`:

| Stale `v3:q0` press against a NEW single question | Answers delivered | User told |
|---|---|---|
| **With** metadata (what the post-#46 worker sends) | none | "That question was replaced by a newer one…" |
| **Without** metadata | `[["Yes, deploy"]]` | **nothing** |

So the bead's mechanism is untouched — the version guard at `:193` still only runs when the *current*
question is a wizard — and #46 masked it upstream rather than fixing it. Where the supersede check does
not run, it still fires, and fires **silently**, answering a question the user never read with an
option chosen by position. Reachable routes, strongest first:

1. **Stale daemons.** The sibling roadmap records that `devbox` and `macbook` still run stale daemon
   code. A pre-#46 daemon has no supersede check *at all*, so the misroute is live on those machines
   today regardless of metadata. This is the route that actually justifies the fix.
2. **Rollout skew** — commands queued by the pre-#46 worker and still sitting in D1.
3. ~~A `notification_id` that does not parse~~ — **probably not reachable**, and the bead should not
   lean on it. The `q:` notification format predates `WIZARD_OPTION_RE`, so every wizard keyboard ever
   rendered maps to a `q:`-prefixed row, and the parser handles the `#cN` chunk suffix. A missing
   mapping makes `resolveCallbackSession` return null, so the command is never queued at all. Listed
   here only so nobody re-derives it as live.

The originally-proposed fix is still the right one *because* it does not depend on metadata: apply the
version guard whenever the payload is wizard-**shaped**. That is defense-in-depth behind #46's identity
check, not a duplicate of it.

### `pigeon-k4c.3` (W2d) — still live, and now independently corroborated

#46 deliberately did not extend `expires_at`, and its own comment states this bead's premise in this
bead's terms: *"a live row hijacks EVERY plain message to the session into the question-reply path
below."* Independent confirmation from another track.

It also **changed the fix space**: `getBySessionIdIncludingExpired` makes an expired row deliberately
reachable, so any fix here must not delete rows on TTL — that would destroy the late-answer rescue #46
just built. The superseded case is now handled; a genuinely-gone question still hijacks for 4h.

### The pattern, restated

Three cycles ago the lesson was "each fix surfaces its neighbour". This cycle it is broader: **another
session's merged PR moved this epic's ground, in one case closing an item and in the other narrowing
it, and neither bead knew.** Beads and roadmaps record what was believed when written. The sibling-track
table at the top of this file exists so the next reader checks before working, rather than discovering
it at rebase time.
