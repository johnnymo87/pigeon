# MCP & Model Commands Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `/mcp` and `/model` slash commands to pigeon so users can manage MCP server connections and switch models per-session from Telegram. Also improve session ID copy-pasteability across all notification types.

**Architecture:** Five new `command_type` values (`mcp_list`, `mcp_enable`, `mcp_disable`, `model_list`, `model_set`) flow through the existing worker -> D1 -> daemon pipeline. The daemon executes them via the opencode serve API (`GET /mcp`, `POST /mcp/{name}/connect`, `POST /mcp/{name}/disconnect`, `GET /provider`) and replies to Telegram. Model overrides are stored per-session in the daemon's SQLite and passed through the direct-channel protocol to the plugin, which includes them in `prompt_async` calls.

**Tech Stack:** TypeScript, Cloudflare Workers (worker), Node.js (daemon), vitest

---

### Task 1: Add new command types to the worker's `CommandType` union

**Files:**
- Modify: `packages/worker/src/webhook.ts:5`

**Step 1: Update the type**

At line 5, change:
```typescript
type CommandType = "execute" | "launch" | "kill" | "compact";
```
to:
```typescript
type CommandType = "execute" | "launch" | "kill" | "compact" | "mcp_list" | "mcp_enable" | "mcp_disable" | "model_list" | "model_set";
```

**Step 2: Commit**

```bash
git add packages/worker/src/webhook.ts
git commit -m "feat: add mcp and model command types to CommandType union"
```

---

### Task 2: Parse `/mcp` commands in the worker webhook handler

**Files:**
- Modify: `packages/worker/src/webhook.ts` (after the `/compact` handler block, before plain-message routing)

The `/mcp` commands use explicit session IDs rather than reply-to routing. The worker resolves `machine_id` from the `sessions` D1 table.

**Step 1: Add `/mcp list` handler**

After the `/compact` handler (around line 572), add:

```typescript
// /mcp list <SESSION_ID>
const mcpListMatch = update.message.text?.match(/^\/mcp\s+list\s+(\S+)$/);
if (mcpListMatch) {
  const mcpChatId = update.message.chat.id;
  const sessionId = mcpListMatch[1];
  const session = await db
    .prepare("SELECT machine_id, label FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<{ machine_id: string; label: string | null }>();
  if (!session) {
    await sendTelegramMessage(env, mcpChatId, `Session \`${sessionId}\` not found.`);
    return new Response("OK");
  }
  const machineOnline = await isMachineRecent(db, session.machine_id);
  if (!machineOnline) {
    await sendTelegramMessage(env, mcpChatId, `Machine \`${session.machine_id}\` is not reachable.`);
    return new Response("OK");
  }
  await queueCommand(db, env, session.machine_id, sessionId, "", String(mcpChatId), session.label, "mcp_list");
  return new Response("OK");
}
```

**Step 2: Add `/mcp enable` handler**

```typescript
// /mcp enable <SERVER> <SESSION_ID>
const mcpEnableMatch = update.message.text?.match(/^\/mcp\s+enable\s+(\S+)\s+(\S+)$/);
if (mcpEnableMatch) {
  const mcpChatId = update.message.chat.id;
  const serverName = mcpEnableMatch[1];
  const sessionId = mcpEnableMatch[2];
  const session = await db
    .prepare("SELECT machine_id, label FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<{ machine_id: string; label: string | null }>();
  if (!session) {
    await sendTelegramMessage(env, mcpChatId, `Session \`${sessionId}\` not found.`);
    return new Response("OK");
  }
  const machineOnline = await isMachineRecent(db, session.machine_id);
  if (!machineOnline) {
    await sendTelegramMessage(env, mcpChatId, `Machine \`${session.machine_id}\` is not reachable.`);
    return new Response("OK");
  }
  // Store server name in the `command` column
  await queueCommand(db, env, session.machine_id, sessionId, serverName, String(mcpChatId), session.label, "mcp_enable");
  return new Response("OK");
}
```

**Step 3: Add `/mcp disable` handler**

```typescript
// /mcp disable <SERVER> <SESSION_ID>
const mcpDisableMatch = update.message.text?.match(/^\/mcp\s+disable\s+(\S+)\s+(\S+)$/);
if (mcpDisableMatch) {
  const mcpChatId = update.message.chat.id;
  const serverName = mcpDisableMatch[1];
  const sessionId = mcpDisableMatch[2];
  const session = await db
    .prepare("SELECT machine_id, label FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<{ machine_id: string; label: string | null }>();
  if (!session) {
    await sendTelegramMessage(env, mcpChatId, `Session \`${sessionId}\` not found.`);
    return new Response("OK");
  }
  const machineOnline = await isMachineRecent(db, session.machine_id);
  if (!machineOnline) {
    await sendTelegramMessage(env, mcpChatId, `Machine \`${session.machine_id}\` is not reachable.`);
    return new Response("OK");
  }
  await queueCommand(db, env, session.machine_id, sessionId, serverName, String(mcpChatId), session.label, "mcp_disable");
  return new Response("OK");
}
```

Note: All three handlers share the same session-lookup + machine-check pattern. Consider extracting a helper, but keep inline for now to match the existing style.

**Step 4: Commit**

```bash
git add packages/worker/src/webhook.ts
git commit -m "feat: parse /mcp list, enable, disable commands in worker webhook"
```

---

### Task 3: Parse `/model` commands in the worker webhook handler

**Files:**
- Modify: `packages/worker/src/webhook.ts` (after the `/mcp` handlers from Task 2)

**Step 1: Add `/model` handlers**

```typescript
// /model <SESSION_ID> — list models
// /model <PROVIDER/MODEL> <SESSION_ID> — set model
const modelMatch = update.message.text?.match(/^\/model\s+(\S+)(?:\s+(\S+))?$/);
if (modelMatch) {
  const modelChatId = update.message.chat.id;
  const firstArg = modelMatch[1];
  const secondArg = modelMatch[2];

  // If firstArg contains '/', it's a model code and secondArg is the session ID
  // Otherwise firstArg is the session ID (list mode)
  const isSetMode = firstArg.includes("/") && secondArg;
  const sessionId = isSetMode ? secondArg : firstArg;
  const modelCode = isSetMode ? firstArg : null;

  const session = await db
    .prepare("SELECT machine_id, label FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<{ machine_id: string; label: string | null }>();
  if (!session) {
    await sendTelegramMessage(env, modelChatId, `Session \`${sessionId}\` not found.`);
    return new Response("OK");
  }
  const machineOnline = await isMachineRecent(db, session.machine_id);
  if (!machineOnline) {
    await sendTelegramMessage(env, modelChatId, `Machine \`${session.machine_id}\` is not reachable.`);
    return new Response("OK");
  }

  if (modelCode) {
    // model_set: store model code in `command` column
    await queueCommand(db, env, session.machine_id, sessionId, modelCode, String(modelChatId), session.label, "model_set");
  } else {
    await queueCommand(db, env, session.machine_id, sessionId, "", String(modelChatId), session.label, "model_list");
  }
  return new Response("OK");
}
```

**Step 2: Commit**

```bash
git add packages/worker/src/webhook.ts
git commit -m "feat: parse /model list and set commands in worker webhook"
```

---

### Task 4: Shape poll responses for new command types in the worker

**Files:**
- Modify: `packages/worker/src/poll.ts` (the if/else chain starting around line 36)

**Step 1: Add branches for new command types**

After the existing `compact` branch, add:

```typescript
} else if (result.commandType === "mcp_list" || result.commandType === "model_list") {
  body.sessionId = result.sessionId;
} else if (result.commandType === "mcp_enable" || result.commandType === "mcp_disable") {
  body.sessionId = result.sessionId;
  body.serverName = result.command; // server name stored in command column
} else if (result.commandType === "model_set") {
  body.sessionId = result.sessionId;
  body.model = result.command; // model code stored in command column
```

**Step 2: Commit**

```bash
git add packages/worker/src/poll.ts
git commit -m "feat: shape poll responses for mcp and model command types"
```

---

### Task 5: Add worker tests for new command parsing and poll shaping

**Files:**
- Modify: `packages/worker/test/worker.test.ts`

**Step 1: Add test for `/mcp list`**

Add to the webhook test section (follow existing test patterns with `sendWebhook()` and session registration):

```typescript
describe("/mcp commands", () => {
  it("queues mcp_list when /mcp list <session_id> is sent", async () => {
    const sessionId = "sess-mcp-test";
    await registerSession(sessionId, "devbox");
    mockTelegramSuccess();

    await sendWebhook({
      update_id: 9001,
      message: {
        message_id: 9001,
        chat: { id: 12345, type: "private" },
        from: { id: 12345, is_bot: false, first_name: "Test" },
        date: Date.now(),
        text: `/mcp list ${sessionId}`,
      },
    });

    const cmd = await env.DB.prepare(
      "SELECT command_type, session_id FROM commands ORDER BY created_at DESC LIMIT 1",
    ).first<{ command_type: string; session_id: string }>();
    expect(cmd?.command_type).toBe("mcp_list");
    expect(cmd?.session_id).toBe(sessionId);
  });

  it("queues mcp_enable with server name when /mcp enable <server> <session_id> is sent", async () => {
    const sessionId = "sess-mcp-test-2";
    await registerSession(sessionId, "devbox");
    mockTelegramSuccess();

    await sendWebhook({
      update_id: 9002,
      message: {
        message_id: 9002,
        chat: { id: 12345, type: "private" },
        from: { id: 12345, is_bot: false, first_name: "Test" },
        date: Date.now(),
        text: `/mcp enable filesystem ${sessionId}`,
      },
    });

    const cmd = await env.DB.prepare(
      "SELECT command_type, session_id, command FROM commands ORDER BY created_at DESC LIMIT 1",
    ).first<{ command_type: string; session_id: string; command: string }>();
    expect(cmd?.command_type).toBe("mcp_enable");
    expect(cmd?.session_id).toBe(sessionId);
    expect(cmd?.command).toBe("filesystem");
  });

  it("queues mcp_disable with server name", async () => {
    const sessionId = "sess-mcp-test-3";
    await registerSession(sessionId, "devbox");
    mockTelegramSuccess();

    await sendWebhook({
      update_id: 9003,
      message: {
        message_id: 9003,
        chat: { id: 12345, type: "private" },
        from: { id: 12345, is_bot: false, first_name: "Test" },
        date: Date.now(),
        text: `/mcp disable slack ${sessionId}`,
      },
    });

    const cmd = await env.DB.prepare(
      "SELECT command_type, session_id, command FROM commands ORDER BY created_at DESC LIMIT 1",
    ).first<{ command_type: string; session_id: string; command: string }>();
    expect(cmd?.command_type).toBe("mcp_disable");
    expect(cmd?.command).toBe("slack");
  });

  it("returns error when session not found", async () => {
    mockTelegramSuccess();

    await sendWebhook({
      update_id: 9004,
      message: {
        message_id: 9004,
        chat: { id: 12345, type: "private" },
        from: { id: 12345, is_bot: false, first_name: "Test" },
        date: Date.now(),
        text: "/mcp list nonexistent-session",
      },
    });

    const cmd = await env.DB.prepare(
      "SELECT command_type FROM commands ORDER BY created_at DESC LIMIT 1",
    ).first<{ command_type: string }>();
    // Should NOT have queued a command
    expect(cmd?.command_type).not.toBe("mcp_list");
  });
});
```

**Step 2: Add tests for `/model`**

```typescript
describe("/model commands", () => {
  it("queues model_list when /model <session_id> is sent", async () => {
    const sessionId = "sess-model-test";
    await registerSession(sessionId, "devbox");
    mockTelegramSuccess();

    await sendWebhook({
      update_id: 9010,
      message: {
        message_id: 9010,
        chat: { id: 12345, type: "private" },
        from: { id: 12345, is_bot: false, first_name: "Test" },
        date: Date.now(),
        text: `/model ${sessionId}`,
      },
    });

    const cmd = await env.DB.prepare(
      "SELECT command_type, session_id FROM commands ORDER BY created_at DESC LIMIT 1",
    ).first<{ command_type: string; session_id: string }>();
    expect(cmd?.command_type).toBe("model_list");
    expect(cmd?.session_id).toBe(sessionId);
  });

  it("queues model_set when /model <provider/model> <session_id> is sent", async () => {
    const sessionId = "sess-model-test-2";
    await registerSession(sessionId, "devbox");
    mockTelegramSuccess();

    await sendWebhook({
      update_id: 9011,
      message: {
        message_id: 9011,
        chat: { id: 12345, type: "private" },
        from: { id: 12345, is_bot: false, first_name: "Test" },
        date: Date.now(),
        text: `/model anthropic/claude-opus-4-6 ${sessionId}`,
      },
    });

    const cmd = await env.DB.prepare(
      "SELECT command_type, session_id, command FROM commands ORDER BY created_at DESC LIMIT 1",
    ).first<{ command_type: string; session_id: string; command: string }>();
    expect(cmd?.command_type).toBe("model_set");
    expect(cmd?.session_id).toBe(sessionId);
    expect(cmd?.command).toBe("anthropic/claude-opus-4-6");
  });
});
```

**Step 3: Run worker tests**

```bash
npm run --workspace @pigeon/worker test
```
Expected: All tests pass including new ones.

**Step 4: Commit**

```bash
git add packages/worker/test/worker.test.ts
git commit -m "test: add worker tests for /mcp and /model command parsing"
```

---

### Task 6: Add MCP methods to `OpencodeClient`

**Files:**
- Modify: `packages/daemon/src/opencode-client.ts`
- Modify or create: `packages/daemon/test/opencode-client.test.ts`

**Step 1: Write failing tests**

Add to `packages/daemon/test/opencode-client.test.ts` (create if it doesn't exist, following existing test patterns):

```typescript
import { describe, it, expect, vi } from "vitest";
import { OpencodeClient } from "../src/opencode-client.js";

function makeClient(mockFetch: ReturnType<typeof vi.fn>) {
  return new OpencodeClient({ baseUrl: "http://localhost:4096", fetchFn: mockFetch });
}

describe("OpencodeClient", () => {
  describe("mcpStatus", () => {
    it("returns MCP server statuses", async () => {
      const statuses = {
        filesystem: { status: "connected" },
        slack: { status: "disabled" },
      };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => statuses,
      });
      const client = makeClient(mockFetch);

      const result = await client.mcpStatus();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4096/mcp",
        expect.objectContaining({ method: "GET" }),
      );
      expect(result).toEqual(statuses);
    });

    it("throws on non-ok response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 500, text: async () => "error",
      });
      await expect(makeClient(mockFetch).mcpStatus()).rejects.toThrow();
    });
  });

  describe("mcpConnect", () => {
    it("calls connect endpoint for a server", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => true,
      });
      const client = makeClient(mockFetch);

      const result = await client.mcpConnect("filesystem");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4096/mcp/filesystem/connect",
        expect.objectContaining({ method: "POST" }),
      );
      expect(result).toBe(true);
    });
  });

  describe("mcpDisconnect", () => {
    it("calls disconnect endpoint for a server", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => true,
      });
      const client = makeClient(mockFetch);

      const result = await client.mcpDisconnect("slack");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4096/mcp/slack/disconnect",
        expect.objectContaining({ method: "POST" }),
      );
      expect(result).toBe(true);
    });
  });

  describe("listProviders", () => {
    it("returns provider list", async () => {
      const providers = {
        all: [{ id: "anthropic", models: {} }],
        default: { code: "anthropic/claude-sonnet-4-20250514" },
        connected: ["anthropic"],
      };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => providers,
      });
      const client = makeClient(mockFetch);

      const result = await client.listProviders();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4096/provider",
        expect.objectContaining({ method: "GET" }),
      );
      expect(result).toEqual(providers);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npm run --workspace @pigeon/daemon test -- --reporter verbose opencode-client
```
Expected: FAIL (methods don't exist)

**Step 3: Implement the methods**

Add to `packages/daemon/src/opencode-client.ts` after the existing `summarize` method:

```typescript
  async mcpStatus(): Promise<Record<string, { status: string; error?: string }>> {
    const res = await this.fetchFn(`${this.baseUrl}/mcp`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`mcpStatus failed (${res.status}): ${body}`);
    }
    return res.json();
  }

  async mcpConnect(name: string): Promise<boolean> {
    const res = await this.fetchFn(`${this.baseUrl}/mcp/${encodeURIComponent(name)}/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`mcpConnect failed (${res.status}): ${body}`);
    }
    return res.json();
  }

  async mcpDisconnect(name: string): Promise<boolean> {
    const res = await this.fetchFn(`${this.baseUrl}/mcp/${encodeURIComponent(name)}/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`mcpDisconnect failed (${res.status}): ${body}`);
    }
    return res.json();
  }

  async listProviders(): Promise<{
    all: Array<{ id: string; models: Record<string, unknown> }>;
    default: Record<string, string>;
    connected: string[];
  }> {
    const res = await this.fetchFn(`${this.baseUrl}/provider`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`listProviders failed (${res.status}): ${body}`);
    }
    return res.json();
  }
```

Note: Check the existing method style for `this.fetchFn` vs `this.fetch` — use whichever the existing code uses.

**Step 4: Run tests to verify they pass**

```bash
npm run --workspace @pigeon/daemon test -- --reporter verbose opencode-client
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/daemon/src/opencode-client.ts packages/daemon/test/opencode-client.test.ts
git commit -m "feat: add mcpStatus, mcpConnect, mcpDisconnect, listProviders to OpencodeClient"
```

---

### Task 7: Add new message types and callbacks to daemon poller

**Files:**
- Modify: `packages/daemon/src/worker/poller.ts`

**Step 1: Add message type interfaces**

After `CompactMessage` (around line 48), add:

```typescript
export interface McpListMessage {
  commandId: string;
  commandType: "mcp_list";
  sessionId: string;
  chatId: string;
}

export interface McpEnableMessage {
  commandId: string;
  commandType: "mcp_enable";
  sessionId: string;
  chatId: string;
  serverName: string;
}

export interface McpDisableMessage {
  commandId: string;
  commandType: "mcp_disable";
  sessionId: string;
  chatId: string;
  serverName: string;
}

export interface ModelListMessage {
  commandId: string;
  commandType: "model_list";
  sessionId: string;
  chatId: string;
}

export interface ModelSetMessage {
  commandId: string;
  commandType: "model_set";
  sessionId: string;
  chatId: string;
  model: string;
}
```

**Step 2: Update the WorkerMessage union**

```typescript
export type WorkerMessage =
  | ExecuteMessage | LaunchMessage | KillMessage | CompactMessage
  | McpListMessage | McpEnableMessage | McpDisableMessage
  | ModelListMessage | ModelSetMessage;
```

**Step 3: Add callbacks to PollerCallbacks**

```typescript
export interface PollerCallbacks {
  onCommand: (msg: ExecuteMessage) => Promise<void>;
  onLaunch: (msg: LaunchMessage) => Promise<void>;
  onKill: (msg: KillMessage) => Promise<void>;
  onCompact: (msg: CompactMessage) => Promise<void>;
  onMcpList: (msg: McpListMessage) => Promise<void>;
  onMcpEnable: (msg: McpEnableMessage) => Promise<void>;
  onMcpDisable: (msg: McpDisableMessage) => Promise<void>;
  onModelList: (msg: ModelListMessage) => Promise<void>;
  onModelSet: (msg: ModelSetMessage) => Promise<void>;
}
```

**Step 4: Add dispatch branches**

In the `dispatch` method, add after the `compact` branch:

```typescript
} else if (msg.commandType === "mcp_list") {
  await this.callbacks.onMcpList(msg);
} else if (msg.commandType === "mcp_enable") {
  await this.callbacks.onMcpEnable(msg);
} else if (msg.commandType === "mcp_disable") {
  await this.callbacks.onMcpDisable(msg);
} else if (msg.commandType === "model_list") {
  await this.callbacks.onModelList(msg);
} else if (msg.commandType === "model_set") {
  await this.callbacks.onModelSet(msg);
```

**Step 5: Update poller tests**

Modify `packages/daemon/test/poller.test.ts`: update `makeCallbacks()` to include the five new callbacks as `vi.fn().mockResolvedValue(undefined)`. Add one dispatch test per new type following the existing pattern.

**Step 6: Run poller tests**

```bash
npm run --workspace @pigeon/daemon test -- --reporter verbose poller
```
Expected: PASS

**Step 7: Commit**

```bash
git add packages/daemon/src/worker/poller.ts packages/daemon/test/poller.test.ts
git commit -m "feat: add MCP and model message types to daemon poller"
```

---

### Task 8: Create `mcp-ingest.ts` with tests

**Files:**
- Create: `packages/daemon/src/worker/mcp-ingest.ts`
- Create: `packages/daemon/test/mcp-ingest.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { ingestMcpListCommand, ingestMcpEnableCommand, ingestMcpDisableCommand } from "../src/worker/mcp-ingest.js";

const makeInput = (overrides: Record<string, unknown> = {}) => ({
  commandId: "cmd-1",
  sessionId: "sess-1",
  chatId: "42",
  machineId: "devbox",
  opencodeClient: {
    mcpStatus: vi.fn(),
    mcpConnect: vi.fn(),
    mcpDisconnect: vi.fn(),
  },
  sendTelegramReply: vi.fn(),
  ...overrides,
});

describe("ingestMcpListCommand", () => {
  it("lists MCP servers with status", async () => {
    const input = makeInput();
    input.opencodeClient.mcpStatus.mockResolvedValue({
      filesystem: { status: "connected" },
      slack: { status: "disabled" },
      browser: { status: "failed", error: "connection timeout" },
    });

    await ingestMcpListCommand(input);

    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("filesystem"),
    );
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("connected"),
    );
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("disabled"),
    );
  });

  it("includes session ID in response", async () => {
    const input = makeInput();
    input.opencodeClient.mcpStatus.mockResolvedValue({});

    await ingestMcpListCommand(input);

    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("sess-1"),
    );
  });

  it("handles API error gracefully", async () => {
    const input = makeInput();
    input.opencodeClient.mcpStatus.mockRejectedValue(new Error("timeout"));

    await ingestMcpListCommand(input);

    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("Failed"),
    );
  });
});

describe("ingestMcpEnableCommand", () => {
  it("connects a disabled server", async () => {
    const input = makeInput({ serverName: "slack" });
    input.opencodeClient.mcpStatus.mockResolvedValue({
      slack: { status: "disabled" },
    });
    input.opencodeClient.mcpConnect.mockResolvedValue(true);

    await ingestMcpEnableCommand(input);

    expect(input.opencodeClient.mcpDisconnect).not.toHaveBeenCalled();
    expect(input.opencodeClient.mcpConnect).toHaveBeenCalledWith("slack");
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("connected"),
    );
  });

  it("cycles an already-connected server (disconnect + connect)", async () => {
    const input = makeInput({ serverName: "filesystem" });
    input.opencodeClient.mcpStatus.mockResolvedValue({
      filesystem: { status: "connected" },
    });
    input.opencodeClient.mcpDisconnect.mockResolvedValue(true);
    input.opencodeClient.mcpConnect.mockResolvedValue(true);

    await ingestMcpEnableCommand(input);

    expect(input.opencodeClient.mcpDisconnect).toHaveBeenCalledWith("filesystem");
    expect(input.opencodeClient.mcpConnect).toHaveBeenCalledWith("filesystem");
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("reconnected"),
    );
  });

  it("reports error when server not found", async () => {
    const input = makeInput({ serverName: "nonexistent" });
    input.opencodeClient.mcpStatus.mockResolvedValue({
      filesystem: { status: "connected" },
    });

    await ingestMcpEnableCommand(input);

    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("not found"),
    );
  });
});

describe("ingestMcpDisableCommand", () => {
  it("disconnects a connected server", async () => {
    const input = makeInput({ serverName: "filesystem" });
    input.opencodeClient.mcpDisconnect.mockResolvedValue(true);

    await ingestMcpDisableCommand(input);

    expect(input.opencodeClient.mcpDisconnect).toHaveBeenCalledWith("filesystem");
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("disconnected"),
    );
  });

  it("handles disconnect failure", async () => {
    const input = makeInput({ serverName: "filesystem" });
    input.opencodeClient.mcpDisconnect.mockRejectedValue(new Error("not connected"));

    await ingestMcpDisableCommand(input);

    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("Failed"),
    );
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npm run --workspace @pigeon/daemon test -- --reporter verbose mcp-ingest
```
Expected: FAIL (module doesn't exist)

**Step 3: Implement `mcp-ingest.ts`**

Create `packages/daemon/src/worker/mcp-ingest.ts`:

```typescript
import type { OpencodeClient } from "../opencode-client.js";

export interface McpListInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "mcpStatus">;
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
}

export interface McpEnableInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  serverName: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "mcpStatus" | "mcpConnect" | "mcpDisconnect">;
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
}

export interface McpDisableInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  serverName: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "mcpDisconnect">;
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
}

const STATUS_EMOJI: Record<string, string> = {
  connected: "✅",
  disabled: "❌",
  failed: "⚠️",
  needs_auth: "🔑",
  needs_client_registration: "🔑",
};

export async function ingestMcpListCommand(input: McpListInput): Promise<void> {
  const { sessionId, chatId, opencodeClient, sendTelegramReply } = input;

  try {
    const statuses = await opencodeClient.mcpStatus();
    const entries = Object.entries(statuses);

    const lines: string[] = ["🔌 *MCP Servers:*", `🆔 \`${sessionId}\``, ""];

    if (entries.length === 0) {
      lines.push("No MCP servers configured.");
    } else {
      for (const [name, info] of entries) {
        const emoji = STATUS_EMOJI[info.status] ?? "❓";
        const errorSuffix = info.error ? `: ${info.error}` : "";
        lines.push(`${emoji} \`${name}\` — ${info.status}${errorSuffix}`);
      }
    }

    lines.push("", `\`/mcp enable <server> ${sessionId}\``);
    lines.push(`\`/mcp disable <server> ${sessionId}\``);

    await sendTelegramReply(chatId, lines.join("\n"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(chatId, `Failed to list MCP servers: ${message}`);
  }
}

export async function ingestMcpEnableCommand(input: McpEnableInput): Promise<void> {
  const { sessionId, chatId, serverName, opencodeClient, sendTelegramReply } = input;

  try {
    // Check current status to determine if we need to cycle
    const statuses = await opencodeClient.mcpStatus();
    const serverStatus = statuses[serverName];

    if (!serverStatus) {
      const available = Object.keys(statuses).map((n) => `\`${n}\``).join(", ");
      await sendTelegramReply(
        chatId,
        `MCP server \`${serverName}\` not found. Available: ${available || "none"}`,
      );
      return;
    }

    if (serverStatus.status === "connected") {
      // Cycle: disconnect then connect to refresh
      await opencodeClient.mcpDisconnect(serverName);
      await opencodeClient.mcpConnect(serverName);
      await sendTelegramReply(chatId, `🔌 \`${serverName}\` reconnected ✅`);
    } else {
      // Just connect
      await opencodeClient.mcpConnect(serverName);
      await sendTelegramReply(chatId, `🔌 \`${serverName}\` connected ✅`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(chatId, `Failed to enable \`${serverName}\`: ${message}`);
  }
}

export async function ingestMcpDisableCommand(input: McpDisableInput): Promise<void> {
  const { chatId, serverName, opencodeClient, sendTelegramReply } = input;

  try {
    await opencodeClient.mcpDisconnect(serverName);
    await sendTelegramReply(chatId, `🔌 \`${serverName}\` disconnected`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(chatId, `Failed to disable \`${serverName}\`: ${message}`);
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npm run --workspace @pigeon/daemon test -- --reporter verbose mcp-ingest
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/daemon/src/worker/mcp-ingest.ts packages/daemon/test/mcp-ingest.test.ts
git commit -m "feat: add mcp-ingest handlers for mcp_list, mcp_enable, mcp_disable"
```

---

### Task 9: Create `model-ingest.ts` with tests

**Files:**
- Create: `packages/daemon/src/worker/model-ingest.ts`
- Create: `packages/daemon/test/model-ingest.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { ingestModelListCommand, ingestModelSetCommand } from "../src/worker/model-ingest.js";
import type { Storage } from "../src/storage/types.js";

const makeInput = (overrides: Record<string, unknown> = {}) => ({
  commandId: "cmd-1",
  sessionId: "sess-1",
  chatId: "42",
  machineId: "devbox",
  opencodeClient: {
    listProviders: vi.fn(),
  },
  sendTelegramReply: vi.fn(),
  ...overrides,
});

describe("ingestModelListCommand", () => {
  it("lists models from allowed providers only", async () => {
    const input = makeInput();
    input.opencodeClient.listProviders.mockResolvedValue({
      all: [
        {
          id: "anthropic",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
            "claude-sonnet-4-20250514": { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
          },
        },
        {
          id: "openai",
          models: {
            "gpt-5.4": { id: "gpt-5.4", name: "GPT 5.4" },
          },
        },
        {
          id: "some-other-provider",
          models: {
            "some-model": { id: "some-model", name: "Some Model" },
          },
        },
      ],
      default: { code: "anthropic/claude-sonnet-4-20250514" },
      connected: ["anthropic", "openai", "some-other-provider"],
    });

    await ingestModelListCommand(input);

    const replyText = input.sendTelegramReply.mock.calls[0][1];
    // Should include allowed providers
    expect(replyText).toContain("anthropic");
    expect(replyText).toContain("openai");
    // Should NOT include disallowed providers
    expect(replyText).not.toContain("some-other-provider");
  });

  it("includes session ID in response", async () => {
    const input = makeInput();
    input.opencodeClient.listProviders.mockResolvedValue({
      all: [],
      default: {},
      connected: [],
    });

    await ingestModelListCommand(input);

    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("sess-1"),
    );
  });
});

describe("ingestModelSetCommand", () => {
  it("stores model override and confirms", async () => {
    const storage = { sessions: { setModelOverride: vi.fn() } };
    const input = makeInput({ model: "anthropic/claude-opus-4-6", storage });
    input.opencodeClient.listProviders.mockResolvedValue({
      all: [
        { id: "anthropic", models: { "claude-opus-4-6": { id: "claude-opus-4-6" } } },
      ],
      default: {},
      connected: ["anthropic"],
    });

    await ingestModelSetCommand(input);

    expect(storage.sessions.setModelOverride).toHaveBeenCalledWith("sess-1", "anthropic/claude-opus-4-6");
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("anthropic/claude-opus-4-6"),
    );
  });

  it("reports error when model not found", async () => {
    const storage = { sessions: { setModelOverride: vi.fn() } };
    const input = makeInput({ model: "anthropic/nonexistent", storage });
    input.opencodeClient.listProviders.mockResolvedValue({
      all: [
        { id: "anthropic", models: { "claude-opus-4-6": { id: "claude-opus-4-6" } } },
      ],
      default: {},
      connected: ["anthropic"],
    });

    await ingestModelSetCommand(input);

    expect(storage.sessions.setModelOverride).not.toHaveBeenCalled();
    expect(input.sendTelegramReply).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("not found"),
    );
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npm run --workspace @pigeon/daemon test -- --reporter verbose model-ingest
```
Expected: FAIL

**Step 3: Implement `model-ingest.ts`**

Create `packages/daemon/src/worker/model-ingest.ts`:

```typescript
import type { OpencodeClient } from "../opencode-client.js";

const ALLOWED_PROVIDERS = new Set(["anthropic", "openai", "google", "vertex"]);

export interface ModelListInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "listProviders">;
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
}

export interface ModelSetInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  model: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "listProviders">;
  storage: { sessions: { setModelOverride: (sessionId: string, model: string) => void } };
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
}

export async function ingestModelListCommand(input: ModelListInput): Promise<void> {
  const { sessionId, chatId, opencodeClient, sendTelegramReply } = input;

  try {
    const providers = await opencodeClient.listProviders();
    const lines: string[] = ["🤖 *Available models:*", `🆔 \`${sessionId}\``, ""];

    const filtered = providers.all.filter((p) => ALLOWED_PROVIDERS.has(p.id));

    if (filtered.length === 0) {
      lines.push("No models available from configured providers.");
    } else {
      for (const provider of filtered) {
        lines.push(`*${provider.id}*`);
        for (const modelId of Object.keys(provider.models)) {
          lines.push(`\`${provider.id}/${modelId}\``);
        }
        lines.push("");
      }
    }

    // Show current default if available
    const defaultModel = providers.default?.code;
    if (defaultModel) {
      lines.push(`Current: \`${defaultModel}\``);
    }

    lines.push("", `Reply: \`/model <code> ${sessionId}\``);

    await sendTelegramReply(chatId, lines.join("\n"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(chatId, `Failed to list models: ${message}`);
  }
}

export async function ingestModelSetCommand(input: ModelSetInput): Promise<void> {
  const { sessionId, chatId, model, opencodeClient, storage, sendTelegramReply } = input;

  try {
    // Validate the model exists
    const providers = await opencodeClient.listProviders();
    const [providerID, ...modelParts] = model.split("/");
    const modelID = modelParts.join("/");

    const provider = providers.all.find((p) => p.id === providerID);
    if (!provider || !provider.models[modelID]) {
      await sendTelegramReply(
        chatId,
        `Model \`${model}\` not found. Use \`/model ${sessionId}\` to see available models.`,
      );
      return;
    }

    // Store the override
    storage.sessions.setModelOverride(sessionId, model);

    console.log(`[model-ingest] model set sessionId=${sessionId} model=${model}`);
    await sendTelegramReply(chatId, `🤖 Model set to \`${model}\` for session \`${sessionId}\``);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(chatId, `Failed to set model: ${message}`);
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npm run --workspace @pigeon/daemon test -- --reporter verbose model-ingest
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/daemon/src/worker/model-ingest.ts packages/daemon/test/model-ingest.test.ts
git commit -m "feat: add model-ingest handlers for model_list and model_set"
```

---

### Task 10: Add `model_override` column to daemon SQLite schema and storage

**Files:**
- Modify: `packages/daemon/src/storage/schema.ts` (sessions table)
- Modify: `packages/daemon/src/storage/types.ts` (SessionRecord type, if exists)
- Add migration or ALTER TABLE in schema init

**Step 1: Add the column**

In `packages/daemon/src/storage/schema.ts`, the sessions table uses `CREATE TABLE IF NOT EXISTS`. For existing databases, add an `ALTER TABLE` migration. Look at how existing migrations are handled (search for `ALTER TABLE` in schema.ts). If there's a migration pattern, follow it. If not, add:

```typescript
// After the CREATE TABLE block for sessions:
db.exec("ALTER TABLE sessions ADD COLUMN model_override TEXT DEFAULT NULL").catch(() => {
  // Column already exists — ignore
});
```

Or if the project recreates the DB each time (check), just add `model_override TEXT DEFAULT NULL` to the CREATE TABLE.

**Step 2: Add `setModelOverride` to the sessions storage**

Find the sessions storage module (likely in `packages/daemon/src/storage/`) and add:

```typescript
setModelOverride(sessionId: string, model: string): void {
  this.db.prepare("UPDATE sessions SET model_override = ? WHERE session_id = ?").run(model, sessionId);
}

getModelOverride(sessionId: string): string | null {
  const row = this.db.prepare("SELECT model_override FROM sessions WHERE session_id = ?").get(sessionId) as { model_override: string | null } | undefined;
  return row?.model_override ?? null;
}
```

**Step 3: Update SessionRecord type**

Add `modelOverride?: string | null` to the type if it exists.

**Step 4: Commit**

```bash
git add packages/daemon/src/storage/
git commit -m "feat: add model_override column to sessions table"
```

---

### Task 11: Pass model override through DirectChannelAdapter to plugin

**Files:**
- Modify: `packages/daemon/src/adapters/types.ts` (add `modelOverride` to context)
- Modify: `packages/daemon/src/adapters/direct-channel.ts` (pass model through)
- Modify: `packages/daemon/src/opencode-direct/contracts.ts` (add model to metadata type)
- Modify: `packages/daemon/src/opencode-direct/adapter.ts` (include model in envelope)
- Modify: `packages/daemon/src/worker/command-ingest.ts` (read model override from session)
- Modify: `packages/opencode-plugin/src/index.ts` (read model from metadata, pass to prompt_async)

**Step 1: Add `modelOverride` to `CommandDeliveryContext`**

In `packages/daemon/src/adapters/types.ts`:

```typescript
export interface CommandDeliveryContext {
  commandId: string;
  chatId?: string | number;
  media?: { mime: string; filename: string; url: string; };
  modelOverride?: string; // "provider/model" format
}
```

**Step 2: Pass model through the envelope builder**

In `packages/daemon/src/opencode-direct/adapter.ts`, in `buildExecuteEnvelope()`, add the model to metadata:

```typescript
metadata: {
  chatId: input.chatId,
  replyToMessageId: input.replyToMessageId,
  replyToken: input.replyToken,
  ...(input.modelOverride ? { model: input.modelOverride } : {}),
},
```

Also update the function's input type to accept `modelOverride?: string`.

**Step 3: Read model override in `command-ingest.ts`**

In `packages/daemon/src/worker/command-ingest.ts`, in the `deliverViaAdapter` function (around line 336), read the model override from the session storage and pass it in the context:

```typescript
// Before calling adapter.deliverCommand:
const modelOverride = storage.sessions.getModelOverride?.(session.sessionId) ?? undefined;

const result = await adapter.deliverCommand(session, msg.command, {
  commandId,
  chatId: msg.chatId,
  ...(media ? { media } : {}),
  ...(modelOverride ? { modelOverride } : {}),
});
```

**Step 4: Read model in plugin and pass to `prompt_async`**

In `packages/opencode-plugin/src/index.ts`, in the `onExecute` handler (around line 100), read the model from the envelope metadata and include it in the prompt body:

```typescript
// After building the parts array (around line 94):
const modelOverride = request.metadata?.model as string | undefined;

// In the JSON.stringify body (around line 100):
body: JSON.stringify({
  parts,
  noReply: false,
  ...(modelOverride ? {
    model: {
      providerID: modelOverride.split("/")[0],
      modelID: modelOverride.split("/").slice(1).join("/"),
    },
  } : {}),
}),
```

**Step 5: Commit**

```bash
git add packages/daemon/src/adapters/ packages/daemon/src/opencode-direct/ packages/daemon/src/worker/command-ingest.ts packages/opencode-plugin/src/index.ts
git commit -m "feat: pass model override through direct-channel protocol to prompt_async"
```

---

### Task 12: Wire new callbacks in daemon entry point

**Files:**
- Modify: `packages/daemon/src/index.ts`

**Step 1: Add imports**

```typescript
import { ingestMcpListCommand, ingestMcpEnableCommand, ingestMcpDisableCommand } from "./worker/mcp-ingest.js";
import { ingestModelListCommand, ingestModelSetCommand } from "./worker/model-ingest.js";
```

**Step 2: Add callbacks**

After the `onCompact` callback (around line 106), add:

```typescript
onMcpList: async (msg) => {
  if (!opencodeClient) {
    console.warn("[index] onMcpList: no opencodeClient configured, skipping");
    return;
  }
  await ingestMcpListCommand({
    commandId: msg.commandId,
    sessionId: msg.sessionId,
    chatId: msg.chatId,
    machineId: config.machineId,
    opencodeClient,
    sendTelegramReply: sendTelegramMessage,
  });
},
onMcpEnable: async (msg) => {
  if (!opencodeClient) {
    console.warn("[index] onMcpEnable: no opencodeClient configured, skipping");
    return;
  }
  await ingestMcpEnableCommand({
    commandId: msg.commandId,
    sessionId: msg.sessionId,
    chatId: msg.chatId,
    serverName: msg.serverName,
    machineId: config.machineId,
    opencodeClient,
    sendTelegramReply: sendTelegramMessage,
  });
},
onMcpDisable: async (msg) => {
  if (!opencodeClient) {
    console.warn("[index] onMcpDisable: no opencodeClient configured, skipping");
    return;
  }
  await ingestMcpDisableCommand({
    commandId: msg.commandId,
    sessionId: msg.sessionId,
    chatId: msg.chatId,
    serverName: msg.serverName,
    machineId: config.machineId,
    opencodeClient,
    sendTelegramReply: sendTelegramMessage,
  });
},
onModelList: async (msg) => {
  if (!opencodeClient) {
    console.warn("[index] onModelList: no opencodeClient configured, skipping");
    return;
  }
  await ingestModelListCommand({
    commandId: msg.commandId,
    sessionId: msg.sessionId,
    chatId: msg.chatId,
    machineId: config.machineId,
    opencodeClient,
    sendTelegramReply: sendTelegramMessage,
  });
},
onModelSet: async (msg) => {
  if (!opencodeClient) {
    console.warn("[index] onModelSet: no opencodeClient configured, skipping");
    return;
  }
  await ingestModelSetCommand({
    commandId: msg.commandId,
    sessionId: msg.sessionId,
    chatId: msg.chatId,
    model: msg.model,
    machineId: config.machineId,
    opencodeClient,
    storage,
    sendTelegramReply: sendTelegramMessage,
  });
},
```

**Step 3: Commit**

```bash
git add packages/daemon/src/index.ts
git commit -m "feat: wire MCP and model callbacks in daemon entry point"
```

---

### Task 13: Fix session ID copy-pasteability in command responses

**Files:**
- Modify: `packages/daemon/src/worker/launch-ingest.ts:39`
- Modify: `packages/daemon/src/worker/kill-ingest.ts:20`
- Modify: `packages/daemon/src/worker/compact-ingest.ts:39`

**Step 1: Fix launch response**

In `packages/daemon/src/worker/launch-ingest.ts`, change line 39 from:
```typescript
`Session started${machineLabel}: \`${session.id}\`\nDirectory: \`${directory}\`\n\nThe pigeon plugin will notify you when the session stops or has questions.`
```
to:
```typescript
`Session started${machineLabel}:\n🆔 \`${session.id}\`\n📂 \`${directory}\`\n\nThe pigeon plugin will notify you when the session stops or has questions.`
```

**Step 2: Fix kill response**

In `packages/daemon/src/worker/kill-ingest.ts`, change line 20 from:
```typescript
`Session \`${sessionId}\` terminated${machineLabel}.`
```
to:
```typescript
`Session terminated${machineLabel}.\n🆔 \`${sessionId}\``
```

**Step 3: Fix compact error response**

In `packages/daemon/src/worker/compact-ingest.ts`, change line 39 from:
```typescript
`No user messages found in session \`${sessionId}\`. Cannot determine model for compaction.`
```
to:
```typescript
`No user messages found. Cannot determine model for compaction.\n🆔 \`${sessionId}\``
```

**Step 4: Update tests**

Update `packages/daemon/test/compact-ingest.test.ts` assertions that check for `stringContaining("No user messages")` -- these should still pass since the text still contains that substring.

Check `packages/worker/test/worker.test.ts` for any assertions on the exact launch/kill response text and update if needed.

**Step 5: Run all tests**

```bash
npm run test
```
Expected: All pass

**Step 6: Commit**

```bash
git add packages/daemon/src/worker/launch-ingest.ts packages/daemon/src/worker/kill-ingest.ts packages/daemon/src/worker/compact-ingest.ts
git commit -m "fix: make session IDs copy-pasteable on their own line in all responses"
```

---

### Task 14: End-to-end verification

**Step 1: Type-check all packages**

```bash
npm run typecheck
```
Expected: No type errors across all packages.

**Step 2: Run all tests**

```bash
npm run test
```
Expected: All tests pass.

**Step 3: Verify no regressions**

Specifically verify:
- Existing `/launch`, `/kill`, `/compact` commands still work (check tests)
- Callback query handling still works (default `execute` type)
- Reply-to-notification routing still works

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: address any issues found during verification"
```
