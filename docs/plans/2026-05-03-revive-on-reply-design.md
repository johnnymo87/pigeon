# Revive-on-Reply: Self-Healing Telegram Replies After Opencode-Serve Restart

**Date:** 2026-05-03
**Status:** Design — pending user approval

## Problem

After cloudbox's nightly `reset-workspace` (3 AM ET) restarts
`opencode-serve.service`, the pigeon plugin process — which lives inside
opencode-serve — is destroyed and replaced. The new plugin instance loads, but
it knows nothing about the existing on-disk sessions until each one emits a
`message.updated` event. Until then, the daemon's `sessions` table still points
each session at the **old** plugin's `backendEndpoint` (a `127.0.0.1:<random>`
HTTP server that died with the old process).

When the user replies in Telegram to a notification from one of these sessions,
the daemon:

1. Looks up the local session row (still present).
2. Selects `DirectChannelAdapter` (because `backend_kind = "opencode-plugin-direct"`).
3. POSTs to the dead `backendEndpoint` → ECONNREFUSED.
4. Hits the `isConnectionError` branch in
   `packages/daemon/src/worker/command-ingest.ts:392`, **deletes the local
   session row**, and **acks the command** to the worker.

Net effect: the user's reply silently vanishes. No Telegram feedback. No retry.
The next reply for the same session id fails earlier (no session row at all)
and is also silently dropped, until the worker's session row is reaped after
7 days.

The session itself is fine — it's still in `~/.local/share/opencode/opencode.db`
and opencode-serve will happily accept a `prompt_async` for it. The only
missing piece is the plugin endpoint.

The user wants Telegram replies to "just work" the way `opencode attach
http://localhost:4096 --session <sid>` from a terminal does today.

## Out of Scope

- A general `/attach <sid>` Telegram command. Same primitive, can be added
  later as a thin wrapper.
- Reviving sessions that have been deleted from opencode-serve (genuinely gone,
  not just plugin-dead). These get a clear error message; nothing to revive.
- Restoring features that fundamentally cannot survive a plugin restart on the
  in-flight reply (see "Degraded mode on first revival" below).

## Architecture

### Key insight: late-discovery already does the recovery

The plugin already has a self-healing path. `lateDiscoverSession` in
`packages/opencode-plugin/src/index.ts:211` fires when the plugin sees a
`message.updated` event for a session id it doesn't know about. It calls
`session.get` to confirm the session exists, then calls `registerSession`
which POSTs `/session-start` to the daemon. The daemon's upsert
(`packages/daemon/src/storage/repos.ts:84-102`) does
`ON CONFLICT(session_id) DO UPDATE SET backend_endpoint = excluded.backend_endpoint,
backend_auth_token = excluded.backend_auth_token`, so the dead endpoint is
replaced with the new one.

**The thing that triggers this** is any new message activity on the session.
Which is exactly what a reply is.

So the plan is: instead of POSTing to the dead plugin endpoint and giving up,
deliver the reply via opencode-serve's `prompt_async` directly (the
plugin-free path that the swarm arbiter already uses). That delivery causes
the next assistant `message.updated`, which triggers `lateDiscoverSession`,
which re-registers the session with a fresh `backendEndpoint`. From the next
reply onward, the standard plugin-direct path works again.

### Delivery flow (proposed)

```
Reply arrives at daemon (command-ingest.ts ingestWorkerCommand)
  ↓
Lookup local session row in daemon SQLite
  │
  ├── not found → log + ack + return (unchanged)
  │
  └── found → DirectChannelAdapter.deliverCommand
                ↓
              POST to session.backendEndpoint
                │
                ├── 2xx → done (unchanged)
                │
                ├── non-connection error → existing failure path (unchanged)
                │
                └── connection error (ECONNREFUSED, ETIMEOUT, fetch failed, …)
                    ↓ [NEW]
                  reviveAndDeliver(session, command)
                    ↓
                  GET /session/:id from opencode-serve
                    │
                    ├── 404 → session truly gone
                    │   ↓
                    │   - delete local session row (unchanged behavior)
                    │   - ack command (unchanged)
                    │   - send Telegram reply: "Session no longer exists"
                    │
                    └── 200 with .directory
                        ↓
                      OpencodeClient.sendPrompt(sessionId, directory, text)
                        │
                        ├── success
                        │   ↓
                        │   - DO NOT delete local session row
                        │   - clear session.backendEndpoint to force fallback
                        │     until the plugin re-registers
                        │   - ack command
                        │   - fire-and-forget oc-auto-attach <sid>
                        │     (best-effort, ENOENT-tolerant — same as
                        │     launch-ingest.ts:59-77)
                        │
                        └── failure
                            ↓
                          - send Telegram reply with error
                          - ack command (don't infinitely retry)
                          - leave session row alone for now
```

### Why this is safe

- **Idempotency**: Worker dedups by `commandId`; ack-on-success path unchanged.
- **No new state**: Reuses existing `OpencodeClient.sendPrompt` and the daemon's
  existing session row. Optional `backendEndpoint` clearing is the only schema
  use change, and the column is already nullable.
- **Self-healing**: Once the plugin late-discovers, the next delivery uses the
  standard path. No persistent "fallback mode" stickiness.
- **Bounded fallback storm**: At worst, every session gets one fallback delivery
  per opencode-serve restart, then heals. With ~1500 sessions on disk but only
  recently-active ones likely to receive replies, the load is trivial.

## Components

### 1. `command-ingest.ts` — fallback branch

In the `isConnectionError` block at line 392, before the
`storage.sessions.delete()` call, attempt revival via a new helper. If revival
succeeds, skip the delete and return.

### 2. `revive-and-deliver.ts` (new)

A small module exposing `reviveAndDeliver(deps, session, command)`. Owns:
- The `GET /session/:id` existence check
- The `OpencodeClient.sendPrompt` fallback delivery
- The `oc-auto-attach` spawn (best-effort)
- The `clearBackendEndpoint(sessionId)` storage update on success

Lives next to `command-ingest.ts` to keep the failure-handling logic colocated.

### 3. `OpencodeClient.getSession(sessionId)` (extension)

`OpencodeClient` already has `createSession`, `sendPrompt`, `healthCheck`. Add
a `getSession(sessionId)` method (or `resolveDirectory(sessionId)`) that wraps
`GET /session/:id` and returns `{ id, directory } | null`. The
`SessionDirectoryRegistry` (`packages/daemon/src/swarm/registry.ts:27`) already
does this — extract or share.

### 4. Storage repo — `clearBackendEndpoint(sessionId)`

A small helper that NULLs `backend_endpoint` and `backend_auth_token` for a
session id. Used after a successful fallback to ensure the next reply doesn't
re-attempt the dead endpoint if the plugin hasn't re-registered yet.

Alternative considered: leave the dead endpoint in place and let it ECONNREFUSE
again, falling back each time. Rejected because it's wasteful and produces
noise in logs. Clearing the column is one SQL update; the dead-endpoint retry
storm is per-reply.

### 5. `oc-auto-attach` spawn

Same fire-and-forget pattern as `launch-ingest.ts:59-77`. Best-effort, ENOENT
tolerant. On hosts without `oc-auto-attach` installed (e.g. cloudbox today —
see "Open question" below) this is a silent no-op.

This piece links revive-on-reply to the long-term tmux+nvim story: any time a
session is revived, the user gets a viewer in their editor for free.

## Degraded mode on the first revival reply

The reply that triggers revival travels via `OpencodeClient.sendPrompt`, not
the plugin. That delivery loses three plugin-mediated capabilities for that
single reply:

| Lost on revival reply | Why | When it heals |
|----------------------|-----|---------------|
| Model override | Plugin reads `metadata.model` and injects into the prompt body (`packages/opencode-plugin/src/index.ts:101-113`). `OpencodeClient.sendPrompt` doesn't. | Next reply (plugin re-registered). |
| Media attachments from the user | Plugin builds the `parts` array with file URLs (`index.ts:84-99`). `OpencodeClient.sendPrompt` only carries text. | Next reply. |
| Question-button taps | The `requestId` for an in-flight question lives in the dead plugin's memory. Tapping a button references a `requestId` that no current plugin knows about. | Cannot heal — the question is gone with the old plugin. A plain text reply to the question still goes through as a normal prompt, which is roughly what the user wants. |

This is an acceptable trade-off because:
1. The 90% reply is plain text without a model override.
2. The user already accepts that nightly resets reset state.
3. From the second reply onward, full feature parity is restored.
4. The previous behavior (silent vanish) was strictly worse.

The user opted not to send a "degraded mode" notification banner. The
degradation is invisible to the user unless they specifically try to use a
lost feature, in which case they'll see opencode-serve's natural response
(the prompt goes through, the model override is just absent).

## Worker-side considerations

No worker-side changes required. The worker's `messages` and `sessions` tables
are unchanged. The fix is entirely on the daemon side.

The worker's session reaper (`packages/daemon/src/session-reaper.ts:34-38`)
will continue to clean up sessions whose `last_seen` exceeds 7 days; replies
that revive a session naturally update its activity, which extends its life.
This means revive-on-reply implicitly extends the session lifetime — a
desirable side effect.

## Slash commands

Slash commands like `/kill`, `/compact`, `/mcp list`, `/model`, `/interrupt`
do NOT travel through `command-ingest.ts`. The worker's webhook dispatches
them as separate `command_type` values (`launch`, `kill`, `interrupt`,
`compact`, `mcp_list`, `mcp_enable`, `mcp_disable`, `model_list`,
`model_set`), and the daemon's `Poller` routes each to a dedicated ingest
module (`packages/daemon/src/worker/{kill,interrupt,compact,mcp,model}-ingest.ts`).

Each of those modules calls `opencodeClient.<method>()` directly against
opencode-serve — they never touch the plugin's `backendEndpoint`. So a
restart of opencode-serve doesn't break them, and they don't need any
revive-on-reply logic.

The only exception is `command-ingest.ts` itself, which handles
`commandType: "execute"` (plain text replies and question-button taps). That
is the only place where the fallback applies, and there are no slash commands
to filter out — every command reaching `command-ingest` is already either
plain text or a question option.

Question-button taps (`q0`, `q1`, `v3:q1`, …) are a special case inside
`command-ingest`: they are routed through `pendingQuestion` lookup before
reaching the failure branch. If the plugin is dead, the `pendingQuestion`
row may still exist in daemon storage (it has a 4h TTL independent of the
plugin), in which case the daemon will try `deliverQuestionReply` via the
direct adapter and hit the same ECONNREFUSED. The fallback for that case is
documented in "Degraded mode on the first revival reply" above (question
buttons can't be answered after plugin death because the `requestId` lives
in the dead plugin's memory). The simplest correct behavior is: if a question
reply hits ECONNREFUSED, send a Telegram message ("This question is no
longer answerable — the session was restarted. Send a new message to
continue.") and clear the pending question. That keeps the user un-stuck
without trying to recover something that fundamentally can't be recovered.

## Testing

### Unit tests

- `revive-and-deliver.test.ts`:
  - Session exists in opencode-serve → calls `sendPrompt` with recovered
    directory, clears `backendEndpoint`, returns success.
  - Session 404 in opencode-serve → returns "session gone" sentinel; caller
    handles deletion and Telegram reply.
  - `sendPrompt` throws → returns failure with error; caller handles Telegram
    reply.
  - `oc-auto-attach` spawn ENOENT → swallowed silently.

- `command-ingest.test.ts` (extend):
  - Connection error + plain text reply + session live in opencode-serve →
    revival path runs, session NOT deleted, command acked.
  - Connection error + slash command + session live in opencode-serve →
    Telegram reply sent ("session needs to be re-attached"), session
    deleted, command acked.
  - Connection error + session 404 in opencode-serve → existing delete
    behavior, plus new Telegram reply ("session no longer exists").

### Integration test

Reuse the existing daemon integration test harness. Spin up a fake plugin
that registers, kill it, send a reply, assert that:
1. Telegram receives no "session is asleep" error.
2. The fake opencode-serve receives a `prompt_async` for the right session.
3. The session row in daemon storage still exists after the reply.

### Manual verification on cloudbox

1. `/launch cloudbox workstation "say hello"` — confirm session starts.
2. `sudo systemctl restart opencode-serve.service` — kill the plugin.
3. Reply to the launch notification with "what was your last message?" — assert
   that opencode-serve answers in Telegram.
4. Reply again with "and now?" — assert that this second reply also works
   (proves late-discovery healed the endpoint).
5. Try `/model` on the same session before reply 1 above — assert the
   "needs to be re-attached" error message appears.

## Open question: oc-auto-attach on cloudbox

Spawning `oc-auto-attach` in the revival path only delivers value if it's
actually installed and functional. The user reports that `/launch` sessions on
cloudbox are NOT producing tmux+nvim windows today, which suggests
`oc-auto-attach` is not wired up correctly there (likely candidates: not in
the daemon's PATH, or `nvims` wrapper not in use, or `nvims` not installed,
or `OC_AUTO_ATTACH_BIN` env var not set on the daemon service unit).

A parallel investigation session has been launched
(`ses_2117b1bcfffe3ncW1Fj3QHZHZ7` in `~/projects/workstation`) to find the
root cause and propose a fix. **This design assumes that issue gets resolved
in parallel and `oc-auto-attach` works on cloudbox by the time this lands.**

If the investigation reveals `oc-auto-attach` cannot work on cloudbox for
fundamental reasons, the spawn step degrades to a no-op (existing
`launch-ingest.ts` already handles this gracefully) and revive-on-reply still
delivers its core value: replies don't disappear.

## Future work (not in this plan)

- **`/attach <sid>` Telegram command**: explicit "revive this session and open
  it in my editor." Same primitive as the `oc-auto-attach` spawn here. Useful
  for sessions the user wants to bring back without sending a real prompt.
- **Headless plugin host spawning**: if it ever turns out that we DO want to
  preserve model overrides / media on the very first revival reply, we could
  spawn a separate `opencode -s <sid> <dir>` process to host a fresh plugin
  for the session. Significantly more complex (process lifecycle, race with
  late-discovery, who owns the process). Not worth it given the self-healing
  property of the current design.
- **Devbox alignment**: devbox's nightly behavior currently restarts
  `pigeon-daemon.service` AND `opencode-serve.service`. The pigeon-daemon
  restart loses the daemon's in-memory state, but its SQLite state persists,
  so revive-on-reply will work the same way once it ships. No code changes
  needed for devbox parity.

## Implementation order

1. Add `OpencodeClient.getSession(sessionId)` (or share `SessionDirectoryRegistry`).
2. Add `clearBackendEndpoint(sessionId)` storage helper.
3. Build `revive-and-deliver.ts` with unit tests.
4. Hook into `command-ingest.ts` failure branch with the slash-command guard.
5. Integration test against a fake-plugin harness.
6. Manual verification on cloudbox after merge.
