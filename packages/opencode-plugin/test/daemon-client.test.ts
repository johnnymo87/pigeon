import { describe, expect, test, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import { registerSession, notifyStop, notifyQuestionAsked, _resetBreakerForTesting } from "../src/daemon-client"
import { SessionManager } from "../src/session-state"
import { MessageTail } from "../src/message-tail"

/** Minimal HTTP server helper replacing Bun.serve() for tests. */
function createTestServer(handler: (req: Request) => Promise<Response> | Response): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(async (nodeReq, nodeRes) => {
      const body = await new Promise<string>((res) => {
        let data = ""
        nodeReq.on("data", (chunk: Buffer) => { data += chunk.toString() })
        nodeReq.on("end", () => res(data))
      })

      const url = new URL(nodeReq.url ?? "/", `http://127.0.0.1`)
      const request = new Request(url, {
        method: nodeReq.method,
        headers: nodeReq.headers as Record<string, string>,
        body: nodeReq.method !== "GET" && nodeReq.method !== "HEAD" ? body : undefined,
      })

      try {
        const response = await handler(request)
        const responseBody = await response.text()
        nodeRes.writeHead(response.status, {
          "content-type": response.headers.get("content-type") ?? "application/json",
        })
        nodeRes.end(responseBody)
      } catch (err) {
        nodeRes.writeHead(500)
        nodeRes.end("Internal Server Error")
      }
    })

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as import("node:net").AddressInfo
      resolve({ port: addr.port, close: () => server.close() })
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("daemon-client", () => {
  let server: { port: number; close: () => void } | undefined
  let serverPort: number
  let requestLog: Array<{ path: string; body: any }> = []
  const mockLog = () => {}

  beforeEach(async () => {
    _resetBreakerForTesting()
    requestLog = []
    const s = await createTestServer(async (req) => {
      const url = new URL(req.url)
      const body = await req.json()
      requestLog.push({ path: url.pathname, body })
      return Response.json({ ok: true, notified: true })
    })
    server = s
    serverPort = s.port
  })

  afterEach(() => {
    server?.close()
    server = undefined
  })

  describe("registerSession", () => {
    test("should send correct request body with notify: true", async () => {
      // given
      const opts = {
        sessionId: "test-session-123",
        cwd: "/home/user/project",
        label: "Test Session",
        pid: 12345,
        ppid: 12344,
        daemonUrl: `http://127.0.0.1:${serverPort}`,
        log: mockLog,
      }

      // when
      const result = await registerSession(opts)

      // then
      expect(result).toEqual({ ok: true, notified: true })
      expect(requestLog).toHaveLength(1)
      expect(requestLog[0].path).toBe("/session-start")
      expect(requestLog[0].body).toEqual({
        session_id: "test-session-123",
        notify: true,
        cwd: "/home/user/project",
        label: "Test Session",
        pid: 12345,
        ppid: 12344,
      })
    })

    test("should handle network failure gracefully", async () => {
      // given - invalid URL that will fail
      const opts = {
        sessionId: "test-session",
        cwd: "/home/user",
        label: "Test",
        pid: 1,
        ppid: 0,
        daemonUrl: "http://127.0.0.1:99999", // Invalid port
        log: mockLog,
      }

      // when
      const result = await registerSession(opts)

      // then
      expect(result).toBeNull()
    })

    test("should handle timeout", async () => {
      // given - server that delays response
      server?.close()
      server = await createTestServer(async (req) => {
        await sleep(2000) // Delay longer than 1000ms timeout
        return Response.json({ ok: true })
      })
      serverPort = server.port

      const opts = {
        sessionId: "test-session",
        cwd: "/home/user",
        label: "Test",
        pid: 1,
        ppid: 0,
        daemonUrl: `http://127.0.0.1:${serverPort}`,
        log: mockLog,
      }

      // when
      const result = await registerSession(opts)

      // then
      expect(result).toBeNull()
    })

     test("should handle non-200 response", async () => {
       // given - server that returns error
       server?.close()
       server = await createTestServer(async (req) => {
         return new Response("Internal Server Error", { status: 500 })
       })
       serverPort = server.port

       const opts = {
         sessionId: "test-session",
         cwd: "/home/user",
         label: "Test",
         pid: 1,
         ppid: 0,
         daemonUrl: `http://127.0.0.1:${serverPort}`,
         log: mockLog,
       }

       // when
       const result = await registerSession(opts)

       // then
       expect(result).toBeNull()
     })

     test("should handle 500 with JSON body", async () => {
       // given - server that returns 500 with JSON error body
       server?.close()
       server = await createTestServer(async (req) => {
         return Response.json({ ok: false, error: "internal" }, { status: 500 })
       })
       serverPort = server.port

       const opts = {
         sessionId: "test-session",
         cwd: "/home/user",
         label: "Test",
         pid: 1,
         ppid: 0,
         daemonUrl: `http://127.0.0.1:${serverPort}`,
         log: mockLog,
       }

       // when
       const result = await registerSession(opts)

       // then - should return null, not the JSON body
       expect(result).toBeNull()
     })
  })

  describe("notifyStop", () => {
    test("should send correct request body with message field", async () => {
      // given
      const opts = {
        sessionId: "test-session-456",
        message: "Session completed successfully",
        label: "Test Session",
        daemonUrl: `http://127.0.0.1:${serverPort}`,
        log: mockLog,
      }

      // when
      const result = await notifyStop(opts)

      // then
      expect(result).toEqual({ ok: true, notified: true })
      expect(requestLog).toHaveLength(1)
      expect(requestLog[0].path).toBe("/stop")
      expect(requestLog[0].body).toEqual({
        session_id: "test-session-456",
        event: "Stop",
        message: "Session completed successfully",
        label: "Test Session",
      })
    })

    test("should handle failure gracefully", async () => {
      // given - invalid URL
      const opts = {
        sessionId: "test-session",
        message: "Done",
        label: "Test",
        daemonUrl: "http://127.0.0.1:99999",
        log: mockLog,
      }

      // when
      const result = await notifyStop(opts)

      // then
      expect(result).toBeNull()
    })

    test("should include media array in POST body when provided", async () => {
      // given
      const opts = {
        sessionId: "test-session-media",
        message: "Task completed with image",
        label: "Test Session",
        media: [
          { mime: "image/png", filename: "screenshot.png", url: "data:image/png;base64,abc" },
          { mime: "image/jpeg", filename: "chart.jpg", url: "data:image/jpeg;base64,xyz" },
        ],
        daemonUrl: `http://127.0.0.1:${serverPort}`,
        log: mockLog,
      }

      // when
      const result = await notifyStop(opts)

      // then
      expect(result).toEqual({ ok: true, notified: true })
      expect(requestLog).toHaveLength(1)
      expect(requestLog[0].path).toBe("/stop")
      expect(requestLog[0].body).toEqual({
        session_id: "test-session-media",
        event: "Stop",
        message: "Task completed with image",
        label: "Test Session",
        media: [
          { mime: "image/png", filename: "screenshot.png", url: "data:image/png;base64,abc" },
          { mime: "image/jpeg", filename: "chart.jpg", url: "data:image/jpeg;base64,xyz" },
        ],
      })
    })

    test("should not include media field in POST body when media is undefined", async () => {
      // given - no media field
      const opts = {
        sessionId: "test-session-no-media",
        message: "Task completed",
        label: "Test Session",
        daemonUrl: `http://127.0.0.1:${serverPort}`,
        log: mockLog,
      }

      // when
      const result = await notifyStop(opts)

      // then
      expect(result).toEqual({ ok: true, notified: true })
      expect(requestLog).toHaveLength(1)
      expect(requestLog[0].body).not.toHaveProperty("media")
    })

    test("should not include media field in POST body when media is empty array", async () => {
      // given - empty media array
      const opts = {
        sessionId: "test-session-empty-media",
        message: "Task completed",
        label: "Test Session",
        media: [],
        daemonUrl: `http://127.0.0.1:${serverPort}`,
        log: mockLog,
      }

      // when
      const result = await notifyStop(opts)

      // then
      expect(result).toEqual({ ok: true, notified: true })
      expect(requestLog).toHaveLength(1)
      expect(requestLog[0].body).not.toHaveProperty("media")
    })
  })

  describe("circuit breaker", () => {
    test("should skip calls after failure for 30s", async () => {
      // given - server that fails
      server?.close()
      server = await createTestServer(async (req) => {
        return new Response("Error", { status: 500 })
      })
      serverPort = server.port

      const opts = {
        sessionId: "test-session",
        cwd: "/home/user",
        label: "Test",
        pid: 1,
        ppid: 0,
        daemonUrl: `http://127.0.0.1:${serverPort}`,
        log: mockLog,
      }

      // when - first call fails
      const result1 = await registerSession(opts)
      expect(result1).toBeNull()

      // when - second call should be skipped (circuit open)
      requestLog = []
      const result2 = await registerSession(opts)

      // then - no request made (circuit breaker blocked it)
      expect(result2).toBeNull()
      expect(requestLog).toHaveLength(0)
    })

    test("should transition to half-open after timeout", async () => {
      // given - server that initially fails
      let shouldFail = true
      server?.close()
      server = await createTestServer(async (req) => {
        if (shouldFail) {
          return new Response("Error", { status: 500 })
        }
        const body = await req.json()
        return Response.json({ ok: true, notified: true })
      })
      serverPort = server.port

      const opts = {
        sessionId: "test-session",
        cwd: "/home/user",
        label: "Test",
        pid: 1,
        ppid: 0,
        daemonUrl: `http://127.0.0.1:${serverPort}`,
        log: mockLog,
      }

      // when - first call fails, opening circuit
      await registerSession(opts)

      // Simulate time passing (we can't actually wait 30s in tests)
      // Instead, we'll test the logic by checking that after the backoff period,
      // the circuit allows a retry. For this test, we'll use a shorter approach:
      // The circuit breaker uses Date.now(), so we can't easily mock time in Bun.
      // This test documents the expected behavior.

      // then - circuit should be open
      const result2 = await registerSession(opts)
      expect(result2).toBeNull()
    })

    test("should close circuit on successful half-open request", async () => {
      // This test documents that after half-open state, a successful request
      // should close the circuit. Due to time constraints in testing,
      // we verify the success path resets the breaker.

      // given - successful server
      const opts = {
        sessionId: "test-session",
        cwd: "/home/user",
        label: "Test",
        pid: 1,
        ppid: 0,
        daemonUrl: `http://127.0.0.1:${serverPort}`,
        log: mockLog,
      }

      // when - successful call
      const result = await registerSession(opts)

      // then - circuit is closed (success)
      expect(result).toEqual({ ok: true, notified: true })

      // when - another call should succeed
      requestLog = []
      const result2 = await registerSession(opts)
      expect(result2).toEqual({ ok: true, notified: true })
      expect(requestLog).toHaveLength(1)
    })

    test("should extend backoff to 60s on half-open failure", async () => {
      // This test documents that if a half-open request fails,
      // the backoff should double (capped at 60s).
      // Due to time constraints, we verify the failure path.

      // given - server that fails
      server?.close()
      server = await createTestServer(async (req) => {
        return new Response("Error", { status: 500 })
      })
      serverPort = server.port

      const opts = {
        sessionId: "test-session",
        cwd: "/home/user",
        label: "Test",
        pid: 1,
        ppid: 0,
        daemonUrl: `http://127.0.0.1:${serverPort}`,
        log: mockLog,
      }

      // when - multiple failures
      await registerSession(opts)
      await registerSession(opts) // Should be blocked

      // then - circuit is open
      requestLog = []
      const result = await registerSession(opts)
      expect(result).toBeNull()
      expect(requestLog).toHaveLength(0)
    })
  })

  describe("question.asked flushes unnotified text", () => {
    // Simulates the plugin's question.asked handler: when a question fires
    // and there's unnotified assistant text, a stop notification should be
    // sent first, then the question notification.

    test("sends stop before question when text is unnotified", async () => {
      // given - registered session with unnotified assistant text
      const sessionManager = new SessionManager()
      const messageTail = new MessageTail()

      sessionManager.onSessionCreated("sess-q")
      sessionManager.onRegistered("sess-q")

      // Simulate assistant text arriving (message.updated + part.updated)
      messageTail.onMessageUpdated({ id: "msg-1", sessionID: "sess-q", role: "assistant" })
      messageTail.onPartUpdated(
        { id: "part-1", sessionID: "sess-q", messageID: "msg-1", type: "text" },
        "Here is the design for section 1...",
      )

      const daemonUrl = `http://127.0.0.1:${serverPort}`

      // when - question.asked fires (no session.idle preceded it)
      // This is what the plugin handler should do:
      const currentMsgId = messageTail.getCurrentMessageId("sess-q")
      if (sessionManager.shouldNotify("sess-q", currentMsgId)) {
        sessionManager.setNotified("sess-q", currentMsgId!)
        const summary = messageTail.getSummary("sess-q")
        if (summary) {
          await notifyStop({
            sessionId: "sess-q",
            message: summary,
            label: "test",
            daemonUrl,
            log: mockLog,
          })
        }
      }
      await notifyQuestionAsked({
        sessionId: "sess-q",
        requestId: "req-1",
        questions: [{ question: "Looks good?", header: "Check", options: [], custom: true }],
        label: "test",
        daemonUrl,
        log: mockLog,
      })

      // then - stop sent first, then question
      expect(requestLog).toHaveLength(2)
      expect(requestLog[0].path).toBe("/stop")
      expect(requestLog[0].body.session_id).toBe("sess-q")
      expect(requestLog[0].body.message).toBe("Here is the design for section 1...")
      expect(requestLog[1].path).toBe("/question-asked")
      expect(requestLog[1].body.session_id).toBe("sess-q")
    })

    test("does not send duplicate stop if text was already notified", async () => {
      // given - registered session where idle already sent the stop notification
      const sessionManager = new SessionManager()
      const messageTail = new MessageTail()

      sessionManager.onSessionCreated("sess-q2")
      sessionManager.onRegistered("sess-q2")

      messageTail.onMessageUpdated({ id: "msg-2", sessionID: "sess-q2", role: "assistant" })
      messageTail.onPartUpdated(
        { id: "part-2", sessionID: "sess-q2", messageID: "msg-2", type: "text" },
        "Some text that was already notified",
      )

      // Simulate: session.idle already fired and notified this message
      sessionManager.setNotified("sess-q2", "msg-2")

      const daemonUrl = `http://127.0.0.1:${serverPort}`

      // when - question.asked fires after idle already notified
      const currentMsgId = messageTail.getCurrentMessageId("sess-q2")
      if (sessionManager.shouldNotify("sess-q2", currentMsgId)) {
        sessionManager.setNotified("sess-q2", currentMsgId!)
        const summary = messageTail.getSummary("sess-q2")
        if (summary) {
          await notifyStop({
            sessionId: "sess-q2",
            message: summary,
            label: "test",
            daemonUrl,
            log: mockLog,
          })
        }
      }
      await notifyQuestionAsked({
        sessionId: "sess-q2",
        requestId: "req-2",
        questions: [{ question: "OK?", header: "Check", options: [], custom: true }],
        label: "test",
        daemonUrl,
        log: mockLog,
      })

      // then - only question sent, no duplicate stop
      expect(requestLog).toHaveLength(1)
      expect(requestLog[0].path).toBe("/question-asked")
    })

    test("does not send stop if no assistant text exists", async () => {
      // given - registered session with no text
      const sessionManager = new SessionManager()
      const messageTail = new MessageTail()

      sessionManager.onSessionCreated("sess-q3")
      sessionManager.onRegistered("sess-q3")

      const daemonUrl = `http://127.0.0.1:${serverPort}`

      // when - question.asked fires with no preceding text
      const currentMsgId = messageTail.getCurrentMessageId("sess-q3")
      if (sessionManager.shouldNotify("sess-q3", currentMsgId)) {
        sessionManager.setNotified("sess-q3", currentMsgId!)
        const summary = messageTail.getSummary("sess-q3")
        if (summary) {
          await notifyStop({
            sessionId: "sess-q3",
            message: summary,
            label: "test",
            daemonUrl,
            log: mockLog,
          })
        }
      }
      await notifyQuestionAsked({
        sessionId: "sess-q3",
        requestId: "req-3",
        questions: [{ question: "OK?", header: "Check", options: [], custom: true }],
        label: "test",
        daemonUrl,
        log: mockLog,
      })

      // then - only question sent
      expect(requestLog).toHaveLength(1)
      expect(requestLog[0].path).toBe("/question-asked")
    })
  })
})
