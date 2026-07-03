import { describe, expect, test, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import {
  swarmRead,
  formatInbox,
  createSwarmReadTool,
  SWARM_READ_TOOL_NAME,
  type SwarmInboxMessage,
} from "../src/swarm-tool"

/** Minimal HTTP server helper (mirrors daemon-client.test.ts pattern). */
function createTestServer(
  handler: (req: Request) => Promise<Response> | Response,
): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(async (nodeReq, nodeRes) => {
      const body = await new Promise<string>((res) => {
        let data = ""
        nodeReq.on("data", (chunk: Buffer) => {
          data += chunk.toString()
        })
        nodeReq.on("end", () => res(data))
      })

      const url = new URL(nodeReq.url ?? "/", `http://127.0.0.1`)
      const request = new Request(url, {
        method: nodeReq.method,
        headers: nodeReq.headers as Record<string, string>,
        body:
          nodeReq.method !== "GET" && nodeReq.method !== "HEAD"
            ? body
            : undefined,
      })

      try {
        const response = await handler(request)
        const responseBody = await response.text()
        nodeRes.writeHead(response.status, {
          "content-type":
            response.headers.get("content-type") ?? "application/json",
        })
        nodeRes.end(responseBody)
      } catch {
        nodeRes.writeHead(500)
        nodeRes.end("Internal Server Error")
      }
    })

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as import("node:net").AddressInfo
      resolve({ port: addr.port, close: () => server.close() })
    })
  })
}

const SAMPLE_MESSAGES: SwarmInboxMessage[] = [
  {
    msg_id: "msg_aaa",
    from: "ses_alice",
    kind: "chat",
    priority: "normal",
    payload: "hello world",
    reply_to: null,
    created_at: 1_700_000_000_000,
  },
  {
    msg_id: "msg_bbb",
    from: "ses_bob",
    kind: "task.assign",
    priority: "urgent",
    payload: "please run the diff",
    reply_to: "msg_aaa",
    created_at: 1_700_000_001_000,
  },
]

describe("swarmRead (pure helper)", () => {
  test("hits /swarm/inbox with the calling session id and returns a page", async () => {
    const seenUrls: string[] = []
    const fetchFn = (async (input: RequestInfo | URL) => {
      seenUrls.push(typeof input === "string" ? input : input.toString())
      return new Response(JSON.stringify({ messages: SAMPLE_MESSAGES }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    const page = await swarmRead({
      daemonBaseUrl: "http://daemon.test",
      sessionId: "ses_target",
      fetchFn,
    })

    expect(page.messages).toEqual(SAMPLE_MESSAGES)
    expect(page.hasMore).toBe(false) // absent has_more defaults to false
    expect(seenUrls).toHaveLength(1)
    const url = new URL(seenUrls[0]!)
    expect(url.pathname).toBe("/swarm/inbox")
    expect(url.searchParams.get("session")).toBe("ses_target")
    expect(url.searchParams.get("since")).toBeNull()
    expect(url.searchParams.get("before")).toBeNull()
    expect(url.searchParams.get("limit")).toBeNull()
  })

  test("forwards `since`, `before`, and `limit` as query params", async () => {
    const seenUrls: string[] = []
    const fetchFn = (async (input: RequestInfo | URL) => {
      seenUrls.push(typeof input === "string" ? input : input.toString())
      return new Response(JSON.stringify({ messages: [], has_more: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    await swarmRead(
      {
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_target",
        fetchFn,
      },
      { since: "msg_aaa", before: "msg_zzz", limit: 5 },
    )

    const url = new URL(seenUrls[0]!)
    expect(url.searchParams.get("since")).toBe("msg_aaa")
    expect(url.searchParams.get("before")).toBe("msg_zzz")
    expect(url.searchParams.get("limit")).toBe("5")
  })

  test("parses `has_more` from the response body", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ messages: SAMPLE_MESSAGES, has_more: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch

    const page = await swarmRead({
      daemonBaseUrl: "http://daemon.test",
      sessionId: "ses_target",
      fetchFn,
    })
    expect(page.hasMore).toBe(true)
  })

  test("throws with status + body when daemon returns non-2xx", async () => {
    const fetchFn = (async () =>
      new Response("session unknown", {
        status: 404,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch

    await expect(
      swarmRead({
        daemonBaseUrl: "http://daemon.test",
        sessionId: "ses_target",
        fetchFn,
      }),
    ).rejects.toThrow(/swarm_read failed: 404 session unknown/)
  })

  test("works against a real HTTP server", async () => {
    const requestLog: Array<{ path: string; query: Record<string, string> }> =
      []
    const server = await createTestServer((req) => {
      const url = new URL(req.url)
      const query: Record<string, string> = {}
      for (const [k, v] of url.searchParams) query[k] = v
      requestLog.push({ path: url.pathname, query })
      return new Response(JSON.stringify({ messages: SAMPLE_MESSAGES }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })

    try {
      const page = await swarmRead({
        daemonBaseUrl: `http://127.0.0.1:${server.port}`,
        sessionId: "ses_real",
      })
      expect(page.messages).toEqual(SAMPLE_MESSAGES)
      expect(requestLog).toEqual([
        { path: "/swarm/inbox", query: { session: "ses_real" } },
      ])
    } finally {
      server.close()
    }
  })
})

describe("formatInbox", () => {
  test("returns a placeholder when empty", () => {
    expect(formatInbox([])).toBe("Inbox is empty.")
  })

  test("renders one block per message with routing metadata header", () => {
    const out = formatInbox(SAMPLE_MESSAGES)
    expect(out).toContain("msg_id=msg_aaa")
    expect(out).toContain("from=ses_alice")
    expect(out).toContain("kind=chat")
    expect(out).toContain("priority=normal")
    expect(out).toContain("hello world")
    expect(out).toContain("msg_id=msg_bbb")
    expect(out).toContain("reply_to=msg_aaa")
    expect(out).toContain("kind=task.assign")
    expect(out).toContain("priority=urgent")
    expect(out).toContain("please run the diff")
    // Each message becomes its own block separated by a blank line
    const blocks = out.split("\n\n")
    expect(blocks).toHaveLength(2)
  })

  test("appends a scroll-back hint (before=<oldest>) in recent mode when hasMore", () => {
    const out = formatInbox(SAMPLE_MESSAGES, { hasMore: true, mode: "recent" })
    expect(out).toContain("before=")
    expect(out).toContain("msg_aaa") // oldest returned id
  })

  test("appends a forward hint (since=<newest>) in forward mode when hasMore", () => {
    const out = formatInbox(SAMPLE_MESSAGES, { hasMore: true, mode: "forward" })
    expect(out).toContain("since=")
    expect(out).toContain("msg_bbb") // newest returned id
  })

  test("no pagination hint when hasMore is false", () => {
    const out = formatInbox(SAMPLE_MESSAGES, { hasMore: false, mode: "recent" })
    expect(out).not.toContain("Older messages")
    expect(out).not.toContain("before=")
  })
})

describe("createSwarmReadTool", () => {
  test("builds a ToolDefinition with description + since/before/limit args", () => {
    const def = createSwarmReadTool("http://127.0.0.1:4731")
    expect(typeof def.description).toBe("string")
    expect(def.description.length).toBeGreaterThan(0)
    expect(def.args).toHaveProperty("since")
    expect(def.args).toHaveProperty("before")
    expect(def.args).toHaveProperty("limit")
    expect(typeof def.execute).toBe("function")
  })

  const makeCtx = (
    metadataCalls: Array<{ title?: string; metadata?: unknown }>,
  ) => ({
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

  test("execute() defaults to limit=10, passes sessionID, returns formatted inbox", async () => {
    const seenUrls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seenUrls.push(typeof input === "string" ? input : input.toString())
      return new Response(JSON.stringify({ messages: SAMPLE_MESSAGES, has_more: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    try {
      const def = createSwarmReadTool("http://daemon.test")
      const metadataCalls: Array<{ title?: string; metadata?: unknown }> = []
      const result = await def.execute(
        { since: undefined, before: undefined, limit: undefined },
        makeCtx(metadataCalls) as never,
      )

      expect(seenUrls).toHaveLength(1)
      const url = new URL(seenUrls[0]!)
      expect(url.searchParams.get("session")).toBe("ses_caller")
      expect(url.searchParams.get("limit")).toBe("10") // default
      expect(result).toContain("msg_id=msg_aaa")
      expect(result).toContain("from=ses_alice")
      expect(metadataCalls).toEqual([
        {
          title: "swarm inbox (2)",
          metadata: {
            count: 2,
            since: null,
            before: null,
            limit: 10,
            has_more: false,
          },
        },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("execute() forwards an explicit limit and appends a scroll-back hint when has_more", async () => {
    const seenUrls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seenUrls.push(typeof input === "string" ? input : input.toString())
      return new Response(JSON.stringify({ messages: SAMPLE_MESSAGES, has_more: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    try {
      const def = createSwarmReadTool("http://daemon.test")
      const metadataCalls: Array<{ title?: string; metadata?: unknown }> = []
      const result = await def.execute(
        { since: undefined, before: undefined, limit: 2 },
        makeCtx(metadataCalls) as never,
      )

      const url = new URL(seenUrls[0]!)
      expect(url.searchParams.get("limit")).toBe("2")
      // recent mode (no since) + has_more => hint to page back with before=<oldest>
      expect(result).toContain("before=")
      expect(result).toContain("msg_aaa")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("SWARM_READ_TOOL_NAME (Anthropic compatibility)", () => {
  // Anthropic's API rejects tool names that don't match this regex with
  // "tools.N.custom.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$'"
  // and a 400 error that crashes every fresh opencode session.
  // Notably, '.' (period) is NOT allowed -- so the original "swarm.read"
  // registration broke every fresh session that loaded the plugin.
  const ANTHROPIC_TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,128}$/

  test("registration name matches Anthropic's tool-name regex", () => {
    expect(SWARM_READ_TOOL_NAME).toMatch(ANTHROPIC_TOOL_NAME_REGEX)
  })

  test("registration name does not contain a period (the original bug)", () => {
    expect(SWARM_READ_TOOL_NAME).not.toContain(".")
  })
})
