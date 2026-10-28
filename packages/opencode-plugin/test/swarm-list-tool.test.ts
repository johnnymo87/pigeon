import { describe, expect, test } from "vitest"
import {
  swarmList,
  swarmListRemote,
  formatRemoteSessions,
  formatSessions,
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

  test("explains each non-available relay status", () => {
    const out = formatRemoteSessions(
      {
        ...REMOTE,
        machines: [
          { machine_id: "a", relay: "not_accepted", last_poll_at: 1 },
          { machine_id: "b", relay: "not_retired", last_poll_at: 1 },
          { machine_id: "c", relay: "offline", last_poll_at: null },
          { machine_id: "d", relay: "unknown", last_poll_at: null },
        ],
      },
      10_000,
    )
    expect(out).toMatch(/a: not_accepted .*does not accept relays from cloudbox/)
    expect(out).toMatch(/b: not_retired .*shared worker key/)
    expect(out).toMatch(/c: offline .*not polling/)
    expect(out).toMatch(/d: unknown/)
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
    expect(daemon.seen).toHaveLength(0)
  })
})
