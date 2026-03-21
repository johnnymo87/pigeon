# Pigeon `/compact` Slash Command

## Problem

When a headless Claude Code session's context window fills up, the only way to trigger compaction is through OpenCode's UI (web or TUI). There's no way to compact a session from Telegram, which is the primary interface for managing headless sessions launched via pigeon.

## Decision

New `command_type: "compact"` (Approach A). Follows the same pattern as `/kill` -- a session-targeted command with no prompt text. The daemon resolves the model from the session's message history and calls OpenCode's summarize API. No changes to OpenCode itself.

## Design

### 1. User interaction

Swipe-reply on any notification from a running session and type `/compact`. The worker sends an immediate ack: "Compacting session `<id>`...". OpenCode processes the compaction and the summary flows back through the plugin's existing notification path as a normal assistant message.

### 2. Data flow

```
Telegram (swipe-reply + "/compact")
  → Worker: parse /compact, resolve session_id from reply-to
  → D1: INSERT command {command_type: "compact", session_id, machine_id}
  → Telegram: "Compacting session <id>..."
  → Daemon polls: receives CompactMessage
  → Daemon: GET /session/<id>/message (find last user message's model)
  → Daemon: POST /session/<id>/summarize {providerID, modelID}
  → OpenCode compacts, emits summary as assistant message
  → Plugin relays summary notification to Telegram (existing flow)
```

### 3. Worker changes (`packages/worker/`)

**`webhook.ts`**: Add regex `/^\/compact$/` for the `/compact` command. When matched inside a reply-to context, resolve `session_id` from the `messages` table (same as existing reply routing), look up `machine_id` from `sessions` table, check `isMachineRecent`, queue with `command_type: "compact"`. Reply with ack.

**`poll.ts`**: Shape the poll response for `compact` commands -- include `sessionId` (like `kill`), no `command` or `directory`.

**No D1 schema migration** -- `command_type` is already a free-text `TEXT` column.

### 4. Daemon changes (`packages/daemon/`)

**`poller.ts`**: Add `CompactMessage` interface and `onCompact` callback to `PollerCallbacks`.

```typescript
interface CompactMessage {
  commandId: string;
  commandType: "compact";
  sessionId: string;
  chatId: string;
}
```

**`compact-ingest.ts`** (new file): `ingestCompactCommand(msg, deps)` -- fetches session messages from OpenCode API, extracts `providerID`/`modelID` from the last user message, calls summarize.

**`opencode-client.ts`**: Add two methods:
- `getSessionMessages(sessionId)` -- `GET /session/{id}/message`
- `summarize(sessionId, providerID, modelID)` -- `POST /session/{id}/summarize`

**`index.ts`**: Wire `onCompact` callback to `ingestCompactCommand`.

### 5. Error handling

- `/compact` without replying to a session notification: worker replies "Reply to a session notification to compact it."
- Machine offline: worker replies "Machine `<id>` is not reachable."
- Summarize API failure: daemon logs the error. Lease expires after 60s, allowing one retry. On second failure the command ages out.

### 6. No changes required to

- D1 schema (command_type is free-text)
- OpenCode plugin (summary notifications use existing event flow)
- OpenCode itself (summarize endpoint already exists)
