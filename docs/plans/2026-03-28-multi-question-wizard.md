# Multi-Question Telegram Wizard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable Telegram users to answer multi-question prompts step-by-step via inline buttons, instead of falling back to "answer in app."

**Architecture:** An edited single-message wizard with server-side state. When a multi-question event arrives, the daemon sends one message showing question 1 of N with inline buttons. Each button tap records the answer, advances the step counter, and edits the same Telegram message to show the next question. After the final question, all answers are submitted together as `string[][]` to opencode. State lives in daemon SQLite; the worker gets a new `editMessageText` endpoint. Single-question flows are unchanged.

**Tech Stack:** TypeScript, better-sqlite3 (daemon), D1/SQLite (worker), Telegram Bot API (`sendMessage`, `editMessageText`, `answerCallbackQuery`), Vitest.

---

## Background

### Current behavior
- Single-question (`questions.length === 1`): Renders question + options as inline buttons. Works well.
- Multi-question (`questions.length > 1`): Renders only Q1, appends "+N more question(s) -- answer in app", suppresses all buttons.

### Target behavior
- Single-question: **Unchanged.**
- Multi-question (2-3 questions, single-select per question): Wizard flow via edited message with inline buttons per step.
- Complex cases (many questions, multi-select): Future work; keep "answer in app" fallback.

### Key design decisions
- **Daemon-side state.** Wizard progress (current step, accumulated answers, version counter) lives in daemon SQLite. The worker stays stateless for edits.
- **Edit via notificationId.** The daemon requests edits using the stable `notificationId` (`q:{sessionId}:{requestId}`). The worker looks up `(chat_id, message_id)` from its `messages` table.
- **Version-based stale tap rejection.** Each wizard step bumps a version counter stored in the daemon. Callback data includes the version; mismatches are silently ignored.
- **Backward-compatible callback_data.** New format: `cmd:{token}:v{version}:q{optionIndex}`. Old format `cmd:{token}:q{index}` still works (version=undefined, no wizard routing).
- **No Cancel button.** There is no opencode API to reject/dismiss a pending question, and opencode has no question timeout. A Cancel button would leave opencode permanently stuck waiting for an answer, requiring the user to go back to the TUI -- violating pigeon's core principle of never blocking the conversation. Users can always swipe-reply with custom text for any step they don't want to answer with the offered options.
- **parse_mode passthrough.** The worker's send and edit endpoints will accept an optional `parseMode` field so the daemon can request Markdown formatting. Currently missing from the outbox->worker path.

### Callback data budget (64 bytes max)
```
cmd:AAAAAAAAAAAAAAAAAAAAAA:v0:q99   = 35 bytes (max realistic)
```
Token is 22 chars (16 bytes base64url). Plenty of headroom.

---

## Phase A: Improved Fallback Rendering

Even before the wizard ships, show ALL questions in the notification text body. This improves UX for users who answer in-app.

### Task 1: Render all questions in notification text

**Files:**
- Modify: `packages/daemon/src/notification-service.ts:117-143`
- Test: `packages/daemon/test/notification-service.test.ts:233-250`

**Step 1: Update the multi-question test to expect all questions rendered**

In `notification-service.test.ts`, update the "hides buttons for multi-question requests" test:

```typescript
it("renders all questions for multi-question requests (no buttons)", () => {
  const result = formatQuestionNotification({
    label: "test",
    questions: [
      { question: "Q1 text", header: "H1", options: [{ label: "A", description: "desc A" }] },
      { question: "Q2 text", header: "H2", options: [{ label: "B", description: "desc B" }] },
    ],
    cwd: "/tmp",
    token: "tok-multi",
    sessionId: "sess-multi",
  });

  // Shows BOTH questions
  expect(result.text).toContain("*H1*");
  expect(result.text).toContain("Q1 text");
  expect(result.text).toContain("A");
  expect(result.text).toContain("*H2*");
  expect(result.text).toContain("Q2 text");
  expect(result.text).toContain("B");
  // Fallback hint
  expect(result.text).toContain("answer in app");
  // No inline buttons for multi-question (wizard will change this later)
  expect(result.replyMarkup.inline_keyboard).toHaveLength(0);
});
```

**Step 2: Run test to verify it fails**

```bash
npm run test -- packages/daemon/test/notification-service.test.ts
```
Expected: FAIL -- "Q2 text" / "H2" not found in text.

**Step 3: Update formatQuestionNotification to render all questions**

In `notification-service.ts`, replace the first-question-only rendering (lines 118-143) with a loop over all questions:

```typescript
// Replace lines 118-143 with:
const lines = [
  `❓ *Question*: ${escapeMarkdown(input.label)}`,
  "",
];

for (let qi = 0; qi < input.questions.length; qi++) {
  const q = input.questions[qi]!;
  if (qi > 0) lines.push(""); // separator between questions

  if (input.questions.length > 1) {
    const prefix = `(${qi + 1}/${input.questions.length})`;
    lines.push(q.header ? `*${escapeMarkdown(prefix)} ${escapeMarkdown(q.header)}*` : `*${escapeMarkdown(prefix)}*`);
  } else if (q.header) {
    lines.push(`*${escapeMarkdown(q.header)}*`);
  }

  lines.push(escapeMarkdown(q.question));

  if (q.options.length > 0) {
    lines.push("");
    q.options.forEach((opt, i) => {
      const desc = opt.description ? ` — ${escapeMarkdown(opt.description)}` : "";
      lines.push(`${i + 1}\\. ${escapeMarkdown(opt.label)}${desc}`);
    });
  }
}

if (input.questions.length > 1) {
  lines.push("");
  lines.push("_Answer in app or wait for wizard buttons_");
}
```

Keep the existing `firstQuestion` reference for the `custom` hint and button logic below -- rename it or use `input.questions[0]`:

```typescript
const firstQuestion = input.questions[0];
```

**Step 4: Run test to verify it passes**

```bash
npm run test -- packages/daemon/test/notification-service.test.ts
```
Expected: PASS

**Step 5: Verify existing single-question tests still pass**

```bash
npm run test -- packages/daemon/test/notification-service.test.ts
```
Expected: All tests pass (single-question rendering unchanged for `questions.length === 1`).

**Step 6: Commit**

```bash
git add packages/daemon/src/notification-service.ts packages/daemon/test/notification-service.test.ts
git commit -m "feat: render all questions in multi-question Telegram notifications"
```

---

## Phase B: Foundation (Storage, Formatting, Worker Edit)

### Task 2: Add wizard state columns to pending_questions

**Files:**
- Modify: `packages/daemon/src/storage/schema.ts:73-82` (additive migration)
- Modify: `packages/daemon/src/storage/types.ts:52-67` (extend types)
- Modify: `packages/daemon/src/storage/repos.ts:309-360` (extend repo)
- Test: `packages/daemon/test/repos.test.ts` (or wherever pending question repo is tested)

**Step 1: Write tests for wizard state operations**

Add tests for the new `advanceStep` and updated `store`/`getBySessionId` methods. Find the existing pending question repo tests and add:

```typescript
describe("PendingQuestionRepository wizard state", () => {
  it("stores with default wizard state (step=0, answers=[], version=0)", () => {
    repo.store({ sessionId: "s1", requestId: "r1", questions: [q1, q2], token: "t1" });
    const record = repo.getBySessionId("s1")!;
    expect(record.currentStep).toBe(0);
    expect(record.answers).toEqual([]);
    expect(record.version).toBe(0);
  });

  it("advanceStep records answer and bumps version", () => {
    repo.store({ sessionId: "s1", requestId: "r1", questions: [q1, q2], token: "t1" });
    const updated = repo.advanceStep("s1", ["PostgreSQL"]);
    expect(updated).not.toBeNull();
    expect(updated!.currentStep).toBe(1);
    expect(updated!.answers).toEqual([["PostgreSQL"]]);
    expect(updated!.version).toBe(1);
  });

  it("advanceStep returns null for missing session", () => {
    expect(repo.advanceStep("missing", ["x"])).toBeNull();
  });

  it("advanceStep returns null for expired session", () => {
    repo.store({ sessionId: "s1", requestId: "r1", questions: [q1, q2], token: "t1" }, 1000, 100);
    expect(repo.advanceStep("s1", ["x"], 2000)).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npm run test -- packages/daemon/test/repos.test.ts
```
Expected: FAIL -- `currentStep`, `answers`, `version`, `advanceStep` don't exist.

**Step 3: Add schema migration**

In `schema.ts`, add to the `additiveColumns` array (after line 109):

```typescript
"ALTER TABLE pending_questions ADD COLUMN current_step INTEGER NOT NULL DEFAULT 0",
"ALTER TABLE pending_questions ADD COLUMN answers_json_v2 TEXT NOT NULL DEFAULT '[]'",
"ALTER TABLE pending_questions ADD COLUMN version INTEGER NOT NULL DEFAULT 0",
```

Note: `answers_json_v2` avoids confusion with the existing `questions_json` column. This stores the accumulated wizard answers as `string[][]`.

**Step 4: Update types**

In `types.ts`, extend `PendingQuestionRecord`:

```typescript
export interface PendingQuestionRecord {
  sessionId: string;
  requestId: string;
  questions: QuestionInfoData[];
  token: string | null;
  createdAt: number;
  expiresAt: number;
  currentStep: number;
  answers: string[][];
  version: number;
}
```

**Step 5: Update repository**

In `repos.ts`, update `asPendingQuestion`:

```typescript
function asPendingQuestion(row: SqlRow): PendingQuestionRecord {
  return {
    sessionId: String(row.session_id),
    requestId: String(row.request_id),
    questions: JSON.parse(String(row.questions_json)) as PendingQuestionRecord["questions"],
    token: (row.token as string | null) ?? null,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    currentStep: Number(row.current_step ?? 0),
    answers: JSON.parse(String(row.answers_json_v2 ?? "[]")) as string[][],
    version: Number(row.version ?? 0),
  };
}
```

Update `store` to include wizard columns in the INSERT:

```typescript
store(input: StorePendingQuestionInput, now = Date.now(), ttlMs = PENDING_QUESTION_TTL_MS): void {
  this.db
    .prepare(
      `INSERT OR REPLACE INTO pending_questions
       (session_id, request_id, questions_json, token, created_at, expires_at,
        current_step, answers_json_v2, version)
       VALUES (?, ?, ?, ?, ?, ?, 0, '[]', 0)`,
    )
    .run(
      input.sessionId,
      input.requestId,
      JSON.stringify(input.questions),
      input.token ?? null,
      now,
      now + ttlMs,
    );
}
```

Add `advanceStep` method:

```typescript
advanceStep(sessionId: string, answer: string[], now = Date.now()): PendingQuestionRecord | null {
  const current = this.getBySessionId(sessionId, now);
  if (!current) return null;

  const newAnswers = [...current.answers, answer];
  const newStep = current.currentStep + 1;
  const newVersion = current.version + 1;

  this.db
    .prepare(
      `UPDATE pending_questions
       SET current_step = ?, answers_json_v2 = ?, version = ?
       WHERE session_id = ?`,
    )
    .run(newStep, JSON.stringify(newAnswers), newVersion, sessionId);

  return { ...current, currentStep: newStep, answers: newAnswers, version: newVersion };
}
```

**Step 6: Run tests to verify they pass**

```bash
npm run test -- packages/daemon/test/repos.test.ts
```
Expected: PASS

**Step 7: Commit**

```bash
git add packages/daemon/src/storage/ packages/daemon/test/repos.test.ts
git commit -m "feat: add wizard state columns to pending_questions storage"
```

---

### Task 3: Per-step wizard formatting function

**Files:**
- Modify: `packages/daemon/src/notification-service.ts` (add `formatQuestionWizardStep`)
- Test: `packages/daemon/test/notification-service.test.ts`

**Step 1: Write tests for formatQuestionWizardStep**

```typescript
describe("formatQuestionWizardStep", () => {
  const questions: QuestionInfoData[] = [
    { question: "Which DB?", header: "Database", options: [
      { label: "PostgreSQL", description: "Relational" },
      { label: "SQLite", description: "File-based" },
    ]},
    { question: "Which ORM?", header: "ORM", options: [
      { label: "Prisma", description: "" },
      { label: "Drizzle", description: "" },
      { label: "None", description: "" },
    ]},
  ];

  it("renders step 1 of 2 with progress header", () => {
    const result = formatQuestionWizardStep({
      label: "pigeon",
      questions,
      currentStep: 0,
      cwd: "/home/dev/projects/pigeon",
      token: "tok-wiz",
      version: 0,
      sessionId: "sess-wiz",
      machineId: "devbox",
    });

    expect(result.text).toContain("Question 1 of 2");
    expect(result.text).toContain("*Database*");
    expect(result.text).toContain("Which DB?");
    expect(result.text).toContain("PostgreSQL");
    expect(result.text).toContain("SQLite");
    expect(result.text).not.toContain("ORM"); // future question not shown
  });

  it("includes versioned callback_data on buttons", () => {
    const result = formatQuestionWizardStep({
      label: "test", questions, currentStep: 0,
      cwd: "/tmp", token: "tok-wiz", version: 0, sessionId: "s1",
    });

    const buttons = result.replyMarkup.inline_keyboard.flat();
    expect(buttons[0]!.callback_data).toBe("cmd:tok-wiz:v0:q0");
    expect(buttons[1]!.callback_data).toBe("cmd:tok-wiz:v0:q1");
  });

  it("renders step 2 of 2", () => {
    const result = formatQuestionWizardStep({
      label: "test", questions, currentStep: 1,
      cwd: "/tmp", token: "tok-wiz", version: 1, sessionId: "s1",
    });

    expect(result.text).toContain("Question 2 of 2");
    expect(result.text).toContain("*ORM*");
    expect(result.text).toContain("Which ORM?");
    expect(result.text).not.toContain("Database");
  });

  it("does NOT include a Cancel button (no opencode API to reject questions)", () => {
    const result = formatQuestionWizardStep({
      label: "test", questions, currentStep: 0,
      cwd: "/tmp", token: "tok-wiz", version: 0, sessionId: "s1",
    });

    const allButtons = result.replyMarkup.inline_keyboard.flat();
    expect(allButtons.every(b => !b.callback_data.includes("cancel"))).toBe(true);
  });

  it("includes swipe-reply hint when custom is enabled", () => {
    const result = formatQuestionWizardStep({
      label: "test", questions, currentStep: 0,
      cwd: "/tmp", token: "tok-wiz", version: 0, sessionId: "s1",
    });
    expect(result.text).toContain("Swipe-reply for custom answer");
  });

  it("hides swipe-reply hint when custom=false", () => {
    const qs = [{ ...questions[0]!, custom: false }, questions[1]!];
    const result = formatQuestionWizardStep({
      label: "test", questions: qs, currentStep: 0,
      cwd: "/tmp", token: "tok-wiz", version: 0, sessionId: "s1",
    });
    expect(result.text).not.toContain("Swipe-reply");
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npm run test -- packages/daemon/test/notification-service.test.ts
```
Expected: FAIL -- `formatQuestionWizardStep` doesn't exist.

**Step 3: Implement formatQuestionWizardStep**

Add to `notification-service.ts`:

```typescript
export function formatQuestionWizardStep(input: {
  label: string;
  questions: QuestionInfoData[];
  currentStep: number;
  cwd: string | null;
  token: string;
  version: number;
  sessionId: string;
  machineId?: string;
}): {
  text: string;
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
} {
  const totalSteps = input.questions.length;
  const currentQuestion = input.questions[input.currentStep]!;
  const cwdShort = input.cwd ? input.cwd.split("/").slice(-2).join("/") : "unknown";

  const lines = [
    `❓ *Question ${input.currentStep + 1} of ${totalSteps}*: ${escapeMarkdown(input.label)}`,
    "",
  ];

  if (currentQuestion.header) {
    lines.push(`*${escapeMarkdown(currentQuestion.header)}*`);
  }
  lines.push(escapeMarkdown(currentQuestion.question));

  if (currentQuestion.options.length > 0) {
    lines.push("");
    currentQuestion.options.forEach((opt, i) => {
      const desc = opt.description ? ` — ${escapeMarkdown(opt.description)}` : "";
      lines.push(`${i + 1}\\. ${escapeMarkdown(opt.label)}${desc}`);
    });
  }

  // Info line
  let infoLine = `📂 \`${cwdShort}\``;
  if (input.machineId) {
    infoLine += ` · 🖥 ${escapeMarkdown(input.machineId)}`;
  }
  lines.push("");
  lines.push(infoLine);
  lines.push(`🆔 \`${input.sessionId}\``);

  const hasCustom = currentQuestion.custom !== false;
  if (hasCustom) {
    lines.push("");
    lines.push("↩️ _Swipe-reply for custom answer_");
  }

  // Option buttons with versioned callback data
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  const options = currentQuestion.options;
  for (let i = 0; i < options.length; i += 3) {
    rows.push(
      options.slice(i, i + 3).map((opt, j) => ({
        text: opt.label,
        callback_data: `cmd:${input.token}:v${input.version}:q${i + j}`,
      })),
    );
  }

  // No Cancel button: opencode has no API to reject/dismiss a pending question
  // and no question timeout. Cancelling would leave opencode permanently stuck,
  // requiring the user to go back to the TUI. Users can swipe-reply with custom
  // text for any step they don't want to answer with the offered options.

  return {
    text: lines.join("\n"),
    replyMarkup: { inline_keyboard: rows },
  };
}
```

**Step 4: Run tests to verify they pass**

```bash
npm run test -- packages/daemon/test/notification-service.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/daemon/src/notification-service.ts packages/daemon/test/notification-service.test.ts
git commit -m "feat: add formatQuestionWizardStep for multi-question rendering"
```

---

### Task 4: Worker editMessageText endpoint

**Files:**
- Modify: `packages/worker/src/notifications.ts` (add `handleEditNotification`)
- Modify: `packages/worker/src/index.ts` (add route)
- Test: `packages/worker/test/worker.test.ts`

**Step 1: Write test for the edit endpoint**

Find the notification-related tests in `worker.test.ts` and add:

```typescript
describe("POST /notifications/edit", () => {
  it("edits a message by notificationId", async () => {
    // Setup: create a session, send a notification to get a message stored
    // ... (follow existing test patterns for session + notification setup)

    const editRes = await worker.fetch(
      new Request("http://test/notifications/edit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          notificationId: "q:sess-1:req-1",
          text: "Updated question text",
          replyMarkup: { inline_keyboard: [[{ text: "New Option", callback_data: "cmd:tok:v1:q0" }]] },
        }),
      }),
      env,
    );

    expect(editRes.status).toBe(200);
    const body = await editRes.json();
    expect(body.ok).toBe(true);

    // Verify Telegram editMessageText was called
    // (check mock/fetch spy for the Telegram API call)
  });

  it("returns 404 for unknown notificationId", async () => {
    const editRes = await worker.fetch(
      new Request("http://test/notifications/edit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          notificationId: "q:nonexistent:req",
          text: "text",
        }),
      }),
      env,
    );

    expect(editRes.status).toBe(404);
  });

  it("rejects unauthenticated requests", async () => {
    const editRes = await worker.fetch(
      new Request("http://test/notifications/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationId: "x", text: "y" }),
      }),
      env,
    );

    expect(editRes.status).toBe(401);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npm run test -- packages/worker/test/worker.test.ts
```
Expected: FAIL -- 404 from unknown route.

**Step 3: Implement handleEditNotification**

Add to `notifications.ts`:

```typescript
/**
 * Handle POST /notifications/edit
 *
 * Edits an existing Telegram message identified by notificationId.
 * Looks up (chat_id, message_id) from the messages table.
 */
export async function handleEditNotification(
  db: D1Database,
  env: Env,
  request: Request,
): Promise<Response> {
  const authResult = verifyApiKey(request, env);
  if (!authResult.ok) return unauthorized();

  const body = (await request.json()) as {
    notificationId?: string;
    text?: string;
    replyMarkup?: unknown;
    parseMode?: string;
  };

  const { notificationId, text, replyMarkup, parseMode } = body;
  if (!notificationId || !text) {
    return json({ error: "notificationId and text are required" }, 400);
  }

  // Look up the original message
  const row = await db
    .prepare("SELECT chat_id, message_id FROM messages WHERE notification_id = ?")
    .bind(notificationId)
    .first<{ chat_id: string; message_id: number }>();

  if (!row) {
    return json({ error: "Message not found for notificationId" }, 404);
  }

  const telegramPayload: Record<string, unknown> = {
    chat_id: row.chat_id,
    message_id: row.message_id,
    text,
  };
  if (parseMode) {
    telegramPayload.parse_mode = parseMode;
  }
  if (replyMarkup) {
    telegramPayload.reply_markup = replyMarkup;
  }

  const telegramResponse = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telegramPayload),
    },
  );

  const telegramResult = (await telegramResponse.json()) as {
    ok: boolean;
    description?: string;
  };

  if (!telegramResult.ok) {
    return json({ error: "Telegram API error", details: telegramResult }, 502);
  }

  return json({ ok: true });
}
```

**Step 4: Add route in index.ts**

In `packages/worker/src/index.ts`, after the `/notifications/send` route (line 54):

```typescript
if (path === "/notifications/edit" && request.method === "POST") {
  return handleEditNotification(db, env, request);
}
```

And add the import at the top.

**Step 5: Run tests to verify they pass**

```bash
npm run test -- packages/worker/test/worker.test.ts
```
Expected: PASS

**Step 6: Commit**

```bash
git add packages/worker/src/notifications.ts packages/worker/src/index.ts packages/worker/test/worker.test.ts
git commit -m "feat: add POST /notifications/edit endpoint for editMessageText"
```

---

### Task 5: Daemon Poller editNotification method

**Files:**
- Modify: `packages/daemon/src/worker/poller.ts:213-241` (add method)
- Test: `packages/daemon/test/poller.test.ts` (or wherever Poller is tested)

**Step 1: Write test for editNotification**

```typescript
it("editNotification calls worker /notifications/edit", async () => {
  const fetchSpy = vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ ok: true }),
  });
  const poller = new Poller({ workerUrl: "http://worker", apiKey: "key", machineId: "m1" }, fetchSpy);

  const result = await poller.editNotification("q:sess:req", "new text", { inline_keyboard: [] });

  expect(result.ok).toBe(true);
  expect(fetchSpy).toHaveBeenCalledWith("http://worker/notifications/edit", expect.objectContaining({
    method: "POST",
    body: expect.stringContaining('"notificationId":"q:sess:req"'),
  }));
});
```

**Step 2: Run test to verify it fails**

```bash
npm run test -- packages/daemon/test/poller.test.ts
```
Expected: FAIL -- `editNotification` doesn't exist.

**Step 3: Implement editNotification**

Add to the `Poller` class in `poller.ts`, after `sendNotification`:

```typescript
async editNotification(
  notificationId: string,
  text: string,
  replyMarkup: { inline_keyboard?: unknown[] },
): Promise<{ ok: boolean }> {
  try {
    const response = await this.fetchFn(`${this.config.workerUrl}/notifications/edit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ notificationId, text, replyMarkup }),
    });
    return await response.json() as { ok: boolean };
  } catch {
    return { ok: false };
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npm run test -- packages/daemon/test/poller.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/daemon/src/worker/poller.ts packages/daemon/test/poller.test.ts
git commit -m "feat: add Poller.editNotification for editing Telegram messages"
```

---

## Phase C: Wizard Flow

### Task 6: Initial wizard notification in /question-asked

**Files:**
- Modify: `packages/daemon/src/app.ts:255-345` (branch on questions.length)
- Test: `packages/daemon/test/app.test.ts`

**Step 1: Write test for multi-question wizard initialization**

```typescript
it("POST /question-asked with multiple questions stores wizard state and formats step 1", async () => {
  // Register session first (follow existing test setup patterns)
  // ...

  const res = await app.request("/question-asked", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: "sess-wiz",
      request_id: "req-wiz",
      questions: [
        { question: "Q1", header: "H1", options: [{ label: "A", description: "" }] },
        { question: "Q2", header: "H2", options: [{ label: "B", description: "" }] },
      ],
      label: "pigeon",
    }),
  });

  expect(res.status).toBe(202);

  // Verify pending question stored with wizard state
  const pq = storage.pendingQuestions.getBySessionId("sess-wiz");
  expect(pq).not.toBeNull();
  expect(pq!.currentStep).toBe(0);
  expect(pq!.answers).toEqual([]);
  expect(pq!.version).toBe(0);

  // Verify outbox entry contains wizard step 1 format
  const outbox = storage.outbox.getByNotificationId("q:sess-wiz:req-wiz");
  expect(outbox).not.toBeNull();
  const payload = JSON.parse(outbox!.payload);
  expect(payload.text).toContain("Question 1 of 2");
  expect(payload.text).toContain("H1");
  // Buttons should be present (wizard mode)
  expect(payload.replyMarkup.inline_keyboard.length).toBeGreaterThan(0);
});
```

**Step 2: Run test to verify it fails**

```bash
npm run test -- packages/daemon/test/app.test.ts
```
Expected: FAIL -- outbox text contains old format, not wizard step format.

**Step 3: Branch on questions.length in /question-asked route**

In `app.ts`, in the `/question-asked` handler, after generating the token and storing the pending question, branch the formatting:

```typescript
// Format the notification payload for the outbox
let notificationPayload: { text: string; replyMarkup: unknown; notificationId: string };

if (questions.length > 1) {
  // Multi-question: wizard mode — show step 1
  const notification = formatQuestionWizardStep({
    label: label || session.label || sessionId.slice(0, 8),
    questions,
    currentStep: 0,
    cwd: session.cwd,
    token,
    version: 0,
    machineId: opts.machineId,
    sessionId,
  });
  notificationPayload = {
    text: notification.text,
    replyMarkup: notification.replyMarkup,
    notificationId,
  };
} else {
  // Single-question: existing behavior
  const notification = formatQuestionNotification({
    label: label || session.label || sessionId.slice(0, 8),
    questions,
    cwd: session.cwd,
    token,
    machineId: opts.machineId,
    sessionId,
  });
  notificationPayload = {
    text: notification.text,
    replyMarkup: notification.replyMarkup,
    notificationId,
  };
}

// Store in outbox
storage.outbox.upsert({
  notificationId,
  sessionId,
  requestId,
  kind: "question",
  payload: JSON.stringify(notificationPayload),
  token,
}, now);
```

Import `formatQuestionWizardStep` at the top of app.ts.

**Step 4: Run tests to verify they pass**

```bash
npm run test -- packages/daemon/test/app.test.ts
```
Expected: PASS (both single-question and multi-question tests).

**Step 5: Commit**

```bash
git add packages/daemon/src/app.ts packages/daemon/test/app.test.ts
git commit -m "feat: use wizard step format for multi-question notifications"
```

---

### Task 7: Wizard routing in command-ingest

This is the core task. When a button tap arrives for a wizard-mode pending question, command-ingest must:
1. Parse the versioned callback data (`v{version}:q{optionIndex}`)
2. Validate the version matches
3. Record the answer for the current step
4. If more steps remain: advance, format next step, edit the Telegram message
5. If final step: collect all answers, deliver to opencode, edit message to "complete", clean up

**Files:**
- Modify: `packages/daemon/src/worker/command-ingest.ts`
- Test: `packages/daemon/test/command-ingest.test.ts`

**Step 1: Write tests for wizard routing**

```typescript
describe("multi-question wizard routing", () => {
  // Setup: pending question with 2 questions, wizard state at step 0
  const twoQuestions = [
    { question: "Q1", header: "H1", options: [
      { label: "A", description: "" }, { label: "B", description: "" },
    ]},
    { question: "Q2", header: "H2", options: [
      { label: "X", description: "" }, { label: "Y", description: "" },
    ]},
  ];

  it("routes v0:q1 to advance wizard from step 0 to step 1", async () => {
    storage.pendingQuestions.store({
      sessionId: "s1", requestId: "r1", questions: twoQuestions, token: "tok",
    });
    // ... setup session, adapter mock, editNotification mock ...

    await ingestWorkerCommand(storage, {
      commandId: "c1", commandType: "execute",
      sessionId: "s1", command: "v0:q1", chatId: "123",
    }, options);

    // Verify wizard advanced
    const pq = storage.pendingQuestions.getBySessionId("s1");
    expect(pq!.currentStep).toBe(1);
    expect(pq!.answers).toEqual([["B"]]);
    expect(pq!.version).toBe(1);

    // Verify message was edited (editNotification called)
    expect(mockEditNotification).toHaveBeenCalledWith(
      "q:s1:r1",
      expect.stringContaining("Question 2 of 2"),
      expect.any(Object),
    );

    // Verify answer NOT delivered to opencode yet
    expect(mockAdapter.deliverQuestionReply).not.toHaveBeenCalled();
  });

  it("routes v1:q0 on final step to deliver all answers", async () => {
    storage.pendingQuestions.store({
      sessionId: "s1", requestId: "r1", questions: twoQuestions, token: "tok",
    });
    // Advance to step 1 first
    storage.pendingQuestions.advanceStep("s1", ["A"]);

    await ingestWorkerCommand(storage, {
      commandId: "c2", commandType: "execute",
      sessionId: "s1", command: "v1:q0", chatId: "123",
    }, options);

    // Verify answers delivered to opencode
    expect(mockAdapter.deliverQuestionReply).toHaveBeenCalledWith(
      expect.any(Object),
      { questionRequestId: "r1", answers: [["A"], ["X"]] },
      expect.any(Object),
    );

    // Verify pending question cleared
    expect(storage.pendingQuestions.getBySessionId("s1")).toBeNull();
  });

  it("ignores stale version (v0 when wizard is at v1)", async () => {
    storage.pendingQuestions.store({
      sessionId: "s1", requestId: "r1", questions: twoQuestions, token: "tok",
    });
    storage.pendingQuestions.advanceStep("s1", ["A"]); // now at version 1

    await ingestWorkerCommand(storage, {
      commandId: "c3", commandType: "execute",
      sessionId: "s1", command: "v0:q0", chatId: "123",
    }, options);

    // Wizard state unchanged
    const pq = storage.pendingQuestions.getBySessionId("s1");
    expect(pq!.currentStep).toBe(1);
    expect(pq!.version).toBe(1);
  });

  it("routes custom text reply as answer for current wizard step", async () => {
    storage.pendingQuestions.store({
      sessionId: "s1", requestId: "r1", questions: twoQuestions, token: "tok",
    });

    await ingestWorkerCommand(storage, {
      commandId: "c5", commandType: "execute",
      sessionId: "s1", command: "Use MongoDB", chatId: "123",
    }, options);

    // Wizard advanced with custom text
    const pq = storage.pendingQuestions.getBySessionId("s1");
    expect(pq!.currentStep).toBe(1);
    expect(pq!.answers).toEqual([["Use MongoDB"]]);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npm run test -- packages/daemon/test/command-ingest.test.ts
```
Expected: FAIL -- wizard routing not implemented.

**Step 3: Implement wizard routing**

Update `command-ingest.ts`:

Add new regex patterns at the top:

```typescript
const QUESTION_OPTION_RE = /^q(\d+)$/;
const WIZARD_OPTION_RE = /^v(\d+):q(\d+)$/;
```

Add `editNotification` to the options interface:

```typescript
export interface WorkerCommandIngestOptions {
  createAdapter?: (session: SessionRecord) => CommandDeliveryAdapter | null;
  executeDirect?: (...) => Promise<OpencodeDirectExecuteResult>;
  workerUrl?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
  /** Edit an existing Telegram notification (for wizard step transitions) */
  editNotification?: (notificationId: string, text: string, replyMarkup: unknown) => Promise<{ ok: boolean }>;
  /** Machine ID for formatting wizard steps */
  machineId?: string;
}
```

In `ingestWorkerCommand`, in the pending-question branch (after line 94), replace the existing routing logic with:

```typescript
if (pendingQuestion) {
  const command = msg.command.trim();
  const isWizard = pendingQuestion.questions.length > 1;

  // Parse option selection (wizard versioned or legacy unversioned)
  const wizardMatch = WIZARD_OPTION_RE.exec(command);
  const legacyMatch = QUESTION_OPTION_RE.exec(command);

  let optionIndex: number | null = null;
  let isCustomText = false;

  if (wizardMatch) {
    const version = Number(wizardMatch[1]);
    if (isWizard && version !== pendingQuestion.version) {
      console.log(`[command-ingest] stale wizard tap v=${version} current=${pendingQuestion.version}`);
      storage.inbox.markDone(commandId);
      return;
    }
    optionIndex = Number(wizardMatch[2]);
  } else if (legacyMatch) {
    optionIndex = Number(legacyMatch[1]);
  } else {
    // Custom text answer
    isCustomText = true;
  }

  const currentQuestion = pendingQuestion.questions[pendingQuestion.currentStep];
  if (!currentQuestion) {
    console.warn(`[command-ingest] invalid currentStep=${pendingQuestion.currentStep}`);
    storage.inbox.markDone(commandId);
    return;
  }

  // Resolve the answer for the current step
  let stepAnswer: string[];
  if (isCustomText) {
    stepAnswer = [command];
  } else if (optionIndex !== null && optionIndex < currentQuestion.options.length) {
    stepAnswer = [currentQuestion.options[optionIndex]!.label];
  } else {
    console.warn(`[command-ingest] invalid option index ${optionIndex}`);
    storage.inbox.markDone(commandId);
    return;
  }

  // Wizard mode: advance step
  if (isWizard) {
    const isLastStep = pendingQuestion.currentStep >= pendingQuestion.questions.length - 1;

    if (!isLastStep) {
      // Advance to next step
      const updated = storage.pendingQuestions.advanceStep(msg.sessionId, stepAnswer);
      storage.inbox.markDone(commandId);

      if (updated && options.editNotification) {
        const notificationId = `q:${msg.sessionId}:${pendingQuestion.requestId}`;
        const session = storage.sessions.get(msg.sessionId);
        const nextStep = formatQuestionWizardStep({
          label: session?.label || msg.sessionId.slice(0, 8),
          questions: pendingQuestion.questions,
          currentStep: updated.currentStep,
          cwd: session?.cwd ?? null,
          token: pendingQuestion.token!,
          version: updated.version,
          sessionId: msg.sessionId,
          machineId: options.machineId,
        });
        await options.editNotification(notificationId, nextStep.text, nextStep.replyMarkup);
      }
      return;
    }

    // Final step: collect all answers and deliver
    const allAnswers = [...pendingQuestion.answers, stepAnswer];

    const adapter = options.createAdapter
      ? options.createAdapter(session)
      : selectAdapter(session);

    if (!adapter || !adapter.deliverQuestionReply) {
      console.warn(`[command-ingest] adapter does not support question replies`);
      storage.inbox.markDone(commandId);
      return;
    }

    const result = await adapter.deliverQuestionReply(
      session,
      { questionRequestId: pendingQuestion.requestId, answers: allAnswers },
      { commandId, chatId: msg.chatId },
    );

    if (result.ok) {
      storage.inbox.markDone(commandId);
      storage.pendingQuestions.delete(msg.sessionId);

      if (options.editNotification) {
        const notificationId = `q:${msg.sessionId}:${pendingQuestion.requestId}`;
        await options.editNotification(
          notificationId,
          "✅ _All answers submitted_",
          { inline_keyboard: [] },
        );
      }
      return;
    }

    console.warn(`[command-ingest] wizard final delivery failed: ${result.error}`);
    storage.inbox.markDone(commandId);
    return;
  }

  // Single-question mode: existing behavior (deliver immediately)
  const answers = [stepAnswer];

  const adapter = options.createAdapter
    ? options.createAdapter(session)
    : selectAdapter(session);

  if (!adapter || !adapter.deliverQuestionReply) {
    console.warn(`[command-ingest] adapter does not support question replies`);
    storage.inbox.markDone(commandId);
    return;
  }

  const result = await adapter.deliverQuestionReply(
    session,
    { questionRequestId: pendingQuestion.requestId, answers },
    { commandId, chatId: msg.chatId },
  );

  if (result.ok) {
    storage.inbox.markDone(commandId);
    storage.pendingQuestions.delete(msg.sessionId);
    return;
  }

  console.warn(`[command-ingest] question reply failed commandId=${commandId} error=${result.error}`);
  storage.inbox.markDone(commandId);
  return;
}
```

Import `formatQuestionWizardStep` at the top of command-ingest.ts.

**Step 4: Run tests to verify they pass**

```bash
npm run test -- packages/daemon/test/command-ingest.test.ts
```
Expected: PASS (all existing tests + new wizard tests).

**Step 5: Run full test suite**

```bash
npm run test
```
Expected: All tests pass.

**Step 6: Commit**

```bash
git add packages/daemon/src/worker/command-ingest.ts packages/daemon/test/command-ingest.test.ts
git commit -m "feat: implement multi-question wizard routing in command-ingest"
```

---

### Task 8: Wire editNotification into the daemon polling loop

The `editNotification` function needs to be passed from the Poller into command-ingest options wherever `ingestWorkerCommand` is called.

**Files:**
- Modify: wherever `ingestWorkerCommand` is called (likely `packages/daemon/src/app.ts` or a polling orchestrator)
- This may be wired in `packages/daemon/src/index.ts` or the Poller's `processCommands` method

**Step 1: Find where ingestWorkerCommand is called**

Search for `ingestWorkerCommand` call sites.

**Step 2: Wire the Poller's editNotification into options**

```typescript
await ingestWorkerCommand(storage, msg, {
  ...existingOptions,
  editNotification: (nid, text, rm) => poller.editNotification(nid, text, rm),
  machineId: config.machineId,
});
```

**Step 3: Run full test suite**

```bash
npm run test && npm run typecheck
```
Expected: PASS

**Step 4: Commit**

```bash
git add packages/daemon/src/
git commit -m "feat: wire editNotification into command-ingest options"
```

---

## Known Limitations & Future Work

1. **Polling delay.** Button taps take up to 5s to reflect (daemon polling interval). The user sees "Command sent" immediately from the worker's `answerCallbackQuery`, but the message edit lags. Acceptable for now; can be improved by moving wizard state to D1 in the worker for instant edits.

2. **`multiple: true` (multi-select) not supported.** The `multiple` field passes through but is ignored. Phase 2 would add toggle buttons with checkmarks and a Submit button.

3. **parse_mode not passed through outbox->worker path.** The worker's `/notifications/send` endpoint doesn't add `parse_mode` to the Telegram API call. The edit endpoint accepts `parseMode` but we don't send it from the daemon yet. Pre-existing issue; should be fixed separately.

4. **Stale tap UX.** When a stale button is tapped, the user sees "Command sent" (from worker) but nothing changes (daemon ignores it). No error feedback. Could be improved by having the worker validate version against D1 state.

5. **No timeout handling mid-wizard.** If a user abandons a wizard mid-flow, the pending question expires after 4 hours (existing TTL). The Telegram message keeps showing stale buttons until then. Could add a shorter wizard-specific TTL or a background cleanup that edits expired wizard messages.

6. **No Cancel button by design.** opencode has no API to reject/dismiss a pending question and no question timeout. A Cancel button would leave opencode permanently stuck waiting for an answer, forcing the user back to the TUI -- violating pigeon's core principle that the user must never be blocked from continuing the interaction via Telegram alone. Instead, users can swipe-reply with custom text for any wizard step. If an upstream `POST /question/{id}/reject` API becomes available in opencode, a Cancel button could be reconsidered.
