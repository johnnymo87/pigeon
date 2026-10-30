import { describe, expect, test, vi, beforeEach } from "vitest"
import {
  SWARM_LAUNCH_TOOL_NAME,
  resolveRootSession,
  swarmLaunch,
  createSwarmLaunchTool,
  type SwarmLaunchArgs,
  type SwarmLaunchRequestOptions,
} from "../src/swarm-launch-tool"
import { invalidateDaemonToken } from "../src/auth-token"

type Captured = { url: string; init?: RequestInit }

function capturingFetch(
  response: () => Response,
): { fetchFn: typeof fetch; seen: Captured[] } {
  const seen: Captured[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: input.toString(),
      init: {
        ...init,
        headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      },
    })
    return response()
  }) as typeof fetch
  return { fetchFn, seen }
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

function bodyOf(c: Captured): Record<string, unknown> {
  return JSON.parse(c.init!.body as string) as Record<string, unknown>
}

function headersOf(c: Captured): Record<string, string> {
  return (c.init!.headers as Record<string, string>) ?? {}
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function textResponse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain" },
  })
}

const noSleep = async (): Promise<void> => {}

describe("resolveRootSession", () => {
  test("returns current session id when session has no parentID", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(200, { id: "ses_main", parentID: undefined }),
    ) as unknown as typeof fetch

    const root = await resolveRootSession("ses_main", "http://127.0.0.1:4096", fetchFn)
    expect(root).toBe("ses_main")
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  test("follows parentID 1 hop to root", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { id: "ses_sub1", parentID: "ses_root" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "ses_root", parentID: undefined })) as unknown as typeof fetch

    const root = await resolveRootSession("ses_sub1", "http://127.0.0.1:4096", fetchFn)
    expect(root).toBe("ses_root")
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  test("follows parentID multiple hops to root", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { id: "ses_c", parentID: "ses_b" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "ses_b", parentID: "ses_a" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "ses_a", parentID: undefined })) as unknown as typeof fetch

    const root = await resolveRootSession("ses_c", "http://127.0.0.1:4096", fetchFn)
    expect(root).toBe("ses_a")
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  test("handles parentID inside data property (SDK format)", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: { id: "ses_sub", parentID: "ses_parent" } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { id: "ses_parent" } })) as unknown as typeof fetch

    const root = await resolveRootSession("ses_sub", "http://127.0.0.1:4096", fetchFn)
    expect(root).toBe("ses_parent")
  })

  test("only climbs to a parentID that starts with ses_, stops if parentID lacks ses_ prefix", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(200, { id: "ses_child", parentID: "non_ses_parent" }),
    ) as unknown as typeof fetch

    const root = await resolveRootSession("ses_child", "http://127.0.0.1:4096", fetchFn)
    expect(root).toBe("ses_child")
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  test("stops and returns furthest resolved session if hop fails (e.g. 404 or network error)", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { id: "ses_c", parentID: "ses_b" }))
      .mockResolvedValueOnce(new Response("Not found", { status: 404 })) as unknown as typeof fetch

    const root = await resolveRootSession("ses_c", "http://127.0.0.1:4096", fetchFn)
    expect(root).toBe("ses_b")
  })

  test("stops and returns current session if first hop throws network error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch

    const root = await resolveRootSession("ses_c", "http://127.0.0.1:4096", fetchFn)
    expect(root).toBe("ses_c")
  })

  test("stops at maxHops (default 8)", async () => {
    let callCount = 0
    const fetchFn = vi.fn().mockImplementation((req: Request) => {
      callCount++
      const url = new URL(req.url)
      const sid = url.pathname.replace("/session/", "")
      const num = parseInt(sid.replace("ses_", ""), 10)
      return Promise.resolve(jsonResponse(200, { id: sid, parentID: `ses_${num + 1}` }))
    }) as unknown as typeof fetch

    const root = await resolveRootSession("ses_0", "http://127.0.0.1:4096", fetchFn, 8)
    expect(root).toBe("ses_8")
    expect(callCount).toBe(8)
  })

  test("detects cycles and terminates without infinite loop", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { id: "ses_a", parentID: "ses_b" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "ses_b", parentID: "ses_a" })) as unknown as typeof fetch

    const root = await resolveRootSession("ses_a", "http://127.0.0.1:4096", fetchFn)
    expect(root).toBe("ses_b")
  })
})

describe("swarmLaunch", () => {
  const baseArgs: SwarmLaunchArgs = {
    machine: "cloudbox",
    directory: "~/projects/pigeon",
    prompt: "say hello",
    tag: "my-tag",
  }

  const baseOpts: SwarmLaunchRequestOptions = {
    daemonBaseUrl: "http://127.0.0.1:4731",
    from: "ses_root123",
    sleepFn: noSleep,
  }

  test("mints launch_id starting with rl_ and sends request to /swarm/launch", async () => {
    const { fetchFn, seen } = capturingFetch(() =>
      jsonResponse(202, {
        status: "accepted",
        to_machine: "cloudbox",
      }),
    )

    const res = await swarmLaunch({ ...baseOpts, fetchFn }, baseArgs)

    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe("http://127.0.0.1:4731/swarm/launch")
    const body = bodyOf(seen[0]!)
    expect(body.launch_id).toMatch(/^rl_[0-9a-z]+_[0-9a-f]{8}$/)
    expect(body.from).toBe("ses_root123")
    expect(body.machine).toBe("cloudbox")
    expect(body.directory).toBe("~/projects/pigeon")
    expect(body.prompt).toBe("say hello")
    expect(body.tag).toBe("my-tag")

    expect(res.status).toBe("accepted")
    expect(res.message).toBe(
      `Launch ${body.launch_id} accepted for cloudbox. The result arrives as a launch.result swarm message.`,
    )
  })

  test("reuses the same launch_id across retries", async () => {
    const { fetchFn, seen } = scriptFetch([
      () => textResponse(500, "internal error"),
      () => jsonResponse(202, { status: "accepted", to_machine: "cloudbox" }),
    ])

    const res = await swarmLaunch({ ...baseOpts, fetchFn }, baseArgs)

    expect(seen).toHaveLength(2)
    const id1 = bodyOf(seen[0]!).launch_id
    const id2 = bodyOf(seen[1]!).launch_id
    expect(id1).toBe(id2)
    expect(res.status).toBe("accepted")
  })

  test("returns pending output when daemon returns 202 status pending", async () => {
    const { fetchFn } = capturingFetch(() =>
      jsonResponse(202, {
        launch_id: "rl_pending_1",
        status: "pending",
      }),
    )

    const res = await swarmLaunch(
      { ...baseOpts, fetchFn, makeLaunchId: () => "rl_pending_1" },
      baseArgs,
    )

    expect(res.status).toBe("pending")
    expect(res.message).toBe(
      "Launch rl_pending_1 is pending (the worker did not answer). The result arrives as a launch.result swarm message. Do NOT call swarm_launch again for this.",
    )
  })

  test("retries with refreshed token on 401", async () => {
    process.env.PIGEON_DAEMON_AUTH_TOKEN = "old-token"
    invalidateDaemonToken()

    let callCount = 0
    const { fetchFn, seen } = capturingFetch(() => {
      callCount++
      if (callCount === 1) {
        process.env.PIGEON_DAEMON_AUTH_TOKEN = "new-token"
        return jsonResponse(401, { error: "unauthorized" })
      }
      return jsonResponse(202, { status: "accepted", to_machine: "cloudbox" })
    })

    const res = await swarmLaunch({ ...baseOpts, fetchFn }, baseArgs)

    expect(callCount).toBe(2)
    expect(headersOf(seen[0]!)["Authorization"]).toBe("Bearer old-token")
    expect(headersOf(seen[1]!)["Authorization"]).toBe("Bearer new-token")
    expect(res.status).toBe("accepted")

    delete process.env.PIGEON_DAEMON_AUTH_TOKEN
    invalidateDaemonToken()
  })

  test("throws 'pigeon on this machine is too old for swarm_launch' on 404 without a code", async () => {
    const { fetchFn } = capturingFetch(() => textResponse(404, "Cannot POST /swarm/launch"))

    await expect(swarmLaunch({ ...baseOpts, fetchFn }, baseArgs)).rejects.toThrow(
      "pigeon on this machine is too old for swarm_launch",
    )
  })

  test("throws <code>: <detail> on 404 with a code", async () => {
    const { fetchFn } = capturingFetch(() =>
      jsonResponse(404, { error: "not_found", detail: "session not found" }),
    )

    await expect(swarmLaunch({ ...baseOpts, fetchFn }, baseArgs)).rejects.toThrow(
      "not_found: session not found",
    )
  })

  test("throws <code>: <detail> on 400 validation error", async () => {
    const { fetchFn } = capturingFetch(() =>
      jsonResponse(400, { error: "invalid", detail: "directory must be 1-512 characters" }),
    )

    await expect(swarmLaunch({ ...baseOpts, fetchFn }, baseArgs)).rejects.toThrow(
      "invalid: directory must be 1-512 characters",
    )
  })

  test("throws <code> on 403 refusal without detail (e.g. launch_send_disabled)", async () => {
    const { fetchFn } = capturingFetch(() =>
      jsonResponse(403, { error: "launch_send_disabled" }),
    )

    await expect(swarmLaunch({ ...baseOpts, fetchFn }, baseArgs)).rejects.toThrow(
      "launch_send_disabled",
    )
  })

  test("throws <code> on 409 launch_id_conflict", async () => {
    const { fetchFn } = capturingFetch(() =>
      jsonResponse(409, { error: "launch_id_conflict" }),
    )

    await expect(swarmLaunch({ ...baseOpts, fetchFn }, baseArgs)).rejects.toThrow(
      "launch_id_conflict",
    )
  })

  test("429 with known worker code (queue_full, rate_limited) is a refusal and throws immediately", async () => {
    const { fetchFn, seen } = capturingFetch(() =>
      jsonResponse(429, { error: "queue_full", detail: "queue cap reached" }),
    )

    await expect(swarmLaunch({ ...baseOpts, fetchFn }, baseArgs)).rejects.toThrow(
      "queue_full: queue cap reached",
    )
    expect(seen).toHaveLength(1) // did not retry
  })

  test("429 without code is transient and retries", async () => {
    const { fetchFn, seen } = scriptFetch([
      () => textResponse(429, "Too Many Requests"),
      () => jsonResponse(202, { status: "accepted", to_machine: "cloudbox" }),
    ])

    const res = await swarmLaunch({ ...baseOpts, fetchFn }, baseArgs)
    expect(seen).toHaveLength(2)
    expect(res.status).toBe("accepted")
  })

  test("503 with known refusal code (target_offline, launch_unavailable, no_worker) throws immediately", async () => {
    const { fetchFn, seen } = capturingFetch(() =>
      jsonResponse(503, { error: "target_offline", detail: "cloudbox is offline" }),
    )

    await expect(swarmLaunch({ ...baseOpts, fetchFn }, baseArgs)).rejects.toThrow(
      "target_offline: cloudbox is offline",
    )
    expect(seen).toHaveLength(1)
  })

  test("503 without code is transient and retried", async () => {
    const { fetchFn, seen } = scriptFetch([
      () => textResponse(503, "Service Unavailable"),
      () => jsonResponse(202, { status: "accepted", to_machine: "cloudbox" }),
    ])

    const res = await swarmLaunch({ ...baseOpts, fetchFn }, baseArgs)
    expect(seen).toHaveLength(2)
    expect(res.status).toBe("accepted")
  })

  test("retries exhausted on network failures without seeing 5xx throws daemon unreachable with error detail", async () => {
    const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4731"), { code: "ECONNREFUSED" })
    const { fetchFn, seen } = capturingFetch(() => {
      throw err
    })

    await expect(swarmLaunch({ ...baseOpts, fetchFn }, baseArgs)).rejects.toThrow(
      "swarm_launch failed: daemon unreachable (connect ECONNREFUSED 127.0.0.1:4731)",
    )
    expect(seen).toHaveLength(6)
  })

  test("one ECONNRESET then refusals -> pending", async () => {
    let call = 0
    const resetErr = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
    const refusedErr = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4731"), { code: "ECONNREFUSED" })
    const { fetchFn, seen } = capturingFetch(() => {
      call++
      if (call === 1) throw resetErr
      throw refusedErr
    })

    const res = await swarmLaunch(
      { ...baseOpts, fetchFn, makeLaunchId: () => "rl_reset" },
      baseArgs,
    )

    expect(seen).toHaveLength(6)
    expect(res.status).toBe("pending")
    expect(res.message).toBe(
      "Launch rl_reset is pending (the worker did not answer). The result arrives as a launch.result swarm message. Do NOT call swarm_launch again for this.",
    )
  })

  test("one timeout then refusals -> pending", async () => {
    let call = 0
    const timeoutErr = Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" })
    const refusedErr = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4731"), { code: "ECONNREFUSED" })
    const { fetchFn, seen } = capturingFetch(() => {
      call++
      if (call === 1) throw timeoutErr
      throw refusedErr
    })

    const res = await swarmLaunch(
      { ...baseOpts, fetchFn, makeLaunchId: () => "rl_timeout" },
      baseArgs,
    )

    expect(seen).toHaveLength(6)
    expect(res.status).toBe("pending")
    expect(res.message).toBe(
      "Launch rl_timeout is pending (the worker did not answer). The result arrives as a launch.result swarm message. Do NOT call swarm_launch again for this.",
    )
  })

  test("passes signal with timeout to fetch, aborting if timeout passes", async () => {
    const fetchFn = vi.fn().mockImplementation((url, init) => {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
        })
      })
    }) as unknown as typeof fetch

    const res = await swarmLaunch(
      { ...baseOpts, fetchFn, timeoutMs: 10, makeLaunchId: () => "rl_abort" },
      baseArgs,
    )

    expect(res.status).toBe("pending")
    expect(res.message).toBe(
      "Launch rl_abort is pending (the worker did not answer). The result arrives as a launch.result swarm message. Do NOT call swarm_launch again for this.",
    )
  })

  test("retries exhausted on 500 returns pending message", async () => {
    const { fetchFn, seen } = capturingFetch(() => textResponse(500, "Internal Server Error"))

    const res = await swarmLaunch(
      { ...baseOpts, fetchFn, makeLaunchId: () => "rl_test500" },
      baseArgs,
    )

    expect(seen).toHaveLength(6)
    expect(res.status).toBe("pending")
    expect(res.message).toBe(
      "Launch rl_test500 is pending (the worker did not answer). The result arrives as a launch.result swarm message. Do NOT call swarm_launch again for this.",
    )
  })

  test("attempt 1 gets 500, subsequent attempts get network error -> returns pending message", async () => {
    let call = 0
    const { fetchFn, seen } = capturingFetch(() => {
      call++
      if (call === 1) return textResponse(500, "Internal Server Error")
      throw new Error("ECONNREFUSED")
    })

    const res = await swarmLaunch(
      { ...baseOpts, fetchFn, makeLaunchId: () => "rl_net500" },
      baseArgs,
    )

    expect(seen).toHaveLength(6)
    expect(res.status).toBe("pending")
    expect(res.message).toBe(
      "Launch rl_net500 is pending (the worker did not answer). The result arrives as a launch.result swarm message. Do NOT call swarm_launch again for this.",
    )
  })
})

describe("createSwarmLaunchTool", () => {
  test("registers tool with correct name and required descriptions", () => {
    const toolDef = createSwarmLaunchTool(
      "http://127.0.0.1:4731",
      "http://127.0.0.1:4096",
      vi.fn() as unknown as typeof fetch,
    )

    expect(toolDef.description).toContain("FRESH session on another machine")
    expect(toolDef.description).toContain("PIGEON_REMOTE_LAUNCH_SEND=1")
    expect(toolDef.description).toContain("launch_send_disabled")
    expect(toolDef.description).toContain("PIGEON_REMOTE_LAUNCH_FROM")
    expect(toolDef.description).toContain("ONCE per launch")
    expect(toolDef.description).toContain("launch.result")
    expect(toolDef.description).toContain("pending")
    expect(toolDef.description).toContain("pool restart")
    expect(toolDef.description).toContain("cross-device-deployment")

    const args = toolDef.args as Record<string, { description?: string }>
    expect(args.directory.description).toContain("absolute path or ~/... or a bare project name expanded to ~/projects/<name>")
  })

  test("execute resolves root session and launches", async () => {
    const internalFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, { id: "ses_child", parentID: "ses_root" }),
    ) as unknown as typeof fetch

    const daemonFetch = vi.fn().mockResolvedValue(
      jsonResponse(202, {
        launch_id: "rl_exec1",
        status: "accepted",
        to_machine: "cloudbox",
      }),
    ) as unknown as typeof fetch

    const toolDef = createSwarmLaunchTool(
      "http://127.0.0.1:4731",
      "http://127.0.0.1:4096",
      internalFetch,
      daemonFetch,
    )

    const metaFn = vi.fn()
    const ctx = {
      sessionID: "ses_child",
      metadata: metaFn,
    } as any

    const result = await toolDef.execute(
      {
        machine: "cloudbox",
        directory: "~/projects/pigeon",
        prompt: "hello",
      },
      ctx,
    )

    expect(result).toBe("Launch rl_exec1 accepted for cloudbox. The result arrives as a launch.result swarm message.")
    expect(metaFn).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "swarm launch -> cloudbox",
      }),
    )

    // Daemon fetch was called with from: ses_root
    expect(daemonFetch).toHaveBeenCalledTimes(1)
    const [, init] = (daemonFetch as any).mock.calls[0]
    const sentBody = JSON.parse(init.body)
    expect(sentBody.from).toBe("ses_root")
  })
})
