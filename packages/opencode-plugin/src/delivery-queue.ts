type LogFn = (message: string, data?: unknown) => void

/**
 * What one delivery attempt concluded.
 *
 * `terminal` exists so a queue can stop retrying something a retry cannot fix (a
 * malformed request, a session the daemon refuses) WITHOUT the caller having to
 * pretend it succeeded. It is deliberately a third case rather than a boolean: with
 * only success/failure, every unfixable error retries until the TTL expires and then
 * emits an alarm, which is noise that trains people to ignore the alarm.
 */
export type DeliveryOutcome = "success" | "retry" | "terminal"

export type DeliverySender<T> = (entry: T) => Promise<DeliveryOutcome>

export type DeliveryQueueOptions<T> = {
  /** Prefix for every log line, e.g. "question-queue". */
  name: string
  /** Identity of an entry. Two entries with the same key are the same delivery. */
  key: (entry: T) => string
  /** Extra fields for log lines, so an operator can grep by session. */
  describe?: (entry: T) => Record<string, unknown>
  maxSize?: number
  maxRetryMs?: number
  onExpired?: (entry: T, info: { attempts: number; ageMs: number }) => void
  onEvicted?: (entry: T) => void
  log?: LogFn
}

type QueueItem<T> = {
  entry: T
  enqueuedAt: number
  nextAttemptAt: number
  attempts: number
}

const DEFAULT_MAX_SIZE = 20
const TICK_INTERVAL_MS = 500
const DEFAULT_MAX_RETRY_MS = 2 * 60 * 1000

const BACKOFF_SCHEDULE = [500, 1000, 2000, 4000, 8000, 15000, 30000]

function getBackoffMs(attempts: number): number {
  const index = Math.min(attempts, BACKOFF_SCHEDULE.length - 1)
  const base = BACKOFF_SCHEDULE[index] ?? BACKOFF_SCHEDULE[BACKOFF_SCHEDULE.length - 1] ?? 30000
  const jitter = base * Math.random() * 0.5
  return base + jitter
}

/**
 * A bounded, in-memory retry queue that bridges the gap between "the plugin decided to
 * send something" and "the daemon accepted it".
 *
 * It is not durable, and does not need to be: everything past the daemon's front door
 * is already covered by the daemon's SQLite outbox. What this covers is the loopback
 * hop itself -- the seconds where the daemon is restarting, busy, or briefly
 * unreachable -- which is precisely the window in which notifications used to be
 * dropped outright.
 *
 * Both the identity of an entry and the classification of an attempt are injected,
 * because the two users disagree about both. Sharing them would be a bug: /stop
 * answers `{ok:true, notified:false}` for a session that is intentionally quiet, and
 * the question classifier reads that as a failure worth retrying for ten minutes.
 */
export class DeliveryQueue<T> {
  private items: Map<string, QueueItem<T>> = new Map()
  private insertionOrder: string[] = []
  private opts: DeliveryQueueOptions<T>
  private maxSize: number
  private maxRetryMs: number
  private log: LogFn
  private timer: ReturnType<typeof setInterval> | null = null
  private sender: DeliverySender<T> | null = null
  /**
   * At-most-one-tick-in-flight. A tick can take seconds (the send timeout) while the
   * interval fires every 500ms, and `nextAttemptAt` is only advanced AFTER the await --
   * so overlapping ticks would snapshot the same entry and send it twice.
   */
  private ticking = false

  constructor(opts: DeliveryQueueOptions<T>) {
    this.opts = opts
    this.maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE
    this.maxRetryMs = opts.maxRetryMs ?? DEFAULT_MAX_RETRY_MS
    this.log = opts.log ?? ((msg, data) => console.log(`[${opts.name}]`, msg, data))
  }

  private describe(entry: T): Record<string, unknown> {
    return this.opts.describe?.(entry) ?? {}
  }

  enqueue(entry: T): void {
    const k = this.opts.key(entry)

    if (this.items.has(k)) return

    if (this.items.size >= this.maxSize) {
      const oldestKey = this.insertionOrder.shift()
      if (oldestKey !== undefined) {
        const evicted = this.items.get(oldestKey)
        this.items.delete(oldestKey)
        if (evicted) {
          // Loud on purpose. Eviction means a notification was thrown away, which is
          // the failure this queue exists to prevent; it must not be silent.
          this.log(`${this.opts.name}: evicted at capacity`, {
            ...this.describe(evicted.entry),
            attempts: evicted.attempts,
            maxSize: this.maxSize,
          })
          this.opts.onEvicted?.(evicted.entry)
        }
      }
    }

    const now = Date.now()
    this.items.set(k, { entry, enqueuedAt: now, nextAttemptAt: now, attempts: 0 })
    this.insertionOrder.push(k)
  }

  start(sender: DeliverySender<T>): void {
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

  hasKey(key: string): boolean {
    return this.items.has(key)
  }

  private remove(k: string): void {
    this.items.delete(k)
    this.insertionOrder = this.insertionOrder.filter((x) => x !== k)
  }

  private scheduleRetry(k: string, item: QueueItem<T>, reason: string): void {
    const backoffMs = getBackoffMs(item.attempts)
    item.attempts++
    item.nextAttemptAt = Date.now() + backoffMs
    this.log(`${this.opts.name}: ${reason}, scheduling retry`, {
      ...this.describe(item.entry),
      attempts: item.attempts,
      backoffMs,
    })
  }

  async tick(): Promise<void> {
    if (this.sender === null) return
    if (this.ticking) return
    this.ticking = true

    try {
      const now = Date.now()
      const toProcess = Array.from(this.items.entries()).filter(
        ([, item]) => now >= item.nextAttemptAt,
      )

      for (const [k, item] of toProcess) {
        const ageMs = now - item.enqueuedAt

        if (ageMs >= this.maxRetryMs) {
          this.log(`${this.opts.name}: entry expired`, {
            ...this.describe(item.entry),
            ageMs,
            attempts: item.attempts,
          })
          this.remove(k)
          this.opts.onExpired?.(item.entry, { attempts: item.attempts, ageMs })
          continue
        }

        try {
          const outcome = await this.sender(item.entry)
          if (outcome === "success") {
            this.log(`${this.opts.name}: delivered`, this.describe(item.entry))
            this.remove(k)
          } else if (outcome === "terminal") {
            this.log(`${this.opts.name}: giving up (terminal)`, {
              ...this.describe(item.entry),
              attempts: item.attempts,
            })
            this.remove(k)
          } else {
            this.scheduleRetry(k, item, "delivery failed")
          }
        } catch (err) {
          this.scheduleRetry(k, item, "sender threw")
        }
      }
    } finally {
      this.ticking = false
    }
  }
}
