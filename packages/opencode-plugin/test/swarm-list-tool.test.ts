import { describe, expect, test } from "vitest"
import {
  swarmList,
  swarmListRemote,
  formatRemoteSessions,
  formatSessions,
  formatGooseSessions,
  swarmListGoose,
  type RemoteSessionsListing,
  createSwarmListTool,
  SWARM_LIST_TOOL_NAME,
  type SwarmSession,
} from "../src/swarm-list-tool"

type Captured = { url: string; init?: RequestInit }

function capturingFetch(
  response: () => Response,
): { fetchFn: typeof fetch; seen: Captured[] } {
  const seen: Captured[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // The plugin wraps requests in `new Request(url, init)`; normalize both.
    if (input instanceof Request) {
      seen.push({ url: input.url, init: { method: input.method } })
    } else {
      seen.push({ url: input.toString(), init })
    }
    return response()
  }) as typeof fetch
  return { fetchFn, seen }
}

const SAMPLE: SwarmSession[] = [
  {
    id: "ses_old",
    title: "older session",
    directory: "/home/dev/projects/a",
    time: { updated: 1_000 },
  },
  {
    id: "ses_new",
    title: "newer session",
    directory: "/home/dev/projects/b",
    time: { updated: 9_000 },
  },
]

function okSessions(sessions: SwarmSession[]): Response {
  return new Response(JSON.stringify(sessions), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

describe("swarmList (pure helper)", () => {
  test("GETs /experimental/session with limit and returns sessions sorted by time.updated desc", async () => {
    const { fetchFn, seen } = capturingFetch(() => okSessions(SAMPLE))

    const result = await swarmList({
      serverUrl: "http://127.0.0.1:4096",
      fetchFn,
      limit: 50,
    })

    expect(seen).toHaveLength(1)
    const url = new URL(seen[0]!.url)
    expect(url.pathname).toBe("/experimental/session")
    expect(url.searchParams.get("limit")).toBe("50")

    // Sorted newest-first.
    expect(result.map((s) => s.id)).toEqual(["ses_new", "ses_old"])
  })

  test("defaults limit to 100 when not provided", async () => {
    const { fetchFn, seen } = capturingFetch(() => okSessions([]))
    await swarmList({ serverUrl: "http://127.0.0.1:4096", fetchFn })
    expect(new URL(seen[0]!.url).searchParams.get("limit")).toBe("100")
  })

  test("throws with status + body on non-2xx", async () => {
    const fetchFn = (async () =>
      new Response("boom", {
        status: 500,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch

    await expect(
      swarmList({ serverUrl: "http://127.0.0.1:4096", fetchFn }),
    ).rejects.toThrow(/swarm_list failed: 500 boom/)
  })
})

describe("formatSessions", () => {
  test("placeholder when empty", () => {
    expect(formatSessions([], 10_000)).toBe("No sessions found.")
  })

  test("renders a header and a row per session with relative updated time", () => {
    const now = 10_000 // ms
    const out = formatSessions(SAMPLE, now)
    expect(out).toContain("ID")
    expect(out).toContain("UPDATED")
    expect(out).toContain("DIRECTORY")
    expect(out).toContain("TITLE")
    expect(out).toContain("ses_old")
    expect(out).toContain("ses_new")
    expect(out).toContain("/home/dev/projects/b")
    expect(out).toContain("newer session")
    // ses_new updated at 9_000, now 10_000 -> 1s ago
    expect(out).toMatch(/ses_new\s+1s/)
  })
})

describe("createSwarmListTool", () => {
  test("builds a ToolDefinition with a description and execute", () => {
    const { fetchFn } = capturingFetch(() => okSessions([]))
    const def = createSwarmListTool("http://127.0.0.1:4096", fetchFn)
    expect(typeof def.description).toBe("string")
    expect(def.description.length).toBeGreaterThan(0)
    expect(typeof def.execute).toBe("function")
  })

  test("execute() returns a formatted list and reports count in metadata", async () => {
    const { fetchFn } = capturingFetch(() => okSessions(SAMPLE))
    const def = createSwarmListTool("http://127.0.0.1:4096", fetchFn)
    const metadataCalls: Array<{ title?: string; metadata?: unknown }> = []
    const result = await def.execute(
      {},
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

    expect(result).toContain("ses_new")
    expect(result).toContain("ses_old")
    expect(metadataCalls).toHaveLength(1)
    expect(metadataCalls[0]!.title).toContain("2")
    expect((metadataCalls[0]!.metadata as { count: number }).count).toBe(2)
  })
})

describe("SWARM_LIST_TOOL_NAME (Anthropic compatibility)", () => {
  const ANTHROPIC_TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,128}$/
  test("registration name matches Anthropic's tool-name regex", () => {
    expect(SWARM_LIST_TOOL_NAME).toMatch(ANTHROPIC_TOOL_NAME_REGEX)
  })
  test("registration name does not contain a period", () => {
    expect(SWARM_LIST_TOOL_NAME).not.toContain(".")
  })
})

// ---------------------------------------------------------------------------
// remote: true (pigeon-k0qn.9)
// ---------------------------------------------------------------------------

const REMOTE: RemoteSessionsListing = {
  machine_id: "cloudbox",
  sessions: [
    { session_id: "ses_onDevbox01", machine_id: "devbox", label: "pigeon", updated_at: 7_000 },
    { session_id: "ses_onMac00001", machine_id: "macbook", label: null, updated_at: 4_000 },
  ],
  machines: [
    { machine_id: "devbox", relay: "available", last_poll_at: 9_000 },
    { machine_id: "macbook", relay: "offline", last_poll_at: 1_000 },
  ],
  truncated: false,
  relay_send: true,
}

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

const ctx = (metadataCalls: Array<{ title?: string; metadata?: unknown }>) => ({
  sessionID: "ses_caller",
  messageID: "msg_x",
  agent: "build",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: (input: { title?: string; metadata?: unknown }) => {
    metadataCalls.push(input)
  },
  ask: async () => {},
})

describe("swarmListRemote (pure helper)", () => {
  test("GETs the daemon's /swarm/remote-sessions, passing limit only when given", async () => {
    const { fetchFn, seen } = capturingFetch(() => okJson(REMOTE))
    const out = await swarmListRemote({ daemonBaseUrl: "http://127.0.0.1:4731", fetchFn, limit: 20 })
    expect(out).toEqual(REMOTE)
    const url = new URL(seen[0]!.url)
    expect(url.origin).toBe("http://127.0.0.1:4731")
    expect(url.pathname).toBe("/swarm/remote-sessions")
    expect(url.searchParams.get("limit")).toBe("20")

    await swarmListRemote({ daemonBaseUrl: "http://127.0.0.1:4731", fetchFn })
    expect(new URL(seen[1]!.url).searchParams.has("limit")).toBe(false)
  })

  test("throws with status and body on non-2xx", async () => {
    const fetchFn = (async () =>
      okJson({ error: "worker_error", worker_status: 404, worker_error: null }, 502)) as typeof fetch
    await expect(swarmListRemote({ daemonBaseUrl: "http://127.0.0.1:4731", fetchFn })).rejects.toThrow(
      /swarm_list remote failed: 502 .*worker_error/,
    )
  })
})

describe("formatRemoteSessions", () => {
  test("placeholder when there are no remote sessions", () => {
    const out = formatRemoteSessions({ ...REMOTE, sessions: [], machines: [] }, 10_000)
    expect(out).toContain("No sessions on other machines")
  })

  test("renders id, age, machine and label, then each machine's relay status", () => {
    const out = formatRemoteSessions(REMOTE, 10_000)
    expect(out).toMatch(/ses_onDevbox01\s+3s\s+devbox\s+"pigeon"/)
    expect(out).toContain("SEEN")
    expect(out).toMatch(/ses_onMac00001\s+6s\s+macbook/)
    expect(out).toMatch(/devbox: available/)
    expect(out).toMatch(/macbook: offline/)
    expect(out).not.toMatch(/does not relay/)
    expect(out).not.toMatch(/more sessions/)
  })

  test("explains each non-available relay status and offline hold window", () => {
    const now = 1_000_000_000
    const out = formatRemoteSessions(
      {
        ...REMOTE,
        machines: [
          { machine_id: "a", relay: "not_accepted", last_poll_at: now - 1000 },
          { machine_id: "b", relay: "not_retired", last_poll_at: now - 1000 },
          { machine_id: "c", relay: "offline", last_poll_at: null },
          { machine_id: "d", relay: "unknown", last_poll_at: null },
          { machine_id: "e", relay: "offline", last_poll_at: now - 3600_000 }, // 1h ago
          { machine_id: "f", relay: "offline", last_poll_at: now - 8 * 86400_000 }, // 8d ago
        ],
      },
      now,
    )
    expect(out).toMatch(/a: not_accepted .*does not accept relays from cloudbox/)
    expect(out).toMatch(/b: not_retired .*shared worker key/)
    expect(out).toMatch(/c: offline \(c is not polling the worker; asleep or down\)/)
    expect(out).toMatch(/d: unknown/)
    expect(out).toMatch(
      /e: offline \(e last polled 1h ago; a message sent now is held up to 24h and delivered if it wakes in time\)/,
    )
    expect(out).toMatch(/f: offline \(f has not polled for 8d; sends are refused\)/)
  })

  test("header explains that available and offline within 7 days are queued by worker", () => {
    const out = formatRemoteSessions(REMOTE, 10_000)
    expect(out).toContain('"available" and "offline" (within 7 days) are queued by the worker')
    expect(out).not.toContain('"available" means the worker will queue it')
  })

  test("warns when this machine does not relay, and when the list was truncated", () => {
    const out = formatRemoteSessions({ ...REMOTE, relay_send: false, truncated: true }, 10_000)
    expect(out).toMatch(/cloudbox does not relay/)
    expect(out).toMatch(/PIGEON_SWARM_RELAY_SEND/)
    expect(out).toMatch(/more sessions matched; pass a larger limit, up to 500/)
  })
})

describe("createSwarmListTool remote: true", () => {
  test("lists remote sessions through the daemon, not the serve", async () => {
    const serve = capturingFetch(() => okSessions(SAMPLE))
    const daemon = capturingFetch(() => okJson(REMOTE))
    const def = createSwarmListTool("http://127.0.0.1:4096", serve.fetchFn, {
      daemonBaseUrl: "http://127.0.0.1:4731",
      fetchFn: daemon.fetchFn,
    })
    const metadataCalls: Array<{ title?: string; metadata?: unknown }> = []
    const result = await def.execute({ remote: true, limit: 5 }, ctx(metadataCalls))
    expect(serve.seen).toHaveLength(0)
    expect(new URL(daemon.seen[0]!.url).searchParams.get("limit")).toBe("5")
    expect(result).toContain("ses_onDevbox01")
    expect(metadataCalls[0]!.title).toContain("remote")
    expect((metadataCalls[0]!.metadata as { count: number }).count).toBe(2)
  })

  test("remote omitted or false keeps the local listing", async () => {
    const serve = capturingFetch(() => okSessions(SAMPLE))
    const daemon = capturingFetch(() => okJson(REMOTE))
    const def = createSwarmListTool("http://127.0.0.1:4096", serve.fetchFn, {
      daemonBaseUrl: "http://127.0.0.1:4731",
      fetchFn: daemon.fetchFn,
    })
    await def.execute({ remote: false }, ctx([]))
    await def.execute({}, ctx([]))
    expect(serve.seen).toHaveLength(2)
    // The local listing asks the daemon only for this machine's goose sessions.
    expect(daemon.seen.map((c) => new URL(c.url).pathname)).toEqual(["/swarm/goose-sessions", "/swarm/goose-sessions"])
  })
})

// ---------------------------------------------------------------------------
// goose sessions and coordinators (pigeon-a0o8)
// ---------------------------------------------------------------------------

const GOOSE = {
  sessions: [
    {
      session_id: "gse_c82dc1cc-cd47-50fd-a5a2-7860b54abc20",
      label: "📋 eternal-machinery",
      title: null,
      cwd: "/tmp",
      last_seen: 4_000,
      program: "eternal-machinery",
      rotation_pending: false,
    },
    { session_id: "gse_chat0000000001", label: "20261104_2", title: "e2e pong", cwd: "/tmp", last_seen: 9_000, program: null },
  ],
}

describe("local swarm_list lists goose sessions too (pigeon-a0o8)", () => {
  const tool = (daemonResponse: () => Response) => {
    const serve = capturingFetch(() => okSessions(SAMPLE))
    const daemon = capturingFetch(daemonResponse)
    return createSwarmListTool("http://127.0.0.1:4096", serve.fetchFn, {
      daemonBaseUrl: "http://127.0.0.1:4731",
      fetchFn: daemon.fetchFn,
    })
  }

  test("appends the goose table after the opencode one, marking coordinators", async () => {
    const out = (await tool(() => okJson(GOOSE)).execute({}, ctx([]))) as string
    expect(out.indexOf("ses_new")).toBeLessThan(out.indexOf("Goose sessions on this machine"))
    expect(out).toMatch(/gse_c82dc1cc-cd47-50fd-a5a2-7860b54abc20\s+\S+\s+"📋 eternal-machinery"\s+coordinator of eternal-machinery/)
    expect(out).toMatch(/gse_chat0000000001\s+\S+\s+"e2e pong"$/m)
    expect(out).toMatch(/Program coordinators on other machines: swarm_list with remote: true\.$/)
  })

  test("marks a program whose coordinator rotation is pending", () => {
    const out = formatGooseSessions([{ ...GOOSE.sessions[0]!, rotation_pending: true }], 10_000)
    expect(out).toContain("coordinator of eternal-machinery (rotation pending")
  })

  test("a daemon failure costs one line, never the opencode listing", async () => {
    const cases: Array<[() => Response, RegExp]> = [
      [() => okJson({ error: "nope" }, 404), /could not be listed: this machine's pigeon daemon is too old/],
      [() => okJson({ error: "boom" }, 500), /could not be listed: daemon answered 500/],
      [() => { throw new Error("ECONNREFUSED") }, /could not be listed: ECONNREFUSED/],
    ]
    for (const [res, line] of cases) {
      const out = (await tool(res).execute({}, ctx([]))) as string
      expect(out).toContain("ses_new")
      expect(out).toMatch(line)
    }
  })

  test("without a daemon configured, says so", async () => {
    const serve = capturingFetch(() => okSessions(SAMPLE))
    const out = (await createSwarmListTool("http://127.0.0.1:4096", serve.fetchFn).execute({}, ctx([]))) as string
    expect(out).toContain("ses_new")
    expect(out).toMatch(/could not be listed: no pigeon daemon is configured/)
  })

  test("swarmListGoose gives up after its timeout", async () => {
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timed out"))))) as typeof fetch
    await expect(swarmListGoose({ daemonBaseUrl: "http://127.0.0.1:4731", fetchFn: hang, timeoutMs: 20 })).rejects.toThrow(/timed out/)
  })

  test("remote listing prints coordinators on other machines first", () => {
    const out = formatRemoteSessions(
      {
        ...REMOTE,
        coordinators: [
          { session_id: "gse_onCloudbox0001", machine_id: "cloudbox2", program: "pigeon", label: "📋 pigeon", updated_at: 9_000 },
        ],
      },
      10_000,
    )
    expect(out.indexOf("Program coordinators")).toBeLessThan(out.indexOf("Sessions on machines other than"))
    expect(out).toMatch(/gse_onCloudbox0001\s+cloudbox2\s+coordinator of pigeon/)
  })

  test("remote listing with only coordinators is not reported as empty", () => {
    const out = formatRemoteSessions(
      {
        ...REMOTE,
        sessions: [],
        coordinators: [{ session_id: "gse_onCloudbox0001", machine_id: "x", program: "p", label: null, updated_at: 1 }],
      },
      10_000,
    )
    expect(out).not.toContain("No sessions on other machines")
    expect(out).toContain("coordinator of p")
  })
})
