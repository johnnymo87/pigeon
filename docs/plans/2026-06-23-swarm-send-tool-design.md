# Design: `swarm_send` opencode plugin tool

Date: 2026-06-23
Issue: pigeon-4ou

## Goal

Add an always-on `swarm_send` tool to pigeon's opencode plugin (alongside the
existing `swarm_read`), so any agent can send a swarm message via a native tool
call instead of shelling out to `pigeon-send`/`opencode-send`. `from` is
auto-injected from the calling session, the `<swarm_message>` envelope is added
by pigeon, and the double-wrap mistake (a sender hand-writing the envelope into
the payload) becomes structurally hard to make.

### Why a plugin tool, not an MCP server

- The plugin is already always-loaded in every session (it's how `swarm_read`
  is available). A new MCP server would default to `enabled = false` like every
  other MCP in `opencode-config.nix` (the Gemini schema-incompatibility policy),
  so it would not be present when needed.
- No second process: the plugin already has `daemon-client.ts` and a derived
  `daemonUrl`.
- Proven, Gemini-safe pattern: mirror `swarm_read` with simple string args (no
  `anyOf`-null unions).

## File layout & naming

- New file `packages/opencode-plugin/src/swarm-send-tool.ts`, mirroring
  `swarm-tool.ts`.
- Exports:
  - `SWARM_SEND_TOOL_NAME = "swarm_send"` (satisfies Anthropic's tool-name
    regex `^[a-zA-Z0-9_-]{1,128}$`).
  - `swarmSend(opts, args)` — pure helper, unit-testable with an injectable
    `fetchFn`.
  - `createSwarmSendTool(daemonBaseUrl)` — `ToolDefinition` factory.

## Tool surface (Gemini-safe simple types)

```
swarm_send(
  to:        string   (required)  // recipient session id, ^ses_
  message:   string   (required)  // RAW text; pigeon adds the envelope
  kind?:     string   (default "chat")
  priority?: string   (default "normal"; one of urgent|normal|low)
  reply_to?: string                // a msg_id to thread under
)
```

- `from` is **not** an arg — taken from `ctx.sessionID` (cannot be spoofed or
  typo'd).
- All args are plain strings (no unions / `anyOf`), matching `swarm_read`'s
  `.optional()` style, so Vertex Gemini function-calling accepts the schema.
- Description steers away from the double-wrap: *"Provide raw message text;
  pigeon wraps it in the `<swarm_message>` envelope automatically — do not
  include envelope tags yourself. `from` is set automatically to the current
  session."*

## Pure helper `swarmSend`

- POSTs to `${daemonBaseUrl}/swarm/send` with JSON body
  `{ from, to, kind, priority, payload: message, reply_to? }`. The daemon mints
  `msg_id`.
- Headers: `Content-Type: application/json` plus
  `Authorization: Bearer $PIGEON_DAEMON_AUTH_TOKEN` when that env var is set.
  Required because `/swarm/send` is an auth-protected POST when the daemon has a
  token configured (`checkAuth`); harmless no-op on devbox where it is unset.
  This is why `swarm_read` (a GET on `/swarm/inbox`, not auth-protected) gets
  away without the header.
- On `202`: parse `{ accepted, msg_id }` and return it.
- On non-2xx (`400` close-tag, `401`, `5xx`): throw
  `Error("swarm_send failed: <status> <body>")` so the agent sees the real
  reason inline. Mirrors `swarmRead`'s throw-on-failure. No circuit breaker —
  interactive tool calls should surface errors, not swallow them.

## Registration (`index.ts`)

```ts
tool: {
  [SWARM_READ_TOOL_NAME]: createSwarmReadTool(daemonUrl),
  [SWARM_SEND_TOOL_NAME]: createSwarmSendTool(daemonUrl),
},
```

`daemonUrl` is already in scope (index.ts:51).

## Return value & metadata

- Returns a concise string:
  `Queued msg_<id> -> <to> (kind=<k> priority=<p>, <n> chars). Delivery is async.`
- `ctx.metadata({ title: "swarm send -> <to>", metadata: { msg_id, to, kind, priority } })`
  (mirrors `swarm_read`).

## Testing (`test/swarm-send-tool.test.ts`, TDD)

Mirror `swarm-tool.test.ts` with a mock `fetchFn`:

- Builds the correct request: URL `/swarm/send`, method POST, body fields,
  `from` taken from ctx, `Authorization` header present when token env set and
  absent when not.
- `202` → returns `msg_id`; formats the queued string.
- `400` close-tag body → throws with the daemon's error text surfaced.
- `kind`/`priority` defaults applied when omitted.

## Out of scope (YAGNI; future)

- `channel` broadcast (daemon supports it; add later if needed).
- Blocking delivery-confirmation poll (`handed_off`) — stays async; `swarm_read`
  covers verification.
- Caller-supplied `msg_id` idempotency.

## Docs

- Add a short "native tool" note to the `opencode-send` / `swarm-messaging`
  skills: prefer `swarm_send` in-agent; the CLIs remain for shell/scripts.

## Rollout

- Pure pigeon-repo change. No workstation edit — `opencode-config.nix` already
  symlinks the plugin. Takes effect when sessions reload the plugin.
