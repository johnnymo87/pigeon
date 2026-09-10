import { DeliveryQueue, type DeliveryOutcome } from "./delivery-queue"
import type { StopOutcome } from "./daemon-client"

type LogFn = (message: string, data?: unknown) => void

type FileMedia = {
  mime: string
  filename: string
  url: string
}

export type StopEntry = {
  sessionId: string
  /** Client-minted idempotency key; also this entry's identity in the queue. */
  notificationId: string
  event?: string
  message: string
  label: string
  title?: string
  media?: FileMedia[]
  errorKind?: string | null
}

export type StopSender = (entry: StopEntry) => Promise<StopOutcome>

export type StopQueueOptions = {
  maxRetryMs?: number
  maxSize?: number
  onExpired?: (entry: StopEntry, info: { attempts: number; ageMs: number }) => void
  onEvicted?: (entry: StopEntry) => void
  log?: LogFn
}

const MAX_SIZE = 32
const DEFAULT_MAX_RETRY_MS = 10 * 60 * 1000 // 10 minutes

const MAX_NOTIFICATION_ID_LENGTH = 128

/**
 * The daemon validates this id against `^s:<sessionId>:` and a conservative charset,
 * and falls back to its own (non-deduping) id if we send something it does not like.
 * Sanitising here keeps that fallback for genuine bugs rather than for message ids that
 * merely contain an unexpected character.
 */
function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_")
}

/**
 * Mints the idempotency key for one stop notification.
 *
 * The key must dedupe RETRIES of a single send decision without collapsing two
 * genuinely separate notifications. That rules out keying on the message id alone: a
 * late `message.updated` for an already-completed message clears the plugin's dedup
 * guard, and the next idle legitimately sends the *newly accumulated* text of the SAME
 * message. Keying on the message id would silently swallow it.
 *
 * So each call to `mint` -- i.e. each send decision -- gets a fresh sequence number,
 * and everything the queue retries afterwards reuses that one key. The counter is
 * per-session and monotonic rather than a timestamp, so two decisions inside the same
 * millisecond cannot collide and tests are deterministic.
 */
export class StopKeyMinter {
  private counters: Map<string, number> = new Map()

  mint(sessionId: string, dedupToken: string): string {
    const next = (this.counters.get(sessionId) ?? 0) + 1
    this.counters.set(sessionId, next)

    const prefix = `s:${sessionId}:`
    const suffix = `.${next}`
    const room = MAX_NOTIFICATION_ID_LENGTH - prefix.length - suffix.length
    // max(room, 0): clamping to 1 instead would push an already-maximal id to 129 chars,
    // which the daemon rejects -- an empty token is the only correct answer there.
    const token = sanitizeSegment(dedupToken).slice(0, Math.max(room, 0))
    return `${prefix}${token}${suffix}`
  }
}

/**
 * Retry queue for stop/error notifications.
 *
 * Its whole reason to exist: a stop used to be a single fire-and-forget POST that was
 * silently dropped whenever the circuit breaker happened to be open, and nothing
 * retried it. Everything past the daemon's front door was already durable; this covers
 * the loopback hop that was not.
 *
 * Capacity is larger than the question queue's (32 vs 20) because a machine runs dozens
 * of sessions on one serve process and a daemon restart can idle many of them at once.
 */
export class StopDeliveryQueue {
  private queue: DeliveryQueue<StopEntry>

  constructor(opts?: StopQueueOptions) {
    this.queue = new DeliveryQueue<StopEntry>({
      name: "stop-queue",
      key: (entry) => entry.notificationId,
      describe: (entry) => ({
        sessionId: entry.sessionId,
        notificationId: entry.notificationId,
        event: entry.event ?? "Stop",
      }),
      maxSize: opts?.maxSize ?? MAX_SIZE,
      maxRetryMs: opts?.maxRetryMs ?? DEFAULT_MAX_RETRY_MS,
      onExpired: opts?.onExpired,
      onEvicted: opts?.onEvicted,
      log: opts?.log,
    })
  }

  enqueue(entry: StopEntry): void {
    this.queue.enqueue(entry)
  }

  start(sender: StopSender): void {
    this.queue.start(async (entry): Promise<DeliveryOutcome> => {
      const outcome = await sender(entry)
      // `unregistered` reaches here only if the sender's re-registration attempt did
      // not fix it, so a further retry would just repeat the same 404.
      if (outcome === "success") return "success"
      if (outcome === "retry") return "retry"
      return "terminal"
    })
  }

  stop(): void {
    this.queue.stop()
  }

  /** Run one delivery pass now. Used by tests; the timer calls the same code. */
  tick(): Promise<void> {
    return this.queue.tick()
  }

  size(): number {
    return this.queue.size()
  }
}
