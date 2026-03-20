# Message Splitting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Send long Telegram notifications as multiple messages instead of truncating them.

**Architecture:** Remove the plugin's output caps so full Claude output flows to the daemon. Add a `splitTelegramMessage()` utility in the daemon that splits body text at natural boundaries (paragraphs, lines, sentences) while repeating header/footer on each chunk. The notification services loop over chunks, sending each as a separate Telegram message. The worker is unchanged -- it receives one call per chunk.

**Tech Stack:** TypeScript, Vitest, Node.js (daemon), OpenCode plugin

---

### Task 1: Add `splitTelegramMessage` utility with tests

**Files:**
- Create: `packages/daemon/src/split-message.ts`
- Create: `packages/daemon/test/split-message.test.ts`

**Step 1: Write the tests**

Create `packages/daemon/test/split-message.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { splitTelegramMessage } from "../src/split-message";

describe("splitTelegramMessage", () => {
  const header = "HEADER";
  const footer = "FOOTER";
  // overhead = "HEADER" (6) + "\n\n" (2) + "\n\n" (2) + "FOOTER" (6) = 16

  it("returns single message when body fits", () => {
    const result = splitTelegramMessage(header, "Short body", footer, 100);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("HEADER\n\nShort body\n\nFOOTER");
  });

  it("splits on paragraph boundary (double newline)", () => {
    const body = "Paragraph one.\n\nParagraph two.";
    // overhead=16, so maxBody = 30 - 16 = 14. "Paragraph one." is 14 chars. Fits exactly.
    const result = splitTelegramMessage(header, body, footer, 30);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("HEADER\n\nParagraph one.\n\nFOOTER");
    expect(result[1]).toBe("HEADER\n\nParagraph two.\n\nFOOTER");
  });

  it("splits on line boundary when no paragraph break fits", () => {
    const body = "Line one.\nLine two.";
    // overhead=16, maxBody=18-16=2 is too small... let's use a bigger maxLen
    // overhead=16, body=19. maxLen=26 => maxBody=10. "Line one." is 9 chars.
    const result = splitTelegramMessage(header, body, footer, 26);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("Line one.");
    expect(result[1]).toContain("Line two.");
  });

  it("splits on sentence boundary when no line break fits", () => {
    const body = "First sentence. Second sentence.";
    // overhead=16, maxBody=32-16=16. "First sentence." is 15 chars.
    const result = splitTelegramMessage(header, body, footer, 32);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("First sentence.");
    expect(result[1]).toContain("Second sentence.");
  });

  it("hard-cuts when no natural boundary found", () => {
    const body = "x".repeat(100);
    // overhead=16, maxBody=50-16=34
    const result = splitTelegramMessage(header, body, footer, 50);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
    // Verify all content is preserved
    const bodies = result.map(c => c.replace("HEADER\n\n", "").replace("\n\nFOOTER", ""));
    expect(bodies.join("")).toBe(body);
  });

  it("uses 4096 as default maxLen", () => {
    const body = "x".repeat(4000);
    const result = splitTelegramMessage(header, body, footer);
    expect(result).toHaveLength(1);
  });

  it("handles empty body", () => {
    const result = splitTelegramMessage(header, "", footer, 100);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("HEADER\n\n\n\nFOOTER");
  });

  it("handles body that is exactly maxBody size", () => {
    const overhead = header.length + footer.length + 4; // 4 for two "\n\n"
    const body = "x".repeat(100 - overhead);
    const result = splitTelegramMessage(header, body, footer, 100);
    expect(result).toHaveLength(1);
  });

  it("preserves content across all chunks (no data loss)", () => {
    const body = "Alpha.\n\nBravo.\n\nCharlie.\n\nDelta.\n\nEcho.";
    const result = splitTelegramMessage(header, body, footer, 32);
    const reconstructed = result
      .map(c => c.replace("HEADER\n\n", "").replace("\n\nFOOTER", ""))
      .join("\n\n");
    expect(reconstructed).toBe(body);
  });

  it("handles empty header and footer", () => {
    const body = "Some content";
    const result = splitTelegramMessage("", body, "", 100);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("\n\nSome content\n\n");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run --workspace @pigeon/daemon test -- --reporter verbose --run split-message`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `packages/daemon/src/split-message.ts`:

```typescript
/**
 * Split a Telegram notification into multiple messages that each fit within maxLen.
 *
 * Each chunk is formatted as: header + "\n\n" + bodyChunk + "\n\n" + footer
 *
 * Body is split at natural boundaries in priority order:
 * 1. Paragraph break (\n\n)
 * 2. Line break (\n)
 * 3. Sentence end (". ")
 * 4. Hard cut at maxBody
 */
export function splitTelegramMessage(
  header: string,
  body: string,
  footer: string,
  maxLen = 4096,
): string[] {
  const JOIN = "\n\n";
  const overhead = header.length + footer.length + JOIN.length * 2;
  const maxBody = maxLen - overhead;

  if (maxBody <= 0) {
    // Edge case: header+footer alone exceed maxLen. Send as-is.
    return [header + JOIN + body + JOIN + footer];
  }

  if (body.length <= maxBody) {
    return [header + JOIN + body + JOIN + footer];
  }

  const chunks: string[] = [];
  let remaining = body;

  while (remaining.length > 0) {
    if (remaining.length <= maxBody) {
      chunks.push(remaining);
      break;
    }

    const cutPoint = findSplitPoint(remaining, maxBody);
    chunks.push(remaining.slice(0, cutPoint));
    remaining = remaining.slice(cutPoint);

    // Trim leading separator from next chunk
    if (remaining.startsWith("\n\n")) {
      remaining = remaining.slice(2);
    } else if (remaining.startsWith("\n")) {
      remaining = remaining.slice(1);
    }
  }

  return chunks.map((chunk) => header + JOIN + chunk + JOIN + footer);
}

const MIN_CHUNK = 200;

function findSplitPoint(text: string, maxBody: number): number {
  const searchStart = Math.max(0, MIN_CHUNK);
  const window = text.slice(searchStart, maxBody);

  // 1. Paragraph break
  const paraIdx = window.lastIndexOf("\n\n");
  if (paraIdx !== -1) return searchStart + paraIdx;

  // 2. Line break
  const lineIdx = window.lastIndexOf("\n");
  if (lineIdx !== -1) return searchStart + lineIdx;

  // 3. Sentence end
  const sentIdx = window.lastIndexOf(". ");
  if (sentIdx !== -1) return searchStart + sentIdx + 1; // include the period

  // 4. Hard cut
  return maxBody;
}
```

**Step 4: Run tests to verify they pass**

Run: `npm run --workspace @pigeon/daemon test -- --reporter verbose --run split-message`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/daemon/src/split-message.ts packages/daemon/test/split-message.test.ts
git commit -m "feat: add splitTelegramMessage utility for multi-message notifications"
```

---

### Task 2: Refactor `formatTelegramNotification` to return split messages

**Files:**
- Modify: `packages/daemon/src/notification-service.ts` (lines 76-103)
- Modify: `packages/daemon/test/notification-service.test.ts` (lines 11-56)

**Step 1: Update the test**

In `packages/daemon/test/notification-service.test.ts`, update the `formatTelegramNotification` tests. The function now returns `{ texts: string[]; replyMarkup }` instead of `{ text: string; replyMarkup }`.

Add this import at the top:
```typescript
import { splitTelegramMessage } from "../src/split-message";
```

Update existing tests to use `.texts[0]` instead of `.text`, and add a test for long summaries:

```typescript
describe("formatTelegramNotification", () => {
  it("formats markdown body with no inline buttons", () => {
    const result = formatTelegramNotification({
      event: "Stop",
      label: "my_[label]*",
      summary: "Done",
      cwd: "/home/dev/projects/pigeon",
      token: "tok123",
      sessionId: "sess-abc123",
    });

    expect(result.texts).toHaveLength(1);
    expect(result.texts[0]).toContain("*Stop*: my\\_\\[label\\]\\*");
    expect(result.texts[0]).toContain("📂 `projects/pigeon`");
    expect(result.texts[0]).toContain("🆔 `sess-abc123`");
    expect(result.replyMarkup.inline_keyboard).toHaveLength(0);
  });

  it("includes machine ID in info line when provided", () => {
    const result = formatTelegramNotification({
      event: "Stop",
      label: "test",
      summary: "Done",
      cwd: "/home/dev/projects/pigeon",
      token: "tok123",
      machineId: "devbox",
      sessionId: "sess-xyz",
    });

    expect(result.texts[0]).toContain("📂 `projects/pigeon` · 🖥 devbox");
    expect(result.texts[0]).toContain("\n🆔 `sess-xyz`");
  });

  it("omits machine ID from info line when not provided", () => {
    const result = formatTelegramNotification({
      event: "Stop",
      label: "test",
      summary: "Done",
      cwd: "/home/dev/projects/pigeon",
      token: "tok123",
      sessionId: "sess-nomachine",
    });

    expect(result.texts[0]).toContain("📂 `projects/pigeon`");
    expect(result.texts[0]).toContain("\n🆔 `sess-nomachine`");
    expect(result.texts[0]).not.toContain("🖥");
  });

  it("splits long summary into multiple messages with header/footer on each", () => {
    const longSummary = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} content here.`).join("\n\n");
    const result = formatTelegramNotification({
      event: "Stop",
      label: "test",
      summary: longSummary,
      cwd: "/tmp",
      token: "tok-long",
      sessionId: "sess-long",
    });

    expect(result.texts.length).toBeGreaterThan(1);
    for (const text of result.texts) {
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text).toContain("*Stop*");
      expect(text).toContain("🆔 `sess-long`");
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run --workspace @pigeon/daemon test -- --reporter verbose --run notification-service`
Expected: FAIL — `.texts` is undefined (still returns `.text`)

**Step 3: Update `formatTelegramNotification`**

In `packages/daemon/src/notification-service.ts`, add the import and refactor the function:

Add import at top:
```typescript
import { splitTelegramMessage } from "./split-message";
```

Replace `formatTelegramNotification` (lines 76-103) with:

```typescript
export function formatTelegramNotification(input: NotificationInput): {
  texts: string[];
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
} {
  const cwdShort = input.cwd ? input.cwd.split("/").slice(-2).join("/") : "unknown";
  let infoLine = `📂 \`${cwdShort}\``;
  if (input.machineId) {
    infoLine += ` · 🖥 ${escapeMarkdown(input.machineId)}`;
  }

  const header = `${eventEmoji(input.event)} *${input.event}*: ${escapeMarkdown(input.label)}`;

  const footer = [
    infoLine,
    `🆔 \`${input.sessionId}\``,
    "",
    "↩️ _Swipe-reply to respond_",
  ].join("\n");

  const texts = splitTelegramMessage(header, input.summary, footer);

  return {
    texts,
    replyMarkup: {
      inline_keyboard: [],
    },
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npm run --workspace @pigeon/daemon test -- --reporter verbose --run notification-service`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/daemon/src/notification-service.ts packages/daemon/test/notification-service.test.ts
git commit -m "refactor: formatTelegramNotification returns texts[] for multi-message support"
```

---

### Task 3: Update notification services to send multiple chunks

**Files:**
- Modify: `packages/daemon/src/notification-service.ts` (TelegramNotificationService and WorkerNotificationService)
- Modify: `packages/daemon/test/notification-service.test.ts`

**Step 1: Update TelegramNotificationService test**

In `notification-service.test.ts`, update the `TelegramNotificationService` test to verify multiple Telegram API calls for long summaries. Also update the existing test to work with `texts`:

```typescript
describe("TelegramNotificationService", () => {
  it("mints session token, sends telegram message, and stores reply mapping", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-1",
      notify: true,
      label: "Test Session",
      cwd: "/tmp/demo",
    }, 1_000);

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1234 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const service = new TelegramNotificationService(
      storage,
      "bot-token",
      "8248645256",
      () => 2_000,
      fetchMock,
    );

    const result = await service.sendStopNotification({
      session: {
        sessionId: "sess-1",
        label: "Test Session",
        cwd: "/tmp/demo",
      },
      event: "Stop",
      summary: "All done",
    });

    expect(result.token).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const tokenRecord = storage.sessionTokens.validate(result.token, "8248645256", 2_001);
    expect(tokenRecord?.sessionId).toBe("sess-1");

    const replyMapped = storage.replyTokens.lookup("8248645256", "1234", 2_001);
    expect(replyMapped).toBe(result.token);
  });

  it("sends multiple Telegram messages for long summaries", async () => {
    const storage = openStorageDb(":memory:");
    storage.sessions.upsert({
      sessionId: "sess-long",
      notify: true,
      label: "Long Test",
      cwd: "/tmp",
    }, 1_000);

    let msgIdCounter = 100;
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, result: { message_id: msgIdCounter++ } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const service = new TelegramNotificationService(
      storage,
      "bot-token",
      "8248645256",
      () => 2_000,
      fetchMock,
    );

    const longSummary = Array.from({ length: 50 }, (_, i) => `Paragraph ${i}: ${"x".repeat(60)}`).join("\n\n");

    const result = await service.sendStopNotification({
      session: {
        sessionId: "sess-long",
        label: "Long Test",
        cwd: "/tmp",
      },
      event: "Stop",
      summary: longSummary,
    });

    expect(result.token).toBeTruthy();
    expect((fetchMock as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);

    // All sent messages should map to the same token via reply routing
    const mapped100 = storage.replyTokens.lookup("8248645256", "100", 2_001);
    const mapped101 = storage.replyTokens.lookup("8248645256", "101", 2_001);
    expect(mapped100).toBe(result.token);
    expect(mapped101).toBe(result.token);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run --workspace @pigeon/daemon test -- --reporter verbose --run notification-service`
Expected: FAIL — only 1 fetch call for long summary

**Step 3: Update `TelegramNotificationService.sendTelegramMessage` and `sendStopNotification`**

In `notification-service.ts`, update `sendStopNotification` in `TelegramNotificationService` (around line 223) to loop over `texts`:

```typescript
  async sendStopNotification(input: StopNotificationInput): Promise<NotificationResult> {
    const now = this.nowFn();
    const token = generateToken();

    this.storage.sessionTokens.mint({
      token,
      sessionId: input.session.sessionId,
      chatId: this.chatId,
      context: {
        event: input.event,
        summary: input.summary.slice(0, 200),
      },
    }, now);

    const notification = formatTelegramNotification({
      event: input.event,
      label: input.label || input.session.label || input.session.sessionId.slice(0, 8),
      summary: input.summary,
      cwd: input.session.cwd,
      token,
      machineId: this.machineId,
      sessionId: input.session.sessionId,
    });

    for (const text of notification.texts) {
      await this.sendTelegramMessage(
        input.session.sessionId,
        text,
        notification.replyMarkup,
        token,
      );
    }

    return { token };
  }
```

Note: The summary stored in the session token context is capped at 200 chars (it's just metadata for debugging, not the notification text).

Do the same for `WorkerNotificationService.sendStopNotification` — loop over `notification.texts`, sending media only with the last chunk:

```typescript
  async sendStopNotification(input: StopNotificationInput): Promise<NotificationResult> {
    const now = this.nowFn();
    const token = generateToken();

    this.storage.sessionTokens.mint({
      token,
      sessionId: input.session.sessionId,
      chatId: this.chatId,
      context: {
        event: input.event,
        summary: input.summary.slice(0, 200),
      },
    }, now);

    const notification = formatTelegramNotification({
      event: input.event,
      label: input.label || input.session.label || input.session.sessionId.slice(0, 8),
      summary: input.summary,
      cwd: input.session.cwd,
      token,
      machineId: this.machineId,
      sessionId: input.session.sessionId,
    });

    let mediaKeys: Array<{ key: string; mime: string; filename: string }> | undefined;
    if (input.media && input.media.length > 0 && this.workerSender.uploadMedia) {
      mediaKeys = [];
      for (const file of input.media) {
        try {
          const base64Match = file.url.match(/^data:[^;]+;base64,(.+)$/);
          const base64Data = base64Match?.[1];
          if (!base64Data) continue;
          const buffer = Buffer.from(base64Data, "base64");
          const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
          const timestamp = Date.now();
          const key = `outbound/${timestamp}-${crypto.randomUUID()}/${file.filename}`;
          const result = await this.workerSender.uploadMedia(key, arrayBuffer, file.mime, file.filename);
          if (result.ok) {
            mediaKeys.push({ key: result.key, mime: file.mime, filename: file.filename });
          }
        } catch {
          continue;
        }
      }
    }

    const texts = notification.texts;
    for (let i = 0; i < texts.length; i++) {
      const isLast = i === texts.length - 1;
      await this.sendViaWorker(
        input.session.sessionId,
        texts[i]!,
        isLast ? notification.replyMarkup : { inline_keyboard: [] },
        isLast && mediaKeys && mediaKeys.length > 0 ? mediaKeys : undefined,
      );
    }

    return { token };
  }
```

**Step 4: Run tests to verify they pass**

Run: `npm run --workspace @pigeon/daemon test -- --reporter verbose --run notification-service`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/daemon/src/notification-service.ts packages/daemon/test/notification-service.test.ts
git commit -m "feat: notification services send multiple Telegram messages for long output"
```

---

### Task 4: Remove plugin output caps

**Files:**
- Modify: `packages/opencode-plugin/src/message-tail.ts` (lines 3-4, 111-122, 126-134)
- Modify: `packages/opencode-plugin/test/message-tail.test.ts`

**Step 1: Update the tests**

In `packages/opencode-plugin/test/message-tail.test.ts`:

- Remove the `EXPECTED_SUMMARY_MAX_CHARS` constant (line 5)
- Update the `"4KB cap and truncation"` describe block — these tests should now verify text is NOT truncated
- Update `"should never exceed SUMMARY_MAX_CHARS"` — remove this test or change it to verify full content is preserved
- Update `"should return first N chars when text exceeds limit"` — should now return full text

Replace the `"4KB cap and truncation"` describe block with:

```typescript
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
```

Update the `getSummary` tests:

- `"should return first N chars when text exceeds limit"` — rename and verify full text returned
- `"should never exceed SUMMARY_MAX_CHARS"` — remove this test

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `npm run --workspace @pigeon/opencode-plugin test -- --reporter verbose --run message-tail`
Expected: FAIL — text still capped at 4096

**Step 3: Remove caps from `message-tail.ts`**

In `packages/opencode-plugin/src/message-tail.ts`:

1. Remove `const MAX_TEXT_BYTES = 4096` (line 3)
2. Remove `const SUMMARY_MAX_CHARS = 3800` (line 4)
3. In `onPartUpdated` (lines 110-123), remove the cap logic. Replace with simple accumulation:

```typescript
    if (delta !== undefined) {
      tail.text += delta
    } else {
      const textPart = part as PartInfo & { text?: string }
      tail.text = textPart.text ?? ""
    }
```

4. In `getSummary` (lines 126-135), remove the cap:

```typescript
  getSummary(sessionID: string): string {
    const tail = this.sessions.get(sessionID)
    if (!tail || !tail.text) return ""

    const text = stripMarkdown(tail.text)
    if (!text) return ""
    return text
  }
```

**Step 4: Run tests to verify they pass**

Run: `npm run --workspace @pigeon/opencode-plugin test -- --reporter verbose --run message-tail`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/opencode-plugin/src/message-tail.ts packages/opencode-plugin/test/message-tail.test.ts
git commit -m "feat: remove output caps from plugin — full Claude output flows to daemon"
```

---

### Task 5: Run full test suite and typecheck

**Files:** None (verification only)

**Step 1: Run all tests**

Run: `npm run test`
Expected: PASS — all packages pass

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — no type errors

If there are failures, fix them before proceeding.

**Step 3: Commit any fixes**

If fixes were needed:
```bash
git add -u
git commit -m "fix: resolve test/type issues from message splitting changes"
```

---

### Task 6: Update outbox sender to handle multi-chunk question notifications

**Files:**
- Modify: `packages/daemon/src/app.ts` (lines 315-337)
- Modify: `packages/daemon/src/worker/outbox-sender.ts`
- Modify: `packages/daemon/test/outbox-sender.test.ts`
- Modify: `packages/daemon/test/app.test.ts`

**Step 1: Update outbox-sender test for multi-text payloads**

Add a test in `packages/daemon/test/outbox-sender.test.ts` that verifies when a payload has a `texts` array, each text is sent as a separate `sendNotification` call:

```typescript
  it("sends multiple messages for payload with texts array", async () => {
    storage.outbox.upsert({
      ...BASE_OUTBOX_INPUT,
      payload: JSON.stringify({
        texts: ["Message 1", "Message 2", "Message 3"],
        replyMarkup: { inline_keyboard: [] },
        notificationId: "notif-1",
      }),
    }, 1_000);

    const result = await sender.processOnce();

    expect(sendFn).toHaveBeenCalledTimes(3);
    // First two calls have empty replyMarkup, last has the real one
    const calls = (sendFn as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][2]).toBe("Message 1");
    expect(calls[1][2]).toBe("Message 2");
    expect(calls[2][2]).toBe("Message 3");

    const record = storage.outbox.getByNotificationId("notif-1");
    expect(record?.state).toBe("sent");
  });
```

**Step 2: Run test to verify it fails**

Run: `npm run --workspace @pigeon/daemon test -- --reporter verbose --run outbox-sender`
Expected: FAIL — only sends 1 message

**Step 3: Update outbox sender to handle `texts` array**

In `packages/daemon/src/worker/outbox-sender.ts`, update the payload parsing (around line 112) to handle both `text` (legacy) and `texts` (new):

```typescript
        // Parse payload
        let texts: string[];
        let replyMarkup: unknown;
        let notificationId: string | undefined;
        try {
          const parsed = JSON.parse(entry.payload) as {
            text?: string;
            texts?: string[];
            replyMarkup: unknown;
            notificationId?: string;
          };
          texts = parsed.texts ?? (parsed.text ? [parsed.text] : []);
          replyMarkup = parsed.replyMarkup;
          notificationId = parsed.notificationId;
        } catch (err) {
          // ... existing error handling ...
        }

        if (texts.length === 0) {
          this.storage.outbox.markFailed(entry.notificationId, now);
          continue;
        }

        // Attempt delivery — send each chunk
        try {
          for (let i = 0; i < texts.length; i++) {
            const isLast = i === texts.length - 1;
            const result = await this.sendNotification(
              entry.sessionId,
              this.chatId,
              texts[i]!,
              isLast ? replyMarkup : { inline_keyboard: [] },
              undefined,
              isLast ? notificationId : undefined,
            );

            if (!result.ok) {
              const backoff = getBackoff(entry.attempts);
              this.storage.outbox.markRetry(entry.notificationId, now, backoff);
              this.log("outbox entry delivery failed, scheduling retry", {
                notificationId: entry.notificationId,
                chunkIndex: i,
              });
              break; // Don't send remaining chunks
            }

            if (isLast) {
              this.storage.outbox.markSent(entry.notificationId, now);
              this.log("outbox entry sent", {
                notificationId: entry.notificationId,
                chunks: texts.length,
              });
            }
          }
        } catch (err) {
          const backoff = getBackoff(entry.attempts);
          this.storage.outbox.markRetry(entry.notificationId, now, backoff);
          // ... existing error log ...
        }
```

**Step 4: Update app.ts outbox upsert to use `texts`**

In `packages/daemon/src/app.ts`, the question notification outbox upsert (around line 326) uses `text: notification.text`. Since `formatQuestionNotification` still returns `{ text, replyMarkup }`, this doesn't need to change yet. But if question notifications ever get long, you'd change it to `texts: [notification.text]` for consistency.

For now, just ensure backward compatibility by keeping `text` in the payload — the updated outbox sender handles both `text` and `texts`.

**Step 5: Run tests to verify they pass**

Run: `npm run --workspace @pigeon/daemon test -- --reporter verbose --run outbox-sender`
Expected: PASS

**Step 6: Run full test suite**

Run: `npm run test`
Expected: PASS

**Step 7: Commit**

```bash
git add packages/daemon/src/worker/outbox-sender.ts packages/daemon/test/outbox-sender.test.ts
git commit -m "feat: outbox sender supports multi-chunk message delivery"
```
