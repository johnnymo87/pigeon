import { describe, expect, test, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import {
  sendStop,
  registerSession,
  _resetBreakerForTesting,
  _resetStopSkewForTesting,
} from "../src/daemon-client"

/**
 * `sendStop` is the breaker-free stop transport used by the stop delivery queue.
 *
 * Everything here is about which outcome a given daemon answer deserves. Getting that
 * wrong in either direction is a real failure: "retry" on something unfixable burns the
 * TTL and then raises a false alarm, while "terminal" on something transient is exactly
 * the silent drop this change exists to remove.
 */

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void

function createTestServer(handler: Handler): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let data = ""
      req.on("data", (c: Buffer) => (data += c.toString()))
      req.on("end", () => handler(req, res, data))
    })
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as import("node:net").AddressInfo
      resolve({ port: addr.port, close: () => server.close() })
    })
  })
}

const DEAD_PORT = 9

describe("sendStop", () => {
  let server: { port: number; close: () => void } | undefined
  let bodies: any[] = []

  beforeEach(() => {
    _resetBreakerForTesting()
    _resetStopSkewForTesting()
    bodies = []
  })

  afterEach(() => {
    server?.close()
    server = undefined
  })

  function opts(port: number, over: Record<string, unknown> = {}) {
    return {
      sessionId: "ses_1",
      notificationId: "s:ses_1:msg_1.0",
      message: "Done",
      label: "test",
      daemonUrl: `http://127.0.0.1:${port}`,
      log: () => {},
      ...over,
    }
  }

  function jsonServer(status: number, payload: unknown) {
    return createTestServer((req, res, body) => {
      bodies.push(body ? JSON.parse(body) : null)
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(payload))
    })
  }

  test("sends the client notification id so a retry cannot duplicate", async () => {
    server = await jsonServer(202, {
      ok: true,
      deliveryState: "queued",
      notificationId: "s:ses_1:msg_1.0",
    })

    const outcome = await sendStop(opts(server.port))

    expect(outcome).toBe("success")
    expect(bodies[0].notification_id).toBe("s:ses_1:msg_1.0")
  })

  test("treats a quieted stop as delivered, not as something to retry", async () => {
    // The daemon answers this for every session under a quiet policy. Retrying it
    // would burn the TTL and then warn about a notification nobody wanted.
    server = await jsonServer(200, { ok: true, notified: false, reason: "quiet_origin" })

    expect(await sendStop(opts(server.port))).toBe("success")
  })

  test("treats notify=false as delivered", async () => {
    server = await jsonServer(200, { ok: true, notified: false, reason: "notify=false" })

    expect(await sendStop(opts(server.port))).toBe("success")
  })

  test("retries a 5xx", async () => {
    server = await jsonServer(500, { error: "boom" })

    expect(await sendStop(opts(server.port))).toBe("retry")
  })

  test("reports 404 separately so the caller can re-register", async () => {
    server = await jsonServer(404, { error: "Session not found" })

    expect(await sendStop(opts(server.port))).toBe("unregistered")
  })

  test("gives up on a 4xx that a retry cannot fix", async () => {
    server = await jsonServer(400, { error: "session_id is required" })

    expect(await sendStop(opts(server.port))).toBe("terminal")
  })

  test("retries when the daemon is not listening", async () => {
    // Connection refused means nothing was processed, so a retry cannot duplicate.
    expect(await sendStop(opts(DEAD_PORT))).toBe("retry")
  })

  test("ignores the circuit breaker", async () => {
    server = await jsonServer(202, { ok: true, deliveryState: "queued" })
    const livePort = server.port

    // Trip the breaker on a different route.
    await registerSession({
      sessionId: "ses_other",
      cwd: "/home/dev",
      label: "x",
      pid: 1,
      ppid: 0,
      daemonUrl: `http://127.0.0.1:${DEAD_PORT}`,
      log: () => {},
    })

    expect(await sendStop(opts(livePort))).toBe("success")
  })

  describe("deploy skew: a daemon that ignores the key", () => {
    test("a timeout is terminal until the daemon has echoed a key", async () => {
      // An old daemon mints its own id per request, so it cannot dedupe our retry.
      // A timeout may mean 'processed'; retrying it would post twice. Today's
      // behaviour (drop) is the safer of the two, so keep it until we have proof.
      server = await createTestServer((req, res) => {
        setTimeout(() => {
          res.writeHead(202, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
        }, 4000)
      })

      expect(await sendStop(opts(server.port))).toBe("terminal")
    }, 10_000)

    test("a timeout is retried once the daemon has echoed a key", async () => {
      let first = true
      server = await createTestServer((req, res) => {
        if (first) {
          first = false
          res.writeHead(202, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true, notificationId: "s:ses_1:msg_1.0" }))
          return
        }
        setTimeout(() => {
          res.writeHead(202, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
        }, 4000)
      })

      expect(await sendStop(opts(server.port))).toBe("success")
      expect(await sendStop(opts(server.port, { notificationId: "s:ses_1:msg_2.0" }))).toBe(
        "retry",
      )
    }, 10_000)

    test("a daemon echoing a DIFFERENT id does not count as proof", async () => {
      server = await createTestServer((req, res) => {
        res.writeHead(202, { "content-type": "application/json" })
        // What an old daemon does: mints its own id, ignoring ours.
        res.end(JSON.stringify({ ok: true, notificationId: "s:ses_1:1789079999999" }))
      })
      const port = server.port

      expect(await sendStop(opts(port))).toBe("success")

      server.close()
      server = await createTestServer((req, res) => {
        setTimeout(() => {
          res.writeHead(202)
          res.end("{}")
        }, 4000)
      })

      expect(await sendStop(opts(server.port))).toBe("terminal")
    }, 15_000)
  })
})
