/**
 * Maximum session title length (200 characters).
 * Bounded to prevent header overhead from breaking Telegram's 4096-char message limit
 * and to accommodate Phase 2 forum topic names (capped at 128 chars).
 */
export const MAX_TITLE_LENGTH = 200

/**
 * Clamp to at most `max` UTF-16 code units without splitting a surrogate pair.
 *
 * An unpaired surrogate survives JSON.stringify (escaped as a well-formed \udXXX) and so
 * reaches Telegram, but cannot be encoded as UTF-8 — Telegram rejects it or mojibakes it to
 * U+FFFD. Mirrors `clampPreservingSurrogates` in @pigeon/daemon's `text.ts`; the packages
 * share no library, so this is duplicated deliberately. Keep them in sync.
 */
function clampPreservingSurrogates(s: string, max: number): string {
  if (s.length <= max) return s
  let end = max
  const c = s.charCodeAt(end - 1)
  // Trailing high surrogate means its low half was cut off — drop it too.
  if (c >= 0xd800 && c <= 0xdbff) end--
  return s.slice(0, end)
}

export function normalizeTitle(title: string | undefined): string | undefined {
  if (!title) return undefined
  const trimmed = title.trim()
  if (!trimmed) return undefined
  return clampPreservingSurrogates(trimmed, MAX_TITLE_LENGTH)
}

const State = { Created: 0, Registering: 1, Registered: 2, Notified: 3 } as const
type State = (typeof State)[keyof typeof State]

type SessionEntry = {
  state: State
  parentID: string | undefined
  lastNotifiedMessageId: string | undefined
  registrationPromise: Promise<void> | undefined
  lastSeenAt: number
  title: string | undefined
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry>()
  private mainSessionIds = new Set<string>()
  private discoveryPromises = new Map<string, Promise<void>>()
  private evictionTimer: ReturnType<typeof setInterval> | undefined

  getDiscoveryPromise(sessionID: string): Promise<void> | undefined {
    return this.discoveryPromises.get(sessionID)
  }

  setDiscoveryPromise(sessionID: string, promise: Promise<void>): void {
    this.discoveryPromises.set(sessionID, promise)
  }

  clearDiscoveryPromise(sessionID: string): void {
    this.discoveryPromises.delete(sessionID)
  }

  onSessionCreated(sessionID: string, parentID?: string, title?: string): void {
    this.cleanupSession(sessionID)

    this.sessions.set(sessionID, {
      state: State.Created,
      parentID,
      lastNotifiedMessageId: undefined,
      registrationPromise: undefined,
      lastSeenAt: Date.now(),
      title: normalizeTitle(title),
    })

    if (!parentID) {
      this.mainSessionIds.add(sessionID)
    }
  }

  setTitle(sessionID: string, title: string | undefined): void {
    const entry = this.sessions.get(sessionID)
    if (!entry) return
    entry.title = normalizeTitle(title)
    entry.lastSeenAt = Date.now()
  }

  getTitle(sessionID: string): string | undefined {
    return this.sessions.get(sessionID)?.title
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

    this.mainSessionIds.delete(sessionID)
  }

  isMainSession(sessionID: string): boolean {
    return this.mainSessionIds.has(sessionID)
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
        this.mainSessionIds.delete(id)
      }
    }, intervalMs)

    if (this.evictionTimer.unref) {
      this.evictionTimer.unref()
    }
  }
}
