const State = { Created: 0, Registering: 1, Registered: 2, Notified: 3 } as const
type State = (typeof State)[keyof typeof State]

type SessionEntry = {
  state: State
  parentID: string | undefined
  lastNotifiedMessageId: string | undefined
  registrationPromise: Promise<void> | undefined
  lastSeenAt: number
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry>()
  private mainSessionId: string | undefined = undefined
  private evictionTimer: ReturnType<typeof setInterval> | undefined

  onSessionCreated(sessionID: string, parentID?: string): void {
    this.cleanupSession(sessionID)

    this.sessions.set(sessionID, {
      state: State.Created,
      parentID,
      lastNotifiedMessageId: undefined,
      registrationPromise: undefined,
      lastSeenAt: Date.now(),
    })

    if (!parentID) {
      this.mainSessionId = sessionID
    }
  }

  setRegistrationPromise(sessionID: string, promise: Promise<void>): void {
    const entry = this.sessions.get(sessionID)
    if (!entry) return
    entry.registrationPromise = promise
    entry.lastSeenAt = Date.now()
  }

  async awaitRegistration(sessionID: string): Promise<void> {
    const entry = this.sessions.get(sessionID)
    if (!entry) return
    if (!entry.registrationPromise) return
    await entry.registrationPromise
  }

  onRegistered(sessionID: string): void {
    const entry = this.sessions.get(sessionID)
    if (!entry) return
    entry.state = State.Registered
    entry.lastSeenAt = Date.now()
  }

  onBusy(sessionID: string): void {
    const entry = this.sessions.get(sessionID)
    if (!entry) return

    if (entry.state === State.Notified) {
      entry.state = State.Registered
      entry.lastNotifiedMessageId = undefined
    }
    entry.lastSeenAt = Date.now()
  }



  onDeleted(sessionID: string): void {
    this.cleanupSession(sessionID)
    this.sessions.delete(sessionID)

    if (this.mainSessionId === sessionID) {
      this.mainSessionId = undefined
    }
  }

  isMainSession(sessionID: string): boolean {
    return this.mainSessionId === sessionID
  }

  isKnown(sessionID: string): boolean {
    return this.sessions.has(sessionID)
  }

  isRegistered(sessionID: string): boolean {
    const entry = this.sessions.get(sessionID)
    if (!entry) return false
    return entry.state >= State.Registered
  }

  shouldNotify(sessionID: string, currentMessageId: string | undefined): boolean {
    const entry = this.sessions.get(sessionID)
    if (!entry) return false
    if (!this.isRegistered(sessionID)) return false
    if (currentMessageId === undefined) return false
    if (currentMessageId === entry.lastNotifiedMessageId) return false
    return true
  }

  setNotified(sessionID: string, messageId: string): void {
    const entry = this.sessions.get(sessionID)
    if (!entry) return
    entry.lastNotifiedMessageId = messageId
    entry.state = State.Notified
    entry.lastSeenAt = Date.now()
  }

  private cleanupSession(sessionID: string): void {}

  startEviction(intervalMs = 3600_000): void {
    // Default: every hour, evict sessions not seen in 24h
    this.evictionTimer = setInterval(() => {
      const cutoff = Date.now() - 86_400_000 // 24h staleness
      const idsToDelete: string[] = []

      for (const [id, entry] of this.sessions) {
        if (entry.lastSeenAt < cutoff) {
          idsToDelete.push(id)
        }
      }

      // Defensive cap: if >100 sessions, evict oldest immediately
      if (this.sessions.size > 100) {
        const entries = Array.from(this.sessions.entries())
        entries.sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)
        const toEvict = entries.slice(0, this.sessions.size - 100)
        for (const [id] of toEvict) {
          if (!idsToDelete.includes(id)) {
            idsToDelete.push(id)
          }
        }
      }

      for (const id of idsToDelete) {
        this.sessions.delete(id)
        if (this.mainSessionId === id) {
          this.mainSessionId = undefined
        }
      }
    }, intervalMs)

    if (this.evictionTimer.unref) {
      this.evictionTimer.unref()
    }
  }
}
