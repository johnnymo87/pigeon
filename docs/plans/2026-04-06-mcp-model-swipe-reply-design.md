# MCP/Model Swipe-Reply Design

## Problem

`/mcp` and `/model` commands require copy-pasting a session ID:

```
/mcp enable tec ses_2c31c2feeffe7lzPxa6musSTMf
```

This is friction. The user is typically looking at a session notification when
they want to manage MCP servers or switch models. The session ID is right there
but must be manually copied.

`/compact` already supports swipe-reply (reply to a session notification) to
infer the session ID. `/mcp` and `/model` should work the same way.

## Solution

Make the session ID argument optional on all `/mcp` and `/model` commands. When
omitted, resolve the session from `reply_to_message` via the existing `messages`
table lookup, following the `/compact` pattern.

### New command forms (in addition to existing explicit forms)

| Swipe-reply form | Resolves to |
|------------------|-------------|
| `/mcp list` | List MCP servers for the replied-to session |
| `/mcp enable <server>` | Enable/reconnect server for the replied-to session |
| `/mcp disable <server>` | Disable server for the replied-to session |
| `/model` | List available models for the replied-to session |
| `/model <provider/model>` | Set model for the replied-to session |

Existing explicit forms (`/mcp list <sid>`, `/model <sid>`, etc.) continue to
work unchanged.

### `/model` disambiguation

A single argument to `/model` is ambiguous: is it a session ID or a model name?

- **No reply context**: single arg = session ID (existing behavior).
- **With reply context, arg contains `/`**: arg = model to set, session from reply.
- **With reply context, no arg**: list models, session from reply.

### Helper extraction

The session lookup + machine liveness check is duplicated across `/compact`,
three `/mcp` handlers, and two `/model` handlers. Extract a shared helper:

```typescript
async function resolveSessionFromReply(
  db: D1Database,
  env: Env,
  chatId: string,
  replyToMessage: { message_id: number },
): Promise<{ sessionId: string; machineId: string; label: string | null } | null>
```

Returns the resolved session or sends an error reply and returns null. Each
command handler calls this when the session ID argument is missing.

### Scope

- **Worker `webhook.ts`**: Relax regexes, add reply-to-message resolution,
  extract helper.
- **No daemon changes.** Session resolution happens entirely in the worker.
- **No D1 schema changes.** The `messages` table already maps notification
  message IDs to session IDs.
- **No poll/command format changes.**
