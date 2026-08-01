import { describe, expect, test } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { invalidateDaemonToken } from "../src/auth-token"
import {
  swarmSchedule,
  formatScheduleResult,
  createSwarmScheduleTool,
  ScheduleRejectedError,
  SWARM_SCHEDULE_TOOL_NAME,
  SWARM_SCHEDULE_MAX_ATTEMPTS,
  SWARM_SCHEDULE_INITIAL_BACKOFF_MS,
  SWARM_SCHEDULE_BACKOFF_FACTOR,
  SWARM_SCHEDULE_MAX_BACKOFF_MS,
  type SwarmScheduleResult,
} from "../src/swarm-schedule-tool"

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

function ok202(
  msgId = "msg_sched_xyz",
  deliverAt = 1700000000000,
  expiresAt = 1700021600000,
): Response {
  return new Response(
    JSON.stringify({
      accepted: true,
      msg_id: msgId,
      deliver_at: deliverAt,
      expires_at: expiresAt,
    }),
    {
      status: 202,
      headers: { "content-type": "application/json" },
    },
  )
}

function bodyOf(c: Captured): Record<string, unknown> {
  return JSON.parse(c.init!.body as string) as Record<string, unknown>
}

function headersOf(c: Captured): Record<string, string> {
  return (c.init!.headers as Record<string, string>) ?? {}
}

function scriptFetch(steps: Array<() => Response>): {
  fetchFn: typeof fetch
  seen: Captured[]
} {
  const seen: Captured[] = []
  let i = 0
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: input.toString(), init })
    const step = steps[Math.min(i, steps.length - 1)]!
    i++
    return step()
  }) as typeof fetch
  return { fetchFn, seen }
}

function status(code: number, body = ""): Response {
  return new Response(body, {
    status: code,
    headers: { "content-type": "application/json" },
  })
}

const noSleep = async (): Promise<void> => {}

describe("swarmSchedule (pure helper)", () => {
  test("to defaults to calling session when omitted", async () => {
    const { fetchFn, seen } = capturingFetch(() => ok202())

    const result = await swarmSchedule(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_caller",
        fetchFn,
      },
      {
        message: "Resume work on W4: bd show pigeon-c68 and continue.",
        after: "30m",
      },
    )

    expect(seen).toHaveLength(1)
    const body = bodyOf(seen[0]!)
    expect(body.from).toBe("ses_caller")
    expect(body.to).toBe("ses_caller")
    expect(result.to).toBe("ses_caller")
  })

  test("explicit to overrides default calling session", async () => {
    const { fetchFn, seen } = capturingFetch(() => ok202())

    const result = await swarmSchedule(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_caller",
        fetchFn,
      },
      {
        to: "ses_other",
        message: "Resume work on W4: bd show pigeon-c68 and continue.",
        after: "30m",
      },
    )

    expect(seen).toHaveLength(1)
    const body = bodyOf(seen[0]!)
    expect(body.from).toBe("ses_caller")
    expect(body.to).toBe("ses_other")
    expect(result.to).toBe("ses_other")
  })

  test("both at and after given -> client-side error and fetch NEVER called", async () => {
    const { fetchFn, seen } = capturingFetch(() => ok202())

    await expect(
      swarmSchedule(
        {
          daemonBaseUrl: "http://daemon.test",
          sessionId: "ses_caller",
          fetchFn,
        },
        {
          message: "Resume work on W4: bd show pigeon-c68 and continue.",
          at: "09:00",
          after: "30m",
        },
      ),
    ).rejects.toThrow("Exactly one of 'at' or 'after' must be provided.")

    expect(seen).toHaveLength(0)
  })

  test("neither at nor after given -> client-side error and fetch NEVER called", async () => {
    const { fetchFn, seen } = capturingFetch(() => ok202())

    await expect(
      swarmSchedule(
        {
          daemonBaseUrl: "http://daemon.test",
          sessionId: "ses_caller",
          fetchFn,
        },
        {
          message: "Resume work on W4: bd show pigeon-c68 and continue.",
        },
      ),
    ).rejects.toThrow("Exactly one of 'at' or 'after' must be provided.")

    expect(seen).toHaveLength(0)
  })

  test("msg_id is minted once and is IDENTICAL across retries", async () => {
    const { fetchFn, seen } = scriptFetch([
      () => status(500, "internal server error"),
      () => ok202("msg_fixed_id"),
    ])

    const result = await swarmSchedule(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_caller",
        fetchFn,
        sleepFn: noSleep,
        makeMsgId: () => "msg_fixed_id",
      },
      {
        message: "Resume work on W4: bd show pigeon-c68 and continue.",
        after: "1h",
      },
    )

    expect(seen).toHaveLength(2)
    const bodies = seen.map(bodyOf)
    expect(bodies[0]!.msg_id).toBe("msg_fixed_id")
    expect(bodies[1]!.msg_id).toBe("msg_fixed_id")
    expect(result.msg_id).toBe("msg_fixed_id")
  })

  test("transient 500 and 429 retry then succeed", async () => {
    const { fetchFn, seen } = scriptFetch([
      () => status(500, "boom"),
      () => status(429, "rate limit"),
      () => ok202("msg_ok"),
    ])

    const result = await swarmSchedule(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_caller",
        fetchFn,
        sleepFn: noSleep,
      },
      {
        message: "Resume work on W4: bd show pigeon-c68 and continue.",
        after: "1h",
      },
    )

    expect(seen).toHaveLength(3)
    expect(result.attempts).toBe(3)
    expect(result.msg_id).toBe("msg_ok")
  })

  test("Fix 1: transient 500 -> retry -> 409 -> reported as SUCCESS with correct msg_id, deliver_at, and already_banked", async () => {
    const { fetchFn, seen } = scriptFetch([
      () => status(500, "transient error"),
      () =>
        status(
          409,
          JSON.stringify({
            error: "message with msg_id 'msg_banked_123' already exists",
            msg_id: "msg_banked_123",
            deliver_at: 1700000000000,
            expires_at: 1700021600000,
          }),
        ),
    ])

    const result = await swarmSchedule(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_caller",
        fetchFn,
        sleepFn: noSleep,
        makeMsgId: () => "msg_banked_123",
      },
      {
        message: "Resume work on W4: bd show pigeon-c68 and continue.",
        after: "1h",
      },
    )

    expect(seen).toHaveLength(2)
    expect(result.msg_id).toBe("msg_banked_123")
    expect(result.deliver_at).toBe(1700000000000)
    expect(result.expires_at).toBe(1700021600000)
    expect(result.already_banked).toBe(true)

    const formatted = formatScheduleResult(result)
    expect(formatted).toContain("Already banked by an earlier attempt.")
  })

  test("Fix 1: attempt 1 receiving 409 (genuine duplicate) throws immediately", async () => {
    const { fetchFn, seen } = scriptFetch([
      () =>
        status(
          409,
          JSON.stringify({
            error: "message with msg_id 'msg_dup_123' already exists",
            msg_id: "msg_dup_123",
            deliver_at: 1700000000000,
          }),
        ),
    ])

    await expect(
      swarmSchedule(
        {
          daemonBaseUrl: "http://daemon.test",
          sessionId: "ses_caller",
          fetchFn,
          sleepFn: noSleep,
          makeMsgId: () => "msg_dup_123",
        },
        {
          message: "Resume work on W4: bd show pigeon-c68 and continue.",
          after: "1h",
        },
      ),
    ).rejects.toThrow(/swarm_schedule failed: 409/)

    expect(seen).toHaveLength(1)
  })

  test("Fix 3: 503 throws ScheduleRejectedError instance", async () => {
    const { fetchFn } = scriptFetch([
      () =>
        status(
          503,
          JSON.stringify({ error: "Scheduler service is disabled." }),
        ),
    ])

    let caughtErr: unknown
    try {
      await swarmSchedule(
        {
          daemonBaseUrl: "http://daemon.test",
          sessionId: "ses_caller",
          fetchFn,
          sleepFn: noSleep,
        },
        {
          message: "Resume work on W4: bd show pigeon-c68 and continue.",
          after: "1h",
        },
      )
    } catch (err) {
      caughtErr = err
    }

    expect(caughtErr).toBeInstanceOf(ScheduleRejectedError)
  })

  test("Fix 3: truncated JSON body on 2xx returns success instead of false failure", async () => {
    const { fetchFn } = scriptFetch([
      () => status(202, "truncated or bad json {{{"),
    ])

    const result = await swarmSchedule(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_caller",
        fetchFn,
        sleepFn: noSleep,
        makeMsgId: () => "msg_trunc_123",
      },
      {
        message: "Resume work on W4: bd show pigeon-c68 and continue.",
        after: "1h",
      },
    )

    expect(result.msg_id).toBe("msg_trunc_123")
  })

  test("Fix 3: network error on re-auth fetch continues retry loop instead of throwing 401", async () => {
    const { fetchFn, seen } = scriptFetch([
      () => status(401, "Unauthorized"),
      () => {
        throw new Error("network reset on re-auth")
      },
      () => ok202("msg_recovered_after_reauth_net_err"),
    ])

    const result = await swarmSchedule(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_caller",
        fetchFn,
        sleepFn: noSleep,
      },
      {
        message: "Resume work on W4: bd show pigeon-c68 and continue.",
        after: "1h",
      },
    )

    expect(seen).toHaveLength(3)
    expect(result.msg_id).toBe("msg_recovered_after_reauth_net_err")
  })

  test("400 throws immediately without retrying (assert fetch call count)", async () => {
    const { fetchFn, seen } = scriptFetch([
      () => status(400, JSON.stringify({ error: "payload under 40 chars" })),
      () => ok202(),
    ])

    await expect(
      swarmSchedule(
        {
          daemonBaseUrl: "http://daemon.test",
          sessionId: "ses_caller",
          fetchFn,
          sleepFn: noSleep,
        },
        {
          message: "short",
          after: "1h",
        },
      ),
    ).rejects.toThrow(/swarm_schedule failed: 400.*payload under 40 chars/)

    expect(seen).toHaveLength(1)
  })

  test("503 throws immediately, surfaces daemon's error text, and fetch is called EXACTLY ONCE", async () => {
    const { fetchFn, seen } = scriptFetch([
      () =>
        status(
          503,
          JSON.stringify({ error: "Scheduler service is disabled on this daemon." }),
        ),
      // If wrongly retried, step 2 would run:
      () => ok202(),
    ])

    await expect(
      swarmSchedule(
        {
          daemonBaseUrl: "http://daemon.test",
          sessionId: "ses_caller",
          fetchFn,
          sleepFn: noSleep,
        },
        {
          message: "Resume work on W4: bd show pigeon-c68 and continue.",
          after: "1h",
        },
      ),
    ).rejects.toThrow(
      "swarm_schedule REJECTED — the wake was NOT scheduled and will never fire: Scheduler service is disabled on this daemon.",
    )

    expect(seen).toHaveLength(1)
  })

  test("one-shot 401 re-auth path works", async () => {
    delete process.env.PIGEON_DAEMON_AUTH_TOKEN
    delete process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
    invalidateDaemonToken()

    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pigeon-swarmsched-test-"),
    )
    const secretPath = path.join(tmpDir, "token")
    process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE = secretPath

    let callCount = 0
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      callCount++
      if (callCount === 1) {
        fs.writeFileSync(secretPath, "late-arriving-token", "utf8")
        return status(401, "Unauthorized")
      }
      return ok202("msg_reauth_ok")
    }) as typeof fetch

    try {
      const result = await swarmSchedule(
        {
          daemonBaseUrl: "http://daemon.test",
          sessionId: "ses_caller",
          fetchFn,
          sleepFn: noSleep,
        },
        {
          message: "Resume work on W4: bd show pigeon-c68 and continue.",
          after: "1h",
        },
      )

      expect(callCount).toBe(2)
      expect(result.msg_id).toBe("msg_reauth_ok")
    } finally {
      delete process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
      invalidateDaemonToken()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test("ref and expires_in are forwarded in body when supplied and absent when not", async () => {
    const withExtra = capturingFetch(() => ok202())
    await swarmSchedule(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_caller",
        fetchFn: withExtra.fetchFn,
      },
      {
        message: "Resume work on W4: bd show pigeon-c68 and continue.",
        after: "1h",
        expires_in: "12h",
        ref: "bd:pigeon-w4",
      },
    )

    const bodyWith = bodyOf(withExtra.seen[0]!)
    expect(bodyWith.expires_in).toBe("12h")
    expect(bodyWith.ref).toBe("bd:pigeon-w4")

    const withoutExtra = capturingFetch(() => ok202())
    await swarmSchedule(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_caller",
        fetchFn: withoutExtra.fetchFn,
      },
      {
        message: "Resume work on W4: bd show pigeon-c68 and continue.",
        after: "1h",
      },
    )

    const bodyWithout = bodyOf(withoutExtra.seen[0]!)
    expect(bodyWithout).not.toHaveProperty("expires_in")
    expect(bodyWithout).not.toHaveProperty("ref")
  })
})

describe("formatScheduleResult", () => {
  test("renders formatted confirmation with ISO delivery and expiration dates", () => {
    const result: SwarmScheduleResult = {
      msg_id: "msg_abc",
      to: "ses_caller",
      deliver_at: 1700000000000,
      expires_at: 1700021600000,
    }
    const formatted = formatScheduleResult(result)
    expect(formatted).toContain("Scheduled msg_abc for ses_caller.")
    expect(formatted).toContain("Delivery at 2023-11-14T22:13:20.000Z")
    expect(formatted).toContain("expires at 2023-11-15T04:13:20.000Z")
  })

  test("appends retry note when attempts > 1", () => {
    const result: SwarmScheduleResult = {
      msg_id: "msg_abc",
      to: "ses_caller",
      deliver_at: 1700000000000,
      expires_at: 1700021600000,
      attempts: 3,
    }
    const formatted = formatScheduleResult(result)
    expect(formatted).toContain("Accepted after 3 attempts")
  })
})

describe("createSwarmScheduleTool", () => {
  test("builds ToolDefinition with description and args", () => {
    const toolDef = createSwarmScheduleTool("http://127.0.0.1:4731")
    expect(toolDef.description).toContain("Schedule a swarm message for future delivery")
    expect(toolDef.args).toHaveProperty("message")
    expect(toolDef.args).toHaveProperty("to")
    expect(toolDef.args).toHaveProperty("at")
    expect(toolDef.args).toHaveProperty("after")
  })

  test("Fix 2: execute re-auth retry fetches refreshed token instead of stale snapshot token", async () => {
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
      return ok202("msg_fix2_ok")
    }) as typeof fetch

    try {
      const toolDef = createSwarmScheduleTool("http://daemon.test")
      const result = await toolDef.execute(
        {
          message: "Resume work on W4: bd show pigeon-c68 and continue.",
          after: "1h",
        },
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
      expect(result).toContain("Scheduled msg_fix2_ok")
    } finally {
      globalThis.fetch = originalFetch
      delete process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
      invalidateDaemonToken()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe("SWARM_SCHEDULE_TOOL_NAME (Anthropic compatibility)", () => {
  const ANTHROPIC_TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,128}$/

  test("registration name matches Anthropic's tool-name regex", () => {
    expect(SWARM_SCHEDULE_TOOL_NAME).toMatch(ANTHROPIC_TOOL_NAME_REGEX)
  })

  test("registration name does not contain a period", () => {
    expect(SWARM_SCHEDULE_TOOL_NAME).not.toContain(".")
  })
})
