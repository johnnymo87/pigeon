# Telegram Forum Topics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move Pigeon from a single Telegram DM to a forum supergroup where each opencode session gets its own topic, named from its TUI session title.

**Architecture:** Three phases that ship independently. Phase 0 plumbs the real session title from the opencode plugin through the daemon into notification headers. Phase 1 fixes two verified outbox correctness bugs and extracts a central Telegram client — both prerequisites for threading, both valuable alone. Phase 2 adds a worker-owned topic manager, topic-membership inbound routing, and the chat migration. Phases 0 and 1 ship dark with zero user-visible migration.

**Tech Stack:** TypeScript, vitest everywhere. Worker: Cloudflare Workers + D1, tested via `cloudflare:test` (miniflare) with real D1 and `fetchMock` for Telegram. Daemon: Node + `better-sqlite3`. Plugin: `@opencode-ai/plugin`.

**Design doc:** `docs/plans/2026-07-25-telegram-forum-topics-design.md` (revision 2). Read it before starting any phase — it carries the rationale, the verified-bug evidence, and the deferred decisions.

---

## How to use this plan across sessions

This plan is a **spine**. It is expected to outlive several compactions, subagent-driven-development runs, and adversarial reviews.

**On resuming:** read this section, then the Progress Tracker, then the design doc, then the first unchecked task.

**Rules:**

- Mark a task `[x]` only after its tests pass AND it is committed. Never on intent.
- One task per commit. Commit messages use conventional-commit style matching the repo (`feat(daemon):`, `fix(worker):`, `docs:`).
- Do not skip ahead across a **Checkpoint**. Checkpoints exist because later tasks depend on earlier ones being verified in the real system.
- Phase 2 task detail was written before Phase 0/1 landed. **Re-read the affected source files before executing any Phase 2 task** — line numbers will have drifted.
- If a task turns out to be wrong, amend this file in the same commit as the fix and note why.

**Verification commands** (run from repo root):

```bash
npm run test         # all workspaces
npm run typecheck    # all workspaces
```

**Baseline as of 2026-07-25, commit `3c32389`** — measure regressions against this, not against zero:

| Package | Test files | Tests |
|---|---|---|
| `@pigeon/daemon` | 48 | 588 passed, 1 skipped |
| `@pigeon/opencode-plugin` | 12 | 246 passed |
| `@pigeon/worker` | 1 | 163 passed |

`npm run test` is **fully green**. `npm run typecheck` is **not**: `@pigeon/daemon` has
pre-existing errors confined to `test/routing/lease-cas-concurrency.test.ts` and
`test/routing/lease-cas-concurrency.bun-worker.ts`. Worker and plugin typecheck clean.
**Do not treat those two files as a regression you caused**, and do not fix them as part of
this plan — that is unrelated scope.

Single package:

```bash
npm run --workspace @pigeon/daemon test
npm run --workspace @pigeon/worker test
npm run --workspace @pigeon/opencode-plugin test
```

Single test file: `npx vitest run test/<file>.test.ts` from inside the package dir.

---

## Progress Tracker

### Phase 0 — Session titles (ships dark)

- [ ] T0.1 Daemon: `title` column + storage plumbing
- [ ] T0.2 Daemon: `/session-start` accepts `title`
- [ ] T0.3 Daemon: `displayName()` helper replaces 7 duplicated precedence expressions
- [ ] T0.4 Plugin: capture title from `session.get()` at registration
- [ ] T0.5 Plugin: `session.updated` handler keeps the title fresh
- [ ] T0.6 Plugin + daemon: `/stop` and `/question-asked` carry `title`
- [ ] **Checkpoint 0** — full test + typecheck, deploy, observe titles in Telegram headers

### Phase 1 — Outbox correctness + Telegram client (ships dark)

- [ ] T1.1 Daemon: per-chunk idempotency keys in `OutboxSender`
- [ ] T1.2 Worker: `q:` notification-id parsing tolerates the chunk suffix
- [ ] T1.3 Worker: surface Telegram's `retry_after` as a 429 response
- [ ] T1.4 Daemon: global outbox pause on `retry_after`
- [ ] T1.5 Worker: extract a central Telegram client module
- [ ] T1.6 Daemon: convert `poller.sendNotification` to an options object
- [ ] **Checkpoint 1** — full test + typecheck, deploy, adversarial review of the Phase 0+1 diff

### Phase 2 — Topics

- [ ] T2.1 Worker: `topics` table (schema file + test schema array)
- [ ] T2.2 Worker: `topics.ts` repo module
- [ ] T2.3 Worker: reservation protocol + `createForumTopic`
- [ ] T2.4 Worker: `label` + `threaded` on the send payload; wire topic resolution
- [ ] T2.5 Worker: reopen-on-closed
- [ ] T2.6 Worker: stale-thread recovery
- [ ] T2.7 Worker: non-429 fallback to General, 429 propagates
- [ ] T2.8 Worker: media sends pass `message_thread_id`
- [ ] T2.9 Worker: close topic on session unregister
- [ ] T2.10 Worker: reap closed topics in the hourly cron
- [ ] T2.11 Daemon: `/current-state` cards send `threaded: false`
- [ ] T2.12 Worker: inbound topic-membership resolution + service-message guard
- [ ] T2.13 Worker + daemon: `message_thread_id` round-trip on commands
- [ ] T2.14 Worker: webhook confirmations echo `message_thread_id`
- [ ] T2.15 Worker: bare slash commands resolve via topic
- [ ] T2.16 Worker: `TELEGRAM_TOPICS_ENABLED` flag
- [ ] T2.17 Docs: migration runbook + `worker-deployment` skill update
- [ ] **Checkpoint 2** — adversarial review, then execute the migration runbook

---

## Phase 0 — Session titles

**Why first:** "can't tell which session a message came from" is the sharpest of the four reported pains, and this fixes it at ~5% of the cost of topics. It also produces the `title` that Phase 2 uses for topic names.

**Current state:** the human-readable name Pigeon shows is the directory basename, minted once at `packages/opencode-plugin/src/index.ts:209`. The real TUI title sits unused in a call the plugin already makes (`index.ts:228`, `.data.title` discarded).

**Exit criteria:** a stop notification header reads `🤖 **Stop**: Fix flaky auth test` instead of `🤖 **Stop**: pigeon`.

### Task T0.1: Daemon `title` column + storage plumbing

**Files:**
- Modify: `packages/daemon/src/storage/schema.ts:103-113` (additive migration list)
- Modify: `packages/daemon/src/storage/types.ts` (`SessionRecord`, `UpsertSessionInput`)
- Modify: `packages/daemon/src/storage/repos.ts` (`asSession`, upsert SQL)
- Test: `packages/daemon/test/storage.test.ts`

**Step 1: Write the failing test**

Add to `packages/daemon/test/storage.test.ts`, following the existing session-upsert test style in that file:

```typescript
it("persists and returns session title", () => {
  const storage = createTestStorage();
  storage.sessions.upsert({
    sessionId: "ses_title",
    cwd: "/home/dev/projects/pigeon",
    label: "pigeon",
    title: "Fix flaky auth test",
    notify: true,
  });
  expect(storage.sessions.get("ses_title")?.title).toBe("Fix flaky auth test");
});

it("leaves title null when not supplied", () => {
  const storage = createTestStorage();
  storage.sessions.upsert({ sessionId: "ses_notitle", cwd: "/tmp", notify: true });
  expect(storage.sessions.get("ses_notitle")?.title).toBeNull();
});
```

**Step 2: Run test to verify it fails**

Run: `npm run --workspace @pigeon/daemon test -- storage`
Expected: FAIL — `title` is not a known property / returns `undefined`.

**Step 3: Implement**

`schema.ts` — append to the `additiveColumns` array (order matters only in that it must be last, matching the existing convention of appending):

```typescript
"ALTER TABLE sessions ADD COLUMN title TEXT DEFAULT NULL",
```

`storage/types.ts` — add `title: string | null;` to `SessionRecord` and `title?: string | null;` to `UpsertSessionInput`.

`storage/repos.ts` — add `title: row.title ?? null` to `asSession()`, and add the column to the upsert statement. **Follow the existing existing-value-fallback idiom** used for `label` (`COALESCE`-style: an absent `title` must not clobber a stored one).

**Step 4: Run test to verify it passes**

Run: `npm run --workspace @pigeon/daemon test -- storage`
Expected: PASS. Also run the full daemon suite — the upsert SQL is shared by many tests.

**Step 5: Commit**

```bash
git add packages/daemon/src/storage packages/daemon/test/storage.test.ts
git commit -m "feat(daemon): store opencode session title alongside label"
```

### Task T0.2: Daemon `/session-start` accepts `title`

**Files:**
- Modify: `packages/daemon/src/app.ts:218-262` (the `/session-start` handler)
- Test: `packages/daemon/test/app.test.ts`

**Step 1: Write the failing test**

```typescript
it("stores title from /session-start", async () => {
  const res = await request(app).post("/session-start").send({
    session_id: "ses_t2",
    notify: true,
    cwd: "/home/dev/projects/pigeon",
    label: "pigeon",
    title: "Fix flaky auth test",
  });
  expect(res.status).toBe(200);
  expect(storage.sessions.get("ses_t2")?.title).toBe("Fix flaky auth test");
});

it("does not clobber a stored title when /session-start omits it", async () => {
  // seed with a title, then re-register without one
  ...
  expect(storage.sessions.get("ses_t2")?.title).toBe("Fix flaky auth test");
});
```

Match the existing supertest/fetch idiom already used in `app.test.ts`.

**Step 2: Run to verify it fails.** Expected: `title` is `null`.

**Step 3: Implement.** In the upsert at `app.ts:229-255`, add `title` using the *same* precedence idiom as `label` at `:236` — `body.title` if a non-empty string, else `existing.title`.

**Step 4: Run tests.** `npm run --workspace @pigeon/daemon test -- app`

**Step 5: Commit**

```bash
git commit -am "feat(daemon): accept title on /session-start"
```

### Task T0.3: `displayName()` helper replaces duplicated precedence

**Files:**
- Modify: `packages/daemon/src/notification-service.ts` (add helper; use at `:427`, `:473`, `:556`, `:625`)
- Modify: `packages/daemon/src/app.ts` (use at `:377`, `:474`, `:491`)
- Test: `packages/daemon/test/notification-service.test.ts`

**Why a helper:** the expression `label || session.label || sessionId.slice(0,8)` is currently duplicated **seven** times across two files. Adding a third input to seven copies is how bugs are born. DRY it first.

**Step 1: Write the failing test**

```typescript
describe("displayName", () => {
  it("prefers title", () => {
    expect(displayName({ title: "Fix auth", label: "pigeon", sessionId: "ses_abcdef123" }))
      .toBe("Fix auth");
  });
  it("falls back to label when title is absent or blank", () => {
    expect(displayName({ title: null, label: "pigeon", sessionId: "ses_abcdef123" })).toBe("pigeon");
    expect(displayName({ title: "  ", label: "pigeon", sessionId: "ses_abcdef123" })).toBe("pigeon");
  });
  it("falls back to a session-id prefix when both are absent", () => {
    expect(displayName({ title: null, label: null, sessionId: "ses_abcdef123" })).toBe("ses_abcd");
  });
});
```

**Step 2: Run to verify it fails.** Expected: `displayName is not exported`.

**Step 3: Implement**

```typescript
export function displayName(input: {
  title?: string | null;
  label?: string | null;
  sessionId: string;
}): string {
  const title = input.title?.trim();
  if (title) return title;
  const label = input.label?.trim();
  if (label) return label;
  return input.sessionId.slice(0, 8);
}
```

Then replace all seven call sites. **Do this mechanically and verify each** — `app.ts:377` currently reads `label || session.label || sessionId.slice(0,8)`; it becomes `displayName({ title: session.title, label: label || session.label, sessionId })`. Note the request-supplied `label` still wins over the stored one.

**Step 4: Run the full daemon suite.** Formatter snapshots may need updating — inspect each diff and confirm it is the intended title change, not an accident.

**Step 5: Commit**

```bash
git commit -am "refactor(daemon): extract displayName(), prefer session title in notifications"
```

### Task T0.4: Plugin captures title at registration

**Files:**
- Modify: `packages/opencode-plugin/src/index.ts:228-247` (`lateDiscoverSession`), `:313-353` (`session.created`)
- Modify: `packages/opencode-plugin/src/daemon-client.ts:113-130` (`registerSession` body)
- Test: `packages/opencode-plugin/test/daemon-client.test.ts`

**Step 1: Write the failing test** in `daemon-client.test.ts`, asserting `registerSession({ ..., title: "Fix auth" })` puts `title` in the POST body and omits the key entirely when undefined (match how `label` is handled).

**Step 2: Run to verify it fails.**

**Step 3: Implement.**
- `daemon-client.ts`: add `title?: string` to the options type and `...(title ? { title } : {})` to the body.
- `index.ts:228-231`: `const session = await ctx.client.session.get(...)` already runs — capture `session.data?.title` and pass it to the `registerSession` call at `:234`.
- `index.ts:314-318` (`session.created`): `sessionInfo.title` is already declared in the local narrowing type but unused — pass it at `:329`.

**Caveat to encode in a comment:** `session.created` fires *before* opencode generates the title, so this value is usually a placeholder. T0.5 is what makes it correct. Do not delete T0.5 as redundant.

**Step 4: Run.** `npm run --workspace @pigeon/opencode-plugin test`

**Step 5: Commit**

```bash
git commit -am "feat(plugin): send opencode session title on registration"
```

### Task T0.5: Plugin `session.updated` handler

**Files:**
- Modify: `packages/opencode-plugin/src/index.ts` (event dispatcher, `:307-627`)
- Test: `packages/opencode-plugin/test/` — new `session-title.test.ts`

**Verified prerequisite:** `EventSessionUpdated` is a member of the SDK `Event` union (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:499-504`, union at `:602`) and the plugin `event` hook receives the full union (`node_modules/@opencode-ai/plugin/dist/index.d.ts:109-110`). These events do reach plugins.

**Step 1: Write the failing test.** Assert that dispatching a `session.updated` event whose `info.title` differs from the last-seen title triggers exactly one `registerSession` call, and that dispatching the *same* title again triggers none (debounce — opencode emits `session.updated` frequently for reasons unrelated to the title).

**Step 2: Run to verify it fails.**

**Step 3: Implement.** Add a handler that:
- reads `props.info` as `{ id?: string; title?: string; parentID?: string }`
- ignores child sessions (`parentID` set) and unknown sessions
- keeps a `Map<sessionID, string>` of last-sent titles; returns early if unchanged
- calls the existing `registerSession` (the daemon-side upsert is idempotent, so no new endpoint is needed)

Reuse `sessionManager` for known-session checks rather than adding parallel state.

**Step 4: Run.** Both the new test and the full plugin suite.

**Step 5: Commit**

```bash
git commit -m "feat(plugin): refresh session title on session.updated"
```

### Task T0.6: `/stop` and `/question-asked` carry `title`

**Files:**
- Modify: `packages/opencode-plugin/src/daemon-client.ts:158-169` (`notifyStop`), `:195-205` + `:257-267` (question payloads)
- Modify: `packages/daemon/src/app.ts:326-404` (`/stop`), `:406-519` (`/question-asked`)
- Test: `packages/opencode-plugin/test/daemon-client.test.ts`, `packages/daemon/test/app.test.ts`

**Why:** registration-time title can be stale (a session is registered once but notifies many times). Carrying `title` on each notification is what makes the header — and later the topic name — track the live title.

**Steps:** same TDD shape. Plugin sends `title` alongside the existing `label`; the daemon handlers pass it into `displayName()` with request-supplied values winning over stored ones, and persist it back to the `sessions` row so `/current-state` and topic naming see it too.

**Commit:**

```bash
git commit -am "feat: carry session title on stop and question notifications"
```

### Checkpoint 0

```bash
npm run test && npm run typecheck
```

Both must be green. Then deploy per the `cross-device-deployment` skill and confirm in Telegram that stop notifications now show real session titles. **Do not proceed to Phase 1 until you have seen a real title in a real notification** — Phase 2's topic names depend entirely on this working.

---

## Phase 1 — Outbox correctness + Telegram client

**Why before topics:** T1.1 fixes a bug that a 20 msg/min supergroup ceiling would promote from rare to routine, and T1.5/T1.6 are the refactors that make threading expressible. All ship dark.

### Task T1.1: Per-chunk idempotency keys

**Files:**
- Modify: `packages/daemon/src/worker/outbox-sender.ts:136-173`
- Test: `packages/daemon/test/outbox-sender.test.ts`

**The verified bug:** `OutboxSender` sends chunks in a loop; on any chunk failing it `break`s and marks the *whole entry* for retry (`:152-163`). On retry the loop restarts at `i=0`. Only the last chunk carries `notificationId` (`:148`), and worker dedup keys on it (`packages/worker/src/notifications.ts:197-205`). So chunks before the failure are re-sent with no idempotency key → duplicate Telegram messages → more traffic into an already-throttled chat.

**Step 1: Write the failing test**

```typescript
it("does not re-send delivered chunks after a mid-chunk failure", async () => {
  const sent: Array<string | undefined> = [];
  let failNext = true;
  const sendNotification = vi.fn(async (_s, _c, text, _rm, _m, notificationId) => {
    sent.push(text);
    if (failNext && text === "chunk-2") { failNext = false; return { ok: false }; }
    return { ok: true };
  });
  // enqueue a 3-chunk entry, processOnce() twice (advancing time past the backoff)
  // assert: every distinct notificationId passed to sendNotification is unique,
  // and chunk-1's id on the retry equals its id on the first attempt
  //   (so worker-side dedup suppresses it)
});
```

The assertion that matters: **every chunk send carries a defined `notificationId`**, and the id for chunk *i* is stable across attempts.

**Step 2: Run to verify it fails.** Expected: chunk 0 is sent with `notificationId === undefined` on both attempts.

**Step 3: Implement**

```typescript
/**
 * Per-chunk idempotency key. The LAST chunk keeps the bare notificationId
 * because handleEditNotification (the multi-question wizard) looks messages up
 * by exactly that id, and it is the chunk that carries reply_markup.
 * Earlier chunks get a "#c{i}" suffix so worker-side dedup can suppress them
 * on retry. See webhook.ts question-id parsing, which strips this suffix.
 */
export function chunkNotificationId(
  notificationId: string | undefined,
  index: number,
  isLast: boolean,
): string | undefined {
  if (!notificationId) return undefined;
  return isLast ? notificationId : `${notificationId}#c${index}`;
}
```

Use it at `:148` in place of `isLast ? notificationId : undefined`.

**Why `#` and not `:`:** notification ids are `:`-delimited (`q:{sessionId}:{requestId}`) and the worker parses them by splitting on `:` (`webhook.ts:336-339`). A `#` suffix cannot be confused with a delimiter.

**Step 4: Run.** `npm run --workspace @pigeon/daemon test -- outbox`

**Step 5: Commit**

```bash
git commit -am "fix(daemon): per-chunk idempotency keys so outbox retries do not duplicate chunks"
```

### Task T1.2: Worker `q:` parsing tolerates the chunk suffix

**Files:**
- Modify: `packages/worker/src/webhook.ts:334-340`
- Test: `packages/worker/test/worker.test.ts` (`resolveMessageSession` describe block)

**The bug this prevents:** line 338 is `result.questionRequestId = parts.slice(2).join(":")`. For a chunk id `q:ses_x:req123#c0` that yields `req123#c0` — a request id that matches nothing, so the swipe-reply silently fails to answer the question.

**Step 1: Write the failing test**

```typescript
it("strips the chunk suffix from a question notification id", async () => {
  await seedMessage({ chatId, messageId: 42, sessionId: "ses_x", notificationId: "q:ses_x:req123#c0" });
  const r = await resolveMessageSession(env.DB, {
    message_id: 99, chat: { id: chatId }, text: "my answer",
    reply_to_message: { message_id: 42 },
  });
  expect(r?.questionRequestId).toBe("req123");
});
```

**Step 2: Run to verify it fails.** Expected: `"req123#c0"`.

**Step 3: Implement.** After the existing `parts.slice(2).join(":")`, strip the suffix:

```typescript
result.questionRequestId = parts.slice(2).join(":").replace(/#c\d+$/, "");
```

**Step 4: Run.** `npm run --workspace @pigeon/worker test`

**Step 5: Commit**

```bash
git commit -am "fix(worker): strip chunk suffix when parsing question notification ids"
```

### Task T1.3: Worker surfaces Telegram `retry_after` as 429

**Files:**
- Modify: `packages/worker/src/notifications.ts:244-249`
- Test: `packages/worker/test/worker.test.ts`

**Step 1: Write the failing test.** Using `fetchMock`, stub `sendMessage` to return `{ ok: false, error_code: 429, parameters: { retry_after: 17 } }`. Assert `handleSendNotification` responds **429** with body `{ error: "rate_limited", retryAfter: 17 }`, not the current 502.

**Step 2: Run to verify it fails.** Expected: 502.

**Step 3: Implement.** Widen the Telegram result type to include `error_code?: number` and `parameters?: { retry_after?: number }`. Before the generic 502 at `:244-249`:

```typescript
if (!telegramResult.ok && telegramResult.error_code === 429) {
  const retryAfter = telegramResult.parameters?.retry_after ?? 60;
  return json({ error: "rate_limited", retryAfter }, 429);
}
```

**Step 4: Run.** Worker suite.

**Step 5: Commit**

```bash
git commit -am "feat(worker): surface Telegram retry_after as a 429 response"
```

### Task T1.4: Global outbox pause on `retry_after`

**Files:**
- Modify: `packages/daemon/src/worker/poller.ts:297-327` (`sendNotification` returns `retryAfter`)
- Modify: `packages/daemon/src/worker/outbox-sender.ts` (`SendNotificationFn` type, `processOnce`)
- Test: `packages/daemon/test/outbox-sender.test.ts`, `packages/daemon/test/poller.test.ts`

**The gap:** today a `retry_after` reschedules one entry while the other four in the batch keep firing at the same throttled chat.

**Step 1: Write the failing test**

```typescript
it("pauses the whole outbox when a send reports retryAfter", async () => {
  // 3 queued entries; first send returns { ok: false, retryAfter: 30 }
  await sender.processOnce();
  expect(sendNotification).toHaveBeenCalledTimes(1); // not 3
  now += 29_000;
  await sender.processOnce();
  expect(sendNotification).toHaveBeenCalledTimes(1); // still paused
  now += 2_000;
  await sender.processOnce();
  expect(sendNotification).toHaveBeenCalledTimes(2); // resumed
});
```

**Step 2: Run to verify it fails.** Expected: 3 calls on the first `processOnce`.

**Step 3: Implement.**
- `poller.sendNotification`: on a 429, read `retryAfter` from the JSON body and return `{ ok: false, retryAfter }`.
- `SendNotificationFn` return type becomes `Promise<{ ok: boolean; retryAfter?: number }>`.
- `OutboxSender` gains `private pausedUntil = 0`. `processOnce` returns early if `this.nowFn() < this.pausedUntil`. On a `retryAfter` result, set `this.pausedUntil = now + retryAfter * 1000`, mark the entry for retry, and `break` out of the entry loop.

**Step 4: Run.** Daemon suite.

**Step 5: Commit**

```bash
git commit -am "feat(daemon): pause the whole outbox on Telegram retry_after"
```

### Task T1.5: Extract a central Telegram client in the worker

**Files:**
- Create: `packages/worker/src/telegram.ts`
- Modify: `packages/worker/src/notifications.ts` (4 call sites: `:135`, `:154`, `:229`, `:341`)
- Modify: `packages/worker/src/webhook.ts` (`sendTelegramMessage` `:282-292`, `answerCallbackQuery` `:297-307`, `getFile` `:240-247`, file download `:258-259`)
- Test: `packages/worker/test/worker.test.ts`

**Why:** six inline `fetch` calls against a template-literal URL, with three duplicate `sendMessage` implementations. Phase 2 adds five forum methods and a `message_thread_id` parameter to most sends. That is not expressible until this is one module.

**Design of the module.** Every method returns a discriminated result so callers can distinguish rate limits from permanent failures — Phase 2's fallback rule depends on this:

```typescript
export type TgResult<T> =
  | { ok: true; result: T }
  | { ok: false; kind: "rate_limited"; retryAfter: number }
  | { ok: false; kind: "thread_not_found" }
  | { ok: false; kind: "error"; errorCode?: number; description?: string };
```

`thread_not_found` is classified by matching Telegram's description for a missing `message_thread_id`. **Verify the exact string empirically during Phase 2** and, until then, treat an unmatched 400 as `kind: "error"`.

**Step 1: Write the failing tests** for the classifier — a 429 with `parameters.retry_after`, a plain 400, and a success — driving `sendMessage` through `fetchMock`.

**Step 2: Run to verify they fail.** Expected: module does not exist.

**Step 3: Implement** `telegram.ts` with `sendMessage`, `editMessageText`, `sendPhoto`, `sendDocument`, `answerCallbackQuery`, `getFile`. Leave the forum methods for T2.3. Then refactor every call site to use it.

**This is a pure refactor.** The existing worker suite must pass **unchanged**. If a test needs editing, stop — you have changed behavior.

**Step 4: Run.** `npm run --workspace @pigeon/worker test && npm run --workspace @pigeon/worker typecheck`

**Step 5: Commit**

```bash
git commit -am "refactor(worker): extract a central Telegram client module"
```

### Task T1.6: `poller.sendNotification` takes an options object

**Files:**
- Modify: `packages/daemon/src/worker/poller.ts:297-327`
- Modify: `packages/daemon/src/worker/outbox-sender.ts` (`SendNotificationFn`, call at `:142-150`)
- Modify: `packages/daemon/src/notification-service.ts:61-70`, `packages/daemon/src/index.ts:254-260`
- Test: `packages/daemon/test/poller.test.ts` and any test constructing a `SendNotificationFn`

**Why:** the signature is already seven positional parameters, three of them optional. Phase 2 adds `label` and `threaded`. Nine positional parameters with a `undefined, undefined` gap in the middle is how the wrong argument ends up in the wrong slot.

**Step 1–4:** mechanical refactor to

```typescript
export interface SendNotificationInput {
  sessionId: string;
  chatId: string;
  text: string;
  replyMarkup: unknown;
  media?: Array<{ key: string; mime: string; filename: string }>;
  notificationId?: string;
  entities?: unknown[];
}
```

Pure refactor: the existing suite must pass unchanged.

**Step 5: Commit**

```bash
git commit -am "refactor(daemon): sendNotification takes an options object"
```

### Checkpoint 1

```bash
npm run test && npm run typecheck
```

Deploy per `cross-device-deployment`. Then **dispatch an adversarial review of the cumulative Phase 0 + Phase 1 diff** before starting Phase 2:

```
git diff <sha-before-T0.1>..HEAD
```

Phase 2 is the largest and riskiest phase; a clean base matters.

---

## Phase 2 — Topics

> **Before executing any Phase 2 task:** re-read `docs/plans/2026-07-25-telegram-forum-topics-design.md` and the source files named below. Line numbers in this section predate Phases 0 and 1 and will have drifted.

**Prerequisite that is not code:** the supergroup must exist before T2.16 can be flipped on, but *all* of Phase 2 can be built and tested against `fetchMock` without it. Do the manual setup during Checkpoint 2, not now.

### Task T2.1: `topics` table

**Files:**
- Modify: `packages/worker/src/d1-schema.sql`
- Modify: `packages/worker/test/worker.test.ts:35-79` (the `d1SchemaStatements` array)

**Trap:** the worker test file **duplicates the schema** rather than reading the `.sql` file. Both must be updated or tests pass locally against a table production does not have.

```sql
CREATE TABLE IF NOT EXISTS topics (
  session_id        TEXT PRIMARY KEY,
  machine_id        TEXT,
  chat_id           TEXT NOT NULL,
  message_thread_id INTEGER,
  name              TEXT,
  state             TEXT NOT NULL DEFAULT 'open',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  closed_at         INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_thread
  ON topics(chat_id, message_thread_id) WHERE message_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_topics_reap ON topics(state, closed_at);
```

`chat_id` is `TEXT` to match the existing `messages` table convention. The unique index is **partial** because the reservation protocol inserts rows with a NULL `message_thread_id`.

**Commit:** `feat(worker): add topics table`

### Task T2.2: `topics.ts` repo module

**Files:**
- Create: `packages/worker/src/topics.ts`
- Test: `packages/worker/test/worker.test.ts` (new describe block)

Pure D1 access, no Telegram calls — those come in T2.3. Functions: `getBySession`, `getByThread`, `reserve` (returns whether this caller won), `finalize`, `rename`, `markClosed`, `markOpen`, `deleteBySession`, `listReapable`.

Also here: the topic-name builder, tested independently.

```typescript
const MACHINE_ICON_COLORS: Record<string, number> = {
  devbox: 7322096,    // blue
  cloudbox: 9367192,  // green
};
const DEFAULT_ICON_COLOR = 16766590; // yellow

export function topicName(dirBasename: string, title: string): string {
  const full = `${dirBasename} · ${title}`;
  return full.length <= 128 ? full : full.slice(0, 127) + "…";
}
```

A **fixed map, not a hash** — with six allowed `icon_color` values a hash collides trivially between two machines.

**Commit:** `feat(worker): topics repo module`

### Task T2.3: Reservation protocol + `createForumTopic`

**Files:**
- Modify: `packages/worker/src/telegram.ts` (add `createForumTopic`, `editForumTopic`, `closeForumTopic`, `reopenForumTopic`, `deleteForumTopic`)
- Create: `packages/worker/src/topic-manager.ts`
- Test: `packages/worker/test/worker.test.ts`

**The race being defended against:** the Poller dispatch loop and the OutboxSender run on independent timers in the same daemon process, so two concurrent worker invocations for the same session can both miss the lookup and both call `createForumTopic`. `session_id` is the primary key, so the loser's write is dropped while its Telegram topic survives as an orphan with a notification stranded inside it.

**Test first:** two concurrent `resolveTopic()` calls for the same session produce exactly **one** `createForumTopic` call and both return the same `message_thread_id`.

Algorithm:

1. `INSERT OR IGNORE INTO topics (session_id, ..., message_thread_id) VALUES (..., NULL)`.
2. Winner (insert changed a row) calls `createForumTopic`, then `finalize`s the row.
3. Loser re-reads; if `message_thread_id` is still NULL, poll briefly (bounded — 5 tries, 100ms) then give up and fall back to General rather than hanging the request.
4. If the winner's `createForumTopic` fails, it must **delete its reservation row** so the next notification retries rather than being permanently stuck on a NULL thread.

**Commit:** `feat(worker): topic manager with create-reservation protocol`

### Task T2.4: `label` + `threaded` on the send payload

**Files:**
- Modify: `packages/worker/src/notifications.ts` (`SendNotificationBody`, `handleSendNotification`)
- Modify: `packages/daemon/src/worker/poller.ts` (`SendNotificationInput` from T1.6)
- Test: both suites

`threaded` defaults to **`true`** when absent so the outbox path needs no change; `/current-state` opts out explicitly in T2.11.

**Commit:** `feat: thread notifications into per-session topics`

### Task T2.5: Reopen-on-closed

Sessions resurrect via `/current-state` re-registration (`current-state-ingest.ts:96`), revive-on-reply (`docs/plans/2026-05-03-revive-on-reply-design.md`), and `opencode attach`. Without reopen, a revived session's notifications land in the collapsed "closed" section — invisible — or fail outright.

**Test:** resolving a topic with `state='closed'` calls `reopenForumTopic` and flips `state` to `open` before sending.

**Also settle empirically here:** whether an admin bot can post into a closed topic at all. Record the answer in the design doc.

**Commit:** `feat(worker): reopen closed topics on send`

### Task T2.6: Stale-thread recovery

If a topic is deleted by hand in Telegram, the next send fails. Detect `kind: "thread_not_found"`, delete the `topics` row, and recreate once. Guard against infinite recursion with a single retry.

**Commit:** `fix(worker): recreate topics deleted out of band`

### Task T2.7: Fallback rules

- Non-429 topic failure (revoked rights, forum mode off) → send to General with today's format. **Never drop a notification.**
- 429 anywhere → return 429 with `retryAfter`. **Never** fall back to General: that burns another call against the same exhausted budget and misplaces the message.

Two tests, one per branch.

**Commit:** `feat(worker): topic failure falls back to General, except rate limits`

### Task T2.8: Media passes `message_thread_id`

Media already lands in the right topic via `reply_to_message_id` (`notifications.ts:272-273`), so this is belt-and-braces. Add the parameter to `sendPhoto`/`sendDocument`.

**Commit:** `feat(worker): pass message_thread_id on media sends`

### Task T2.9: Close topic on unregister

**Files:** `packages/worker/src/sessions.ts:87-100`

Note `:98-99` already deletes the `sessions` row and its `messages`. **Do not delete the `topics` row** — the reaper needs it for 30 days. Mark `state='closed'`, set `closed_at`, best-effort `closeForumTopic`. Mark closed in D1 **even if the Telegram call fails**, so the reaper still collects it.

**Commit:** `feat(worker): close a session's topic on unregister`

### Task T2.10: Reap closed topics

**Files:** `packages/worker/src/index.ts:67-71` (existing hourly cron, `wrangler.toml:15-16`)

Delete topics with `state='closed' AND closed_at < now - 30d`. On a `deleteForumTopic` "not found" error, drop the row anyway. Cap deletions per run (e.g. 20) so one cron tick cannot blow the rate budget.

**Commit:** `feat(worker): reap topics closed over 30 days ago`

### Task T2.11: `/current-state` cards are unthreaded

**Files:** `packages/daemon/src/worker/current-state-ingest.ts:94-113`, `packages/daemon/src/index.ts:254-260`

**The blocker this fixes:** cards go through `poller.sendNotification(sid, …)` — the exact endpoint doing lazy topic creation — once per surveyed session, sequentially, uncapped. On a 15-session machine that is 1 index + 15 `createForumTopic` + 15 `sendMessage` ≈ 31 calls in one burst against a 20/min ceiling. It also creates topics for idle sessions that never notified, defeating lazy creation. Card failures are swallowed by `console.warn` at `:110-112` with no outbox and no retry, so anything past the limit is silently lost.

Send `threaded: false`.

**Test:** a `/current-state` run over 3 sessions produces **zero** `createForumTopic` calls.

**Follow-up worth raising with the user, not resolved here:** once the topic list exists it *is* the current-state view — sorted by activity, named, unread-badged. The per-session cards may be redundant and `/current-state` may collapse to the index alone.

**Commit:** `fix(daemon): /current-state cards do not create topics`

### Task T2.12: Inbound topic-membership resolution

**Files:** `packages/worker/src/webhook.ts` — `TelegramMessage` (`:122-134`), `resolveMessageSession` (`:319-357`)

`TelegramMessage` has neither `message_thread_id` nor `is_topic_message`; add both.

Precedence, highest fidelity first: callback query → explicit swipe-reply → **topic membership (new)** → `/cmd TOKEN`.

**The service-message guard.** Inside a topic, a plain message often arrives with `reply_to_message` pointing at the topic's own `ForumTopicCreated` service message, whose `message_id` equals the `message_thread_id`. Without a guard, every message in a topic is misread as a swipe-reply:

```typescript
const isTopicServiceReply =
  message.message_thread_id !== undefined &&
  message.reply_to_message?.message_id === message.message_thread_id;

if (message.reply_to_message && !isTopicServiceReply) {
  // ... existing swipe-reply lookup
}
```

**Tests:** (a) bare text in a topic resolves via `topics`; (b) a message whose `reply_to_message.message_id === message_thread_id` does **not** resolve via swipe-reply; (c) a genuine swipe-reply inside a topic still outranks topic membership.

**Known and accepted limitation to document in code:** topic membership carries no `notification_id`, so the metadata fallback at `packages/daemon/src/worker/command-ingest.ts:274-305` — which rescues question replies after the `pending_questions` row expires at 4h (`schema.ts:7`) — is unreachable for topic-routed messages. The common case still works because `command-ingest.ts:129` checks `pendingQuestions.getBySessionId` *before* consulting metadata. **For questions older than 4 hours, swipe-reply remains the only reliable answer path.**

**Commit:** `feat(worker): resolve inbound messages by forum topic membership`

### Task T2.13: `message_thread_id` round-trip on commands

**Files:** `packages/worker/src/d1-schema.sql` + test schema array, `packages/worker/src/d1-ops.ts:60-80` (`queueCommand`), `packages/worker/src/poll.ts`, `packages/daemon/src/worker/poller.ts` (command type), `packages/daemon/src/index.ts:80-99` (`sendTelegramMessage`) and its eleven call sites (`:126, 146, 161, 176, 191, 200, 210, 220, 228, 238, 261`)

**The problem:** `sendTelegramMessage` in the daemon is the **primary** reply path for `/kill`, `/interrupt`, `/compact`, `/mcp list`, `/model`, launch errors, and revive errors — not a break-glass fallback. Without this task, `/mcp list` typed in a topic sends the command from the topic and the result to General.

**The fix keeps the daemon ignorant of topics.** `ALTER TABLE commands ADD COLUMN message_thread_id INTEGER`; the worker populates it from the inbound message; it is returned on `GET /machines/:id/next`; the daemon's `sendTelegramReply` echoes it back. The daemon never reads the `topics` table.

**Commit:** `feat: carry message_thread_id through commands so daemon replies stay in-topic`

### Task T2.14: Webhook confirmations echo the thread

**Files:** `packages/worker/src/webhook.ts` — ~22 `sendTelegramMessage` call sites (`:401, 413, 459, 480, 486, 496, 502, 555, 562, 574, 581, 595, 609, 623, 637, 653, 669, 699, 701, 715, 724, 739`)

Thread the inbound `message_thread_id` through so "Killing session…" and "Could not find session for this message" land in the topic the user typed in. Mechanical, but **count the call sites** and verify none were missed.

**Commit:** `feat(worker): webhook confirmations reply in the originating topic`

### Task T2.15: Bare slash commands in a topic

**Files:** `packages/worker/src/webhook.ts:472-507` (`resolveReplySession`)

`/kill`, `/interrupt`, `/compact`, `/mcp *`, `/model *` currently hard-require a swipe-reply. In a topic, resolve from `message_thread_id` instead. Keep the `isMachineRecent` gate.

`/launch` and `/current-state` stay global and answer in General.

**Commit:** `feat(worker): slash commands resolve via topic without a reply`

### Task T2.16: `TELEGRAM_TOPICS_ENABLED` flag

**Files:** `packages/worker/src/types.ts` (`Env`), `packages/worker/wrangler.toml`, `packages/worker/src/notifications.ts`, `packages/worker/src/webhook.ts`

When off: skip all topic resolution and all topic-membership inbound routing — behavior byte-identical to Phase 1. **Test both branches**; this flag is the rollback mechanism.

**Commit:** `feat(worker): TELEGRAM_TOPICS_ENABLED flag`

### Task T2.17: Migration runbook

**Files:** Create `docs/runbooks/telegram-forum-migration.md`; update `.opencode/skills/worker-deployment/SKILL.md` and `AGENTS.md`

Document the manual setup (create supergroup → enable Topics → add bot → promote with `can_manage_topics`, `can_delete_messages`, `can_pin_messages`; admin status also bypasses privacy mode, so no BotFather change is needed), the D1 `ALTER`/`CREATE` statements to run against production, the staged rollout, and the rollback.

**Commit:** `docs: Telegram forum migration runbook`

### Checkpoint 2

1. `npm run test && npm run typecheck`
2. Adversarial review of the full Phase 2 diff.
3. Execute the runbook:
   - deploy with `TELEGRAM_TOPICS_ENABLED` **off**; confirm no behavior change
   - apply the D1 schema changes to production
   - create the supergroup and add its id to `ALLOWED_CHAT_IDS` **alongside** `8248645256`, so in-flight notifications to the old DM do not start 403ing mid-flight
   - flip the flag; update the `TELEGRAM_CHAT_ID` sops secret per machine; restart daemons
   - burn in per `daemon-cutover-burnin`, **watching worker logs for 429 frequency**
   - after burn-in, drop the old chat id

**Deferred item with an explicit trigger:** the design defers a chat-level `next_send_at` gate in D1. If 429s appear on more than a handful of days during burn-in, build it. Record the observed 429 rate in the design doc either way.

---

## Out of scope (YAGNI)

Slack; a proactive chat-level rate gate (deferred, trigger above); per-machine supergroups; any change to the swarm IPC path.
