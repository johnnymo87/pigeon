# Delivery Hardening Roadmap — post-forum-topics

**Created 2026-07-31**, immediately after `TELEGRAM_TOPICS_ENABLED` was flipped on in production.

**Tracking bead: `pigeon-l0w`.**

This is a **spine**. It is expected to outlive many compactions, SDD runs, and adversarial reviews.
Its predecessor — `docs/plans/2026-07-25-telegram-forum-topics-plan.md` — survived ~10 compactions,
two worktree deletions, and five checkpoints. Same discipline applies here.

---

## How to use this file

**On resuming:** read §0 (where you are), §1 (the operating hazards), §2 (the cycle protocol),
then the first unchecked cycle in §4. Do not skim §1 — every entry in it cost real time to learn.

**Rules:**

- Mark a cycle `[x]` only after its tests pass AND it is merged. Never on intent.
- One task per commit. Conventional-commit style (`feat(daemon):`, `fix(worker):`, `docs:`).
- **Commit and push at every task boundary, not every session boundary.** See §1.1.
- If a claim in this file turns out to be wrong, amend it in the same commit as the fix and say why.
  This file has authority only because previous versions were corrected when they were wrong.

---

## §0 — WHERE YOU ARE

**Forum topics are LIVE in production as of 2026-07-31 03:03 UTC.**

| Thing | Value |
|---|---|
| Worker version | `5c7381f3-a970-4916-a29f-49a693a3c1ef` |
| `TELEGRAM_TOPICS_ENABLED` | `"true"` |
| `ALLOWED_CHAT_IDS` | `8248645256,-1004391832753` — **both, deliberately** |
| Supergroup | "Pigeon V2", `-1004391832753`, `is_forum: true` |
| Daemon `TELEGRAM_CHAT_ID` | `-1004391832753` (sops, cloudbox) |
| Branch | `feat/forum-topics-phase2`, fast-forwarded to `origin/main` |

**Rollback is the flag, not a code revert.** Set `TELEGRAM_TOPICS_ENABLED = "false"` in
`packages/worker/wrangler.toml` and deploy. **Keep BOTH chat ids allowed** until the daemon secret is
reverted and the outbox has drained — narrowing the allowlist first permanently loses notifications
(outbox terminal failure at 10 attempts / 15 min). Full procedure:
`docs/runbooks/telegram-forum-migration.md`.

**Still open from the migration:** drop the old DM chat id from `ALLOWED_CHAT_IDS` after burn-in.
Do this LAST, after §4 is done — it is the only irreversible step.

### Test baseline — regressions are measured against this

| Package | Tests |
|---|---|
| `@pigeon/daemon` | **778** passed, 1 skipped |
| `@pigeon/opencode-plugin` | **305** passed |
| `@pigeon/worker` | **279** passed |

Total **1362**. **`npm run typecheck` is CLEAN — 0 errors.** The 4 `lease-cas` errors that the
previous plan told every task to ignore were fixed by PR #8. **Any typecheck error is now a real
regression.**

---

## §1 — OPERATING HAZARDS

Each of these cost real time. They are not hypothetical.

### 1.1 The nightly reset prunes worktrees — this has happened TWICE

A workspace reset at ~03:00 deletes `.worktrees/*`. It hit this project on 2026-07-27 and again
mid-session on 2026-07-30. **Nothing was lost either time, only because every task had been committed
and pushed.** Recovery is:

```bash
cd /home/dev/projects/pigeon
git worktree add .worktrees/<name> <branch>
```

**Anything uncommitted at 03:00 is gone.** This is a sharper hazard than the shared-worktree rule,
because the destroyer is a clock rather than a peer.

### 1.2 `sudo` appears broken but is not

```
sudo: /nix/store/.../bin/sudo must be owned by uid 0 and have the setuid bit set
```

The PATH injected into agent bash calls puts the non-setuid Nix-store `sudo` ahead of NixOS's setuid
wrapper. **Use `/run/wrappers/bin/sudo`.** An interactive human shell is unaffected.

### 1.3 Never work in `/home/dev/projects/pigeon` itself

That checkout runs the LIVE production daemon from its source (`tsx` execs
`packages/daemon/src/index.ts`) and hosts the live routing DB at
`packages/daemon/data/pigeon-daemon.db`. Work in a linked worktree.

The live DB is **untracked**, so `git reset --hard` there cannot destroy it — verified 2026-07-30.
That does not make tree-wide destructive git ops acceptable there; it means the one time it was
necessary, the safety argument was checked rather than assumed.

### 1.4 A full disk masquerades as unrelated failures

On 2026-07-30 the root filesystem hit **100% (0 bytes free of 393G)**. It presented as:
a D1 query reporting `no such column` (it was `ENOSPC`), and **143 bogus worker test failures**
caused by two `npm install` runs that silently truncated `node_modules`.

- **Always read raw output before concluding.** A parsed/grepped result turned a disk error into a
  phantom schema failure.
- **After any disk event, `rm -rf node_modules && npm install` before believing a test result.**
- The hog was **Docker: 39.4G** of unused images (`docker image prune -a`). Nix GC recovered
  ~0.2 MiB — the store was nearly all live. Check Docker first.
- Keep the disk under 80%; above ~90% a `nix-gc` I/O storm can stop sshd from answering.

### 1.5 Do not conclude "impossible" from probing default paths

I reported the sops age key "MISSING" after checking three conventional locations, and told the user
they'd have to do the edit. Wrong: `hosts/cloudbox/configuration.nix:281` declares
`sops.age.keyFile = "/var/lib/sops-age-key.txt"`. **Read the config that declares the thing.**

Editing a secret:
```bash
cd ~/projects/workstation
/run/wrappers/bin/sudo env SOPS_AGE_KEY_FILE=/var/lib/sops-age-key.txt \
  sops --set '["<key>"] "<value>"' secrets/cloudbox.yaml
# then: chown back to dev if needed, nixos-rebuild switch --flake .#cloudbox
```

### 1.6 `grep -c` returning 0 exits 1

`grep -c foo file && python3 ...` — when the count is zero, grep exits **1** and short-circuits the
`&&`, so the next command never runs. This silently skipped a file edit; only an unchanged test count
revealed it. Do not chain a mutation behind a `grep -c` guard.

### 1.7 Attribution discipline — check timestamps before blaming the recent change

`pigeon-t5f` looked exactly like a topics regression: errors appeared minutes after the flag flip.
They were **40 seconds before it**. The memorable event was not the cause. Establish a timeline
before attributing, and prefer a mechanism that explains the *number* you see (exactly 20 successes
⇒ the documented 20/min cap) over one that merely correlates.

### 1.8 Worker tests share ONE D1 instance; two tables are UNIQUE-constrained

`topics` has a partial unique index on `(chat_id, message_thread_id)`; `messages` on
`(chat_id, message_id)`. A hardcoded id that collides passes in isolation and fails only in the full
suite with `D1_ERROR: UNIQUE constraint failed`, which looks nothing like a logic bug. Pick ids far
outside every other test's range — the 991500s and 992100s are taken. `nextMsgId()` is scoped to one
`describe` block. **`tsc` does not cover `packages/worker/test/`.**

### 1.9 Plugin tests can write to the LIVE daemon

`packages/opencode-plugin/test/setup.ts` pins `PIGEON_DAEMON_URL` to `http://127.0.0.1:1` and throws
if anything targets `:4731`. **Do not remove that guard**; ensure `setupFiles` covers any new test
file. With topics live, a missing mock now creates **real Telegram topics**, not just DB rows.

### 1.10 Subagent brief prohibitions — copy VERBATIM into every brief

1. Never run `opencode serve`, opencode in any server mode, or opencode's own test suite (`bun test`
   inside `packages/opencode` — its harness spawns children with unfiltered `process.env`;
   bead `pigeon-050`).
2. **No backticks in shell strings.** Prose containing backticks inside a double-quoted bash argument
   gets command-substituted. Single quotes or a heredoc.
3. Never `git stash` / `reset` / `checkout -- <path>` / `restore` / `clean` / `rebase` / `merge` /
   `cherry-pick` / `commit --amend`. Peers share this repo; one already lost uncommitted data. Undo by
   editing forward.

---

## §2 — THE CYCLE PROTOCOL

Each cycle in §4 runs this loop:

1. **Compact** with a resumption prompt pointing at this file and the cycle.
2. **(Optional) `oracle-fable`** — only when the design is genuinely open. Skip for mechanical work.
3. **SDD** — fresh `implementer` per task, one task per commit, TDD, tick `[x]` with the SHA.
4. **`adversarial-reviewer-fable`** on the diff.
5. **Review the fix the review prompts, not just the finding.** At Checkpoint 2b fable found a real
   defect; re-reviewing the *fix* found two more, one introduced by the fix itself.
6. **PR**, then merge to `main`.

### Verification discipline that has repeatedly paid off

- **Verify every subagent and reviewer claim.** Several have been wrong. I have also been wrong to
  doubt one that was right — check, don't guess in either direction.
- **After adding an assertion, inject the regression and watch it fail.** An assertion you did not
  see fail is not evidence.
- **Scope the injection to the call site you are claiming coverage for.** Removing a shared helper
  proves it matters *somewhere*, not that it matters where you tested. This exact error hid the fact
  that `isTopicServiceReply` was doing nothing in `resolveReplySession`.
- **Reason about composition across units, not one call path.** Five consecutive checkpoints found
  the defect that mattered living *between* tasks, invisible to every unit test.
- **Report "already implemented" or "the spec is wrong" honestly.** The previous plan's file lists
  were materially wrong twice; one task's real diff touched **zero** of the files the plan named.

---

## §3 — THE ORGANIZING CONSTRAINT: the 20/min group budget

Everything below is downstream of one fact discovered on flip day:

> **Telegram caps a bot at ~20 messages per minute per group.** The old DM had a far more forgiving
> budget. Moving every session's traffic into one supergroup made a whole class of latent
> rate-limit bugs reachable *simultaneously*.

The system now has **one shared, hard, per-minute budget** across: every session's stop and question
notifications, every webhook ack and error, `/current-state` fan-out, and topic-management calls
(`createForumTopic`, `reopenForumTopic`, `closeForumTopic`).

Two structural consequences worth holding in mind while doing any of the work below:

- **Every wasted call costs somebody else's notification.** T2.6 reopens a closed topic before
  sending, but live probing proved a bot **can** post into a closed topic — so that call is
  belt-and-braces and is spending budget for nothing (§4.4).
- **Durability and budget are the same problem.** A send that is dropped on 429 (rather than
  retried) converts a budget shortfall into permanent data loss. That is `t5f`, `cal`, and `bqo`.

---

## §4 — THE ROADMAP

### Cycle 0 — `pigeon-t5f` + `pigeon-3h9`: make delivery failures visible, then survivable

- [ ] **0a. `pigeon-3h9` — stop swallowing the failure reason.** `poller.sendNotification` and
  `registerSession` use a bare catch, so the daemon logs `ok=false` and never the status code. This
  is *why* `t5f` took several steps to diagnose instead of ten seconds.
  **Do this first: it is the instrument you need to verify 0b.** Verifying that a 429 is now retried
  requires being able to see that it was a 429.
- [ ] **0b. `pigeon-t5f` — route `/current-state` cards through the durable outbox.** `index.ts:308`
  wires `sendCard` to a bare POST; stop/question go through the outbox and survive a 429. Observed in
  production: exactly 20 cards delivered, 29 silently lost.
  Consider also whether `/current-state` should emit one message per session at all — the fan-out is
  what makes it hit the cap. That is a design question; `oracle-fable` is warranted here.

**Definition of done:** a `/current-state` with 25+ live sessions delivers every card, late if
necessary, and any 429 is visible in the daemon log with its status code.

### Cycle 1 — `pigeon-bqo` + `pigeon-8l7`: the outbox must not drop silently

- [ ] **1a. `pigeon-bqo`** — the outbox permanently drops entries when the worker path is down longer
  than `MAX_AGE_MS` (15 min) or 10 attempts. This is the same terminal-failure budget that makes the
  migration rollback dangerous (runbook F1). ~150 messages have already died this way overnight.
- [ ] **1b. `pigeon-8l7`** — no alerting on terminal drops. **The surfacing path must not depend on
  Telegram**, since Telegram being broken is the common cause.

### Cycle 2 — `pigeon-cal` + `pigeon-6be`: the remaining fire-and-forget paths

- [ ] **2a. `pigeon-cal`** — webhook acks discard `TgResult`, so a 429-ed ack vanishes. Its
  closed-topic half is already resolved as a non-issue (a bot *can* post into a closed topic); only
  the 429 half remains. 21 call sites behind one wrapper, so the change is contained.
- [ ] **2b. `pigeon-6be`** — `registerSession` is one-shot with no retry; a failed registration
  orphans a session and the outbox retry loop cannot recover it.

### Cycle 3 — topic-specific residuals

- [ ] **3a. `pigeon-5o7`** — scope `deleteTopicBySession` to the stale thread id. Latent TOCTOU,
  currently safe only by architectural accident (sequential outbox, single daemon, and a `fetch`
  with **no timeout**). Adding a fetch timeout — an obviously reasonable change — silently breaks it.
- [ ] **3b. Classify `TOPIC_NOT_MODIFIED` explicitly.** Live probing confirmed reopening an
  already-open topic returns `400 Bad Request: TOPIC_NOT_MODIFIED`. Classifying it retires the trade
  recorded at Checkpoint 2b, where *any* generic reopen failure marks the row open and never retries.
- [ ] **3c. Drop the T2.6 reopen-before-send call**, or make it conditional. Proven belt-and-braces;
  it spends budget (§3) on every notification to a closed topic. Depends on 3b.
- [ ] **3d. `pigeon-wly`** (P3) — reap-loop generic failures pin head-of-line slots, degrading the
  reaper to 4 of 5 slots. Accepted residual; fix only if it bites.

### Cycle 4 — close out the migration

- [ ] **4a.** Record the observed 429 rate during burn-in. The design defers a chat-level
  `next_send_at` gate in D1 with an explicit trigger: **build it if 429s appear on more than a
  handful of days.** Flip day already produced a burst, so this is now justified by observation —
  but confirm it is recurring, not a one-off caused by `/current-state` fan-out (which Cycle 0 fixes).
- [ ] **4b.** Drop `8248645256` from `ALLOWED_CHAT_IDS`. **Last, and only after the daemon has been
  stable on the supergroup through a full burn-in.** Irreversible in practice.

---

## §5 — Reference

- Migration runbook: `docs/runbooks/telegram-forum-migration.md`
- Predecessor spine: `docs/plans/2026-07-25-telegram-forum-topics-plan.md` — read its Checkpoint 2a
  and 2b entries before touching topic code; they record why each guard exists.
- Live-API facts established 2026-07-31 (bead `pigeon-cev`, closed):
  - deleted topic ⇒ `400 "Bad Request: message thread not found"`; the `includes("thread not found")`
    classifier is **correct**
  - a bot **can** post into a closed topic
  - reopening an open topic ⇒ `400 "Bad Request: TOPIC_NOT_MODIFIED"`
  - a **private chat carries no `message_thread_id`** (measured, not assumed)
