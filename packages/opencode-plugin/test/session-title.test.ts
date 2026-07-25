import { describe, expect, test, beforeEach, vi, afterEach } from "vitest"
import { SessionManager } from "../src/session-state"
import plugin from "../src/index"
import * as daemonClient from "../src/daemon-client"
import type { PluginInput } from "@opencode-ai/plugin"

describe("Session Title Management", () => {
  describe("SessionManager title state", () => {
    let manager: SessionManager

    beforeEach(() => {
      manager = new SessionManager()
    })

    test("getTitle returns undefined for unknown session", () => {
      expect(manager.getTitle("unknown")).toBeUndefined()
    })

    test("getTitle returns undefined when no title was set", () => {
      manager.onSessionCreated("session-1")
      expect(manager.getTitle("session-1")).toBeUndefined()
    })

    test("onSessionCreated sets initial title when provided", () => {
      manager.onSessionCreated("session-1", undefined, "  My Initial Title  ")
      expect(manager.getTitle("session-1")).toBe("My Initial Title")
    })

    test("setTitle updates session title and trims whitespace", () => {
      manager.onSessionCreated("session-1")
      manager.setTitle("session-1", "  New Refreshed Title  ")
      expect(manager.getTitle("session-1")).toBe("New Refreshed Title")
    })

    test("setTitle with empty/whitespace string sets title to undefined", () => {
      manager.onSessionCreated("session-1", undefined, "Initial Title")
      manager.setTitle("session-1", "   ")
      expect(manager.getTitle("session-1")).toBeUndefined()
    })

    test("setTitle does nothing for unknown session", () => {
      manager.setTitle("unknown", "Some Title")
      expect(manager.getTitle("unknown")).toBeUndefined()
    })

    test("onDeleted cleans up session title", () => {
      manager.onSessionCreated("session-1", undefined, "Title")
      expect(manager.getTitle("session-1")).toBe("Title")

      manager.onDeleted("session-1")
      expect(manager.getTitle("session-1")).toBeUndefined()
    })

    test("onSessionCreated clears previous title on re-creation", () => {
      manager.onSessionCreated("session-1", undefined, "Old Title")
      expect(manager.getTitle("session-1")).toBe("Old Title")

      manager.onSessionCreated("session-1")
      expect(manager.getTitle("session-1")).toBeUndefined()
    })
  })

  describe("Plugin event handling & wiring", () => {
    let registerSessionSpy: any

    beforeEach(() => {
      daemonClient._resetBreakerForTesting()
      registerSessionSpy = vi.spyOn(daemonClient, "registerSession").mockResolvedValue({ ok: true })
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    function createMockCtx(sessionGetMock?: ReturnType<typeof vi.fn>): PluginInput {
      return {
        client: {
          _client: {
            getConfig: () => ({ fetch: globalThis.fetch }),
          },
          app: {
            log: () => {},
          },
          session: {
            get: sessionGetMock ?? vi.fn(),
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

    test("session.updated refreshes session title and re-registers session", async () => {
      const mockCtx = createMockCtx()
      const hooks = await plugin(mockCtx)

      // First, create the session via session.created
      await hooks.event!({
        event: {
          type: "session.created",
          properties: {
            info: { id: "ses_1", title: "Placeholder Title" },
          },
        } as any,
      })

      expect(registerSessionSpy).toHaveBeenCalledTimes(1)
      expect(registerSessionSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionId: "ses_1",
          title: "Placeholder Title",
        })
      )

      registerSessionSpy.mockClear()

      // Now dispatch session.updated with a new title
      await hooks.event!({
        event: {
          type: "session.updated",
          properties: {
            info: { id: "ses_1", title: "Real Generated Title" },
          },
        } as any,
      })

      expect(registerSessionSpy).toHaveBeenCalledTimes(1)
      expect(registerSessionSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionId: "ses_1",
          title: "Real Generated Title",
        })
      )
    })

    test("session.updated debounces when title is unchanged", async () => {
      const mockCtx = createMockCtx()
      const hooks = await plugin(mockCtx)

      await hooks.event!({
        event: {
          type: "session.created",
          properties: {
            info: { id: "ses_1", title: "Title A" },
          },
        } as any,
      })

      registerSessionSpy.mockClear()

      // First session.updated changes title to Title B
      await hooks.event!({
        event: {
          type: "session.updated",
          properties: {
            info: { id: "ses_1", title: "Title B" },
          },
        } as any,
      })

      expect(registerSessionSpy).toHaveBeenCalledTimes(1)
      registerSessionSpy.mockClear()

      // Second session.updated with same title Title B should be ignored
      await hooks.event!({
        event: {
          type: "session.updated",
          properties: {
            info: { id: "ses_1", title: "Title B" },
          },
        } as any,
      })

      expect(registerSessionSpy).toHaveBeenCalledTimes(0)
    })

    test("session.updated ignores unknown session", async () => {
      const mockCtx = createMockCtx()
      const hooks = await plugin(mockCtx)

      await hooks.event!({
        event: {
          type: "session.updated",
          properties: {
            info: { id: "unknown_ses", title: "Some Title" },
          },
        } as any,
      })

      expect(registerSessionSpy).toHaveBeenCalledTimes(0)
    })

    test("session.updated ignores child session with parentID set", async () => {
      const mockCtx = createMockCtx()
      const hooks = await plugin(mockCtx)

      // Create main session and subagent session
      await hooks.event!({
        event: {
          type: "session.created",
          properties: {
            info: { id: "ses_main" },
          },
        } as any,
      })

      await hooks.event!({
        event: {
          type: "session.created",
          properties: {
            info: { id: "ses_child", parentID: "ses_main" },
          },
        } as any,
      })

      registerSessionSpy.mockClear()

      // Dispatch session.updated for child session
      await hooks.event!({
        event: {
          type: "session.updated",
          properties: {
            info: { id: "ses_child", parentID: "ses_main", title: "Child Title" },
          },
        } as any,
      })

      expect(registerSessionSpy).toHaveBeenCalledTimes(0)
    })

    test("session.updated ignores child session even if parentID is omitted in update event", async () => {
      const mockCtx = createMockCtx()
      const hooks = await plugin(mockCtx)

      // Create main session and subagent session
      await hooks.event!({
        event: {
          type: "session.created",
          properties: {
            info: { id: "ses_main" },
          },
        } as any,
      })

      await hooks.event!({
        event: {
          type: "session.created",
          properties: {
            info: { id: "ses_child", parentID: "ses_main" },
          },
        } as any,
      })

      registerSessionSpy.mockClear()

      // Dispatch session.updated for child session WITHOUT parentID in event payload
      await hooks.event!({
        event: {
          type: "session.updated",
          properties: {
            info: { id: "ses_child", title: "Child Title Without ParentID" },
          },
        } as any,
      })

      expect(registerSessionSpy).toHaveBeenCalledTimes(0)
    })

    test("session.updated ignores blank or whitespace-only title", async () => {
      const mockCtx = createMockCtx()
      const hooks = await plugin(mockCtx)

      await hooks.event!({
        event: {
          type: "session.created",
          properties: {
            info: { id: "ses_1", title: "Initial Title" },
          },
        } as any,
      })

      registerSessionSpy.mockClear()

      // Dispatch session.updated with empty/whitespace title
      await hooks.event!({
        event: {
          type: "session.updated",
          properties: {
            info: { id: "ses_1", title: "   " },
          },
        } as any,
      })

      expect(registerSessionSpy).toHaveBeenCalledTimes(0)
    })

    test("session.updated handles non-string title gracefully", async () => {
      const mockCtx = createMockCtx()
      const hooks = await plugin(mockCtx)

      await hooks.event!({
        event: {
          type: "session.created",
          properties: {
            info: { id: "ses_1", title: "Initial Title" },
          },
        } as any,
      })

      registerSessionSpy.mockClear()

      // Dispatch session.updated with non-string title
      await hooks.event!({
        event: {
          type: "session.updated",
          properties: {
            info: { id: "ses_1", title: 12345 },
          },
        } as any,
      })

      expect(registerSessionSpy).toHaveBeenCalledTimes(0)
    })

    describe("Carry-over (A): registration wiring tests", () => {
      test("session.created passes title through to registerSession", async () => {
        const mockCtx = createMockCtx()
        const hooks = await plugin(mockCtx)

        await hooks.event!({
          event: {
            type: "session.created",
            properties: {
              info: { id: "ses_created", title: "Created Title" },
            },
          } as any,
        })

        expect(registerSessionSpy).toHaveBeenCalledTimes(1)
        expect(registerSessionSpy).toHaveBeenLastCalledWith(
          expect.objectContaining({
            sessionId: "ses_created",
            title: "Created Title",
          })
        )
      })

      test("lateDiscoverSession try path passes session.data.title to registerSession", async () => {
        const sessionGetMock = vi.fn().mockResolvedValue({
          data: {
            id: "ses_late_try",
            parentID: undefined,
            title: "Late Discovered Title",
          },
        })

        const mockCtx = createMockCtx(sessionGetMock)
        const hooks = await plugin(mockCtx)

        // Trigger late discover via message.updated for a session not seen in session.created
        await hooks.event!({
          event: {
            type: "message.updated",
            properties: {
              info: {
                id: "msg_1",
                sessionID: "ses_late_try",
                role: "user",
              },
            },
          } as any,
        })

        await vi.waitFor(() => {
          expect(sessionGetMock).toHaveBeenCalledWith({ path: { id: "ses_late_try" } })
          expect(registerSessionSpy).toHaveBeenCalledTimes(1)
        })

        expect(registerSessionSpy).toHaveBeenLastCalledWith(
          expect.objectContaining({
            sessionId: "ses_late_try",
            title: "Late Discovered Title",
          })
        )
      })

      test("lateDiscoverSession catch path passes no title to registerSession", async () => {
        const sessionGetMock = vi.fn().mockRejectedValue(new Error("API error"))

        const mockCtx = createMockCtx(sessionGetMock)
        const hooks = await plugin(mockCtx)

        // Trigger late discover via message.updated
        await hooks.event!({
          event: {
            type: "message.updated",
            properties: {
              info: {
                id: "msg_1",
                sessionID: "ses_late_catch",
                role: "user",
              },
            },
          } as any,
        })

        await vi.waitFor(() => {
          expect(sessionGetMock).toHaveBeenCalledWith({ path: { id: "ses_late_catch" } })
          expect(registerSessionSpy).toHaveBeenCalledTimes(1)
        })

        expect(registerSessionSpy).toHaveBeenLastCalledWith(
          expect.objectContaining({
            sessionId: "ses_late_catch",
          })
        )
        expect(registerSessionSpy.mock.calls[0][0].title).toBeUndefined()
      })
    })

    describe("Notification title wiring tests", () => {
      let notifyStopSpy: any
      let sendQuestionAskedSpy: any

      beforeEach(() => {
        notifyStopSpy = vi.spyOn(daemonClient, "notifyStop").mockResolvedValue({ ok: true, deliveryState: "accepted" })
        sendQuestionAskedSpy = vi.spyOn(daemonClient, "sendQuestionAsked").mockResolvedValue({ ok: true, deliveryState: "accepted" })
      })

      test("session.idle passes live title to notifyStop", async () => {
        const mockCtx = createMockCtx()
        const hooks = await plugin(mockCtx)

        // Create session with title
        await hooks.event!({
          event: {
            type: "session.created",
            properties: { info: { id: "ses_idle_title", title: "Live Idle Title" } },
          } as any,
        })

        // Simulate assistant message updated
        await hooks.event!({
          event: {
            type: "message.updated",
            properties: { info: { id: "msg_idle_1", sessionID: "ses_idle_title", role: "assistant" } },
          } as any,
        })

        // Dispatch session.idle
        await hooks.event!({
          event: {
            type: "session.idle",
            properties: { sessionID: "ses_idle_title" },
          } as any,
        })

        await vi.waitFor(() => {
          expect(notifyStopSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              sessionId: "ses_idle_title",
              title: "Live Idle Title",
            })
          )
        })
      })

      test("question.asked passes live title to sendQuestionAsked", async () => {
        const mockCtx = createMockCtx()
        const hooks = await plugin(mockCtx)

        await hooks.event!({
          event: {
            type: "session.created",
            properties: { info: { id: "ses_q_title", title: "Live Question Title" } },
          } as any,
        })

        await hooks.event!({
          event: {
            type: "question.asked",
            properties: {
              id: "q_1",
              sessionID: "ses_q_title",
              questions: [{ question: "Continue?", header: "Check", options: [] }],
            },
          } as any,
        })

        await vi.waitFor(() => {
          expect(sendQuestionAskedSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              sessionId: "ses_q_title",
              title: "Live Question Title",
            })
          )
        })
      })
    })
  })
})
