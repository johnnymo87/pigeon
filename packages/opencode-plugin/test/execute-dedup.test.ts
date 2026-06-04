import { describe, expect, it, vi } from "vitest"
import {
  OPENCODE_DIRECT_PROTOCOL_VERSION,
  OpencodeDirectMessageType,
  OpencodeDirectSource,
  type ExecuteCommandEnvelope,
} from "../../daemon/src/opencode-direct/contracts"
import type { ExecuteResult } from "../src/direct-channel"
import { withExecuteDedup } from "../src/execute-dedup"

function makeEnvelope(
  commandId: string,
  overrides: Partial<ExecuteCommandEnvelope> = {},
): ExecuteCommandEnvelope {
  return {
    type: OpencodeDirectMessageType.Execute,
    version: OPENCODE_DIRECT_PROTOCOL_VERSION,
    requestId: commandId || "req",
    commandId,
    sessionId: "sess-1",
    command: "do thing",
    source: OpencodeDirectSource.TelegramReply,
    issuedAt: 0,
    ...overrides,
  }
}

describe("withExecuteDedup", () => {
  it("calls onExecute once for a repeated commandId and marks the repeat as a duplicate", async () => {
    const onExecute = vi.fn(async (): Promise<ExecuteResult> => ({ success: true, output: "queued" }))
    const wrapped = withExecuteDedup(onExecute)

    const r1 = await wrapped(makeEnvelope("c1"))
    const r2 = await wrapped(makeEnvelope("c1"))

    expect(onExecute).toHaveBeenCalledTimes(1)
    expect(r1.success).toBe(true)
    expect(r1.output).toBe("queued")
    expect(r2.success).toBe(true)
    expect(r2.output).toBe("duplicate")
  })

  it("calls onExecute once for concurrent duplicate requests (single injection)", async () => {
    let resolveInner!: (r: ExecuteResult) => void
    const onExecute = vi.fn(
      () => new Promise<ExecuteResult>((resolve) => { resolveInner = resolve }),
    )
    const wrapped = withExecuteDedup(onExecute)

    const p1 = wrapped(makeEnvelope("c1"))
    const p2 = wrapped(makeEnvelope("c1"))
    resolveInner({ success: true, output: "queued" })

    const [r1, r2] = await Promise.all([p1, p2])

    expect(onExecute).toHaveBeenCalledTimes(1)
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
  })

  it("calls onExecute for each distinct commandId", async () => {
    const onExecute = vi.fn(async (): Promise<ExecuteResult> => ({ success: true, output: "queued" }))
    const wrapped = withExecuteDedup(onExecute)

    await wrapped(makeEnvelope("c1"))
    await wrapped(makeEnvelope("c2"))

    expect(onExecute).toHaveBeenCalledTimes(2)
  })

  it("does not cache failures: a failed result is re-attempted (at-least-once)", async () => {
    const onExecute = vi
      .fn<() => Promise<ExecuteResult>>()
      .mockResolvedValueOnce({ success: false, errorMessage: "boom" })
      .mockResolvedValueOnce({ success: true, output: "queued" })
    const wrapped = withExecuteDedup(onExecute)

    const r1 = await wrapped(makeEnvelope("c1"))
    const r2 = await wrapped(makeEnvelope("c1"))

    expect(r1.success).toBe(false)
    expect(r2.success).toBe(true)
    expect(onExecute).toHaveBeenCalledTimes(2)
  })

  it("does not cache thrown errors: a throw is re-attempted (at-least-once)", async () => {
    const onExecute = vi
      .fn<() => Promise<ExecuteResult>>()
      .mockRejectedValueOnce(new Error("crash"))
      .mockResolvedValueOnce({ success: true, output: "queued" })
    const wrapped = withExecuteDedup(onExecute)

    await expect(wrapped(makeEnvelope("c1"))).rejects.toThrow("crash")
    const r2 = await wrapped(makeEnvelope("c1"))

    expect(r2.success).toBe(true)
    expect(onExecute).toHaveBeenCalledTimes(2)
  })

  it("converts a synchronous onExecute throw into a rejection and recovers (no stuck in-flight)", async () => {
    const onExecute = vi
      .fn<() => Promise<ExecuteResult>>()
      .mockImplementationOnce(() => {
        throw new Error("sync boom")
      })
      .mockImplementationOnce(async () => ({ success: true, output: "queued" }))
    const wrapped = withExecuteDedup(onExecute)

    // The wrapper must REJECT, not throw synchronously (a sync throw escapes the
    // returned function and leaves the in-flight entry permanently stuck).
    let threwSync = false
    let p: Promise<ExecuteResult>
    try {
      p = wrapped(makeEnvelope("c1"))
    } catch (err) {
      threwSync = true
      p = Promise.reject(err)
    }
    expect(threwSync).toBe(false)
    await expect(p).rejects.toThrow("sync boom")

    // A second call must re-attempt (the stuck in-flight entry must be cleared).
    const r2 = await wrapped(makeEnvelope("c1"))
    expect(r2.success).toBe(true)
    expect(onExecute).toHaveBeenCalledTimes(2)
  })

  it("re-attempts after the dedup entry expires (TTL)", async () => {
    let t = 1_000
    const now = () => t
    const onExecute = vi.fn(async (): Promise<ExecuteResult> => ({ success: true, output: "queued" }))
    const wrapped = withExecuteDedup(onExecute, { ttlMs: 100, now })

    await wrapped(makeEnvelope("c1"))
    t += 101
    await wrapped(makeEnvelope("c1"))

    expect(onExecute).toHaveBeenCalledTimes(2)
  })

  it("treats a reused commandId with a DIFFERENT payload as a distinct delivery (never drops it)", async () => {
    const onExecute = vi.fn(async (req: ExecuteCommandEnvelope): Promise<ExecuteResult> => ({
      success: true,
      output: `queued:${req.command}`,
    }))
    const log = vi.fn()
    const wrapped = withExecuteDedup(onExecute, { log })

    const r1 = await wrapped(makeEnvelope("c1", { command: "first message" }))
    const r2 = await wrapped(makeEnvelope("c1", { command: "SECOND, different message" }))

    // The second (different) payload must be delivered, not silently deduped to
    // the first's cached success — that would drop a user message.
    expect(onExecute).toHaveBeenCalledTimes(2)
    expect(r1.output).toBe("queued:first message")
    expect(r2.output).toBe("queued:SECOND, different message")
    expect(r2.output).not.toBe("duplicate")
    // ...and the anomaly is surfaced loudly for operators.
    expect(log).toHaveBeenCalled()
  })

  it("still dedups a reused commandId with the SAME payload", async () => {
    const onExecute = vi.fn(async (): Promise<ExecuteResult> => ({ success: true, output: "queued" }))
    const wrapped = withExecuteDedup(onExecute)

    await wrapped(makeEnvelope("c1", { command: "same text", media: { mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAAA" } }))
    const r2 = await wrapped(makeEnvelope("c1", { command: "same text", media: { mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAAA" } }))

    expect(onExecute).toHaveBeenCalledTimes(1)
    expect(r2.output).toBe("duplicate")
  })

  it("treats a reused commandId with different media as a distinct delivery", async () => {
    const onExecute = vi.fn(async (): Promise<ExecuteResult> => ({ success: true, output: "queued" }))
    const wrapped = withExecuteDedup(onExecute)

    await wrapped(makeEnvelope("c1", { command: "look", media: { mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAAA" } }))
    await wrapped(makeEnvelope("c1", { command: "look", media: { mime: "image/png", filename: "b.png", url: "data:image/png;base64,BBBB" } }))

    expect(onExecute).toHaveBeenCalledTimes(2)
  })

  it("bypasses dedup when commandId is empty (always executes)", async () => {
    const onExecute = vi.fn(async (): Promise<ExecuteResult> => ({ success: true, output: "queued" }))
    const wrapped = withExecuteDedup(onExecute)

    await wrapped(makeEnvelope(""))
    await wrapped(makeEnvelope(""))

    expect(onExecute).toHaveBeenCalledTimes(2)
  })
})
