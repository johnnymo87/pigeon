# Session ID in Telegram Notifications — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the full opencode session ID to the metadata info line in stop and question Telegram notifications.

**Architecture:** Thread `sessionId` through the existing format function inputs and append `· 🆔 \`{id}\`` to the info line. No new modules, no data plumbing — the session ID is already available at every call site.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Add sessionId to stop notification format function

**Files:**
- Modify: `packages/daemon/src/notification-service.ts:5-11` (NotificationInput interface)
- Modify: `packages/daemon/src/notification-service.ts:66-91` (formatTelegramNotification)
- Test: `packages/daemon/test/notification-service.test.ts`

**Step 1: Write the failing tests**

Add `sessionId` to existing test inputs and add a new test for session ID presence. In `packages/daemon/test/notification-service.test.ts`, update the `formatTelegramNotification` describe block:

Update the first test ("formats markdown body with no inline buttons") to include `sessionId: "sess-abc123"` in its input, and add an assertion:

```typescript
expect(result.text).toContain("🆔 `sess-abc123`");
```

Update the second test ("includes machine ID in info line when provided") to include `sessionId: "sess-xyz"` in its input, and add an assertion that the info line contains all three items:

```typescript
expect(result.text).toContain("📂 `projects/pigeon` · 🖥 devbox · 🆔 `sess-xyz`");
```

Update the third test ("omits machine ID from info line when not provided") to include `sessionId: "sess-nomachine"` in its input, and add an assertion:

```typescript
expect(result.text).toContain("📂 `projects/pigeon` · 🆔 `sess-nomachine`");
```

**Step 2: Run tests to verify they fail**

Run: `bun run --filter '@pigeon/daemon' test -- --run notification-service`
Expected: 3 failures — `sessionId` not in type, and output doesn't contain session ID

**Step 3: Implement the change**

In `packages/daemon/src/notification-service.ts`:

Add `sessionId: string` to the `NotificationInput` interface (after the `machineId` field).

In `formatTelegramNotification()`, update the `infoLine` construction to always append the session ID:

```typescript
const cwdShort = input.cwd ? input.cwd.split("/").slice(-2).join("/") : "unknown";
let infoLine = `📂 \`${cwdShort}\``;
if (input.machineId) {
  infoLine += ` · 🖥 ${escapeMarkdown(input.machineId)}`;
}
infoLine += ` · 🆔 \`${input.sessionId}\``;
```

**Step 4: Run tests to verify they pass**

Run: `bun run --filter '@pigeon/daemon' test -- --run notification-service`
Expected: All `formatTelegramNotification` tests PASS

**Step 5: Commit**

```bash
git add packages/daemon/src/notification-service.ts packages/daemon/test/notification-service.test.ts
git commit -m "feat: add session ID to stop notification format"
```

---

### Task 2: Add sessionId to question notification format function

**Files:**
- Modify: `packages/daemon/src/notification-service.ts:93-163` (formatQuestionNotification)
- Test: `packages/daemon/test/notification-service.test.ts`

**Step 1: Write the failing tests**

In `packages/daemon/test/notification-service.test.ts`, update the `formatQuestionNotification` describe block:

Add `sessionId: "sess-q1"` to the first test ("formats single question with option buttons") input, and add:

```typescript
expect(result.text).toContain("🆔 `sess-q1`");
```

Add `sessionId: "sess-wrap"` to the second test ("wraps options into rows of 3") input.

Add `sessionId: "sess-multi"` to the third test ("hides buttons for multi-question requests") input.

Add `sessionId: "sess-nocustom"` to the fourth test ("hides swipe-reply hint when custom=false") input.

Add `sessionId: "sess-q-machine"` and `machineId: "devbox"` to the first test input, and add an assertion:

```typescript
expect(result.text).toContain("📂 `projects/pigeon` · 🖥 devbox · 🆔 `sess-q-machine`");
```

Note: since the first test already uses `cwd: "/home/dev/projects/pigeon"`, this will validate the full info line. Use `sessionId: "sess-q-machine"` and add `machineId: "devbox"` to the first test.

**Step 2: Run tests to verify they fail**

Run: `bun run --filter '@pigeon/daemon' test -- --run notification-service`
Expected: Failures — `sessionId` not in type for formatQuestionNotification input

**Step 3: Implement the change**

In `packages/daemon/src/notification-service.ts`, update `formatQuestionNotification()`:

Add `sessionId: string` to the input type (alongside the existing fields).

Update the `questionInfoLine` construction:

```typescript
let questionInfoLine = `📂 \`${cwdShort}\``;
if (input.machineId) {
  questionInfoLine += ` · 🖥 ${escapeMarkdown(input.machineId)}`;
}
questionInfoLine += ` · 🆔 \`${input.sessionId}\``;
```

**Step 4: Run tests to verify they pass**

Run: `bun run --filter '@pigeon/daemon' test -- --run notification-service`
Expected: All `formatQuestionNotification` tests PASS

**Step 5: Commit**

```bash
git add packages/daemon/src/notification-service.ts packages/daemon/test/notification-service.test.ts
git commit -m "feat: add session ID to question notification format"
```

---

### Task 3: Thread sessionId through service class callers

**Files:**
- Modify: `packages/daemon/src/notification-service.ts:208-278` (TelegramNotificationService methods)
- Modify: `packages/daemon/src/notification-service.ts:307-375` (WorkerNotificationService methods)
- Test: `packages/daemon/test/notification-service.test.ts`

**Step 1: Write the failing test**

In `packages/daemon/test/notification-service.test.ts`, update the `TelegramNotificationService` test ("mints session token, sends telegram message, and stores reply mapping"):

After the existing assertion `expect(payload.parse_mode).toBe("Markdown")`, add:

```typescript
expect((payload.text as string)).toContain("🆔 `sess-1`");
```

Similarly, update the `TelegramNotificationService.sendQuestionNotification` test:

After the existing `expect((payload.text as string)).toContain("Which DB?")`, add:

```typescript
expect((payload.text as string)).toContain("🆔 `sess-q`");
```

**Step 2: Run tests to verify they fail**

Run: `bun run --filter '@pigeon/daemon' test -- --run notification-service`
Expected: 2 failures — session ID not in formatted text because callers aren't passing it yet

**Step 3: Implement the change**

In `packages/daemon/src/notification-service.ts`, update 4 call sites:

`TelegramNotificationService.sendStopNotification()` — add `sessionId: input.session.sessionId` to the `formatTelegramNotification()` call (line ~222).

`TelegramNotificationService.sendQuestionNotification()` — add `sessionId: input.session.sessionId` to the `formatQuestionNotification()` call (line ~262).

`WorkerNotificationService.sendStopNotification()` — add `sessionId: input.session.sessionId` to the `formatTelegramNotification()` call (line ~321).

`WorkerNotificationService.sendQuestionNotification()` — add `sessionId: input.session.sessionId` to the `formatQuestionNotification()` call (line ~360).

**Step 4: Run tests to verify they pass**

Run: `bun run --filter '@pigeon/daemon' test -- --run notification-service`
Expected: ALL tests PASS

**Step 5: Run full test suite and typecheck**

Run: `bun run test && bun run typecheck`
Expected: All tests pass, no type errors

**Step 6: Commit**

```bash
git add packages/daemon/src/notification-service.ts packages/daemon/test/notification-service.test.ts
git commit -m "feat: thread session ID through notification service callers"
```
