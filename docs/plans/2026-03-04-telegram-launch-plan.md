# Telegram-Triggered Headless OpenCode Sessions — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `/launch <machine> <dir> <prompt>` Telegram command that starts a headless opencode session on any machine via the existing pigeon infrastructure.

**Architecture:** The Cloudflare Worker parses the command, queues a `launch`-type command for the target machine, the daemon receives it via WebSocket, calls the local opencode serve API to create a session and send the prompt, then confirms back to Telegram. The existing pigeon plugin handles all subsequent notifications.

**Tech Stack:** TypeScript (Bun + Node), Cloudflare Workers + Durable Objects, opencode serve HTTP API, NixOS/systemd, sops-nix.

**Repos:** `pigeon` (worker + daemon), `workstation` (NixOS config + secrets)

---

### Task 1: Workstation — Add opencode_server_password secret and opencode-serve systemd service

This task sets up the infrastructure: a persistent `opencode serve` process on devbox, and the shared password secret.

**Files:**
- Modify: `~/projects/workstation/secrets/devbox.yaml` (add new secret)
- Modify: `~/projects/workstation/hosts/devbox/configuration.nix` (add secret declaration + systemd service + daemon env vars)

**Step 1: Generate and add the secret to sops**

```bash
cd ~/projects/workstation
# Generate a strong random password
openssl rand -base64 32
# Edit the sops file and add the opencode_server_password key
sops secrets/devbox.yaml
# Add a line: opencode_server_password: <the generated password>
```

**Step 2: Declare the secret in configuration.nix**

In `hosts/devbox/configuration.nix`, find the `sops.secrets` block and add:

```nix
sops.secrets.opencode_server_password = {
  sopsFile = ../../secrets/devbox.yaml;
  owner = "dev";
};
```

**Step 3: Add the opencode-serve systemd service**

Add after the existing `pigeon-daemon` service block (around line 149):

```nix
systemd.services.opencode-serve = {
  description = "OpenCode headless serve";
  wantedBy = [ "multi-user.target" ];
  after = [ "network.target" ];
  path = [ pkgs.git pkgs.fzf pkgs.ripgrep ];
  serviceConfig = {
    User = "dev";
    Group = "dev";
    WorkingDirectory = "/home/dev";
    ExecStart = pkgs.writeShellScript "opencode-serve-start" ''
      export OPENCODE_SERVER_PASSWORD="$(cat /run/secrets/opencode_server_password)"
      exec /home/dev/.nix-profile/bin/opencode serve --port 4096 --hostname 127.0.0.1
    '';
    Restart = "always";
    RestartSec = 10;
  };
};
```

**Step 4: Add opencode env vars to the pigeon-daemon service**

In the pigeon-daemon service's start script, add after the existing `export` lines:

```bash
export OPENCODE_URL="http://127.0.0.1:4096"
export OPENCODE_PASSWORD="$(cat /run/secrets/opencode_server_password)"
```

**Step 5: Deploy and verify**

```bash
sudo nixos-rebuild switch --flake ~/projects/workstation#devbox
# Verify the service starts
sudo systemctl status opencode-serve
# Verify health endpoint
curl -u opencode:$(cat /run/secrets/opencode_server_password) http://127.0.0.1:4096/global/health
# Verify pigeon-daemon still works
sudo systemctl status pigeon-daemon
```

**Step 6: Commit**

```bash
cd ~/projects/workstation
git add -A
git commit --no-gpg-sign -m "feat: add persistent opencode-serve service and shared password secret"
git push
```

---

### Task 2: Daemon — Add config and opencode API client

**Files:**
- Modify: `packages/daemon/src/config.ts` (add OPENCODE_URL, OPENCODE_PASSWORD)
- Create: `packages/daemon/src/opencode-client.ts` (HTTP client for opencode serve API)
- Create: `packages/daemon/test/opencode-client.test.ts`

**Step 1: Write failing tests for the opencode client**

```typescript
// packages/daemon/test/opencode-client.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpencodeClient } from "../src/opencode-client.js";

describe("OpencodeClient", () => {
  let client: OpencodeClient;

  beforeEach(() => {
    client = new OpencodeClient({
      url: "http://localhost:4096",
      password: "test-password",
    });
  });

  describe("healthCheck", () => {
    it("returns true when server is healthy", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
      );
      expect(await client.healthCheck()).toBe(true);
      const call = (fetch as any).mock.calls[0];
      expect(call[0]).toBe("http://localhost:4096/global/health");
      expect(call[1].headers["Authorization"]).toMatch(/^Basic /);
      vi.unstubAllGlobals();
    });

    it("returns false when server is down", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      expect(await client.healthCheck()).toBe(false);
      vi.unstubAllGlobals();
    });
  });

  describe("createSession", () => {
    it("creates a session with the correct directory header", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ id: "sess-123" }),
        })
      );
      const result = await client.createSession("/home/dev/projects/foo");
      expect(result).toEqual({ id: "sess-123" });
      const call = (fetch as any).mock.calls[0];
      expect(call[0]).toBe("http://localhost:4096/session");
      expect(call[1].method).toBe("POST");
      expect(call[1].headers["x-opencode-directory"]).toBe("/home/dev/projects/foo");
      vi.unstubAllGlobals();
    });

    it("throws on API error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
        })
      );
      await expect(client.createSession("/foo")).rejects.toThrow("Failed to create session: 500");
      vi.unstubAllGlobals();
    });
  });

  describe("sendPrompt", () => {
    it("sends a prompt to the correct session", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
      );
      await client.sendPrompt("sess-123", "/home/dev/projects/foo", "fix the tests");
      const call = (fetch as any).mock.calls[0];
      expect(call[0]).toBe("http://localhost:4096/session/sess-123/prompt_async");
      expect(call[1].method).toBe("POST");
      expect(call[1].headers["x-opencode-directory"]).toBe("/home/dev/projects/foo");
      const body = JSON.parse(call[1].body);
      expect(body.parts[0].text).toBe("fix the tests");
      vi.unstubAllGlobals();
    });
  });

  describe("no password", () => {
    it("omits Authorization header when no password is set", async () => {
      const noAuthClient = new OpencodeClient({ url: "http://localhost:4096" });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
      );
      await noAuthClient.healthCheck();
      const call = (fetch as any).mock.calls[0];
      expect(call[1].headers["Authorization"]).toBeUndefined();
      vi.unstubAllGlobals();
    });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd ~/projects/pigeon
bun run --filter '@pigeon/daemon' test -- opencode-client
```

Expected: FAIL — module not found.

**Step 3: Add config fields**

In `packages/daemon/src/config.ts`, add to the `DaemonConfig` interface and `loadConfig()`:

```typescript
// Add to DaemonConfig interface:
  opencodeUrl?: string;
  opencodePassword?: string;

// Add to loadConfig():
  opencodeUrl: process.env.OPENCODE_URL || undefined,
  opencodePassword: process.env.OPENCODE_PASSWORD || undefined,
```

**Step 4: Implement the opencode client**

```typescript
// packages/daemon/src/opencode-client.ts

export interface OpencodeClientConfig {
  url: string;
  password?: string;
}

export class OpencodeClient {
  private readonly url: string;
  private readonly authHeader?: string;

  constructor(config: OpencodeClientConfig) {
    this.url = config.url.replace(/\/$/, "");
    if (config.password) {
      const encoded = Buffer.from(`opencode:${config.password}`).toString("base64");
      this.authHeader = `Basic ${encoded}`;
    }
  }

  private headers(directory?: string): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authHeader) h["Authorization"] = this.authHeader;
    if (directory) h["x-opencode-directory"] = directory;
    return h;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/global/health`, {
        headers: this.headers(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async createSession(directory: string): Promise<{ id: string }> {
    const res = await fetch(`${this.url}/session`, {
      method: "POST",
      headers: this.headers(directory),
    });
    if (!res.ok) {
      throw new Error(`Failed to create session: ${res.status}`);
    }
    return res.json() as Promise<{ id: string }>;
  }

  async sendPrompt(sessionId: string, directory: string, prompt: string): Promise<void> {
    const res = await fetch(`${this.url}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
    });
    if (!res.ok) {
      throw new Error(`Failed to send prompt: ${res.status}`);
    }
  }
}
```

**Step 5: Run tests to verify they pass**

```bash
bun run --filter '@pigeon/daemon' test -- opencode-client
```

Expected: all pass.

**Step 6: Commit**

```bash
cd ~/projects/pigeon
git add -A
git commit --no-gpg-sign -m "feat(daemon): add opencode API client and config"
```

---

### Task 3: Worker — Parse /launch command and queue with launch type

**Files:**
- Modify: `packages/worker/src/router-do.ts` (add `command_type` and `directory` columns to schema)
- Modify: `packages/worker/src/webhook.ts` (parse /launch command)
- Modify: `packages/worker/src/command-queue.ts` (send launch-type WebSocket messages)
- Modify or create: `packages/worker/test/launch.test.ts`

**Step 1: Write failing tests for /launch parsing**

Create a test file that validates the /launch command parsing logic. The test should cover:
- Valid `/launch devbox ~/projects/foo fix the tests` — extracts machine, directory, prompt
- Missing arguments — returns error
- Unknown machine — returns error (machine not connected)

Adapt the existing test patterns in `packages/worker/test/worker.test.ts`.

**Step 2: Run test to verify it fails**

```bash
bun run --filter '@pigeon/worker' test
```

**Step 3: Add columns to command_queue schema**

In `packages/worker/src/router-do.ts`, modify the `command_queue` CREATE TABLE to add:

```sql
command_type TEXT NOT NULL DEFAULT 'execute',
directory TEXT,
```

**Step 4: Parse /launch in webhook.ts**

Add a new regex and handler in the message processing logic. Before the existing session resolution logic, check for `/launch`:

```typescript
const launchMatch = text.match(/^\/launch\s+(\S+)\s+(\S+)\s+(.+)$/s);
if (launchMatch) {
  const [, machineId, directory, prompt] = launchMatch;
  // Validate machine is connected (check sessions table for machine_id,
  // or check WebSocket connection state)
  // Queue a launch command
  // Send immediate ack to Telegram
  return;
}
```

The command queue insert for launch commands uses `command_type = 'launch'`, `session_id = NULL`, `directory = <dir>`, `command = <prompt>`.

**Step 5: Send launch-type WebSocket messages**

In `packages/worker/src/command-queue.ts`, modify `sendCommand()` (or add a parallel function) to check `command_type`. For `launch` commands, send:

```json
{"type": "launch", "commandId": "...", "directory": "...", "prompt": "...", "chatId": "..."}
```

Instead of the existing `{type: "command", ...}` shape.

Modify `flushCommandQueue()` to read the `command_type` and `directory` columns and pass them through.

**Step 6: Send immediate Telegram ack**

When the /launch command is parsed, send a Telegram message back immediately:

```
Launching on <machine> in <directory>...
```

Use the existing `sendTelegramMessage` helper or call the Telegram API directly from the webhook handler.

**Step 7: Run tests**

```bash
bun run --filter '@pigeon/worker' test
```

**Step 8: Commit**

```bash
git add -A
git commit --no-gpg-sign -m "feat(worker): parse /launch command and queue launch-type commands"
```

---

### Task 4: Daemon — Handle launch command

**Files:**
- Modify: `packages/daemon/src/worker/machine-agent.ts` (handle "launch" message type)
- Modify: `packages/daemon/src/worker/command-ingest.ts` (add launch handling logic)
- Modify: `packages/daemon/src/index.ts` (wire OpencodeClient into MachineAgent)
- Create: `packages/daemon/test/launch-ingest.test.ts`

**Step 1: Write failing tests for launch ingestion**

```typescript
// packages/daemon/test/launch-ingest.test.ts
import { describe, it, expect, vi } from "vitest";
import { ingestLaunchCommand } from "../src/worker/command-ingest.js";

describe("ingestLaunchCommand", () => {
  it("creates a session and sends prompt on healthy server", async () => {
    const mockClient = {
      healthCheck: vi.fn().mockResolvedValue(true),
      createSession: vi.fn().mockResolvedValue({ id: "sess-abc" }),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
    };
    const mockNotify = vi.fn().mockResolvedValue(undefined);
    const mockAck = vi.fn();

    await ingestLaunchCommand({
      commandId: "cmd-1",
      directory: "/home/dev/projects/foo",
      prompt: "fix the tests",
      chatId: "12345",
      opencodeClient: mockClient as any,
      sendTelegramReply: mockNotify,
      sendAck: mockAck,
    });

    expect(mockAck).toHaveBeenCalledWith("cmd-1");
    expect(mockClient.healthCheck).toHaveBeenCalled();
    expect(mockClient.createSession).toHaveBeenCalledWith("/home/dev/projects/foo");
    expect(mockClient.sendPrompt).toHaveBeenCalledWith("sess-abc", "/home/dev/projects/foo", "fix the tests");
    expect(mockNotify).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("sess-abc")
    );
  });

  it("sends error when opencode serve is down", async () => {
    const mockClient = {
      healthCheck: vi.fn().mockResolvedValue(false),
    };
    const mockNotify = vi.fn().mockResolvedValue(undefined);
    const mockAck = vi.fn();

    await ingestLaunchCommand({
      commandId: "cmd-2",
      directory: "/home/dev/projects/foo",
      prompt: "fix the tests",
      chatId: "12345",
      opencodeClient: mockClient as any,
      sendTelegramReply: mockNotify,
      sendAck: mockAck,
    });

    expect(mockAck).toHaveBeenCalledWith("cmd-2");
    expect(mockNotify).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("not running")
    );
  });

  it("sends error when session creation fails", async () => {
    const mockClient = {
      healthCheck: vi.fn().mockResolvedValue(true),
      createSession: vi.fn().mockRejectedValue(new Error("500")),
    };
    const mockNotify = vi.fn().mockResolvedValue(undefined);
    const mockAck = vi.fn();

    await ingestLaunchCommand({
      commandId: "cmd-3",
      directory: "/home/dev/projects/foo",
      prompt: "fix the tests",
      chatId: "12345",
      opencodeClient: mockClient as any,
      sendTelegramReply: mockNotify,
      sendAck: mockAck,
    });

    expect(mockNotify).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("Failed")
    );
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run --filter '@pigeon/daemon' test -- launch-ingest
```

**Step 3: Implement ingestLaunchCommand**

Add to `packages/daemon/src/worker/command-ingest.ts` (or a new file `launch-ingest.ts`):

```typescript
import type { OpencodeClient } from "../opencode-client.js";

export interface LaunchCommandInput {
  commandId: string;
  directory: string;
  prompt: string;
  chatId: string;
  opencodeClient: OpencodeClient;
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
  sendAck: (commandId: string) => void;
}

export async function ingestLaunchCommand(input: LaunchCommandInput): Promise<void> {
  const { commandId, directory, prompt, chatId, opencodeClient, sendTelegramReply, sendAck } = input;

  // Ack immediately so the worker knows we received it
  sendAck(commandId);

  // Health check
  const healthy = await opencodeClient.healthCheck();
  if (!healthy) {
    await sendTelegramReply(chatId, `opencode serve is not running on this machine.`);
    return;
  }

  try {
    // Create session
    const session = await opencodeClient.createSession(directory);

    // Send prompt
    await opencodeClient.sendPrompt(session.id, directory, prompt);

    // Confirm to Telegram
    await sendTelegramReply(
      chatId,
      `Session started: \`${session.id}\`\nDirectory: \`${directory}\`\n\nThe pigeon plugin will notify you when the session stops or has questions.`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(chatId, `Failed to launch session: ${msg}`);
  }
}
```

**Step 4: Wire into machine-agent.ts**

In `packages/daemon/src/worker/machine-agent.ts`, add handling for the `"launch"` message type in the WebSocket message handler (alongside the existing `"command"` handler):

```typescript
case "launch": {
  const { commandId, directory, prompt, chatId } = parsed;
  await ingestLaunchCommand({
    commandId,
    directory,
    prompt,
    chatId,
    opencodeClient: this.opencodeClient,
    sendTelegramReply: (chatId, text) => this.sendTelegramReply(chatId, text),
    sendAck: (id) => this.sendAck(id),
  });
  break;
}
```

The `MachineAgent` constructor needs to accept an `OpencodeClient` instance. Update `index.ts` to construct one from config and pass it in.

The `sendTelegramReply` method uses the existing notification service to send a Telegram message. If the daemon already has a direct Telegram API path (via `TelegramNotificationService`), use that. Otherwise, route through the worker's `/notifications/send` endpoint — but that requires a sessionId which we don't have for the ack. The simplest approach is to call the Telegram `sendMessage` API directly for launch confirmations, similar to how `TelegramNotificationService` works.

**Step 5: Wire OpencodeClient in index.ts**

In `packages/daemon/src/index.ts`, construct the client from config:

```typescript
import { OpencodeClient } from "./opencode-client.js";

// After loading config:
const opencodeClient = config.opencodeUrl
  ? new OpencodeClient({ url: config.opencodeUrl, password: config.opencodePassword })
  : undefined;

// Pass to MachineAgent constructor:
const machineAgent = new MachineAgent({
  // ...existing params...
  opencodeClient,
});
```

**Step 6: Run tests**

```bash
bun run --filter '@pigeon/daemon' test
```

**Step 7: Commit**

```bash
git add -A
git commit --no-gpg-sign -m "feat(daemon): handle launch commands from worker"
```

---

### Task 5: End-to-end verification

**Step 1: Deploy workstation changes**

```bash
cd ~/projects/workstation
sudo nixos-rebuild switch --flake .#devbox
```

Verify:
```bash
sudo systemctl status opencode-serve
curl -u opencode:$(cat /run/secrets/opencode_server_password) http://127.0.0.1:4096/global/health
```

**Step 2: Deploy worker**

```bash
cd ~/projects/pigeon
bun run --filter '@pigeon/worker' deploy
```

**Step 3: Restart daemon**

```bash
sudo systemctl restart pigeon-daemon
sudo systemctl status pigeon-daemon
```

**Step 4: Test from Telegram**

Send in Telegram:
```
/launch devbox ~/projects/pigeon "check the health endpoint and report back"
```

Expected:
1. Immediate ack: "Launching on devbox in ~/projects/pigeon..."
2. Session confirmation with session ID
3. Pigeon plugin notifications (stop notification when the agent finishes)

**Step 5: Verify attach works**

```bash
opencode attach http://localhost:4096 --session <session-id-from-telegram>
```

**Step 6: Commit any fixes and push everything**

```bash
cd ~/projects/pigeon
git push

cd ~/projects/workstation
git push
```

---

### Task 6 (follow-up, not in this PR): Cloudbox + macOS daemon deployment

Add the same opencode-serve service and pigeon-daemon env vars to:
- `hosts/cloudbox/configuration.nix` — same pattern as devbox
- macOS — launchd agent in `users/dev/home.darwin.nix` (different service manager)

This is deferred because it requires deploying pigeon-daemon to those machines first (cloudbox has it, macOS may not).
