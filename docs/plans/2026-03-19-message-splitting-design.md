# Message Splitting for Long Telegram Notifications

## Problem

The plugin hard-caps Claude output at 4096 chars (`MAX_TEXT_BYTES`) and summaries at 3800 chars (`SUMMARY_MAX_CHARS`). Long Claude responses are silently truncated with no indicator. Users lose the tail of long outputs.

Telegram's `sendMessage` API rejects messages over 4096 UTF-8 characters, so messages that exceed this limit must be split into multiple Telegram messages.

## Decision

Split at the daemon notification service (Approach B). The daemon already knows header vs body vs footer, so it can repeat the framing on each chunk naturally. The worker API stays unchanged -- it receives one call per chunk.

## Design

### 1. Plugin: Remove output caps

Remove `MAX_TEXT_BYTES` and `SUMMARY_MAX_CHARS` from `message-tail.ts`. Let `getSummary()` return the full stripped text with no length limit.

### 2. New utility: `splitTelegramMessage`

Location: `packages/daemon/src/split-message.ts`

```
splitTelegramMessage(header: string, body: string, footer: string, maxLen?: number): string[]
```

- `maxLen` defaults to 4096 (Telegram's limit)
- Calculate overhead = header + footer + joining newlines
- Available per chunk = maxLen - overhead
- Split body on natural boundaries, preferring in order: `\n\n` (paragraph), `\n` (line), `. ` (sentence), then hard cut
- Return array of fully-formatted messages: `[header + "\n\n" + chunk1 + "\n\n" + footer, ...]`
- Single-chunk case (vast majority): identical to current behavior

### 3. Daemon notification formatting

`formatTelegramNotification` returns `string[]` instead of `string` (array of formatted message texts). `formatQuestionNotification` unchanged -- question notifications are short.

### 4. Daemon notification services

`TelegramNotificationService` and `WorkerNotificationService` loop over chunks, sending each as a separate `sendMessage` / `sendViaWorker` call. Only the last message carries the `replyMarkup` (inline keyboard). All chunks share the same token.

### 5. Outbox sender

Question notification payloads may contain `texts: string[]` in addition to `text: string`. The outbox sender sends each text sequentially. Existing single-text payloads continue to work unchanged.

### 6. Worker

No changes. Each chunk arrives as a separate `POST /notifications/send` call. The worker stores each message_id with the same session/token, so reply-to-any-chunk routes correctly.

## Reply routing

All chunks for a single notification share one token (generated once per notification in the daemon). The worker stores `(chat_id, message_id, session_id, token)` for each chunk's Telegram message. A swipe-reply to any chunk resolves to the correct session.

## Splitting strategy

1. Try `\n\n` (paragraph break) -- find last occurrence within budget
2. Try `\n` (line break) -- find last occurrence within budget
3. Try `. ` (sentence end) -- find last occurrence within budget
4. Hard cut at budget

Minimum chunk size before attempting natural split: 200 chars (to avoid pathological fragmentation).
