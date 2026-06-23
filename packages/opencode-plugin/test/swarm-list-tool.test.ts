import { describe, expect, test } from "vitest"
import {
  swarmList,
  formatSessions,
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
