# Pigeon `/mcp` and `/model` Slash Commands

## Problem

Headless opencode sessions managed via Telegram have no way to:
1. Refresh stale MCP server connections (today requires restarting the opencode process)
2. Enable/disable MCP servers
3. Switch models mid-session

Additionally, session IDs are not consistently copy-pasteable across all notification types.

## Decision

Two new slash command families: `/mcp` (list/enable/disable MCP servers) and `/model` (list/set models). Both use explicit session IDs rather than reply-to routing, since the user copy-pastes session IDs from notifications.

MCP "restart" is handled by cycling disconnect+connect on an already-connected server (via `/mcp enable`), avoiding any process-level restart. Model switching is per-session, stored in the daemon's SQLite and passed through to opencode on every `prompt_async` call.

## Design

### 1. Commands

| Command | D1 `command_type` | What it does |
|---------|-------------------|-------------|
| `/mcp list <SESSION_ID>` | `mcp_list` | Lists MCP servers with status |
| `/mcp enable <SERVER> <SESSION_ID>` | `mcp_enable` | Connects if disabled; cycles (disconnect+connect) if already connected |
| `/mcp disable <SERVER> <SESSION_ID>` | `mcp_disable` | Disconnects a server |
| `/model <SESSION_ID>` | `model_list` | Lists available models (filtered) |
| `/model <PROVIDER/MODEL> <SESSION_ID>` | `model_set` | Switches session to specified model |

### 2. Data flow: `/mcp list`

```
Telegram: "/mcp list sess-abc123"
  → Worker: parse command, resolve machine_id from sessions table
  → D1: INSERT command {command_type: "mcp_list", session_id}
  → Daemon polls: receives McpListMessage
  → Daemon: GET /mcp (opencode serve API, with session's directory)
  → Daemon: format response, POST /notifications/send
  → Telegram:
      🔌 MCP Servers:
      🆔 `sess-abc123`

      ✅ filesystem — connected
      ✅ github — connected
      ❌ slack — disabled
      ⚠️ browser — failed: connection timeout

      `/mcp enable <server> sess-abc123`
      `/mcp disable <server> sess-abc123`
```

### 3. Data flow: `/mcp enable`

```
Telegram: "/mcp enable filesystem sess-abc123"
  → Worker: parse, resolve machine_id, queue as mcp_enable
  → Daemon polls: receives McpEnableMessage {serverName, sessionId}
  → Daemon: GET /mcp to check current status
  → If "connected": POST /mcp/filesystem/disconnect, then POST /mcp/filesystem/connect
  → If "disabled"/"failed": POST /mcp/filesystem/connect
  → Daemon: POST /notifications/send
  → Telegram: "🔌 `filesystem` reconnected ✅" or "🔌 `filesystem` connected ✅"
```

`/mcp disable` follows the same pattern, calling `POST /mcp/{name}/disconnect`.

### 4. Data flow: `/model` (list)

```
Telegram: "/model sess-abc123"
  → Worker: parse, resolve machine_id, queue as model_list
  → Daemon polls: receives ModelListMessage
  → Daemon: GET /provider (opencode serve API)
  → Daemon: filter to allowed providers, format response
  → Telegram:
      🤖 Available models:
      🆔 `sess-abc123`

      *anthropic*
      `anthropic/claude-opus-4-6`

      *openai*
      `openai/gpt-5.4`

      *google*
      `google/gemini-3.1-pro`

      Current: `anthropic/claude-sonnet-4-20250514`

      Reply: `/model <code> sess-abc123`
```

Provider allowlist: `anthropic`, `openai`, `google`, `vertex`. Configurable in daemon config. Only shows models from connected providers that are present in the opencode API response.

### 5. Data flow: `/model set`

```
Telegram: "/model anthropic/claude-opus-4-6 sess-abc123"
  → Worker: parse, resolve machine_id, queue as model_set {model, session_id}
  → Daemon polls: receives ModelSetMessage
  → Daemon: validate model exists via GET /provider
  → Daemon: store model_override in sessions SQLite table
  → Daemon: POST /notifications/send
  → Telegram: "🤖 Model set to `anthropic/claude-opus-4-6` for session `sess-abc123`"
```

On subsequent commands to this session, the `DirectChannelAdapter` includes the model override in the `ExecuteCommandEnvelope` metadata. The plugin reads it and passes `model: { providerID, modelID }` to `prompt_async`.

### 6. Worker changes (`packages/worker/`)

**`webhook.ts`**: Add regex patterns:
- `/^\/mcp\s+list\s+(\S+)$/` → `mcp_list`
- `/^\/mcp\s+enable\s+(\S+)\s+(\S+)$/` → `mcp_enable` (captures server name + session ID)
- `/^\/mcp\s+disable\s+(\S+)\s+(\S+)$/` → `mcp_disable`
- `/^\/model\s+((?:\S+\/\S+)\s+)?(\S+)$/` → if group 1 present: `model_set`, else `model_list`

Session resolution: look up `session_id` in the `sessions` D1 table to get `machine_id`. Validate `isMachineRecent`. Reply with error if session not found or machine offline.

**`poll.ts`**: Shape poll responses for the new command types. All include `sessionId` and `chatId`. `mcp_enable`/`mcp_disable` also include `serverName`. `model_set` includes `model`.

**No D1 schema migration** -- `command_type` is already a free-text `TEXT` column. The `command` column can carry the server name or model string.

### 7. Daemon changes (`packages/daemon/`)

**New message types in `poller.ts`**:
```typescript
interface McpListMessage {
  commandId: string;
  commandType: "mcp_list";
  sessionId: string;
  chatId: string;
}
interface McpEnableMessage {
  commandId: string;
  commandType: "mcp_enable";
  sessionId: string;
  chatId: string;
  serverName: string;
}
interface McpDisableMessage {
  commandId: string;
  commandType: "mcp_disable";
  sessionId: string;
  chatId: string;
  serverName: string;
}
interface ModelListMessage {
  commandId: string;
  commandType: "model_list";
  sessionId: string;
  chatId: string;
}
interface ModelSetMessage {
  commandId: string;
  commandType: "model_set";
  sessionId: string;
  chatId: string;
  model: string; // "provider/model" format
}
```

**`opencode-client.ts`**: Add methods:
- `mcpStatus(directory?)` → `GET /mcp`
- `mcpConnect(name, directory?)` → `POST /mcp/{name}/connect`
- `mcpDisconnect(name, directory?)` → `POST /mcp/{name}/disconnect`
- `listProviders(directory?)` → `GET /provider`

**New ingest files**:
- `mcp-ingest.ts`: Handlers for `mcp_list`, `mcp_enable`, `mcp_disable`
- `model-ingest.ts`: Handlers for `model_list`, `model_set`

**`sessions` SQLite table**: Add nullable `model_override TEXT` column. Updated by `model_set` handler. Read by `DirectChannelAdapter` when building the envelope.

**`index.ts`**: Wire new poller callbacks.

### 8. Plugin changes (`packages/opencode-plugin/`)

**`direct-channel.ts`**: Read `metadata.model` from `ExecuteCommandEnvelope`. If present, include `model: { providerID, modelID }` in the `prompt_async` body.

The envelope's `metadata` field (already typed as `Record<string, unknown>`) carries the model override without protocol version changes.

### 9. Session ID copy-pasteability fix

Update all command response messages to put the session ID on its own line using the established `🆔 \`{sessionId}\`` pattern:

**`launch-ingest.ts`** (currently inline):
```
Session started on devbox:
🆔 `sess-abc123`
📂 `~/projects/pigeon`

The pigeon plugin will notify you when the session stops or has questions.
```

**`kill-ingest.ts`** (currently inline):
```
Session terminated on devbox.
🆔 `sess-abc123`
```

**`compact-ingest.ts`** error message (currently inline):
```
No user messages found. Cannot determine model for compaction.
🆔 `sess-abc123`
```

### 10. Error handling

- Session ID not found in D1: worker replies "Session `<id>` not found."
- Machine offline: worker replies "Machine `<id>` is not reachable."
- MCP server name not found: daemon replies "MCP server `<name>` not found. Use `/mcp list <id>` to see available servers."
- MCP connect/disconnect failure: daemon replies with error message from opencode API.
- Model not found in provider list: daemon replies "Model `<code>` not found. Use `/model <id>` to see available models."
- opencode serve unreachable: daemon logs error, lease expires, command retries once.

### 11. No changes required to

- D1 schema (command_type is free-text)
- Notification formatting functions (stop/question notifications already have session IDs on their own lines)
- OpenCode itself (all APIs already exist: `/mcp`, `/mcp/{name}/connect`, `/mcp/{name}/disconnect`, `/provider`, `prompt_async` with model parameter)
