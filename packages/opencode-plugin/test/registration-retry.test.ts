import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import plugin from "../src/index"
import * as daemonClient from "../src/daemon-client"
import type { PluginInput } from "@opencode-ai/plugin"

/**
 * Regression: a session whose registration failed (daemon timeout) stayed
 * `isRegistered=false` forever, so every subsequent `session.idle` silently
 * skipped `notifyStop`. The daemon had actually recorded the session, so
 * nothing looked wrong from the outside -- the user just stopped receiving
 * Telegram notifications for that session until the serve restarted.
 */
describe("registration retry after a failed registration", () => {
  let registerSessionSpy: any
  let notifyStopSpy: any

  beforeEach(() => {
    daemonClient._resetBreakerForTesting()
    notifyStopSpy = vi.spyOn(daemonClient, "notifyStop").mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function createMockCtx(): PluginInput {
    return {
      client: {
        _client: {
          getConfig: () => ({ fetch: globalThis.fetch }),
        },
        app: { log: () => {} },
        session: { get: vi.fn() },
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

  async function createSessionThenIdle(hooks: any) {
    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "ses_1", title: "Title" } },
      } as any,
    })

    // An assistant message gives session.idle a currentMessageId to dedup on.
    await hooks.event!({
      event: {
        type: "message.updated",
        properties: { info: { id: "msg_1", sessionID: "ses_1", role: "assistant" } },
      } as any,
    })

    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "ses_1" } } as any,
    })
  }

  test("session.idle retries registration and notifies when the first attempt failed", async () => {
    // First attempt fails the way a daemon timeout does: resolves null.
    registerSessionSpy = vi
      .spyOn(daemonClient, "registerSession")
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ ok: true })

    const hooks = await plugin(createMockCtx())
    await createSessionThenIdle(hooks)

    expect(registerSessionSpy).toHaveBeenCalledTimes(2)
    expect(notifyStopSpy).toHaveBeenCalledTimes(1)
    expect(notifyStopSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "ses_1" })
    )
  })

  test("session.idle does not re-register a session that is already registered", async () => {
    registerSessionSpy = vi
      .spyOn(daemonClient, "registerSession")
      .mockResolvedValue({ ok: true })

    const hooks = await plugin(createMockCtx())
    await createSessionThenIdle(hooks)

    expect(registerSessionSpy).toHaveBeenCalledTimes(1)
    expect(notifyStopSpy).toHaveBeenCalledTimes(1)
  })

  test("question.asked retries registration too, not only session.idle", async () => {
    registerSessionSpy = vi
      .spyOn(daemonClient, "registerSession")
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ ok: true })
    const sendQuestionAskedSpy = vi
      .spyOn(daemonClient, "sendQuestionAsked")
      .mockResolvedValue({ ok: true })

    const hooks = await plugin(createMockCtx())

    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "ses_1", title: "Title" } },
      } as any,
    })

    await hooks.event!({
      event: {
        type: "question.asked",
        properties: {
          sessionID: "ses_1",
          id: "req_1",
          questions: [{ question: "Proceed?", header: "Proceed", options: [] }],
        },
      } as any,
    })

    expect(registerSessionSpy).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(sendQuestionAskedSpy).toHaveBeenCalled())
  })

  test("a retry that also fails stays silent rather than notifying", async () => {
    registerSessionSpy = vi.spyOn(daemonClient, "registerSession").mockResolvedValue(null)

    const hooks = await plugin(createMockCtx())
    await createSessionThenIdle(hooks)

    expect(registerSessionSpy).toHaveBeenCalledTimes(2)
    expect(notifyStopSpy).not.toHaveBeenCalled()
  })
})
