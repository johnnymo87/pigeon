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

export type QuestionQueueOptions = {
  maxRetryMs?: number
  onExpired?: (sessionId: string, requestId: string) => void
  log?: LogFn
}

type DaemonResponse = {
  ok: boolean
  notified?: boolean
  deliveryState?: string
} | null

export type Sender = (entry: QuestionEntry) => Promise<DaemonResponse>

type QueueItem = {
  entry: QuestionEntry
  enqueuedAt: number
  nextAttemptAt: number
  attempts: number
}

const MAX_SIZE = 20
const TICK_INTERVAL_MS = 500
const DEFAULT_MAX_RETRY_MS = 2 * 60 * 1000 // 2 minutes

// Exponential backoff schedule (ms)
const BACKOFF_SCHEDULE = [500, 1000, 2000, 4000, 8000, 15000, 30000]

function isSuccess(result: DaemonResponse): boolean {
  if (result === null || result === undefined) return false

  // New daemon: deliveryState present
  if (result.deliveryState !== undefined) {
    return (
      result.deliveryState === "accepted" ||
      result.deliveryState === "sent" ||
      result.deliveryState === "queued"
    )
  }

  // Old daemon: deliveryState absent, check notified
  return result.notified === true
}

function getBackoffMs(attempts: number): number {
  const index = Math.min(attempts, BACKOFF_SCHEDULE.length - 1)
  const base = BACKOFF_SCHEDULE[index] ?? BACKOFF_SCHEDULE[BACKOFF_SCHEDULE.length - 1] ?? 30000
  // Add 0-50% jitter
  const jitter = base * Math.random() * 0.5
  return base + jitter
}

export class QuestionDeliveryQueue {
  private items: Map<string, QueueItem> = new Map()
  private insertionOrder: string[] = []
  private maxRetryMs: number
  private onExpired?: (sessionId: string, requestId: string) => void
  private log: LogFn
  private timer: ReturnType<typeof setInterval> | null = null
  private sender: Sender | null = null

  constructor(opts?: QuestionQueueOptions) {
    this.maxRetryMs = opts?.maxRetryMs ?? DEFAULT_MAX_RETRY_MS
    this.onExpired = opts?.onExpired
    this.log = opts?.log ?? ((msg, data) => console.log("[QuestionQueue]", msg, data))
  }

  private key(sessionId: string, requestId: string): string {
    return `${sessionId}::${requestId}`
  }

  enqueue(entry: QuestionEntry): void {
    const k = this.key(entry.sessionId, entry.requestId)

    // Dedup: if already queued, skip
    if (this.items.has(k)) {
      return
    }

    // Evict oldest if at capacity
    if (this.items.size >= MAX_SIZE) {
      const oldestKey = this.insertionOrder.shift()
      if (oldestKey !== undefined) {
        this.items.delete(oldestKey)
      }
    }

    const now = Date.now()
    this.items.set(k, {
      entry,
      enqueuedAt: now,
      nextAttemptAt: now, // attempt immediately on next tick
      attempts: 0,
    })
    this.insertionOrder.push(k)
  }

  start(sender: Sender): void {
    this.sender = sender
    this.timer = setInterval(() => {
      void this.tick()
    }, TICK_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  size(): number {
    return this.items.size
  }

  has(sessionId: string, requestId: string): boolean {
    return this.items.has(this.key(sessionId, requestId))
  }

  private async tick(): Promise<void> {
    if (this.sender === null) return

    const now = Date.now()
    const toProcess = Array.from(this.items.entries()).filter(
      ([, item]) => now >= item.nextAttemptAt
    )

    for (const [k, item] of toProcess) {
      const age = now - item.enqueuedAt

      // Check expiry
      if (age >= this.maxRetryMs) {
        this.log("question-queue: entry expired", {
          sessionId: item.entry.sessionId,
          requestId: item.entry.requestId,
          age,
        })
        this.items.delete(k)
        this.insertionOrder = this.insertionOrder.filter((x) => x !== k)
        this.onExpired?.(item.entry.sessionId, item.entry.requestId)
        continue
      }

      // Attempt delivery
      try {
        const result = await this.sender(item.entry)
        if (isSuccess(result)) {
          this.log("question-queue: delivered", {
            sessionId: item.entry.sessionId,
            requestId: item.entry.requestId,
          })
          this.items.delete(k)
          this.insertionOrder = this.insertionOrder.filter((x) => x !== k)
        } else {
          // Schedule retry
          const backoffMs = getBackoffMs(item.attempts)
          item.attempts++
          item.nextAttemptAt = Date.now() + backoffMs
          this.log("question-queue: delivery failed, scheduling retry", {
            sessionId: item.entry.sessionId,
            requestId: item.entry.requestId,
            attempts: item.attempts,
            backoffMs,
          })
        }
      } catch (err) {
        // Treat exceptions as failures
        const backoffMs = getBackoffMs(item.attempts)
        item.attempts++
        item.nextAttemptAt = Date.now() + backoffMs
        this.log("question-queue: sender threw, scheduling retry", {
          sessionId: item.entry.sessionId,
          requestId: item.entry.requestId,
          attempts: item.attempts,
          err,
        })
      }
    }
  }
}
