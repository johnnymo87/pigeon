import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import plugin from "../src/index"
import * as daemonClient from "../src/daemon-client"
import type { PluginInput } from "@opencode-ai/plugin"

/**
 * pigeon-4ogz.21: a session deleted in the TUI used to keep its daemon row, so its topic (or
 * Slack channel) stayed open until the 7-day reaper. The plugin now reports the delete -- and
 * must not then re-register the session from a late event, which would reopen what the
 * teardown closed.
 */
describe("session.deleted reports the delete to the daemon", () => {
  let registerSpy: any
  let reportSpy: any
  let sendStopSpy: any
  let sessionGet: any

  beforeEach(() => {
    daemonClient._resetBreakerForTesting()
    daemonClient._resetStopSkewForTesting()
    registerSpy = vi.spyOn(daemonClient, "registerSession").mockResolvedValue({ ok: true })
    reportSpy = vi.spyOn(daemonClient, "reportSessionDeleted").mockResolvedValue(true)
    sendStopSpy = vi.spyOn(daemonClient, "sendStop").mockResolvedValue("success")
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function createMockCtx(): PluginInput {
    sessionGet = vi.fn().mockRejectedValue(new Error("404 session not found"))
    return {
      client: {
        _client: { getConfig: () => ({ fetch: globalThis.fetch }) },
        app: { log: () => {} },
        session: { get: sessionGet },
      } as any,
      project: {} as any,
      directory: "/path/to/my-project",
      worktree: "/path/to/my-project",
      serverUrl: new URL("http://localhost:4096"),
      $: (() => {
        throw new Error("no shell")
      }) as any,
    }
  }

  const ev = (type: string, properties: unknown) => ({ event: { type, properties } as any })

  async function flush() {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
  }

  test("reports a deleted main session", async () => {
    const hooks = await plugin(createMockCtx())
    await hooks.event!(ev("session.created", { info: { id: "ses_1", title: "T" } }))
    await flush()

    await hooks.event!(ev("session.deleted", { info: { id: "ses_1" } }))
    await flush()

    expect(reportSpy).toHaveBeenCalledTimes(1)
    expect(reportSpy.mock.calls[0][0]).toMatchObject({ sessionId: "ses_1" })
  })

  test("reports a main session this plugin never saw (deleted from another serve)", async () => {
    const hooks = await plugin(createMockCtx())

    await hooks.event!(ev("session.deleted", { info: { id: "ses_other" } }))
    await flush()

    expect(reportSpy).toHaveBeenCalledTimes(1)
    expect(reportSpy.mock.calls[0][0]).toMatchObject({ sessionId: "ses_other" })
  })

  test("does not report a subagent", async () => {
    const hooks = await plugin(createMockCtx())
    await hooks.event!(ev("session.created", { info: { id: "ses_sub", parentID: "ses_1" } }))

    await hooks.event!(ev("session.deleted", { info: { id: "ses_sub", parentID: "ses_1" } }))
    await hooks.event!(ev("session.deleted", { info: { id: "ses_sub2", parentID: "ses_1" } }))
    await flush()

    expect(reportSpy).not.toHaveBeenCalled()
  })

  test("does not re-register a deleted session when a late event names it", async () => {
    const hooks = await plugin(createMockCtx())
    await hooks.event!(ev("session.created", { info: { id: "ses_1", title: "T" } }))
    await flush()
    registerSpy.mockClear()

    await hooks.event!(ev("session.deleted", { info: { id: "ses_1" } }))
    await hooks.event!(ev("message.updated", { info: { id: "msg_9", sessionID: "ses_1", role: "assistant" } }))
    await hooks.event!(ev("message.part.updated", { part: { id: "p", sessionID: "ses_1", messageID: "msg_9", type: "text", text: "x" } }))
    await hooks.event!(ev("session.idle", { sessionID: "ses_1" }))
    await hooks.event!(ev("session.error", { sessionID: "ses_1", error: { name: "MessageAbortedError" } }))
    await flush()

    expect(registerSpy).not.toHaveBeenCalled()
    expect(sessionGet).not.toHaveBeenCalled()
  })

  test("a queued stop for a deleted session is dropped on 404, not repaired by re-registering", async () => {
    let answer!: (o: string) => void
    sendStopSpy.mockImplementation(() => new Promise((r) => { answer = r }))
    const hooks = await plugin(createMockCtx())
    await hooks.event!(ev("session.created", { info: { id: "ses_1", title: "T" } }))
    await hooks.event!(ev("message.updated", { info: { id: "msg_1", sessionID: "ses_1", role: "assistant" } }))
    await flush()
    registerSpy.mockClear()

    await hooks.event!(ev("session.idle", { sessionID: "ses_1" }))
    await vi.waitFor(() => expect(sendStopSpy).toHaveBeenCalledTimes(1))
    await hooks.event!(ev("session.deleted", { info: { id: "ses_1" } }))
    answer("unregistered")
    await new Promise((r) => setTimeout(r, 50))
    await flush()

    expect(sendStopSpy).toHaveBeenCalledTimes(1)
    expect(registerSpy).not.toHaveBeenCalled()
  })
})
