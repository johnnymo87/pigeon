# MCP/Model Swipe-Reply Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow `/mcp` and `/model` commands to resolve the session ID from a swipe-reply instead of requiring it as an explicit argument.

**Architecture:** Extract a shared `resolveSessionFromReply` helper in `webhook.ts`. Relax each command's regex to make the session ID optional. When missing, resolve from `reply_to_message` via `lookupMessage()`. Existing explicit forms continue to work.

**Tech Stack:** Cloudflare Worker, D1, Vitest with `cloudflare:test`

---

### Task 1: Extract `resolveSessionFromReply` helper

The session lookup + machine liveness check pattern is repeated across `/compact`, `/mcp`, and `/model` handlers. Extract it into a shared helper first.

**Files:**
- Modify: `packages/worker/src/webhook.ts`

**Step 1: Write the helper function**

Add this helper near the top of `webhook.ts` (after the existing helper functions, before the main handler):

```typescript
/**
 * Resolve a session from a reply_to_message. Returns session info or sends
 * an error reply and returns null.
 */
async function resolveSessionFromReply(
  db: D1Database,
  env: Env,
  chatId: number,
  replyToMessage: { message_id: number } | undefined,
  usageHint: string,
): Promise<{ sessionId: string; machineId: string; label: string | null } | null> {
  if (!replyToMessage) {
    await sendTelegramMessage(env, chatId, usageHint);
    return null;
  }

  const mapping = await lookupMessage(db, String(chatId), replyToMessage.message_id);
  if (!mapping) {
    await sendTelegramMessage(env, chatId, "Could not find a session for that message.");
    return null;
  }

  const session = await db
    .prepare("SELECT machine_id, label FROM sessions WHERE session_id = ?")
    .bind(mapping.session_id)
    .first<{ machine_id: string; label: string | null }>();

  if (!session) {
    await sendTelegramMessage(env, chatId, `Session \`${mapping.session_id}\` not found.`);
    return null;
  }

  const isRecent = await isMachineRecent(db, session.machine_id);
  if (!isRecent) {
    await sendTelegramMessage(env, chatId, `${session.machine_id} is not recently seen.`);
    return null;
  }

  return { sessionId: mapping.session_id, machineId: session.machine_id, label: session.label };
}
```

Export it for testing:

```typescript
export { resolveSessionFromReply };
```

**Step 2: Refactor `/compact` to use the helper**

Replace the `/compact` handler body (lines ~555-590) with:

```typescript
if (/^\/compact$/.test(update.message.text)) {
  const compactChatId = update.message.chat.id;
  const resolved = await resolveSessionFromReply(
    db, env, compactChatId, update.message.reply_to_message,
    "Reply to a session notification to compact it.",
  );
  if (!resolved) return OK();

  const commandId = await queueCommand(db, env, resolved.machineId, resolved.sessionId, "", String(compactChatId), resolved.label, "compact");
  if (!commandId) return OK();

  await sendTelegramMessage(env, compactChatId, `Compacting session \`${resolved.sessionId}\` on ${resolved.machineId}...`);
  return OK();
}
```

**Step 3: Run tests to verify no regressions**

Run: `npm test --workspace @pigeon/worker -- --run`
Expected: All existing `/compact` tests pass unchanged.

**Step 4: Commit**

```bash
git add packages/worker/src/webhook.ts
git commit -m "refactor(worker): extract resolveSessionFromReply helper and use in /compact"
```

---

### Task 2: Add swipe-reply support to `/mcp list`

**Files:**
- Modify: `packages/worker/src/webhook.ts`
- Modify: `packages/worker/test/worker.test.ts`

**Step 1: Write failing tests**

Add a swipe-reply test helper and tests in the `/mcp command` describe block:

```typescript
function makeMcpListReply(replyToMessageId: number, updateId?: number): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: "/mcp list",
      reply_to_message: { message_id: replyToMessageId },
    },
  };
}
```

Add these tests:

```typescript
it("/mcp list via swipe-reply queues mcp_list command", async () => {
  const now = Date.now();
  const sessionId = `mcp-list-reply-${now}`;
  const machineId = `mcp-list-reply-machine-${now}`;
  const notifMsgId = 6_000_001 + (now % 100);

  await registerSession(sessionId, machineId);
  await insertMessageMapping({
    chatId: String(CHAT_ID_NUM),
    messageId: notifMsgId,
    sessionId,
    token: `mcp-list-reply-token-${now}`,
  });
  await touchMachine(env.DB, machineId, now);

  mockTelegramSendMessage();

  const res = await sendWebhook(makeMcpListReply(notifMsgId));

  expect(res.status).toBe(200);
  const rows = await queryQueueBySession(sessionId);
  const mcpRows = rows.filter((r) => r.command_type === "mcp_list");
  expect(mcpRows.length).toBeGreaterThanOrEqual(1);
});

it("/mcp list without reply or session ID shows usage hint", async () => {
  mockTelegramSendMessage();

  const msg = {
    update_id: ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: "/mcp list",
    },
  };
  const res = await sendWebhook(msg);
  expect(res.status).toBe(200);
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test --workspace @pigeon/worker -- --run`
Expected: New tests fail (regex doesn't match `/mcp list` without session ID).

**Step 3: Update the `/mcp list` handler**

Replace the `/mcp list` handler with:

```typescript
// Handle /mcp list [SESSION_ID] — explicit or swipe-reply
const mcpListMatch = update.message.text.match(/^\/mcp\s+list(?:\s+(\S+))?$/);
if (mcpListMatch) {
  const mcpChatId = update.message.chat.id;
  let sessionId = mcpListMatch[1];

  if (!sessionId) {
    const resolved = await resolveSessionFromReply(
      db, env, mcpChatId, update.message.reply_to_message,
      "Reply to a session notification, or: `/mcp list <session-id>`",
    );
    if (!resolved) return OK();
    sessionId = resolved.sessionId;

    const commandId = await queueCommand(db, env, resolved.machineId, sessionId, "", String(mcpChatId), resolved.label, "mcp_list");
    if (!commandId) return OK();

    await sendTelegramMessage(env, mcpChatId, `Listing MCP servers for session \`${sessionId}\` on ${resolved.machineId}...`);
    return OK();
  }

  // Explicit session ID path (existing)
  const session = await db
    .prepare("SELECT machine_id, label FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<{ machine_id: string; label: string | null }>();

  if (!session) {
    await sendTelegramMessage(env, mcpChatId, `Session \`${sessionId}\` not found.`);
    return OK();
  }

  const isRecent = await isMachineRecent(db, session.machine_id);
  if (!isRecent) {
    await sendTelegramMessage(env, mcpChatId, `${session.machine_id} is not recently seen.`);
    return OK();
  }

  const commandId = await queueCommand(db, env, session.machine_id, sessionId, "", String(mcpChatId), session.label, "mcp_list");
  if (!commandId) return OK();

  await sendTelegramMessage(env, mcpChatId, `Listing MCP servers for session \`${sessionId}\` on ${session.machine_id}...`);
  return OK();
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test --workspace @pigeon/worker -- --run`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add packages/worker/src/webhook.ts packages/worker/test/worker.test.ts
git commit -m "feat(worker): add swipe-reply support to /mcp list"
```

---

### Task 3: Add swipe-reply support to `/mcp enable` and `/mcp disable`

**Files:**
- Modify: `packages/worker/src/webhook.ts`
- Modify: `packages/worker/test/worker.test.ts`

**Step 1: Write failing tests**

Add helpers and tests:

```typescript
function makeMcpEnableReply(serverName: string, replyToMessageId: number, updateId?: number): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: `/mcp enable ${serverName}`,
      reply_to_message: { message_id: replyToMessageId },
    },
  };
}

function makeMcpDisableReply(serverName: string, replyToMessageId: number, updateId?: number): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: `/mcp disable ${serverName}`,
      reply_to_message: { message_id: replyToMessageId },
    },
  };
}
```

Tests:

```typescript
it("/mcp enable via swipe-reply queues mcp_enable command", async () => {
  const now = Date.now();
  const sessionId = `mcp-en-reply-${now}`;
  const machineId = `mcp-en-reply-machine-${now}`;
  const notifMsgId = 6_100_001 + (now % 100);

  await registerSession(sessionId, machineId);
  await insertMessageMapping({
    chatId: String(CHAT_ID_NUM),
    messageId: notifMsgId,
    sessionId,
    token: `mcp-en-reply-token-${now}`,
  });
  await touchMachine(env.DB, machineId, now);
  mockTelegramSendMessage();

  const res = await sendWebhook(makeMcpEnableReply("tec", notifMsgId));

  expect(res.status).toBe(200);
  const rows = await queryQueueBySession(sessionId);
  const mcpRows = rows.filter((r) => r.command_type === "mcp_enable");
  expect(mcpRows.length).toBeGreaterThanOrEqual(1);
  expect(mcpRows[mcpRows.length - 1]!.command).toBe("tec");
});

it("/mcp disable via swipe-reply queues mcp_disable command", async () => {
  const now = Date.now();
  const sessionId = `mcp-dis-reply-${now}`;
  const machineId = `mcp-dis-reply-machine-${now}`;
  const notifMsgId = 6_200_001 + (now % 100);

  await registerSession(sessionId, machineId);
  await insertMessageMapping({
    chatId: String(CHAT_ID_NUM),
    messageId: notifMsgId,
    sessionId,
    token: `mcp-dis-reply-token-${now}`,
  });
  await touchMachine(env.DB, machineId, now);
  mockTelegramSendMessage();

  const res = await sendWebhook(makeMcpDisableReply("tec", notifMsgId));

  expect(res.status).toBe(200);
  const rows = await queryQueueBySession(sessionId);
  const mcpRows = rows.filter((r) => r.command_type === "mcp_disable");
  expect(mcpRows.length).toBeGreaterThanOrEqual(1);
  expect(mcpRows[mcpRows.length - 1]!.command).toBe("tec");
});

it("/mcp enable without reply or session ID shows usage hint", async () => {
  mockTelegramSendMessage();

  const msg = {
    update_id: ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: "/mcp enable tec",
    },
  };
  const res = await sendWebhook(msg);
  expect(res.status).toBe(200);
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test --workspace @pigeon/worker -- --run`
Expected: New tests fail.

**Step 3: Update the `/mcp enable` and `/mcp disable` handlers**

For enable, change the regex from `^\/mcp\s+enable\s+(\S+)\s+(\S+)$` to `^\/mcp\s+enable\s+(\S+)(?:\s+(\S+))?$` and add swipe-reply resolution when group 2 is missing.

For disable, same pattern: `^\/mcp\s+disable\s+(\S+)(?:\s+(\S+))?$`.

Enable handler:

```typescript
const mcpEnableMatch = update.message.text.match(/^\/mcp\s+enable\s+(\S+)(?:\s+(\S+))?$/);
if (mcpEnableMatch) {
  const serverName = mcpEnableMatch[1]!;
  let sessionId = mcpEnableMatch[2];
  const mcpChatId = update.message.chat.id;

  if (!sessionId) {
    const resolved = await resolveSessionFromReply(
      db, env, mcpChatId, update.message.reply_to_message,
      "Reply to a session notification, or: `/mcp enable <server> <session-id>`",
    );
    if (!resolved) return OK();
    sessionId = resolved.sessionId;

    const commandId = await queueCommand(db, env, resolved.machineId, sessionId, serverName, String(mcpChatId), resolved.label, "mcp_enable");
    if (!commandId) return OK();

    await sendTelegramMessage(env, mcpChatId, `Enabling MCP server \`${serverName}\` for session \`${sessionId}\` on ${resolved.machineId}...`);
    return OK();
  }

  // Explicit session ID path (existing)
  const session = await db
    .prepare("SELECT machine_id, label FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<{ machine_id: string; label: string | null }>();

  if (!session) {
    await sendTelegramMessage(env, mcpChatId, `Session \`${sessionId}\` not found.`);
    return OK();
  }

  const isRecent = await isMachineRecent(db, session.machine_id);
  if (!isRecent) {
    await sendTelegramMessage(env, mcpChatId, `${session.machine_id} is not recently seen.`);
    return OK();
  }

  const commandId = await queueCommand(db, env, session.machine_id, sessionId, serverName, String(mcpChatId), session.label, "mcp_enable");
  if (!commandId) return OK();

  await sendTelegramMessage(env, mcpChatId, `Enabling MCP server \`${serverName}\` for session \`${sessionId}\` on ${session.machine_id}...`);
  return OK();
}
```

Disable handler follows the same pattern.

**Step 4: Run tests to verify they pass**

Run: `npm test --workspace @pigeon/worker -- --run`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add packages/worker/src/webhook.ts packages/worker/test/worker.test.ts
git commit -m "feat(worker): add swipe-reply support to /mcp enable and /mcp disable"
```

---

### Task 4: Add swipe-reply support to `/model`

**Files:**
- Modify: `packages/worker/src/webhook.ts`
- Modify: `packages/worker/test/worker.test.ts`

**Step 1: Write failing tests**

```typescript
function makeModelReply(text: string, replyToMessageId: number, updateId?: number): Record<string, unknown> {
  return {
    update_id: updateId ?? ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text,
      reply_to_message: { message_id: replyToMessageId },
    },
  };
}
```

Tests:

```typescript
it("/model via swipe-reply (no args) queues model_list command", async () => {
  const now = Date.now();
  const sessionId = `model-list-reply-${now}`;
  const machineId = `model-list-reply-machine-${now}`;
  const notifMsgId = 6_300_001 + (now % 100);

  await registerSession(sessionId, machineId);
  await insertMessageMapping({
    chatId: String(CHAT_ID_NUM),
    messageId: notifMsgId,
    sessionId,
    token: `model-list-reply-token-${now}`,
  });
  await touchMachine(env.DB, machineId, now);
  mockTelegramSendMessage();

  const res = await sendWebhook(makeModelReply("/model", notifMsgId));

  expect(res.status).toBe(200);
  const rows = await queryQueueBySession(sessionId);
  const modelRows = rows.filter((r) => r.command_type === "model_list");
  expect(modelRows.length).toBeGreaterThanOrEqual(1);
});

it("/model <provider/model> via swipe-reply queues model_set command", async () => {
  const now = Date.now();
  const sessionId = `model-set-reply-${now}`;
  const machineId = `model-set-reply-machine-${now}`;
  const notifMsgId = 6_400_001 + (now % 100);

  await registerSession(sessionId, machineId);
  await insertMessageMapping({
    chatId: String(CHAT_ID_NUM),
    messageId: notifMsgId,
    sessionId,
    token: `model-set-reply-token-${now}`,
  });
  await touchMachine(env.DB, machineId, now);
  mockTelegramSendMessage();

  const res = await sendWebhook(makeModelReply("/model anthropic/claude-sonnet-4-20250514", notifMsgId));

  expect(res.status).toBe(200);
  const rows = await queryQueueBySession(sessionId);
  const modelRows = rows.filter((r) => r.command_type === "model_set");
  expect(modelRows.length).toBeGreaterThanOrEqual(1);
  expect(modelRows[modelRows.length - 1]!.command).toBe("anthropic/claude-sonnet-4-20250514");
});

it("/model without reply or session ID shows usage hint", async () => {
  mockTelegramSendMessage();

  const msg = {
    update_id: ++webhookUpdateCounter,
    message: {
      message_id: ++webhookUpdateCounter,
      chat: { id: CHAT_ID_NUM },
      from: { id: CHAT_ID_NUM },
      text: "/model",
    },
  };
  const res = await sendWebhook(msg);
  expect(res.status).toBe(200);
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test --workspace @pigeon/worker -- --run`
Expected: New tests fail.

**Step 3: Update the `/model` handler**

The `/model` regex needs to handle three forms:
- `/model` (bare, swipe-reply) -> list models
- `/model <provider/model>` (with `/` in arg, swipe-reply) -> set model
- `/model <session-id>` (no `/` in arg, no reply) -> list models (existing)
- `/model <provider/model> <session-id>` (two args) -> set model (existing)

Replace with:

```typescript
// Handle /model — bare (swipe-reply), one arg, or two args
const modelMatch = update.message.text.match(/^\/model(?:\s+(\S+))?(?:\s+(\S+))?$/);
if (modelMatch) {
  const firstArg = modelMatch[1];
  const secondArg = modelMatch[2];
  const modelChatId = update.message.chat.id;

  let sessionId: string | undefined;
  let commandType: CommandType;
  let modelCode: string | undefined;

  if (firstArg && firstArg.includes("/") && secondArg) {
    // /model <PROVIDER/MODEL> <SESSION_ID> → model_set (existing)
    modelCode = firstArg;
    sessionId = secondArg;
    commandType = "model_set";
  } else if (firstArg && firstArg.includes("/") && !secondArg) {
    // /model <PROVIDER/MODEL> (swipe-reply) → model_set
    modelCode = firstArg;
    commandType = "model_set";
  } else if (firstArg && !firstArg.includes("/")) {
    // /model <SESSION_ID> → model_list (existing)
    sessionId = firstArg;
    commandType = "model_list";
  } else {
    // /model (bare, swipe-reply) → model_list
    commandType = "model_list";
  }

  if (!sessionId) {
    const resolved = await resolveSessionFromReply(
      db, env, modelChatId, update.message.reply_to_message,
      "Reply to a session notification, or: `/model <session-id>`",
    );
    if (!resolved) return OK();
    sessionId = resolved.sessionId;

    const command = modelCode ?? "";
    const commandId = await queueCommand(db, env, resolved.machineId, sessionId, command, String(modelChatId), resolved.label, commandType);
    if (!commandId) return OK();

    if (commandType === "model_set") {
      await sendTelegramMessage(env, modelChatId, `Setting model to \`${modelCode}\` for session \`${sessionId}\` on ${resolved.machineId}...`);
    } else {
      await sendTelegramMessage(env, modelChatId, `Listing models for session \`${sessionId}\` on ${resolved.machineId}...`);
    }
    return OK();
  }

  // Explicit session ID path (existing)
  const session = await db
    .prepare("SELECT machine_id, label FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<{ machine_id: string; label: string | null }>();

  if (!session) {
    await sendTelegramMessage(env, modelChatId, `Session \`${sessionId}\` not found.`);
    return OK();
  }

  const isRecent = await isMachineRecent(db, session.machine_id);
  if (!isRecent) {
    await sendTelegramMessage(env, modelChatId, `${session.machine_id} is not recently seen.`);
    return OK();
  }

  const command = modelCode ?? "";
  const commandId = await queueCommand(db, env, session.machine_id, sessionId, command, String(modelChatId), session.label, commandType);
  if (!commandId) return OK();

  if (commandType === "model_set") {
    await sendTelegramMessage(env, modelChatId, `Setting model to \`${modelCode}\` for session \`${sessionId}\` on ${session.machine_id}...`);
  } else {
    await sendTelegramMessage(env, modelChatId, `Listing models for session \`${sessionId}\` on ${session.machine_id}...`);
  }
  return OK();
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test --workspace @pigeon/worker -- --run`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add packages/worker/src/webhook.ts packages/worker/test/worker.test.ts
git commit -m "feat(worker): add swipe-reply support to /model list and /model set"
```

---

### Task 5: Update AGENTS.md command table

**Files:**
- Modify: `AGENTS.md`

**Step 1: Update the command table**

Update the Commands table to document the new swipe-reply forms:

| Command | Example | What it does |
|---------|---------|--------------|
| `/mcp list <session-id>` | `/mcp list sess-abc123` | Lists MCP servers with connection status |
| `/mcp list` | _(reply to notification)_ | Same, session from reply |
| `/mcp enable <server> <session-id>` | `/mcp enable slack sess-abc123` | Connects (or reconnects) an MCP server |
| `/mcp enable <server>` | _(reply to notification)_ | Same, session from reply |
| `/mcp disable <server> <session-id>` | `/mcp disable slack sess-abc123` | Disconnects an MCP server |
| `/mcp disable <server>` | _(reply to notification)_ | Same, session from reply |
| `/model <session-id>` | `/model sess-abc123` | Lists available models from allowed providers |
| `/model` | _(reply to notification)_ | Same, session from reply |
| `/model <provider/model> <session-id>` | `/model anthropic/claude-sonnet-4-20250514 sess-abc123` | Sets model override for the session |
| `/model <provider/model>` | _(reply to notification)_ | Same, session from reply |

**Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: document swipe-reply support for /mcp and /model commands"
```

---

### Task 6: Deploy worker and verify

**Step 1: Run full test suite**

Run: `npm run test`
Expected: All tests pass across all packages.

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: Clean.

**Step 3: Deploy**

Run: `npm run --workspace @pigeon/worker deploy`

**Step 4: Verify health**

Run: `curl https://ccr-router.jonathan-mohrbacher.workers.dev/health`
Expected: `{"ok":true}`
