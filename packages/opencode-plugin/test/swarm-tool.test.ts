import { describe, expect, test, beforeEach, afterEach } from "vitest"
import * as http from "node:http"
import {
  swarmRead,
  formatInbox,
  createSwarmReadTool,
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
  test("hits /swarm/inbox with the calling session id and returns messages", async () => {
    const seenUrls: string[] = []
    const fetchFn = (async (input: RequestInfo | URL) => {
      seenUrls.push(typeof input === "string" ? input : input.toString())
      return new Response(JSON.stringify({ messages: SAMPLE_MESSAGES }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    const messages = await swarmRead({
      daemonBaseUrl: "http://daemon.test",
      sessionId: "ses_target",
      fetchFn,
    })

    expect(messages).toEqual(SAMPLE_MESSAGES)
    expect(seenUrls).toHaveLength(1)
    const url = new URL(seenUrls[0]!)
    expect(url.pathname).toBe("/swarm/inbox")
    expect(url.searchParams.get("session")).toBe("ses_target")
    expect(url.searchParams.get("since")).toBeNull()
  })

  test("forwards `since` cursor as a query param", async () => {
    const seenUrls: string[] = []
    const fetchFn = (async (input: RequestInfo | URL) => {
      seenUrls.push(typeof input === "string" ? input : input.toString())
      return new Response(JSON.stringify({ messages: [] }), {
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
      "msg_aaa",
    )

    const url = new URL(seenUrls[0]!)
    expect(url.searchParams.get("since")).toBe("msg_aaa")
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
    ).rejects.toThrow(/swarm\.read failed: 404 session unknown/)
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
      const messages = await swarmRead({
        daemonBaseUrl: `http://127.0.0.1:${server.port}`,
        sessionId: "ses_real",
      })
      expect(messages).toEqual(SAMPLE_MESSAGES)
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
})

describe("createSwarmReadTool", () => {
  test("builds a ToolDefinition with description + args.since schema", () => {
    const def = createSwarmReadTool("http://127.0.0.1:4731")
    expect(typeof def.description).toBe("string")
    expect(def.description.length).toBeGreaterThan(0)
    expect(def.args).toHaveProperty("since")
    expect(typeof def.execute).toBe("function")
  })

  test("execute() calls the daemon with the ToolContext sessionID and returns formatted inbox", async () => {
    const seenUrls: string[] = []
    // Patch global fetch for this test (the tool factory doesn't accept a fetchFn).
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seenUrls.push(typeof input === "string" ? input : input.toString())
      return new Response(JSON.stringify({ messages: SAMPLE_MESSAGES }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    try {
      const def = createSwarmReadTool("http://daemon.test")
      const metadataCalls: Array<{ title?: string; metadata?: unknown }> = []
      const result = await def.execute(
        { since: undefined },
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

      expect(seenUrls).toHaveLength(1)
      const url = new URL(seenUrls[0]!)
      expect(url.searchParams.get("session")).toBe("ses_caller")
      expect(result).toContain("msg_id=msg_aaa")
      expect(result).toContain("from=ses_alice")
      expect(metadataCalls).toEqual([
        {
          title: "swarm inbox (2)",
          metadata: { count: 2, since: null },
        },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
