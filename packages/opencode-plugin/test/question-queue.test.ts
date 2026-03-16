import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import { QuestionDeliveryQueue } from "../src/question-queue"
import type { QuestionEntry, Sender } from "../src/question-queue"

const makeEntry = (sessionId: string, requestId: string): QuestionEntry => ({
  sessionId,
  requestId,
  questions: [
    {
      question: "What should I do?",
      header: "Action",
      options: [{ label: "Continue", description: "Continue the task" }],
    },
  ],
  label: "test-session",
})

const noop = () => {}

describe("QuestionDeliveryQueue", () => {
  let queue: QuestionDeliveryQueue

  beforeEach(() => {
    vi.useFakeTimers()
    queue = new QuestionDeliveryQueue({ log: noop })
  })

  afterEach(() => {
    queue.stop()
    vi.useRealTimers()
  })

  describe("enqueue", () => {
    test("enqueue adds entry and dedup by sessionId+requestId", () => {
      const entry = makeEntry("sess-1", "req-1")
      queue.enqueue(entry)
      expect(queue.size()).toBe(1)
      expect(queue.has("sess-1", "req-1")).toBe(true)

      // Enqueue same session+request again - should remain at 1
      queue.enqueue(entry)
      expect(queue.size()).toBe(1)

      // Different requestId same session - new entry
      queue.enqueue(makeEntry("sess-1", "req-2"))
      expect(queue.size()).toBe(2)

      // Different session same requestId - new entry
      queue.enqueue(makeEntry("sess-2", "req-1"))
      expect(queue.size()).toBe(3)
    })

    test("enqueue evicts oldest when at capacity", () => {
      // Fill to capacity (20)
      for (let i = 0; i < 20; i++) {
        queue.enqueue(makeEntry("sess", `req-${i}`))
      }
      expect(queue.size()).toBe(20)
      expect(queue.has("sess", "req-0")).toBe(true)

      // Add one more - oldest (req-0) should be evicted
      queue.enqueue(makeEntry("sess", "req-20"))
      expect(queue.size()).toBe(20)
      expect(queue.has("sess", "req-0")).toBe(false)
      expect(queue.has("sess", "req-20")).toBe(true)
    })
  })

  describe("delivery", () => {
    test("successful delivery removes entry", async () => {
      const successSender: Sender = vi.fn().mockResolvedValue({ ok: true, deliveryState: "accepted" })

      queue.enqueue(makeEntry("sess-1", "req-1"))
      expect(queue.size()).toBe(1)

      queue.start(successSender)

      // Advance time past the tick interval (500ms)
      await vi.advanceTimersByTimeAsync(600)

      expect(queue.size()).toBe(0)
      expect(queue.has("sess-1", "req-1")).toBe(false)
    })

    test("failed delivery retries with backoff", async () => {
      const sender: Sender = vi.fn()
        .mockResolvedValueOnce(null) // First call: failure (null)
        .mockResolvedValueOnce({ ok: true, deliveryState: "sent" }) // Second call: success

      queue.enqueue(makeEntry("sess-1", "req-1"))
      queue.start(sender)

      // First tick - sender fails (fires at 500ms interval mark)
      await vi.advanceTimersByTimeAsync(600)
      expect(sender).toHaveBeenCalledTimes(1)
      expect(queue.size()).toBe(1) // Still in queue

      // Advance enough for backoff + jitter to pass
      // Backoff is 500ms base + up to 50% jitter = max 750ms
      // Next tick fires at 500ms intervals, so within 1000ms more we'll hit the retry
      // Total elapsed: 600 + 1500 = 2100ms, ticks at 1000ms and 1500ms and 2000ms
      await vi.advanceTimersByTimeAsync(1500)
      expect(sender).toHaveBeenCalledTimes(2) // Retried
      expect(queue.size()).toBe(0) // Removed after success
    })

    test("entry expires after max retry window", async () => {
      const onExpired = vi.fn()
      const alwaysFailSender: Sender = vi.fn().mockResolvedValue(null)

      queue = new QuestionDeliveryQueue({
        maxRetryMs: 2000, // 2s max retry window
        onExpired,
        log: noop,
      })

      queue.enqueue(makeEntry("sess-1", "req-1"))
      queue.start(alwaysFailSender)

      // Advance past the max retry window
      await vi.advanceTimersByTimeAsync(10_000)

      expect(queue.size()).toBe(0)
      expect(onExpired).toHaveBeenCalledWith("sess-1", "req-1")
    })

    test("treats notified:false (old daemon) as failure - retries until success", async () => {
      const sender: Sender = vi.fn()
        .mockResolvedValueOnce({ ok: true, notified: false }) // Old daemon, not notified = failure
        .mockResolvedValueOnce({ ok: true, notified: true })  // Old daemon success

      queue.enqueue(makeEntry("sess-1", "req-1"))
      queue.start(sender)

      // First tick
      await vi.advanceTimersByTimeAsync(600)
      expect(sender).toHaveBeenCalledTimes(1)
      expect(queue.size()).toBe(1) // Should still be in queue (notified:false = failure)

      // Advance past backoff
      await vi.advanceTimersByTimeAsync(1500)
      expect(sender).toHaveBeenCalledTimes(2)
      expect(queue.size()).toBe(0) // Removed after old-daemon success
    })

    test("stop() halts delivery loop", async () => {
      const sender: Sender = vi.fn().mockResolvedValue(null) // Always fails

      queue.enqueue(makeEntry("sess-1", "req-1"))
      queue.start(sender)

      // First tick
      await vi.advanceTimersByTimeAsync(600)
      expect(sender).toHaveBeenCalledTimes(1)

      // Stop the loop
      queue.stop()

      // Advance a lot - no more calls should happen
      await vi.advanceTimersByTimeAsync(10_000)
      expect(sender).toHaveBeenCalledTimes(1)
    })
  })

  describe("success detection", () => {
    test("deliveryState accepted is success", async () => {
      const sender: Sender = vi.fn().mockResolvedValue({ ok: true, deliveryState: "accepted" })
      queue.enqueue(makeEntry("sess-1", "req-1"))
      queue.start(sender)
      await vi.advanceTimersByTimeAsync(600)
      expect(queue.size()).toBe(0)
    })

    test("deliveryState sent is success", async () => {
      const sender: Sender = vi.fn().mockResolvedValue({ ok: true, deliveryState: "sent" })
      queue.enqueue(makeEntry("sess-1", "req-1"))
      queue.start(sender)
      await vi.advanceTimersByTimeAsync(600)
      expect(queue.size()).toBe(0)
    })

    test("deliveryState queued is success", async () => {
      const sender: Sender = vi.fn().mockResolvedValue({ ok: true, deliveryState: "queued" })
      queue.enqueue(makeEntry("sess-1", "req-1"))
      queue.start(sender)
      await vi.advanceTimersByTimeAsync(600)
      expect(queue.size()).toBe(0)
    })

    test("null response is failure", async () => {
      const sender: Sender = vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ok: true, deliveryState: "accepted" })
      queue.enqueue(makeEntry("sess-1", "req-1"))
      queue.start(sender)
      await vi.advanceTimersByTimeAsync(600)
      expect(queue.size()).toBe(1) // null = failure, still in queue

      await vi.advanceTimersByTimeAsync(1500)
      expect(queue.size()).toBe(0)
    })

    test("notified:false with no deliveryState (old daemon) is failure", async () => {
      const sender: Sender = vi.fn()
        .mockResolvedValueOnce({ ok: true, notified: false })
        .mockResolvedValueOnce({ ok: true, notified: true })
      queue.enqueue(makeEntry("sess-1", "req-1"))
      queue.start(sender)
      await vi.advanceTimersByTimeAsync(600)
      expect(queue.size()).toBe(1) // notified:false = failure

      await vi.advanceTimersByTimeAsync(1500)
      expect(queue.size()).toBe(0) // notified:true = old daemon success
    })

    test("notified:true with no deliveryState (old daemon) is success", async () => {
      const sender: Sender = vi.fn().mockResolvedValue({ ok: true, notified: true })
      queue.enqueue(makeEntry("sess-1", "req-1"))
      queue.start(sender)
      await vi.advanceTimersByTimeAsync(600)
      expect(queue.size()).toBe(0)
    })
  })
})
