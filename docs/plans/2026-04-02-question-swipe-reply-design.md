# Question Swipe-Reply Robustness Design

## Problem

When a user swipe-replies to a question notification in Telegram, the text should
be delivered as a custom answer to the pending question. Instead, the reply is
sometimes delivered as a regular `prompt_async` command, which queues in opencode
because the AI is blocked on the unanswered question. The question remains open
and the reply text sits as a queued prompt.

## Root Cause

The daemon's `command-ingest` decides whether to route a command as a question
answer based solely on whether `storage.pendingQuestions.getBySessionId()` returns
a record. If the pending question is missing (expired, cleared by a race, or lost
during a daemon restart with stale state), the command falls through to the
regular `deliverCommand` path.

The worker has the information needed to tag the command as a question reply (the
`messages` table stores `notification_id` which is `q:{sessionId}:{requestId}`
for question notifications), but currently discards this context.

## Solution

Thread question context from the worker through to the daemon so that swipe
replies to question notifications are always identifiable as question answers,
regardless of local daemon state.

### Changes

1. **D1 `commands` table**: Add nullable `metadata_json TEXT` column.

2. **Worker `resolveMessageSession`**: When the looked-up message has a
   `notification_id` starting with `q:`, extract `requestId` from
   `q:{sessionId}:{requestId}` and return it as `questionRequestId` alongside
   `sessionId` and `command`.

3. **Worker `queueCommand`**: Accept and persist optional `metadataJson` into the
   new column.

4. **Worker `handleTelegramWebhook`**: When `resolveMessageSession` returns a
   `questionRequestId`, pass `{ questionRequestId }` as metadata to
   `queueCommand`.

5. **Worker `pollNextCommand` / `handlePollNext`**: Read `metadata_json` from the
   row, include it in the poll response as `metadata`.

6. **Daemon `ExecuteMessage`**: Add optional `metadata?: { questionRequestId?: string }`.

7. **Daemon `command-ingest`**: After the existing `pendingQuestions.getBySessionId`
   check, add a fallback: if no pending question found but `msg.metadata?.questionRequestId`
   exists, deliver the command text as a custom answer via
   `adapter.deliverQuestionReply` using the metadata's `questionRequestId`.
   Log a warning when the fallback is used.

### What this does NOT change

- Button presses (callback queries) are unaffected.
- Wizard multi-question flow is unaffected.
- The happy path (pending question found locally) is unchanged.
- No changes to the opencode plugin or opencode serve.

### Observability

- `[command-ingest] question-reply via metadata fallback` log line when the
  fallback path is used.
- `[command-ingest] no pending question and no metadata, delivering as prompt`
  log line on the existing regular-command path (new, helps diagnose future
  issues).
