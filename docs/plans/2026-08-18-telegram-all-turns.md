# Telegram: All Turn Narration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make a Telegram forum topic show every intermediate thing the agent said during a turn, instead of only the final step's text.

**Architecture:** opencode emits one assistant message per step. `MessageTail` currently wipes its text buffer on each new assistant message id, so only the last step survives to the `session.idle` stop notification. We accumulate each completed message's text into a `segments` array, join it into the *same* stop notification, and clear on send. Notification count is unchanged; only bodies grow (+24% chunk volume, measured). One small daemon change makes the outbox governor chunk-aware so a large stop cannot overshoot the window into a 429.

**Tech Stack:** TypeScript, vitest, better-sqlite3 (daemon), Cloudflare Workers (worker — untouched here).

**Design doc:** `docs/plans/2026-08-18-telegram-all-turns-design.md` (commit `98aca42`). Read it first — it carries the measurements and the reasoning behind every guard below.

---

## Context the engineer needs

**What a "turn" is here.** A human sends one prompt. opencode then runs many *steps* — read a file, think, edit, run tests — and **each step is its own assistant message** (measured: ~14.5 assistant messages per user message). Each of those messages can carry text. `session.idle` fires once at the end.

**Where the loss happens.** `packages/opencode-plugin/src/message-tail.ts:127-132`:

```ts
if (info.role === "assistant") {
  if (tail.currentMessageId !== info.id) {
    tail.currentMessageId = info.id
    tail.text = ""        // <-- previous step's prose is discarded here
    tail.files = []
  }
```

`session.idle` (`packages/opencode-plugin/src/index.ts:488`) then sends `messageTail.getSummary(sessionID)`, which only ever sees the last message's text.

**Two non-obvious hazards, both measured — do not "simplify" them away:**

1. **Flip-back.** A `message.updated` for an already-finished assistant message can arrive *after* the next message has started — in **2.41% of consecutive assistant pairs**, worst lag 37 seconds. Without a guard, the code pushes a segment, flips back to the old message, and then pushes and tears text again. Today that only wipes text invisibly; once we accumulate, it becomes visible duplicated/garbled output. Task 3 is the guard.
2. **Governor overshoot.** The outbox governor checks *before* an entry, not per chunk (`packages/daemon/src/worker/outbox-sender.ts:263-273`), so an 11-chunk stop can start at 11/12 used and produce 22 sends in a 60s window against Telegram's ~20/min group cap. A 429 pauses the **entire** outbox up to 5 minutes. Task 8 fixes it.

**Resolved before planning (do not re-investigate):**

- `/interrupt` calls `abortSession` (`packages/daemon/src/worker/interrupt-ingest.ts:18`). In opencode 1.18.18 an abort surfaces as `error.name === "MessageAbortedError"` **on the assistant message** (`message.updated`), not as a `session.error` event — 750 occurrences in local history. So an interrupted turn still reaches `session.idle` and its narration is delivered by the normal path. The `session.error` consume in Task 7 covers genuine session errors, a rarer path.
- Effective Telegram body budget is `4096 − header − footer − separators` (`packages/daemon/src/split-message.ts:44-49`), ≈3,850 chars for a typical stop. The 3,700-3,900 figure used in the design's modelling is correct.

**Commands:**

```bash
npm run --workspace @pigeon/opencode-plugin test      # plugin tests
npm run --workspace @pigeon/daemon test               # daemon tests
npm run typecheck                                     # all packages
```

Run tests per-workspace, not the full suite, while iterating. See `AGENTS.md` on memory-capped scopes if you see exit 137.

---

### Task 1: Accumulate completed assistant messages into segments

**Files:**
- Modify: `packages/opencode-plugin/src/message-tail.ts:36-42` (type), `:104-113` (`getOrCreate`), `:127-132` (push), `:347-354` (`getSummary`)
- Test: `packages/opencode-plugin/test/message-tail.test.ts`

**Step 1: Write the failing test**

Add inside `describe("MessageTail", ...)`:

```ts
describe("turn accumulation", () => {
  const push = (id: string, text: string) => {
    tail.onMessageUpdated({ id, sessionID: "s1", role: "assistant" })
    tail.onPartUpdated({ id: `p-${id}`, sessionID: "s1", messageID: id, type: "text" }, text)
  }

  test("joins every assistant message's text in a turn, in order", () => {
    push("msg-1", "Reading the file.")
    push("msg-2", "Found the bug.")
    push("msg-3", "Done.")

    expect(tail.getSummary("s1")).toBe(
      "Reading the file.\n\n———\n\nFound the bug.\n\n———\n\nDone.",
    )
  })

  test("a single-message turn is byte-identical to the old behaviour", () => {
    push("msg-1", "Done.")
    expect(tail.getSummary("s1")).toBe("Done.")
  })

  test("an intermediate message with only whitespace adds no separator", () => {
    push("msg-1", "   ")
    push("msg-2", "Done.")
    expect(tail.getSummary("s1")).toBe("Done.")
  })

  test("an intermediate message that strips to nothing adds no separator", () => {
    push("msg-1", "```")
    push("msg-2", "Done.")
    expect(tail.getSummary("s1")).toBe("Done.")
  })
})
```

The last test matters: `stripMarkdown` deletes bare code fences (`message-tail.ts:6`), so a segment can be non-empty raw and empty stripped. Strip **before** deciding to push.

**Step 2: Run to verify it fails**

Run: `npm run --workspace @pigeon/opencode-plugin test -- message-tail`
Expected: FAIL — first test receives `"Done."` (only the last message survives).

**Step 3: Implement**

Add the separator constant near the top of `message-tail.ts`:

```ts
/**
 * Joins one turn's per-step segments. The blank lines are load-bearing: the daemon's
 * splitter prefers paragraph boundaries (split-message.ts:246-248), so a bare "\n———\n"
 * lets a chunk end on a stranded rule.
 */
export const SEGMENT_SEPARATOR = "\n\n———\n\n"
```

Add to `SessionTail`:

```ts
type SessionTail = {
  currentMessageId: string | undefined
  text: string
  segments: string[]
  files: FileInfo[]
  seenAnyMessage: boolean
  lastSeenAt: number
}
```

Initialise `segments: []` in `getOrCreate` (`:107`).

Replace the wipe in `onMessageUpdated` (`:128-132`):

```ts
if (tail.currentMessageId !== info.id) {
  this.pushSegment(tail)
  tail.currentMessageId = info.id
  tail.text = ""
}
```

Note `tail.files = []` is deliberately **gone** — Task 6 makes files turn-scoped. Until then files simply accumulate, which is the Task 6 behaviour arriving early; that is fine and its test lands in Task 6.

Add the helper:

```ts
private pushSegment(tail: SessionTail): void {
  const stripped = stripMarkdown(tail.text)
  if (stripped) tail.segments.push(stripped)
  tail.text = ""
}
```

Rewrite `getSummary` (`:347-354`):

```ts
getSummary(sessionID: string): string {
  const tail = this.sessions.get(sessionID)
  if (!tail) return ""

  const current = stripMarkdown(tail.text)
  const parts = current ? [...tail.segments, current] : tail.segments
  return parts.join(SEGMENT_SEPARATOR)
}
```

**Step 4: Run to verify it passes**

Run: `npm run --workspace @pigeon/opencode-plugin test -- message-tail`
Expected: PASS, and every pre-existing test in the file still passes.

**Step 5: Commit**

```bash
git add packages/opencode-plugin/src/message-tail.ts packages/opencode-plugin/test/message-tail.test.ts
git commit -m "feat(plugin): accumulate a turn's assistant text instead of keeping only the last step"
```

---

### Task 2: Cap the accumulated buffer at push time

**Files:**
- Modify: `packages/opencode-plugin/src/message-tail.ts` (constants, `pushSegment`)
- Test: `packages/opencode-plugin/test/message-tail.test.ts`

**Step 1: Write the failing test**

```ts
describe("turn accumulation cap", () => {
  test("drops oldest segments and says so when over the cap", () => {
    const big = "x".repeat(15_000)
    for (let i = 1; i <= 4; i++) {
      tail.onMessageUpdated({ id: `m${i}`, sessionID: "s1", role: "assistant" })
      tail.onPartUpdated({ id: `p${i}`, sessionID: "s1", messageID: `m${i}`, type: "text" }, big)
    }
    const summary = tail.getSummary("s1")

    expect(summary).toContain("… 1 earlier step omitted")
    expect(summary.length).toBeLessThan(46_000)
  })

  test("does not truncate a single oversized final segment", () => {
    const huge = "y".repeat(120_000)
    tail.onMessageUpdated({ id: "m1", sessionID: "s1", role: "assistant" })
    tail.onPartUpdated({ id: "p1", sessionID: "s1", messageID: "m1", type: "text" }, huge)

    expect(tail.getSummary("s1")).toBe(huge)
  })
})
```

The second test pins an **accepted limit** from the design: the cap bounds what this change adds, never the conclusion. History already contains a 246K single stop; that behaviour is unchanged.

**Step 2: Run to verify it fails**

Run: `npm run --workspace @pigeon/opencode-plugin test -- message-tail`
Expected: FAIL — no omission notice.

**Step 3: Implement**

```ts
/**
 * Cap on retained segment text per turn. 40K is p99.9 of all-history turn size: exceeded
 * by 26 of 22,923 turns. Enforced at PUSH time so plugin memory is bounded (40K x <=100
 * retained sessions ~ 4MB) rather than only at read time.
 *
 * Dropping oldest-first deliberately does NOT bound an oversized FINAL segment. That is
 * pre-existing behaviour (history holds a single 246K stop) and truncating a conclusion
 * would be worse than a long one.
 */
const MAX_TURN_CHARS = 40_000
```

Extend `SessionTail` with `droppedSegments: number` (init `0`), and give `pushSegment` the trim:

```ts
private pushSegment(tail: SessionTail): void {
  const stripped = stripMarkdown(tail.text)
  tail.text = ""
  if (!stripped) return

  tail.segments.push(stripped)

  let total = tail.segments.reduce((n, s) => n + s.length, 0)
  while (total > MAX_TURN_CHARS && tail.segments.length > 1) {
    total -= tail.segments.shift()!.length
    tail.droppedSegments++
  }
}
```

`tail.segments.length > 1` is what preserves the most recent segment even when it alone exceeds the cap.

In `getSummary`, prepend the notice:

```ts
const parts = current ? [...tail.segments, current] : tail.segments
const body = parts.join(SEGMENT_SEPARATOR)
if (!tail.droppedSegments) return body
const n = tail.droppedSegments
return `… ${n} earlier step${n === 1 ? "" : "s"} omitted${SEGMENT_SEPARATOR}${body}`
```

**Step 4: Run to verify it passes**

Run: `npm run --workspace @pigeon/opencode-plugin test -- message-tail` → PASS

**Step 5: Commit**

```bash
git add packages/opencode-plugin/src/message-tail.ts packages/opencode-plugin/test/message-tail.test.ts
git commit -m "feat(plugin): cap accumulated turn text at 40K, dropping oldest segments"
```

---

### Task 3: Guard against late message.updated flipping back

**Files:**
- Modify: `packages/opencode-plugin/src/message-tail.ts` (`SessionTail`, `onMessageUpdated`)
- Test: `packages/opencode-plugin/test/message-tail.test.ts`

This is the blocking hazard. **Measured: 2.41% of consecutive assistant message pairs have the earlier message updated after the later one was created, worst lag 37s.**

**Step 1: Write the failing test**

```ts
test("a late message.updated for a finished message does not duplicate or tear text", () => {
  tail.onMessageUpdated({ id: "m1", sessionID: "s1", role: "assistant" })
  tail.onPartUpdated({ id: "p1", sessionID: "s1", messageID: "m1", type: "text" }, "First step.")

  tail.onMessageUpdated({ id: "m2", sessionID: "s1", role: "assistant" })
  tail.onPartUpdated({ id: "p2", sessionID: "s1", messageID: "m2", type: "text" }, "Second ")

  // m1 completes late (token usage lands ~seconds after m2 started)
  tail.onMessageUpdated({ id: "m1", sessionID: "s1", role: "assistant" })

  tail.onPartUpdated({ id: "p2", sessionID: "s1", messageID: "m2", type: "text" }, "step.")

  expect(tail.getSummary("s1")).toBe("First step.\n\n———\n\nSecond step.")
  expect(tail.getCurrentMessageId("s1")).toBe("m2")
})
```

**Step 2: Run to verify it fails**

Run: `npm run --workspace @pigeon/opencode-plugin test -- message-tail`
Expected: FAIL — "Second " is pushed as its own segment and m2's remaining delta lands in an emptied buffer.

**Step 3: Implement**

Add `pushedMessageIds: Set<string>` to `SessionTail` (init `new Set()`), and gate the branch in `onMessageUpdated`:

```ts
if (info.role === "assistant") {
  // A message.updated for an already-completed message can arrive AFTER the next message
  // started -- 2.41% of consecutive assistant pairs in production history, worst lag 37s.
  // Flipping back would push a partial segment, empty the live buffer, and then push the
  // same message again: visible duplicated and torn text. Today the same event only wipes
  // text invisibly, which is why accumulating makes the guard mandatory rather than
  // defensive.
  if (tail.currentMessageId !== info.id && !tail.pushedMessageIds.has(info.id)) {
    this.pushSegment(tail)
    if (tail.currentMessageId) tail.pushedMessageIds.add(tail.currentMessageId)
    tail.currentMessageId = info.id
    tail.text = ""
  }
  ...
```

Keep the existing `pendingBuffer` cancellation block that follows unchanged — it guards a different (user-text leak) vector.

**Step 4: Run to verify it passes**

Run: `npm run --workspace @pigeon/opencode-plugin test -- message-tail` → PASS

**Step 5: Commit**

```bash
git add packages/opencode-plugin/src/message-tail.ts packages/opencode-plugin/test/message-tail.test.ts
git commit -m "fix(plugin): ignore late message.updated for an already-pushed assistant message"
```

---

### Task 4: Add consume() and clear on send

**Files:**
- Modify: `packages/opencode-plugin/src/message-tail.ts`
- Test: `packages/opencode-plugin/test/message-tail.test.ts`

**Step 1: Write the failing test**

```ts
describe("consume", () => {
  test("returns the summary and clears it", () => {
    tail.onMessageUpdated({ id: "m1", sessionID: "s1", role: "assistant" })
    tail.onPartUpdated({ id: "p1", sessionID: "s1", messageID: "m1", type: "text" }, "Done.")

    expect(tail.consume("s1")).toBe("Done.")
    expect(tail.consume("s1")).toBe("")
  })

  test("text produced after a consume is not re-sent with it", () => {
    tail.onMessageUpdated({ id: "m1", sessionID: "s1", role: "assistant" })
    tail.onPartUpdated({ id: "p1", sessionID: "s1", messageID: "m1", type: "text" }, "Before.")
    expect(tail.consume("s1")).toBe("Before.")

    tail.onMessageUpdated({ id: "m2", sessionID: "s1", role: "assistant" })
    tail.onPartUpdated({ id: "p2", sessionID: "s1", messageID: "m2", type: "text" }, "After.")
    expect(tail.consume("s1")).toBe("After.")
  })
})
```

The second test is the whole reason `consume` exists rather than a read-only `getSummary`: the pre-question flush sends mid-turn and the turn then continues.

**Step 2: Run to verify it fails**

Run: `npm run --workspace @pigeon/opencode-plugin test -- message-tail`
Expected: FAIL — `tail.consume is not a function`.

**Step 3: Implement**

```ts
/**
 * Return the turn's accumulated text AND clear it. Every send site calls this, which is
 * what makes "each segment is sent at most once" structural rather than a dedup rule --
 * the pre-question flush (index.ts:653) sends mid-turn and the turn then continues.
 *
 * Deliberately clears BEFORE the POST succeeds. A daemon-down idle therefore loses the
 * buffer; this codebase prefers loss over duplication (see the mirror design), and the
 * daemon 202s into a durable outbox so only a dead daemon can hit it.
 */
consume(sessionID: string): string {
  const summary = this.getSummary(sessionID)
  const tail = this.sessions.get(sessionID)
  if (tail) {
    tail.segments = []
    tail.text = ""
    tail.droppedSegments = 0
    tail.pushedMessageIds.clear()
  }
  return summary
}
```

Do **not** clear `currentMessageId` — `shouldNotify`/`setNotified` dedup depends on it (`session-state.ts:236-248`).

**Step 4: Run to verify it passes**

Run: `npm run --workspace @pigeon/opencode-plugin test -- message-tail` → PASS

**Step 5: Commit**

```bash
git add packages/opencode-plugin/src/message-tail.ts packages/opencode-plugin/test/message-tail.test.ts
git commit -m "feat(plugin): add MessageTail.consume for send-and-clear semantics"
```

---

### Task 5: Wire consume into the two existing send sites

**Files:**
- Modify: `packages/opencode-plugin/src/index.ts:488` and `:653`
- Test: `packages/opencode-plugin/test/message-tail.test.ts` (behavioural coverage stays at the MessageTail level; the index wiring is a two-word change verified by typecheck + the existing plugin integration tests)

**Step 1: Change `session.idle`**

`index.ts:488`:

```ts
const summary = messageTail.consume(sessionID) || "Task completed"
```

**Step 2: Change the pre-question flush**

`index.ts:653`:

```ts
const summary = messageTail.consume(sessionID)
```

Leave the surrounding `if (summary)` and the fire-and-forget `notifyStop` exactly as they are.

**Step 3: Verify**

```bash
npm run --workspace @pigeon/opencode-plugin test
npm run typecheck
```
Expected: PASS. If a pre-existing test asserted that `getSummary` still returns text after an idle, update it — the new contract is that a sent summary is gone.

**Step 4: Commit**

```bash
git add packages/opencode-plugin/src/index.ts
git commit -m "feat(plugin): consume the accumulated turn at both stop send sites"
```

---

### Task 6: Make files turn-scoped

**Files:**
- Modify: `packages/opencode-plugin/src/message-tail.ts` (`consume`)
- Test: `packages/opencode-plugin/test/message-tail.test.ts`

Mid-turn attachments are dropped today for the same reason text is — `tail.files = []` sat on the same line as the text wipe. Volume is nil: **8 tool attachments in 30 days** across 111,079 tool parts.

**Step 1: Write the failing test**

```ts
test("files from earlier steps in a turn survive, and clear on consume", () => {
  tail.onMessageUpdated({ id: "m1", sessionID: "s1", role: "assistant" })
  tail.onPartUpdated({
    id: "f1", sessionID: "s1", messageID: "m1", type: "file",
    mime: "image/png", filename: "chart.png", url: "https://x/1",
  })

  tail.onMessageUpdated({ id: "m2", sessionID: "s1", role: "assistant" })
  tail.onPartUpdated({
    id: "f2", sessionID: "s1", messageID: "m2", type: "file",
    mime: "image/png", filename: "after.png", url: "https://x/2",
  })

  expect(tail.getFiles("s1").map((f) => f.filename)).toEqual(["chart.png", "after.png"])

  tail.consume("s1")
  expect(tail.getFiles("s1")).toEqual([])
})
```

**Step 2: Run to verify it fails**

Expected: FAIL on the clear — Task 1 already removed the reset, so accumulation passes but `consume` does not empty `files`.

**Step 3: Implement**

Add `tail.files = []` inside `consume`.

**Step 4: Run to verify it passes**

Run: `npm run --workspace @pigeon/opencode-plugin test -- message-tail` → PASS

**Step 5: Commit**

```bash
git add packages/opencode-plugin/src/message-tail.ts packages/opencode-plugin/test/message-tail.test.ts
git commit -m "feat(plugin): keep mid-turn file attachments and clear them on consume"
```

---

### Task 7: Carry narration into the session.error notification

**Files:**
- Modify: `packages/opencode-plugin/src/index.ts:584-587`
- Test: `packages/opencode-plugin/test/message-tail.test.ts` (unit-level assertion on composition helper, or extend the existing plugin event test if one covers `session.error`)

The first draft called dropping the buffer here "no regression" because today's code drops it too. That was wrong **in degree**: the value destroyed grows with the message count per turn, and an error is exactly when "what was it doing" matters.

**Step 1: Implement**

Replace `index.ts:584-587`:

```ts
const errorMsg = error
  ? `Error: ${errorMessage(error)}`
  : "Session error occurred"

// The accumulated narration explains what the session was doing when it failed. It is a
// send site like any other, so it consumes -- clear-on-send stays structural.
const narration = messageTail.consume(sessionID)
const body = narration ? `${narration}\n\n${errorMsg}` : errorMsg
```

and pass `message: body` to `notifyStop`.

Note the existing `messageTail.clear(sessionID)` calls below stay; `consume` must run **before** them.

**Step 2: Verify**

```bash
npm run --workspace @pigeon/opencode-plugin test
npm run typecheck
```

**Step 3: Commit**

```bash
git add packages/opencode-plugin/src/index.ts
git commit -m "feat(plugin): include the turn's narration in session.error notifications"
```

---

### Task 8: Make the outbox governor chunk-aware

**Files:**
- Modify: `packages/daemon/src/worker/outbox-sender.ts` (around `:263-273` and the post-parse block at `:326-346`)
- Test: `packages/daemon/test/outbox-sender.test.ts` (locate the existing governor tests first)

The governor checks before an entry and counts entries, not chunks (`:263-273`). At 11/12 used, an 11-chunk stop still starts → 22 sends in the window → Telegram 429 → the **entire** outbox pauses up to `MAX_PAUSE_MS`. Multi-chunk stops go from rare to ~33% of stops with this feature, so the trade must be repriced.

**Step 1: Write the failing test**

```ts
test("an entry whose chunks would exceed the window is deferred, not started", async () => {
  // 11 sends already in the window, then a 3-chunk stop
  // assert: the 3-chunk entry stays queued this tick
  // assert: a following single-chunk question still sends in the NEXT window
})
```

Fill in using the harness the existing governor tests use (fake `nowFn`, injected sender). Read them before writing.

**Step 2: Run to verify it fails**

Run: `npm run --workspace @pigeon/daemon test -- outbox-sender`
Expected: FAIL — the oversized entry sends.

**Step 3: Implement**

In the post-parse block (where `messages.length` first exists, mirroring the sub-budget check at `:334-337`), add:

```ts
// The pre-entry governor check counts ENTRIES; a multi-chunk entry can therefore overshoot
// the window (11 used + an 11-chunk stop = 22 sends against Telegram's ~20/min group cap),
// and a resulting 429 pauses the WHOLE outbox for minutes. Turn-batched stops made
// multi-chunk entries common, so check chunks too.
//
// `this.sendTimestamps.length > 0` mirrors the sub-budget's oversized-entry escape: an
// entry with more chunks than the whole budget must still be able to send into an empty
// window, or it is starved forever.
if (
  this.sendTimestamps.length > 0 &&
  this.sendTimestamps.length + messages.length > OUTBOX_RATE_LIMIT
) {
  // continue, NOT break -- breaking abandons lower-ranked but still-eligible entries in
  // this batch (same reasoning as outbox-sender.ts:243-249).
  continue
}
```

**Step 4: Run to verify it passes**

```bash
npm run --workspace @pigeon/daemon test -- outbox-sender
npm run --workspace @pigeon/daemon test
```

**Step 5: Commit**

```bash
git add packages/daemon/src/worker/outbox-sender.ts packages/daemon/test/outbox-sender.test.ts
git commit -m "fix(daemon): defer an outbox entry whose chunks would overshoot the rate window"
```

---

### Task 9: Pin the accepted behaviours

**Files:**
- Test: `packages/opencode-plugin/test/message-tail.test.ts`

These are not bugs; they are trades the design accepted. Untested, the next reader will "fix" one.

**Step 1: Write the tests**

```ts
describe("accepted trades", () => {
  test("a not-yet-registered idle leaves the buffer to carry into the next stop", () => {
    // shouldNotify() is false for an unregistered session, so index.ts returns BEFORE
    // consume. Only the same-message-id branch has the "nothing new was produced"
    // property; this branch carries the previous turn's narration forward. Accepted.
    tail.onMessageUpdated({ id: "m1", sessionID: "s1", role: "assistant" })
    tail.onPartUpdated({ id: "p1", sessionID: "s1", messageID: "m1", type: "text" }, "Earlier.")
    // no consume -- simulating the early return

    tail.onMessageUpdated({ id: "m2", sessionID: "s1", role: "assistant" })
    tail.onPartUpdated({ id: "p2", sessionID: "s1", messageID: "m2", type: "text" }, "Later.")

    expect(tail.consume("s1")).toBe("Earlier.\n\n———\n\nLater.")
  })

  test("clear() drops an unsent turn (session.deleted / kill path)", () => {
    tail.onMessageUpdated({ id: "m1", sessionID: "s1", role: "assistant" })
    tail.onPartUpdated({ id: "p1", sessionID: "s1", messageID: "m1", type: "text" }, "Unsent.")
    tail.clear("s1")
    expect(tail.getSummary("s1")).toBe("")
  })

  test("a subagent session still accumulates but is never consumed by the idle path", () => {
    // index.ts:476 returns early for non-main sessions. Bounded by the 40K cap and the
    // 24h eviction sweep; recorded so it is not rediscovered as a leak.
    const sub = new MessageTail({ isMainSession: () => false })
    sub.onMessageUpdated({ id: "m1", sessionID: "sub-1", role: "assistant" })
    sub.onPartUpdated({ id: "p1", sessionID: "sub-1", messageID: "m1", type: "text" }, "Work.")
    expect(sub.getSummary("sub-1")).toBe("Work.")
  })
})
```

**Step 2: Run**

Run: `npm run --workspace @pigeon/opencode-plugin test -- message-tail` → PASS (these document existing behaviour; if any fails, the implementation drifted from the design — stop and reconcile).

**Step 3: Commit**

```bash
git add packages/opencode-plugin/test/message-tail.test.ts
git commit -m "test(plugin): pin the accepted trades in turn accumulation"
```

---

### Task 10: Full verification

**Step 1: Everything**

```bash
npm run typecheck
npm run test
```
Expected: PASS. Do not proceed on a red suite.

**Step 2: Confirm no notification-count change**

Grep for new send sites — there must be none:

```bash
rg -n "notifyStop\(" packages/opencode-plugin/src/index.ts
```
Expected: exactly the same three call sites as before this change (idle, question flush, error).

**Step 3: Commit any fixes, then open the PR**

REQUIRED SUB-SKILL: use `shepherding-pull-requests` from `gh pr create` onward — PR creation is not a terminal state.

---

### Task 11: Post-deploy measurement (after merge, not before)

The design's success criteria are numeric and must be checked against reality, not assumed.

**Do not measure from the daemon outbox.** `OUTBOX_RETENTION_MS = 60 * 60 * 1000` (`packages/daemon/src/storage/schema.ts:8`) deletes sent rows after an hour, so a 7-day query there silently returns ~1 hour of data. That mistake understated the baseline by 33× during design.

One week after deploy, from the worker's D1:

```bash
cd packages/worker && npx wrangler d1 execute pigeon-router --remote --command \
  "SELECT substr(notification_id,1,2) p, COUNT(*) chunks,
          COUNT(DISTINCT CASE WHEN instr(notification_id,'#c')>0
                THEN substr(notification_id,1,instr(notification_id,'#c')-1)
                ELSE notification_id END) notifs
   FROM messages WHERE created_at > (strftime('%s','now')-604800)*1000 GROUP BY p"
```

Baseline to compare against (7 days to 2026-08-18): `s:` 1,972 chunks / 1,704 notifications; total across all kinds 2,870 chunks.

**Pass:** stop *notification* count roughly unchanged; stop *chunks* up ~24% (expect ~2,400).
**Investigate:** notification count changed (a send site was added or dedup broke), or chunks up far more than 24% (the cap or the flip-back guard is not doing its job).

Also check the daemon log for 429-induced pauses; there should be no new ones attributable to stop size.

---

## Notes for the reviewer

- The only file outside the plugin is `outbox-sender.ts` (Task 8), and that change is a repricing of an existing trade, not new machinery.
- No new outbox kind, no ancillary-gate change, no worker change, no schema change. Reverting is `git revert` of the plugin commits.
- Tasks 3 and 8 exist because of measured production behaviour (2.41% late updates; 33% multi-chunk stops). They are not speculative hardening — resist the urge to defer them.
