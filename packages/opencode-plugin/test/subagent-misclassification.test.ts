import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import plugin from "../src/index"
import * as daemonClient from "../src/daemon-client"
import type { PluginInput } from "@opencode-ai/plugin"

/**
 * pigeon-kq6h: when `session.get` fails during late discovery, the fallback
 * registers the session with `parentID` undefined, so `session-state.ts` adds it
 * to `mainSessionIds`. A SUBAGENT then counts as a main session.
 *
 * Pre-existing -- it already affected stop notifications -- but Phase 2 of
 * `pigeon-d95y` made it louder, because a misclassified subagent also MIRRORS
 * its prompts to Telegram, and a subagent prompt is a full task brief.
 *
 * These tests reproduce the symptom through the real plugin entrypoint rather
 * than by asserting on SessionManager directly: the claim under test is about
 * the *fallback path in index.ts*, not about the set semantics.
 */
describe("pigeon-kq6h: subagent misclassified when session.get fails", () => {
  beforeEach(() => {
    daemonClient._resetBreakerForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * `session.get` rejects, exactly as it does when the serve is mid-restart or
   * the HTTP call times out. The plugin never sees the `parentID`, so it cannot
   * know this session is a subagent -- that is the whole bug.
   */
  function createMockCtx(): PluginInput {
    return {
      client: {
        _client: { getConfig: () => ({ fetch: globalThis.fetch }) },
        app: { log: () => {} },
        session: {
          get: vi.fn().mockRejectedValue(new Error("ECONNRESET: serve restarting")),
        },
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

  /**
   * Drive a user-typed prompt through the mirror path for a session the plugin
   * never saw created -- i.e. one that goes through late discovery.
   */
  async function typePromptInto(hooks: any, sessionID: string, text: string) {
    await hooks.event!({
      event: {
        type: "message.updated",
        properties: { info: { id: "msg_sub_1", sessionID, role: "user" } },
      } as any,
    })

    await hooks.event!({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_1",
            messageID: "msg_sub_1",
            sessionID,
            type: "text",
            text,
          },
        },
      } as any,
    })
  }

  async function sessionUpdated(hooks: any, sessionID: string, parentID?: string) {
    await hooks.event!({
      event: {
        type: "session.updated",
        properties: { info: { id: sessionID, title: "Some title", parentID } },
      } as any,
    })
  }

  test("a session whose session.get failed does NOT mirror its prompt (unconfirmed parentage)", async () => {
    const postMirrorSpy = vi
      .spyOn(daemonClient, "postMirror")
      .mockResolvedValue({ mirrored: true })
    vi.spyOn(daemonClient, "registerSession").mockResolvedValue({ ok: true })

    const hooks = await plugin(createMockCtx())

    // ses_sub is a subagent. The plugin cannot tell, because session.get threw --
    // so it must not risk posting what may be a full task brief.
    await typePromptInto(hooks, "ses_sub_t0", "You are a subagent. Full task brief follows...")

    // Well past the 500ms mirror debounce.
    await new Promise((r) => setTimeout(r, 900))

    expect(postMirrorSpy).not.toHaveBeenCalled()
  })

  /**
   * The counterweight, and the more important of the two directions. Failing closed
   * everywhere would silence a genuine main session that merely lost a `session.get`
   * race -- silence is the unrecoverable direction. If someone later "simplifies" the
   * fix by dropping the session on the error path, this test is what stops them.
   */
  test("FAIL-OPEN: a session whose session.get failed STILL sends stop notifications", async () => {
    const sendStopSpy = vi
      .spyOn(daemonClient, "sendStop")
      .mockResolvedValue("success")
    vi.spyOn(daemonClient, "registerSession").mockResolvedValue({ ok: true })

    const hooks = await plugin(createMockCtx())

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: { info: { id: "msg_a1", sessionID: "ses_sub_t1", role: "assistant" } },
      } as any,
    })

    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "ses_sub_t1" } } as any,
    })

    await vi.waitFor(() =>
      expect(sendStopSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "ses_sub_t1" })
      )
    )
  })

  test("CONTROL: when session.get succeeds and reports a parentID, the subagent is correctly excluded", async () => {
    const postMirrorSpy = vi
      .spyOn(daemonClient, "postMirror")
      .mockResolvedValue({ mirrored: true })
    const sendStopSpy = vi
      .spyOn(daemonClient, "sendStop")
      .mockResolvedValue("success")
    vi.spyOn(daemonClient, "registerSession").mockResolvedValue({ ok: true })

    const ctx = createMockCtx()
    ;(ctx.client.session.get as any) = vi
      .fn()
      .mockResolvedValue({ data: { id: "ses_sub_t2", parentID: "ses_parent", title: "sub" } })

    const hooks = await plugin(ctx)

    await typePromptInto(hooks, "ses_sub_t2", "You are a subagent. Full task brief follows...")
    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "ses_sub_t2" } } as any,
    })

    await new Promise((r) => setTimeout(r, 800))

    expect(postMirrorSpy).not.toHaveBeenCalled()
    // Scoped to THIS session: stop delivery is asynchronous now, and an earlier test's
    // queue can still be ticking, so a bare not.toHaveBeenCalled() is not about us.
    expect(sendStopSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "ses_sub_t2" }),
    )
  })

  test("session.updated carrying a parentID DEMOTES a session that was assumed main", async () => {
    const sendStopSpy = vi
      .spyOn(daemonClient, "sendStop")
      .mockResolvedValue("success")
    const postMirrorSpy = vi
      .spyOn(daemonClient, "postMirror")
      .mockResolvedValue({ mirrored: true })
    vi.spyOn(daemonClient, "registerSession").mockResolvedValue({ ok: true })

    const hooks = await plugin(createMockCtx())

    // Late discovery fails -> assumed main -> notifies.
    await hooks.event!({
      event: {
        type: "message.updated",
        properties: { info: { id: "msg_a1", sessionID: "ses_sub_t3", role: "assistant" } },
      } as any,
    })
    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "ses_sub_t3" } } as any,
    })
    await vi.waitFor(() =>
      expect(sendStopSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "ses_sub_t3" }),
      ),
    )

    // The truth arrives for free on session.updated.
    await sessionUpdated(hooks, "ses_sub_t3", "ses_parent")

    sendStopSpy.mockClear()
    await hooks.event!({
      event: {
        type: "message.updated",
        properties: { info: { id: "msg_a2", sessionID: "ses_sub_t3", role: "assistant" } },
      } as any,
    })
    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "ses_sub_t3" } } as any,
    })
    await typePromptInto(hooks, "ses_sub_t3", "another brief")
    await new Promise((r) => setTimeout(r, 900))

    expect(sendStopSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "ses_sub_t3" }),
    )
    expect(postMirrorSpy).not.toHaveBeenCalled()
  })

  /**
   * The asymmetry, pinned. An update that OMITS parentID is not evidence of being a
   * main session -- `session-title.test.ts` (from `2fd9a56`) shows updates can omit
   * the field for a session that really does have a parent. Promoting on absence
   * would reintroduce exactly the leak this change removes, so the session stays
   * unconfirmed and keeps its mirror suppressed, while still notifying normally.
   */
  test("session.updated WITHOUT a parentID does not promote an unconfirmed session", async () => {
    const postMirrorSpy = vi
      .spyOn(daemonClient, "postMirror")
      .mockResolvedValue({ mirrored: true })
    const sendStopSpy = vi
      .spyOn(daemonClient, "sendStop")
      .mockResolvedValue("success")
    vi.spyOn(daemonClient, "registerSession").mockResolvedValue({ ok: true })

    const hooks = await plugin(createMockCtx())

    // Force late discovery (and its failure) to happen first. session.idle is what
    // drives it, via ensureRegistered -- message.updated alone does not.
    await hooks.event!({
      event: {
        type: "message.updated",
        properties: { info: { id: "msg_a1", sessionID: "ses_main_t4", role: "assistant" } },
      } as any,
    })
    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "ses_main_t4" } } as any,
    })

    // session.updated reports no parentID -- which proves nothing either way.
    await sessionUpdated(hooks, "ses_main_t4", undefined)
    sendStopSpy.mockClear()

    await typePromptInto(hooks, "ses_main_t4", "a genuine typed prompt")
    await new Promise((r) => setTimeout(r, 900))

    // Still unconfirmed: no mirror.
    expect(postMirrorSpy).not.toHaveBeenCalled()

    // But emphatically still notifying -- silence is the unrecoverable direction.
    await hooks.event!({
      event: {
        type: "message.updated",
        properties: { info: { id: "msg_a2", sessionID: "ses_main_t4", role: "assistant" } },
      } as any,
    })
    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "ses_main_t4" } } as any,
    })
    // Assert on THIS turn's notification, not on any call left over from msg_a1:
    // delivery is asynchronous now, so a bare "was called" would pass on stale history.
    await vi.waitFor(() =>
      expect(sendStopSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "ses_main_t4",
          notificationId: expect.stringContaining("msg_a2"),
        }),
      ),
    )
  })

  /**
   * The positive control for the mirror wiring, and it is load-bearing.
   *
   * Every other mirror assertion in this file is a `not.toHaveBeenCalled()`, and
   * `message-tail.test.ts` injects its own predicate so it cannot see the wiring in
   * `index.ts`. Without this test, changing that wiring to a constant `() => false`
   * kills mirroring globally and the entire suite still passes -- and it would be
   * invisible in production too, because a missing post is by design a silent gap.
   */
  test("POSITIVE CONTROL: a confirmed main session does mirror its typed prompt", async () => {
    const postMirrorSpy = vi
      .spyOn(daemonClient, "postMirror")
      .mockResolvedValue({ mirrored: true })
    vi.spyOn(daemonClient, "registerSession").mockResolvedValue({ ok: true })

    const hooks = await plugin(createMockCtx())

    // session.created with no parentID: parentage is confirmed main, no session.get.
    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "ses_real_main_t5", title: "Real main" } },
      } as any,
    })

    await typePromptInto(hooks, "ses_real_main_t5", "a genuine human-typed prompt")

    await vi.waitFor(() => expect(postMirrorSpy).toHaveBeenCalled(), { timeout: 3000 })
    expect(postMirrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "ses_real_main_t5" })
    )
  })

  test("a session confirmed as main is never demoted by a later update that omits parentID", async () => {
    vi.spyOn(daemonClient, "registerSession").mockResolvedValue({ ok: true })
    const sendStopSpy = vi
      .spyOn(daemonClient, "sendStop")
      .mockResolvedValue("success")

    const hooks = await plugin(createMockCtx())

    await hooks.event!({
      event: {
        type: "session.created",
        properties: { info: { id: "ses_real_main_t6", title: "Real main" } },
      } as any,
    })

    // Monotonicity: confirmed knowledge must survive a payload that contradicts it.
    await sessionUpdated(hooks, "ses_real_main_t6", "ses_someone_else")

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: { info: { id: "msg_a1", sessionID: "ses_real_main_t6", role: "assistant" } },
      } as any,
    })
    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "ses_real_main_t6" } } as any,
    })

    await vi.waitFor(() =>
      expect(sendStopSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "ses_real_main_t6" })
      )
    )
  })

  test("ensureRegistered still retries a failed registration for unknown parentage", async () => {
    const registerSessionSpy = vi
      .spyOn(daemonClient, "registerSession")
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ ok: true })
    vi.spyOn(daemonClient, "sendStop").mockResolvedValue("success")

    const hooks = await plugin(createMockCtx())

    await hooks.event!({
      event: {
        type: "message.updated",
        properties: { info: { id: "msg_a1", sessionID: "ses_sub_t7", role: "assistant" } },
      } as any,
    })
    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "ses_sub_t7" } } as any,
    })

    expect(registerSessionSpy).toHaveBeenCalledTimes(2)
  })
})
