# Telegram-Visibility Follow-ups Roadmap

**Created 2026-08-11**, the day `pigeon-d95y` (Telegram visibility, both phases) closed.

**Tracking bead: `pigeon-78no`.**

This is a **spine**. It is expected to outlive compactions, worktree deletions and SDD runs. Its
predecessors — `docs/plans/2026-07-31-delivery-hardening-roadmap.md` (where this work is item `F6`)
and the `pigeon-d95y` design/implementation pair — earned that shape by surviving ~10 compactions
between them. Same discipline applies.

---

## How to use this file

**On resuming:** read §0 (where you are), then §1 (hazards — every entry cost real time), then §2
(the ritual), then the first unchecked item in §3.

**Priorities and statuses here are stale snapshots. Read them from `bd`, not from this file.** That
rule is inherited from CORRECTION #9 of the hardening spine, and it has been right every time.

**Rules:**

- Mark an item `[x]` only when its tests pass AND it is merged AND, where it deploys, it is verified
  running. Never on intent. "Merged" is not "deployed" — see §1.2.
- One task per commit, conventional-commit style.
- If a claim in this file turns out to be wrong, amend it **in the same commit as the fix**, and say
  why. This file has authority only because previous versions were corrected when they were wrong.

---

## §0 — WHERE YOU ARE

**The `pigeon-d95y` epic is DONE, merged, and burn-in verified on cloudbox.** A session's Telegram
topic now shows all three inputs that drive it: Telegram commands, swarm IPC (Phase 1, PR #76,
`dcd4016`), and TUI-typed prompts (Phase 2, PR #78, `02c997a`). Docs and roadmap in PR #85.

| Thing | Value |
|---|---|
| Phase 1 + 2 deployed on | **cloudbox only** — see item **B** |
| Daemon route | `POST /mirror` (`packages/daemon/src/app.ts`), live, returns 400 not 404 |
| Suppression store | `injected_prompts`, counted, 15-min TTL, swept by the session reaper |
| Outbox kinds added | `swarm` (`w:`/`wc:` ids), `mirror` (`m:<sessionId>:<messageId>`) |
| Governor | `SWARM_SUB_BUDGET = 6` of 12 per 60s, shared by `swarm` + `mirror` |
| Burn-in evidence | bead `pigeon-d95y.15` — 12 Telegram deliveries, 0 echoes; 21 swarm handoffs, 0 mirrors |

**What is left is not the epic.** It is one design gap the epic created (**A**), one deploy debt it
inherited (**B**), and three items review found and we deliberately deferred (**C**, **D**, **E**).

| Item | Bead | What | Blocked? |
|---|---|---|---|
| **A** | `pigeon-ywlg` → `pigeon-8zqt` | ~~Gate the swarm feed~~ → gate swarm **and mirror** on notify policy | **DONE + VERIFIED IN PROD** 2026-08-12, PR #97. 11 suppressions across 11 quiet sessions, 0 leaks, regression control passes. Mirror was the primary leak — see CORRECTION #A1. |
| **B** | `pigeon-rqyz` + `pigeon-k0eh` | Fleet deploy (devbox, macbook, chromebook) | **Yes** — needs a session ON each host |
| ~~**C**~~ | ~~`pigeon-rmr2`~~ | **WITHDRAWN — the DB is not corrupt.** Premise did not reproduce | n/a |
| **D** | `pigeon-kq6h` | Subagent misclassified as main when `session.get` fails | **PR #94 open** — merged? then deploy |
| **E** | `pigeon-pre9` | Deferred polish from adversarial review | **MERGED** 2026-08-11, PR #99 — awaiting the same serve restart as D |

**Only B remains, and it is the deploy.** A, C, D and E are all resolved: **D and E are merged but
NOT deployed**, and both are waiting on the *same* `opencode serve` restart (§1.2) — that restart is
now the single action that converts four merged PRs into working behaviour, and it is also the first
half of B. Do not tick D or E until it has happened.

Historical detail, still accurate: A shipped on 08-11 as `pigeon-8zqt`
(PR #97) after being reassigned to the `qdcb` owner, who also corrected its scope — read
CORRECTION #A1 in item A before treating anything written about A here as current. D is written,
reviewed and green in PR #94, but it is **not ticked**, because a plugin change is not live until
an `opencode serve` restart (§1.2) — see item D for what remains. **C is withdrawn** — the
database it wanted repaired is healthy (see item C for the measurement). B is blocked on a session
existing on each host, and **must be sequenced last** regardless, because A/D/E each re-widen the
fleet skew B exists to close. Do not burn a cycle rediscovering any of this.

**Two new beads came out of D**, both filed rather than fixed inline, and neither blocks anything:
`pigeon-nwrt` (P4 — restore the mirror for a main session whose `session.get` failed) and
`pigeon-umyr` (P3 — a demoted subagent leaves a stale daemon registration and an orphan topic).

---

## §1 — OPERATING HAZARDS

### 1.1 Splitting `git` from a heavy command on cloudbox — now hygiene, not a hazard

> **CORRECTED 2026-08-11 (item E).** This entry described the `git` exemption as current. It is
> **gone** as of workstation PR #349, merged into pigeon's `AGENTS.md` by PR #96 the same day this
> spine was written. Left in place rather than deleted, because the *practice* it recommends is
> still right and because a reader who has seen the old rule elsewhere needs to know it changed.

**What used to be true:** a bash command whose text contained a bare `git` token was exempted from
the `oc-agent.slice` scope and ran inside `opencode-serve@<port>.service` — `MemoryMax=14G`,
`OOMPolicy=stop`, shared with the serve and every peer session on that port. An OOM there stopped
the whole serve, killing the plugin, so `session.idle` never fired and Telegram notifications
stopped **silently**, reading as a pigeon bug. It cost a peer session a serve (`pigeon-8bif`).

**What is true now:** the scope wrap happens at spawn time instead of by rewriting the command
text, so the `git … : deny` permission globs still match *and* every command is scoped, `git`
included. An OOM reports **exit 137** and kills only your command; retrying unchanged fails
identically, so reduce parallelism instead. The old silent-serve-death mode only applies if you
see the wrapper's `WARNING: … running UNSCOPED` line.

Keep splitting them anyway — it costs nothing and the suite is only ~1.0 GiB peak:

```bash
git pull --ff-only          # call 1
npm install && npm run test # call 2 — separate bash invocation
```

### 1.2 Merging is not deploying, and restarting the daemon is not deploying either

This feature has **two halves with different activation**. A daemon restart activates the daemon
half; the **plugin half only loads when `opencode serve` restarts**, which disrupts live sessions.
The daemon half alone is *inert, not broken* — `POST /mirror` answers, no mirror is ever produced.
**That state looks exactly like a successful deploy.** On cloudbox the serve restart was deliberately
left to the nightly reset rather than interrupting live sessions.

### 1.3 Copy the SQLite WAL or you will read a stale snapshot

Reading `packages/daemon/data/pigeon-daemon.db` without its `-wal` gives a snapshot frozen at the
last checkpoint. This already produced a false "the feature is silently doing nothing" conclusion
during Phase 1 verification; the `-wal` was 7 MB. Copy all three, always:

```bash
cp pigeon-daemon.db /tmp/x.db; cp pigeon-daemon.db-wal /tmp/x.db-wal; cp pigeon-daemon.db-shm /tmp/x.db-shm
```

Same applies to `~/.local/share/opencode/opencode.db` — and see item **C**, which is about that file.

### 1.4 A failing test whose name contains "regression" is a stop-and-escalate signal

Never edit or weaken one. It pins a previously-fixed bug. During `pigeon-d95y` an implementer
rewrote one to make a spec of mine pass; **the spec was the bug**, and the test was pinning
`pigeon-81p`, a closed P1. Put this prohibition verbatim in every subagent brief.

### 1.5 Never work in `/home/dev/projects/pigeon` itself

It is shared with live sessions. Use a worktree off `origin/main`. Never run tree-wide destructive
git there (`reset`, `checkout --`, `stash`, `clean`) — a peer's uncommitted work has been destroyed
that way before.

### 1.6 Fail open toward noise, not silence

House rule for this whole area, and it is a *decision*, not a default: a silent topic that should
have spoken is the unrecoverable direction; a duplicate post is merely annoying. Every ambiguity in
items A–E resolves toward posting. Note this is the opposite of the leak direction chosen *inside*
Phase 2's echo suppression, where an unconsumed count suppresses for ≤15 min — that is deliberate,
because there the alternative was noise in every topic on the machine. Know which side you are on.

**The discriminator for a novel case:** if the risk is *duplicating something Telegram already
showed*, err toward silence; if the risk is *losing a genuine event*, err toward posting. Item D is
the live collision — failing closed there means a real session stops notifying — which is why it
needs an explicit argument rather than a default.

### 1.7 The verification checklist misses what it cannot observe

Phase 2's burn-in checklist was entirely behavioural, so the one task with no runtime symptom —
the AGENTS.md update — silently did not happen, and the bead was closed claiming complete. A
checklist derived from observable behaviour will systematically omit documentation and roadmap
steps. Put them in the ritual (§2) rather than trusting them to a symptom.

---

## §2 — THE PER-ITEM RITUAL

Every item in §3 runs this sequence. It is the user's standing instruction.

0. **Reproduce the item's stated symptom before designing anything.** If it does not reproduce, the
   item is the bug — amend or withdraw it and stop. This step exists because item **C** did not
   reproduce: it sat in a bead for two days and this roadmap sent the first reader at it, until an
   adversarial review measured instead of trusting. §1.7 warns that a checklist misses what it
   cannot observe; this is the twin failure — **a roadmap preserves what is no longer true, or was
   never true**, and it does so with authority.
1. **Compact** if context is heavy. Persist first (`preparing-for-compaction`): beads updated, plan
   file current, resumption prompt pointing at *this file by path* and the item letter.
2. **Optional `oracle-fable` consult** — for a design question where being wrong is expensive.
   Skip it for mechanical work; say in the bead that you skipped it and why.
3. **SDD if it genuinely decomposes** — fresh `implementer` per task, then `spec-reviewer` /
   `code-reviewer`. A one-file change does not decompose; do not manufacture tasks to fit the ritual.
4. **`adversarial-reviewer-fable`** on the finished diff, before any deploy and before the PR.
   It reviewed both `pigeon-d95y` phases and caught two real SHOULD-FIXes in Phase 2.
5. **PR** if code changed. Description carries the *reasoning*, not just the change list.
6. **Update this roadmap** — tick the item, record evidence, file beads for anything discovered.
   **This step is the one that gets skipped** (§1.7). It is not optional.

**Verify before claiming.** Re-run the full suite yourself; do not take an implementer's report for
it. Twice during `pigeon-d95y` a subagent reported "all green" having run only its own test files.

```bash
npm run test        # expect exit 0; test-FILE counts per package: daemon 68+, plugin 21+, worker 2
npm run typecheck   # expect exit 0 across all three workspaces
```

---

## §3 — THE ITEMS

### [x] A. `pigeon-ywlg` (P2) — DONE 2026-08-11 as `pigeon-8zqt`, PR #97 (`c3c7615`)

> **CORRECTION #A1 (2026-08-11, written by the `qdcb` owner who caused the error).**
> This item shipped **wider than specified**, because the specification below was wrong on the
> single most important point, and the wrongness was mine.
>
> ~~"Scope is deliberately asymmetric: gate `kind='swarm'` only. Do NOT gate `kind='mirror'`.
> Mirror fires when a human types into a TUI; lgtm sessions are headless, so gating mirror is
> near-dead code."~~
>
> **Mirror was the PRIMARY leak, not dead code.** Measured on cloudbox before the fix, outbox rows
> for sessions holding a quiet `session_origin` row: **`mirror` 16, `swarm` 4, `stop` 1** (the stop
> is by-design Error/Retry). The first outbox entry for every newly created lgtm topic was
> `kind='mirror'`. The user's report was "my telegram is full of topics coming from lgtm".
>
> **Why the reasoning failed, which is the reusable part:** `/mirror` does not implement "a human
> typed into a TUI" — that is the feature's *name*, and `AGENTS.md` repeated it as if it were the
> predicate. What it actually does is mirror **any user-role message not found in
> `injected_prompts`**. lgtm starts sessions with the `opencode-launch` CLI rather than the daemon's
> injection path, so lgtm's own launch prompt is a user message the daemon never recorded and never
> suppressed. Headlessness is irrelevant; the provenance of the *prompt* is what decides. Any
> automation launching sessions outside the daemon leaks identically.
>
> I compounded it by reporting "the lgtm filtering works, 0 leaks" thirty minutes earlier — true,
> but measured by grepping `[stop] queued`, an instrument that by construction cannot see a mirror
> or a swarm post. §1.7 already warned about exactly this and I still did it. The correct
> instrument was `outbox` joined to `session_origin`, grouped by `kind`.
>
> `AGENTS.md` now documents the real predicate next to the feature description.

**Shipped:** `packages/daemon/src/ancillary-gate.ts` — `shouldEmitAncillary` (pure predicate) and
`shouldEmitAncillaryFor` (reads the row, applies `effectiveNotifyPolicy` + TTL, fails open). Wired
at the `/mirror` route in `app.ts` **and** both swarm emitters in `swarm/telegram-notice.ts`. It
landed in its own module rather than `notify-policy.ts` as the contract below assumed; import from
`./ancillary-gate`.

**Verification:** the tests were confirmed to FAIL without the gate (neutered it → 3 targeted
failures), not merely to pass with it. Full suite 1454/376/375 green.

**Production confirmation: PASS**, measured 2026-08-12T03:0x UTC (~5h post-deploy) when the armed
wake fired. The verdict rests on a **positive signal**, not on an absence:

```
journalctl -u pigeon-daemon | grep -E '\[mirror\] quieted|\[swarm-notice\] quieted'
  → 11 suppression events (9 mirror + 2 swarm-notice), all reason=origin
  → across 11 DISTINCT sessions, all 11 confirmed notify_policy='errors-only'
  → 0 surviving mirror/swarm outbox rows for any of them
```

That is the denominator the first window lacked: 11 quiet sessions really did generate ancillary
events after the deploy, and every one was suppressed. Regression control passes — a non-quiet
session with no `session_origin` row still produced a `mirror` row after the deploy (the
`pigeon-w36w` control, PR #100). The PR #94 confounder is moot here: `quieted … reason=origin`
attributes each suppression to *this* code path, so no serve-restart archaeology is required.

> **The instrument this section recommended is partly unusable, and finding out cost two wrong
> answers.** Both are worth internalising because each produced a confident, plausible result.
>
> **The `outbox` table prunes sent rows.** It is a delivery queue, not a history. At verification
> time it held 18 rows total and the pre-deploy baseline (`mirror` 16, `swarm` 4) had **vanished**,
> along with every row from test sessions only 5 hours old. A before/after count over it therefore
> reports `BEFORE: none` — which reads as *the bug never existed* rather than *the evidence
> expired*, and would have been reported as a pass. Restrict both sides of a split to the retained
> window, or use the journal, which persists. §1.7 says a checklist misses what it cannot observe;
> this is the sharper version — **an instrument can stop being able to observe the past.**
>
> **A timestamp carried across a compaction boundary is an unverified claim.** The deploy epoch in
> my own wake payload was `1786520089000`, which is *in the future* relative to the verification;
> every before/after split silently used it (`window hours: -4.55`). Recompute such constants from
> the human-readable time and check the sign of the window before trusting any split.
>
> A third, smaller instance: extracting `sessionId=` from *all* journal lines rather than only the
> `quieted` ones inflated 11 sessions to 32 and manufactured 2 false leaks. Aim the extraction at
> the predicate being measured.

**Note when re-measuring:** item D's PR #94 independently changes which sessions may mirror, and is
plugin-side (needs a *serve* restart, not just a daemon restart). Some of any observed drop may be
theirs. Count by session provenance or record which commit was deployed when you measured.

**Follow-up filed, not done here:** `pigeon-w36w` (P2) — `opencode-launch` should record its launch
prompt in `injected_prompts`, fixing the leak at source for automations that have **no**
`session_origin` row and therefore nothing for this gate to act on. The two fixes are complementary
and neither subsumes the other: the gate suppresses everything for a quiet session; the source fix
suppresses only the launch prompt, but for every session.

> **`pigeon-w36w` is DONE** — pigeon PR #100 (`3c08192`, daemon deployed to cloudbox) added a
> record-only `POST /injected-prompts`, and workstation PR #353 (`2e23aa6`) makes `opencode-launch`
> call it between session create and `prompt_async`. Deployment of the launcher itself is
> `pigeon-0e37` (it is a nix package; no machine runs it until a home-manager switch).
>
> **This is the first end-to-end proof that the leak was real and is now closed**, measured rather
> than asserted — two throwaway sessions, both with **no** `session_origin` row so the gate above
> could not have been what suppressed anything:
>
> | session | outbox kinds | mirror rows |
> |---|---|---|
> | control, unpatched path | `mirror`, `stop` | **1** |
> | patched launcher | `stop` | **0** |
>
> The load-bearing detail is that `injected_prompts` for the launched session **consumed to 0**. A
> leftover count would have meant the hash never matched and the absent mirror had some other
> cause. When re-testing this, check the count — not just the absent row.
>
> **Rejected alternative, recorded because it looks obviously better than it is:** marking the
> launch part `synthetic: true` (the plugin already drops synthetic parts, §"Exclusion 2") would
> have been one line in the caller and no daemon change. Measured on cloudbox: it does suppress the
> mirror and the model does still receive the text, **but the session then never gets a title** — a
> control titled itself in 40 s while the synthetic session still read `New session - <ISO>` minutes
> later. Every CLI-launched topic would be named after its bare path forever and `pigeon-353p`'s
> provisional-name flag would never clear. Cheap seams that touch opencode's own message semantics
> have side effects outside the one behaviour you are aiming at.

<details>
<summary>Original specification, kept for the record (its mirror-scope clause is refuted above)</summary>

**The problem, and it is worse than a duplicate.** `pigeon-qdcb` suppresses the Stop notification
for a declared-quiet session, and the Phase 1 swarm feed then reinstates the noise through a side
door. lgtm re-prompts a session via `/swarm/send` on re-review, so those posts land in a topic that
policy says should be silent. (That mechanism is **reported, not verified** — it came from the
`qdcb` owner, and a review could not find a `reawaken()` symbol in lgtm code. Treat it as motivation,
not premise: the gate is correct regardless of which caller drives the re-prompt.) And because topics are created by the **first** notification, a swarm
post can *create* a topic for a session that was meant to be invisible — the same mechanism that
produced `pigeon-353p`.

> ### CORRECTION 2026-08-11 — the asymmetry below was WRONG, and backwards
>
> **RETRACTED by the `pigeon-qdcb` owner, who measured it.** The struck-through paragraph said to
> gate `swarm` and skip `mirror`. In fact **`mirror` is the PRIMARY leak.** Counted on cloudbox, for
> sessions holding a quiet lgtm origin row (`errors-only`/`none`): **`mirror` 16, `swarm` 4,
> `stop` 1.** The **first** outbox entry for every new lgtm topic is `kind='mirror'` — so the mirror
> is what *creates* the topic for a session whose Stops we correctly silence. That is the visible
> symptom the user reported as "Telegram full of lgtm topics".
>
> **Why the reasoning failed, which generalises well beyond lgtm.** `/mirror` does not detect "a
> human typed into a TUI". It mirrors any user-role message **not found in `injected_prompts`**.
> lgtm starts sessions with `opencode-launch <dir> <prompt>` — the CLI, not daemon injection — so
> its launch prompt is a user message the daemon never recorded and therefore never suppressed.
> **Headlessness is irrelevant; the provenance of the prompt is what matters.** Any automation that
> launches sessions outside the daemon's inject path leaks identically.
>
> This also corrects a claim in `AGENTS.md`, which describes the mirror as showing prompts "typed
> directly into the opencode TUI". That is the intent, not the implemented predicate.
>
> **Ownership changed with it: the `pigeon-qdcb` owner has taken this fix** (their call, their
> policy surface). Do not start a parallel patch. Their plan: gate **both** `/mirror` and the swarm
> feed on `effectiveNotifyPolicy` at insert time, `errors-only`/`none` suppress, fail open on
> lookup error, retraction follows the original's fate. The predicate contract below is unchanged —
> **only the scope and the priority order changed.**
>
> Kept rather than deleted, per the same rule as item C: a wrong claim that silently vanishes gets
> re-derived by the next reader from the same bad reasoning.

~~**Scope is deliberately asymmetric: gate `kind='swarm'` only. Do NOT gate `kind='mirror'`.** Mirror
fires when a human types into a TUI; lgtm sessions are headless, so gating mirror is near-dead code
for exactly the population `qdcb` exists to silence. Revisit only if a human session is ever
declared quiet.~~

**Files:** `packages/daemon/src/swarm/telegram-notice.ts` — `enqueueSwarmTelegramNotice` (`:10`) and
`enqueueSwarmCancelNotice` (`:67`), reached from the `/swarm/send` and `/swarm/schedule` handlers in
`app.ts`. Test: `packages/daemon/test/swarm-telegram-notice.test.ts`.

**Contract (agreed with the `qdcb` owner; they own the predicate's semantics, we own the wiring):**

- Feed it the output of `effectiveNotifyPolicy`, **not** the raw `session_origin` row. That inherits
  the 2h TTL for free, so an adopted long-running session goes audible again on the same clock as
  its Stops.
- `'none'` and `'errors-only'` → suppress. `'all'` and no-row → post.
- Ambiguity or lookup error → **POST** (§1.6).
- **Do not** gate on `isQuietTitle` / the title regex. It is off by default as of PR #88 and is being
  deleted under `pigeon-ycjg`; a new caller would resurrect the dependency that cycle just retired.
- **Retractions follow the fate of the original**, not a fresh policy read. If `w:<msg_id>` was
  posted and policy flipped since, still post `wc:<msg_id>` — check for the original's outbox row
  rather than re-evaluating the predicate. Otherwise you strand a live notice that can never be
  withdrawn.

**Acceptance:** a declared-quiet session receiving a swarm message produces no `w:` row and no
topic; an `all`/no-row session is unchanged; a retraction still posts after a policy flip; policy
lookup throwing still posts. Landing this does not disturb the `qdcb.5` soak, which reads
`[stop] queued` lines only.

</details>

---

### [ ] B. `pigeon-rqyz` + `pigeon-k0eh` (P3) — close the fleet skew

**BLOCKED on location, not on code: this cannot be done from cloudbox.** It needs a session running
**on each host**. Do not schedule it here; hand it to a session on that machine.

**`rqyz` is a subset of `k0eh` — treat them as one deploy and close both.** `k0eh` (filed 08-09)
says devbox and macbook daemons are on pre-`mlc0` code generally; `rqyz` adds chromebook and the
`pigeon-d95y` halves. Same physical action. Scoping `rqyz` as swarm-only would visit the same
machines twice.

**Safe by construction in this direction:** the Cloudflare worker is the single shared producer and
no longer emits `current_state`, so the old daemons' dead handlers are unreachable. Poison-pill risk
exists only in the opposite order (new daemon + old worker), which is why the original deploy was
sequenced worker-first.

**SEQUENCE B LAST, AFTER A / D / E.** All three are daemon-or-plugin code changes, so each one
merged *after* a fleet deploy re-widens the exact skew B exists to close — and D and E.4 are plugin
changes, which need a serve restart on every host, not just a daemon restart (§1.2). Doing B first
and then landing A silently recreates the debt.

**How to start it, given there is no session on those hosts.** This is the part that otherwise
stalls: send `/launch devbox pigeon "<deploy prompt>"` from Telegram. `/launch` still works on the
stale daemons, so the old code can be told to update itself. Without this, a context-free reader
concludes B waits indefinitely on nothing.

**Per host** (`/home/dev/projects/pigeon` or host equivalent), as **separate** bash calls (§1.1):

```bash
git pull --ff-only
npm install
# then restart that host's pigeon-daemon (see cross-device-deployment skill)
```

Then, for the Phase 2 half only, an `opencode serve` restart — **§1.2**. Schedule it when it will
not interrupt live work; on cloudbox this was left to the nightly reset.

**Acceptance, per host:** `POST /mirror` returns 400 (not 404); a TUI-typed prompt yields exactly one
`🧑` post; a Telegram-sent command yields none.

---

### [x] C. `pigeon-rmr2` — WITHDRAWN 2026-08-11. The database is not corrupt.

**The premise did not reproduce, and the bug report was almost certainly an instance of §1.3.**
This item originally claimed that a full-table scan of `part` in
`~/.local/share/opencode/opencode.db` throws `SQLITE_CORRUPT` while bounded scans succeed.

Measured twice on 2026-08-11, independently — once by `adversarial-reviewer-fable` on a coherent
copy (db + `-wal` + `-shm`), once directly against the **live** file opened read-only with its WAL
intact:

```
full scan of part OK: 1712315 rows, 4.48 GB payload, 42.2s
integrity_check: ok
```

"Damage confined to part of the file, bounded scans succeed, unbounded scans throw" is the exact
signature of reading a `.db` **without its `-wal`** — the hazard recorded in §1.3, which had already
produced one false "the feature is silently broken" conclusion during Phase 1 verification. The
original report carried no repro command, so this cannot be proven, only strongly inferred.

**Kept in this file rather than deleted, deliberately.** A withdrawn item that vanishes invites the
next person to re-file it from the same bad measurement. `pigeon-rmr2` is closed with this evidence.

**The lesson is the durable part, and it now sits in §2 as step 0:** this item survived in a bead
for two days and was about to send the first post-compaction session to repair a healthy 7.2 GB
database. Roadmaps preserve claims long after they stop being true — or, here, long after they were
never true.

---

### [ ] D. `pigeon-kq6h` (P3) — subagent misclassified as main when `session.get` fails

**Unblocked. The item with a real correctness argument.**

`packages/opencode-plugin/src/index.ts:301-305`: when `session.get` fails, the fallback registers the
session with `parentID` undefined, so `session-state.ts:74-76` adds it to `mainSessionIds`. A
subagent then counts as a main session. Pre-existing — it already affects stop notifications — but
Phase 2 made it louder, because a misclassified subagent would **mirror its prompts to Telegram**,
and subagent prompts are large (a full task brief).

**DONE in PR #94** (`1a3d552` + `9921886`), reviewed and green. **Not ticked**: a plugin change is
inert until an `opencode serve` restart (§1.2), so this is not live even on cloudbox. Tick it once
merged AND a serve has restarted AND a subagent-heavy session has been observed not mirroring.

**Reproduced first (§2 step 0), and it was real** — unlike item C. Driven through the real plugin
entrypoint with `session.get` rejecting: the subagent mirrored a task brief and emitted a stop
notification; the control (`session.get` succeeds, returns `parentID`) stayed silent.

**The candidate fix above — "fail closed" — was wrong, and the item text was wrong to suggest it.**
Failing closed silences a genuine main session that merely lost a `session.get` race. The real
defect is that **one boolean serves two populations with opposite correct fail directions**:
notifications must fail open (silence is unrecoverable), the mirror must fail closed (it posts a
task brief). So parentage became three states — `main | subagent | unknown` — and each consumer
picks: notifications keep the loose `isMainSession` (unchanged behaviour), the mirror takes a
strict `isConfirmedMain`.

**Two things worth not re-deriving:**

- `session.updated` **already carries the authoritative `parentID`**, and the handler was throwing
  it away in an early return. That is the repair, and it needs no retry machinery. Found by the
  step-2 `oracle-fable` consult.
- But resolution must be **monotonic and evidence-asymmetric**: only a *present* `parentID` acts
  (by demoting), and only on a still-`unknown` session. An update **can omit** `parentID` for a
  session that genuinely has a parent — pinned by `session-title.test.ts` since `2fd9a56` — so
  promoting on absence reintroduces the leak. A symmetric first cut broke that test; the test was
  load-bearing (§1.4) and the design changed, not the test.

**Accepted cost:** a genuine main session whose `session.get` failed never mirrors again. It still
receives every notification. Follow-up `pigeon-nwrt`.

**What the review caught, and the transferable lesson.** All six original tests asserted the mirror
*withholding*; none asserted it ever *posting*. Wiring the mirror predicate to a constant `false`
killed mirroring globally and the **entire 2160-test suite still passed** — and it would have been
invisible in production too, because a missing post is by design a silent gap. A positive control
was added and **verified by mutation**. Generalise this: for any change whose failure mode is
*silence*, negative tests alone are not coverage, because both the bug and the guard look identical
from the outside.

---

### [ ] E. `pigeon-pre9` (P4) — deferred polish from the adversarial review

**All four written, reviewed and merged in PR #99 (`e5addda`). NOT ticked: like D, the plugin half
is inert until an `opencode serve` restart (§1.2).** Tick when a restarted serve has run the plugin
half — the same restart D is waiting for, which is why they were landed together.

Four NICE-TO-HAVEs, all deliberately deferred, none urgent. Done together in one PR, as specified.

**Item 4 pairs naturally with D** — both are `message-tail.ts`/plugin changes needing the same serve
restart, so landing them close together spends one restart instead of two. That is what happened:
D merged as PR #94, E as PR #99, minutes apart.

> **CORRECTION #E1 (2026-08-11, written while doing the work).** Item 3's stated failure mode below
> — "leaks its count for 15 min" — is **impossible**, and the bead said the same thing. `hashPrompt`
> is a raw sha256 with no normalisation, so any later prompt with a matching hash is also
> whitespace-only and is dropped by the `!text.trim()` check *regardless of any count*. A
> whitespace-hash count can never change a mirroring decision. The reorder still shipped, as
> **hygiene**: the row is freed at echo time instead of at the TTL sweep, and "consumed exactly
> once" stops being conditional on the shape of the text. Found by `adversarial-reviewer-fable`
> checking whether the scenario was reachable rather than whether the code matched the item.

> **CORRECTION #E2 (2026-08-11).** The first implementation of item 1 introduced a **new instance of
> the assistant-leak** it was supposed to avoid, and the review caught it by probe rather than by
> reading. `Map.set` on an existing key keeps the entry's ORIGINAL insertion position, so eviction
> ordered by insertion tracked message *creation*, not activity. A long-streaming assistant message
> therefore sat at its original position while peers filled the cap, lost its `currentMessageId`
> protection the instant the next message began, and was evicted milliseconds after its last delta;
> a late text part for it then took the `roleInfo === undefined` branch and mirrored assistant
> output into Telegram as user text. Fixed by delete-then-set (recency refresh), pinned by a test
> verified to fail without it. **The general lesson: an eviction policy's safety argument is a claim
> about ordering, and Map insertion order is not the order you assume it is.**

> **Line references corrected 2026-08-11.** The four below were transcribed from bead `pigeon-pre9`
> and were **wrong against the tree this file sits on** — `app.ts:100-124` is `parseSwarmSendBody`,
> so a reader would have landed in swarm-validation code and concluded the item was nonsense. All
> four are substantively real; only the pointers lied. Verified line-exact on `origin/main` at
> `4a454ff`. The bead carries the same correction.

1. `messageRoles` (`packages/opencode-plugin/src/message-tail.ts` — declared `:86`, written `:109`,
   pruned only at `:321-323` via `clear()`) grows unbounded for a long-lived active session. Small
   but indefinite.
2. The empty footer leaves a trailing blank line on every mirror (`packages/daemon/src/app.ts:833`,
   `const footer = new TgMessageBuilder().build()`, plus `split-message.ts`). Telegram trims it;
   cosmetic.
3. Whitespace-only text returns at `app.ts:809` **before** `injectedPrompts.consume` at `:816`, so an
   injected whitespace-only prompt leaks its count for 15 min. Near-unreachable.
4. **Log when the assistant-message buffer-cancel fires** (`message-tail.ts:122-123`). This is the
   only guard on the assistant-leak vector — a part arriving >500ms before its `message.updated`
   would flush assistant deltas as a user mirror — and the guard is currently invisible in the logs.
   Worth more than the other three: it is the difference between knowing that vector is dormant and
   assuming it.

**What shipped, per item:** (1) `messageRoles` capped at 2000 with least-recently-*updated*
eviction, skipping any session's in-flight assistant message, and announcing itself once when the
cap first engages; (2) `splitTelegramMessage` joins only non-empty components, so an empty footer
contributes no separator — which exposed and fixed a latent hole where a body ending in an unpaired
high surrogate was sanitised only by accident; (3) `consume` before the whitespace return, as
hygiene (see CORRECTION #E1); (4) the buffer-cancel logs session, message and discarded part count.

**Evidence:** `npm run test` exit 0 (daemon 71, plugin 23, worker 2 files), `npm run typecheck`
exit 0, both re-run on current `main` after PR #97's quiet-policy gate landed underneath this work.
The resulting order in `/mirror` is consume THEN the quiet gate, which is the right way round — a
quiet session still consumes its injected counts rather than accumulating them until the TTL sweep.

**Two things worth carrying forward, both from how the review found its findings:**

- It **probed the tests, not just the code**, and proved one of my "positive controls" was theatre:
  it passed with `pruneMessageRoles` replaced by `messageRoles.clear()`, because a user message with
  no role entry still mirrors through the undefined-role fallback. Role presence is behaviourally
  invisible for user messages, so only a white-box assertion discriminates. **The §1.7/§2 lesson
  generalises: a positive control is itself a claim that needs checking.**
- It **asked whether each stated failure mode was reachable at all**, which is what produced
  CORRECTION #E1. Step 0 says reproduce the symptom; item 3 shows that a symptom can be
  unreproducible while the fix is still worth shipping — in which case the honest move is to ship it
  with a corrected rationale, not to withdraw it and not to leave the false rationale standing.

**Discovered here, already known:** the `lease-CAS concurrency proof` CI job is flaky — it failed
PR #94 on a **docs-only** merge commit and passed on a bare re-run. That is `pigeon-1lha` (P2,
filed 08-08), which already has the root cause: `SQLITE_BUSY` on concurrent schema init, no
`busy_timeout` pragma, ~20% failure rate measured on pristine `main`. I filed a duplicate
(`pigeon-j14t`) before searching, then closed it and moved the one new fact onto `pigeon-1lha`:
**the flake fires in GitHub Actions too, where the job is advisory and therefore cannot block.** A
flaky advisory check trains everyone to wave it through, including the day it is right.

---

## §4 — NOT OURS

Held by the session working `pigeon-qdcb` ("Pigeon LGTM filtering gaps"), confirmed by direct
consultation 2026-08-11. **Do not touch, do not wait on, do not re-file:**

- `pigeon-qdcb.5` — mid-soak. The lgtm quiet-title regex is off by default as of PR #88 (`b4daef7`);
  suppression now comes solely from `session_origin` provenance. `PIGEON_QUIET_TITLE_LAYER=on`
  restores it in one restart. Soak verdict due **08-19**.
- `pigeon-ycjg` — the actual regex deletion, blocked on that soak.
- `pigeon-qdcb.4` / `.10` / `.11` — parked by them; nothing waits on them.
- `pigeon-9jz`, `pigeon-k4c.*` — other tracks.

**Resolved, for the record:** `pigeon-353p` is CLOSED. Fixed by PR #86 (`5bb29d9`), verified live in
D1 — the `name_provisional` column exists and 361 topics carry it with 64 still provisional, and
those 64 prove the **worker** deployed too, since only post-#86 code writes that flag. The 64 are a
standing pool, not a backlog: a topic that goes provisional and whose session ends before any titled
notification arrives stays provisional forever, by design.

---

## §5 — Reference

- Parent roadmap: `docs/plans/2026-07-31-delivery-hardening-roadmap.md` — this work is `F6`/`F6a`,
  and CORRECTION #10 there records why "the feature track is worker-only" stopped being true.
- Epic design + plan: `docs/plans/2026-08-10-telegram-visibility-swarm-and-tui-design.md` (read the
  **Task 10 spike result** section appended at the end) and
  `docs/plans/2026-08-10-telegram-visibility-implementation.md`.
- On-hold design this feature is deliberately invariant to:
  `docs/plans/2026-08-09-swarm-quiet-messages-design.md` — the reason the swarm hook fires at
  **insert**, not at `handed_off`.
- Behaviour documented in `AGENTS.md` under "TUI-typed prompt mirror".
- Facts established empirically during the epic, worth not re-deriving:
  - A question reply produces **no** user-role message; the answer is the `question` tool's output on
    the assistant message. Telegram button presses therefore cannot echo.
  - A **compaction marker** is a user-role message whose only part is `{type: "compaction"}`, and it
    is **not** flagged `synthetic`.
  - A post-compaction **resumption prompt** is an ordinary user text message and does mirror — this
    is correct, not a leak.
  - `prompt_async` materialises the user message within **±34ms** of handoff (measured across 300
    rows), so the 15-min suppression TTL has ~1800× headroom.
