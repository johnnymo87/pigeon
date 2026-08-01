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
Do this LAST, as Cycle 7b — it is the only irreversible step.

### Test baseline — regressions are measured against this

| Package | Tests |
|---|---|
| `@pigeon/daemon` | **889** passed, 1 skipped |
| `@pigeon/opencode-plugin` | **306** passed |
| `@pigeon/worker` | **292** passed |

Total **1487**. Updated by Cycle 4 itself (see CORRECTION #4) rather than left for Cycle 5 to discover. **`npm run typecheck` is CLEAN — 0 errors.**

> **CORRECTION #4 (2026-08-01, start of Cycle 4).** This table said **832 / 1429** until re-measured at
> the top of Cycle 4. Cycle 3 added 36 daemon tests and the table was not updated — **the fourth time
> in four cycles.** CORRECTION #3 directly below already declared "re-measuring is now the first action
> of every cycle", and it was: the number was still wrong, because writing the rule did not make the
> *previous* cycle go back and update the table it had invalidated. The durable fix is not another
> exhortation — it is that **the cycle that adds tests owns updating this table in its own final
> commit.** Until that habit exists, assume this table is stale and spend the 90 seconds.

> **CORRECTION #3 (2026-07-31, start of Cycle 3).** This table said **790 / 305 / 279 = 1374** until
> re-measured at the top of Cycle 3. Cycles 1 and 2 added tests and the table was never updated —
> **the third time in three cycles that a carried-forward count was wrong.** Re-measuring took 90
> seconds and is now the first action of every cycle. Treat any number in this file that you did not
> personally measure this session as unverified.

> **CORRECTION #2 (2026-07-31, start of Cycle 1).** This table said **792 / 1376** until re-measured at
> the top of Cycle 1. It was stale: Cycle 0's `9a792c9` deleted the dead `buildCardNotification` tests,
> dropping the daemon by 2. **The table was written in the same session that deleted them and still was
> not re-measured** — the identical failure mode as CORRECTION #1 directly below, one cycle later.
> Re-measure at the START of every cycle, not just after config changes. It costs 90 seconds. The 4 `lease-cas` errors that the
previous plan told every task to ignore were fixed by PR #8. **Any typecheck error is now a real
regression.**

> **CORRECTION (2026-07-31).** The first version of this table claimed `@pigeon/worker` **279
> passed** as of the topics flip. That was false. Commit `4c163cb` set
> `TELEGRAM_TOPICS_ENABLED = "true"` in `wrangler.toml`, Miniflare inherited it, and **20 worker
> tests broke immediately** — the real state at `34d4389` was **20 failed / 259 passed**, confirmed
> by running the suite at that commit in a throwaway worktree. The number survived a whole session
> because it was *inherited from a previous measurement* rather than re-measured after the change
> that broke it. `packages/worker/vitest.config.ts` now pins the flag explicitly so test config no
> longer moves when a production flag is flipped (bead `pigeon-66y`).
>
> **Generalise this: re-measure a baseline after any change to shared config. Never carry a count
> forward across a change that could plausibly affect it.** This is the same failure mode as §1.7 —
> trusting a memorable prior fact instead of establishing the current one.

---

## §1 — OPERATING HAZARDS

> **§1.-1 — Platform limits do not exist in the test environment, and D1 caps bound parameters at
> 100.** The cap applies to **each statement inside a `db.batch`**, not to the batch
> (https://developers.cloudflare.com/d1/platform/limits/). The session sweep binds one parameter per
> victim; production had 126 victims, so its **first run threw, was swallowed by its own try/catch,
> and deleted nothing for two hourly ticks** while health, analytics and error counts all looked
> perfect. No test could have caught it: worker tests run on miniflare, which is plain SQLite with a
> 999-parameter ceiling, so **the limit that broke production does not exist where the tests run.**
> When code depends on a platform limit, pin it with a guard test on the constant and assert the
> *call shape* (parameter counts per statement), because the behaviour itself is unobservable
> locally. Generalise beyond D1: query duration, subrequest counts and payload sizes are all
> enforced in production and absent in miniflare.
>
> Corollary, learned the hard way: **a `try/catch` around a janitorial step converts a hard failure
> into an invisible one.** The catch was right, but it must log loudly enough to be found, and the
> step needs an outcome you can measure from outside (here, a stale-row count that should go to
> zero). Prefer verifying the *effect* over trusting the absence of errors.

> **§1.0 — Merging is not deploying, and the daemon proves it.** Discovered 2026-07-31 while
> deploying Cycle 2c: the production daemon checkout (`/home/dev/projects/pigeon`) was **44 commits
> behind main**, meaning **every daemon change from Cycles 0 and 1 had been merged but never run.**
> The outbox classifier, the priority ordering, the durable `/current-state` cards — none of it was
> protecting anything. The nightly reset restarts the service but does **not** pull, so a merged
> daemon commit sits inert until someone runs a pull and a restart on each machine. Earlier notes in
> this file that said Cycles 0 and 1 "were daemon-only and merging was enough" had it exactly
> backwards: worker changes need one deploy, daemon changes need a deploy **per machine**. Before
> claiming a daemon behaviour is live, check `git rev-list --count HEAD..origin/main` in the
> deployment checkout, not in your worktree.

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

> **THIRD occurrence, 2026-07-31 — and the stated cause does not fit.** The worktree vanished
> mid-session at about **10:14 local**, nowhere near the ~03:00 reset window, and the session had
> been using it continuously beforehand. Nothing was lost, again, only because every task had been
> pushed. **Do not record this as "the nightly reset did it" (§1.7):** the timing rules out the
> obvious suspect, and the real cause is unestablished — a peer session or a stray
> `git worktree prune` are equally consistent with the evidence. The operational lesson is unchanged
> and now has three data points behind it: **commit and push at every task boundary**, because the
> worktree can disappear at any hour for reasons you have not identified. Recovery is the same
> `git worktree add` either way.

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
  belt-and-braces and is spending budget for nothing (Cycle 6c).
- **Durability and budget are the same problem.** A send that is dropped on 429 (rather than
  retried) converts a budget shortfall into permanent data loss. That is `t5f`, `cal`, and `bqo`.

---

## §4 — THE ROADMAP

### Cycle 0 — `pigeon-t5f` + `pigeon-3h9`: make delivery failures visible, then survivable

- [x] **0a. `pigeon-3h9` — stop swallowing the failure reason.** DONE `203aeca`. `poller.sendNotification` and
  `registerSession` use a bare catch, so the daemon logs `ok=false` and never the status code. This
  is *why* `t5f` took several steps to diagnose instead of ten seconds.
  **Do this first: it is the instrument you need to verify 0b.** Verifying that a 429 is now retried
  requires being able to see that it was a 429.
- [x] **0b. `pigeon-t5f` — route `/current-state` cards through the durable outbox.** DONE `4c6db4f`.
  Cards now enqueue with a deterministic id `cs:{commandId}:{sid}`, only after `registerSession`
  succeeds. **The staleness objection was a trap**: the swipe-reply token and the
  `messages(chat_id,message_id → session_id)` row are created at Telegram **delivery** time, so a
  late card is a fully functional handle — only its displayed status is stale, and the index already
  conveyed that. Design review also rejected threading cards into per-session topics: lazy
  `createForumTopic` would roughly double the call count and make the budget worse.
- [x] **0c. `pigeon-vb2` — message-class priority in the outbox.** DONE `97c4466`. Routing 25 cards
  through one FIFO would have starved *question* notifications (agent blocked on a human) behind the
  fan-out plus a 5-minute pause. `getReady` now orders question → stop → card, then `created_at`,
  then `rowid`. **This regression was created by 0b, which is why it shipped with it rather than
  being deferred.** Adversarial review quantified the residual starvation risk as needing ~300
  question/stop notifications inside 15 minutes — pathological, not operational.

**Definition of done:** a `/current-state` with 25+ live sessions delivers every card, late if
necessary, and any 429 is visible in the daemon log with its status code.

### Cycle 1 — consume the classification: act on a classified failure

`pigeon-3h9` produced classifications that **nothing reads for control flow yet**. Every item here
is that missing consumer, which is why they belong together.

- [x] **1a. `pigeon-m76` — clear the refactor trap FIRST, before any behaviour change lands nearby.**
  `sendStopNotification`, `sendQuestionNotification` and `sendViaWorker` have **zero** production
  callers (re-verified 2026-07-31), yet they duplicate the real formatting/chunking logic and have
  passing unit tests. **This trap already fired**: Cycle 0 improved an error message inside
  `sendViaWorker`, i.e. in dead code, with a green suite throughout. It cost a few lines that time.
  Cycles 1 and 2 rewrite failure policy and the age budget *in exactly these files*.
- [x] **1b. `pigeon-bzf` + `pigeon-6be` + `pigeon-288` — ONE change, one policy.** Splitting these
  actively harms:
  - **`bzf` alone is a regression.** Making 404 terminal while `registerSession` is still one-shot
    turns `6be`'s incident from "ten doomed retries, then dropped" into "one attempt, then dropped".
    The message is lost *faster* and the logs look better. Correct behaviour: **404 → re-register →
    retry**; terminal only if re-registration itself fails.
  - **`288` is a deliberate exception to `bzf`.** A non-rate-limited 400 should get one retry with
    entities stripped so the text still lands unformatted. Whichever of the two lands second will
    silently override the first unless they are written as a single policy.
  - Net policy: see the verified table below — **the naive version of this line is wrong on three
    counts**, established by reading the worker source and by `oracle-fable` on 2026-07-31.

#### The actual `/notifications/send` status map (verified, not assumed)

| Daemon sees | Cause | Correct action |
|---|---|---|
| `400` | **worker-side field validation only** (`notifications.ts:187`) | terminal at once |
| `403` | `ALLOWED_CHAT_IDS` reject (`notifications.ts:201`) | terminal **only at `attempts >= 2`** |
| `404` | session not registered (`notifications.ts:197`) | re-register arm, below |
| `429` | Telegram rate limit | pause + retry (unchanged) |
| `502` | **every Telegram-level error**, incl. a 400 (`notifications.ts:331`) | inspect `details.error_code` |
| other 5xx / transport | worker or network | retry (unchanged) |

**Correction 1 — `pigeon-288`'s premise is unsound as written.** A malformed-entity Telegram 400 never
reaches the daemon as a 400; the worker wraps *every* non-429 Telegram failure as **502 "Telegram API
error"**, preserving Telegram's own code at `details.error_code` (`telegram.ts:91`). So entity
stripping must key on **502 + `details.error_code === 400` + entities present**. The only 400 the
daemon can see is missing-field validation, where stripping is useless. It follows that `bzf` and
`288` were **never actually in conflict** — they address disjoint status codes. The beads' stated
reason for pairing them was wrong; the pairing is still right, for the reasons below.

**Correction 2 — the real conflict is `bzf` vs the reaper, and nobody wrote it down.** `bzf`'s own
motivating scenario is a `/current-state` card whose session the reaper unregisters mid-flight. But
`6be` wants 404 → re-register. Applied blindly that **resurrects a session the reaper deliberately
cleaned up**, and `6be` note 4 flags the consequence: the reaper unregisters only sessions it still
holds locally, and the worker has **no session TTL cron**, so the leaked row lives forever.
**Discriminator: re-register only if the LOCAL session row still exists.** `app.ts:275` upserts the
local row *before* registering (6be: row present, worker registration missing → re-register), while
`session-reaper.ts:27` deletes the local row *before* unregistering (reaped: no row → terminal). The
local row also carries `label`, which answers `6be` note 4's "no label available at retry time".
There is still a narrow race — reaper fires between the check and the register — so **after a
successful re-register, re-check the local row; if it vanished, `unregisterSession` and go terminal.**

**Correction 3 — two arms of the naive policy make data loss FASTER, the exact failure this cycle
exists to prevent.**
- **`403` must not be terminal on the first attempt.** A 403 is a property of *worker config*, not of
  the message. An `ALLOWED_CHAT_IDS` typo in a deploy today leaves a 15-minute window to roll back
  losing nothing; instant-terminal converts it into immediate mass loss of everything queued. Terminal
  at `attempts >= 2` keeps deterministic 403s dying in seconds while a bad deploy stays survivable.
  **This is also live rollback-safety today** — §0 keeps both chat ids allowed precisely because
  narrowing the allowlist produces 403s.
- **A failed re-registration must not be terminal if it failed *transiently*.** Register
  `transport_error`/5xx means the worker is briefly down — plain `markRetry`, do not consume the
  once-flag. Only a definitive register 4xx is terminal. (Note: `/sessions/register` can return
  **429 "Session limit reached" with no `retryAfter`** (`sessions.ts:69`) — not a Telegram rate limit,
  do not feed it to the pause path.)
- **Do not "strip entities, then terminal if it fails again."** Persist the strip by **rewriting the
  outbox payload** instead of holding a flag; the entry then stays under the normal retry budget, so a
  429 arriving after the strip does not kill it. Worker dedup by `notificationId` makes rewriting all
  chunks safe.

#### Cycle 1 task breakdown

- [x] **1a. `pigeon-m76`** — dead stop/question arms removed. DONE `6233937` + `03539d9`. The second
  commit deletes the residue: with its methods gone `WorkerNotificationService` was a five-argument
  constructor with no body, still wired as the "primary" notifier. Alert delivery already fell
  through to Telegram in all three configurations, so removing it was behaviour-preserving.
- [x] **1b.** Pure `classifyDeliveryFailure(result, ctx) -> DeliveryAction`, table-driven tests, no
  I/O. DONE `1fc0e44`.
- [x] **1c.** Wired into `OutboxSender` + `outbox.updatePayload`. DONE `5b3c79d`, `e67a144`, `938c38c`.
  **Every arm ends in `markRetry` — never re-send inside the same tick**, so attempt accounting is
  unchanged and a 404→re-register→502→strip sequence cannot double-count (confirmed by review).
- Budget constants (`MAX_ATTEMPTS`, `MAX_AGE_MS`, `BACKOFF_SCHEDULE`, `MAX_PAUSE_MS`) are **Cycle 3**.

#### What changed during Cycle 1 vs. what was planned

**`403` is NOT terminal — `pigeon-bzf` is rejected on that point.** Correction 3 above softened it to
"terminal at `attempts >= 2`". Adversarial review killed even that, on two counts: `ctx.attempts`
counts failures of *every* kind, so an entry with two unrelated transport failures would die on its
**first** 403 — two recoverable transients composing into permanent loss; and the threshold bought
~15 seconds of rollback window while the comment justifying it claimed 15 minutes.

Checking the worker then removed the motive entirely: **a 403 never reaches Telegram.** It is
rejected at `notifications.ts:202`, before `resolveTopic` (`:230`) and before
`createTelegramClient` (`:248`), so a retried 403 costs *none* of the shared 20/min budget that
§3 says is the reason to kill doomed entries early. 400 (`:188`) and 404 (`:197`) return before
Telegram too — they stay terminal for a **different** reason: they are genuinely deterministic, so
retrying cannot ever succeed. **Generalise: "terminal" must be justified by determinism, not by
budget, unless the failure actually spends budget.**

**Two register outcomes were also un-terminalled** (`e67a144`): a 429 "Session limit reached" is a
capacity condition that clears, and an `app_rejection` (2xx with `ok:false`) is inherently ambiguous.
Terminal only on a definitive 4xx.

**New beads from review:** `pigeon-bea` (P2 — the worker has **no session TTL cron**, so any leaked
`sessions` row is permanent; Cycle 1's compensating unregister is a client-side mitigation and now
logs `LEAKED worker session row` when it fails) and `pigeon-e44` (P3 — entity stripping fires on any
Telegram 400, not just parse errors).

### Cycle 2 — the worker session registry: make the cap safe, then sweep the leak

**Inserted 2026-07-31 after Cycle 1 on an urgency claim that was measured the next hour and
retracted. Read the retraction first — it is the more useful half of this section.**

#### The retraction: there is no one-week deadline

`pigeon-bea` was filed as a structural P2 from reading the code. A first measurement turned it into
"574/1000 rows, ~65/day, **≈6–7 days to the cap**" and it jumped the queue on that basis. **That
estimate was wrong by roughly 60x, and it was wrong in precisely the way §1.7 warns about.**

It divided headroom (426) by the session *creation* rate (65/day). That silently assumes every
created row is permanent. Alive-rows-by-creation-age, measured 2026-07-31 10:35, total 578:

| age | 0–6d | 7d | 8d | 9d | 10d | 11–130d | 131–138d |
|---|---|---|---|---|---|---|---|
| alive | 103,74,56,65,47,23,57 (**425**) | 14 | 4 | 1 | 1 | ~1/day (~30) | **103** frozen |

A **93% cliff between 6d and 8d**. And a snapshot cannot distinguish the two hypotheses that both
predict that exact curve:

- **(A)** high creation **+ a reaper that works at 7d** → a self-limiting equilibrium, safe.
- **(B)** a creation explosion that began ~7d ago **+ zero deletion** → the entire 0–7d band is
  leaked and the cap arrives in days.

**(B) was the filed story, and the cliff sitting exactly at the TTL is suspicious enough to look
like confirmation of it.** The discriminator is the daemon's *own local table* on cloudbox: **389
rows, nothing older than 7d**, with a by-`last_seen` histogram of 115,67,47,53,36,14,53,4 that
mirrors the worker curve. The reaper demonstrably deletes locally **and** unregisters worker-side.
**(A) confirmed.**

Corrected model — `worker total ≈ 7 × creation_rate + leaked`:

- **working set** (0–7d) ≈ **425**, self-limiting, mirrors the daemon's live table — **not a leak**
- **genuinely leaked** (>7d) = **153** rows over ~138 days ≈ **1.1/day**
- headroom 422 ÷ 1.1/day ≈ **380 days**

The "essentially nothing is being deleted" claim was inferred from one snapshot (128 rows over 7d)
with no age curve behind it. The leak is also **not** a uniform trickle: it is bursty
daemon-state-loss events (the frozen 131–138d cluster; macbook 19/25 and chromebook 4/4 old rows) —
machines whose local SQLite was wiped or retired, which the reaper can never clean because it only
unregisters sessions it still *holds locally*. That is why the worker must own this sweep.

#### What survives, and why this cycle still runs

1. **The leak is real, just slow.** 153 rows no daemon will ever unregister, growing in bursts.
2. **The cap is the real hazard, and it is independent of the leak.** The working set scales
   linearly with creation rate, which is 60–103/day and trending up, while `MAX_SESSIONS = 1000`
   (`sessions.ts:5`) is an arbitrary guard rail. A sustained doubling of activity gives
   ~840 working set + 153 leaked ≈ **993**. The leak buys 380 days; the *cap* is one busy fortnight
   away, and nothing warns you.

**What happens at the cap is silent, which is the dangerous part.** The limit is checked only for
NEW sessions (`sessions.ts:64-71`, guarded by `if (!existing)`), so every already-registered session
keeps working and nothing looks wrong. New sessions get `429 Session limit reached`, are never
registered, and every notification they produce 404s. Cycle 1 turns that 404 into a lazy
re-registration, which returns 429 again, which Cycle 1 deliberately classifies as **retryable** — so
the entry retries until the 15-minute age cap (`outbox-sender.ts:42,159`) and is dropped.
`/current-state` is worse: `current-state-ingest.ts:106` does `continue` when registration fails, so
those cards are never enqueued at all.

> **Cycle 1 does not protect against this, and it is worth being honest about that.** Making
> register-429 retryable was still the right call, but it converts instant loss into *delayed* loss,
> not into delivery. A durability fix downstream of an exhausted registry buys time, not correctness.

- [x] **2a. Make the cap safe and observable — `pigeon-bea`, first half.** Done in `fafad8a` and
  `18abfae` (PR #15); deployed 2026-07-31, worker version `290864ff`.
  Raise `MAX_SESSIONS` 1000 → **5000** and keep it global and dumb. Nothing real constrains it: D1
  allows 10GB, rows are ~100 bytes, and the `COUNT(*)` on new registration is sub-ms at this scale.
  Its only legitimate job is runaway-bug guard, not capacity planning. **Do not build per-machine
  caps** — cloudbox's 72% share is legitimate load, and a per-machine cap would starve the busiest
  *legitimate* machine first. Then make it loud: `console.error` at the 429 return (today the worker
  rejects in total silence, so even `wrangler tail` shows nothing), and a high-water check in the
  existing cron that sends a Telegram alert at ≥80% of the cap. Note the check-then-insert at
  `sessions.ts:59-71` is not atomic, so the cap is soft — fine for a backstop, do not fix.
- [x] **2b. The TTL sweep — `pigeon-bea`, second half.** Done in `c6745d3`, `2e3dc50` and
  `336a5e0` (PR #15); deployed with 2a. Expire on **`updated_at`, not
  `created_at`**: the touch runs on every notification (`notifications.ts:219`) and every webhook
  reply (`webhook.ts:468`), and its comment says *"Touch session to prevent cleanup"* — **the touch
  was written for a cleanup that was never built.** TTL = **14 days, strictly greater than the
  daemon's 7-day `SESSION_TTL_MS`**, so the daemon always wins for machines that are alive and the
  worker only catches structural orphans. Measured: only **4 rows** sit between 7d and 14d, so 14d
  costs almost nothing versus 7d and is far safer. **Add a test asserting the worker TTL exceeds 7
  days**, naming the daemon constant — the two live in different packages, and a future edit dropping
  the worker below the daemon would mass-expire the live working set. **Delete `messages` alongside
  `sessions`** (mirroring unregister at `sessions.ts:101-102`, the *only* deletion path `messages`
  has) in a single transactional `db.batch`. Bound it with a subquery `LIMIT 500` rather than
  `DELETE ... LIMIT`, which is compile-flag-dependent. Run the sweep **before** `runTopicReaper` in
  `scheduled()` so topics orphaned by the sweep start draining via `topics.ts` `listOrphaned`
  immediately rather than an hour later. Note *start*: the reaper closes at most
  `DEFAULT_ORPHAN_CAP` (5) orphans per tick, so a bulk sweep drains over hours, not in one tick. Current
  backlog at 14d: **126 sessions and 701 messages**; orphaned messages today: **0**.
  **Verified in production 2026-07-31 14:00** after the `51257ad` chunking hotfix (PR #17): sessions
  566 → **444**, stale-over-14d 126 → **0**, messages 11124 → **10447**, orphans **0**. The first two
  attempts (12:00, 13:00) silently deleted nothing — see §1.-1, and note it was caught by checking
  the effect rather than by any alarm.
- [x] **2c. `pigeon-a1a` — stop producing the garbage.** Done in `95ab2df` and `01abd0b` (PR #16),
  but landed as **two** sites rather than four — see the finding below. **Deployed to cloudbox only**
  (2026-07-31); devbox and macbook are alive and polling but not reachable from cloudbox, so their
  pull+restart must be run on those hosts. chromebook has not polled in ~4 months. The bead claimed three daemon paths remove a local
  session row without unregistering, or register worker-side with no local row at all:
  - `repos.ts:226` — `cleanupExpired` does `DELETE FROM sessions WHERE expires_at < ?` with no
    unregister, and is called from **inside the reaper itself** (`session-reaper.ts:43`).
  - dead-session cleanup in `command-ingest.ts` deletes the local row on a connection error.
  - `current-state-ingest.ts:103` registers every tmux-surveyed session; discovery is tmux-based,
    not registry-based, so nothing guarantees a local row exists.
  The reaper's own unregister is also best-effort (`session-reaper.ts:33-37` swallows errors).

> **Finding, 2026-07-31 — two of the four named sources were not sources.** Checking each before
> writing code retired half the bead:
>
> - **`repos.ts:226` `cleanupExpired` is not a leak source**, despite looking exactly like one (it
>   deletes with no unregister, from inside the reaper). `expires_at` is always set to
>   `last_seen + SESSION_TTL_MS` (`repos.ts:82,166`) and no caller overrides `ttlMs`, so its row set
>   is a strict **subset** of the `listStale` set that the reap loop deleted and unregistered moments
>   earlier. Confirmed empirically: the reaper's `cleaned N expired session records` log line has
>   **never** fired in production, while `reaped stale session` fired 52 times in the same window.
>   Mechanically true, empirically vacuous — the kind of bug that survives code review forever
>   because the code really does look wrong.
> - **`app.ts:595`** already unregisters via its `onSessionDelete` hook.
> - **`current-state-ingest.ts:103` is real** and is probably the dominant source, but fixing it
>   means synthesizing local session rows. It is now covered by `2b`'s sweep, so it was left for a
>   later cycle rather than bolted on here. **Still open as `pigeon-2c6` (P2)** — measure how many
>   such registrations lack a local row before choosing a design; the sweep makes it safe to take
>   time over it.
>
> A correction on that first point, because I got the credit wrong before checking: the log line
> that settled it **predates Cycle 0**. It is present in the commit the daemon was actually running
> (`4e8156a`, 44 commits behind main), so the "never fired" evidence is sound — but attributing it
> to recent work was the §1.7 reflex again, reaching for the memorable recent event. Verify which
> binary produced a log line before crediting anything for it.

**Sequencing: cap before sweep, and in two separate deploys.** The only way this work *loses*
notifications is: sweep expires a live session → 404 → re-register → **429** → transient retry loop →
killed at the 15-minute age cap. That chain needs cap pressure **and** the sweep at the same time.
Raising the cap first breaks the 429 link before the sweep can ever run, so a mid-flight daemon that
eats a 404 simply re-registers and succeeds. Shipping both at once re-creates exactly the
"fix makes the loss faster" hazard that Cycle 1's 403 arm produced.
**In the event both shipped in one deploy, and that was sound for a reason worth keeping:** the cap
raise takes effect the instant the worker goes live, while the sweep only fires on the next hourly
cron tick, so the protective ordering is enforced by the schedule rather than by the deploy count. `2c` is last: it stops future
garbage but clears none of the 153 rows already there, and the backstop makes it non-urgent.

> **Method note — the same lesson twice, in both directions.** The first measurement of `pigeon-bea`
> promoted it from "someday" to "this week"; the second *demoted it back* and moved the real risk to
> a different variable entirely. **Measure a resource-exhaustion bead before ranking it — and make
> sure the measurement can actually discriminate between the hypotheses.** A snapshot of a table tells
> you a population, never a rate; only an age curve, or two readings separated in time, tells you
> whether something is accumulating. Cross-check against an independent source of truth where one
> exists — here the daemon's local table settled in one query what the worker's table could not
> settle at all.
>
> Note also what the retraction did *not* do: it did not retire the bead. The work survived the
> collapse of its own justification, in a re-scoped form aimed at the hazard the measurement actually
> exposed. Discovering that a deadline is fake is a reason to re-aim the work, not to drop it.

### Cycle 3 — the age and attempt budget — DONE (PR #18, merged `eafba12`)

**Deployed to cloudbox 2026-07-31 and verified by effect, not by absence of errors** (§1.-1): the
additive migration applied to the LIVE DB — `retry_count`, `failed_reason` and `last_error` are all
present on the production `outbox` table and existing rows backfilled to `retry_count = 0` — daemon
healthy, no migration errors in the journal. The migration having run is itself the proof the new code
is live, since nothing else creates those columns. A pre-deploy DB backup was taken via the
`better-sqlite3` backup API (`/tmp/opencode/pigeon-daemon-pre-cycle3.db`) rather than a file copy, so
it is consistent against a running writer.

**Still undeployed on devbox and macbook** — both were unreachable from cloudbox again at deploy time
(`devbox` does not resolve, the `mac` reverse tunnel refuses on 127.0.0.1:2222). Their `git pull &&
npm install` plus restart must be run on those hosts. Beads `pigeon-bqo` and `pigeon-8e9` are closed
on the strength of the cloudbox deploy.



Both beads are the same `MAX_AGE_MS` / attempts mechanism seen from opposite sides.

- [x] **3a. `pigeon-bqo`** — the outbox permanently drops entries once the worker path is down longer
  than `MAX_AGE_MS` (15 min) or 10 attempts. Same budget that makes the migration rollback dangerous
  (runbook F1).
- [x] **3b. `pigeon-8e9`** — `upsert` resurrects a `failed` row **without resetting `created_at`**, so
  anything older than 15 min returns to `queued`, is instantly judged too old, and re-fails having
  sent nothing — with `attempts` still 0, so the journal line reads like it never tried.

**Verified at the top of the cycle (all four claims confirmed against source, plus two additions):**
the terminal check at `outbox-sender.ts:159` runs **before** the payload parse and before any send, so
Cycle 1's classifier — which already returns `retry` for `transport_error` and 5xx — **can never veto
it**. That is precisely why Cycle 1 did not fix `bqo`. Backoff sums to **13.75 min** over 10 attempts,
so both caps bite together and the attempts cap binds first by a hair.

Two things the roadmap did not know:

- **The `pause` arm charges an attempt.** `outbox-sender.ts:248` calls `markRetry` *before* setting
  `pausedUntil`, so every 429 burns one message's attempt budget even though a 429 says nothing about
  that message. This is latent today and becomes severe the moment a backlog exists — which is
  exactly what fixing `bqo` creates. **It must be fixed before, or with, the age cap.**
- **`OUTBOX_RETENTION_MS` is 1 hour**, and `cleanupOlderThan` deletes `failed` as well as `sent`. In
  the 2-hour incident the record of what was lost was **deleted before the outage ended**. Measured
  the production outbox during planning: 5 rows, all `sent`. There is no dead-letter anywhere, so
  today a dropped notification is both unrecoverable *and* unauditable.

**Design (oracle-fable consulted; it argued me out of my opening position).** I intended to delete the
age cap outright on the Cycle 1 principle that *terminal status must be justified by determinism, not
by budget*. That principle is right but the conclusion was wrong: **staleness is real, not a budget
excuse.** A 4-hour-old question is not merely old, it is *unanswerable* — `PENDING_QUESTION_TTL_MS`
has already expired it. So the cap stays and is instead **grounded in affordance TTLs**, which makes
expiry deterministic rather than budgetary: a message dies when delivery can no longer function.

- **Per-kind expiry** replaces the flat 15 min: `question` **4h** (`PENDING_QUESTION_TTL_MS`),
  `stop`/`card` **24h** (`REPLY_TOKEN_TTL_MS` — after which reply routing is dead anyway). The
  2-hour incident survives comfortably.
- **Attempts becomes cause-aware.** `transport_error`, 5xx and 429 stop incrementing it, so
  `attempts` finally means "the path was up and this message failed anyway" — a genuine per-message
  signal, which is what makes `attempts >= MAX_ATTEMPTS` a *deterministic* terminal rather than a
  budget one.
- **The 24h cap is itself the growth bound** (a never-heals scenario holds ≤24h of notifications).
  No depth cap and no dead-letter table: **`failed` rows with 7-day retention are the dead letter**,
  which also satisfies §1.-1's "measurable from outside the process" requirement — a `sqlite3` query
  on `failed_reason` is observable without trusting a log line.
- **A drain governor** is required, not optional. Post-outage the loop would otherwise push 60/min
  (5 entries per 5s tick) into a **20/min** group ceiling (§3), producing sustained 429s. Counts
  **chunks**, not entries, since `sendNotification` is per-chunk.

**Dedup blocker checked before committing to the 24h horizon:** worker dedup is a `messages` lookup
by `notification_id` (`notifications.ts:209`) and those rows are deleted only on session unregister
or the 14-day sweep. Retention therefore outlives a 24h retry horizon, so the longer window cannot
resurface as duplicate delivery.

**Order matters and is not arbitrary — 3e last.** It is the change that creates large backlogs, so
3c and 3d must already be in place or the first drain both floods the group and burns messages
through the 429-charges-an-attempt bug.

- [x] **3a. Observability first** (`3d93258`) — add `failed_reason` / `last_error`, populate at every `markFailed`
  site (including line 159 and the parse-failure path, which today record *no reason at all*), and
  split retention: `sent` 1h, `failed` 7d. Zero behaviour change; it is the safety net for 3b–3e.
- [x] **3b. `pigeon-8e9`** (`17c57c1`) — reset `created_at` in the `ON CONFLICT` clause. Tiny and independent.
- [x] **3c. Cause-aware attempts** (`f2fd28e`) — `countAttempt` on `markRetry`; transport/5xx/429 do not charge.
  **This alone extends outage survival from ~14 min to the age cap** and fixes the pause-arm bug.
- [x] **3d. Drain governor** (`5966ef7`) — chunk-counting sliding window, ~12/min, leaving headroom for wizard
  edits, media and topic management. Inert until a backlog exists, so safe to land before 3e.
- [x] **3e. Per-kind expiry replaces `MAX_AGE_MS`** (`47eacd7`) — reason `expired`. Also rewrite the `MAX_PAUSE_MS`
  comment at line 47, whose stated rationale ("could exceed MAX_AGE_MS 15m") dies with the flat cap;
  keep the 5-minute probe ceiling, which is still correct for a different reason.

Deferred rather than dropped: stop-kind newest-first ordering during drain, coalescing stale
per-session notifications, and an "N dropped during the outage" summary. File as beads, do not
inline.

**Review outcome — the fix step earned its keep for the third cycle running.** `adversarial-reviewer-fable`
found a real defect that **3c introduced and 3e made expensive**, and that all five commits' tests
missed: `getBackoff` was driven by `attempts`, so making `attempts` cause-aware silently **pinned
retry spacing at 5 seconds** — for precisely the failure class whose horizon 3e had just extended from
15 minutes to 24 hours. A doomed entry would have retried **17,280 times a day**, each one a real
Telegram-reaching call spending the §3 budget this whole cycle exists to protect. The two counters
were the same counter; the fix (`9292b58`) splits them — `attempts` stays the *budget* signal,
a new always-incrementing `retry_count` becomes the *spacing* signal — and adds the escalation-ladder
test whose absence hid it. A second, latent incoherence was fixed in `bda0e9c`: `isTransportFailure`
counted `app_rejection` while the re-registration arm's own comment argued at length that "2xx but not
ok" must be treated as retryable. Unreachable today, but had it become reachable it would have
reproduced the original incident timeline through a different door.

**The re-review of the fix came back clean** — the first time in three cycles that it has. It verified
the migration empirically against `better-sqlite3` rather than by inspection, confirming SQLite accepts
`NOT NULL` *with* a default in `ALTER TABLE ADD COLUMN` and that a genuine failure would not be
swallowed by the duplicate-column guard.

Follow-ups filed rather than inlined:

- **`pigeon-93v`** (P2) and **`pigeon-bvh`** (P3) — `/question-asked` early-returns
  `deliveryState: "queued"` for a row that is actually `failed`, and never calls `upsert`. Split into
  an honesty half and a resurrection half after measuring; both are placed in Cycle 4. It also means
  **3b is card-only in practice**: questions never reach the resurrection arm, and stop ids are
  timestamp-unique so they never collide.

  > **CORRECTION (2026-07-31, same day).** This entry originally claimed 3a's 7-day retention
  > "widens that lying window from 1h to 7 days". **The arithmetic is right and the conclusion was
  > wrong; I withdraw it.** Measured afterwards: every re-send path completes within **120 seconds**
  > (the plugin's question queue has a hard `maxRetryMs = 120_000`), while the old retention was
  > **1 hour** — already 30x longer than the longest path. So the old window never protected anything
  > and the new one is **inert** here. The claim was plausible, cheap to check, and I asserted it in a
  > bead and a commit message before checking. Same lesson as §1.7: a mechanism that *sounds* causal
  > is not evidence that it *is*.
- **`pigeon-m74`** (P3) — the governor's "12 leaves 8 headroom" is asserted, not measured, and counts
  the wrong unit: one chunk call can cost more than one Telegram message (lazy `createForumTopic`, and
  the General-fallback path sends twice), while acks, wizard edits and media are invisible to it.
  Bounded by the reactive 429 pause, so the worst case is oscillatory drain rather than loss.
  **Measure a real post-outage drain before changing the constant** — do not guess a smaller number.
  Placed in Cycle 4 next to the alerting work, since that is what will produce the measurement.

Accepted deliberately, not filed: the governor window and `pausedUntil` are in-memory and reset on
daemon restart (worst case ~24/min across the boundary, self-correcting via 429), and progress paths
such as a successful re-registration inherit an escalated backoff (≤2 min extra latency, no loss).

### Cycle 4 — the amplifier was fictional; alert on what is actually there

> **CORRECTION #5 (2026-08-01, start of Cycle 4) — this cycle's organizing premise was false, and the
> file committed §1.7 against itself.** Cycle 4 was titled "remove the amplifier, then alert on what
> remains" and its entire ordering argument rested on `pigeon-9y3`: a ~150× overnight amplifier.
> **It does not exist.** The measurement is in `4a` below. The consequence is that **`8l7` (alerting)
> was never actually gated on anything** — it was held behind a fictional prerequisite for one cycle.
>
> The instructive part is *how* the file was wrong. `9y3`'s stated evidence was "monotonically
> **decreasing** embedded session-id timestamps ⇒ walking history newest→oldest". OpenCode session ids
> are **descending-encoded**: a *decreasing* id sequence is a stream of **brand-new** sessions.
> Verified twice, independently, against the live daemon table — **380 of 390 consecutive pairs
> ordered by `created_at` ascending have a strictly smaller id**, the smallest id in the table is
> today's session and the largest is the oldest. The bead read its central clue exactly backwards, and
> the reading then set the priority of a whole cycle for two weeks.
>
> **New sub-rule for §1.7, because "don't blame the memorable event" would not have caught this:**
> *an ordering is not evidence until you have verified which direction the encoding sorts.* Inferring
> recency from an id sequence costs one query to check and produces a confident, completely inverted
> conclusion when skipped.

- [x] **4a. `pigeon-9y3` — CLOSED, REFUTED. No code written.** Investigated and closed 2026-08-01.
  Three independent findings, each measured:
  1. **The evidence is inverted** (above): decreasing ids ⇒ newer sessions, not a historical walk.
  2. **The cadence is baseline.** The journal's longest strictly-decreasing run is 81 distinct sids
     over 34 continuous hours at a **median 120 s** inter-arrival — "one every ~2 minutes",
     newest→oldest, exactly as filed. Of 185 registrations in the window, **152 (82%) were sessions
     the daemon first saw within 10 minutes of registering them**, i.e. brand new. The signature is
     this machine's ordinary session-creation rate.
  3. **The counterfactual is off by ~100×.** The bead's force comes from "~150 lost instead of ~1".
     Measured stop notifications in the *identical* clock window on a normal night: **79** (22:50→05:00
     on 2026-07-30) and 34 the next. At the measured 13.3 stop-notifications/hour, a 6-hour outage
     loses ~80–150 messages **with no amplifier at all.** ~150 was never anomalous.
  Deep-overnight volume (01:00–08:59) is **~5 registrations/night**, all brand new. Ruled out with
  discriminating evidence: the nightly reset (fires exactly **1** register + 1 stop; its 03:00 run
  reattaches nothing, and **0** of the 30 sids in its own manifest registered in that hour),
  `oc-auto-attach` (real, but mid-morning and **non**-monotone ids), systemd timers (`lgtm-run`
  *creates* sessions — which is precisely what makes new-session traffic look like a walk), cron (does
  not exist on NixOS here), and the reaper (only ever *un*registers). `registerSession` has exactly
  three production callers and none performs an ordered historical sweep.
  **The 2026-07-14/15 journal is gone** (retention starts 2026-07-30), so the original observation
  cannot be re-read — but its *inference* is invalid regardless of what the log said.
  **Two real amplifiers were found instead, both burst-shaped rather than walk-shaped**, and Cycle 3d's
  drain governor already covers that shape: `/current-state` fan-out (~25–31 registrations at ~1/s)
  and the morning swarm broadcast (31 registrations + ~25 stops in ~2 min — but it **first ran
  2026-08-01**, so it cannot have amplified a 2026-07-14 incident).
- [x] **4b. `pigeon-2c6` — MEASURED, downgraded to P3, no code written.** The mechanism is real and
  `current-state-ingest.ts:103` is the right line: it calls `registerSession` per surveyed session with
  no local-row upsert anywhere in the file, and `session-reaper.ts:26-44` only unregisters what it
  holds locally. **The magnitude is negligible.** Cross-referencing all 449 worker `sessions` rows
  against the daemon's local table (verified twice, independently):
  **392 cloudbox worker rows vs 391 local rows ⇒ exactly 1 orphan**, 1.5 days old, **0 orphans over
  14 days**, and 0 local rows missing worker-side. Worker-wide 449 of `MAX_SESSIONS = 5000`.
  Cycle 2b's sweep is working and bounds this permanently.
  **Do NOT synthesize local rows** — it requires inventing `pid`/`ppid`/`cwd`/`backend_endpoint` the
  tmux survey does not have, and it would make the reaper own rows for sessions the daemon does not
  route: a worse invariant than one orphan a day.
  > **The bead's stated mechanism is wrong in both directions, and the roadmap repeated it.** "Discovery
  > is tmux-based, not registry-based" is inaccurate: `main-session-allowlist.ts:143-153` is a
  > registry-**first** hybrid with a cmdline fallback. But the operative reality is worse than the bead —
  > **the registry branch never fires at all** (measured **0 of 32** live panes resolve via the registry;
  > 32 of 32 take the ungated fallback), because it keys on `sessions.pid` (the plugin process) while the
  > tmux subtree yields the `opencode attach` TUI process. The conclusion held for a reason nobody had
  > written down. Filed as **`pigeon-toi`** (P3), which notes that the pid-mismatch *cause* is inference
  > from a 0/32 match rate plus code reading — no single pid was traced end to end — so that must be
  > confirmed before designing a fix.
  >
  > Note also that this bead was ranked **"probably the DOMINANT remaining leak source"** twice without
  > ever being measured — in the same document whose Cycle 2 retraction says *"Measure a
  > resource-exhaustion bead before ranking it."* Writing the lesson down did not cause it to be applied.

> **Q3 — "the same code and almost certainly the same root" was also false.** `4b` really is
> `current-state-ingest.ts`; `4a`'s overnight traffic is `index.ts:565` `onSessionStart`, plugin-driven
> registration of new sessions, and `/current-state` contributed **zero** of the 10 deep-overnight
> registrations. Bundling them cost nothing this time (reading the file was ~10 minutes of a
> multi-hour timestamp forensic) but the premise was unsound. The one genuine overlap is narrow and
> worth keeping: `/current-state` is the only production path that registers a session the daemon does
> not own, which is both `4b`'s mechanism **and** the only thing that made `4a`'s "historical session"
> reading superficially plausible. That coincidence is what let the misreading survive.
- [x] **4c. `pigeon-cn8`** — DONE `ded5a92`. Daemon-side, at the stop-enqueue point: a matched session
  gets no outbox row, so no worker call, no topic and no budget spend. Configurable via
  `PIGEON_QUIET_TITLE_PATTERN` (case-insensitive regex; invalid values log and fall back rather than
  throwing or matching everything), defaulting to `lgtm`. Every suppression logs `[stop] quieted` with
  the session id and title — a silent suppressor would be exactly the §1.-1 shape this roadmap keeps
  getting bitten by.
  **Two design decisions worth keeping, both measured rather than assumed:**
  - **`question` notifications are deliberately NOT suppressed.** Measured on the live DB: **0 of 55
    `pending_questions` rows belong to an lgtm-titled session** — they do not ask questions in
    practice, so exempting the class costs nothing today and removes the one real hazard (an
    automation session blocked on a human, silently, forever). Because topics are created **lazily on
    first send**, a matched session now gets a topic *only if it actually asks something* — i.e. only
    when there is something worth reading.
  - **`morning-agent` is NOT in the default pattern**, despite this file grouping it with lgtm as "the
    same problem". It is not the same: the morning workspace-recovery agent is deliberately
    Telegram-reachable and the user interacts with it. Suppressing it would break a feature. It stays
    reachable through the env var for anyone who disagrees.
  Safe because `notifyStop` is fire-and-forget (`index.ts:416`) with no retry queue, so the
  `notified: false` response cannot induce a retry loop.
  **Original entry, for the reasoning:** — with `4a` refuted this is now the ONLY confirmed amplifier, and the one the
  user actually feels. **Re-measured 2026-08-01: 59 of 110 forum topics — 53.6%**, up from the
  40-of-82 (49%) measured a day earlier, so it is growing in both absolute and relative terms. Every PR
  spawns at least two (a gather pass and a review pass, visible in the topic
  names), and the review pass can be re-summoned repeatedly. With topics enabled each one gets its
  **own topic**, so this is topic-list noise as well as notification noise, and it spends the §3
  budget on messages the user reports never once having read.
  **The obvious approach does not work.** lgtm sessions do **not** live in `~/projects/lgtm` — only
  the dispatcher does. The review sessions run inside the *target* repo's worktree
  (`/home/dev/projects/mono/.worktrees/pr-4005`), so a directory denylist cannot catch them without
  hiding real work in those same repos. (`docs/plans/2026-06-06-current-state-command-design.md`
  assumes the `~/projects/lgtm` location; that holds for the dispatcher only.) **Confirmed by
  measurement**: the 57 strict-matching lgtm topics span **32 distinct directories** and **none** is
  under `~/projects/lgtm`. Make the match **configurable** rather than hardcoding `.lgtm-`, because
  `morning-agent` has the same problem and cannot be filtered by directory either (it runs in
  `~/projects/workstation`, a real work dir; 3 such topics measured). Corral to one shared topic or
  suppress outright; the user leans suppress and would accept corralling.
  > **CORRECTION — "the title *always* names the prompt file" is false, and the signal is softer than
  > this entry implies.** Measured across all 110 topics: `.lgtm-` as a strict substring matches **57**,
  > while a case-insensitive `lgtm` matches **59**. The two stragglers are
  > *"Review PR using LGTM prompt"* and *"PR review from LGTM prompt"* — they name the tool in prose and
  > never the filename. The reason matters for the design: **the topic name derives from the
  > model-generated TUI title**, so it is a *description* of the prompt file, not a field containing it.
  > No exact token can be relied on. Match case-insensitively on `lgtm`, treat the classifier as
  > best-effort, and accept that a few will leak through — a missed suppression is a cosmetic
  > degradation, whereas a false positive would suppress real work, so **bias the pattern toward
  > precision and let the stragglers through.** A structurally reliable signal would have to come from
  > the launcher tagging its own sessions, which lives in another repo and is out of scope here.
- [x] **4d. `pigeon-93v`** (P2) — DONE `f3231c3`. Returns HTTP **200** with
  `{ ok: false, deliveryState: "failed" }` plus a `[question]` warn line carrying `failedReason`.
  **The 2xx is load-bearing and must not be "improved" to a 4xx/5xx**: `sendQuestionAsked` (the retry
  queue's own path) *throws* on non-2xx, and `notifyQuestionAsked` calls `onFailure()` on non-2xx,
  tripping the plugin circuit breaker. Signalling failure in the **body** under a 2xx lets the queue
  see the failure, judge it correctly, and reschedule — with no exception and no breaker damage.
  The plugin-side composition test is the one that pins the actual consequence (entry stays queued and
  is retried); the daemon test alone would only pin a string. Both regressions were injected and
  observed failing.
  **Original entry, for the reasoning:** — **do this BEFORE `8l7`, it is the cheapest real fix left in the
  roadmap.** `/question-asked` (`app.ts:479-484`) early-returns for an existing outbox row without
  inspecting its state, so a `failed` row is reported as `"queued"`. The reason that matters more than
  it sounds: **the lie is load-bearing.** The plugin's question retry queue treats `"queued"` as
  *success* (`question-queue.ts:49-54`) and drops the entry (`:163-169`) — so the daemon's false
  reassurance is exactly what makes the loss permanent, by telling the one component that would have
  retried not to. The path is also **completely silent**: unlike its stop twin at `app.ts:386` it logs
  nothing, which is why 7 days of journald containing 687 outbox lines could not have recorded it.
  This is §1.-1's shape again — a swallow turning a hard failure invisible — except here it turns a
  failure into a reported *success*. Returning `"failed"` and logging is a few lines and needs none of
  the TTL reasoning that blocks `bvh`. **Do it before `8l7` for the same reason `cn8` comes before
  `8l7`:** there is no point alerting on terminal drops while one class of drop is still reported as a
  success.
- [x] **4e. `pigeon-8l7`** — DONE `d0f0576` + `9357cab`, in two commits.
  - **`d0f0576` — one choke point.** All **seven** `markFailed` sites in `outbox-sender.ts` now route
    through a private `markTerminal(...)` that marks the row, does the `reregisteredEntries` cleanup
    every site used to repeat, and emits one greppable token: **`outbox terminal drop`** with
    `notificationId`, `sessionId`, `kind`, `reason`, `attempts`, `ageMs`, `lastError`. Before this there
    was **no single token** covering terminal drops — five different phrasings — and the
    `payload_empty` path (line ~287) **logged nothing at all**, so one whole class of drop was
    invisible. The per-site lines were replaced rather than kept, since they duplicated fields the
    uniform line carries; verified first that **no doc, skill or runbook greps for the old strings.**
    The `LEAKED worker session row` warning is deliberately preserved.
  - **`9357cab` — countable from outside.** `GET /outbox/stats` returns counts by state, `failed`
    broken down by `failed_reason`, and the age of the oldest queued entry. **Aggregates only — no
    payloads, no tokens, no session ids** — which is what makes it safe on the anonymous allowlist
    beside `/health`. This is the non-Telegram path: `curl` it during an outage; it reads the `failed`
    rows Cycle 3's 7-day retention already keeps.
  **Deliberately NOT built:** a pager, a Telegram alert, or a background alerting daemon. The first
  depends on the broken channel; the others are a larger design. This delivers the signal and the
  counter and leaves the consumer to a follow-up.
  **Original entry, for the reasoning:** — promoted: with `4a` refuted, this is the highest-value item in the cycle.
  No alerting on terminal drops. **The surfacing path must not depend on Telegram**, since Telegram
  being broken is the common cause. It was held behind `4a` for a cycle on a prerequisite that turned
  out to be fictional; the *only* surviving reason to sequence anything before it is `4c` — alerting
  while 53.6% of traffic is unread lgtm noise means the first thing the new alerting does is page about
  messages nobody wants. That argument is real but much weaker than the one it replaces, and it
  applies to alert **volume**, not correctness.
  **Note what `4a` measured, because it changes this bead's own framing:** the "~150 messages died
  overnight" in the bead description is **ordinary traffic for a 6-hour outage on this machine**, not
  an amplified storm. That makes alerting *more* justified, not less — the steady-state loss rate
  during an outage is ~13/hour with no pathology required.
- [ ] **4f. `pigeon-m74`** (P3) — **evidence-gated; do not schedule it, let `4e` produce it.** Cycle 3's
  drain governor assumes 12 chunk-sends/min leaves ~8/min of the §3 budget spare, but it counts its own
  invocations rather than Telegram-side messages: one chunk call can cost more (lazy
  `createForumTopic`; the General-fallback path sends twice), and acks, wizard edits and media are
  invisible to it entirely. Bounded by the reactive 429 pause, so the failure mode is oscillatory
  drain, not loss. It is placed here because **`4e` is the instrument** — whatever non-Telegram
  surfacing `8l7` builds should record the real Telegram-side call rate during a drain, which turns
  this from a guess into a measurement. **Do not tune the constant without that data**; picking a
  smaller number by intuition is exactly the move this roadmap has been burned by.

**Revised execution order, 2026-08-01: `4d` → `4c` → `4e` → (`4f` only if `4e` produces data).**
`4a` and `4b` are closed by measurement without code. `4d` goes first because it is a few lines, has no
prerequisites, and removes a *reported success* that is actively suppressing a retry — while it stands,
any alerting built in `4e` is blind to that entire class of drop. `4c` next, because it is the only
confirmed amplifier and it halves the volume `4e` will alert on. `4e` last, as before, but now for a
much weaker reason than the one originally given.

Deferred out of this cycle: **`pigeon-bvh`** (P3, blocked on `4d`) — actually resurrecting the failed
question row rather than merely reporting it honestly. It carries a trap that makes it worth its own
slot rather than a rider on `4d`: Cycle 3 grounded question expiry in `PENDING_QUESTION_TTL_MS` on the
argument that an expired question is *provably unanswerable*, so resurrecting the outbox row without
also refreshing the `pending_questions` clock would hand the user a question they cannot answer —
defeating the reasoning that justifies the expiry design. `pending_questions` is keyed by `session_id`
with `INSERT OR REPLACE`, which constrains the options.

### Cycle 5 — the server side (the track this roadmap was missing)

Cycles 0–3 are **entirely client-side mitigations**. `pigeon-dul` makes the argument this roadmap
initially failed to answer: if the worker's session store fails recurrently, client fixes reduce
blast radius but **do not cure the outage**.

- [ ] **5a. `pigeon-dul`, re-scoped 2026-07-31.** The original forensics are no longer possible — the
  outage window is 16 days old and `wrangler.toml` has **no observability, no Logpush, no
  tail_consumers**, so Cloudflare no longer holds those logs. New scope: enable Workers
  observability/Logpush, log status+body on the `/sessions/register` and `/notifications/send`
  failure paths, and surface D1/KV/DO errors distinctly instead of collapsing them into a generic
  error response.
  > One inference in the original bead is now known to be over-confident: it reasoned that `ok=false`
  > proved an *app-level* rejection rather than a transport failure. Under the code of the time that
  > was not decidable — the old `sendNotification` never inspected `response.status` and called
  > `response.json()` unconditionally, so a 500 carrying a JSON body produced `ok=false` too. As of
  > `pigeon-3h9` the two are distinct, so a recurrence is separable **from the client side alone**.
- [ ] **5b. `pigeon-e44`** (P3) — entity stripping fires on **any** Telegram 400, not just
  entity-parse errors (Telegram also returns 400 for e.g. "message is too long"). Then the strip is
  persisted by rewriting the payload, so formatting that was never the problem is discarded
  permanently. No data-loss regression — the entry dies at the same budget it would have anyway —
  so this is a precision issue, not a correctness one.
  **It is here, in the observability cycle, for a specific reason: its own trigger is currently
  unobservable.** The bead says to fix it "only if a real non-entity 400 is observed", but
  `outbox-sender.ts:417` logs *that* entities were stripped and never Telegram's `description`, so
  nothing records **why** a strip happened. **Step one is two lines — log `details.description` on
  the strip arm — and step two is to look before deciding whether step three is worth doing at all.**
  This is the same shape as `pigeon-bea` in Cycle 2: there, measuring first invented a one-week
  deadline and then destroyed it; here, measuring may well retire a P3 without any code change.
  Either way the measurement comes first.

### Cycle 6 — topic-specific residuals

- [ ] **6a. `pigeon-5o7`** — scope `deleteTopicBySession` to the stale thread id. Latent TOCTOU, safe
  today only by architectural accident (sequential outbox, single daemon, and a `fetch` with **no
  timeout**). Adding a fetch timeout — an obviously reasonable change — silently breaks it.
- [ ] **6b. Classify `TOPIC_NOT_MODIFIED` explicitly.** Reopening an already-open topic returns
  `400 Bad Request: TOPIC_NOT_MODIFIED` (measured). Classifying it retires the Checkpoint 2b trade
  where *any* generic reopen failure marks the row open and never retries.
- [ ] **6c. Drop the T2.6 reopen-before-send call**, or make it conditional. Proven belt-and-braces —
  a bot *can* post into a closed topic — so it spends budget (§3) for nothing. Depends on 6b.
- [ ] **6d. `pigeon-cx2`** — the `/current-state` **index** message bypasses the outbox *and the worker
  entirely* (a raw Telegram call from the daemon). Cycle 0 made the cards durable and left the framing
  message best-effort, so it is now the lossiest part of the command. Needs a different fix shape:
  `/notifications/send` requires a registered `sessionId` and the index has none. Its deeper
  significance: a daemon-direct-to-Telegram path makes any shared rate gate (6a) **structurally
  blind**, so shrinking that path is a precondition for 6a, not a cleanup.
- [ ] **6e. `pigeon-6hl`** (P3) — re-running `/current-state` also delivers the previous run's queued
  cards, stale ones first.
- [ ] **6f. `pigeon-1rb`** (P3) — document the 2xx-without-`ok` contract in `safeExecuteWorkerFetch`;
  it now fails **open** where the old code failed closed. Safe today, verified endpoint by endpoint.
- [ ] **6g. `pigeon-66y`** — flip the worker test default to topics-on and delete the flag-off
  equivalence tests, once the flag is permanent.
- [ ] **6h. `pigeon-wly`** (P3) — reap-loop generic failures pin head-of-line slots, degrading the
  reaper to 4 of 5 slots. Accepted residual; fix only if it bites.

- [ ] **6i. `pigeon-cal`** (P2) — webhook acks are fire-and-forget, so an ack Telegram rejects
  vanishes with no exception, no log and no fallback (`webhook.ts` `sendTelegramMessage` discards the
  `TgResult` deliberately; `telegram.ts` `sendMessage` returns it and never throws). The messages
  that vanish are exactly the **error** messages — "Could not find a session for that message" — so
  the failure class is errors being invisible at the point of failure, reintroduced by a different
  mechanism in the very work meant to fix it. The notification path is fully defended here (reopen,
  `thread_not_found` recovery, non-429 fallback); the webhook confirmation path has none of it.
  **Gated on `pigeon-cev` item 3** — whether a bot admin can post into a *closed* forum topic. If it
  can, there is no bug at all. **Verify that before building a fallback**, since building one now
  means guessing a Telegram behaviour, which this plan has twice refused to do.
  Note this is the same shape as the Cycle 2 sweep bug in §1.-1: a deliberate swallow that converts a
  hard failure into an invisible one. Whatever is done here, the fix is to make the outcome
  observable, not merely to add a retry.

### Cycle 7 — close out the migration

- [ ] **7a.** Record the observed 429 rate during burn-in. The deferred chat-level `next_send_at` gate
  in D1 named an explicit trigger: build it if 429s recur on more than a handful of days. Flip day
  produced a burst, but confirm it recurs rather than being the one-off `/current-state` fan-out that
  Cycle 0 already fixed. **Blocked on 6d** — the gate is blind while the daemon-direct path exists.
- [ ] **7b.** Drop `8248645256` from `ALLOWED_CHAT_IDS`. **Last, and only after a full burn-in.**
  Irreversible in practice.

---

## §4.1 — Explicitly OUT of scope for this roadmap

Re-measuring on 2026-07-31 found **44 open beads**; this roadmap covers ~20. The rest are real but
belong to other themes, and are listed here so a future reader does not mistake this file for the
whole backlog:

- **Launch/TUI:** `pigeon-92q` (headless `/launch` completes with no notification when
  `oc-auto-attach` fails). Delivery-adjacent in symptom, different subsystem in cause.
- **Swarm:** `pigeon-3m5`, `pigeon-web`, `pigeon-0ky`.
- **Serve routing:** the `pigeon-u1u` epic and `pigeon-886`, `pigeon-76k`, `pigeon-amr`, `pigeon-r2e`.
- **Chores/infra:** `pigeon-0n6`, `pigeon-0pp`, `pigeon-fia`, `pigeon-m68`, `pigeon-0zl`, `pigeon-4v0`,
  `pigeon-0u5`, `pigeon-f2i`, `pigeon-mud`, `pigeon-ewr`, `pigeon-050`.

### Closed during restructuring

- `pigeon-3tx` (P1) — **already implemented**; a phantom P1 sitting in the ready queue. All three
  components it specifies exist (`question-queue.ts`, the outbox, worker `deduplicated:true`).
- `pigeon-vmi` (P3) — superseded: `pigeon-3h9` delivered the structured type, `pigeon-bzf` carries the
  retry decision.

> **Both were found only by re-measuring instead of trusting the inherited list — the same discipline
> that caught the false test baseline in §0.** Do this at the start of every restructuring.

## §4.2 — Feature track (parallel; no dependency on the hardening spine)

These are **not** delivery-hardening and are deliberately kept off the numbered spine, because the
Cycle ordering above encodes a risk argument and these carry none of it. They can be picked up in any
gap, in any order, without disturbing the sequence — with one exception noted below. Same protocol
as §2 (compact → optional `oracle-fable` → SDD → `adversarial-reviewer-fable` → PR).

Note the one genuine feature that is NOT here: `pigeon-cn8` (lgtm noise) sits at **4c** on the spine
instead, because it is an amplifier. It halves forum-topic creation and spends the §3 budget, which
makes it delivery work that happens to also be a quality-of-life win.

- [ ] **F1. `pigeon-4ne`** (P3) — topic names are unreadable: dir first, absolute, and clamped at
  Telegram's 128-char limit. Measured 2026-07-31 at **77–115 chars**, roughly 19 of them spent on the
  constant `/home/dev/projects/` prefix before any information appears. Two problems, and the second
  is not cosmetic: the list reads as a column of identical prefixes, **and the clamp eats the wrong
  end** — because dir comes first, a long path truncates the *title*, which is the informative half.
  Put the **title first**, abbreviate `$HOME` to `~` (derive it from the session's own home; macbook
  is not `/home/dev`), keep the path as the suffix. Decide explicitly what happens to the 82 existing
  topics — leave, rename-on-next-touch, or backfill via `editForumTopic` — rather than discovering
  the inconsistency later.
- [ ] **F2. `pigeon-pnf`** (P3) — add `/rename <new title>`, the manual complement to F1, for when
  the auto-derived title has gone stale. Follow the existing reply-resolved command pattern
  (`webhook.ts:712`, `:734`, helper at `:538`); `editForumTopic` already exists in the Telegram
  client. Rename the **title only** and let `topicName` re-derive the suffix, so the two naming paths
  cannot drift. Must degrade gracefully with topics disabled. **Sequence after F1** — the only
  ordering constraint in this track — or the naming logic gets written twice.

**Do `pigeon-cn8` (4c) before F1 if you want the easy win first:** it removes roughly half of all
topics, which makes the naming change much easier to evaluate against a list that is mostly real
work.

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
