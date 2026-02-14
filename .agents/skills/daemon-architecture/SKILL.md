---
name: daemon-architecture
description: Use when you need to understand daemon route flow, storage model, worker connectivity, and command injection architecture before making changes
---

# Pigeon Daemon Architecture

## When To Use

Use this skill before changing daemon routes, storage schema, worker integration, or injection behavior.

## Overview

`@pigeon/daemon` is the local control plane.

- API routes live in `packages/daemon/src/app.ts`
- Storage is SQLite-first in `packages/daemon/src/storage/*`
- Worker integration is in `packages/daemon/src/worker/*`

## Route Surface

- `GET /health`
- `POST /session-start`
- `POST /sessions/enable-notify`
- `GET /sessions`, `GET /sessions/:id`, `DELETE /sessions/:id`
- `POST /stop`
- `POST /cleanup`

## Storage Domains

- `sessions`: active session registry + transport metadata
- `session_tokens`: reply/command token validation state
- `reply_tokens`: message reply-key to token mapping
- `inbox`: durable local command ingest queue

## Command Delivery Adapters

Command injection is routed through `packages/daemon/src/adapters/`:

- `CommandDeliveryAdapter` — interface: `deliver(session, command) => Promise<Result>`
- `DirectChannelAdapter` — HTTP POST to OpenCode plugin backend endpoint (uses `backend_endpoint` + `backend_auth_token` from session)
- `NvimRpcAdapter` — shells out to `nvim --server <socket> --remote-expr` to call `pigeon.dispatch()` via RPC (uses `nvim_socket` + `pty_path` from session; payload/response are base64-encoded JSON)

**Routing priority:** direct-channel (if `backend_endpoint` set) > nvim (if `nvim_socket` set) > error.

## Integration Flow

1. Session start hits daemon route and writes session row.
2. Daemon registers session with worker (if configured).
3. Stop event sends notification and mints token.
4. Worker delivers reply/callback as `command` message over WS.
5. Daemon acks, routes command through adapter, sends `commandResult`.

## Verify

```bash
bun run --filter '@pigeon/daemon' typecheck
bun run --filter '@pigeon/daemon' test
```

Expected:

- typecheck passes
- tests pass
