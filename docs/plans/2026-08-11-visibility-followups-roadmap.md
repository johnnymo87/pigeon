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
| **A** | `pigeon-ywlg` | Gate the swarm feed on notify policy | **Yes** — needs `shouldEmitAncillary` from `pigeon-qdcb.5` |
| **B** | `pigeon-rqyz` + `pigeon-k0eh` | Fleet deploy (devbox, macbook, chromebook) | **Yes** — needs a session ON each host |
| **C** | `pigeon-rmr2` | `opencode.db` full scans of `part` throw `SQLITE_CORRUPT` | No |
| **D** | `pigeon-kq6h` | Subagent misclassified as main when `session.get` fails | No |
| **E** | `pigeon-pre9` | Deferred polish from adversarial review | No |

**Start with C or D** — they are the only unblocked items, and D is the one with a correctness
argument. A and B are both blocked on something outside this session's control; do not burn a cycle
discovering that again.

---

## §1 — OPERATING HAZARDS

### 1.1 Never chain `git` with a heavy command on cloudbox

A bash command whose text contains a bare `git` token is **exempted** from the `oc-agent.slice`
scope and runs inside `opencode-serve@<port>.service` instead: `MemoryMax=14G`, `OOMPolicy=stop`,
shared with the serve and every peer session on that port. Any OOM there stops the whole serve,
which kills the plugin, so `session.idle` never fires and Telegram notifications stop **silently** —
it reads as a pigeon bug. This cost a peer session a serve (`pigeon-8bif`).

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

### 1.7 The verification checklist misses what it cannot observe

Phase 2's burn-in checklist was entirely behavioural, so the one task with no runtime symptom —
the AGENTS.md update — silently did not happen, and the bead was closed claiming complete. A
checklist derived from observable behaviour will systematically omit documentation and roadmap
steps. Put them in the ritual (§2) rather than trusting them to a symptom.

---

## §2 — THE PER-ITEM RITUAL

Every item in §3 runs this sequence. It is the user's standing instruction.

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
npm run test        # expect: 66+ / 21+ / 2 files, exit 0
npm run typecheck   # expect: exit 0
```

---

## §3 — THE ITEMS

### [ ] A. `pigeon-ywlg` (P2) — gate the swarm feed on notify policy

**BLOCKED** on `shouldEmitAncillary` landing in `packages/daemon/src/notify-policy.ts`. That
predicate is owned by the session holding `pigeon-qdcb` (see §4); as of 2026-08-11 the file exports
`effectiveNotifyPolicy` (`:76`), `decideNotify` (`:172`), `explainQuiet` (`:230`) — no
`shouldEmitAncillary` yet. **Check for it before scheduling this item.**

**The problem, and it is worse than a duplicate.** `pigeon-qdcb` suppresses the Stop notification
for a declared-quiet session, and the Phase 1 swarm feed then reinstates the noise through a side
door. lgtm's `reawaken()` re-prompts via `/swarm/send`, so every re-review posts into a topic that
policy says should be silent. And because topics are created by the **first** notification, a swarm
post can *create* a topic for a session that was meant to be invisible — the same mechanism that
produced `pigeon-353p`.

**Scope is deliberately asymmetric: gate `kind='swarm'` only. Do NOT gate `kind='mirror'`.** Mirror
fires when a human types into a TUI; lgtm sessions are headless, so gating mirror is near-dead code
for exactly the population `qdcb` exists to silence. Revisit only if a human session is ever
declared quiet.

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

### [ ] C. `pigeon-rmr2` (P2) — `opencode.db` full scans of `part` throw `SQLITE_CORRUPT`

**Unblocked. Good first pickup.** Found incidentally during the Phase 2 adversarial review, unrelated
to that branch.

A full-table scan of `part` in `~/.local/share/opencode/opencode.db` throws `SQLITE_CORRUPT`;
bounded rowid-range scans succeed, so the damage is confined to part of the file. **Nothing
user-visible is broken today** — only unbounded queries hit it — which is precisely why it will
ambush the next person who writes an ad hoc transcript query, and why it silently constrains every
such query written until then.

**Approach:** `PRAGMA integrity_check` to size the damage first, then decide between `VACUUM INTO` a
fresh file and accepting it. **Do not run a destructive repair against the live DB while sessions
are attached** — every running session on this host writes to it. Work on a copy (§1.3), and note
that this file is opencode's, not pigeon's, so a fix here is operational, not a code change; there
may be no PR (step 5 of §2 is conditional for exactly this reason).

---

### [ ] D. `pigeon-kq6h` (P3) — subagent misclassified as main when `session.get` fails

**Unblocked. The item with a real correctness argument.**

`packages/opencode-plugin/src/index.ts:301-305`: when `session.get` fails, the fallback registers the
session with `parentID` undefined, so `session-state.ts:74-76` adds it to `mainSessionIds`. A
subagent then counts as a main session. Pre-existing — it already affects stop notifications — but
Phase 2 made it louder, because a misclassified subagent would **mirror its prompts to Telegram**,
and subagent prompts are large (a full task brief).

**Candidate fix:** fail closed — do not add to `mainSessionIds` on the error fallback. **Check the
stop-notification implications before changing it**, since that path reads the same set and a
fail-closed change there means a real session stops notifying. That trade runs against §1.6, so it
needs an explicit argument rather than a default — a good candidate for the §2 step-2 consult.

---

### [ ] E. `pigeon-pre9` (P4) — deferred polish from the adversarial review

Four NICE-TO-HAVEs, all deliberately deferred, none urgent. Do them together in one PR or not at all.

1. `messageRoles` (`packages/opencode-plugin/src/message-tail.ts:66,88`) grows unbounded for a
   long-lived session; pruned only on `clear()`. Small but indefinite.
2. The empty footer leaves a trailing blank line on every mirror (`app.ts:124` +
   `split-message.ts:77`). Telegram trims it; cosmetic.
3. Whitespace-only text returns before `consume` (`app.ts:100-102` vs `:107`), so an injected
   whitespace-only prompt leaks its count for 15 min. Near-unreachable.
4. **Log when the assistant-message buffer-cancel fires** (`message-tail.ts:99-103`). This is the
   only guard on the assistant-leak vector — a part arriving >500ms before its `message.updated`
   would flush assistant deltas as a user mirror — and the guard is currently invisible in the logs.
   This one is worth more than the other three: it is the difference between knowing that vector is
   dormant and assuming it.

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
