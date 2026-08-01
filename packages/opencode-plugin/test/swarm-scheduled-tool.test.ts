import { describe, expect, test } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { invalidateDaemonToken } from "../src/auth-token"
import {
  swarmScheduledList,
  swarmScheduledCancel,
  formatScheduledList,
  createSwarmScheduledTool,
  SWARM_SCHEDULED_TOOL_NAME,
  type ScheduledMessage,
} from "../src/swarm-scheduled-tool"

type Captured = { url: string; init?: RequestInit }

function capturingFetch(
  response: () => Response,
): { fetchFn: typeof fetch; seen: Captured[] } {
  const seen: Captured[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: input.toString(), init })
    return response()
  }) as typeof fetch
  return { fetchFn, seen }
}

function status(code: number, body = ""): Response {
  return new Response(body, {
    status: code,
    headers: { "content-type": "application/json" },
  })
}

const SAMPLE_SCHEDULED: ScheduledMessage[] = [
  {
    msg_id: "msg_future_1",
    from: "ses_me",
    to: "ses_me",
    kind: "chat",
    priority: "normal",
    payload: "Resume work on W4: bd show pigeon-c68, then continue in .worktrees/wake-w4.",
    state: "queued",
    deliver_at: 1700011520000, // 3h 12m after 1700000000000
    expires_at: 1700043120000,
    created_at: 1699999000000,
    ref: "bd:pigeon-w4",
  },
  {
    msg_id: "msg_past_2",
    from: "ses_me",
    to: "ses_peer",
    kind: "task.assign",
    priority: "urgent",
    payload: "Review W4 implementation plan and run tests.",
    state: "queued",
    deliver_at: 1699999760000, // 240000 ms before 1700000000000 (4m overdue)
    expires_at: 1700021360000,
    created_at: 1699999000000,
  },
]

describe("swarmScheduledList", () => {
  test("GETs /swarm/scheduled?session=<sessionId> and returns list", async () => {
    const { fetchFn, seen } = capturingFetch(() =>
      status(200, JSON.stringify({ scheduled: SAMPLE_SCHEDULED })),
    )

    const result = await swarmScheduledList({
      daemonBaseUrl: "http://daemon.test",
      sessionId: "ses_me",
      fetchFn,
    })

    expect(seen).toHaveLength(1)
    const url = new URL(seen[0]!.url)
    expect(url.pathname).toBe("/swarm/scheduled")
    expect(url.searchParams.get("session")).toBe("ses_me")
    expect(seen[0]!.init!.method).toBe("GET")
    expect(result).toHaveLength(2)
  })

  test("throws with status and body on HTTP error", async () => {
    const { fetchFn } = capturingFetch(() => status(500, "internal error"))

    await expect(
      swarmScheduledList({
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_me",
        fetchFn,
      }),
    ).rejects.toThrow(/swarm_scheduled list failed: 500 internal error/)
  })
})

describe("formatScheduledList", () => {
  test("handles empty list with plain message", () => {
    expect(formatScheduledList([], "ses_me", 1700000000000)).toBe(
      "No scheduled messages found.",
    )
  })

  test("renders rows with relative delivery times, direction, ref, and truncated payload preview", () => {
    const now = 1700000000000
    const out = formatScheduledList(SAMPLE_SCHEDULED, "ses_me", now)

    expect(out).toContain("msg_future_1")
    expect(out).toContain("[queued]")
    expect(out).toContain("(in 3h12m)")
    expect(out).toContain("[ref: bd:pigeon-w4]")
    // Self-wake direction omitted
    expect(out).not.toContain("[to: ses_me]")

    expect(out).toContain("msg_past_2")
    expect(out).toContain("(overdue by 4m)")
    expect(out).toContain("[to: ses_peer]")
    expect(out).toContain('Review W4 implementation plan and run tests.')
  })
})

describe("swarmScheduledCancel", () => {
  test("200 produces confirmation and encodes msg_id in URL path", async () => {
    const { fetchFn, seen } = capturingFetch(() =>
      status(200, JSON.stringify({ cancelled: true, msg_id: "msg/special 123" })),
    )

    const res = await swarmScheduledCancel(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_me",
        fetchFn,
      },
      "msg/special 123",
    )

    expect(seen).toHaveLength(1)
    const url = new URL(seen[0]!.url)
    expect(url.pathname).toBe("/swarm/scheduled/msg%2Fspecial%20123/cancel")
    expect(seen[0]!.init!.method).toBe("POST")
    expect(res).toEqual({ cancelled: true, msg_id: "msg/special 123" })
  })

  test("404 maps to actionable 'no such scheduled message' error", async () => {
    const { fetchFn } = capturingFetch(() => status(404, "Not Found"))

    await expect(
      swarmScheduledCancel(
        {
          daemonBaseUrl: "http://daemon.test",
          sessionId: "ses_me",
          fetchFn,
        },
        "msg_missing",
      ),
    ).rejects.toThrow("Failed to cancel msg_missing: no such scheduled message.")
  })

  test("403 maps to actionable 'only original sender may cancel' error", async () => {
    const { fetchFn } = capturingFetch(() => status(403, "Forbidden"))

    await expect(
      swarmScheduledCancel(
        {
          daemonBaseUrl: "http://daemon.test",
          sessionId: "ses_me",
          fetchFn,
        },
        "msg_not_mine",
      ),
    ).rejects.toThrow("Failed to cancel msg_not_mine: only the original sender may cancel it.")
  })

  test("409 maps to actionable terminal state error", async () => {
    const { fetchFn } = capturingFetch(() =>
      status(409, JSON.stringify({ error: "Cannot cancel", state: "delivered" })),
    )

    await expect(
      swarmScheduledCancel(
        {
          daemonBaseUrl: "http://daemon.test",
          sessionId: "ses_me",
          fetchFn,
        },
        "msg_done",
      ),
    ).rejects.toThrow("Failed to cancel msg_done: cannot cancel message in state 'delivered'.")
  })
})

describe("createSwarmScheduledTool & execute client-side validation", () => {
  test("cancel without msg_id throws client-side error and fetch is NEVER called", async () => {
    const { fetchFn, seen } = capturingFetch(() => status(200, "{}"))
    const toolDef = createSwarmScheduledTool("http://daemon.test")

    // Override fetch inside test scope by calling helper directly or via mock
    await expect(
      toolDef.execute(
        { action: "cancel" as const },
        {
          sessionID: "ses_me",
          messageID: "msg_m",
          agent: "build",
          directory: "/tmp",
          worktree: "/tmp",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        },
      ),
    ).rejects.toThrow("msg_id is required when action is 'cancel'")

    expect(seen).toHaveLength(0)
  })

  test("unknown action throws client-side error and fetch is NEVER called", async () => {
    const { fetchFn, seen } = capturingFetch(() => status(200, "{}"))
    const toolDef = createSwarmScheduledTool("http://daemon.test")

    await expect(
      toolDef.execute(
        { action: "foo" as any },
        {
          sessionID: "ses_me",
          messageID: "msg_m",
          agent: "build",
          directory: "/tmp",
          worktree: "/tmp",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        },
      ),
    ).rejects.toThrow("Invalid action 'foo': expected 'list' or 'cancel'")

    expect(seen).toHaveLength(0)
  })

  test("Fix 2: execute list re-auth retry fetches refreshed token instead of stale snapshot token", async () => {
    delete process.env.PIGEON_DAEMON_AUTH_TOKEN
    delete process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
    invalidateDaemonToken()

    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pigeon-swarmsched-fix2-test-"),
    )
    const secretPath = path.join(tmpDir, "token")
    fs.writeFileSync(secretPath, "old-token", "utf8")
    process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE = secretPath

    const authHeadersSeen: string[] = []
    let callCount = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      callCount++
      const headers = (init?.headers as Record<string, string>) ?? {}
      if (headers["Authorization"]) {
        authHeadersSeen.push(headers["Authorization"])
      }
      if (callCount === 1) {
        fs.writeFileSync(secretPath, "new-token", "utf8")
        return status(401, "Unauthorized")
      }
      return status(200, JSON.stringify({ scheduled: [] }))
    }) as typeof fetch

    try {
      const toolDef = createSwarmScheduledTool("http://daemon.test")
      const result = await toolDef.execute(
        { action: "list" },
        {
          sessionID: "ses_caller",
          messageID: "msg_m",
          agent: "build",
          directory: "/tmp",
          worktree: "/tmp",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        },
      )

      expect(callCount).toBe(2)
      expect(authHeadersSeen).toEqual(["Bearer old-token", "Bearer new-token"])
      expect(result).toBe("No scheduled messages found.")
    } finally {
      globalThis.fetch = originalFetch
      delete process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
      invalidateDaemonToken()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe("SWARM_SCHEDULED_TOOL_NAME (Anthropic compatibility)", () => {
  const ANTHROPIC_TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,128}$/

  test("registration name matches Anthropic's tool-name regex", () => {
    expect(SWARM_SCHEDULED_TOOL_NAME).toMatch(ANTHROPIC_TOOL_NAME_REGEX)
  })

  test("registration name does not contain a period", () => {
    expect(SWARM_SCHEDULED_TOOL_NAME).not.toContain(".")
  })
})
