import { describe, expect, test, beforeEach } from "vitest"
import { SessionManager } from "../src/session-state"

describe("SessionManager", () => {
  let manager: SessionManager

  beforeEach(() => {
    manager = new SessionManager()
  })

  describe("main session detection", () => {
    test("should detect main session when parentID is undefined", () => {
      manager.onSessionCreated("main-session")

      expect(manager.isMainSession("main-session")).toBe(true)
    })

    test("should not detect subagent as main session", () => {
      manager.onSessionCreated("main-session")
      manager.onSessionCreated("subagent-session", "main-session")

      expect(manager.isMainSession("main-session")).toBe(true)
      expect(manager.isMainSession("subagent-session")).toBe(false)
    })

    test("should treat multiple concurrent parentless sessions as main", () => {
      manager.onSessionCreated("first-session")
      expect(manager.isMainSession("first-session")).toBe(true)

      manager.onSessionCreated("second-session")
      expect(manager.isMainSession("first-session")).toBe(true)
      expect(manager.isMainSession("second-session")).toBe(true)
    })

    test("should treat three concurrent parentless sessions as main", () => {
      manager.onSessionCreated("session-a")
      manager.onSessionCreated("session-b")
      manager.onSessionCreated("session-c")

      expect(manager.isMainSession("session-a")).toBe(true)
      expect(manager.isMainSession("session-b")).toBe(true)
      expect(manager.isMainSession("session-c")).toBe(true)
    })

    test("should remove only deleted session from main set", () => {
      manager.onSessionCreated("session-a")
      manager.onSessionCreated("session-b")
      manager.onSessionCreated("session-c")

      manager.onDeleted("session-b")

      expect(manager.isMainSession("session-a")).toBe(true)
      expect(manager.isMainSession("session-b")).toBe(false)
      expect(manager.isMainSession("session-c")).toBe(true)
    })

    test("should allow each main session to independently notify", () => {
      manager.onSessionCreated("session-a")
      manager.onRegistered("session-a")
      manager.onSessionCreated("session-b")
      manager.onRegistered("session-b")

      expect(manager.shouldNotify("session-a", "msg-a1")).toBe(true)
      expect(manager.shouldNotify("session-b", "msg-b1")).toBe(true)

      manager.setNotified("session-a", "msg-a1")

      expect(manager.shouldNotify("session-a", "msg-a1")).toBe(false)
      expect(manager.shouldNotify("session-b", "msg-b1")).toBe(true)
    })

    test("should clear main session on deletion", () => {
      manager.onSessionCreated("main-session")
      expect(manager.isMainSession("main-session")).toBe(true)

      manager.onDeleted("main-session")
      expect(manager.isMainSession("main-session")).toBe(false)
    })

    test("should not treat subagent sessions created after multiple mains as main", () => {
      manager.onSessionCreated("main-1")
      manager.onSessionCreated("main-2")
      manager.onSessionCreated("sub-1", "main-1")

      expect(manager.isMainSession("main-1")).toBe(true)
      expect(manager.isMainSession("main-2")).toBe(true)
      expect(manager.isMainSession("sub-1")).toBe(false)
    })
  })





  describe("cleanup", () => {
    test("should remove all state on session deletion", () => {
      manager.onSessionCreated("session-1")
      manager.onRegistered("session-1")

      expect(manager.isRegistered("session-1")).toBe(true)

      manager.onDeleted("session-1")

      expect(manager.isRegistered("session-1")).toBe(false)
    })

    test("should clear state on session recreation", () => {
      manager.onSessionCreated("session-1")
      manager.onRegistered("session-1")

      expect(manager.isRegistered("session-1")).toBe(true)

      manager.onSessionCreated("session-1")

      expect(manager.isRegistered("session-1")).toBe(false)
    })
  })

    describe("isRegistered", () => {
      test("should return false for unknown session", () => {
        expect(manager.isRegistered("unknown")).toBe(false)
      })

      test("should return false for created but not registered session", () => {
        manager.onSessionCreated("session-1")
        expect(manager.isRegistered("session-1")).toBe(false)
      })

      test("should return true for registered session", () => {
        manager.onSessionCreated("session-1")
        manager.onRegistered("session-1")
        expect(manager.isRegistered("session-1")).toBe(true)
      })
    })

    describe("isKnown", () => {
      test("should return false for unknown session", () => {
        expect(manager.isKnown("unknown")).toBe(false)
      })

      test("should return true for known session", () => {
        manager.onSessionCreated("session-1")
        expect(manager.isKnown("session-1")).toBe(true)
      })

      test("should return true for registered session", () => {
        manager.onSessionCreated("session-1")
        manager.onRegistered("session-1")
        expect(manager.isKnown("session-1")).toBe(true)
      })

      test("should return false after session deletion", () => {
        manager.onSessionCreated("session-1")
        expect(manager.isKnown("session-1")).toBe(true)
        manager.onDeleted("session-1")
        expect(manager.isKnown("session-1")).toBe(false)
      })
    })

    describe("awaitRegistration", () => {
     test("should resolve immediately for unknown session", async () => {
       await manager.awaitRegistration("unknown")
     })

     test("should resolve immediately for already-registered session", async () => {
       manager.onSessionCreated("session-1")
       manager.onRegistered("session-1")
       await manager.awaitRegistration("session-1")
     })

     test("should wait for pending promise", async () => {
       manager.onSessionCreated("session-1")

       let resolved = false
       const promise = new Promise<void>((resolve) => {
         setTimeout(() => {
           resolved = true
           resolve()
         }, 10)
       })

       manager.setRegistrationPromise("session-1", promise)

       expect(resolved).toBe(false)
       await manager.awaitRegistration("session-1")
       expect(resolved).toBe(true)
     })
   })

   describe("notification deduplication", () => {
     test("shouldNotify returns true for new message", () => {
       manager.onSessionCreated("session-1")
       manager.onRegistered("session-1")

       expect(manager.shouldNotify("session-1", "msg-1")).toBe(true)
     })

     test("shouldNotify returns false for same message", () => {
       manager.onSessionCreated("session-1")
       manager.onRegistered("session-1")

       expect(manager.shouldNotify("session-1", "msg-1")).toBe(true)
       manager.setNotified("session-1", "msg-1")
       expect(manager.shouldNotify("session-1", "msg-1")).toBe(false)
     })

     test("shouldNotify returns true after onBusy resets state", () => {
       manager.onSessionCreated("session-1")
       manager.onRegistered("session-1")

       manager.setNotified("session-1", "msg-1")
       expect(manager.shouldNotify("session-1", "msg-1")).toBe(false)

       manager.onBusy("session-1")
       expect(manager.shouldNotify("session-1", "msg-1")).toBe(true)
     })

     test("shouldNotify returns false for unknown session", () => {
       expect(manager.shouldNotify("unknown", "msg-1")).toBe(false)
     })

     test("shouldNotify returns false for unregistered session", () => {
       manager.onSessionCreated("session-1")
       expect(manager.shouldNotify("session-1", "msg-1")).toBe(false)
     })

     test("shouldNotify returns false for undefined messageId", () => {
       manager.onSessionCreated("session-1")
       manager.onRegistered("session-1")
       expect(manager.shouldNotify("session-1", undefined)).toBe(false)
     })

     test("setNotified transitions state to Notified", () => {
       manager.onSessionCreated("session-1")
       manager.onRegistered("session-1")

       manager.setNotified("session-1", "msg-1")
       expect(manager.isRegistered("session-1")).toBe(true)
     })
   })

   describe("TTL eviction", () => {
     test("should NOT evict fresh session seen within 24h", async () => {
       manager.onSessionCreated("session-1")
       manager.onRegistered("session-1")

       expect(manager.isRegistered("session-1")).toBe(true)

       manager.startEviction(10)

       await new Promise((resolve) => setTimeout(resolve, 20))

       expect(manager.isRegistered("session-1")).toBe(true)
     })

     test("should update lastSeenAt on state transitions", async () => {
       manager.onSessionCreated("session-1")
       manager.onRegistered("session-1")

       manager.startEviction(10)

       manager.onBusy("session-1")

       await new Promise((resolve) => setTimeout(resolve, 20))

       expect(manager.isRegistered("session-1")).toBe(true)
     })

     test("should evict oldest sessions when >100 sessions exist", async () => {
       for (let i = 0; i < 105; i++) {
         manager.onSessionCreated(`session-${i}`)
       }

       expect(manager.isRegistered("session-0")).toBe(false)

       manager.startEviction(10)

       await new Promise((resolve) => setTimeout(resolve, 20))

       expect(manager.isRegistered("session-0")).toBe(false)
       expect(manager.isRegistered("session-104")).toBe(false)
     })

     test("should track lastSeenAt on session creation", () => {
       manager.onSessionCreated("session-1")
       manager.onRegistered("session-1")

       expect(manager.isRegistered("session-1")).toBe(true)
     })

     test("should update lastSeenAt on setNotified", () => {
       manager.onSessionCreated("session-1")
       manager.onRegistered("session-1")

       manager.setNotified("session-1", "msg-1")

       expect(manager.isRegistered("session-1")).toBe(true)
     })
   })
})
