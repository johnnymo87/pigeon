import { describe, expect, test } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { invalidateDaemonToken } from "../src/auth-token"
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

  test("reads token from secret file when env is unset", async () => {
    delete process.env.PIGEON_DAEMON_AUTH_TOKEN
    delete process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
    invalidateDaemonToken()

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pigeon-swarmsend-test-"))
    const secretPath = path.join(tmpDir, "token")
    fs.writeFileSync(secretPath, "file-token-789", "utf8")
    process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE = secretPath

    const fileTok = capturingFetch(() => ok202())
    try {
      await swarmSend(
        {
          daemonBaseUrl: "http://daemon.test",
          sessionId: "ses_sender",
          fetchFn: fileTok.fetchFn,
        },
        { to: "ses_target", message: "hi" },
      )
      expect(headersOf(fileTok.seen[0]!)["Authorization"]).toBe("Bearer file-token-789")
    } finally {
      delete process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
      invalidateDaemonToken()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test("invalidates token and retries on 401 response", async () => {
    delete process.env.PIGEON_DAEMON_AUTH_TOKEN
    delete process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
    invalidateDaemonToken()

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pigeon-swarmsend-test2-"))
    const secretPath = path.join(tmpDir, "token")
    process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE = secretPath

    const seenHeaders: Array<Record<string, string>> = []
    let callCount = 0

    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      callCount++
      const headers = (init?.headers as Record<string, string>) ?? {}
      seenHeaders.push({ ...headers })

      if (callCount === 1) {
        fs.writeFileSync(secretPath, "late-arriving-token", "utf8")
        return status(401, "Unauthorized")
      }
      return ok202("msg_retry_ok")
    }) as typeof fetch

    try {
      const result = await swarmSend(
        {
          daemonBaseUrl: "http://daemon.test",
          sessionId: "ses_sender",
          fetchFn,
          sleepFn: noSleep,
        },
        { to: "ses_target", message: "hi" },
      )

      expect(callCount).toBe(2)
      expect(result.msg_id).toBe("msg_retry_ok")
      expect(seenHeaders[0]["Authorization"]).toBeUndefined()
      expect(seenHeaders[1]["Authorization"]).toBe("Bearer late-arriving-token")
    } finally {
      delete process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
      invalidateDaemonToken()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  /**
   * pigeon-iy4 follow-through. A fetch REJECTION on the re-auth retry must
   * re-enter the outer retry loop, not abort the send.
   *
   * A token rotation and a daemon restart are frequently the same event, so
   * "401 with the stale token -> re-resolve -> retry lands in the restart
   * window -> ECONNREFUSED" is an ordinary sequence here, not an exotic one.
   * The catch used to only record lastError and fall through to the
   * isTransientStatus check -- which still saw the ORIGINAL 401 response, a
   * permanent status -- so the send threw immediately, with a refreshed token
   * in hand and most of the ~15.5s backoff budget unspent, blaming a 401 that
   * had already been cured.
   *
   * swarm-schedule-tool.ts:246-258 already does this correctly; W4 found it
   * there ("Fix 3") and this is the same defect in the sibling tool.
   */
  test("re-auth retry that rejects (ECONNREFUSED) resumes the outer retry loop instead of throwing the cured 401", async () => {
    delete process.env.PIGEON_DAEMON_AUTH_TOKEN
    delete process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
    invalidateDaemonToken()

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pigeon-swarmsend-fix3-"))
    const secretPath = path.join(tmpDir, "token")
    fs.writeFileSync(secretPath, "old-token", "utf8")
    process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE = secretPath

    const seenAuth: Array<string | undefined> = []
    let callCount = 0
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount++
      seenAuth.push((init?.headers as Record<string, string>)?.["Authorization"])
      if (callCount === 1) {
        fs.writeFileSync(secretPath, "new-token", "utf8")
        return status(401, "Unauthorized")
      }
      // The daemon is mid-restart when the re-auth retry arrives.
      if (callCount === 2) econnRefused()
      return ok202("msg_fix3_ok")
    }) as typeof fetch

    const { sleepFn, delays } = recordingSleep()

    try {
      const result = await swarmSend(
        {
          daemonBaseUrl: "http://daemon.test",
          sessionId: "ses_sender",
          fetchFn,
          sleepFn,
        },
        { to: "ses_target", message: "hi" },
      )

      expect(result.msg_id).toBe("msg_fix3_ok")
      expect(callCount).toBe(3)
      // The blip cost one backoff sleep rather than the whole send.
      expect(delays).toHaveLength(1)
      // And the refreshed token survived the rejection -- it is not re-resolved
      // back to the stale value, and the retry is not attempted a second time.
      expect(seenAuth).toEqual([
        "Bearer old-token",
        "Bearer new-token",
        "Bearer new-token",
      ])
    } finally {
      delete process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
      invalidateDaemonToken()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
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

  /**
   * pigeon-iy4. The one-shot 401 re-auth must survive the REAL tool entry
   * point, not just a direct swarmSend() call.
   *
   * This has to go through execute() rather than swarmSend(): the bug lived
   * entirely in what execute() passed down. execute() resolved the token once
   * and handed it over as opts.authToken, so the retry's
   * `opts.authToken ?? resolveDaemonToken()` kept preferring that snapshot and
   * re-sent the identical dead token. The pre-existing 401 test
   * ("invalidates token and retries on 401 response") calls swarmSend()
   * without opts.authToken -- a configuration production never used -- which
   * is exactly why it stayed green while the production path was broken.
   *
   * Asserting the full header sequence, not just "the second call happened":
   * the broken code also makes two calls and also succeeds here. Only the
   * header CONTENT separates the fixed path from the broken one.
   */
  test("execute() re-auth retry sends the refreshed token, not a stale snapshot (pigeon-iy4)", async () => {
    delete process.env.PIGEON_DAEMON_AUTH_TOKEN
    delete process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
    invalidateDaemonToken()

    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pigeon-swarmsend-iy4-"),
    )
    const secretPath = path.join(tmpDir, "token")
    fs.writeFileSync(secretPath, "old-token", "utf8")
    process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE = secretPath

    const authHeadersSeen: string[] = []
    let callCount = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount++
      const headers = (init?.headers as Record<string, string>) ?? {}
      if (headers["Authorization"]) {
        authHeadersSeen.push(headers["Authorization"])
      }
      if (callCount === 1) {
        // Token rotates on disk while the daemon is rejecting the old one.
        fs.writeFileSync(secretPath, "new-token", "utf8")
        return status(401, "Unauthorized")
      }
      return ok202("msg_iy4_ok")
    }) as typeof fetch

    try {
      const def = createSwarmSendTool("http://daemon.test")
      const result = await def.execute(
        { to: "ses_target", message: "ping" },
        {
          sessionID: "ses_caller",
          messageID: "msg_x",
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
      expect(result).toContain("msg_iy4_ok")
    } finally {
      globalThis.fetch = originalFetch
      delete process.env.PIGEON_DAEMON_AUTH_TOKEN_FILE
      invalidateDaemonToken()
      fs.rmSync(tmpDir, { recursive: true, force: true })
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
