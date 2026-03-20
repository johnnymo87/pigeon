# Session Reaper Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Auto-reap idle launched sessions after 1 week of inactivity, with cascading cleanup across daemon SQLite and worker D1.

**Architecture:** A periodic timer in the daemon queries stale sessions from SQLite, best-effort terminates them via Claude Code serve, deletes the SQLite records, and unregisters from D1 via the poller. Activity tracking is improved so `last_seen` reflects real session activity.

**Tech Stack:** TypeScript, better-sqlite3, vitest

---

### Task 1: Fix activity tracking — touch session on question-asked

The `/question-asked` handler looks up the session but never calls `touch()`. Add the touch call so that question events refresh `last_seen`.

**Files:**
- Modify: `packages/daemon/src/app.ts:272` (after session lookup in `/question-asked`)
- Test: `packages/daemon/test/app.test.ts`

**Step 1: Write the failing test**

Add to `packages/daemon/test/app.test.ts`:

```typescript
it("touches session last_seen on /question-asked", async () => {
  const now = 100_000;
  storage = openStorageDb(":memory:");
  const app = createApp(storage, {
    nowFn: () => now,
    chatId: "42",
    notifier: {
      sendStopNotification: vi.fn(async () => ({})),
      sendQuestionAsked: vi.fn(async () => ({ notificationId: "n-1" })),
    },
  });

  await app(new Request("http://localhost/session-start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "sess-q-touch", notify: true }),
  }));

  const sessionBefore = storage.sessions.get("sess-q-touch");

  const questionRes = await app(new Request("http://localhost/question-asked", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: "sess-q-touch",
      request_id: "req-1",
      questions: [{ type: "text", question: "Continue?", options: [] }],
    }),
  }));

  expect(questionRes.status).toBe(202);
  const sessionAfter = storage.sessions.get("sess-q-touch");
  expect(sessionAfter!.lastSeen).toBe(now);
  expect(sessionAfter!.lastSeen).toBeGreaterThanOrEqual(sessionBefore!.lastSeen);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- --run packages/daemon/test/app.test.ts`

The test should pass trivially since `nowFn` returns the same value for both upsert and the question call. Adjust the approach: use a mutable now.

Actually — since `upsert` and `touch` both use `nowFn()`, and we call them at different "times", use a counter:

```typescript
it("touches session last_seen on /question-asked", async () => {
  let now = 100_000;
  storage = openStorageDb(":memory:");
  const app = createApp(storage, {
    nowFn: () => now,
    chatId: "42",
  });

  await app(new Request("http://localhost/session-start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "sess-q-touch", notify: true }),
  }));

  const sessionBefore = storage.sessions.get("sess-q-touch");
  expect(sessionBefore!.lastSeen).toBe(100_000);

  now = 200_000;

  await app(new Request("http://localhost/question-asked", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: "sess-q-touch",
      request_id: "req-1",
      questions: [{ type: "text", question: "Continue?", options: [] }],
    }),
  }));

  const sessionAfter = storage.sessions.get("sess-q-touch");
  expect(sessionAfter!.lastSeen).toBe(200_000);
});
```

**Step 3: Run test to verify it fails**

Run: `npm run test -- --run packages/daemon/test/app.test.ts`

Expected: FAIL — `sessionAfter.lastSeen` is `100_000`, not `200_000`.

**Step 4: Implement the fix**

In `packages/daemon/src/app.ts`, after line 275 (`if (!session) { ... }`), add:

```typescript
storage.sessions.touch(sessionId, nowFn());
```

Place it right after the session lookup and before the `if (!session.notify)` check (around line 277).

**Step 5: Run test to verify it passes**

Run: `npm run test -- --run packages/daemon/test/app.test.ts`

Expected: PASS

**Step 6: Commit**

```
git add packages/daemon/src/app.ts packages/daemon/test/app.test.ts
git commit -m "fix: touch session last_seen on question-asked events"
```

---

### Task 2: Update SESSION_TTL_MS to 1 week

**Files:**
- Modify: `packages/daemon/src/storage/schema.ts:3`
- Test: `packages/daemon/test/storage.test.ts`

**Step 1: Update the existing storage test expectation**

The existing test at `packages/daemon/test/storage.test.ts:37` asserts cleanup at `2_000 + 24 * 60 * 60 * 1000 + 1`. Update it to use the new 1-week TTL:

```typescript
// Change this line:
expect(storage.sessions.cleanupExpired(2_000 + 24 * 60 * 60 * 1000 + 1)).toBe(1);
// To:
expect(storage.sessions.cleanupExpired(2_000 + 7 * 24 * 60 * 60 * 1000 + 1)).toBe(1);
```

Also verify the old 24h mark no longer expires:
```typescript
expect(storage.sessions.cleanupExpired(2_000 + 24 * 60 * 60 * 1000 + 1)).toBe(0);
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- --run packages/daemon/test/storage.test.ts`

Expected: FAIL — the 24h cleanup assertion returns 1 instead of 0.

**Step 3: Change the constant**

In `packages/daemon/src/storage/schema.ts`, change line 3:

```typescript
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
```

**Step 4: Run test to verify it passes**

Run: `npm run test -- --run packages/daemon/test/storage.test.ts`

Expected: PASS

**Step 5: Commit**

```
git add packages/daemon/src/storage/schema.ts packages/daemon/test/storage.test.ts
git commit -m "chore: bump session TTL from 24h to 1 week"
```

---

### Task 3: Add `listStale` method to SessionRepository

The reaper needs to query sessions older than the TTL. Add a dedicated method.

**Files:**
- Modify: `packages/daemon/src/storage/repos.ts` (add method to SessionRepository)
- Test: `packages/daemon/test/storage.test.ts`

**Step 1: Write the failing test**

Add to `packages/daemon/test/storage.test.ts`:

```typescript
it("lists stale sessions by last_seen cutoff", () => {
  const storage = createStorage();

  storage.sessions.upsert({ sessionId: "fresh", notify: true }, 10_000);
  storage.sessions.upsert({ sessionId: "stale", notify: true }, 1_000);

  const stale = storage.sessions.listStale(5_000);
  expect(stale).toHaveLength(1);
  expect(stale[0]?.sessionId).toBe("stale");

  const none = storage.sessions.listStale(500);
  expect(none).toHaveLength(0);

  storage.db.close();
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- --run packages/daemon/test/storage.test.ts`

Expected: FAIL — `listStale` is not a function.

**Step 3: Implement listStale**

In `packages/daemon/src/storage/repos.ts`, add to `SessionRepository` after the `list` method (around line 151):

```typescript
listStale(cutoff: number): SessionRecord[] {
  const rows = this.db
    .prepare("SELECT * FROM sessions WHERE last_seen < ?")
    .all(cutoff) as SqlRow[];
  return rows.map(asSession);
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test -- --run packages/daemon/test/storage.test.ts`

Expected: PASS

**Step 5: Commit**

```
git add packages/daemon/src/storage/repos.ts packages/daemon/test/storage.test.ts
git commit -m "feat: add listStale method to SessionRepository"
```

---

### Task 4: Implement session reaper module

**Files:**
- Create: `packages/daemon/src/session-reaper.ts`
- Test: `packages/daemon/test/session-reaper.test.ts`

**Step 1: Write the test file**

Create `packages/daemon/test/session-reaper.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { openStorageDb, type StorageDb } from "../src/storage/database";
import { startSessionReaper, reapStaleSessions } from "../src/session-reaper";
import { SESSION_TTL_MS } from "../src/storage/schema";

describe("reapStaleSessions", () => {
  let storage: StorageDb | null = null;

  afterEach(() => {
    if (storage) {
      storage.db.close();
      storage = null;
    }
  });

  it("deletes sessions older than the TTL and calls cleanup callbacks", async () => {
    storage = openStorageDb(":memory:");
    const now = SESSION_TTL_MS + 50_000;

    // Create a stale session (last_seen = 1000, well past TTL)
    storage.sessions.upsert({ sessionId: "stale-1", notify: true, label: "old" }, 1_000);
    // Create a fresh session (last_seen = now - 1000, within TTL)
    storage.sessions.upsert({ sessionId: "fresh-1", notify: true, label: "new" }, now - 1_000);

    const deleteSession = vi.fn(async () => {});
    const unregisterSession = vi.fn(async () => {});

    const result = await reapStaleSessions({
      storage,
      deleteSession,
      unregisterSession,
      nowFn: () => now,
    });

    expect(result.reaped).toBe(1);
    expect(deleteSession).toHaveBeenCalledWith("stale-1");
    expect(unregisterSession).toHaveBeenCalledWith("stale-1");
    expect(storage.sessions.get("stale-1")).toBeNull();
    expect(storage.sessions.get("fresh-1")).not.toBeNull();
  });

  it("still cleans up records when deleteSession fails", async () => {
    storage = openStorageDb(":memory:");
    const now = SESSION_TTL_MS + 50_000;

    storage.sessions.upsert({ sessionId: "stale-2", notify: true }, 1_000);

    const deleteSession = vi.fn(async () => { throw new Error("serve unreachable"); });
    const unregisterSession = vi.fn(async () => {});

    const result = await reapStaleSessions({
      storage,
      deleteSession,
      unregisterSession,
      nowFn: () => now,
    });

    expect(result.reaped).toBe(1);
    expect(storage.sessions.get("stale-2")).toBeNull();
    expect(unregisterSession).toHaveBeenCalledWith("stale-2");
  });

  it("still cleans up SQLite when unregisterSession fails", async () => {
    storage = openStorageDb(":memory:");
    const now = SESSION_TTL_MS + 50_000;

    storage.sessions.upsert({ sessionId: "stale-3", notify: true }, 1_000);

    const deleteSession = vi.fn(async () => {});
    const unregisterSession = vi.fn(async () => { throw new Error("worker down"); });

    const result = await reapStaleSessions({
      storage,
      deleteSession,
      unregisterSession,
      nowFn: () => now,
    });

    expect(result.reaped).toBe(1);
    expect(storage.sessions.get("stale-3")).toBeNull();
  });

  it("does nothing when no sessions are stale", async () => {
    storage = openStorageDb(":memory:");
    const now = 50_000;

    storage.sessions.upsert({ sessionId: "fresh-2", notify: true }, now - 1_000);

    const deleteSession = vi.fn();
    const unregisterSession = vi.fn();

    const result = await reapStaleSessions({
      storage,
      deleteSession,
      unregisterSession,
      nowFn: () => now,
    });

    expect(result.reaped).toBe(0);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(unregisterSession).not.toHaveBeenCalled();
  });

  it("also runs cleanupExpired to catch records with blown TTLs", async () => {
    storage = openStorageDb(":memory:");
    const now = SESSION_TTL_MS + 50_000;

    // Manually insert a session with a custom short expires_at
    // that wouldn't be caught by last_seen check but is expired
    storage.sessions.upsert({ sessionId: "expired-ttl", notify: true }, now - 1_000);
    // Force expires_at to be in the past by touching with a tiny TTL
    storage.sessions.touch("expired-ttl", 1_000, 1); // expires_at = 1001

    const deleteSession = vi.fn(async () => {});
    const unregisterSession = vi.fn(async () => {});

    const result = await reapStaleSessions({
      storage,
      deleteSession,
      unregisterSession,
      nowFn: () => now,
    });

    // The session should be cleaned up by cleanupExpired
    expect(storage.sessions.get("expired-ttl")).toBeNull();
  });
});

describe("startSessionReaper", () => {
  it("returns a stop function that clears the interval", () => {
    const storage = openStorageDb(":memory:");
    const reaper = startSessionReaper({
      storage,
      deleteSession: async () => {},
      unregisterSession: async () => {},
      intervalMs: 60_000,
    });

    expect(typeof reaper.stop).toBe("function");
    reaper.stop();
    storage.db.close();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- --run packages/daemon/test/session-reaper.test.ts`

Expected: FAIL — module not found.

**Step 3: Implement the reaper**

Create `packages/daemon/src/session-reaper.ts`:

```typescript
import type { StorageDb } from "./storage/database";
import { SESSION_TTL_MS } from "./storage/schema";

interface ReapDeps {
  storage: StorageDb;
  deleteSession: (sessionId: string) => Promise<void>;
  unregisterSession: (sessionId: string) => Promise<void>;
  nowFn?: () => number;
  log?: (msg: string) => void;
}

interface ReapResult {
  reaped: number;
  expired: number;
}

export async function reapStaleSessions(deps: ReapDeps): Promise<ReapResult> {
  const now = (deps.nowFn ?? Date.now)();
  const log = deps.log ?? ((msg: string) => console.log(`[reaper] ${msg}`));
  const cutoff = now - SESSION_TTL_MS;

  const stale = deps.storage.sessions.listStale(cutoff);

  let reaped = 0;
  for (const session of stale) {
    try {
      await deps.deleteSession(session.sessionId);
    } catch {
      // Best-effort — session may already be gone
    }

    deps.storage.sessions.delete(session.sessionId);

    try {
      await deps.unregisterSession(session.sessionId);
    } catch {
      // Best-effort — worker may be unreachable
    }

    log(`reaped stale session ${session.sessionId} (last seen ${new Date(session.lastSeen).toISOString()})`);
    reaped++;
  }

  const expired = deps.storage.sessions.cleanupExpired(now);
  if (expired > 0) {
    log(`cleaned ${expired} expired session records`);
  }

  return { reaped, expired };
}

interface StartReaperDeps {
  storage: StorageDb;
  deleteSession: (sessionId: string) => Promise<void>;
  unregisterSession: (sessionId: string) => Promise<void>;
  nowFn?: () => number;
  log?: (msg: string) => void;
  intervalMs?: number;
}

export function startSessionReaper(deps: StartReaperDeps): { stop: () => void } {
  const intervalMs = deps.intervalMs ?? 60 * 60 * 1000; // 1 hour

  const timer = setInterval(async () => {
    try {
      await reapStaleSessions(deps);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[reaper] cycle error: ${msg}`);
    }
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test -- --run packages/daemon/test/session-reaper.test.ts`

Expected: PASS

**Step 5: Commit**

```
git add packages/daemon/src/session-reaper.ts packages/daemon/test/session-reaper.test.ts
git commit -m "feat: add session reaper module"
```

---

### Task 5: Wire reaper into daemon startup

**Files:**
- Modify: `packages/daemon/src/index.ts`

**Step 1: Add the import and start the reaper**

In `packages/daemon/src/index.ts`, add import at the top:

```typescript
import { startSessionReaper } from "./session-reaper";
```

After the outbox cleanup `setInterval` (after line 113), add:

```typescript
// Reap stale sessions every hour
if (opencodeClient && poller) {
  startSessionReaper({
    storage,
    deleteSession: (sessionId) => opencodeClient.deleteSession(sessionId),
    unregisterSession: (sessionId) => poller.unregisterSession(sessionId),
    log: (msg) => console.log(`[reaper] ${msg}`),
  });
}
```

**Step 2: Run the full test suite**

Run: `npm run test -- --run`

Expected: All tests PASS.

**Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: No errors.

**Step 4: Commit**

```
git add packages/daemon/src/index.ts
git commit -m "feat: wire session reaper into daemon startup"
```

---

### Task 6: Final verification

**Step 1: Run full test suite**

Run: `npm run test -- --run`

Expected: All tests PASS.

**Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: No type errors.

**Step 3: Verify the design doc is accurate**

Review `docs/plans/2026-03-20-session-reaper-design.md` — it should match what was implemented. No updates needed if the plan was followed exactly.
