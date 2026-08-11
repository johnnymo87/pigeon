import { describe, expect, test, vi } from "vitest"
import { MessageTail } from "../src/message-tail"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * pigeon-pre9 item 1 — messageRoles is written on every message.updated and pruned only by
 * clear(), which runs on session end or 24h staleness. A single long-lived active session is
 * never cleared, so the map grows for the life of the process.
 */
describe("pre9/1 — messageRoles is bounded for a long-lived session", () => {
  test("stays bounded after thousands of messages in one never-cleared session", () => {
    const tail = new MessageTail()

    for (let i = 0; i < 5_000; i++) {
      tail.onMessageUpdated({
        id: `msg-${i}`,
        sessionID: "ses-long-lived",
        role: i % 2 === 0 ? "user" : "assistant",
      })
    }

    const size = (tail as unknown as { messageRoles: Map<string, unknown> }).messageRoles.size
    expect(size).toBeLessThanOrEqual(2_000)
  })

  /**
   * Positive control. A bound is trivially satisfiable by discarding everything, which would
   * silently break role lookup and re-open the assistant-leak vector.
   *
   * The behavioural half of this assertion is NOT sufficient on its own, and adversarial review
   * proved it: with pruneMessageRoles replaced by messageRoles.clear(), the mirror still posts,
   * because a user message with no role entry reaches the same flush via the
   * `roleInfo === undefined` fallback. Role presence is behaviourally invisible for user
   * messages. The white-box assertion below is what actually discriminates.
   */
  test("recent roles still resolve after eviction has kicked in", async () => {
    const posted: Array<{ sessionId: string; messageId: string; text: string }> = []
    const tail = new MessageTail({
      debounceMs: 5,
      postMirror: async (p) => {
        posted.push(p)
      },
    })

    for (let i = 0; i < 5_000; i++) {
      tail.onMessageUpdated({ id: `msg-${i}`, sessionID: "ses-long-lived", role: "assistant" })
    }

    // A brand-new user message, recorded after the bound was reached.
    tail.onMessageUpdated({ id: "msg-recent", sessionID: "ses-long-lived", role: "user" })
    tail.onPartUpdated({
      id: "part-recent",
      sessionID: "ses-long-lived",
      messageID: "msg-recent",
      type: "text",
      text: "still here",
    })

    await sleep(40)

    const roles = (tail as unknown as {
      messageRoles: Map<string, { role: string }>
    }).messageRoles
    expect(roles.get("msg-recent")?.role).toBe("user")

    expect(posted).toHaveLength(1)
    expect(posted[0]?.text).toBe("still here")
  })

  /**
   * The leak that adversarial review found in the first version of this fix, pinned so it cannot
   * come back. An assistant message is protected only while it is its session's currentMessageId;
   * the next assistant message drops that protection. Under creation-ordered eviction the
   * just-finished message was then the OLDEST unprotected entry, so a single further insert
   * evicted it, and a late text part for it flushed assistant output as a user mirror.
   *
   * Recency refresh (delete-then-set in onMessageUpdated) is what defeats this: after its last
   * update the message sits at the newest end, so eviction cannot reach it until
   * MAX_MESSAGE_ROLES further updates have occurred.
   */
  test("a superseded assistant message is not evicted straight into a user mirror", async () => {
    const posted: Array<{ messageId: string; text: string }> = []
    const tail = new MessageTail({
      debounceMs: 5,
      postMirror: async (p) => {
        posted.push(p)
      },
    })

    // A1 streams throughout the flood: message.updated re-fires for it as deltas arrive, which
    // is what a long assistant turn looks like on a busy multi-session host.
    tail.onMessageUpdated({ id: "A1", sessionID: "ses-p", role: "assistant" })
    for (let i = 0; i < 2_500; i++) {
      tail.onMessageUpdated({ id: `peer-${i}`, sessionID: "ses-peer", role: "assistant" })
      if (i % 100 === 0) {
        tail.onMessageUpdated({ id: "A1", sessionID: "ses-p", role: "assistant" })
      }
    }
    // A1's final update, at completion.
    tail.onMessageUpdated({ id: "A1", sessionID: "ses-p", role: "assistant" })

    // A2 supersedes A1: A1 is no longer currentMessageId, so the skip no longer covers it.
    tail.onMessageUpdated({ id: "A2", sessionID: "ses-p", role: "assistant" })
    tail.onMessageUpdated({ id: "peer-extra", sessionID: "ses-peer", role: "assistant" })

    // A late text part for A1 must never be mirrored as user text.
    tail.onPartUpdated(
      { id: "part-late", sessionID: "ses-p", messageID: "A1", type: "text" },
      "ASSISTANT OUTPUT",
    )
    await sleep(40)

    expect(posted).toHaveLength(0)
  })

  /**
   * The accepted residual, documented rather than left implicit. Recency refresh bounds the
   * exposure to "MAX_MESSAGE_ROLES further message updates after this message's last activity";
   * it does not eliminate it. A part arriving after that window still finds no role entry.
   *
   * This test asserts the eviction, NOT that the outcome is safe — it exists so that anyone who
   * later widens the window, or removes the cap, can see exactly what the cap costs. The trade
   * was judged acceptable because reaching it requires 2000+ message updates across all sessions
   * between a message's last delta and a straggler part for it.
   */
  test("documents the residual: an entry IS evicted once the window is exceeded", () => {
    const tail = new MessageTail()

    tail.onMessageUpdated({ id: "A1", sessionID: "ses-p", role: "assistant" })
    tail.onMessageUpdated({ id: "A2", sessionID: "ses-p", role: "assistant" })
    for (let i = 0; i < 2_500; i++) {
      tail.onMessageUpdated({ id: `peer-${i}`, sessionID: "ses-peer", role: "assistant" })
    }

    const roles = (tail as unknown as { messageRoles: Map<string, unknown> }).messageRoles
    expect(roles.has("A1")).toBe(false)
    // A2 is ses-p's in-flight message, so the skip protects it regardless of age.
    expect(roles.has("A2")).toBe(true)
  })

  /**
   * The in-flight assistant message must survive eviction. If its role entry is dropped while
   * parts are still arriving, onPartUpdated falls into the roleInfo === undefined branch and
   * buffers assistant deltas as a user mirror — precisely the leak item 4 exists to guard.
   */
  test("never evicts the role of a session's in-flight assistant message", async () => {
    const posted: Array<{ text: string }> = []
    const tail = new MessageTail({
      debounceMs: 5,
      postMirror: async (p) => {
        posted.push(p)
      },
    })

    tail.onMessageUpdated({ id: "msg-open", sessionID: "ses-p", role: "assistant" })

    // Flood past the cap while msg-open is still the current assistant message.
    for (let i = 0; i < 5_000; i++) {
      tail.onMessageUpdated({ id: `filler-${i}`, sessionID: "ses-other", role: "assistant" })
    }

    const roles = (tail as unknown as {
      messageRoles: Map<string, { role: string }>
    }).messageRoles
    expect(roles.get("msg-open")?.role).toBe("assistant")

    // And behaviourally: a late delta for it accumulates as assistant text, never as a mirror.
    tail.onPartUpdated(
      { id: "part-open", sessionID: "ses-p", messageID: "msg-open", type: "text" },
      "assistant words",
    )
    await sleep(40)

    expect(posted).toHaveLength(0)
    expect(tail.getSummary("ses-p")).toContain("assistant words")
  })
})

/**
 * pigeon-pre9 item 4 — the buffer-cancel at message-tail.ts is the only guard on the
 * assistant-leak vector (a part arriving >500ms before its message.updated would flush
 * assistant deltas as a user mirror). It is currently invisible in the logs, so we cannot
 * tell whether that vector is dormant or firing daily.
 */
describe("pre9/4 — the assistant buffer-cancel is observable", () => {
  test("logs when an assistant message.updated cancels a pending user buffer", async () => {
    const log = vi.fn()
    const posted: Array<{ text: string }> = []
    const tail = new MessageTail({
      debounceMs: 50,
      log,
      postMirror: async (p) => {
        posted.push(p)
      },
    })

    // Part arrives before its message.updated, so it is provisionally buffered as user text.
    tail.onPartUpdated({
      id: "part-1",
      sessionID: "ses-x",
      messageID: "msg-late",
      type: "text",
      text: "assistant text misread as user",
    })

    // message.updated then reveals it was an assistant message: the guard fires.
    tail.onMessageUpdated({ id: "msg-late", sessionID: "ses-x", role: "assistant" })

    await sleep(120)

    expect(posted).toHaveLength(0)
    expect(log).toHaveBeenCalled()
    const logged = log.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(logged).toMatch(/cancel/i)
    expect(logged).toContain("msg-late")
    expect(logged).toContain("ses-x")
  })

  /**
   * Positive control for the assertion above. `posted` being empty proves the guard fired only
   * if the same setup WITHOUT the assistant message.updated does produce a mirror. Item D's
   * review found six tests that all passed with mirroring globally disabled; this is that
   * lesson applied.
   */
  test("the same buffer DOES mirror when no assistant message.updated cancels it", async () => {
    const log = vi.fn()
    const posted: Array<{ text: string }> = []
    const tail = new MessageTail({
      debounceMs: 50,
      log,
      postMirror: async (p) => {
        posted.push(p)
      },
    })

    tail.onPartUpdated({
      id: "part-1",
      sessionID: "ses-x",
      messageID: "msg-late",
      type: "text",
      text: "genuine user prompt",
    })

    await sleep(120)

    expect(posted).toHaveLength(1)
    expect(posted[0]?.text).toBe("genuine user prompt")
    const logged = log.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(logged).not.toMatch(/cancel/i)
  })
})
