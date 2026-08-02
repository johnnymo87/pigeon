# Roadmap: Devbox Forum Split — Post-Migration Defect Cleanup

**Spine bead:** `pigeon-k4c` (epic). Every work item hangs off it.
**Status at authoring:** migration DONE and HEALTHY. This roadmap covers only the defects
found while validating it.

If you are reading this after a compaction and have no other context, read
[§1 Where things stand](#1-where-things-stand) then run `bd show pigeon-k4c` and
`bd ready`. That pair is authoritative; this file is the narrative.

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
| `pigeon-2k1` | W2 — terminal rejection silently acked, no feedback, leaks inbox row | P1 | ✅ **PR #39** |
| `pigeon-mmu` | W1 — `forum_topic_created` service message queued as empty command | P2 | ✅ **PR #39** |
| `pigeon-k4c.1` | W2b — question-reply path silent drops + unguarded revive sends | P1 | new, ready |
| `pigeon-tyk` | W3 — caption-less media silently dropped | P2 | ready |
| `pigeon-bru` | W4 — text-less message submits an EMPTY ANSWER to a pending question | P2 | ready |

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

### Suggested order after W0

W2 first (it is the design flaw, and it makes the others observable), then W1 (closes the only
known live producer, and also closes W4), then W3 and W4 as verification.

W1 and W4 likely land together: a worker-side guard fixes both, and W4 is the strongest
argument for fixing at the worker rather than the daemon.

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
