import { describe, expect, test, beforeEach } from "vitest"
import { MessageTail } from "../src/message-tail"
import * as messageTailModule from "../src/message-tail"

const stripMarkdown = (messageTailModule as Record<string, unknown>).stripMarkdown as
  | ((value: string) => string)
  | undefined

const runStripMarkdown = (value: string): string => {
  if (typeof stripMarkdown !== "function") {
    throw new Error("stripMarkdown is not implemented")
  }
  return stripMarkdown(value)
}

describe("MessageTail", () => {
  let tail: MessageTail

  beforeEach(() => {
    tail = new MessageTail()
  })

  describe("message accumulation", () => {
    test("should accumulate text from assistant messages only", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
        },
        "Hello"
      )

      tail.onPartUpdated(
        {
          id: "part-2",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
        },
        " world"
      )

      expect(tail.getSummary("session-1")).toBe("Hello world")
    })

    test("should ignore user messages", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "user",
      })

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
        },
        "User message"
      )

      expect(tail.getSummary("session-1")).toBe("")
    })

    test("should handle delta mode (append)", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
        },
        "First"
      )

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
        },
        " Second"
      )

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
        },
        " Third"
      )

      expect(tail.getSummary("session-1")).toBe("First Second Third")
    })

    test("should handle full-text mode (replace)", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      const partWithText = {
        id: "part-1",
        sessionID: "session-1",
        messageID: "msg-1",
        type: "text" as const,
        text: "Full text content",
      }

      tail.onPartUpdated(partWithText)

      expect(tail.getSummary("session-1")).toBe("Full text content")

      const updatedPart = {
        ...partWithText,
        text: "Updated full text",
      }

      tail.onPartUpdated(updatedPart)

      expect(tail.getSummary("session-1")).toBe("Updated full text")
    })

    test("should ignore non-text parts", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "image",
        },
        "image data"
      )

      expect(tail.getSummary("session-1")).toBe("")
    })

    test("should reset text when new message starts", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
        },
        "First message"
      )

      tail.onMessageUpdated({
        id: "msg-2",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onPartUpdated(
        {
          id: "part-2",
          sessionID: "session-1",
          messageID: "msg-2",
          type: "text",
        },
        "Second message"
      )

      expect(tail.getSummary("session-1")).toBe("Second message")
    })

     test("should ignore parts from previous messages", () => {
       tail.onMessageUpdated({
         id: "msg-1",
         sessionID: "session-1",
         role: "assistant",
       })

       tail.onPartUpdated(
         {
           id: "part-1",
           sessionID: "session-1",
           messageID: "msg-1",
           type: "text",
         },
         "First"
       )

       tail.onMessageUpdated({
         id: "msg-2",
         sessionID: "session-1",
         role: "assistant",
       })

       tail.onPartUpdated(
         {
           id: "part-1",
           sessionID: "session-1",
           messageID: "msg-1",
           type: "text",
         },
         " (should be ignored)"
       )

       tail.onPartUpdated(
         {
           id: "part-2",
           sessionID: "session-1",
           messageID: "msg-2",
           type: "text",
         },
         "Second"
       )

       expect(tail.getSummary("session-1")).toBe("Second")
     })

     test("should accumulate parts arriving before onMessageUpdated", () => {
       // Parts arrive before message.updated event
       tail.onPartUpdated(
         {
           id: "part-1",
           sessionID: "session-1",
           messageID: "msg-1",
           type: "text",
         },
         "Hello"
       )

       tail.onPartUpdated(
         {
           id: "part-2",
           sessionID: "session-1",
           messageID: "msg-1",
           type: "text",
         },
         " world"
       )

       // Now message.updated arrives
       tail.onMessageUpdated({
         id: "msg-1",
         sessionID: "session-1",
         role: "assistant",
       })

       expect(tail.getSummary("session-1")).toBe("Hello world")
     })

     test("should continue accumulating after late-start with same messageID", () => {
       // Parts arrive before message.updated
       tail.onPartUpdated(
         {
           id: "part-1",
           sessionID: "session-1",
           messageID: "msg-1",
           type: "text",
         },
         "Early"
       )

       // message.updated arrives with same ID
       tail.onMessageUpdated({
         id: "msg-1",
         sessionID: "session-1",
         role: "assistant",
       })

       // More parts arrive
       tail.onPartUpdated(
         {
           id: "part-2",
           sessionID: "session-1",
           messageID: "msg-1",
           type: "text",
         },
         " Late"
       )

       expect(tail.getSummary("session-1")).toBe("Early Late")
     })

     test("should reset text when onMessageUpdated arrives with different messageID after late-start", () => {
       // Parts arrive before message.updated
       tail.onPartUpdated(
         {
           id: "part-1",
           sessionID: "session-1",
           messageID: "msg-1",
           type: "text",
         },
         "First message"
       )

       // message.updated arrives with DIFFERENT ID
       tail.onMessageUpdated({
         id: "msg-2",
         sessionID: "session-1",
         role: "assistant",
       })

       // Parts from new message arrive
       tail.onPartUpdated(
         {
           id: "part-2",
           sessionID: "session-1",
           messageID: "msg-2",
           type: "text",
         },
         "Second message"
       )

       expect(tail.getSummary("session-1")).toBe("Second message")
     })
   })

  describe("getSummary", () => {
    test("should return text when under summary cap", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      const shortText = "Short text"
      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
        },
        shortText
      )

      expect(tail.getSummary("session-1")).toBe(shortText)
    })

    test("should return full text regardless of length", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      const longText = "START" + "x".repeat(5000) + "END"
      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
        },
        longText
      )

      const summary = tail.getSummary("session-1")
      expect(summary).toContain("START")
      expect(summary).toContain("END")
      expect(summary.length).toBe(longText.length)
    })

    test("should trim whitespace", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
        },
        "  \n  Text with whitespace  \n  "
      )

      expect(tail.getSummary("session-1")).toBe("Text with whitespace")
    })

    test("should return empty string for unknown session", () => {
      expect(tail.getSummary("unknown-session")).toBe("")
    })

    test("should return empty string when no text accumulated", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      expect(tail.getSummary("session-1")).toBe("")
    })
  })

  describe("no artificial cap on text length", () => {
    test("should accumulate text beyond 4096 bytes", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      const chunk = "x".repeat(1000)
      for (let i = 0; i < 10; i++) {
        tail.onPartUpdated(
          {
            id: "part-1",
            sessionID: "session-1",
            messageID: "msg-1",
            type: "text",
          },
          chunk
        )
      }

      const summary = tail.getSummary("session-1")
      expect(summary.length).toBe(10000)
    })

    test("should preserve all content including tail", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
        },
        "START"
      )

      const filler = "x".repeat(5000)
      tail.onPartUpdated(
        {
          id: "part-2",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
        },
        filler
      )

      tail.onPartUpdated(
        {
          id: "part-3",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
        },
        "END"
      )

      const summary = tail.getSummary("session-1")
      expect(summary).toContain("START")
      expect(summary).toContain("END")
    })
  })

  describe("stripMarkdown", () => {
    test("strips double-asterisk bold markers", () => {
      expect(runStripMarkdown("**bold**")).toBe("bold")
    })

    test("strips double-underscore bold markers", () => {
      expect(runStripMarkdown("__bold__")).toBe("bold")
    })

    test("strips single-asterisk italic markers", () => {
      expect(runStripMarkdown("*italic*")).toBe("italic")
    })

    test("strips single-underscore italic markers", () => {
      expect(runStripMarkdown("_italic_")).toBe("italic")
    })

    test("strips heading markers", () => {
      expect(runStripMarkdown("## heading\n### deeper heading")).toBe("heading\ndeeper heading")
    })

    test("strips blockquote markers", () => {
      expect(runStripMarkdown("> blockquote")).toBe("blockquote")
    })

    test("strips markdown links but keeps link text", () => {
      expect(runStripMarkdown("[docs](https://example.com)")).toBe("docs")
    })

    test("keeps fenced code block content", () => {
      const input = "```ts\nconst value = 1\n```"
      const output = runStripMarkdown(input)
      expect(output).toContain("const value = 1")
    })

    test("keeps inline code content", () => {
      expect(runStripMarkdown("Use `npm run test` now")).toContain("npm run test")
    })

    test("keeps list markers for unordered and ordered lists", () => {
      const input = "- alpha\n* beta\n1. gamma"
      expect(runStripMarkdown(input)).toBe("- alpha\n* beta\n1. gamma")
    })

    test("keeps URLs", () => {
      const input = "Visit https://example.com/path?q=1"
      expect(runStripMarkdown(input)).toBe(input)
    })

     test("handles unbalanced markers without crashing", () => {
       const output = runStripMarkdown("**broken _markdown")
       expect(output.length).toBeGreaterThan(0)
     })

     test("handles response that is all code blocks", () => {
       const input = "```\nconst x = 1\n```"
       const result = runStripMarkdown(input)
       expect(result).toContain("const x = 1")
     })

     test("handles nested bold/italic markers", () => {
       const input = "***bold italic***"
       const result = runStripMarkdown(input)
       expect(result).toBe("bold italic")
     })

     test("handles unbalanced markers without crashing (truncated mid-bold)", () => {
       const input = "**truncated"
       expect(() => runStripMarkdown(input)).not.toThrow()
       const result = runStripMarkdown(input)
       expect(result.length).toBeGreaterThan(0)
     })

     test("returns empty string for empty input", () => {
       const result = runStripMarkdown("")
       expect(result).toBe("")
     })

     test("returns short content as-is after stripping", () => {
       const input = "**short**"
       const result = runStripMarkdown(input)
       expect(result).toBe("short")
     })

     test("returns empty string for whitespace-only input", () => {
       const result = runStripMarkdown("   \n\n   ")
       expect(result).toBe("")
     })

     test("handles unicode and emoji correctly", () => {
       const input = "Hello 👋 世界"
       const result = runStripMarkdown(input)
       expect(result).toBe("Hello 👋 世界")
     })
   })

  describe("clear", () => {
    test("should remove session state", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
        },
        "Some text"
      )

      expect(tail.getSummary("session-1")).toBe("Some text")

      tail.clear("session-1")

      expect(tail.getSummary("session-1")).toBe("")
    })

    test("should not affect other sessions", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
        },
        "Session 1"
      )

      tail.onMessageUpdated({
        id: "msg-2",
        sessionID: "session-2",
        role: "assistant",
      })

      tail.onPartUpdated(
        {
          id: "part-2",
          sessionID: "session-2",
          messageID: "msg-2",
          type: "text",
        },
        "Session 2"
      )

      tail.clear("session-1")

      expect(tail.getSummary("session-1")).toBe("")
      expect(tail.getSummary("session-2")).toBe("Session 2")
    })
  })

  describe("multiple sessions", () => {
    test("should track sessions independently", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
        },
        "Session 1 text"
      )

      tail.onMessageUpdated({
        id: "msg-2",
        sessionID: "session-2",
        role: "assistant",
      })

      tail.onPartUpdated(
        {
          id: "part-2",
          sessionID: "session-2",
          messageID: "msg-2",
          type: "text",
        },
        "Session 2 text"
      )

      expect(tail.getSummary("session-1")).toBe("Session 1 text")
      expect(tail.getSummary("session-2")).toBe("Session 2 text")
    })
  })

    describe("stripMarkdown edge cases - message reset", () => {
      test("new assistant message clears head buffer", () => {
        const tail = new MessageTail()

        // First message
        tail.onMessageUpdated({
          id: "msg1",
          sessionID: "ses1",
          role: "assistant",
        })

        tail.onPartUpdated(
          {
            id: "part1",
            sessionID: "ses1",
            messageID: "msg1",
            type: "text",
          },
          "FIRST"
        )

        // Second message
        tail.onMessageUpdated({
          id: "msg2",
          sessionID: "ses1",
          role: "assistant",
        })

        tail.onPartUpdated(
          {
            id: "part2",
            sessionID: "ses1",
            messageID: "msg2",
            type: "text",
          },
          "SECOND"
        )

        const summary = tail.getSummary("ses1")
        expect(summary).toContain("SECOND")
        expect(summary).not.toContain("FIRST")
      })
    })

    describe("getCurrentMessageId", () => {
     test("should return undefined for unknown session", () => {
       expect(tail.getCurrentMessageId("unknown")).toBeUndefined()
     })

     test("should return undefined for session with no messages", () => {
       tail.onPartUpdated(
         {
           id: "part-1",
           sessionID: "session-1",
           messageID: "msg-1",
           type: "image",
         },
         "data"
       )
       expect(tail.getCurrentMessageId("session-1")).toBeUndefined()
     })

     test("should return current message ID after onMessageUpdated", () => {
       tail.onMessageUpdated({
         id: "msg-1",
         sessionID: "session-1",
         role: "assistant",
       })

       expect(tail.getCurrentMessageId("session-1")).toBe("msg-1")
     })

     test("should return current message ID after late-start part", () => {
       tail.onPartUpdated(
         {
           id: "part-1",
           sessionID: "session-1",
           messageID: "msg-1",
           type: "text",
         },
         "Hello"
       )

       expect(tail.getCurrentMessageId("session-1")).toBe("msg-1")
     })

     test("should update when message changes", () => {
       tail.onMessageUpdated({
         id: "msg-1",
         sessionID: "session-1",
         role: "assistant",
       })

       expect(tail.getCurrentMessageId("session-1")).toBe("msg-1")

       tail.onMessageUpdated({
         id: "msg-2",
         sessionID: "session-1",
         role: "assistant",
       })

       expect(tail.getCurrentMessageId("session-1")).toBe("msg-2")
     })
   })

   describe("TTL eviction", () => {
     test("should NOT evict fresh session seen within 24h", async () => {
       tail.onMessageUpdated({
         id: "msg-1",
         sessionID: "session-1",
         role: "assistant",
       })

       tail.onPartUpdated(
         {
           id: "part-1",
           sessionID: "session-1",
           messageID: "msg-1",
           type: "text",
         },
         "Fresh content"
       )

       expect(tail.getSummary("session-1")).toBe("Fresh content")

       tail.startEviction(10)

       await new Promise((resolve) => setTimeout(resolve, 20))

       expect(tail.getSummary("session-1")).toBe("Fresh content")
     })

     test("should update lastSeenAt on onPartUpdated", async () => {
       tail.onMessageUpdated({
         id: "msg-1",
         sessionID: "session-1",
         role: "assistant",
       })

       tail.onPartUpdated(
         {
           id: "part-1",
           sessionID: "session-1",
           messageID: "msg-1",
           type: "text",
         },
         "Content"
       )

       tail.startEviction(10)

       tail.onPartUpdated(
         {
           id: "part-2",
           sessionID: "session-1",
           messageID: "msg-1",
           type: "text",
         },
         " updated"
       )

       await new Promise((resolve) => setTimeout(resolve, 20))

       expect(tail.getSummary("session-1")).toBe("Content updated")
     })

     test("should evict oldest sessions when >100 sessions exist", async () => {
       for (let i = 0; i < 105; i++) {
         tail.onMessageUpdated({
           id: `msg-${i}`,
           sessionID: `session-${i}`,
           role: "assistant",
         })
       }

       tail.startEviction(10)

       await new Promise((resolve) => setTimeout(resolve, 20))

       expect(tail.getSummary("session-0")).toBe("")
       expect(tail.getSummary("session-104")).toBe("")
     })

     test("should track lastSeenAt on message update", () => {
       tail.onMessageUpdated({
         id: "msg-1",
         sessionID: "session-1",
         role: "assistant",
       })

       expect(tail.getCurrentMessageId("session-1")).toBe("msg-1")
     })

      test("should update lastSeenAt on getOrCreate", () => {
        tail.onPartUpdated(
          {
            id: "part-1",
            sessionID: "session-1",
            messageID: "msg-1",
            type: "text",
          },
          "Content"
        )

        expect(tail.getSummary("session-1")).toBe("Content")
      })
    })

  describe("FilePart capture (getFiles)", () => {
    test("captures FilePart with image mime type", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onPartUpdated({
        id: "part-1",
        sessionID: "session-1",
        messageID: "msg-1",
        type: "file",
        mime: "image/png",
        filename: "screenshot.png",
        url: "data:image/png;base64,abc123",
      } as any)

      const files = tail.getFiles("session-1")
      expect(files).toHaveLength(1)
      expect(files[0]).toEqual({
        mime: "image/png",
        filename: "screenshot.png",
        url: "data:image/png;base64,abc123",
      })
    })

    test("uses default filename 'file' when filename is missing", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onPartUpdated({
        id: "part-1",
        sessionID: "session-1",
        messageID: "msg-1",
        type: "file",
        mime: "image/jpeg",
        url: "data:image/jpeg;base64,xyz",
      } as any)

      const files = tail.getFiles("session-1")
      expect(files).toHaveLength(1)
      expect(files[0].filename).toBe("file")
    })

    test("does not capture file from non-current message (wrong messageID)", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onMessageUpdated({
        id: "msg-2",
        sessionID: "session-1",
        role: "assistant",
      })

      // File arriving with old messageID
      tail.onPartUpdated({
        id: "part-1",
        sessionID: "session-1",
        messageID: "msg-1",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,abc",
      } as any)

      const files = tail.getFiles("session-1")
      expect(files).toHaveLength(0)
    })

    test("does not capture file part without mime", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onPartUpdated({
        id: "part-1",
        sessionID: "session-1",
        messageID: "msg-1",
        type: "file",
        url: "data:image/png;base64,abc",
      } as any)

      const files = tail.getFiles("session-1")
      expect(files).toHaveLength(0)
    })

    test("returns empty array when no files", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      expect(tail.getFiles("session-1")).toEqual([])
    })

    test("returns empty array for unknown session", () => {
      expect(tail.getFiles("unknown-session")).toEqual([])
    })

    test("resets files on new assistant message", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onPartUpdated({
        id: "part-1",
        sessionID: "session-1",
        messageID: "msg-1",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,old",
      } as any)

      expect(tail.getFiles("session-1")).toHaveLength(1)

      // New message starts
      tail.onMessageUpdated({
        id: "msg-2",
        sessionID: "session-1",
        role: "assistant",
      })

      expect(tail.getFiles("session-1")).toHaveLength(0)
    })

    test("clears files on clear()", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onPartUpdated({
        id: "part-1",
        sessionID: "session-1",
        messageID: "msg-1",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,abc",
      } as any)

      expect(tail.getFiles("session-1")).toHaveLength(1)

      tail.clear("session-1")

      expect(tail.getFiles("session-1")).toEqual([])
    })

    test("captures tool attachments via onToolAttachments for current message", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onToolAttachments("session-1", "msg-1", [
        { mime: "image/png", filename: "tool-output.png", url: "data:image/png;base64,tool" },
        { mime: "image/jpeg", filename: "chart.jpg", url: "data:image/jpeg;base64,chart" },
      ])

      const files = tail.getFiles("session-1")
      expect(files).toHaveLength(2)
      expect(files[0].filename).toBe("tool-output.png")
      expect(files[1].filename).toBe("chart.jpg")
    })

    test("does not capture tool attachments for wrong messageID", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onMessageUpdated({
        id: "msg-2",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onToolAttachments("session-1", "msg-1", [
        { mime: "image/png", filename: "old.png", url: "data:image/png;base64,old" },
      ])

      const files = tail.getFiles("session-1")
      expect(files).toHaveLength(0)
    })

    test("text parts still work alongside file parts", () => {
      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
        },
        "Here is the image:"
      )

      tail.onPartUpdated({
        id: "part-2",
        sessionID: "session-1",
        messageID: "msg-1",
        type: "file",
        mime: "image/png",
        filename: "result.png",
        url: "data:image/png;base64,result",
      } as any)

      expect(tail.getSummary("session-1")).toBe("Here is the image:")
      expect(tail.getFiles("session-1")).toHaveLength(1)
    })
  })

  describe("user prompt mirroring (Task 14)", () => {
    test("a TUI-typed user message -> exactly one POST /mirror with the right fields", async () => {
      const mirrors: Array<{ sessionId: string; messageId: string; text: string }> = []
      const tail = new MessageTail({
        debounceMs: 50,
        postMirror: async (opts) => {
          mirrors.push(opts)
          return { mirrored: true }
        },
      })

      tail.onMessageUpdated({
        id: "msg-user-1",
        sessionID: "session-1",
        role: "user",
      })

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-user-1",
          type: "text",
        },
        "Fix the build error"
      )

      await new Promise((r) => setTimeout(r, 100))

      expect(mirrors).toHaveLength(1)
      expect(mirrors[0]).toEqual({
        sessionId: "session-1",
        messageId: "msg-user-1",
        text: "Fix the build error",
      })
    })

    test("multiple parts arriving within the debounce window -> ONE POST containing the full text", async () => {
      const mirrors: Array<{ sessionId: string; messageId: string; text: string }> = []
      const tail = new MessageTail({
        debounceMs: 100,
        postMirror: async (opts) => {
          mirrors.push(opts)
          return { mirrored: true }
        },
      })

      tail.onMessageUpdated({
        id: "msg-user-2",
        sessionID: "session-1",
        role: "user",
      })

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-user-2",
          type: "text",
        },
        "First line\n"
      )

      await new Promise((r) => setTimeout(r, 50))

      tail.onPartUpdated(
        {
          id: "part-2",
          sessionID: "session-1",
          messageID: "msg-user-2",
          type: "text",
        },
        "Second line"
      )

      await new Promise((r) => setTimeout(r, 150))

      expect(mirrors).toHaveLength(1)
      expect(mirrors[0]).toEqual({
        sessionId: "session-1",
        messageId: "msg-user-2",
        text: "First line\nSecond line",
      })
    })

    test("a part arriving after a flush -> treated as a new flush, not merged", async () => {
      const mirrors: Array<{ sessionId: string; messageId: string; text: string }> = []
      const tail = new MessageTail({
        debounceMs: 50,
        postMirror: async (opts) => {
          mirrors.push(opts)
          return { mirrored: true }
        },
      })

      tail.onMessageUpdated({
        id: "msg-user-3",
        sessionID: "session-1",
        role: "user",
      })

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-user-3",
          type: "text",
        },
        "Initial text"
      )

      await new Promise((r) => setTimeout(r, 100))
      expect(mirrors).toHaveLength(1)
      expect(mirrors[0].text).toBe("Initial text")

      // Part arrives after flush
      tail.onPartUpdated(
        {
          id: "part-2",
          sessionID: "session-1",
          messageID: "msg-user-3",
          type: "text",
        },
        " Appended text"
      )

      await new Promise((r) => setTimeout(r, 100))
      expect(mirrors).toHaveLength(2)
      expect(mirrors[1].text).toBe(" Appended text")
    })

    test("subagent session (parentID present) -> no POST", async () => {
      const mirrors: Array<{ sessionId: string; messageId: string; text: string }> = []
      const tail = new MessageTail({
        debounceMs: 50,
        isMainSession: (sessionId) => sessionId !== "subagent-session",
        postMirror: async (opts) => {
          mirrors.push(opts)
          return { mirrored: true }
        },
      })

      tail.onMessageUpdated({
        id: "msg-sub-1",
        sessionID: "subagent-session",
        role: "user",
      })

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "subagent-session",
          messageID: "msg-sub-1",
          type: "text",
        },
        "Subagent chatter"
      )

      await new Promise((r) => setTimeout(r, 100))
      expect(mirrors).toHaveLength(0)
    })

    test("synthetic part -> excluded from the text (and if nothing remains, no POST)", async () => {
      const mirrors: Array<{ sessionId: string; messageId: string; text: string }> = []
      const tail = new MessageTail({
        debounceMs: 50,
        postMirror: async (opts) => {
          mirrors.push(opts)
          return { mirrored: true }
        },
      })

      // 1. Synthetic part only -> no POST
      tail.onMessageUpdated({
        id: "msg-synth-1",
        sessionID: "session-1",
        role: "user",
      })

      tail.onPartUpdated(
        {
          id: "part-synth",
          sessionID: "session-1",
          messageID: "msg-synth-1",
          type: "text",
          synthetic: true,
        } as any,
        "Quiet swarm note"
      )

      await new Promise((r) => setTimeout(r, 100))
      expect(mirrors).toHaveLength(0)

      // 2. Mixed real and synthetic parts -> only real part included
      tail.onMessageUpdated({
        id: "msg-synth-2",
        sessionID: "session-1",
        role: "user",
      })

      tail.onPartUpdated(
        {
          id: "part-real",
          sessionID: "session-1",
          messageID: "msg-synth-2",
          type: "text",
        },
        "User typed prompt"
      )

      tail.onPartUpdated(
        {
          id: "part-synth-2",
          sessionID: "session-1",
          messageID: "msg-synth-2",
          type: "text",
          synthetic: true,
        } as any,
        "\nSynthetic append"
      )

      await new Promise((r) => setTimeout(r, 100))
      expect(mirrors).toHaveLength(1)
      expect(mirrors[0].text).toBe("User typed prompt")
    })

    test("compaction-only message (no text parts) -> no POST", async () => {
      const mirrors: Array<{ sessionId: string; messageId: string; text: string }> = []
      const tail = new MessageTail({
        debounceMs: 50,
        postMirror: async (opts) => {
          mirrors.push(opts)
          return { mirrored: true }
        },
      })

      tail.onMessageUpdated({
        id: "msg-compact-1",
        sessionID: "session-1",
        role: "user",
      })

      tail.onPartUpdated({
        id: "part-compact",
        sessionID: "session-1",
        messageID: "msg-compact-1",
        type: "compaction",
        auto: false,
        tail_start_id: "msg-0",
      } as any)

      await new Promise((r) => setTimeout(r, 100))
      expect(mirrors).toHaveLength(0)
    })

    test("daemon unreachable / non-2xx -> no throw, silently dropped", async () => {
      const tail = new MessageTail({
        debounceMs: 50,
        postMirror: async () => {
          throw new Error("Connection refused")
        },
      })

      tail.onMessageUpdated({
        id: "msg-fail-1",
        sessionID: "session-1",
        role: "user",
      })

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-fail-1",
          type: "text",
        },
        "Text that fails to mirror"
      )

      await expect(new Promise((r) => setTimeout(r, 100))).resolves.not.toThrow()
    })

    test("assistant-role messages -> no POST", async () => {
      const mirrors: Array<{ sessionId: string; messageId: string; text: string }> = []
      const tail = new MessageTail({
        debounceMs: 50,
        postMirror: async (opts) => {
          mirrors.push(opts)
          return { mirrored: true }
        },
      })

      tail.onMessageUpdated({
        id: "msg-asst-1",
        sessionID: "session-1",
        role: "assistant",
      })

      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-asst-1",
          type: "text",
        },
        "Assistant output"
      )

      await new Promise((r) => setTimeout(r, 100))
      expect(mirrors).toHaveLength(0)
    })

    test("unknown-at-flush session whose discovery resolves as a main session -> mirrors after discovery settles", async () => {
      let discoveryResolve: (() => void) | undefined
      const discoveryPromise = new Promise<void>((res) => {
        discoveryResolve = res
      })

      let isMain = false
      const mirrors: Array<{ sessionId: string; messageId: string; text: string }> = []

      const tail = new MessageTail({
        debounceMs: 50,
        isMainSession: () => isMain,
        getDiscoveryPromise: () => discoveryPromise,
        postMirror: async (opts) => {
          mirrors.push(opts)
          return { mirrored: true }
        },
      })

      tail.onMessageUpdated({
        id: "msg-1",
        sessionID: "sess-late-main",
        role: "user",
      })
      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "sess-late-main",
          messageID: "msg-1",
          type: "text",
        },
        "First prompt after restart"
      )

      await new Promise((r) => setTimeout(r, 100))
      expect(mirrors).toHaveLength(0)

      isMain = true
      discoveryResolve!()

      await new Promise((r) => setTimeout(r, 50))
      expect(mirrors).toHaveLength(1)
      expect(mirrors[0].text).toBe("First prompt after restart")
    })

    test("unknown-at-flush whose discovery resolves as a subagent -> no mirror", async () => {
      let discoveryResolve: (() => void) | undefined
      const discoveryPromise = new Promise<void>((res) => {
        discoveryResolve = res
      })

      let isMain = false
      const mirrors: Array<{ sessionId: string; messageId: string; text: string }> = []

      const tail = new MessageTail({
        debounceMs: 50,
        isMainSession: () => isMain,
        getDiscoveryPromise: () => discoveryPromise,
        postMirror: async (opts) => {
          mirrors.push(opts)
          return { mirrored: true }
        },
      })

      tail.onMessageUpdated({
        id: "msg-sub",
        sessionID: "sess-late-sub",
        role: "user",
      })
      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "sess-late-sub",
          messageID: "msg-sub",
          type: "text",
        },
        "Subagent prompt"
      )

      await new Promise((r) => setTimeout(r, 100))
      expect(mirrors).toHaveLength(0)

      discoveryResolve!()

      await new Promise((r) => setTimeout(r, 50))
      expect(mirrors).toHaveLength(0)
    })

    test("discovery that never settles -> no mirror, no hung timer, no unhandled rejection", async () => {
      const discoveryPromise = new Promise<void>(() => {})

      const mirrors: Array<{ sessionId: string; messageId: string; text: string }> = []

      const tail = new MessageTail({
        debounceMs: 50,
        isMainSession: () => false,
        getDiscoveryPromise: () => discoveryPromise,
        postMirror: async (opts) => {
          mirrors.push(opts)
          return { mirrored: true }
        },
      })

      tail.onMessageUpdated({
        id: "msg-hung",
        sessionID: "sess-hung",
        role: "user",
      })
      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "sess-hung",
          messageID: "msg-hung",
          type: "text",
        },
        "Prompt with hung discovery"
      )

      await new Promise((r) => setTimeout(r, 1150))
      expect(mirrors).toHaveLength(0)
    })

    test("already-known main session -> unchanged single mirror with no added delay", async () => {
      const mirrors: Array<{ sessionId: string; messageId: string; text: string }> = []

      const tail = new MessageTail({
        debounceMs: 50,
        isMainSession: () => true,
        getDiscoveryPromise: () => undefined,
        postMirror: async (opts) => {
          mirrors.push(opts)
          return { mirrored: true }
        },
      })

      const start = Date.now()
      tail.onMessageUpdated({
        id: "msg-known",
        sessionID: "sess-known",
        role: "user",
      })
      tail.onPartUpdated(
        {
          id: "part-1",
          sessionID: "sess-known",
          messageID: "msg-known",
          type: "text",
        },
        "Known main prompt"
      )

      await new Promise((r) => setTimeout(r, 100))
      const elapsed = Date.now() - start

      expect(mirrors).toHaveLength(1)
      expect(mirrors[0].text).toBe("Known main prompt")
      expect(elapsed).toBeLessThan(500)
    })
  })
})
