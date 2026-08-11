import type { Message, Part } from "@opencode-ai/sdk"

export function stripMarkdown(text: string): string {
  let stripped = text

  stripped = stripped.replace(/^```.*$/gm, "")
  stripped = stripped.replace(/\*\*(.+?)\*\*/g, "$1")
  stripped = stripped.replace(/__(.+?)__/g, "$1")
  stripped = stripped.replace(/\*(?=\S)(.+?)(?<=\S)\*/g, "$1")
  stripped = stripped.replace(/(^|[^\w])_([^_\n]+?)_(?=[^\w]|$)/gm, "$1$2")
  stripped = stripped.replace(/^#{1,6}\s+/gm, "")
  stripped = stripped.replace(/^>\s+/gm, "")
  stripped = stripped.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
  stripped = stripped.replace(/\n{3,}/g, "\n\n")

  return stripped.trim()
}

export type FileInfo = {
  mime: string;
  filename: string;
  url: string;
}

export type MessageTailOptions = {
  postMirror?: (opts: { sessionId: string; messageId: string; text: string }) => Promise<unknown>
  isMainSession?: (sessionId: string) => boolean
  getDiscoveryPromise?: (sessionId: string) => Promise<void> | undefined
  log?: (message: string, data?: unknown) => void
  debounceMs?: number
}

type MessageInfo = Pick<Message, "id" | "sessionID" | "role">
type PartInfo = Pick<Part, "id" | "sessionID" | "messageID" | "type">

type SessionTail = {
  currentMessageId: string | undefined
  text: string
  files: FileInfo[]
  seenAnyMessage: boolean
  lastSeenAt: number
}

type UserPartData = {
  id: string
  type: string
  text: string
  synthetic?: boolean
}

type UserMessageBuffer = {
  messageID: string
  sessionID: string
  parts: Map<string, UserPartData>
  timer: ReturnType<typeof setTimeout>
}

async function waitForDiscovery(promise: Promise<void>, timeoutMs = 1000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
    if (timer.unref) {
      timer.unref()
    }
  })
  try {
    await Promise.race([
      promise.catch(() => {}),
      timeoutPromise,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Cap on retained message-role entries. Sized well above any plausible number of messages that
 * could still receive parts, so eviction only ever reaches entries that are long finished.
 */
const MAX_MESSAGE_ROLES = 2000

export class MessageTail {
  private sessions = new Map<string, SessionTail>()
  private evictionTimer: ReturnType<typeof setInterval> | undefined

  private postMirror?: MessageTailOptions["postMirror"]
  private isMainSession?: MessageTailOptions["isMainSession"]
  private getDiscoveryPromise?: MessageTailOptions["getDiscoveryPromise"]
  private log?: MessageTailOptions["log"]
  private debounceMs: number

  private messageRoles = new Map<string, { sessionID: string; role: string }>()
  private userBuffers = new Map<string, UserMessageBuffer>()
  private evictionAnnounced = false

  constructor(options?: MessageTailOptions) {
    this.postMirror = options?.postMirror
    this.isMainSession = options?.isMainSession
    this.getDiscoveryPromise = options?.getDiscoveryPromise
    this.log = options?.log
    this.debounceMs = options?.debounceMs ?? 500
  }

  private getOrCreate(sessionID: string): SessionTail {
    let tail = this.sessions.get(sessionID)
    if (!tail) {
      tail = { currentMessageId: undefined, text: "", files: [], seenAnyMessage: false, lastSeenAt: Date.now() }
      this.sessions.set(sessionID, tail)
    } else {
      tail.lastSeenAt = Date.now()
    }
    return tail
  }

  onMessageUpdated(info: MessageInfo): void {
    // Delete before set so the entry moves to the END of the Map's insertion order. Map.set on
    // an existing key keeps its original position, which would make eviction order track message
    // CREATION rather than last activity -- and a long-streaming message re-fires message.updated
    // throughout, so all those updates would be wasted. See pruneMessageRoles.
    this.messageRoles.delete(info.id)
    this.messageRoles.set(info.id, { sessionID: info.sessionID, role: info.role })
    this.pruneMessageRoles()

    const tail = this.getOrCreate(info.sessionID)
    tail.seenAnyMessage = true

    if (info.role === "assistant") {
      if (tail.currentMessageId !== info.id) {
        tail.currentMessageId = info.id
        tail.text = ""
        tail.files = []
      }
      const pendingBuffer = this.userBuffers.get(info.id)
      if (pendingBuffer) {
        clearTimeout(pendingBuffer.timer)
        this.userBuffers.delete(info.id)
        // This is the only guard on the assistant-leak vector: parts arrived for this message
        // more than debounceMs before its message.updated told us it was an assistant message,
        // so they were provisionally buffered as user text and would have flushed as a mirror.
        // Log it — otherwise there is no way to tell a dormant vector from a firing one.
        this.log?.(
          `[mirror] cancelled buffered user parts for message ${info.id} in session ${info.sessionID}: message.updated reports role=assistant (${pendingBuffer.parts.size} part(s) discarded)`,
        )
      }
    }
  }

  /**
   * Bound messageRoles. It is written on every message.updated and otherwise pruned only by
   * clear(), which runs on session end or 24h staleness — so a single long-lived active session
   * grows it for the life of the process.
   *
   * Eviction drops the least-recently-UPDATED entries (onMessageUpdated re-inserts to refresh
   * position), and skips the in-flight assistant message of any session.
   *
   * Both of those matter, and the reason is the same hazard. If a role entry is evicted while a
   * part for it can still arrive, onPartUpdated takes its `roleInfo === undefined` branch, treats
   * the part as USER text, and flushes assistant output into Telegram as if the user typed it —
   * the worst outcome in this codebase, and the exact leak the buffer-cancel above guards.
   *
   * An earlier version of this evicted in creation order and claimed that was safe because the
   * oldest entries "can no longer receive parts". Adversarial review disproved it by probe: a
   * message keeps its creation-order position through every update, so a just-finished assistant
   * message became the oldest unprotected entry milliseconds after its last delta, and a late
   * text part for it mirrored assistant output as user text. Recency refresh is what makes
   * eviction age track time-since-activity, which is what this comment can now honestly claim.
   *
   * Residual, accepted: a part arriving after MAX_MESSAGE_ROLES further message updates across
   * all sessions still leaks. Pinned by test rather than left implicit.
   */
  private pruneMessageRoles(): void {
    if (this.messageRoles.size <= MAX_MESSAGE_ROLES) return

    if (!this.evictionAnnounced) {
      this.evictionAnnounced = true
      // Item 4 of this same change exists because an invisible guard cannot be reasoned about.
      // The same applies here: say so once when the cap first engages.
      this.log?.(
        `[mirror] messageRoles reached its ${MAX_MESSAGE_ROLES}-entry cap; evicting least-recently-updated entries from here on`,
      )
    }

    for (const [msgID, roleInfo] of this.messageRoles) {
      if (this.messageRoles.size <= MAX_MESSAGE_ROLES) break
      if (this.sessions.get(roleInfo.sessionID)?.currentMessageId === msgID) continue
      this.messageRoles.delete(msgID)
    }
  }

  onPartUpdated(part: PartInfo & { synthetic?: boolean; text?: string; mime?: string; filename?: string; url?: string; state?: { status?: string; attachments?: Array<{ mime?: string; filename?: string; url?: string }> } }, delta?: string): void {
    const roleInfo = this.messageRoles.get(part.messageID)
    const currentAssistantMsgId = this.sessions.get(part.sessionID)?.currentMessageId

    if (roleInfo?.role === "user" || (roleInfo === undefined && part.messageID !== currentAssistantMsgId)) {
      this.handleUserPartUpdated(part, delta)
      if (roleInfo?.role === "user") return
    }

    // Handle file parts
    if (part.type === "file" && part.mime && part.url) {
      const tail = this.getOrCreate(part.sessionID)
      if (tail.currentMessageId === part.messageID) {
        tail.files.push({
          mime: part.mime,
          filename: part.filename ?? "file",
          url: part.url,
        })
      }
      return
    }

    // Handle tool parts with file attachments
    if (part.type === "tool" && part.state?.status === "completed" && part.state.attachments) {
      const tail = this.getOrCreate(part.sessionID)
      if (tail.currentMessageId === part.messageID) {
        for (const att of part.state.attachments) {
          if (att.mime && att.url) {
            tail.files.push({
              mime: att.mime,
              filename: att.filename ?? "file",
              url: att.url,
            })
          }
        }
      }
      return
    }

    if (part.type !== "text") return

    const tail = this.getOrCreate(part.sessionID)
    tail.lastSeenAt = Date.now()

    // Tolerate parts arriving before onMessageUpdated, but only if we haven't seen any message yet
    if (tail.currentMessageId === undefined && !tail.seenAnyMessage) {
      tail.currentMessageId = part.messageID
    }

    if (tail.currentMessageId !== part.messageID) return

    if (delta !== undefined) {
      tail.text += delta
    } else {
      const textPart = part as PartInfo & { text?: string }
      tail.text = textPart.text ?? ""
    }
  }

  private handleUserPartUpdated(
    part: PartInfo & { synthetic?: boolean; text?: string },
    delta?: string,
  ): void {
    let buffer = this.userBuffers.get(part.messageID)
    if (!buffer) {
      buffer = {
        messageID: part.messageID,
        sessionID: part.sessionID,
        parts: new Map(),
        timer: setTimeout(() => {}, 0),
      }
      clearTimeout(buffer.timer)
      this.userBuffers.set(part.messageID, buffer)
    } else {
      clearTimeout(buffer.timer)
    }

    let partData = buffer.parts.get(part.id)
    if (!partData) {
      partData = {
        id: part.id,
        type: part.type,
        text: "",
        synthetic: part.synthetic === true,
      }
      buffer.parts.set(part.id, partData)
    }

    if (part.synthetic === true) {
      partData.synthetic = true
    }
    if (part.type) {
      partData.type = part.type
    }

    if (part.type === "text") {
      if (delta !== undefined) {
        partData.text += delta
      } else if (part.text !== undefined) {
        partData.text = part.text
      }
    }

    buffer.timer = setTimeout(() => {
      this.flushUserMessage(part.messageID)
    }, this.debounceMs)

    if (buffer.timer.unref) {
      buffer.timer.unref()
    }
  }

  private async flushUserMessage(messageID: string): Promise<void> {
    const buffer = this.userBuffers.get(messageID)
    if (!buffer) return

    clearTimeout(buffer.timer)
    this.userBuffers.delete(messageID)

    // Exclusion 1: Subagent sessions
    if (this.isMainSession && !this.isMainSession(buffer.sessionID)) {
      const discoveryPromise = this.getDiscoveryPromise?.(buffer.sessionID)
      if (discoveryPromise) {
        await waitForDiscovery(discoveryPromise, 1000)
      }
      if (!this.isMainSession(buffer.sessionID)) {
        return
      }
    }

    // Exclusion 2 & 3: Filter synthetic parts and non-text parts (e.g. compaction)
    const textParts: string[] = []
    for (const partData of buffer.parts.values()) {
      if (partData.synthetic) continue
      if (partData.type === "text") {
        textParts.push(partData.text)
      }
    }

    if (textParts.length === 0) return

    const text = textParts.join("")

    // Exclusion 4: Empty or whitespace-only text
    if (!text.trim()) return

    if (this.postMirror) {
      this.postMirror({
        sessionId: buffer.sessionID,
        messageId: buffer.messageID,
        text,
      }).catch((err) => {
        this.log?.("postMirror error:", err)
      })
    }
  }

  getSummary(sessionID: string): string {
    const tail = this.sessions.get(sessionID)
    if (!tail || !tail.text) return ""

    const text = stripMarkdown(tail.text)
    if (!text) return ""
    return text
  }

  getCurrentMessageId(sessionID: string): string | undefined {
    const tail = this.sessions.get(sessionID)
    return tail?.currentMessageId
  }

  getFiles(sessionID: string): FileInfo[] {
    const tail = this.sessions.get(sessionID)
    return tail?.files ?? []
  }

  onToolAttachments(sessionID: string, messageID: string, attachments: FileInfo[]): void {
    const tail = this.getOrCreate(sessionID)
    if (tail.currentMessageId === messageID) {
      tail.files.push(...attachments)
    }
  }

  clear(sessionID: string): void {
    this.sessions.delete(sessionID)

    for (const [msgID, buffer] of this.userBuffers) {
      if (buffer.sessionID === sessionID) {
        clearTimeout(buffer.timer)
        this.userBuffers.delete(msgID)
      }
    }

    for (const [msgID, roleInfo] of this.messageRoles) {
      if (roleInfo.sessionID === sessionID) {
        this.messageRoles.delete(msgID)
      }
    }
  }

  startEviction(intervalMs = 3600_000): void {
    // Default: every hour, evict sessions not seen in 24h
    this.evictionTimer = setInterval(() => {
      const cutoff = Date.now() - 86_400_000 // 24h staleness
      const idsToDelete: string[] = []

      for (const [id, tail] of this.sessions) {
        if (tail.lastSeenAt < cutoff) {
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
        this.clear(id)
      }
    }, intervalMs)

    if (this.evictionTimer.unref) {
      this.evictionTimer.unref()
    }
  }
}
