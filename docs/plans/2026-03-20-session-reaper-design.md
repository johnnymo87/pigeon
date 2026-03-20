# Session Reaper for Stale Launched Sessions

## Problem

Sessions launched via `/launch` accumulate across three stores (worker D1, daemon SQLite, plugin memory) with no automatic cleanup:

- The daemon has a 24h TTL on session records and a `cleanupExpired()` method, but nothing calls it on a schedule.
- The worker has no session cleanup at all -- D1 sessions grow indefinitely (hard-capped at 1000).
- `/kill` terminates the Claude Code process but doesn't clean up session records from daemon SQLite or D1.
- `last_seen` is only updated on session creation and `/stop` notifications, making it unreliable as an idle indicator.

Sessions that finish their work and go idle sit around forever unless manually `/kill`'d.

## Decision

Daemon-side reaper (Approach A). The daemon owns the session lifecycle, has local access to Claude Code serve, and already has the SQLite-to-D1 unregister path. A single reaper in the daemon cascades cleanup through all three stores.

## Design

### 1. Fix activity tracking

Touch `last_seen` on every event that flows through the daemon, not just `/stop`:

- `POST /question-asked` -- already looks up the session, add a `touch()` call.
- `POST /stop` -- already touches (no change).
- `POST /session-start` -- already sets `last_seen` via `upsert()` (no change).

After this, any session generating notifications will have its `last_seen` refreshed. A session quiet for a week is genuinely idle.

### 2. Update SESSION_TTL_MS

Bump `SESSION_TTL_MS` in `packages/daemon/src/storage/schema.ts` from 24 hours to 1 week. This keeps `expires_at` consistent with the reap policy. The constant is used by `upsert()` (which sets `expires_at = now + TTL`) and by `cleanupExpired()`.

### 3. Session reaper

New module: `packages/daemon/src/session-reaper.ts`

```
startSessionReaper(deps): { stop(): void }
```

Dependencies: `storage`, `opencodeClient`, `poller`, `logger`, `nowFn`.

**Interval:** Every hour (aligned with existing outbox cleanup cadence).

**Logic per cycle:**

1. Query all sessions from daemon SQLite where `last_seen < now - 1 week`.
2. For each stale session:
   a. Attempt `DELETE /session/{id}` on Claude Code serve. Best-effort -- the process may already be gone. Swallow errors.
   b. Delete the session from daemon SQLite.
   c. Unregister from D1 via `poller.unregisterSession(sessionId)`.
   d. Log: `reaped stale session {id} (last seen {timestamp})`.
3. Run `storage.sessions.cleanupExpired(now)` to catch any records with blown TTLs.

**Error handling:** If Claude Code serve is unreachable, still clean up records. The session is stale either way. If serve comes back, the plugin will re-register any sessions that still exist via `lateDiscoverSession`.

**No Telegram notification** for reaped sessions -- silent housekeeping.

### 4. Wire into daemon startup

In `packages/daemon/src/index.ts`, start the reaper after the poller and outbox sender. Stop it on shutdown.

### 5. What we're NOT doing

- No worker-side cron changes (add later if orphaned D1 records become a problem).
- No `/sessions` Telegram command (separate feature).
- No changes to the plugin's in-memory eviction (handles its own state fine).
- No `/kill` changes (the reaper is the safety net for missed cleanups).
