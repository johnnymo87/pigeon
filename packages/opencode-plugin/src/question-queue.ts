import { DeliveryQueue, type DeliveryOutcome } from "./delivery-queue"

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
  title?: string
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

const MAX_SIZE = 20
const DEFAULT_MAX_RETRY_MS = 2 * 60 * 1000 // 2 minutes

/**
 * Whether the daemon accepted a QUESTION.
 *
 * Note how much this classifier assumes: with no `deliveryState` it demands
 * `notified === true`. That is right for /question-asked, which always delivers, and
 * wrong for /stop, which answers `{ok:true, notified:false}` for every quiet session.
 * This is why the shared queue takes its classifier from the caller rather than owning
 * one -- a shared classifier would retry correctly-quieted stops until they expired.
 */
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

/**
 * Question delivery, on the shared DeliveryQueue.
 *
 * Kept as its own class rather than an inline instantiation because the (sessionId,
 * requestId) pair is the question subsystem's vocabulary and appears in `has()` and in
 * `onExpired`, which callers depend on.
 */
export class QuestionDeliveryQueue {
  private queue: DeliveryQueue<QuestionEntry>

  constructor(opts?: QuestionQueueOptions) {
    this.queue = new DeliveryQueue<QuestionEntry>({
      name: "question-queue",
      key: (entry) => this.key(entry.sessionId, entry.requestId),
      describe: (entry) => ({ sessionId: entry.sessionId, requestId: entry.requestId }),
      maxSize: MAX_SIZE,
      maxRetryMs: opts?.maxRetryMs ?? DEFAULT_MAX_RETRY_MS,
      onExpired: (entry) => opts?.onExpired?.(entry.sessionId, entry.requestId),
      log: opts?.log,
    })
  }

  private key(sessionId: string, requestId: string): string {
    return `${sessionId}::${requestId}`
  }

  enqueue(entry: QuestionEntry): void {
    this.queue.enqueue(entry)
  }

  start(sender: Sender): void {
    this.queue.start(async (entry): Promise<DeliveryOutcome> => {
      const result = await sender(entry)
      return isSuccess(result) ? "success" : "retry"
    })
  }

  stop(): void {
    this.queue.stop()
  }

  size(): number {
    return this.queue.size()
  }

  has(sessionId: string, requestId: string): boolean {
    return this.queue.hasKey(this.key(sessionId, requestId))
  }
}
