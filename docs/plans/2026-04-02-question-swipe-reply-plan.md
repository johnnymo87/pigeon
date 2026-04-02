# Question Swipe-Reply Robustness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure swipe-replies to question notifications in Telegram are always routed as question answers, even when daemon-side pending-question state is missing.

**Architecture:** Thread question context (requestId) from the worker's `messages` table through the `commands` table and poll response to the daemon's `command-ingest`, which uses it as a fallback when `pendingQuestions.getBySessionId()` returns null.

**Tech Stack:** TypeScript, Cloudflare D1 (SQLite), better-sqlite3, Vitest

---

### Task 1: Add `metadata_json` column to D1 `commands` table

**Files:**
- Modify: `packages/worker/src/d1-schema.sql`

**Step 1: Add column to schema**

In `packages/worker/src/d1-schema.sql`, add `metadata_json TEXT` to the `commands` table definition, after the `media_json` column:

```sql
CREATE TABLE IF NOT EXISTS commands (
  command_id    TEXT PRIMARY KEY,
  machine_id    TEXT NOT NULL,
  session_id    TEXT,
  command_type  TEXT NOT NULL DEFAULT 'execute',
  command       TEXT NOT NULL,
  chat_id       TEXT NOT NULL,
  directory     TEXT,
  media_json    TEXT,
  metadata_json TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL,
  leased_at     INTEGER,
  acked_at      INTEGER
);
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (schema is just a reference, not used at build time)

**Step 3: Apply the migration to production D1**

This is a nullable column addition, so it's backward-compatible. Run manually after deploy:

```bash
npx wrangler d1 execute pigeon-d1 --command "ALTER TABLE commands ADD COLUMN metadata_json TEXT"
```

Note: This is a forward-compatible change. Existing rows will have `metadata_json = NULL`. The code should handle null gracefully. **Apply this migration BEFORE deploying the new worker code.**

**Step 4: Commit**

```bash
git add packages/worker/src/d1-schema.sql
git commit -m "schema: add metadata_json column to commands table"
```

---

### Task 2: Add `notification_id` to `lookupMessage` return and `resolveMessageSession` output

**Files:**
- Modify: `packages/worker/src/notifications.ts:65-77` (lookupMessage SELECT)
- Modify: `packages/worker/src/webhook.ts:314-341` (resolveMessageSession)
- Test: `packages/worker/test/worker.test.ts`

**Step 1: Write failing test**

In `packages/worker/test/worker.test.ts`, find the existing `resolveMessageSession` tests. Add a new test:

```typescript
it("returns questionRequestId when reply-to message has question notification_id", async () => {
  // Insert a message with a question notification_id
  await env.DB.prepare(
    "INSERT INTO messages (chat_id, message_id, session_id, token, notification_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(String(CHAT_ID_NUM), 9001, "sess-q-test", "tok-q", "q:sess-q-test:req-abc", Date.now()).run();

  const result = await resolveMessageSession(env.DB, {
    chat: { id: CHAT_ID_NUM },
    from: { id: CHAT_ID_NUM },
    text: "my custom answer",
    reply_to_message: { message_id: 9001 },
  } as TelegramMessage);

  expect(result).toEqual({
    sessionId: "sess-q-test",
    command: "my custom answer",
    questionRequestId: "req-abc",
  });
});

it("returns no questionRequestId when reply-to message has non-question notification_id", async () => {
  await env.DB.prepare(
    "INSERT INTO messages (chat_id, message_id, session_id, token, notification_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(String(CHAT_ID_NUM), 9002, "sess-nq", "tok-nq", "stop:sess-nq:xyz", Date.now()).run();

  const result = await resolveMessageSession(env.DB, {
    chat: { id: CHAT_ID_NUM },
    from: { id: CHAT_ID_NUM },
    text: "hello",
    reply_to_message: { message_id: 9002 },
  } as TelegramMessage);

  expect(result).toEqual({
    sessionId: "sess-nq",
    command: "hello",
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run --workspace @pigeon/worker test -- --reporter=verbose -t "questionRequestId"`
Expected: FAIL — `resolveMessageSession` doesn't return `questionRequestId`

**Step 3: Update `lookupMessage` to include `notification_id`**

In `packages/worker/src/notifications.ts`, update the SELECT in `lookupMessage` (line ~72):

```typescript
export async function lookupMessage(
  db: D1Database,
  chatId: string,
  messageId: number,
): Promise<MessageRow | null> {
  const row = await db
    .prepare(
      "SELECT chat_id, message_id, session_id, token, notification_id, created_at FROM messages WHERE chat_id = ? AND message_id = ?",
    )
    .bind(String(chatId), messageId)
    .first<MessageRow>();
  return row ?? null;
}
```

Note: `notification_id` is already in the `MessageRow` interface, so this just adds it to the SELECT.  Check whether the existing SELECT already includes it — if it does, this step is a no-op.

**Step 4: Update `resolveMessageSession` to extract questionRequestId**

In `packages/worker/src/webhook.ts`, change the return type and logic:

```typescript
async function resolveMessageSession(
  db: D1Database,
  message: TelegramMessage,
): Promise<{ sessionId: string; command: string; questionRequestId?: string } | null> {
  const chatId = String(message.chat.id);
  const text = message.text || message.caption || "";

  // Try 1: reply-to-message lookup
  if (message.reply_to_message) {
    const mapping = await lookupMessage(db, chatId, message.reply_to_message.message_id);
    if (mapping) {
      // Extract questionRequestId if this is a reply to a question notification
      let questionRequestId: string | undefined;
      if (mapping.notification_id?.startsWith("q:")) {
        const parts = mapping.notification_id.split(":");
        // Format: q:{sessionId}:{requestId}
        if (parts.length >= 3) {
          questionRequestId = parts.slice(2).join(":");
        }
      }
      return { sessionId: mapping.session_id, command: text, ...(questionRequestId ? { questionRequestId } : {}) };
    }
  }

  // Try 2: /cmd TOKEN command format
  const cmdMatch = text.match(/^\/cmd\s+(\S+)\s+(.+)$/s);
  if (cmdMatch) {
    const token = cmdMatch[1]!;
    const mapping = await lookupMessageByToken(db, token, chatId);
    if (mapping) {
      const command = text.replace(/^\/cmd\s+\S+\s+/, "");
      return { sessionId: mapping.session_id, command };
    }
  }

  return null;
}
```

**Step 5: Run tests**

Run: `npm run --workspace @pigeon/worker test -- --reporter=verbose`
Expected: PASS (both new tests and existing tests)

**Step 6: Commit**

```bash
git add packages/worker/src/notifications.ts packages/worker/src/webhook.ts packages/worker/test/worker.test.ts
git commit -m "feat(worker): extract questionRequestId from reply-to question notifications"
```

---

### Task 3: Thread metadata through `queueCommand` and D1

**Files:**
- Modify: `packages/worker/src/d1-ops.ts:33-82` (queueCommand)
- Modify: `packages/worker/src/webhook.ts:416-447` (local queueCommand wrapper)
- Modify: `packages/worker/src/webhook.ts:714-757` (message handling block)

**Step 1: Add `metadataJson` to `d1-ops.ts` `queueCommand`**

In `packages/worker/src/d1-ops.ts`, add `metadataJson` to the opts type and the INSERT:

```typescript
export async function queueCommand(
  db: D1Database,
  opts: {
    machineId: string;
    sessionId: string | null;
    command: string;
    chatId: string;
    commandType?: string;
    directory?: string | null;
    mediaJson?: string | null;
    metadataJson?: string | null;
  },
): Promise<string | null> {
  const {
    machineId,
    sessionId,
    command,
    chatId,
    commandType = "execute",
    directory = null,
    mediaJson = null,
    metadataJson = null,
  } = opts;

  // ... queue depth check unchanged ...

  await db
    .prepare(
      `INSERT INTO commands
         (command_id, machine_id, session_id, command_type, command, chat_id,
          directory, media_json, metadata_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(commandId, machineId, sessionId, commandType, command, chatId, directory, mediaJson, metadataJson, now)
    .run();

  return commandId;
}
```

**Step 2: Add `metadataJson` to the local `queueCommand` wrapper in `webhook.ts`**

```typescript
async function queueCommand(
  db: D1Database,
  env: Env,
  machineId: string,
  sessionId: string | null,
  command: string,
  chatId: string,
  label: string | null,
  commandType: CommandType = "execute",
  directory: string | null = null,
  mediaRef: MediaRef | null = null,
  metadataJson: string | null = null,
): Promise<string | null> {
  const mediaJson = mediaRef ? JSON.stringify(mediaRef) : null;

  const commandId = await d1QueueCommand(db, {
    machineId,
    sessionId,
    command,
    chatId,
    commandType,
    directory,
    mediaJson,
    metadataJson,
  });

  // ... rest unchanged ...
}
```

**Step 3: Pass `questionRequestId` as metadata in the message handler**

In the message handling block of `handleTelegramWebhook` (~line 753):

```typescript
    // Build metadata if this is a reply to a question notification
    const metadataJson = resolved.questionRequestId
      ? JSON.stringify({ questionRequestId: resolved.questionRequestId })
      : null;

    const commandId = await queueCommand(db, env, machine.machineId, resolved.sessionId, resolved.command, String(chatId!), machine.label, "execute", null, mediaRef, metadataJson);
    if (!commandId) return OK();
```

**Step 4: Run typecheck and tests**

Run: `npm run typecheck && npm run --workspace @pigeon/worker test -- --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/worker/src/d1-ops.ts packages/worker/src/webhook.ts
git commit -m "feat(worker): thread question metadata through queueCommand to D1"
```

---

### Task 4: Include metadata in poll response

**Files:**
- Modify: `packages/worker/src/d1-ops.ts:86-161` (PollResult, pollNextCommand)
- Modify: `packages/worker/src/poll.ts:51-62` (execute response shaping)

**Step 1: Add `metadataJson` to `PollResult`**

In `packages/worker/src/d1-ops.ts`:

```typescript
export interface PollResult {
  commandId: string;
  sessionId: string | null;
  command: string;
  chatId: string;
  commandType: string;
  directory: string | null;
  mediaJson: string | null;
  metadataJson: string | null;
}
```

**Step 2: Add `metadata_json` to the SELECT in `pollNextCommand`**

```typescript
const row = await db
  .prepare(
    `SELECT command_id, session_id, command, chat_id, command_type, directory, media_json, metadata_json
     FROM commands
     WHERE machine_id = ?
       AND (
         status = 'pending'
         OR (status = 'leased' AND leased_at < ?)
       )
     ORDER BY created_at ASC
     LIMIT 1`,
  )
  .bind(machineId, leaseExpiry)
  .first<{
    command_id: string;
    session_id: string | null;
    command: string;
    chat_id: string;
    command_type: string;
    directory: string | null;
    media_json: string | null;
    metadata_json: string | null;
  }>();
```

And update the return:

```typescript
return {
  commandId: row.command_id,
  sessionId: row.session_id,
  command: row.command,
  chatId: row.chat_id,
  commandType: row.command_type,
  directory: row.directory,
  mediaJson: row.media_json,
  metadataJson: row.metadata_json,
};
```

**Step 3: Include metadata in poll response**

In `packages/worker/src/poll.ts`, in the execute branch (~line 51-62):

```typescript
  } else {
    // "execute" -- regular command
    body.sessionId = result.sessionId;
    body.command = result.command;
    if (result.mediaJson) {
      try {
        body.media = JSON.parse(result.mediaJson);
      } catch {
        // Ignore malformed media JSON
      }
    }
    if (result.metadataJson) {
      try {
        body.metadata = JSON.parse(result.metadataJson);
      } catch {
        // Ignore malformed metadata JSON
      }
    }
  }
```

**Step 4: Run typecheck and tests**

Run: `npm run typecheck && npm run --workspace @pigeon/worker test -- --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/worker/src/d1-ops.ts packages/worker/src/poll.ts
git commit -m "feat(worker): include metadata in poll response for execute commands"
```

---

### Task 5: Add `metadata` to daemon's `ExecuteMessage` and update `command-ingest`

**Files:**
- Modify: `packages/daemon/src/worker/poller.ts:17-24` (ExecuteMessage)
- Modify: `packages/daemon/src/worker/command-ingest.ts:98-236` (question routing)
- Test: `packages/daemon/test/command-ingest.test.ts`

**Step 1: Write failing tests**

Add to `packages/daemon/test/command-ingest.test.ts`:

```typescript
it("routes text as question reply using metadata fallback when no pending question in storage", async () => {
  const now = Date.now();
  const storage = openStorageDb(":memory:");
  storage.sessions.upsert({
    sessionId: "sess-meta-1",
    notify: true,
    backendKind: "opencode-plugin-direct",
    backendProtocolVersion: 1,
    backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
    backendAuthToken: "tok",
  }, now);

  // NOTE: No pending question stored — simulates the bug scenario

  let capturedReply: QuestionReplyInput | null = null;

  await ingestWorkerCommand(
    storage,
    makeMsg({
      commandId: "cmd-meta-1",
      sessionId: "sess-meta-1",
      command: "Use PostgreSQL",
      chatId: "1",
      metadata: { questionRequestId: "req-meta-abc" },
    }),
    {
      createAdapter: () => ({
        name: "mock-direct",
        async deliverCommand() { return { ok: true }; },
        async deliverQuestionReply(_session: unknown, reply: QuestionReplyInput) {
          capturedReply = reply;
          return { ok: true as const };
        },
      }),
    },
  );

  expect(capturedReply).toEqual({
    questionRequestId: "req-meta-abc",
    answers: [["Use PostgreSQL"]],
  });

  const unfinished = storage.inbox.listUnfinished();
  expect(unfinished).toHaveLength(0);
  storage.db.close();
});

it("prefers pending question over metadata fallback (happy path unchanged)", async () => {
  const now = Date.now();
  const storage = openStorageDb(":memory:");
  storage.sessions.upsert({
    sessionId: "sess-meta-2",
    notify: true,
    backendKind: "opencode-plugin-direct",
    backendProtocolVersion: 1,
    backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
    backendAuthToken: "tok",
  }, now);

  // Pending question IS stored
  storage.pendingQuestions.store({
    sessionId: "sess-meta-2",
    requestId: "req-pending",
    questions: [{
      question: "Which DB?",
      header: "DB",
      options: [{ label: "PostgreSQL", description: "" }],
    }],
  }, now);

  let capturedReply: QuestionReplyInput | null = null;

  await ingestWorkerCommand(
    storage,
    makeMsg({
      commandId: "cmd-meta-2",
      sessionId: "sess-meta-2",
      command: "Use MongoDB",
      chatId: "1",
      // metadata points to different requestId — should be ignored
      metadata: { questionRequestId: "req-stale" },
    }),
    {
      createAdapter: () => ({
        name: "mock-direct",
        async deliverCommand() { return { ok: true }; },
        async deliverQuestionReply(_session: unknown, reply: QuestionReplyInput) {
          capturedReply = reply;
          return { ok: true as const };
        },
      }),
    },
  );

  // Should use the pending question's requestId, not metadata's
  expect(capturedReply).toEqual({
    questionRequestId: "req-pending",
    answers: [["Use MongoDB"]],
  });

  storage.db.close();
});

it("delivers as regular command when no pending question and no metadata", async () => {
  const now = Date.now();
  const storage = openStorageDb(":memory:");
  storage.sessions.upsert({
    sessionId: "sess-meta-3",
    notify: true,
    backendKind: "opencode-plugin-direct",
    backendProtocolVersion: 1,
    backendEndpoint: "http://127.0.0.1:7777/pigeon/direct/execute",
    backendAuthToken: "tok",
  }, now);

  let deliveredCommand = false;
  let deliveredQuestion = false;

  await ingestWorkerCommand(
    storage,
    makeMsg({
      commandId: "cmd-meta-3",
      sessionId: "sess-meta-3",
      command: "just a regular command",
      chatId: "1",
      // No metadata
    }),
    {
      createAdapter: () => ({
        name: "mock-direct",
        async deliverCommand() {
          deliveredCommand = true;
          return { ok: true };
        },
        async deliverQuestionReply() {
          deliveredQuestion = true;
          return { ok: true as const };
        },
      }),
    },
  );

  expect(deliveredCommand).toBe(true);
  expect(deliveredQuestion).toBe(false);
  storage.db.close();
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run --workspace @pigeon/daemon test -- --reporter=verbose -t "metadata"`
Expected: FAIL — `metadata` not on `ExecuteMessage`, fallback logic missing

**Step 3: Add `metadata` to `ExecuteMessage`**

In `packages/daemon/src/worker/poller.ts`, update the `ExecuteMessage` interface:

```typescript
export interface ExecuteMessage {
  commandId: string;
  commandType: "execute";
  sessionId: string;
  command: string;
  chatId: string;
  media?: { key: string; mime: string; filename: string; size: number };
  metadata?: { questionRequestId?: string };
}
```

**Step 4: Add metadata fallback to `command-ingest`**

In `packages/daemon/src/worker/command-ingest.ts`, after the existing pending-question block (after ~line 236, before the stale option check), add the metadata fallback:

```typescript
  // Metadata fallback: if no pending question found locally but command has
  // question metadata from the worker, route as a question reply anyway.
  // This handles the case where the daemon's pending_questions state is stale
  // (e.g., daemon restarted, TTL expired, race with question-answered event).
  if (msg.metadata?.questionRequestId) {
    console.warn(`[command-ingest] question-reply via metadata fallback sessionId=${msg.sessionId} commandId=${commandId} requestId=${msg.metadata.questionRequestId}`);

    const adapter = options.createAdapter
      ? options.createAdapter(session)
      : selectAdapter(session);

    if (!adapter || !adapter.deliverQuestionReply) {
      console.warn(`[command-ingest] metadata fallback: adapter does not support question replies commandId=${commandId}`);
      storage.inbox.markDone(commandId);
      return;
    }

    const answers: string[][] = [[msg.command.trim()]];
    const result = await adapter.deliverQuestionReply(
      session,
      { questionRequestId: msg.metadata.questionRequestId, answers },
      { commandId, chatId: msg.chatId },
    );

    if (result.ok) {
      console.log(`[command-ingest] metadata fallback question reply delivered commandId=${commandId}`);
      storage.inbox.markDone(commandId);
      // Clean up any stale pending question just in case
      storage.pendingQuestions.delete(msg.sessionId);
      return;
    }

    // If question reply fails (e.g., 404 question not found), fall through to
    // regular command delivery so the user's text isn't lost.
    console.warn(`[command-ingest] metadata fallback question reply failed commandId=${commandId} error=${result.error}, falling through to regular delivery`);
  }
```

This block goes BETWEEN the end of the `if (pendingQuestion)` block and the stale-option check. Specifically, after line 236 (end of `return;` for question reply fail) and before line 238 (`// If command looks like a question option but no pending question, it's stale`).

**Step 5: Run tests**

Run: `npm run --workspace @pigeon/daemon test -- --reporter=verbose`
Expected: PASS (all existing tests + 3 new tests)

**Step 6: Run full test suite**

Run: `npm run test`
Expected: PASS

**Step 7: Commit**

```bash
git add packages/daemon/src/worker/poller.ts packages/daemon/src/worker/command-ingest.ts packages/daemon/test/command-ingest.test.ts
git commit -m "feat(daemon): metadata fallback for question swipe-replies when pending question missing"
```

---

### Task 6: Write integration-level worker test for swipe-reply-to-question flow

**Files:**
- Modify: `packages/worker/test/worker.test.ts`

**Step 1: Write test**

Add a test that verifies the full flow: send question notification → swipe-reply → verify command has metadata:

```typescript
describe("swipe-reply to question notification", () => {
  it("tags the command with questionRequestId when replying to a question notification", async () => {
    // 1. Register session + machine
    const sessRes = await SELF.fetch(makeAuthedRequest("POST", "/sessions/register", {
      sessionId: "sess-swipe-q",
      machineId: MACHINE_ID,
      label: "swipe-test",
    }));
    expect(sessRes.status).toBe(200);

    // 2. Send a question notification with notification_id q:sess-swipe-q:req-123
    const notifRes = await SELF.fetch(makeAuthedRequest("POST", "/notifications/send", {
      sessionId: "sess-swipe-q",
      chatId: String(CHAT_ID_NUM),
      text: "Question: Which DB?",
      replyMarkup: {
        inline_keyboard: [[{ text: "PostgreSQL", callback_data: "cmd:tok-swipe:q0" }]],
      },
      notificationId: "q:sess-swipe-q:req-123",
    }));
    expect(notifRes.status).toBe(200);
    const notifBody = await notifRes.json() as { ok: boolean; messageId: number };
    expect(notifBody.ok).toBe(true);

    // 3. Swipe-reply to the notification message
    const webhookRes = await sendWebhook(makeTextReply("Use MongoDB", notifBody.messageId));
    expect(webhookRes.status).toBe(200);

    // 4. Poll for the command and verify metadata
    const pollRes = await SELF.fetch(makeAuthedRequest("GET", `/machines/${MACHINE_ID}/next`));
    expect(pollRes.status).toBe(200);
    const cmd = await pollRes.json() as Record<string, unknown>;
    expect(cmd.commandType).toBe("execute");
    expect(cmd.sessionId).toBe("sess-swipe-q");
    expect(cmd.command).toBe("Use MongoDB");
    expect(cmd.metadata).toEqual({ questionRequestId: "req-123" });
  });

  it("does not tag command with questionRequestId when replying to a non-question notification", async () => {
    // 1. Register session + machine
    const sessRes = await SELF.fetch(makeAuthedRequest("POST", "/sessions/register", {
      sessionId: "sess-swipe-nq",
      machineId: MACHINE_ID,
      label: "nq-test",
    }));
    expect(sessRes.status).toBe(200);

    // 2. Send a regular notification (stop notification, no q: prefix)
    const notifRes = await SELF.fetch(makeAuthedRequest("POST", "/notifications/send", {
      sessionId: "sess-swipe-nq",
      chatId: String(CHAT_ID_NUM),
      text: "Session stopped",
      notificationId: "stop:sess-swipe-nq:xyz",
    }));
    expect(notifRes.status).toBe(200);
    const notifBody = await notifRes.json() as { ok: boolean; messageId: number };

    // 3. Swipe-reply
    const webhookRes = await sendWebhook(makeTextReply("continue please", notifBody.messageId));
    expect(webhookRes.status).toBe(200);

    // 4. Poll and verify NO metadata
    const pollRes = await SELF.fetch(makeAuthedRequest("GET", `/machines/${MACHINE_ID}/next`));
    expect(pollRes.status).toBe(200);
    const cmd = await pollRes.json() as Record<string, unknown>;
    expect(cmd.commandType).toBe("execute");
    expect(cmd.metadata).toBeUndefined();
  });
});
```

**Step 2: Run tests**

Run: `npm run --workspace @pigeon/worker test -- --reporter=verbose -t "swipe-reply to question"`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/worker/test/worker.test.ts
git commit -m "test(worker): integration tests for question swipe-reply metadata flow"
```

---

### Task 7: Update `makeMsg` helper and run full suite

**Files:**
- Modify: `packages/daemon/test/command-ingest.test.ts:8-17` (makeMsg helper)

**Step 1: Update `makeMsg` to support `metadata`**

The `makeMsg` helper in `command-ingest.test.ts` takes `Partial<ExecuteMessage>`, so it should already support `metadata` after the type change in Task 5. Verify this by running:

Run: `npm run test`
Expected: PASS — all tests across all packages

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: fix any remaining type issues"
```

---

### Task 8: Apply D1 migration to production

This must happen BEFORE deploying the new worker code (the new INSERT includes `metadata_json`).

**Step 1: Apply migration**

```bash
npx wrangler d1 execute pigeon-d1 --command "ALTER TABLE commands ADD COLUMN metadata_json TEXT"
```

**Step 2: Verify**

```bash
npx wrangler d1 execute pigeon-d1 --command "PRAGMA table_info(commands)"
```

Expected: `metadata_json` appears in the column list.

**Step 3: Deploy worker**

```bash
npm run --workspace @pigeon/worker deploy
```

**Step 4: Deploy daemon**

Follow the cross-device-deployment skill for daemon + plugin updates.
