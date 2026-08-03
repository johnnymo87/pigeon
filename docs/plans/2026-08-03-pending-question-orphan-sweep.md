# pending_questions: replace the never-called age sweep with an orphan sweep

Bead: pigeon-uyv. Follows PR #46 (c0358e6), which made *expired* `pending_questions`
rows load-bearing.

## Problem

`PendingQuestionRepository.cleanupExpired(now)` (`packages/daemon/src/storage/repos.ts:459`)
deletes `WHERE expires_at < ?` and has **zero callers**. Its sibling repos are swept
(`sessions`/`sessionTokens` from `app.ts:617-618` and `session-reaper.ts:46`), so it reads
like an oversight that someone should "fix" by wiring it into the reaper.

Wiring it in would be a regression. PR #46 resurrects an *expired* row when a late Telegram
answer carries a `metadata.questionRequestId` matching the row's `request_id`
(`command-ingest.ts:157-164`). An age-based sweep deletes exactly those rows, narrowing the
resurrection window to at most one reaper cycle past the 4h TTL and silently re-breaking the
incident pigeon-uyv was filed for.

Meanwhile the real garbage is unswept: **52 of 54 rows in the production DB are orphans**
(no matching `sessions` row), oldest created 2026-03-18. The reaper deletes stale `sessions`
and `assignments` (`session-reaper.ts:30-33`) but leaves the question row behind.

## Invariant this rests on

An orphan row is unreachable. `ingestWorkerCommand` calls `storage.sessions.get()` at
`command-ingest.ts:123` and, when the session is absent, drops the command with a
user-visible reply and returns at `:136` — strictly before the only two reads of
`pending_questions` (`:139` and `:158`). Deleting a row whose session is gone is therefore
a behavioral no-op, and needs no arbitrary time horizon.

## Design

Sweep by **orphanhood, never by age**.

There are four session-deletion paths — the reaper loop (`session-reaper.ts:30`),
`sessions.cleanupExpired` (`session-reaper.ts:46`), `DELETE /sessions/:id`
(`app.ts:886-892`), and dead-session cleanup on connection failure. Adding a
`pendingQuestions.delete()` beside each would rot as paths are added. A single anti-join in
the reaper covers all four and any future one.

### Changes

1. **Delete `PendingQuestionRepository.cleanupExpired`** (`repos.ts:459-464`). Removes the
   trap permanently. This is the mandatory half.

2. **Add `PendingQuestionRepository.deleteOrphaned(): number`**:
   ```sql
   DELETE FROM pending_questions
   WHERE session_id NOT IN (SELECT session_id FROM sessions)
   ```
   Returns rows deleted.

3. **Call it from `reapStaleSessions`** (`session-reaper.ts`), *after* both the reap loop and
   `sessions.cleanupExpired(now)`, so sessions deleted this cycle are swept the same cycle.
   Log when non-zero, matching the existing `cleaned N expired session records` style. Include
   the count in `ReapResult` (e.g. `orphanedQuestions`).

4. **Comments must state the invariant and the guard.** On `deleteOrphaned` and at the call
   site, in substance: orphan rows are unreachable because `command-ingest` checks
   `sessions.get` before any `pending_questions` read; **do not add an age/expiry-based sweep
   here** — expired-but-live rows are load-bearing for question resurrection
   (`command-ingest.ts:157`).

5. **Update the `getBySessionIdIncludingExpired` doc comment** (`repos.ts:404-415`), which
   currently says "`cleanupExpired` has no caller". Replace with: age-based cleanup
   deliberately does not exist; the reaper's sweep is session-scoped, never age-scoped.

### Deliberately NOT doing

No age floor on the sweep (e.g. "only orphans older than 14d"). The scenario it would defend
— a session reaped after 7d idle, then re-registered under the same `ses_*` id, then a
>7-day-old button press — is a triple conjunction whose failure mode is a polite user-visible
error, not corruption. Note that a **text** answer still works even then, via the metadata
fallback at `command-ingest.ts:423-454`, which needs no row. An age floor would import the
worker's 14-day `messages` retention into the daemon as a magic number for that sliver. If it
is ever observed in production (a `:407` "no longer answerable" log preceded by a reap log for
the same session), add the floor then.

## Tests

TDD, in `packages/daemon/test/`. Follow existing suite conventions.

1. **The guard test — most important.** Live session + **expired** question row → run
   `reapStaleSessions` → row survives → `ingestWorkerCommand` with a matching
   `metadata.questionRequestId` still resurrects and routes the answer. Name it so its
   purpose is obvious (it fails if anyone reintroduces age-based sweeping).
2. Stale session reaped via the `listStale` path → its question row is deleted the same cycle.
3. A session removed via the `sessions.cleanupExpired` path only → its question row is still
   swept. Pins "the anti-join covers all deletion paths, not just the reap loop".
4. Sweep is a no-op when every row has a live session (returns 0, deletes nothing).

Existing resurrection tests (`command-ingest.test.ts`) must stay green and untouched.

## Gates

`npm run test` and `npm run typecheck` from the repo root.

Note: `packages/daemon/test/routing/lease-cas-concurrency.test.ts` is a known load-sensitive
flake (pigeon-cv0 / pigeon-m68), unrelated to this change. If it fails, re-run it on an idle
machine before believing it. `npm run typecheck` has pre-existing errors in
`lease-cas-concurrency.*` tracked by pigeon-m68 — do not fix them here, but do not add new ones.
