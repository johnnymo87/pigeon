import { describe, expect, test } from "vitest"
import {
  swarmSend,
  formatSendResult,
  createSwarmSendTool,
  SWARM_SEND_TOOL_NAME,
  SWARM_SEND_MAX_ATTEMPTS,
  SWARM_SEND_INITIAL_BACKOFF_MS,
  SWARM_SEND_BACKOFF_FACTOR,
  SWARM_SEND_MAX_BACKOFF_MS,
  type SwarmSendResult,
} from "../src/swarm-send-tool"

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

function ok202(msgId = "msg_xyz"): Response {
  return new Response(JSON.stringify({ accepted: true, msg_id: msgId }), {
    status: 202,
    headers: { "content-type": "application/json" },
  })
}

function bodyOf(c: Captured): Record<string, unknown> {
  return JSON.parse(c.init!.body as string) as Record<string, unknown>
}

function headersOf(c: Captured): Record<string, string> {
  return (c.init!.headers as Record<string, string>) ?? {}
}

/**
 * A fetch mock driven by a script of per-attempt thunks. Each thunk is invoked
 * once per attempt (the last thunk repeats if attempts exceed the script), and
 * a thunk may either return a Response or throw to simulate a network reject.
 */
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

function econnRefused(): never {
  throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4731"), {
    code: "ECONNREFUSED",
  })
}

function fetchFailed(): never {
  throw new TypeError("fetch failed")
}

function status(code: number, body = ""): Response {
  return new Response(body, {
    status: code,
    headers: { "content-type": "application/json" },
  })
}

function recordingSleep(): {
  sleepFn: (ms: number) => Promise<void>
  delays: number[]
} {
  const delays: number[] = []
  return {
    sleepFn: async (ms: number) => {
      delays.push(ms)
    },
    delays,
  }
}

const noSleep = async (): Promise<void> => {}

describe("swarmSend (pure helper)", () => {
  test("POSTs to /swarm/send with from=sessionId, message as payload, and defaults", async () => {
    const { fetchFn, seen } = capturingFetch(() => ok202("msg_abc"))

    const result = await swarmSend(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_sender",
        fetchFn,
      },
      { to: "ses_target", message: "hello there" },
    )

    expect(seen).toHaveLength(1)
    const url = new URL(seen[0]!.url)
    expect(url.pathname).toBe("/swarm/send")
    expect(seen[0]!.init!.method).toBe("POST")

    const body = bodyOf(seen[0]!)
    expect(body.from).toBe("ses_sender")
    expect(body.to).toBe("ses_target")
    expect(body.payload).toBe("hello there")
    expect(body.kind).toBe("chat")
    expect(body.priority).toBe("normal")
    // reply_to omitted when not provided
    expect(body).not.toHaveProperty("reply_to")

    expect(result).toEqual<SwarmSendResult>({
      msg_id: "msg_abc",
      to: "ses_target",
      kind: "chat",
      priority: "normal",
      attempts: 1,
    })
  })

  test("applies kind, priority, and reply_to when provided", async () => {
    const { fetchFn, seen } = capturingFetch(() => ok202())

    await swarmSend(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_sender",
        fetchFn,
      },
      {
        to: "ses_target",
        message: "the recon result",
        kind: "result",
        priority: "urgent",
        reply_to: "msg_prev",
      },
    )

    const body = bodyOf(seen[0]!)
    expect(body.kind).toBe("result")
    expect(body.priority).toBe("urgent")
    expect(body.reply_to).toBe("msg_prev")
  })

  test("includes Authorization Bearer header only when authToken is set", async () => {
    const withTok = capturingFetch(() => ok202())
    await swarmSend(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_sender",
        authToken: "secret-tok",
        fetchFn: withTok.fetchFn,
      },
      { to: "ses_target", message: "hi" },
    )
    expect(headersOf(withTok.seen[0]!)["Authorization"]).toBe("Bearer secret-tok")
    expect(headersOf(withTok.seen[0]!)["Content-Type"]).toBe("application/json")

    const noTok = capturingFetch(() => ok202())
    await swarmSend(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_sender",
        fetchFn: noTok.fetchFn,
      },
      { to: "ses_target", message: "hi" },
    )
    expect(headersOf(noTok.seen[0]!)["Authorization"]).toBeUndefined()
  })

  test("throws with status + body when the daemon rejects the payload (400 close tag)", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          error:
            "payload must not contain the literal </swarm_message> close tag",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as typeof fetch

    await expect(
      swarmSend(
        { daemonBaseUrl: "http://daemon.test", sessionId: "ses_sender", fetchFn },
        { to: "ses_target", message: "bad </swarm_message>" },
      ),
    ).rejects.toThrow(/swarm_send failed: 400.*close tag/)
  })
})

describe("swarmSend retry on transient failures", () => {
  test("retries on fetch rejection (ECONNREFUSED) and succeeds once the daemon is back", async () => {
    const { fetchFn, seen } = scriptFetch([
      () => econnRefused(),
      () => econnRefused(),
      () => ok202("msg_back"),
    ])
    const { sleepFn, delays } = recordingSleep()

    const result = await swarmSend(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_sender",
        fetchFn,
        sleepFn,
      },
      { to: "ses_target", message: "reply that must not be lost" },
    )

    expect(seen).toHaveLength(3)
    expect(result.msg_id).toBe("msg_back")
    expect(result.attempts).toBe(3)
    // slept once before each retry (attempt 2 and attempt 3), exponential
    expect(delays).toEqual([
      SWARM_SEND_INITIAL_BACKOFF_MS,
      SWARM_SEND_INITIAL_BACKOFF_MS * SWARM_SEND_BACKOFF_FACTOR,
    ])
  })

  test("retries on 5xx then succeeds", async () => {
    const { fetchFn, seen } = scriptFetch([
      () => status(503, "service unavailable"),
      () => ok202("msg_ok"),
    ])
    const result = await swarmSend(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_sender",
        fetchFn,
        sleepFn: noSleep,
      },
      { to: "ses_target", message: "hi" },
    )
    expect(seen).toHaveLength(2)
    expect(result.attempts).toBe(2)
  })

  test("retries on 429 then succeeds", async () => {
    const { fetchFn, seen } = scriptFetch([
      () => status(429, "rate limited"),
      () => ok202(),
    ])
    const result = await swarmSend(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_sender",
        fetchFn,
        sleepFn: noSleep,
      },
      { to: "ses_target", message: "hi" },
    )
    expect(seen).toHaveLength(2)
    expect(result.attempts).toBe(2)
  })

  test("does NOT retry on 4xx (400 close tag) — throws after a single attempt", async () => {
    const { fetchFn, seen } = scriptFetch([
      () =>
        status(
          400,
          JSON.stringify({
            error:
              "payload must not contain the literal </swarm_message> close tag",
          }),
        ),
      // would succeed if (wrongly) retried — proves we do NOT retry 4xx
      () => ok202(),
    ])
    await expect(
      swarmSend(
        {
          daemonBaseUrl: "http://daemon.test",
          sessionId: "ses_sender",
          fetchFn,
          sleepFn: noSleep,
        },
        { to: "ses_target", message: "bad </swarm_message>" },
      ),
    ).rejects.toThrow(/swarm_send failed: 400.*close tag/)
    expect(seen).toHaveLength(1)
  })

  test("gives up after SWARM_SEND_MAX_ATTEMPTS when the daemon stays unreachable", async () => {
    const { fetchFn, seen } = scriptFetch([() => fetchFailed()])
    await expect(
      swarmSend(
        {
          daemonBaseUrl: "http://daemon.test",
          sessionId: "ses_sender",
          fetchFn,
          sleepFn: noSleep,
        },
        { to: "ses_target", message: "hi" },
      ),
    ).rejects.toThrow(/after \d+ attempts/)
    expect(seen).toHaveLength(SWARM_SEND_MAX_ATTEMPTS)
  })

  test("backoff is exponential, non-decreasing, and capped at SWARM_SEND_MAX_BACKOFF_MS", async () => {
    const { fetchFn } = scriptFetch([() => fetchFailed()])
    const { sleepFn, delays } = recordingSleep()
    await expect(
      swarmSend(
        {
          daemonBaseUrl: "http://daemon.test",
          sessionId: "ses_sender",
          fetchFn,
          sleepFn,
        },
        { to: "ses_target", message: "hi" },
      ),
    ).rejects.toThrow()
    // one sleep between each of the MAX_ATTEMPTS tries
    expect(delays).toHaveLength(SWARM_SEND_MAX_ATTEMPTS - 1)
    expect(delays[0]).toBe(SWARM_SEND_INITIAL_BACKOFF_MS)
    expect(Math.max(...delays)).toBeLessThanOrEqual(SWARM_SEND_MAX_BACKOFF_MS)
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!)
    }
  })

  test("reuses one client-generated msg_id across retries (idempotency)", async () => {
    const { fetchFn, seen } = scriptFetch([
      () => econnRefused(),
      () => ok202("msg_fixed"),
    ])
    const result = await swarmSend(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_sender",
        fetchFn,
        sleepFn: noSleep,
        makeMsgId: () => "msg_fixed",
      },
      { to: "ses_target", message: "hi" },
    )
    const bodies = seen.map(bodyOf)
    expect(bodies).toHaveLength(2)
    expect(bodies[0]!.msg_id).toBe("msg_fixed")
    expect(bodies[1]!.msg_id).toBe("msg_fixed")
    expect(result.msg_id).toBe("msg_fixed")
  })

  test("default msg_id matches the daemon's msg_<base36>_<8hex> format", async () => {
    const { fetchFn, seen } = scriptFetch([() => ok202()])
    await swarmSend(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_sender",
        fetchFn,
        sleepFn: noSleep,
      },
      { to: "ses_target", message: "hi" },
    )
    const sentId = bodyOf(seen[0]!).msg_id as string
    expect(sentId).toMatch(/^msg_[0-9a-z]+_[0-9a-f]{8}$/)
  })
})

describe("formatSendResult", () => {
  test("renders a concise queued line with char count", () => {
    const out = formatSendResult(
      { msg_id: "msg_abc", to: "ses_target", kind: "chat", priority: "normal" },
      11,
    )
    expect(out).toContain("msg_abc")
    expect(out).toContain("ses_target")
    expect(out).toContain("kind=chat")
    expect(out).toContain("priority=normal")
    expect(out).toContain("11 chars")
  })

  test("notes when the send was accepted only after retries", () => {
    const out = formatSendResult(
      { msg_id: "m", to: "ses_t", kind: "chat", priority: "normal", attempts: 3 },
      5,
    )
    expect(out).toMatch(/3 attempts/)
  })

  test("adds no retry note on first-attempt success", () => {
    const out = formatSendResult(
      { msg_id: "m", to: "ses_t", kind: "chat", priority: "normal", attempts: 1 },
      5,
    )
    expect(out).not.toMatch(/attempts/)
  })
})

describe("createSwarmSendTool", () => {
  test("builds a ToolDefinition with description + to/message args", () => {
    const def = createSwarmSendTool("http://127.0.0.1:4731")
    expect(typeof def.description).toBe("string")
    expect(def.description.length).toBeGreaterThan(0)
    expect(def.args).toHaveProperty("to")
    expect(def.args).toHaveProperty("message")
    expect(typeof def.execute).toBe("function")
  })

  test("execute() uses ToolContext sessionID as `from` and returns the queued line", async () => {
    const seen: Captured[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: input.toString(), init })
      return ok202("msg_zzz")
    }) as typeof fetch

    try {
      const def = createSwarmSendTool("http://daemon.test")
      const metadataCalls: Array<{ title?: string; metadata?: unknown }> = []
      const result = await def.execute(
        { to: "ses_target", message: "ping" },
        {
          sessionID: "ses_caller",
          messageID: "msg_x",
          agent: "build",
          directory: "/tmp",
          worktree: "/tmp",
          abort: new AbortController().signal,
          metadata: (input) => {
            metadataCalls.push(input)
          },
          ask: async () => {},
        },
      )

      expect(seen).toHaveLength(1)
      expect(new URL(seen[0]!.url).pathname).toBe("/swarm/send")
      expect(bodyOf(seen[0]!).from).toBe("ses_caller")
      expect(result).toContain("msg_zzz")
      expect(result).toContain("ses_target")
      expect(metadataCalls).toEqual([
        {
          title: "swarm send -> ses_target",
          metadata: {
            msg_id: "msg_zzz",
            to: "ses_target",
            kind: "chat",
            priority: "normal",
          },
        },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("SWARM_SEND_TOOL_NAME (Anthropic compatibility)", () => {
  const ANTHROPIC_TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,128}$/

  test("registration name matches Anthropic's tool-name regex", () => {
    expect(SWARM_SEND_TOOL_NAME).toMatch(ANTHROPIC_TOOL_NAME_REGEX)
  })

  test("registration name does not contain a period", () => {
    expect(SWARM_SEND_TOOL_NAME).not.toContain(".")
  })
})
