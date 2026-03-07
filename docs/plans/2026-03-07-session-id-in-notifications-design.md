# Add Session ID to Telegram Notifications

## Problem

Stop and question notifications sent to Telegram don't include the opencode session ID. The session ID is useful for general awareness -- knowing which session produced a notification -- and is already present in launch/kill messages but missing from the main notification types.

## Solution

Append the full session ID to the metadata info line in stop and question notifications, using the existing `· ` separator pattern.

### Before

```
🤖 *Stop*: pigeon

Summary text here...

📂 `projects/pigeon` · 🖥 devbox

↩️ _Swipe-reply to respond_
```

### After

```
🤖 *Stop*: pigeon

Summary text here...

📂 `projects/pigeon` · 🖥 devbox · 🆔 `01JQKW8M9XYZABC123`

↩️ _Swipe-reply to respond_
```

When machine ID is absent:

```
📂 `projects/pigeon` · 🆔 `01JQKW8M9XYZABC123`
```

Same pattern applies to question notifications.

## Data Flow

No new data plumbing needed. The session ID is already available:

1. Plugin calls `daemon.notifyStop({ session_id, ... })` / `daemon.notifyQuestionAsked({ session_id, ... })`
2. Daemon receives it in route handlers, passes it as `input.session.sessionId`
3. Both `TelegramNotificationService` and `WorkerNotificationService` have access to `input.session.sessionId`
4. They just need to forward it to the format functions

## Changes

All changes are in `packages/daemon/src/notification-service.ts`:

1. **`NotificationInput` interface** -- add `sessionId: string`
2. **`formatTelegramNotification()`** -- append `· 🆔 \`${sessionId}\`` to the info line
3. **`formatQuestionNotification()` input type** -- add `sessionId: string`
4. **`formatQuestionNotification()`** -- same info line change
5. **Both service classes** (stop + question methods, 4 call sites) -- pass `sessionId: input.session.sessionId` to the format functions
6. **Tests** -- update format test inputs to include `sessionId`, assert it appears in output

## Not Changing

- Launch/kill messages (already include session ID)
- Worker webhook operational messages (no session context)
- Worker notification proxy (passes through pre-formatted text from daemon)
- Router DO error messages (no session context)
