import { describe, expect, test, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import {
  registerSession,
  notifyQuestionAnswered,
  postMirror,
  _resetBreakerForTesting,
} from "../src/daemon-client"

/**
 * What the circuit breaker is allowed to conclude.
 *
 * It exists for exactly one reason: `ensureRegistered` is AWAITED inside the
 * session.idle / question.asked / session.error handlers, so a daemon that is down
 * would otherwise cost every session a full registration timeout inline. That makes
 * "the daemon is unreachable" the only question it answers.
 *
 * An HTTP response -- any status, including 404 and 500 -- answers that question with
 * "reachable, and it answered fast". Counting those as failures is what let one
 * session's `404 Session not found` silence every other session on the serve for 30s.
 * A truncated body (SyntaxError from res.json()) is the same: headers arrived, so the
 * daemon was reachable. That is literally what opened the breaker in pigeon-mavq.
 */

function createTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as import("node:net").AddressInfo
      resolve({ port: addr.port, close: () => server.close() })
    })
  })
}

/** A port nothing listens on, so connect() is refused immediately. */
const DEAD_PORT = 9

describe("circuit breaker failure classification", () => {
  let server: { port: number; close: () => void } | undefined
  let hits = 0

  beforeEach(() => {
    _resetBreakerForTesting()
    hits = 0
  })

  afterEach(() => {
    server?.close()
    server = undefined
  })

  function regOpts(port: number, log: (m: string, d?: unknown) => void = () => {}) {
    return {
      sessionId: "sess-1",
      cwd: "/home/dev",
      label: "test",
      pid: 1,
      ppid: 0,
      daemonUrl: `http://127.0.0.1:${port}`,
      log,
    }
  }

  test("an HTTP 500 does not open the breaker", async () => {
    server = await createTestServer((_req, res) => {
      hits++
      res.writeHead(500)
      res.end("boom")
    })

    await registerSession(regOpts(server.port))
    await registerSession(regOpts(server.port))

    // Second call still reached the daemon: the breaker stayed closed.
    expect(hits).toBe(2)
  })

  test("an HTTP 404 does not open the breaker", async () => {
    server = await createTestServer((_req, res) => {
      hits++
      res.writeHead(404)
      res.end(JSON.stringify({ error: "Session not found" }))
    })

    await registerSession(regOpts(server.port))
    await registerSession(regOpts(server.port))

    expect(hits).toBe(2)
  })

  test("a truncated JSON body does not open the breaker", async () => {
    server = await createTestServer((_req, res) => {
      hits++
      res.writeHead(200, { "content-type": "application/json" })
      res.end("{") // parses as SyntaxError -- the daemon answered, it just got cut off
    })

    await registerSession(regOpts(server.port))
    await registerSession(regOpts(server.port))

    expect(hits).toBe(2)
  })

  test("a non-2xx from question-answered does not open the breaker", async () => {
    server = await createTestServer((_req, res) => {
      hits++
      res.writeHead(409)
      res.end("{}")
    })

    await notifyQuestionAnswered({
      sessionId: "sess-1",
      daemonUrl: `http://127.0.0.1:${server.port}`,
      log: () => {},
    })
    await registerSession(regOpts(server.port))

    expect(hits).toBe(2)
  })

  test("an unreachable daemon does open the breaker", async () => {
    server = await createTestServer((_req, res) => {
      hits++
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    })
    const livePort = server.port

    // Transport failure: connection refused.
    await registerSession(regOpts(DEAD_PORT))

    // The breaker is now open, so even a healthy daemon is not called.
    const result = await registerSession(regOpts(livePort))
    expect(result).toBeNull()
    expect(hits).toBe(0)
  })

  test("opening the breaker logs the route and reason", async () => {
    const lines: Array<{ msg: string; data?: any }> = []
    await registerSession(
      regOpts(DEAD_PORT, (msg, data) => lines.push({ msg, data })),
    )

    const opened = lines.find((l) => l.msg.includes("breaker opened"))
    expect(opened).toBeDefined()
    expect(opened!.data.route).toBe("/session-start")
    expect(typeof opened!.data.reason).toBe("string")
    expect(typeof opened!.data.openUntil).toBe("number")
  })

  test("registerSession tolerates a daemon slower than one second", async () => {
    server = await createTestServer((_req, res) => {
      hits++
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
      }, 1300)
    })

    const result = await registerSession(regOpts(server.port))

    expect(result).toEqual({ ok: true })
    expect(hits).toBe(1)
  }, 10_000)

  test("postMirror failure does not open the breaker for other routes", async () => {
    server = await createTestServer((_req, res) => {
      hits++
      res.writeHead(500)
      res.end("nope")
    })

    await postMirror({
      sessionId: "sess-1",
      messageId: "msg-1",
      text: "hi",
      daemonUrl: `http://127.0.0.1:${server.port}`,
      log: () => {},
    })
    await registerSession(regOpts(server.port))

    expect(hits).toBe(2)
  })
})
