import { describe, expect, test } from "vitest"
import { StopDeliveryQueue, StopKeyMinter, type StopEntry } from "../src/stop-queue"

function entry(over: Partial<StopEntry> = {}): StopEntry {
  return {
    sessionId: "ses_1",
    notificationId: "s:ses_1:msg_1.1",
    message: "Done",
    label: "test",
    ...over,
  }
}

describe("StopKeyMinter", () => {
  test("mints a key the daemon will accept for that session", () => {
    const minter = new StopKeyMinter()
    const key = minter.mint("ses_abc", "msg_08d11741b001C8hWW55avwVFcK")

    expect(key.startsWith("s:ses_abc:")).toBe(true)
    expect(key).toMatch(/^[A-Za-z0-9_:.-]+$/)
    expect(key.length).toBeLessThanOrEqual(128)
  })

  test("gives two send decisions on the SAME message distinct keys", () => {
    // A late message.updated clears the dedup guard, and the next idle sends the newly
    // accumulated text of the same message. That is a real second notification; a key
    // derived from the message id alone would swallow it.
    const minter = new StopKeyMinter()
    const first = minter.mint("ses_1", "msg_1")
    const second = minter.mint("ses_1", "msg_1")

    expect(first).not.toBe(second)
  })

  test("counts per session", () => {
    const minter = new StopKeyMinter()
    expect(minter.mint("ses_a", "msg_1")).toBe("s:ses_a:msg_1.1")
    expect(minter.mint("ses_b", "msg_1")).toBe("s:ses_b:msg_1.1")
    expect(minter.mint("ses_a", "msg_2")).toBe("s:ses_a:msg_2.2")
  })

  test("sanitises a token that would fail daemon-side validation", () => {
    const minter = new StopKeyMinter()
    const key = minter.mint("ses_1", "error kind/weird")

    expect(key).toMatch(/^[A-Za-z0-9_:.-]+$/)
  })

  test("clamps an absurd token instead of overflowing the length limit", () => {
    const minter = new StopKeyMinter()
    const key = minter.mint("ses_1", "x".repeat(500))

    expect(key.length).toBeLessThanOrEqual(128)
    expect(key.startsWith("s:ses_1:")).toBe(true)
    expect(key.endsWith(".1")).toBe(true)
  })
})

describe("StopDeliveryQueue", () => {
  test("keeps retrying a stop the daemon has not accepted", async () => {
    const q = new StopDeliveryQueue({ log: () => {} })
    let calls = 0
    q.start(async () => {
      calls++
      return "retry"
    })
    q.stop()

    q.enqueue(entry())
    await q.tick()

    expect(calls).toBe(1)
    expect(q.size()).toBe(1)
  })

  test("stops retrying once delivered", async () => {
    const q = new StopDeliveryQueue({ log: () => {} })
    q.start(async () => "success")
    q.stop()

    q.enqueue(entry())
    await q.tick()

    expect(q.size()).toBe(0)
  })

  test("gives up on a session the daemon still refuses after re-registration", async () => {
    const q = new StopDeliveryQueue({ log: () => {} })
    q.start(async () => "unregistered")
    q.stop()

    q.enqueue(entry())
    await q.tick()

    expect(q.size()).toBe(0)
  })

  test("dedups a retry of the same notification id", () => {
    const q = new StopDeliveryQueue({ log: () => {} })
    q.enqueue(entry())
    q.enqueue(entry())

    expect(q.size()).toBe(1)
  })

  test("holds more entries than the question queue, since a serve runs many sessions", () => {
    const evicted: StopEntry[] = []
    const q = new StopDeliveryQueue({ log: () => {}, onEvicted: (e) => evicted.push(e) })

    for (let i = 0; i < 32; i++) {
      q.enqueue(entry({ notificationId: `s:ses_1:m.${i}` }))
    }

    expect(q.size()).toBe(32)
    expect(evicted).toHaveLength(0)

    q.enqueue(entry({ notificationId: "s:ses_1:m.overflow" }))
    expect(evicted).toHaveLength(1)
  })
})
