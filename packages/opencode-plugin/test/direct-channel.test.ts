import { afterEach, describe, expect, it, vi } from "vitest"
import {
  OPENCODE_DIRECT_PROTOCOL_VERSION,
  OpencodeDirectMessageType,
  OpencodeDirectSource,
  ResultErrorCode,
} from "../../daemon/src/opencode-direct/contracts"
import { startDirectChannelServer } from "../src/direct-channel"

describe("direct channel server", () => {
  const closers: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (closers.length > 0) {
      const close = closers.pop()
      if (close) await close()
    }
  })

  it("rejects unauthorized requests", async () => {
    const server = await startDirectChannelServer({
      onExecute: async () => ({ success: true }),
    })
    closers.push(server.close)

    const response = await fetch(server.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(401)
    const body = await response.json() as { ack: { accepted: boolean; rejectReason: string } }
    expect(body.ack.accepted).toBe(false)
    expect(body.ack.rejectReason).toBe("UNAUTHORIZED")
  })

  it("rejects invalid payload", async () => {
    const server = await startDirectChannelServer({
      onExecute: async () => ({ success: true }),
    })
    closers.push(server.close)

    const response = await fetch(server.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${server.authToken}`,
      },
      body: JSON.stringify({ type: "wrong" }),
    })

    expect(response.status).toBe(400)
    const body = await response.json() as { ack: { accepted: boolean; rejectReason: string } }
    expect(body.ack.accepted).toBe(false)
    expect(body.ack.rejectReason).toBe("INVALID_PAYLOAD")
  })

  it("executes command and returns ack/result envelopes", async () => {
    const onExecute = vi.fn(async () => ({ success: true, output: "ok" }))
    const server = await startDirectChannelServer({ onExecute })
    closers.push(server.close)

    const request = {
      type: OpencodeDirectMessageType.Execute,
      version: OPENCODE_DIRECT_PROTOCOL_VERSION,
      requestId: "req-1",
      commandId: "cmd-1",
      sessionId: "sess-1",
      command: "echo ok",
      source: OpencodeDirectSource.TelegramReply,
      issuedAt: Date.now(),
    }

    const response = await fetch(server.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${server.authToken}`,
      },
      body: JSON.stringify(request),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as {
      ack: { accepted: boolean; commandId: string }
      result: { success: boolean; output?: string }
    }

    expect(body.ack.accepted).toBe(true)
    expect(body.ack.commandId).toBe("cmd-1")
    expect(body.result.success).toBe(true)
    expect(body.result.output).toBe("ok")
    expect(onExecute).toHaveBeenCalledTimes(1)
  })

  it("returns internal result envelope when execution throws", async () => {
    const server = await startDirectChannelServer({
      onExecute: async () => {
        throw new Error("boom")
      },
    })
    closers.push(server.close)

    const request = {
      type: OpencodeDirectMessageType.Execute,
      version: OPENCODE_DIRECT_PROTOCOL_VERSION,
      requestId: "req-2",
      commandId: "cmd-2",
      sessionId: "sess-2",
      command: "echo fail",
      source: OpencodeDirectSource.TelegramCallback,
      issuedAt: Date.now(),
    }

    const response = await fetch(server.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${server.authToken}`,
      },
      body: JSON.stringify(request),
    })

    expect(response.status).toBe(500)
    const body = await response.json() as {
      ack: { accepted: boolean }
      result: { success: boolean; errorCode?: string; errorMessage?: string }
    }
    expect(body.ack.accepted).toBe(true)
    expect(body.result.success).toBe(false)
    expect(body.result.errorCode).toBe(ResultErrorCode.Internal)
    expect(body.result.errorMessage).toContain("boom")
  })
})
