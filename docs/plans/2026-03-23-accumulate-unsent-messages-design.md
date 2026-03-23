# Accumulate Unsent Assistant Messages

## Problem

The plugin's `MessageTail` is a single-message sliding window. When a new assistant message arrives, it replaces the previous one (`text = ""`, `files = []`). If the model produces multiple assistant messages back-to-back without an idle gap, only the last message is available when `session.idle` fires. Substantive content is silently lost.

Example: the model produces a 5,348-char analysis followed by a 214-char coda. The analysis is discarded and only the coda is sent to Telegram.

## Decision

Accumulate unsent messages (Approach A). `MessageTail` becomes a queue of unsent message texts instead of a single slot. All accumulated text is flushed on `session.idle`. Never lose content, even if it means slightly noisier notifications during tool-heavy sessions.

## Design

### 1. MessageTail: accumulate instead of replace

**Current:** `onMessageUpdated` with a new message ID resets `text = ""` and `files = []`.

**New:** `onMessageUpdated` with a new message ID pushes the current `{text, files}` onto a `pending` array (if text is non-empty), then starts fresh for the new message.

`getUnsentText(sessionId)` (renamed from `getSummary`) returns all pending texts plus the current message's text, joined with `\n\n---\n\n` separators, stripped of markdown. Clears the pending array afterward.

`getFiles(sessionId)` returns files from all pending entries plus the current message. Clears the pending file entries afterward.

Eviction and capacity-cap logic unchanged -- operates per-session.

### 2. Session state: no changes

The existing `SessionManager` logic works unchanged:

- `shouldNotify` checks `currentMsgId !== lastNotifiedMessageId`. Since `onBusy` clears `lastNotifiedMessageId` on each `message.updated`, this is always true by the time `session.idle` fires after new work.
- `setNotified` marks the current message ID as sent. The pending buffer is cleared inside `getUnsentText`, so re-idle only sends new content.
- `onBusy` resets from `Notified` to `Registered` on each `message.updated`. Unchanged.

### 3. Rename getSummary to getUnsentText

`getSummary` is misleading -- it implies summarization but just returns raw stripped-markdown text. Rename to `getUnsentText` across `message-tail.ts` and all call sites in `index.ts`.

### 4. What we're NOT doing

- No per-message notifications (too noisy, complex "message complete" detection).
- No intelligent message selection (e.g., "pick the longest"). Just send everything.
- No daemon or worker changes. Message splitting already handles Telegram's 4096-char limit.
- No changes to question notification flow (already works correctly).
