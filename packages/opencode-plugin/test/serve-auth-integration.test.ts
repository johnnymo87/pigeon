import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import plugin from "../src/index"
import { swarmList } from "../src/swarm-list-tool"
import { invalidateServeAuthHeader } from "../src/serve-auth"
import * as daemonClient from "../src/daemon-client"
import * as directChannelModule from "../src/direct-channel"
import type { PluginInput } from "@opencode-ai/plugin"
import {
  OpencodeDirectMessageType,
  OPENCODE_DIRECT_PROTOCOL_VERSION,
  OpencodeDirectSource,
} from "../../daemon/src/opencode-direct/contracts"

describe("Serve HTTP Basic Auth Integration", () => {
  const origPass = process.env.OPENCODE_SERVER_PASSWORD
  const origUser = process.env.OPENCODE_SERVER_USERNAME
  let createdChannels: directChannelModule.DirectChannelServer[] = []

  beforeEach(() => {
    delete process.env.OPENCODE_SERVER_PASSWORD
    delete process.env.OPENCODE_SERVER_USERNAME
    invalidateServeAuthHeader()
    daemonClient._resetBreakerForTesting()

    createdChannels = []
    const origStart = directChannelModule.startDirectChannelServer
    vi.spyOn(directChannelModule, "startDirectChannelServer").mockImplementation(async (opts) => {
      const channel = await origStart(opts)
      createdChannels.push(channel)
      return channel
    })
  })

  afterEach(async () => {
    for (const channel of createdChannels) {
      await channel.close().catch(() => {})
    }
    createdChannels = []

    if (origPass !== undefined) {
      process.env.OPENCODE_SERVER_PASSWORD = origPass
    } else {
      delete process.env.OPENCODE_SERVER_PASSWORD
    }
    if (origUser !== undefined) {
      process.env.OPENCODE_SERVER_USERNAME = origUser
    } else {
      delete process.env.OPENCODE_SERVER_USERNAME
    }
    invalidateServeAuthHeader()
    vi.restoreAllMocks()
  })

  describe("swarmList helper", () => {
    it("sends NO Authorization header when OPENCODE_SERVER_PASSWORD is unset", async () => {
      let capturedRequest: Request | undefined
      const fetchFn = (async (input: RequestInfo | URL) => {
        if (input instanceof Request) {
          capturedRequest = input
        }
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
      }) as typeof fetch

      await swarmList({
        serverUrl: "http://127.0.0.1:4096",
        fetchFn,
      })

      expect(capturedRequest).toBeDefined()
      expect(capturedRequest!.headers.get("Authorization")).toBeNull()
    })

    it("sends Authorization header when OPENCODE_SERVER_PASSWORD is set", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "test-password"
      let capturedRequest: Request | undefined
      const fetchFn = (async (input: RequestInfo | URL) => {
        if (input instanceof Request) {
          capturedRequest = input
        }
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
      }) as typeof fetch

      await swarmList({
        serverUrl: "http://127.0.0.1:4096",
        fetchFn,
      })

      expect(capturedRequest).toBeDefined()
      const expectedAuth = `Basic ${Buffer.from("opencode:test-password").toString("base64")}`
      expect(capturedRequest!.headers.get("Authorization")).toBe(expectedAuth)
    })
  })

  describe("index.ts raw fetch call sites (onExecute / prompt_async and onQuestionReply)", () => {
    let capturedRequests: Request[]
    let mockFetch: typeof fetch
    let registerSessionSpy: any

    beforeEach(() => {
      capturedRequests = []
      mockFetch = (async (input: RequestInfo | URL) => {
        if (input instanceof Request) {
          capturedRequests.push(input)
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }) as typeof fetch

      registerSessionSpy = vi.spyOn(daemonClient, "registerSession").mockResolvedValue({ ok: true })
    })

    function createMockCtx(): PluginInput {
      return {
        serverUrl: new URL("http://127.0.0.1:4096"),
        directory: "/tmp/test-project",
        client: {
          _client: {
            getConfig: () => ({ fetch: mockFetch }),
          },
          app: {
            log: () => {},
          },
          session: {
            get: vi.fn().mockResolvedValue({ data: { id: "ses_1", title: "Test" } }),
          },
        } as any,
        $: (async () => ({ stdout: "123\n456\n" })) as any,
      }
    }

    async function setupPluginAndGetChannel() {
      const ctx = createMockCtx()
      const pluginResult = await plugin(ctx)

      // Trigger session.created to capture directChannel endpoint & token
      await pluginResult.event({
        event: {
          type: "session.created",
          properties: { info: { id: "ses_1" } },
        },
      })

      expect(registerSessionSpy).toHaveBeenCalled()
      const callArgs = registerSessionSpy.mock.calls[0][0]
      const endpoint = callArgs.backendEndpoint as string
      const token = callArgs.backendAuthToken as string

      return { endpoint, token, pluginResult }
    }

    it("prompt_async sends NO Authorization header when password is unset", async () => {
      const { endpoint, token } = await setupPluginAndGetChannel()

      // Send execute command to directChannel
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          type: OpencodeDirectMessageType.Execute,
          version: OPENCODE_DIRECT_PROTOCOL_VERSION,
          requestId: "req_1",
          commandId: "cmd_1",
          sessionId: "ses_1",
          command: "hello",
          source: OpencodeDirectSource.Manual,
          issuedAt: Date.now(),
        }),
      })

      expect(res.status).toBe(200)
      expect(capturedRequests).toHaveLength(1)
      expect(capturedRequests[0]!.url).toBe("http://127.0.0.1:4096/session/ses_1/prompt_async")
      expect(capturedRequests[0]!.headers.get("Authorization")).toBeNull()
    })

    it("prompt_async sends Authorization header when password is set", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "my-serve-pass"
      const { endpoint, token } = await setupPluginAndGetChannel()

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          type: OpencodeDirectMessageType.Execute,
          version: OPENCODE_DIRECT_PROTOCOL_VERSION,
          requestId: "req_2",
          commandId: "cmd_2",
          sessionId: "ses_1",
          command: "hello",
          source: OpencodeDirectSource.Manual,
          issuedAt: Date.now(),
        }),
      })

      expect(res.status).toBe(200)
      expect(capturedRequests).toHaveLength(1)
      expect(capturedRequests[0]!.url).toBe("http://127.0.0.1:4096/session/ses_1/prompt_async")
      const expectedAuth = `Basic ${Buffer.from("opencode:my-serve-pass").toString("base64")}`
      expect(capturedRequests[0]!.headers.get("Authorization")).toBe(expectedAuth)
    })

    it("onQuestionReply sends NO Authorization header when password is unset", async () => {
      const { endpoint, token } = await setupPluginAndGetChannel()
      const replyEndpoint = endpoint.replace("/pigeon/direct/execute", "/pigeon/direct/question-reply")

      const res = await fetch(replyEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          type: OpencodeDirectMessageType.QuestionReply,
          version: OPENCODE_DIRECT_PROTOCOL_VERSION,
          requestId: "req_q1",
          questionRequestId: "q_req_1",
          sessionId: "ses_1",
          answers: [["yes"]],
          issuedAt: Date.now(),
        }),
      })

      expect(res.status).toBe(200)
      expect(capturedRequests).toHaveLength(1)
      expect(capturedRequests[0]!.url).toBe("http://127.0.0.1:4096/question/q_req_1/reply")
      expect(capturedRequests[0]!.headers.get("Authorization")).toBeNull()
    })

    it("onQuestionReply sends Authorization header when password is set", async () => {
      process.env.OPENCODE_SERVER_PASSWORD = "my-serve-pass"
      const { endpoint, token } = await setupPluginAndGetChannel()
      const replyEndpoint = endpoint.replace("/pigeon/direct/execute", "/pigeon/direct/question-reply")

      const res = await fetch(replyEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          type: OpencodeDirectMessageType.QuestionReply,
          version: OPENCODE_DIRECT_PROTOCOL_VERSION,
          requestId: "req_q2",
          questionRequestId: "q_req_2",
          sessionId: "ses_1",
          answers: [["yes"]],
          issuedAt: Date.now(),
        }),
      })

      expect(res.status).toBe(200)
      expect(capturedRequests).toHaveLength(1)
      expect(capturedRequests[0]!.url).toBe("http://127.0.0.1:4096/question/q_req_2/reply")
      const expectedAuth = `Basic ${Buffer.from("opencode:my-serve-pass").toString("base64")}`
      expect(capturedRequests[0]!.headers.get("Authorization")).toBe(expectedAuth)
    })
  })
})
