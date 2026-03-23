# Accumulate Unsent Messages Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Never lose assistant message content by accumulating unsent messages in MessageTail instead of replacing them.

**Architecture:** MessageTail gains a `pending` array of `{text, files}` entries. When a new assistant message arrives, the current entry is pushed to `pending` (if non-empty) before resetting for the new message. `getUnsentText()` (renamed from `getSummary`) returns all pending + current text joined with separators. `getFiles()` returns all pending + current files. Both methods drain their respective buffers.

**Tech Stack:** TypeScript, vitest

---

### Task 1: Add pending buffer to SessionTail and update onMessageUpdated

Change `onMessageUpdated` to accumulate instead of discard. When a new assistant message arrives with a different ID, push the current `{text, files}` to a `pending` array before resetting.

**Files:**
- Modify: `packages/opencode-plugin/src/message-tail.ts:28-61`
- Test: `packages/opencode-plugin/test/message-tail.test.ts`

**Step 1: Update the existing test that expects discard behavior**

In `packages/opencode-plugin/test/message-tail.test.ts`, find the test `"should reset text when new message starts"` (line 163). Change it to expect accumulation:

```typescript
test("should accumulate text across multiple assistant messages", () => {
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

  expect(tail.getSummary("session-1")).toContain("First message")
  expect(tail.getSummary("session-1")).toContain("Second message")
})
```

Also find `"new assistant message clears head buffer"` (line 695) and update it:

```typescript
test("new assistant message accumulates in pending buffer", () => {
  const tail = new MessageTail()

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

  const text = tail.getSummary("ses1")
  expect(text).toContain("FIRST")
  expect(text).toContain("SECOND")
})
```

And find `"should reset text when onMessageUpdated arrives with different messageID after late-start"` (line 310) and update it:

```typescript
test("should accumulate text when onMessageUpdated arrives with different messageID after late-start", () => {
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

  const text = tail.getSummary("session-1")
  expect(text).toContain("First message")
  expect(text).toContain("Second message")
})
```

Add a new test for the separator between accumulated messages:

```typescript
test("should join accumulated messages with separator", () => {
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

  const text = tail.getSummary("session-1")
  expect(text).toBe("First message\n\n---\n\nSecond message")
})
```

Add a test that empty messages are NOT accumulated:

```typescript
test("should not accumulate empty messages in pending", () => {
  tail.onMessageUpdated({
    id: "msg-1",
    sessionID: "session-1",
    role: "assistant",
  })

  // No text parts for msg-1

  tail.onMessageUpdated({
    id: "msg-2",
    sessionID: "session-1",
    role: "assistant",
  })

  tail.onPartUpdated(
    {
      id: "part-1",
      sessionID: "session-1",
      messageID: "msg-2",
      type: "text",
    },
    "Only message"
  )

  expect(tail.getSummary("session-1")).toBe("Only message")
})
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- --run packages/opencode-plugin/test/message-tail.test.ts`

Expected: FAIL -- accumulation tests fail because current code discards.

**Step 3: Implement the accumulation**

In `packages/opencode-plugin/src/message-tail.ts`:

Add `pending` to the `SessionTail` type:

```typescript
type PendingEntry = {
  text: string
  files: FileInfo[]
}

type SessionTail = {
  currentMessageId: string | undefined
  text: string
  files: FileInfo[]
  pending: PendingEntry[]
  seenAnyMessage: boolean
  lastSeenAt: number
}
```

Update `getOrCreate` to initialize `pending: []`.

Update `onMessageUpdated` to push to pending before resetting:

```typescript
onMessageUpdated(info: MessageInfo): void {
  const tail = this.getOrCreate(info.sessionID)
  tail.seenAnyMessage = true

  if (info.role !== "assistant") return

  if (tail.currentMessageId !== info.id) {
    // Push current message to pending if it has content
    if (tail.text) {
      tail.pending.push({ text: tail.text, files: [...tail.files] })
    }
    tail.currentMessageId = info.id
    tail.text = ""
    tail.files = []
  }
}
```

Update `getSummary` to include pending messages:

```typescript
getSummary(sessionID: string): string {
  const tail = this.sessions.get(sessionID)
  if (!tail) return ""

  const parts: string[] = []
  for (const entry of tail.pending) {
    const stripped = stripMarkdown(entry.text)
    if (stripped) parts.push(stripped)
  }
  if (tail.text) {
    const stripped = stripMarkdown(tail.text)
    if (stripped) parts.push(stripped)
  }

  // Drain pending buffer
  tail.pending = []

  if (parts.length === 0) return ""
  return parts.join("\n\n---\n\n")
}
```

Update `getFiles` to include pending files and drain:

```typescript
getFiles(sessionID: string): FileInfo[] {
  const tail = this.sessions.get(sessionID)
  if (!tail) return []

  const allFiles: FileInfo[] = []
  for (const entry of tail.pending) {
    allFiles.push(...entry.files)
  }
  allFiles.push(...tail.files)

  // Drain pending file entries (text is drained by getSummary)
  for (const entry of tail.pending) {
    entry.files = []
  }

  return allFiles
}
```

**Step 4: Run tests to verify they pass**

Run: `npm run test -- --run packages/opencode-plugin/test/message-tail.test.ts`

Expected: PASS

**Step 5: Run the full plugin test suite**

Run: `npm run test -- --run packages/opencode-plugin`

Expected: All tests pass. Some tests may need adjustments if they asserted the old discard behavior.

**Step 6: Commit**

```
git add packages/opencode-plugin/src/message-tail.ts packages/opencode-plugin/test/message-tail.test.ts
git commit --no-gpg-sign -m "feat: accumulate unsent assistant messages instead of discarding"
```

---

### Task 2: Accumulate files across messages

Verify that files from earlier messages are preserved in the pending buffer and returned by `getFiles`. The implementation from Task 1 should already handle this, but the existing test `"resets files on new assistant message"` (line 1010) needs to be updated.

**Files:**
- Modify: `packages/opencode-plugin/test/message-tail.test.ts`

**Step 1: Update the file reset test**

Find `"resets files on new assistant message"` (line 1010) and update it to expect accumulation:

```typescript
test("accumulates files across assistant messages", () => {
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

  tail.onPartUpdated({
    id: "part-2",
    sessionID: "session-1",
    messageID: "msg-2",
    type: "file",
    mime: "image/jpeg",
    url: "data:image/jpeg;base64,new",
  } as any)

  // Should have files from both messages
  const files = tail.getFiles("session-1")
  expect(files).toHaveLength(2)
  expect(files[0].mime).toBe("image/png")
  expect(files[1].mime).toBe("image/jpeg")
})
```

Also update `"does not capture file from non-current message (wrong messageID)"` (line 950) -- this test sends a file for msg-1 after msg-2 is current. The file should still not be captured because `onPartUpdated` checks `currentMessageId === part.messageID`. This test should still pass unchanged.

**Step 2: Run tests**

Run: `npm run test -- --run packages/opencode-plugin/test/message-tail.test.ts`

Expected: All pass.

**Step 3: Commit**

```
git add packages/opencode-plugin/test/message-tail.test.ts
git commit --no-gpg-sign -m "test: update file accumulation tests for pending buffer"
```

---

### Task 3: Rename getSummary to getUnsentText

Rename `getSummary` to `getUnsentText` in `message-tail.ts` and all call sites in `index.ts`.

**Files:**
- Modify: `packages/opencode-plugin/src/message-tail.ts` -- rename method
- Modify: `packages/opencode-plugin/src/index.ts` -- update call sites (lines 327, 477)
- Modify: `packages/opencode-plugin/test/message-tail.test.ts` -- update all `getSummary` references

**Step 1: Rename in source**

In `packages/opencode-plugin/src/message-tail.ts`, rename `getSummary` to `getUnsentText`.

In `packages/opencode-plugin/src/index.ts`, change:
- Line 327: `messageTail.getSummary(sessionID)` -> `messageTail.getUnsentText(sessionID)`
- Line 477: `messageTail.getSummary(sessionID)` -> `messageTail.getUnsentText(sessionID)`

In `packages/opencode-plugin/test/message-tail.test.ts`, rename all occurrences of `getSummary` to `getUnsentText` (use find-and-replace).

**Step 2: Run tests**

Run: `npm run test -- --run packages/opencode-plugin`

Expected: All pass.

**Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: No errors.

**Step 4: Commit**

```
git add packages/opencode-plugin/src/message-tail.ts packages/opencode-plugin/src/index.ts packages/opencode-plugin/test/message-tail.test.ts
git commit --no-gpg-sign -m "refactor: rename getSummary to getUnsentText"
```

---

### Task 4: Final verification

**Step 1: Run full test suite**

Run: `npm run test -- --run`

Expected: All tests pass across all packages.

**Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: No type errors.
