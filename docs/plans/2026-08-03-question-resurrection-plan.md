# Question-answer routing: resurrect expired rows instead of dropping presses

Beads: **pigeon-5d0** (primary), **pigeon-wzk** (identity validation, folded in).
Sibling **pigeon-uyv** is PR 2 — out of scope here, but see "Interaction with PR 2".

## The defect

A Telegram inline-button press answering an opencode question is silently
swallowed once the daemon's `pending_questions` row passes its 4h TTL. Observed
2026-08-03 on `ses_0462c82eaffeJK15wIPKtcql7C`: press arrived 65 minutes after
expiry, user saw a "Command sent" toast, nothing happened.

Two independent causes:

1. **Worker never supplies the question identity on the callback path.**
   `resolveCallbackSession` (`packages/worker/src/webhook.ts:579-601`) has the
   `messages` row in hand — including `notification_id` — but returns only
   `{sessionId, command}`. The plain-message path does extract it
   (`webhook.ts:537-542`) and threads it as `metadataJson`
   (`webhook.ts:1207-1220`); the callback handler passes none
   (`webhook.ts:1246-1253`).
2. **Daemon read path filters expired rows.**
   `PendingQuestionRepository.getBySessionId` (`packages/daemon/src/storage/repos.ts:397`)
   filters `expires_at > ?`. `cleanupExpired` (`repos.ts:423`) has no caller, so
   the row is *physically still present* — only hidden. With no row and no
   metadata, the press falls to the "stale question option" branch
   (`packages/daemon/src/worker/command-ingest.ts:337`), which marks the command
   done and returns without a word to the user.

## Design

### Resurrect the row into the existing path (not a parallel fallback)

The bead originally proposed teaching the metadata fallback to map option
indices to labels and recover wizard state. Rejected: that duplicates ~80 lines
of wizard semantics (`command-ingest.ts:140-297`) in a second, less-tested
place.

Instead, resolve the pending question with an identity-validated fallback to the
expired row, then run the **existing, untouched** block:

```ts
let pendingQuestion = storage.pendingQuestions.getBySessionId(msg.sessionId);
if (!pendingQuestion && msg.metadata?.questionRequestId) {
  const expired = storage.pendingQuestions.getBySessionIdIncludingExpired(msg.sessionId);
  if (expired && expired.requestId === msg.metadata.questionRequestId) {
    pendingQuestion = expired;
  }
}
```

Why the identity check makes this safe: `pending_questions` is keyed on
`session_id` with `INSERT OR REPLACE` (`repos.ts:382`), so a new question
destroys the old row. An expired row whose `requestId` equals the pressed
button's is therefore *provably the same question instance*, and its
`currentStep`/`answers` are genuine progress. Resuming mid-wizard is correct.

Every path by which a question legitimately "goes away" **deletes** the row
rather than letting it expire — TUI answer (`app.ts:871`), Telegram answer
(`command-ingest.ts:235`/`:281`), superseding question (REPLACE). So an expired
row that is still present means the question was never observed to be answered.
In the residual case (missed `question-answered`, daemon downtime) opencode
itself rejects the unknown requestId at `/question/{id}/reply`, producing a
visible failure reply. opencode — not the daemon TTL — is the correctness
boundary; the TTL is cache hygiene.

**Do not extend `expires_at` on resurrection.** While a row is live, *every*
plain message to that session is hijacked into a question reply at
`command-ingest.ts:139`. Re-arming that for ordinary prompts would be a
regression. Resurrection stays stateless and read-only: each metadata-carrying
press independently resurrects.

### Guard ordering — the double-press trap

Supplying metadata on the callback path creates a new hazard that does not exist
today. The single-question success path deletes the row (`:281`) but leaves the
keyboard on screen (unlike the wizard, which clears it at `:238`), so pressing
the same button twice is common. Post-change: second press carries metadata, no
row exists, the `:303` fallback delivers the raw `q0` string as an answer,
opencode rejects it, and the code **falls through to regular delivery**
(`:330`), injecting the literal `q0` into the transcript as a user prompt.

Therefore the option-token guard must run **before** the metadata fallback, not
after it. When the command matches `QUESTION_OPTION_RE`/`WIZARD_OPTION_RE` and
no pending question was resolved, drop it with a user-visible Telegram reply and
never attempt delivery or fall-through.

### Deliberate behavior change (pigeon-wzk)

When a **live** row exists and `msg.metadata.questionRequestId` is present but
does not match `pendingQuestion.requestId`, the answer belongs to a superseded
question. Today the live row silently wins and the answer is misapplied to a
question the user never read. This becomes a reject-with-echo: the user's text
is quoted back with an explanation, so nothing is lost and they can resend
deliberately.

This **invalidates an existing test**,
`packages/daemon/test/command-ingest.test.ts:1371` "prefers pending question
over metadata fallback (happy path unchanged)", which asserts the old
misapplying behavior. That test must be rewritten to assert the new rejection,
not deleted and not worked around.

### Out of scope, deliberately

- **Topic-membership path** (`webhook.ts:553-558`) still supplies no
  questionRequestId. The only available source would be "newest `q:`
  notification for this session", which would convert an ordinary prompt typed
  in a topic long after a question expired into an answer to a dead question —
  strictly worse than today. The existing comment at `webhook.ts:548-552`
  already documents this decision. Swipe-reply remains the >4h answer path for
  topics.
- **Clearing the keyboard on single-question success** (mirroring the wizard's
  `:238`) would shrink the double-press class at the source. Filed separately.
- **Wiring `cleanupExpired`** — see below.

### Interaction with PR 2 (pigeon-uyv)

pigeon-uyv plans to wire `cleanupExpired` into the hourly reaper. That would
**delete the very rows this PR resurrects**, narrowing the resurrection window
to "expired but not yet swept". If both land, the sweep horizon must be much
longer than the 4h TTL (e.g. 14d) or resurrection stops working for anything
older than an hour. This must be decided deliberately in PR 2.

## Tasks

### Task 1 — Worker: thread questionRequestId through the callback path

Files: `packages/worker/src/webhook.ts`, `packages/worker/test/worker.test.ts`.

1. Extract the `notification_id` → requestId parse currently inlined at
   `webhook.ts:537-542` into a small shared helper. It must preserve the
   `.replace(/#c\d+$/, "")` chunk-suffix strip verbatim — reply markup lands on
   the last chunk of a split notification, whose `notification_id` carries a
   `#cN` suffix. Do not retype the regex in a second place.
2. `resolveCallbackSession` (`:579`) returns `questionRequestId` when the mapped
   `notification_id` starts with `q:`.
3. The callback handler (`:1246`) builds `metadataJson` exactly as the plain
   path does at `:1207-1209` and passes it to `queueCommand`.

Tests:
- `resolveCallbackSession` returns the requestId for a `q:{sessionId}:{requestId}`
  notification_id.
- It strips a `#c2` chunk suffix.
- It returns no requestId for a non-`q:` notification_id (e.g. a stop
  notification), and the handler then queues with `metadataJson` null.
- The callback handler threads the value into `queueCommand`.

### Task 2 — Daemon storage: expiry-agnostic read, and stop re-reading in advanceStep

Files: `packages/daemon/src/storage/repos.ts`, `packages/daemon/test/` (storage tests).

1. Add `getBySessionIdIncludingExpired(sessionId)` — same query as
   `getBySessionId` without the `expires_at` predicate.
2. Change `advanceStep` (`repos.ts:411`) to operate on a record supplied by the
   caller instead of re-reading via `getBySessionId(sessionId, now)`. As written
   it would return `null` for a resurrected (expired) row and soft-lock the
   wizard. Passing the already-loaded record also removes a redundant read —
   `ingestWorkerCommand` is holding it at the call site
   (`command-ingest.ts:185`). The `UPDATE` must not touch `expires_at`.

Tests:
- `getBySessionIdIncludingExpired` returns a row whose `expires_at` is in the
  past, where `getBySessionId` returns null.
- `advanceStep` advances an expired row and leaves `expires_at` unchanged.

### Task 3 — Daemon ingest: resurrection, identity validation, guard reordering

Files: `packages/daemon/src/worker/command-ingest.ts`,
`packages/daemon/test/command-ingest.test.ts`.

1. Resurrection at the `:139` lookup, exactly as in the Design section.
2. Identity validation on a **live** row: metadata present and mismatched →
   reject with a Telegram reply echoing the user's text back. Applies to both
   option presses and free text. Rewrite the test at `command-ingest.test.ts:1371`.
3. Move the option-token guard (`:337`) to run **before** the metadata fallback
   (`:303`), and give it a user-visible reply instead of a silent `markDone`.
   A raw `vN:qM`/`qN` token must never reach `deliverQuestionReply` as an answer
   payload and must never fall through to regular command delivery.
4. The residual metadata fallback keeps its current shape for genuine free text
   with no row at all (`[[msg.command.trim()]]`), including the existing
   fall-through to regular delivery on failure. That behavior is correct for
   text and is covered by existing tests at `:1472` and `:1516`.

Tests (all in `command-ingest.test.ts`):
- Button press with matching metadata against an **expired** row resolves the
  option **index to its label** and delivers with the row's requestId.
- Resurrected **wizard** mid-step advances rather than soft-locking.
- Expired row present but metadata requestId **mismatched** → not resurrected,
  and the press is dropped with a reply (not misapplied).
- Live row + mismatched metadata → rejected with the user's text echoed
  (rewrite of the `:1371` test).
- Double press: no row, metadata present, command is `q0` → dropped with a
  reply, and **no** raw token injected via regular delivery.
- Existing free-text fallback tests at `:1472`/`:1516` still pass unchanged.

## Gates

`npm run test` and `npm run typecheck` from the repo root, both green.
