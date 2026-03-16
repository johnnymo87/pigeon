# Question Notification Reliability Overhaul — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate all silent question drop points by promoting question delivery to a durable workflow with idempotent ownership transfer.

**Architecture:** Plugin enqueues questions in an in-memory retry queue that bypasses the circuit breaker. Daemon accepts durably (SQLite outbox), returns 202 immediately, then delivers to Telegram asynchronously via a background sender. Worker deduplicates by `notification_id` to prevent duplicate Telegram messages on daemon retry.

**Tech Stack:** TypeScript, Vitest, better-sqlite3 (daemon), D1 (worker), Bun (plugin runtime)

**Design doc:** `docs/plans/2026-03-15-question-notification-reliability-design.md`

---

## Task 1: Plugin — Question Retry Queue Module

**Files:**
- Create: `packages/opencode-plugin/src/question-queue.ts`
- Test: `packages/opencode-plugin/test/question-queue.test.ts`

This is a self-contained in-memory retry queue for question delivery. No dependencies on daemon-client or circuit breaker.

**Step 1: Write the failing tests**

Create `packages/opencode-plugin/test/question-queue.test.ts`:

```typescript
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest"
import { QuestionDeliveryQueue, type QuestionEntry } from "../src/question-queue"

function makeEntry(overrides: Partial<QuestionEntry> = {}): QuestionEntry {
  return {
    sessionId: "sess-1",
    requestId: "req-1",
    questions: [{ question: "Pick one", header: "Choice", options: [{ label: "A", description: "Option A" }] }],
    label: "test",
    ...overrides,
  }
}

describe("QuestionDeliveryQueue", () => {
  let queue: QuestionDeliveryQueue

  beforeEach(() => {
    vi.useFakeTimers()
    queue = new QuestionDeliveryQueue()
  })

  afterEach(() => {
    queue.stop()
    vi.useRealTimers()
  })

  test("enqueue adds entry and dedup by sessionId+requestId", () => {
    queue.enqueue(makeEntry())
    queue.enqueue(makeEntry())  // duplicate
    expect(queue.size()).toBe(1)
  })

  test("enqueue evicts oldest when at capacity", () => {
    for (let i = 0; i < 20; i++) {
      queue.enqueue(makeEntry({ requestId: `req-${i}` }))
    }
    expect(queue.size()).toBe(20)
    queue.enqueue(makeEntry({ requestId: "req-overflow" }))
    expect(queue.size()).toBe(20)
    // oldest (req-0) should be evicted
    expect(queue.has("sess-1", "req-0")).toBe(false)
    expect(queue.has("sess-1", "req-overflow")).toBe(true)
  })

  test("successful delivery removes entry", async () => {
    const sender = vi.fn().mockResolvedValue({ ok: true, deliveryState: "accepted" })
    queue.start(sender)
    queue.enqueue(makeEntry())
    await vi.advanceTimersByTimeAsync(600) // first retry at ~500ms
    expect(sender).toHaveBeenCalledTimes(1)
    expect(queue.size()).toBe(0)
  })

  test("failed delivery retries with backoff", async () => {
    const sender = vi.fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({ ok: true, deliveryState: "accepted" })
    queue.start(sender)
    queue.enqueue(makeEntry())
    await vi.advanceTimersByTimeAsync(600)   // first attempt
    expect(sender).toHaveBeenCalledTimes(1)
    expect(queue.size()).toBe(1)
    await vi.advanceTimersByTimeAsync(1100)  // second attempt (~1s backoff)
    expect(sender).toHaveBeenCalledTimes(2)
    expect(queue.size()).toBe(0)
  })

  test("entry expires after max retry window", async () => {
    const sender = vi.fn().mockRejectedValue(new Error("always fails"))
    const onExpired = vi.fn()
    queue = new QuestionDeliveryQueue({ maxRetryMs: 5000, onExpired })
    queue.start(sender)
    queue.enqueue(makeEntry())
    // Advance past max retry window
    await vi.advanceTimersByTimeAsync(10_000)
    expect(queue.size()).toBe(0)
    expect(onExpired).toHaveBeenCalledWith("sess-1", "req-1")
  })

  test("treats notified:false (old daemon) as failure", async () => {
    const sender = vi.fn()
      .mockResolvedValueOnce({ ok: true, notified: false })
      .mockResolvedValueOnce({ ok: true, deliveryState: "accepted" })
    queue.start(sender)
    queue.enqueue(makeEntry())
    await vi.advanceTimersByTimeAsync(600)
    expect(queue.size()).toBe(1) // still in queue, treated as failure
    await vi.advanceTimersByTimeAsync(1100)
    expect(queue.size()).toBe(0) // second attempt succeeded
  })

  test("stop() halts delivery loop", async () => {
    const sender = vi.fn().mockResolvedValue({ ok: true, deliveryState: "accepted" })
    queue.start(sender)
    queue.enqueue(makeEntry())
    queue.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(sender).not.toHaveBeenCalled()
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npm run --workspace @pigeon/opencode-plugin test -- --run question-queue`
Expected: FAIL — module not found

**Step 3: Implement QuestionDeliveryQueue**

Create `packages/opencode-plugin/src/question-queue.ts`:

```typescript
type LogFn = (message: string, data?: unknown) => void

export type QuestionEntry = {
  sessionId: string
  requestId: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiple?: boolean
    custom?: boolean
  }>
  label: string
}

type QueueItem = QuestionEntry & {
  enqueuedAt: number
  attempts: number
  nextRetryAt: number
}

type DaemonResponse = { ok: boolean; deliveryState?: string; notified?: boolean } | null
type Sender = (entry: QuestionEntry) => Promise<DaemonResponse>

const BACKOFF_SCHEDULE = [500, 1000, 2000, 4000, 8000, 15000, 30000]
const DEFAULT_MAX_RETRY_MS = 120_000 // 2 minutes
const MAX_QUEUE_SIZE = 20
const TICK_INTERVAL = 500

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * ms * 0.5)
}

function dedupKey(sessionId: string, requestId: string): string {
  return `${sessionId}::${requestId}`
}

export type QuestionQueueOptions = {
  maxRetryMs?: number
  onExpired?: (sessionId: string, requestId: string) => void
  log?: LogFn
}

export class QuestionDeliveryQueue {
  private items = new Map<string, QueueItem>()
  private timer: ReturnType<typeof setInterval> | null = null
  private sender: Sender | null = null
  private readonly maxRetryMs: number
  private readonly onExpired?: (sessionId: string, requestId: string) => void
  private readonly log: LogFn

  constructor(opts: QuestionQueueOptions = {}) {
    this.maxRetryMs = opts.maxRetryMs ?? DEFAULT_MAX_RETRY_MS
    this.onExpired = opts.onExpired
    this.log = opts.log ?? (() => {})
  }

  enqueue(entry: QuestionEntry): void {
    const key = dedupKey(entry.sessionId, entry.requestId)
    if (this.items.has(key)) return // dedup

    // evict oldest if at capacity
    if (this.items.size >= MAX_QUEUE_SIZE) {
      const oldestKey = this.items.keys().next().value!
      this.items.delete(oldestKey)
    }

    const now = Date.now()
    this.items.set(key, {
      ...entry,
      enqueuedAt: now,
      attempts: 0,
      nextRetryAt: now, // try immediately on next tick
    })
    this.log("question enqueued", { sessionId: entry.sessionId, requestId: entry.requestId, queueSize: this.items.size })
  }

  start(sender: Sender): void {
    this.sender = sender
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.sender = null
  }

  size(): number {
    return this.items.size
  }

  has(sessionId: string, requestId: string): boolean {
    return this.items.has(dedupKey(sessionId, requestId))
  }

  private async tick(): Promise<void> {
    if (!this.sender) return
    const now = Date.now()

    for (const [key, item] of this.items) {
      // Expired?
      if (now - item.enqueuedAt > this.maxRetryMs) {
        this.items.delete(key)
        this.log("question retry exhausted", { sessionId: item.sessionId, requestId: item.requestId, attempts: item.attempts })
        this.onExpired?.(item.sessionId, item.requestId)
        continue
      }

      // Not yet ready for retry?
      if (now < item.nextRetryAt) continue

      // Attempt delivery
      item.attempts++
      try {
        const result = await this.sender({
          sessionId: item.sessionId,
          requestId: item.requestId,
          questions: item.questions,
          label: item.label,
        })

        // Determine success: new daemon returns deliveryState, old returns notified
        const isSuccess = result != null && (
          result.deliveryState === "accepted" ||
          result.deliveryState === "sent" ||
          result.deliveryState === "queued" ||
          (result.deliveryState === undefined && result.notified === true)
        )

        if (isSuccess) {
          this.items.delete(key)
          this.log("question delivered", { sessionId: item.sessionId, requestId: item.requestId, deliveryState: result?.deliveryState, attempts: item.attempts })
        } else {
          // Treat as failure — schedule retry
          const backoffIdx = Math.min(item.attempts - 1, BACKOFF_SCHEDULE.length - 1)
          item.nextRetryAt = now + jitter(BACKOFF_SCHEDULE[backoffIdx])
          this.log("question delivery failed, will retry", { sessionId: item.sessionId, requestId: item.requestId, attempt: item.attempts, nextRetryMs: item.nextRetryAt - now })
        }
      } catch {
        const backoffIdx = Math.min(item.attempts - 1, BACKOFF_SCHEDULE.length - 1)
        item.nextRetryAt = now + jitter(BACKOFF_SCHEDULE[backoffIdx])
        this.log("question delivery error, will retry", { sessionId: item.sessionId, requestId: item.requestId, attempt: item.attempts, nextRetryMs: item.nextRetryAt - now })
      }
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npm run --workspace @pigeon/opencode-plugin test -- --run question-queue`
Expected: PASS (all 6 tests)

**Step 5: Commit**

```bash
git add packages/opencode-plugin/src/question-queue.ts packages/opencode-plugin/test/question-queue.test.ts
git commit -m "feat(plugin): add question delivery retry queue"
```

---

## Task 2: Plugin — Bypass Circuit Breaker for Questions

**Files:**
- Modify: `packages/opencode-plugin/src/daemon-client.ts`
- Modify: `packages/opencode-plugin/test/daemon-client.test.ts`

Extract the HTTP call from `notifyQuestionAsked` into a new function `sendQuestionAsked` that does NOT use the circuit breaker. The retry queue calls this directly.

**Step 1: Write failing tests**

Add to `packages/opencode-plugin/test/daemon-client.test.ts`:

```typescript
describe("sendQuestionAsked (no circuit breaker)", () => {
  test("sends question even when breaker is open", async () => {
    // Trip the breaker first
    await notifyStop({
      sessionId: "sess-1",
      message: "summary",
      label: "test",
      daemonUrl: `http://127.0.0.1:1`, // connection refused
      log: mockLog,
    })

    // sendQuestionAsked should still work (bypasses breaker)
    const result = await sendQuestionAsked({
      sessionId: "sess-1",
      requestId: "req-1",
      questions: [{ question: "Pick", header: "H", options: [] }],
      label: "test",
      daemonUrl: `http://127.0.0.1:${serverPort}`,
      log: mockLog,
    })

    expect(result).toBeTruthy()
    expect(result!.ok).toBe(true)
  })

  test("uses 3s timeout instead of 1s", async () => {
    // Create a slow server
    const slowServer = await createTestServer(async () => {
      await sleep(2000)
      return Response.json({ ok: true, deliveryState: "accepted" })
    })

    try {
      const result = await sendQuestionAsked({
        sessionId: "sess-1",
        requestId: "req-1",
        questions: [{ question: "Pick", header: "H", options: [] }],
        label: "test",
        daemonUrl: `http://127.0.0.1:${slowServer.port}`,
        log: mockLog,
      })
      expect(result).toBeTruthy()
      expect(result!.ok).toBe(true)
    } finally {
      slowServer.close()
    }
  })

  test("does not affect breaker state on failure", async () => {
    _resetBreakerForTesting()

    // This should fail but NOT open the breaker
    await sendQuestionAsked({
      sessionId: "sess-1",
      requestId: "req-1",
      questions: [{ question: "Pick", header: "H", options: [] }],
      label: "test",
      daemonUrl: `http://127.0.0.1:1`,
      log: mockLog,
    }).catch(() => {})

    // Breaker should still be closed — notifyStop should work
    const result = await notifyStop({
      sessionId: "sess-1",
      message: "summary",
      label: "test",
      daemonUrl: `http://127.0.0.1:${serverPort}`,
      log: mockLog,
    })
    expect(result).toBeTruthy()
    expect(result!.ok).toBe(true)
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npm run --workspace @pigeon/opencode-plugin test -- --run daemon-client`
Expected: FAIL — `sendQuestionAsked` is not exported

**Step 3: Add `sendQuestionAsked` to daemon-client.ts**

Add after the existing `notifyQuestionAsked` function (around line 210):

```typescript
/**
 * Send a question notification to the daemon WITHOUT using the circuit breaker.
 * Used by the retry queue — questions are too important to suppress.
 * Returns the daemon response or throws on network/timeout errors.
 */
export async function sendQuestionAsked(opts: NotifyQuestionAskedOpts): Promise<DaemonResult> {
  const url = getDaemonUrl(opts.daemonUrl)

  const res = await fetch(`${url}/question-asked`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: opts.sessionId,
      request_id: opts.requestId,
      questions: opts.questions,
      label: opts.label,
    }),
    signal: AbortSignal.timeout(3000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    opts.log("daemon returned error for question-asked (direct)", { status: res.status, body: text })
    throw new Error(`daemon error: ${res.status}`)
  }

  const data = (await res.json()) as { ok: boolean; deliveryState?: string; notified?: boolean }
  return data
}
```

Update the import in test file to include `sendQuestionAsked`.

**Step 4: Run tests to verify they pass**

Run: `npm run --workspace @pigeon/opencode-plugin test -- --run daemon-client`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/opencode-plugin/src/daemon-client.ts packages/opencode-plugin/test/daemon-client.test.ts
git commit -m "feat(plugin): add sendQuestionAsked that bypasses circuit breaker"
```

---

## Task 3: Plugin — Wire Retry Queue into Event Handler

**Files:**
- Modify: `packages/opencode-plugin/src/index.ts`

Replace the fire-and-forget `notifyQuestionAsked` call with queue-based delivery. Decouple the stop flush.

**Step 1: Update index.ts imports and initialization**

At the top of the plugin function (around line 23-28), add:

```typescript
import { QuestionDeliveryQueue } from "./question-queue"
import { sendQuestionAsked } from "./daemon-client"
```

After `const sessionManager = new SessionManager()` (line 24), add:

```typescript
const questionQueue = new QuestionDeliveryQueue({
  log,
  onExpired: (sessionId, requestId) => {
    log("WARN: question delivery permanently failed", { sessionId, requestId })
  },
})
questionQueue.start((entry) =>
  sendQuestionAsked({
    sessionId: entry.sessionId,
    requestId: entry.requestId,
    questions: entry.questions,
    label: entry.label,
    daemonUrl,
    log,
  })
)
```

**Step 2: Replace the question.asked handler (lines 448-474)**

Replace the existing code block:

```typescript
// OLD (lines 445-474):
// Flush any unnotified assistant text as a stop notification before
// sending the question. Without this, text output in the same turn as
// a question tool call is never sent to Telegram (no session.idle fires).
const currentMsgId = messageTail.getCurrentMessageId(sessionID)
if (sessionManager.shouldNotify(sessionID, currentMsgId)) {
  sessionManager.setNotified(sessionID, currentMsgId!)
  const summary = messageTail.getSummary(sessionID)
  if (summary) {
    const files = messageTail.getFiles(sessionID)
    await notifyStop({
      sessionId: sessionID,
      message: summary,
      label,
      media: files.length > 0 ? files : undefined,
      daemonUrl,
      log,
    })
  }
}

notifyQuestionAsked({
  sessionId: sessionID,
  requestId,
  questions,
  label,
  daemonUrl,
  log,
}).catch((err) => {
  log("notifyQuestionAsked error:", serializeError(err))
})
```

With:

```typescript
// Enqueue question delivery FIRST — this bypasses the circuit breaker
// and retries automatically until the daemon accepts.
questionQueue.enqueue({
  sessionId: sessionID,
  requestId,
  questions,
  label,
})

// Flush any unnotified assistant text as a stop notification.
// Fire-and-forget: stop flush failure must NOT block question delivery.
const currentMsgId = messageTail.getCurrentMessageId(sessionID)
if (sessionManager.shouldNotify(sessionID, currentMsgId)) {
  sessionManager.setNotified(sessionID, currentMsgId!)
  const summary = messageTail.getSummary(sessionID)
  if (summary) {
    const files = messageTail.getFiles(sessionID)
    notifyStop({
      sessionId: sessionID,
      message: summary,
      label,
      media: files.length > 0 ? files : undefined,
      daemonUrl,
      log,
    }).catch((err) => {
      log("stop flush before question failed (non-blocking):", serializeError(err))
    })
  }
}
```

**Step 3: Run all plugin tests**

Run: `npm run --workspace @pigeon/opencode-plugin test -- --run`
Expected: PASS

**Step 4: Run plugin typecheck**

Run: `npm run --workspace @pigeon/opencode-plugin typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/opencode-plugin/src/index.ts
git commit -m "feat(plugin): wire question retry queue, decouple stop flush from question path"
```

---

## Task 4: Daemon — Add Outbox Table and Repository

**Files:**
- Modify: `packages/daemon/src/storage/schema.ts`
- Create: `packages/daemon/src/storage/outbox-repo.ts`
- Modify: `packages/daemon/src/storage/database.ts`
- Modify: `packages/daemon/test/storage.test.ts`

**Step 1: Write failing tests**

Add to `packages/daemon/test/storage.test.ts` (or create a new `packages/daemon/test/outbox-repo.test.ts` depending on existing structure — check the existing test file first):

Create `packages/daemon/test/outbox-repo.test.ts`:

```typescript
import { describe, expect, it } from "vitest"
import { openStorageDb } from "../src/storage/database"
import type { StorageDb } from "../src/storage/database"

describe("OutboxRepository", () => {
  let storage: StorageDb

  function freshDb() {
    storage = openStorageDb(":memory:")
    return storage
  }

  it("stores and retrieves an outbox entry", () => {
    const db = freshDb()
    db.outbox.upsert({
      notificationId: "notif-1",
      sessionId: "sess-1",
      requestId: "req-1",
      kind: "question",
      payload: JSON.stringify({ text: "test" }),
      token: "tok-1",
    }, 1000)

    const entries = db.outbox.getReady(2000, 5)
    expect(entries).toHaveLength(1)
    expect(entries[0].notificationId).toBe("notif-1")
    expect(entries[0].state).toBe("queued")
  })

  it("upserts idempotently on same notificationId", () => {
    const db = freshDb()
    db.outbox.upsert({
      notificationId: "notif-1",
      sessionId: "sess-1",
      requestId: "req-1",
      kind: "question",
      payload: JSON.stringify({ text: "v1" }),
      token: "tok-1",
    }, 1000)

    db.outbox.upsert({
      notificationId: "notif-1",
      sessionId: "sess-1",
      requestId: "req-1",
      kind: "question",
      payload: JSON.stringify({ text: "v2" }),
      token: "tok-1",
    }, 2000)

    const entries = db.outbox.getReady(3000, 5)
    expect(entries).toHaveLength(1)
  })

  it("marks sent on success", () => {
    const db = freshDb()
    db.outbox.upsert({
      notificationId: "notif-1",
      sessionId: "sess-1",
      requestId: "req-1",
      kind: "question",
      payload: "{}",
      token: "tok-1",
    }, 1000)

    db.outbox.markSent("notif-1", 2000)
    const entries = db.outbox.getReady(3000, 5)
    expect(entries).toHaveLength(0)

    const entry = db.outbox.getByNotificationId("notif-1")
    expect(entry!.state).toBe("sent")
  })

  it("schedules retry with backoff on failure", () => {
    const db = freshDb()
    db.outbox.upsert({
      notificationId: "notif-1",
      sessionId: "sess-1",
      requestId: "req-1",
      kind: "question",
      payload: "{}",
      token: "tok-1",
    }, 1000)

    db.outbox.markRetry("notif-1", 2000, 5000) // next retry at 7000
    const notReady = db.outbox.getReady(3000, 5) // too early
    expect(notReady).toHaveLength(0)

    const ready = db.outbox.getReady(8000, 5)    // past retry time
    expect(ready).toHaveLength(1)
    expect(ready[0].attempts).toBe(1)
  })

  it("marks terminal failure", () => {
    const db = freshDb()
    db.outbox.upsert({
      notificationId: "notif-1",
      sessionId: "sess-1",
      requestId: "req-1",
      kind: "question",
      payload: "{}",
      token: "tok-1",
    }, 1000)

    db.outbox.markFailed("notif-1", 2000)
    const entries = db.outbox.getReady(3000, 5)
    expect(entries).toHaveLength(0)

    const entry = db.outbox.getByNotificationId("notif-1")
    expect(entry!.state).toBe("failed")
  })

  it("resets failed entries to queued on re-upsert", () => {
    const db = freshDb()
    db.outbox.upsert({
      notificationId: "notif-1",
      sessionId: "sess-1",
      requestId: "req-1",
      kind: "question",
      payload: "{}",
      token: "tok-1",
    }, 1000)
    db.outbox.markFailed("notif-1", 2000)

    // Plugin retries — upsert resets to queued
    db.outbox.upsert({
      notificationId: "notif-1",
      sessionId: "sess-1",
      requestId: "req-1",
      kind: "question",
      payload: "{}",
      token: "tok-1",
    }, 3000)

    const entry = db.outbox.getByNotificationId("notif-1")
    expect(entry!.state).toBe("queued")
  })

  it("cleans up old terminal entries", () => {
    const db = freshDb()
    db.outbox.upsert({
      notificationId: "notif-1",
      sessionId: "sess-1",
      requestId: "req-1",
      kind: "question",
      payload: "{}",
      token: "tok-1",
    }, 1000)
    db.outbox.markSent("notif-1", 2000)

    const cleaned = db.outbox.cleanupOlderThan(2000 + 3600_001) // >1h after update
    expect(cleaned).toBe(1)
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npm run --workspace @pigeon/daemon test -- --run outbox-repo`
Expected: FAIL — module not found

**Step 3: Add outbox table to schema.ts**

In `packages/daemon/src/storage/schema.ts`, add after the `pending_questions` CREATE TABLE (line 79):

```sql
CREATE TABLE IF NOT EXISTS outbox (
  notification_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'question',
  state TEXT NOT NULL DEFAULT 'queued',
  payload TEXT NOT NULL,
  token TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_retry
  ON outbox(state, next_retry_at);
```

Also add the constant:

```typescript
export const OUTBOX_RETENTION_MS = 60 * 60 * 1000; // 1 hour
```

**Step 4: Create outbox repository**

Create `packages/daemon/src/storage/outbox-repo.ts`:

```typescript
import type BetterSqlite3 from "better-sqlite3";

type SqlRow = Record<string, unknown>;

export interface OutboxRecord {
  notificationId: string;
  sessionId: string;
  requestId: string;
  kind: string;
  state: string;
  payload: string;
  token: string;
  attempts: number;
  nextRetryAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertOutboxInput {
  notificationId: string;
  sessionId: string;
  requestId: string;
  kind: string;
  payload: string;
  token: string;
}

function asOutboxRecord(row: SqlRow): OutboxRecord {
  return {
    notificationId: String(row.notification_id),
    sessionId: String(row.session_id),
    requestId: String(row.request_id),
    kind: String(row.kind),
    state: String(row.state),
    payload: String(row.payload),
    token: String(row.token),
    attempts: Number(row.attempts),
    nextRetryAt: row.next_retry_at != null ? Number(row.next_retry_at) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class OutboxRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  upsert(input: UpsertOutboxInput, now = Date.now()): void {
    // If the entry already exists and is in a terminal failure state, reset to queued.
    // If it's already sent or queued, leave it alone (idempotent).
    const existing = this.getByNotificationId(input.notificationId);
    if (existing) {
      if (existing.state === "failed") {
        this.db
          .prepare(
            `UPDATE outbox SET state = 'queued', attempts = 0, next_retry_at = NULL, updated_at = ? WHERE notification_id = ?`
          )
          .run(now, input.notificationId);
      }
      // For 'queued', 'sending', 'sent' — no-op (idempotent)
      return;
    }

    this.db
      .prepare(
        `INSERT INTO outbox (notification_id, session_id, request_id, kind, state, payload, token, attempts, next_retry_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, NULL, ?, ?)`
      )
      .run(
        input.notificationId,
        input.sessionId,
        input.requestId,
        input.kind,
        input.payload,
        input.token,
        now,
        now,
      );
  }

  getByNotificationId(notificationId: string): OutboxRecord | null {
    const row = this.db
      .prepare("SELECT * FROM outbox WHERE notification_id = ?")
      .get(notificationId) as SqlRow | null;
    return row ? asOutboxRecord(row) : null;
  }

  getReady(now: number, limit: number): OutboxRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox
         WHERE state = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY created_at
         LIMIT ?`
      )
      .all(now, limit) as SqlRow[];
    return rows.map(asOutboxRecord);
  }

  markSent(notificationId: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE outbox SET state = 'sent', next_retry_at = NULL, updated_at = ? WHERE notification_id = ?`
      )
      .run(now, notificationId);
  }

  markRetry(notificationId: string, now: number, backoffMs: number): void {
    this.db
      .prepare(
        `UPDATE outbox SET state = 'queued', attempts = attempts + 1, next_retry_at = ?, updated_at = ? WHERE notification_id = ?`
      )
      .run(now + backoffMs, now, notificationId);
  }

  markFailed(notificationId: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE outbox SET state = 'failed', next_retry_at = NULL, updated_at = ? WHERE notification_id = ?`
      )
      .run(now, notificationId);
  }

  cleanupOlderThan(cutoff: number): number {
    const result = this.db
      .prepare(
        "DELETE FROM outbox WHERE state IN ('sent', 'failed') AND updated_at < ?"
      )
      .run(cutoff);
    return result.changes;
  }
}
```

**Step 5: Wire into StorageDb**

In `packages/daemon/src/storage/database.ts`, add:

```typescript
import { OutboxRepository } from "./outbox-repo";
```

Add to `StorageDb` interface:
```typescript
outbox: OutboxRepository;
```

Add to `openStorageDb` return object:
```typescript
outbox: new OutboxRepository(db),
```

**Step 6: Run tests**

Run: `npm run --workspace @pigeon/daemon test -- --run outbox-repo`
Expected: PASS

**Step 7: Run typecheck**

Run: `npm run --workspace @pigeon/daemon typecheck`
Expected: PASS

**Step 8: Commit**

```bash
git add packages/daemon/src/storage/schema.ts packages/daemon/src/storage/outbox-repo.ts packages/daemon/src/storage/database.ts packages/daemon/test/outbox-repo.test.ts
git commit -m "feat(daemon): add outbox table and repository for durable question delivery"
```

---

## Task 5: Daemon — Refactor `/question-asked` to Durable Accept

**Files:**
- Modify: `packages/daemon/src/app.ts`
- Modify: `packages/daemon/src/notification-service.ts`
- Modify: `packages/daemon/test/app.test.ts`

Change `/question-asked` to store question + outbox row in a transaction and return 202 immediately.

**Step 1: Write / update failing tests**

In `packages/daemon/test/app.test.ts`, update the existing question test (line 317) and add new ones:

```typescript
it("POST /question-asked durably accepts and returns 202", async () => {
  storage = openStorageDb(":memory:");
  const app = createApp(storage, { nowFn: () => 50_000 });

  // Register a session first
  await app(new Request("http://localhost/session-start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: "sess-q",
      pid: 1,
      ppid: 1,
      cwd: "/tmp",
      label: "test",
      notify: true,
    }),
  }));

  const response = await app(new Request("http://localhost/question-asked", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: "sess-q",
      request_id: "req-abc",
      questions: [{ question: "Which DB?", header: "Database", options: [{ label: "SQLite", description: "Embedded" }] }],
      label: "test",
    }),
  }));

  expect(response.status).toBe(202);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.deliveryState).toBe("accepted");

  // Verify outbox row was created
  const outboxEntry = storage.outbox.getByNotificationId(body.notificationId);
  expect(outboxEntry).toBeTruthy();
  expect(outboxEntry!.state).toBe("queued");

  // Verify pending question was stored
  const pending = storage.pendingQuestions.getBySessionId("sess-q", 50_000);
  expect(pending).toBeTruthy();
  expect(pending!.requestId).toBe("req-abc");
});

it("POST /question-asked is idempotent for same session+request", async () => {
  storage = openStorageDb(":memory:");
  const app = createApp(storage, { nowFn: () => 50_000 });

  await app(new Request("http://localhost/session-start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "sess-q", pid: 1, ppid: 1, cwd: "/tmp", label: "test", notify: true }),
  }));

  const body1 = JSON.stringify({
    session_id: "sess-q", request_id: "req-dup",
    questions: [{ question: "?", header: "H", options: [] }], label: "test",
  });

  const r1 = await app(new Request("http://localhost/question-asked", { method: "POST", headers: { "Content-Type": "application/json" }, body: body1 }));
  const r2 = await app(new Request("http://localhost/question-asked", { method: "POST", headers: { "Content-Type": "application/json" }, body: body1 }));

  expect(r1.status).toBe(202);
  expect(r2.status).toBe(202);

  // Only one outbox entry
  const entries = storage.outbox.getReady(100_000, 10);
  expect(entries).toHaveLength(1);
});

it("POST /question-asked returns 503 when session has notify=false", async () => {
  storage = openStorageDb(":memory:");
  const app = createApp(storage, { nowFn: () => 50_000 });

  await app(new Request("http://localhost/session-start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "sess-q", pid: 1, ppid: 1, cwd: "/tmp", label: "test", notify: false }),
  }));

  const response = await app(new Request("http://localhost/question-asked", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: "sess-q", request_id: "req-1",
      questions: [{ question: "?", header: "H", options: [] }], label: "test",
    }),
  }));

  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.deliveryState).toBeUndefined();
  expect(body.notified).toBe(false);
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run --workspace @pigeon/daemon test -- --run app`
Expected: FAIL — response is 200 not 202, no `deliveryState`

**Step 3: Refactor `/question-asked` in app.ts**

Replace the `/question-asked` handler (lines 251-300 of `packages/daemon/src/app.ts`):

```typescript
if (request.method === "POST" && url.pathname === "/question-asked") {
  const body = await readJsonBody(request);
  const sessionId = typeof body.session_id === "string" ? body.session_id : "";
  if (!sessionId) {
    return Response.json({ error: "session_id is required" }, { status: 400 });
  }

  const requestId = typeof body.request_id === "string" ? body.request_id : "";
  if (!requestId) {
    return Response.json({ error: "request_id is required" }, { status: 400 });
  }

  const questions = body.questions as QuestionInfoData[] | undefined;
  if (!Array.isArray(questions) || questions.length === 0) {
    return Response.json({ error: "questions array is required" }, { status: 400 });
  }

  const session = storage.sessions.get(sessionId);
  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  if (!session.notify) {
    return Response.json({ ok: true, notified: false, reason: "notify=false" });
  }

  const label = typeof body.label === "string" ? body.label : null;
  const now = opts.nowFn?.() ?? Date.now();

  // Generate stable notification ID for idempotency
  const notificationId = `q:${sessionId}:${requestId}`;

  // Check if already in outbox
  const existing = storage.outbox.getByNotificationId(notificationId);
  if (existing) {
    return Response.json(
      { ok: true, deliveryState: existing.state === "sent" ? "sent" : "queued", notificationId },
      { status: existing.state === "sent" ? 200 : 202 },
    );
  }

  // Generate token for Telegram inline buttons
  const token = generateToken();

  // Store pending question
  storage.pendingQuestions.store({
    sessionId,
    requestId,
    questions,
    token,
  }, now);

  // Mint session token
  storage.sessionTokens.mint({
    token,
    sessionId,
    chatId: opts.chatId ?? "",
    context: { type: "question", questionRequestId: requestId },
  }, now);

  // Format the notification payload for the outbox
  const notification = formatQuestionNotification({
    label: label || session.label || sessionId.slice(0, 8),
    questions,
    cwd: session.cwd || undefined,
    token,
    machineId: opts.machineId,
    sessionId,
  });

  // Store in outbox — background sender will deliver to Telegram
  storage.outbox.upsert({
    notificationId,
    sessionId,
    requestId,
    kind: "question",
    payload: JSON.stringify({
      text: notification.text,
      replyMarkup: notification.replyMarkup,
      notificationId,
    }),
    token,
  }, now);

  return Response.json(
    { ok: true, deliveryState: "accepted", notificationId },
    { status: 202 },
  );
}
```

Note: this requires importing `generateToken` and `formatQuestionNotification` into `app.ts`. Check if they're already imported or need to be added.

**Step 4: Add needed imports to app.ts**

Add at the top of `app.ts`:

```typescript
import { generateToken, formatQuestionNotification } from "./notification-service";
```

Ensure `generateToken` and `formatQuestionNotification` are exported from `notification-service.ts`.

**Step 5: Update `createApp` options interface**

The `createApp` function needs `chatId` and `machineId` in its options so the route handler can mint tokens and format notifications. Check the existing interface and add:

```typescript
chatId?: string;
machineId?: string;
```

**Step 6: Run tests**

Run: `npm run --workspace @pigeon/daemon test -- --run app`
Expected: PASS (update old question tests that expect 200 to expect 202)

**Step 7: Run typecheck**

Run: `npm run --workspace @pigeon/daemon typecheck`
Expected: PASS

**Step 8: Commit**

```bash
git add packages/daemon/src/app.ts packages/daemon/src/notification-service.ts packages/daemon/test/app.test.ts
git commit -m "feat(daemon): refactor /question-asked to durable accept with outbox"
```

---

## Task 6: Daemon — Background Outbox Sender

**Files:**
- Create: `packages/daemon/src/worker/outbox-sender.ts`
- Create: `packages/daemon/test/outbox-sender.test.ts`

A background loop that reads queued outbox entries and sends them to the worker.

**Step 1: Write failing tests**

Create `packages/daemon/test/outbox-sender.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest"
import { OutboxSender } from "../src/worker/outbox-sender"
import { openStorageDb, type StorageDb } from "../src/storage/database"

describe("OutboxSender", () => {
  let storage: StorageDb
  let mockSend: ReturnType<typeof vi.fn>

  beforeEach(() => {
    storage = openStorageDb(":memory:")
    mockSend = vi.fn()
  })

  function createSender(overrides = {}) {
    return new OutboxSender({
      storage,
      sendNotification: mockSend,
      nowFn: () => 10_000,
      ...overrides,
    })
  }

  it("sends queued entries and marks sent", async () => {
    storage.outbox.upsert({
      notificationId: "notif-1",
      sessionId: "sess-1",
      requestId: "req-1",
      kind: "question",
      payload: JSON.stringify({ text: "hello", replyMarkup: { inline_keyboard: [] }, notificationId: "notif-1" }),
      token: "tok-1",
    }, 5000)

    mockSend.mockResolvedValue({ ok: true })
    const sender = createSender()
    await sender.processOnce()

    expect(mockSend).toHaveBeenCalledTimes(1)
    const entry = storage.outbox.getByNotificationId("notif-1")
    expect(entry!.state).toBe("sent")
  })

  it("retries on transient failure with backoff", async () => {
    storage.outbox.upsert({
      notificationId: "notif-1",
      sessionId: "sess-1",
      requestId: "req-1",
      kind: "question",
      payload: JSON.stringify({ text: "hello", replyMarkup: { inline_keyboard: [] }, notificationId: "notif-1" }),
      token: "tok-1",
    }, 5000)

    mockSend.mockResolvedValue({ ok: false })
    const sender = createSender()
    await sender.processOnce()

    const entry = storage.outbox.getByNotificationId("notif-1")
    expect(entry!.state).toBe("queued")
    expect(entry!.attempts).toBe(1)
    expect(entry!.nextRetryAt).toBeGreaterThan(10_000)
  })

  it("marks terminal failure after max attempts", async () => {
    storage.outbox.upsert({
      notificationId: "notif-1",
      sessionId: "sess-1",
      requestId: "req-1",
      kind: "question",
      payload: JSON.stringify({ text: "hello", replyMarkup: { inline_keyboard: [] }, notificationId: "notif-1" }),
      token: "tok-1",
    }, 5000)

    // Simulate 10 prior failed attempts
    for (let i = 0; i < 10; i++) {
      storage.outbox.markRetry("notif-1", 6000, 0)
    }

    mockSend.mockResolvedValue({ ok: false })
    const sender = createSender()
    await sender.processOnce()

    const entry = storage.outbox.getByNotificationId("notif-1")
    expect(entry!.state).toBe("failed")
  })

  it("marks terminal failure after max age", async () => {
    storage.outbox.upsert({
      notificationId: "notif-1",
      sessionId: "sess-1",
      requestId: "req-1",
      kind: "question",
      payload: JSON.stringify({ text: "hello", replyMarkup: { inline_keyboard: [] }, notificationId: "notif-1" }),
      token: "tok-1",
    }, 1000) // created 9 seconds ago

    mockSend.mockResolvedValue({ ok: false })
    const sender = createSender({ nowFn: () => 1000 + 15 * 60 * 1000 + 1 }) // >15 min old
    await sender.processOnce()

    const entry = storage.outbox.getByNotificationId("notif-1")
    expect(entry!.state).toBe("failed")
  })

  it("skips entries not yet ready for retry", async () => {
    storage.outbox.upsert({
      notificationId: "notif-1",
      sessionId: "sess-1",
      requestId: "req-1",
      kind: "question",
      payload: JSON.stringify({ text: "hello", replyMarkup: { inline_keyboard: [] }, notificationId: "notif-1" }),
      token: "tok-1",
    }, 5000)

    storage.outbox.markRetry("notif-1", 8000, 60_000) // not ready until 68s

    const sender = createSender()
    await sender.processOnce()

    expect(mockSend).not.toHaveBeenCalled()
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npm run --workspace @pigeon/daemon test -- --run outbox-sender`
Expected: FAIL — module not found

**Step 3: Implement OutboxSender**

Create `packages/daemon/src/worker/outbox-sender.ts`:

```typescript
import type { StorageDb } from "../storage/database";

type LogFn = (message: string, data?: Record<string, unknown>) => void;

interface SendNotificationFn {
  (sessionId: string, chatId: string, text: string, replyMarkup: unknown, media?: unknown, notificationId?: string): Promise<{ ok: boolean }>;
}

export interface OutboxSenderOptions {
  storage: StorageDb;
  sendNotification: SendNotificationFn;
  chatId?: string;
  nowFn?: () => number;
  log?: LogFn;
}

const MAX_ATTEMPTS = 10;
const MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes
const BACKOFF_SCHEDULE = [5_000, 10_000, 30_000, 60_000, 120_000];

export class OutboxSender {
  private readonly storage: StorageDb;
  private readonly sendNotification: SendNotificationFn;
  private readonly chatId: string;
  private readonly nowFn: () => number;
  private readonly log: LogFn;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  constructor(opts: OutboxSenderOptions) {
    this.storage = opts.storage;
    this.sendNotification = opts.sendNotification;
    this.chatId = opts.chatId ?? "";
    this.nowFn = opts.nowFn ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  start(intervalMs = 5_000): void {
    this.timer = setInterval(() => this.processOnce().catch(() => {}), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async processOnce(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const now = this.nowFn();
      const entries = this.storage.outbox.getReady(now, 5);

      for (const entry of entries) {
        const age = now - entry.createdAt;

        // Terminal failure: too many attempts or too old
        if (entry.attempts >= MAX_ATTEMPTS || age > MAX_AGE_MS) {
          this.storage.outbox.markFailed(entry.notificationId, now);
          this.log("outbox terminal failure", {
            notificationId: entry.notificationId,
            attempts: entry.attempts,
            ageMs: age,
          });
          continue;
        }

        try {
          const payload = JSON.parse(entry.payload) as {
            text: string;
            replyMarkup: unknown;
            notificationId?: string;
          };

          const result = await this.sendNotification(
            entry.sessionId,
            this.chatId,
            payload.text,
            payload.replyMarkup,
            undefined,
            payload.notificationId,
          );

          if (result.ok) {
            this.storage.outbox.markSent(entry.notificationId, now);
            this.log("outbox send success", { notificationId: entry.notificationId });
          } else {
            const backoffIdx = Math.min(entry.attempts, BACKOFF_SCHEDULE.length - 1);
            this.storage.outbox.markRetry(entry.notificationId, now, BACKOFF_SCHEDULE[backoffIdx]);
            this.log("outbox send failed, will retry", {
              notificationId: entry.notificationId,
              attempt: entry.attempts + 1,
            });
          }
        } catch (err) {
          const backoffIdx = Math.min(entry.attempts, BACKOFF_SCHEDULE.length - 1);
          this.storage.outbox.markRetry(entry.notificationId, now, BACKOFF_SCHEDULE[backoffIdx]);
          this.log("outbox send error, will retry", {
            notificationId: entry.notificationId,
            attempt: entry.attempts + 1,
          });
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
```

**Step 4: Run tests**

Run: `npm run --workspace @pigeon/daemon test -- --run outbox-sender`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/daemon/src/worker/outbox-sender.ts packages/daemon/test/outbox-sender.test.ts
git commit -m "feat(daemon): add outbox background sender for durable question delivery"
```

---

## Task 7: Daemon — Wire Outbox Sender into Startup

**Files:**
- Modify: `packages/daemon/src/index.ts` (or wherever the daemon starts up — check the main entrypoint)

This task wires the OutboxSender into daemon startup alongside the existing Poller. The sender needs the same `sendNotification` function the `WorkerNotificationService` uses.

**Step 1: Find the daemon entrypoint**

Check `packages/daemon/src/index.ts` for the startup logic that creates the Poller, storage, and notification service.

**Step 2: Add OutboxSender creation alongside Poller**

After the Poller is created and started, create and start the OutboxSender:

```typescript
import { OutboxSender } from "./worker/outbox-sender";

// ... after poller setup ...

const outboxSender = new OutboxSender({
  storage,
  sendNotification: (sessionId, chatId, text, replyMarkup, media, notificationId) =>
    poller.sendNotification(sessionId, chatId, text, replyMarkup, media, notificationId),
  chatId: config.chatId,
  nowFn: () => Date.now(),
  log: (msg, data) => console.log(`[outbox] ${msg}`, data ?? ""),
});
outboxSender.start(5_000);
```

Note: the exact wiring depends on how `sendNotification` is exposed by the poller/worker-client. The implementer should check how `WorkerNotificationService.sendViaWorker` works and use the same underlying HTTP call.

**Step 3: Add outbox cleanup to the existing periodic cleanup**

Find where `cleanupExpired` or similar cleanup is called periodically and add:

```typescript
storage.outbox.cleanupOlderThan(Date.now() - OUTBOX_RETENTION_MS);
```

**Step 4: Run typecheck**

Run: `npm run --workspace @pigeon/daemon typecheck`
Expected: PASS

**Step 5: Run all daemon tests**

Run: `npm run --workspace @pigeon/daemon test -- --run`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/daemon/src/index.ts
git commit -m "feat(daemon): wire outbox sender into daemon startup"
```

---

## Task 8: Worker — Add Notification Idempotency

**Files:**
- Modify: `packages/worker/src/d1-schema.sql`
- Modify: `packages/worker/src/notifications.ts`
- Modify: `packages/worker/test/worker.test.ts`

**Step 1: Write failing tests**

Add to `packages/worker/test/worker.test.ts`:

```typescript
describe("notification idempotency", () => {
  it("deduplicates by notificationId", async () => {
    // Register a session first
    // Send notification with notificationId
    // Send same notification with same notificationId
    // Verify only one Telegram API call was made
    // Verify response returns the same message data
  })

  it("sends normally when notificationId is absent", async () => {
    // Register session, send notification without notificationId
    // Verify Telegram API is called
  })
})
```

The implementer should expand these based on the existing test patterns in `worker.test.ts`.

**Step 2: Add migration for notification_id column**

In `packages/worker/src/d1-schema.sql`, the `messages` table already exists. Add a D1 migration or handle it in the schema init. Since D1 uses migrations differently, check `wrangler.toml` for migration config.

For the schema definition, add `notification_id` to the messages table:

```sql
-- In the messages table (or as a migration):
ALTER TABLE messages ADD COLUMN notification_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_notification_id
  ON messages(notification_id) WHERE notification_id IS NOT NULL;
```

**Step 3: Update handleSendNotification**

In `packages/worker/src/notifications.ts`, update the `handleSendNotification` function:

After extracting `body` (line 169-170), add:

```typescript
const notificationId = typeof body.notificationId === "string" ? body.notificationId : null;

// Idempotency check: if notificationId was provided and we already sent this notification,
// return the existing message data without calling Telegram again.
if (notificationId) {
  const existing = await db
    .prepare("SELECT * FROM messages WHERE notification_id = ?")
    .bind(notificationId)
    .first<MessageRow>();
  if (existing) {
    return json({ ok: true, messageId: existing.message_id, deduplicated: true });
  }
}
```

After inserting the message (line 237-240), add `notification_id`:

```typescript
await db
  .prepare(
    "INSERT INTO messages (chat_id, message_id, session_id, token, notification_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
  .bind(String(chatId), messageId, sessionId, token, notificationId, Date.now())
  .run();
```

Also update the `SendNotificationBody` type to include `notificationId?: string`.

**Step 4: Run worker tests**

Run: `npm run --workspace @pigeon/worker test -- --run`
Expected: PASS

**Step 5: Run worker typecheck**

Run: `npm run --workspace @pigeon/worker typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/worker/src/d1-schema.sql packages/worker/src/notifications.ts packages/worker/test/worker.test.ts
git commit -m "feat(worker): add notification idempotency by notificationId"
```

---

## Task 9: Integration Testing and Typecheck

**Files:** All packages

**Step 1: Run full typecheck across all packages**

Run: `npm run typecheck`
Expected: PASS — no type errors across all packages

**Step 2: Run full test suite**

Run: `npm run test`
Expected: PASS — all tests across all packages

**Step 3: Fix any issues found**

If any tests fail or type errors exist, fix them.

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: address integration issues from question reliability overhaul"
```

---

## Task 10: Update Documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `.claude/skills/daemon-architecture/SKILL.md`
- Modify: `.claude/skills/opencode-plugin-architecture/SKILL.md` (or `.claude/skills/Claude-plugin-architecture/SKILL.md` — check actual path)
- Modify: `.claude/skills/worker-architecture/SKILL.md`

**Step 1: Update AGENTS.md**

In the "Commands" / architecture section, update the question flow description to reflect the outbox architecture. Add a note about the durable delivery guarantee.

**Step 2: Update daemon-architecture skill**

In `.claude/skills/daemon-architecture/SKILL.md`:
- Add `outbox` to the Storage Domains section
- Update the Question Flow to describe: plugin -> daemon (202 durable accept) -> outbox -> background sender -> worker -> Telegram
- Mention the outbox sender background loop (5s interval)
- Update the response semantics (202 Accepted, deliveryState field)

**Step 3: Update plugin-architecture skill**

In the plugin architecture skill (check whether it's `.claude/skills/Claude-plugin-architecture/SKILL.md` or `.claude/skills/opencode-plugin-architecture/SKILL.md`):
- Document the question retry queue (bypasses circuit breaker)
- Document decoupled stop flush (fire-and-forget before question)
- Document backward-compatible response handling (deliveryState vs notified)

**Step 4: Update worker-architecture skill**

In `.claude/skills/worker-architecture/SKILL.md`:
- Add `notification_id` to the messages table schema description
- Document the idempotency behavior in `POST /notifications/send`

**Step 5: Commit documentation**

```bash
git add AGENTS.md .claude/skills/
git commit -m "docs: update skills and AGENTS.md for question notification reliability overhaul"
```

---

## Summary

| Task | Package | What it does |
|------|---------|-------------|
| 1 | plugin | Question retry queue module (self-contained) |
| 2 | plugin | `sendQuestionAsked` bypassing circuit breaker |
| 3 | plugin | Wire queue into event handler, decouple stop flush |
| 4 | daemon | Outbox table + repository |
| 5 | daemon | Refactor `/question-asked` to durable accept (202) |
| 6 | daemon | Background outbox sender |
| 7 | daemon | Wire outbox sender into startup |
| 8 | worker | Notification idempotency by `notificationId` |
| 9 | all | Integration testing + typecheck |
| 10 | docs | Update AGENTS.md and skills documentation |
