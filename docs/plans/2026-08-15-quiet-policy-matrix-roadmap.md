# Quiet-Policy Matrix Roadmap

**Created 2026-08-15**, out of the work that made the `my-podcasts` pipeline stop posting to
Telegram.

**Tracking bead: `pigeon-5ies`.**

This is a **spine**. It is expected to outlive compactions, worktree deletions and SDD runs. Its
predecessors — `docs/plans/2026-08-11-visibility-followups-roadmap.md` and
`docs/plans/2026-07-31-delivery-hardening-roadmap.md` — earned that shape by surviving ~10
compactions between them. Same discipline applies here.

---

## How to use this file

**On resuming:** read §0 (where you are), then §1 (hazards — every entry cost real time or nearly
cost real data), then §2 (the ritual), then the first unchecked item in §3.

**Priorities and statuses here are stale snapshots. Read them from `bd`, not from this file.** Rule
inherited from CORRECTION #9 of the hardening spine; right every time so far.

**Rules:**

- Mark an item `[x]` only when its tests pass AND it is merged AND, where it deploys, it is verified
  running. Never on intent. "Merged" is not "deployed".
- One task per commit, conventional-commit style.
- If a claim in this file turns out to be wrong, amend it **in the same commit as the fix**, and say
  why. This file has authority only because previous versions were corrected when they were wrong.

---

## §0 — WHERE YOU ARE

**The problem that started this is already solved, and it was not solved in this repo.** Do not
re-solve it.

The `my-podcasts` pipeline was creating an unattended opencode session every ~15 minutes. Each one
posted a Stop notification and a mirror of its own launch prompt to Telegram, and because a forum
topic is created by a session's **first** notification, each run also stranded a topic behind it.

| Thing | Value |
|---|---|
| Sessions measured | **122** in 6 days (2026-08-06 → 08-12), one every ~15 min |
| Of those, never titled | **103** — died before opencode's summarizer ran |
| Fix | `my-podcasts` commit **`c2fea76`**, `pipeline/opencode_client.py` |
| Mechanism | `create_session()` POSTs `/session-origin` `{origin:"my-podcasts-pipeline", notify_policy:"none"}` before returning |
| Deployed | devbox, 2026-08-15 05:21 — `my-podcasts-consumer` restarted; daily timers pick it up on next spawn |
| Topics cleaned | **103** deleted via `deleteForumTopic` + D1 row drop; topics table 508 → 405 |

**What is left is the pigeon-side debt that work exposed.** Three items, none of which the
`my-podcasts` fix depends on.

| Item | Bead | What | Sequence |
|---|---|---|---|
| **A** | `pigeon-twdw` (P2) | Extract one `resolveEffectivePolicy` for all four emission sites | **FIRST** — see §1.1 |
| **B** | `pigeon-c501` (P1) | `POST /question-asked` bypasses the policy matrix entirely | After **A** |
| **C** | `pigeon-l4iw` (P2) | Move quiet expiry onto the row (`expires_at`), drop the global env TTL | After **A** |

**A is sequenced first despite being the lowest priority**, and that inversion is the single most
important thing in this file. B is a P1 bug, but fixing it in place means teaching a *fourth* call
site a matrix that three other call sites each derive differently — which is precisely how `B`
itself came to exist. Do A first and B becomes a few lines inside one function.

### The design that was REJECTED, so nobody re-proposes it

The obvious answer to "stop my-podcasts posting to Telegram" is a **directory-scoped quiet rule**: a
`quiet_dirs` table, matched against `sessions.cwd`, evaluated live, no TTL. It was designed in full
and taken to `adversarial-reviewer-fable`, who returned *buy-in with required changes*.

**It was rejected anyway, on a requirement that surfaced after the review**: the user wanted the
*automated* activity in that directory silenced, not their own hand-driven sessions in the same
directory. A `cwd` predicate cannot tell a human's prompt from a robot's — both have the same
working directory. Declaring at the source can, because the automation has exactly one session-
creation choke point (`pipeline/opencode_client.create_session`) and a human does not go through it.

Do not revive the directory layer without a requirement that is genuinely directory-shaped. If one
appears, fable's review is still valid and its required changes still apply — and note that **A and
B are two of them**, which is part of why they are here at all.

---

## §1 — OPERATING HAZARDS

### 1.1 The matrix is derived in three places and omitted in a fourth

| Site | File | What it does |
|---|---|---|
| `POST /stop` | `packages/daemon/src/app.ts:932-983` | Inlines the origin read, TTL application and `decideNotify`, with **three** separate fail-open catch blocks |
| mirror + swarm | `packages/daemon/src/ancillary-gate.ts:48` | Re-derives roughly half of it |
| `explainQuiet` | `packages/daemon/src/notify-policy.ts:230` | Delegates to `decideNotify`, so it cannot drift — but has **no production caller** |
| `POST /question-asked` | `packages/daemon/src/app.ts:1081` | **None of it.** Gates on `session.notify` alone |

Two production leaks have already come out of this shape: `pigeon-8zqt` (mirror and swarm feed
ignoring the policy) and `pigeon-c501` (item **B**). Adding anything to the matrix in its current
form means remembering four places; the historical record says you will remember three.

### 1.2 Expiry resolves to `'all'`, not `null` — it SEIZES the decision, it does not release it

`effectiveNotifyPolicy` returns `policy: 'all'` when an automated quiet row ages out
(`notify-policy.ts:96-101`). The load-bearing comment is at `notify-policy.ts:49-58`: expiring to
`null` would fall through to the title-regex layer, which matches ~88% of lgtm titles, so an expired
row would stay muted. Expiring to `'all'` deliberately overrides everything downstream.

**Consequence for any new layer:** a layer placed *below* origin must be evaluated **before**
`effectiveNotifyPolicy`, or an expired row silently defeats it. This was the trap fable found in the
rejected directory design, and it is the same trap for any future layer.

### 1.3 The clock is `created_at`, not `updated_at`

`notify-policy.ts:65-74`. lgtm's reconciliation writer re-declares identically; an `updated_at`
clock would extend quiet forever, which is the exact bug the TTL exists to kill. Known consequence,
documented there: a **reused** session id inherits the old `created_at` and is born expired, so it
shouts. Loud, not silent — the acceptable direction — but it looks like a spam bug to whoever hits
it. Change this clock deliberately or not at all (item **C** must preserve it).

### 1.4 Topic names encode no provenance, and `LIKE '%thing%'` matches TITLE TEXT

Cleaning up the 103 stranded topics nearly destroyed two unrelated sessions. `topics.name` is
`<title> · <dir>`, so a pattern intended to match a *directory* also matches any session whose
**title** happens to mention it:

```
Suppress LGTM Telegram (my-podcasts) · ~/projects/workstation   <- NOT a my-podcasts session
my-podcasts LGTM Telegram filter     · ~/projects/pigeon        <- NOT a my-podcasts session
```

The worker stores no per-topic provenance — no origin, no `dir` column (see AGENTS.md on why
`/rename` cannot re-derive a path). The only provable split available was *placeholder title ⇒ the
session died before the summarizer ran ⇒ automation*. Anchor on the ` · <dir>` **suffix**, never on
a bare substring, and pair any destructive statement with a redundant predicate:

```sql
DELETE FROM topics WHERE session_id IN (...)
  AND (name = '~/projects/my-podcasts' OR name LIKE 'New session - %· ~/projects/my-podcasts');
```

### 1.5 The outbox is a queue, not a history

`packages/daemon/data/pigeon-daemon.db` `outbox` held **2 rows** while the system was demonstrably
posting to Telegram every 15 minutes. It cannot answer "what did we send?" — use it only for what is
in flight. (Same correction as PR #104.) To measure delivered traffic, count topics in the worker's
D1, or read the daemon's `sessions` rows.

### 1.6 `POST /session-origin` deliberately accepts a session the daemon has never seen

`app.ts:705-707`. A launcher declares between session creation and the first prompt, which is before
the plugin registers the session. **This is the whole point of the route** — do not "fix" it by
adding an existence check, and do not add a retry loop in a caller on the assumption that it 404s.
Verified live 2026-08-15: declare → `GET /session-origin` returns the row → delete, for an id the
daemon had never seen.

### 1.7 Auth is per-host, and a missing header fails as silence

Devbox runs the daemon with auth **disabled**; cloudbox runs it **enabled**
(`/run/secrets/pigeon_daemon_auth_token`). A client that omits the bearer gets a 401 — and for
anything writing a *quiet* policy, a 401 means the noise silently comes back. Any new declaring
client must read the token (env, then file), as `my-podcasts`'s `_daemon_auth_headers()` does.

### 1.8 House rule: ambiguity resolves toward DELIVERING

Every error path in this subsystem fails **open**. A spurious post is recoverable noise; a silently
withheld one is invisible. `ancillary-gate.ts:38-47` states it; `/stop` implements it three times
over (§1.1). Any change here must preserve the direction — and note that "the user asked for
silence" is not a reason to invert it, because the failure being guarded is *the code being wrong*,
not the policy being wrong.

---

## §2 — THE PER-ITEM RITUAL

Every item in §3 runs this sequence. It is the user's standing instruction, and it is the same
ritual as §2 of the visibility spine.

0. **Reproduce the item's stated symptom before designing anything.** If it does not reproduce, the
   item is the bug — amend or withdraw it and stop. (Item **C** of the visibility spine sat in a
   bead for two days on a premise that never reproduced.)
1. **Compact** if context is heavy. Persist first (`preparing-for-compaction`): beads updated, this
   file current, resumption prompt pointing at *this file by path* and the item letter.
2. **Optional `oracle-fable` consult** — for a design question where being wrong is expensive.
   Skip it for mechanical work; say in the bead that you skipped it and why.
3. **SDD if it genuinely decomposes** — fresh `implementer` per task, then `spec-reviewer` /
   `code-reviewer`. A one-file change does not decompose; do not manufacture tasks to fit the ritual.
4. **`adversarial-reviewer-fable`** on the finished diff, before any deploy and before the PR.
   Its review of the rejected directory design produced items **A** and **B**, so it has already
   paid for itself on this spine specifically.
5. **PR** if code changed. Description carries the *reasoning*, not just the change list.
6. **Update this roadmap** — tick the item, record evidence, file beads for anything discovered.
   **This step is the one that gets skipped.** It is not optional.

**Verify before claiming.** Re-run the full suite yourself; do not take an implementer's report for
it.

```bash
npm run test        # expect exit 0
npm run typecheck   # expect exit 0 across all three workspaces
```

---

## §3 — THE ITEMS

### [ ] A — Extract one `resolveEffectivePolicy` (`pigeon-twdw`, P2)

**Do this first.** See §0 for why a P2 outranks a P1 here.

**Shape:** `resolveEffectivePolicy(storage, sessionId, now): {policy, layer}`, consumed by `/stop`,
`/question-asked`, `/mirror` and `swarm/telegram-notice.ts`.

**Constraints:**

- Preserve fail-open on every path (§1.8). `/stop` currently has three distinct catch blocks with
  three distinct fallbacks — read them before collapsing them; they are not interchangeable.
- `swarm/telegram-notice.ts:33` fetches the target session *after* calling the gate. A resolver that
  needs more session fields requires a small reorder there.
- `explainQuiet`'s `never` exhaustiveness guard (`notify-policy.ts:271-282`) must keep compiling —
  it is the backstop that forces a new suppressing layer to be handled. Do not defeat it.

**Done looks like:** one function, four callers, no behaviour change, full suite green. A pure
refactor — if the diff changes any delivery decision, something is wrong.

**Payoff beyond this spine:** the title-layer retirement (`pigeon-qdcb.5`) becomes a deletion in one
place instead of three.

---

### [ ] B — `POST /question-asked` bypasses the matrix (`pigeon-c501`, P1)

**Symptom:** a session with `notify_policy='none'` still posts its questions to Telegram, and since
the payload carries `threaded: true` + `dir` (`app.ts:1160-1161`), a question also **creates** the
forum topic the quiet policy exists to prevent.

**Reproduce first (§2.0):** declare a session quiet, then have it ask a question; watch a topic
appear.

**The decision this item must make, deliberately:** suppressing a question means a **headless**
session blocks forever with nobody able to answer it. For a hand-driven session the question is
visible in the TUI, so suppression costs nothing.

- (a) Suppress under `'none'`, deliver under `'errors-only'` — on the theory that a blocked session
  is a failure, and `errors-only` exists so failing automation can still shout. **Recommended.**
- (b) Always deliver questions; document that a quiet session can still create a topic.
- (c) Suppress under both; accept the headless deadlock.

Record which was chosen and why, in the bead **and** here.

---

### [ ] C — Move quiet expiry onto the row (`pigeon-l4iw`, P2)

**Symptom:** `DEFAULT_DECLARED_QUIET_TTL_MS` (`notify-policy.ts:16`) is a single global dial
(`PIGEON_DECLARED_QUIET_TTL_MS`) sized against **one** workload — measured lgtm lifetimes of 0–59
min, ~2× headroom.

**Why now:** a second declaring writer now exists in production — `my-podcasts` (`c2fea76`,
`origin='my-podcasts-pipeline'`). Its sessions are minutes long, so 2h happens to be ample. That is
luck, not design; the third writer will not be so lucky.

**The category error underneath:** the TTL exists because a declared/inferred suppression is an
automated *guess* that could otherwise silence real work forever. A human's standing rule is not a
guess. `source='override'` is already exempt (`notify-policy.ts:86`), so the exemption concept
exists — it is just only reachable via `POST /sessions/enable-notify`, which only ever writes
`policy='all'`.

**Shape:** an `expires_at` column on `session_origin`, set by the writer. lgtm writes `now+2h`; a
human or standing rule writes `null`. The global env dial goes away.

**Must survive the change:** §1.3 (the `created_at` clock) and §1.2 (expiry resolving to `'all'`).
Both have load-bearing comments; move them with the code.

---

## §4 — EVIDENCE APPENDIX

Measurements taken 2026-08-15 while diagnosing the `my-podcasts` noise. Recorded so the next reader
does not re-measure, and so a claim above can be checked rather than trusted.

**Session volume** (daemon SQLite, `sessions` where `cwd LIKE '%my-podcast%'`):

- 122 rows, oldest `2026-08-06 04:34`, newest `2026-08-12 05:53`.
- Inter-creation gaps, from the ISO stamps in placeholder titles: `15,15,15,15,…` minutes,
  essentially unbroken for 6 days.
- 103 placeholder-titled (`New session - <ISO>`), 19 real-titled.
- All had `notify=1`. **Zero** `session_origin` rows — nothing was declared, so nothing was
  suppressed.
- Zero `injected_prompts` rows, which is why every launch prompt mirrored: the pipeline creates
  sessions out-of-process, so the daemon never recorded the prompt it did not inject.

**Topic volume** (worker D1 `pigeon-router`, `topics`), before cleanup: 508 total, 141 matching
`%my-podcasts%` — of which 70 bare `~/projects/my-podcasts`, 33 `New session - <ISO> · …`, 36 real-
titled, and **2 false positives from other directories** (§1.4). After: 405.

**Deletion run:** 103 `deleteForumTopic` calls, 1/sec with `retry_after` backoff — `deleted=103
alreadyGone=0 failed=0`, no rate limiting encountered. D1 reconciled in one statement, 103 rows.

**Single choke point, verified:** exactly one `POST /session` exists in the whole `my-podcasts`
repo (`pipeline/opencode_client.py`), so declaring inside `create_session()` covers every automated
session that repo can produce.
