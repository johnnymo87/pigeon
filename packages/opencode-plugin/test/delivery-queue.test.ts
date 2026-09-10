import { describe, expect, test, vi } from "vitest"
import { DeliveryQueue } from "../src/delivery-queue"

type Entry = { id: string }

function newQueue(overrides: Record<string, unknown> = {}, log: (m: string, d?: unknown) => void = () => {}) {
  return new DeliveryQueue<Entry>({
    name: "test-queue",
    key: (e) => e.id,
    describe: (e) => ({ id: e.id }),
    log,
    ...overrides,
  })
}

describe("DeliveryQueue", () => {
  test("delivers an entry and removes it on success", async () => {
    const q = newQueue()
    const sent: string[] = []
    q.start(async (e) => {
      sent.push(e.id)
      return "success"
    })

    q.enqueue({ id: "a" })
    await q.tick()

    expect(sent).toEqual(["a"])
    expect(q.size()).toBe(0)
    q.stop()
  })

  test("retries a failed entry and keeps it queued", async () => {
    const q = newQueue()
    q.start(async () => "retry")

    q.enqueue({ id: "a" })
    await q.tick()

    expect(q.size()).toBe(1)
    q.stop()
  })

  test("drops an entry on a terminal outcome without waiting for the TTL", async () => {
    const lines: string[] = []
    const q = newQueue({}, (m) => lines.push(m))
    q.start(async () => "terminal")

    q.enqueue({ id: "a" })
    await q.tick()

    expect(q.size()).toBe(0)
    expect(lines.some((l) => l.includes("giving up (terminal)"))).toBe(true)
    q.stop()
  })

  test("never runs two ticks concurrently, so an entry is not sent twice", async () => {
    // The regression this guards: nextAttemptAt is only advanced after the send
    // resolves, so a second tick firing mid-send would snapshot the same entry.
    const q = newQueue()
    let inFlight = 0
    let maxInFlight = 0
    let sends = 0

    q.start(async () => {
      sends++
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 50))
      inFlight--
      return "success"
    })

    q.enqueue({ id: "a" })
    const first = q.tick()
    const second = q.tick() // fires while the first is still awaiting the sender
    await Promise.all([first, second])

    expect(maxInFlight).toBe(1)
    expect(sends).toBe(1)
    q.stop()
  })

  test("dedups an entry that is already queued", async () => {
    const q = newQueue()
    q.start(async () => "retry")

    q.enqueue({ id: "a" })
    q.enqueue({ id: "a" })

    expect(q.size()).toBe(1)
    q.stop()
  })

  test("warns and calls onEvicted when it evicts at capacity", async () => {
    const lines: Array<{ m: string; d?: any }> = []
    const evicted: Entry[] = []
    const q = newQueue({ maxSize: 2, onEvicted: (e: Entry) => evicted.push(e) }, (m, d) =>
      lines.push({ m, d }),
    )

    q.enqueue({ id: "a" })
    q.enqueue({ id: "b" })
    q.enqueue({ id: "c" })

    expect(q.size()).toBe(2)
    expect(evicted.map((e) => e.id)).toEqual(["a"])
    expect(lines.some((l) => l.m.includes("evicted at capacity"))).toBe(true)
    q.stop()
  })

  test("expires an entry past the TTL and reports it", async () => {
    vi.useFakeTimers()
    try {
      const lines: Array<{ m: string; d?: any }> = []
      const expired: Entry[] = []
      const q = newQueue(
        { maxRetryMs: 1000, onExpired: (e: Entry) => expired.push(e) },
        (m, d) => lines.push({ m, d }),
      )
      q.start(async () => "retry")
      // Drop the interval but keep the sender: this test drives tick() by hand, and a
      // background tick started by the fake clock would hold the in-flight guard.
      q.stop()

      q.enqueue({ id: "a" })
      vi.advanceTimersByTime(2000)
      await q.tick()

      expect(q.size()).toBe(0)
      expect(expired.map((e) => e.id)).toEqual(["a"])
      const expiredLine = lines.find((l) => l.m.includes("entry expired"))
      expect(expiredLine).toBeDefined()
      expect(expiredLine!.d.id).toBe("a")
      q.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  test("treats a throwing sender as a retry, not a loss", async () => {
    const q = newQueue()
    q.start(async () => {
      throw new Error("boom")
    })

    q.enqueue({ id: "a" })
    await q.tick()

    expect(q.size()).toBe(1)
    q.stop()
  })
})
