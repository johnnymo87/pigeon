import type { Message, Part } from "@opencode-ai/sdk"

const MAX_TEXT_BYTES = 4096
const SUMMARY_MAX_CHARS = 3800

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

type MessageInfo = Pick<Message, "id" | "sessionID" | "role">
type PartInfo = Pick<Part, "id" | "sessionID" | "messageID" | "type">

type SessionTail = {
  currentMessageId: string | undefined
  text: string
  files: FileInfo[]
  seenAnyMessage: boolean
  lastSeenAt: number
}

export class MessageTail {
  private sessions = new Map<string, SessionTail>()
  private evictionTimer: ReturnType<typeof setInterval> | undefined

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
    const tail = this.getOrCreate(info.sessionID)
    tail.seenAnyMessage = true

    if (info.role !== "assistant") return

    if (tail.currentMessageId !== info.id) {
      tail.currentMessageId = info.id
      tail.text = ""
      tail.files = []
    }
  }

  onPartUpdated(part: PartInfo & { mime?: string; filename?: string; url?: string }, delta?: string): void {
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

    if (part.type !== "text") return

    const tail = this.getOrCreate(part.sessionID)
    tail.lastSeenAt = Date.now()

    // Tolerate parts arriving before onMessageUpdated, but only if we haven't seen any message yet
    if (tail.currentMessageId === undefined && !tail.seenAnyMessage) {
      tail.currentMessageId = part.messageID
    }

    if (tail.currentMessageId !== part.messageID) return

    if (delta !== undefined) {
      if (tail.text.length < MAX_TEXT_BYTES) {
        tail.text += delta
        if (tail.text.length > MAX_TEXT_BYTES) {
          tail.text = tail.text.slice(0, MAX_TEXT_BYTES)
        }
      }
    } else {
      const textPart = part as PartInfo & { text?: string }
      tail.text = textPart.text ?? ""
      if (tail.text.length > MAX_TEXT_BYTES) {
        tail.text = tail.text.slice(0, MAX_TEXT_BYTES)
      }
    }
  }

  getSummary(sessionID: string): string {
    const tail = this.sessions.get(sessionID)
    if (!tail || !tail.text) return ""

    const text = stripMarkdown(tail.text)
    if (!text) return ""
    if (text.length <= SUMMARY_MAX_CHARS) return text

    return text.slice(0, SUMMARY_MAX_CHARS)
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
        this.sessions.delete(id)
      }
    }, intervalMs)

    if (this.evictionTimer.unref) {
      this.evictionTimer.unref()
    }
  }
}
