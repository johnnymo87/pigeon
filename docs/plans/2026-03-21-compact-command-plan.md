# Compact Command Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `/compact` slash command to pigeon so users can trigger OpenCode context compaction from Telegram via swipe-reply.

**Architecture:** New `command_type: "compact"` flows through the existing worker → D1 → daemon pipeline. The worker parses `/compact` from swipe-replies, resolves the session, and queues the command. The daemon polls it, fetches the session's current model from OpenCode's message API, then calls the summarize endpoint. The compaction summary flows back through the plugin's existing notification path.

**Tech Stack:** TypeScript, Cloudflare Workers (worker), Node.js (daemon), vitest

---

### Task 1: Add `"compact"` to the worker's `CommandType` union

**Files:**
- Modify: `packages/worker/src/webhook.ts:5`

**Step 1: Update the type**

At line 5, change:
```typescript
type CommandType = "execute" | "launch" | "kill";
```
to:
```typescript
type CommandType = "execute" | "launch" | "kill" | "compact";
```

**Step 2: Commit**

```bash
git add packages/worker/src/webhook.ts
git commit -m "feat: add compact to CommandType union"
```

---

### Task 2: Parse `/compact` in the worker webhook handler

The `/compact` command is parsed from swipe-replies, similar to how regular messages resolve sessions from reply-to context. Add it between the `/kill` handler (line 534) and the plain-message handler.

**Files:**
- Modify: `packages/worker/src/webhook.ts` (after line 534, before the plain message routing)

**Step 1: Add `/compact` regex and handler**

After the `/kill` handler block (around line 534), add:

```typescript
// /compact — compact a session (swipe-reply only)
const compactMatch = update.message.text?.match(/^\/compact$/);
if (compactMatch) {
  const compactChatId = update.message.chat.id;
  if (!update.message.reply_to_message) {
    await sendTelegramMessage(
      env,
      compactChatId,
      "Reply to a session notification to compact it.",
    );
    return new Response("OK");
  }
  const mapping = await lookupMessage(
    db,
    String(compactChatId),
    update.message.reply_to_message.message_id,
  );
  if (!mapping) {
    await sendTelegramMessage(
      env,
      compactChatId,
      "Could not find a session for that message.",
    );
    return new Response("OK");
  }
  const session = await d1GetSession(db, mapping.session_id);
  if (!session) {
    await sendTelegramMessage(
      env,
      compactChatId,
      `Session \`${mapping.session_id}\` not found.`,
    );
    return new Response("OK");
  }
  const machineOnline = await isMachineRecent(db, session.machine_id);
  if (!machineOnline) {
    await sendTelegramMessage(
      env,
      compactChatId,
      `Machine \`${session.machine_id}\` is not reachable.`,
    );
    return new Response("OK");
  }
  const commandId = await queueCommand(
    db,
    env,
    session.machine_id,
    mapping.session_id,
    "",
    String(compactChatId),
    session.label,
    "compact",
  );
  if (commandId) {
    await sendTelegramMessage(
      env,
      compactChatId,
      `Compacting session \`${mapping.session_id}\` on ${session.machine_id}...`,
    );
  }
  return new Response("OK");
}
```

Note: `lookupMessage`, `d1GetSession`, `isMachineRecent`, `queueCommand`, and `sendTelegramMessage` are all existing functions in the webhook module. Check imports — `d1GetSession` may need to be imported from `d1-ops.ts` if not already (verify by checking the file's imports section).

**Step 2: Commit**

```bash
git add packages/worker/src/webhook.ts
git commit -m "feat: parse /compact slash command in worker webhook"
```

---

### Task 3: Shape the compact poll response in the worker

**Files:**
- Modify: `packages/worker/src/poll.ts:39-40` (the `kill` branch of the if/else chain)

**Step 1: Add compact branch**

At lines 39-40, the current code is:
```typescript
} else if (result.commandType === "kill") {
  body.sessionId = result.sessionId;
```

Change to:
```typescript
} else if (result.commandType === "kill") {
  body.sessionId = result.sessionId;
} else if (result.commandType === "compact") {
  body.sessionId = result.sessionId;
```

The `compact` response shape is identical to `kill` — just `sessionId`, no `command` or `directory`.

**Step 2: Commit**

```bash
git add packages/worker/src/poll.ts
git commit -m "feat: shape compact command in poll response"
```

---

### Task 4: Add `CompactMessage` type and `onCompact` callback to the daemon poller

**Files:**
- Modify: `packages/daemon/src/worker/poller.ts:34-47` (message types and callbacks)
- Modify: `packages/daemon/src/worker/poller.ts:135-144` (dispatch logic)

**Step 1: Add the CompactMessage type**

After `KillMessage` (around line 39), add:

```typescript
export interface CompactMessage {
  commandId: string;
  commandType: "compact";
  sessionId: string;
  chatId: string;
}
```

Update the union type at line 41:
```typescript
export type WorkerMessage = ExecuteMessage | LaunchMessage | KillMessage | CompactMessage;
```

**Step 2: Add `onCompact` to `PollerCallbacks`**

At lines 43-47, change:
```typescript
export interface PollerCallbacks {
  onCommand: (msg: ExecuteMessage) => Promise<void>;
  onLaunch: (msg: LaunchMessage) => Promise<void>;
  onKill: (msg: KillMessage) => Promise<void>;
}
```
to:
```typescript
export interface PollerCallbacks {
  onCommand: (msg: ExecuteMessage) => Promise<void>;
  onLaunch: (msg: LaunchMessage) => Promise<void>;
  onKill: (msg: KillMessage) => Promise<void>;
  onCompact: (msg: CompactMessage) => Promise<void>;
}
```

**Step 3: Add dispatch branch**

In the dispatch logic (around lines 141-144), after the `kill` branch:
```typescript
} else if (msg.commandType === "kill") {
  await this.callbacks.onKill(msg);
}
```
add:
```typescript
} else if (msg.commandType === "compact") {
  await this.callbacks.onCompact(msg);
}
```

Keep the `else` branch (unknown commandType warning) after the new compact branch.

**Step 4: Commit**

```bash
git add packages/daemon/src/worker/poller.ts
git commit -m "feat: add CompactMessage type and onCompact callback to poller"
```

---

### Task 5: Add `getSessionMessages` and `summarize` methods to `OpencodeClient`

**Files:**
- Modify: `packages/daemon/src/opencode-client.ts` (after `deleteSession`, around line 62)

**Step 1: Write tests for the new methods**

Check if there is an existing test file for `opencode-client.ts`. If not, create `packages/daemon/test/opencode-client.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { OpencodeClient } from "../src/opencode-client.js";

describe("OpencodeClient", () => {
  describe("getSessionMessages", () => {
    it("fetches messages for a session", async () => {
      const mockMessages = [
        { id: "msg-1", role: "user", model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" } },
        { id: "msg-2", role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
      ];
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockMessages,
      });
      const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: mockFetch });

      const result = await client.getSessionMessages("sess-1");

      expect(mockFetch).toHaveBeenCalledWith("http://localhost:4096/session/sess-1/message", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
      expect(result).toEqual(mockMessages);
    });

    it("throws on non-ok response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "not found",
      });
      const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: mockFetch });

      await expect(client.getSessionMessages("sess-bad")).rejects.toThrow();
    });
  });

  describe("summarize", () => {
    it("calls the summarize endpoint with model params", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: mockFetch });

      await client.summarize("sess-1", "anthropic", "claude-sonnet-4-20250514");

      expect(mockFetch).toHaveBeenCalledWith("http://localhost:4096/session/sess-1/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerID: "anthropic", modelID: "claude-sonnet-4-20250514", auto: false }),
      });
    });

    it("throws on non-ok response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "internal error",
      });
      const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: mockFetch });

      await expect(client.summarize("sess-1", "anthropic", "claude-sonnet-4-20250514")).rejects.toThrow();
    });
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd packages/daemon && npx vitest run test/opencode-client.test.ts
```
Expected: FAIL (methods don't exist yet)

**Step 3: Implement the methods**

Add to `packages/daemon/src/opencode-client.ts` after `deleteSession`:

```typescript
  async getSessionMessages(sessionId: string): Promise<unknown[]> {
    const res = await this.fetch(`${this.baseUrl}/session/${sessionId}/message`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`getSessionMessages failed (${res.status}): ${body}`);
    }
    return res.json();
  }

  async summarize(
    sessionId: string,
    providerID: string,
    modelID: string,
  ): Promise<void> {
    const res = await this.fetch(`${this.baseUrl}/session/${sessionId}/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerID, modelID, auto: false }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`summarize failed (${res.status}): ${body}`);
    }
  }
```

Note: Check how existing methods reference `this.fetch` vs `this.fetchFn` — use the same pattern. The constructor stores it as a private field; verify the field name.

**Step 4: Run tests to verify they pass**

```bash
cd packages/daemon && npx vitest run test/opencode-client.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/daemon/src/opencode-client.ts packages/daemon/test/opencode-client.test.ts
git commit -m "feat: add getSessionMessages and summarize to OpencodeClient"
```

---

### Task 6: Create `compact-ingest.ts` in the daemon

**Files:**
- Create: `packages/daemon/src/worker/compact-ingest.ts`
- Create: `packages/daemon/test/compact-ingest.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { ingestCompactCommand } from "../src/worker/compact-ingest.js";

describe("ingestCompactCommand", () => {
  const makeInput = (overrides = {}) => ({
    commandId: "cmd-1",
    sessionId: "sess-1",
    chatId: "42",
    machineId: "devbox",
    opencodeClient: {
      getSessionMessages: vi.fn(),
      summarize: vi.fn(),
    },
    sendTelegramReply: vi.fn(),
    ...overrides,
  });

  it("fetches messages, extracts model, and calls summarize", async () => {
    const input = makeInput();
    input.opencodeClient.getSessionMessages.mockResolvedValue([
      { id: "msg-1", role: "user", model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" } },
      { id: "msg-2", role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
      { id: "msg-3", role: "user", model: { providerID: "openai", modelID: "gpt-4o" } },
    ]);
    input.opencodeClient.summarize.mockResolvedValue(undefined);

    await ingestCompactCommand(input);

    expect(input.opencodeClient.getSessionMessages).toHaveBeenCalledWith("sess-1");
    expect(input.opencodeClient.summarize).toHaveBeenCalledWith("sess-1", "openai", "gpt-4o");
  });

  it("sends error to Telegram when no user messages found", async () => {
    const input = makeInput();
    input.opencodeClient.getSessionMessages.mockResolvedValue([
      { id: "msg-1", role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
    ]);

    await ingestCompactCommand(input);

    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("No user messages"),
    );
    expect(input.opencodeClient.summarize).not.toHaveBeenCalled();
  });

  it("sends error to Telegram when summarize fails", async () => {
    const input = makeInput();
    input.opencodeClient.getSessionMessages.mockResolvedValue([
      { id: "msg-1", role: "user", model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" } },
    ]);
    input.opencodeClient.summarize.mockRejectedValue(new Error("summarize failed (500): internal"));

    await ingestCompactCommand(input);

    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("Failed to compact"),
    );
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd packages/daemon && npx vitest run test/compact-ingest.test.ts
```
Expected: FAIL (module doesn't exist)

**Step 3: Implement `compact-ingest.ts`**

Create `packages/daemon/src/worker/compact-ingest.ts`:

```typescript
import type { OpencodeClient } from "../opencode-client.js";

export interface CompactCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "getSessionMessages" | "summarize">;
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
}

export async function ingestCompactCommand(
  input: CompactCommandInput,
): Promise<void> {
  const { sessionId, chatId, machineId, opencodeClient, sendTelegramReply } =
    input;
  const machineLabel = machineId ? ` on ${machineId}` : "";

  try {
    const messages = await opencodeClient.getSessionMessages(sessionId);

    // Find the last user message to extract the current model
    const lastUserMessage = [...messages]
      .reverse()
      .find(
        (m: any) =>
          m.role === "user" && m.model?.providerID && m.model?.modelID,
      ) as any;

    if (!lastUserMessage) {
      await sendTelegramReply(
        chatId,
        `No user messages found in session \`${sessionId}\`. Cannot determine model for compaction.`,
      );
      return;
    }

    const { providerID, modelID } = lastUserMessage.model;
    await opencodeClient.summarize(sessionId, providerID, modelID);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(
      chatId,
      `Failed to compact session${machineLabel}: ${message}`,
    );
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
cd packages/daemon && npx vitest run test/compact-ingest.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/daemon/src/worker/compact-ingest.ts packages/daemon/test/compact-ingest.test.ts
git commit -m "feat: add compact-ingest handler for daemon"
```

---

### Task 7: Wire `onCompact` in the daemon entry point

**Files:**
- Modify: `packages/daemon/src/index.ts:73-86` (after the `onKill` callback)

**Step 1: Add the import**

At the top of `packages/daemon/src/index.ts`, add:
```typescript
import { ingestCompactCommand } from "./worker/compact-ingest.js";
```

**Step 2: Add the `onCompact` callback**

After the `onKill` callback (around line 86), add:

```typescript
      onCompact: async (msg) => {
        if (!opencodeClient) {
          log.warn("onCompact: no opencodeClient configured, skipping");
          return;
        }
        await ingestCompactCommand({
          commandId: msg.commandId,
          sessionId: msg.sessionId,
          chatId: msg.chatId,
          machineId: config.machineId,
          opencodeClient,
          sendTelegramReply: sendTelegramMessage,
        });
      },
```

Follow the same pattern as `onKill` — guard on `opencodeClient` existence, pass the same `sendTelegramReply: sendTelegramMessage` helper.

**Step 3: Commit**

```bash
git add packages/daemon/src/index.ts
git commit -m "feat: wire onCompact callback in daemon entry point"
```

---

### Task 8: End-to-end verification

**Step 1: Type-check both packages**

```bash
cd packages/worker && npx tsc --noEmit
cd packages/daemon && npx tsc --noEmit
```
Expected: No type errors

**Step 2: Run all daemon tests**

```bash
cd packages/daemon && npx vitest run
```
Expected: All tests pass, including the new ones from tasks 5 and 6.

**Step 3: Run all worker tests (if any)**

```bash
cd packages/worker && npx vitest run
```
Expected: All tests pass.

**Step 4: Deploy and test manually**

1. Deploy the worker: `cd packages/worker && npx wrangler deploy`
2. Restart the daemon on the target machine
3. From Telegram, swipe-reply on a session notification and send `/compact`
4. Verify: immediate ack message, then compaction summary notification

**Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "feat: complete /compact slash command implementation"
```
