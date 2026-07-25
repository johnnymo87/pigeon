# Telegram Forum Topics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move Pigeon from a single Telegram DM to a forum supergroup where each opencode session gets its own topic, named from its TUI session title.

**Architecture:** Three phases that ship independently. Phase 0 plumbs the real session title from the opencode plugin through the daemon into notification headers. Phase 1 fixes two verified outbox correctness bugs and extracts a central Telegram client — both prerequisites for threading, both valuable alone. Phase 2 adds a worker-owned topic manager, topic-membership inbound routing, and the chat migration. Phases 0 and 1 ship dark with zero user-visible migration.

**Tech Stack:** TypeScript, vitest everywhere. Worker: Cloudflare Workers + D1, tested via `cloudflare:test` (miniflare) with real D1 and `fetchMock` for Telegram. Daemon: Node + `better-sqlite3`. Plugin: `@opencode-ai/plugin`.

**Design doc:** `docs/plans/2026-07-25-telegram-forum-topics-design.md` (**revision 3**). Read it before starting any phase — it carries the rationale, the verified-bug evidence, and the deferred decisions.

**Review history:** this plan is post-second-adversarial-review. Findings from that review are marked **[rev2-plan]** where they changed a task, so a future reviewer can see what was already litigated.

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

**Test-helper idioms** (the sketches below are illustrative; these are the real ones):

- Daemon storage tests: `createStorage()`, not `createTestStorage()` — see `packages/daemon/test/storage.test.ts:4`.
- Daemon app tests: `await app(new Request(url, {...}))`, **not** supertest — see `packages/daemon/test/app.test.ts:45`.
- `OutboxSender` takes an injected `nowFn` (`outbox-sender.ts:27,53`), so time-dependent tests need **no fake timers**; drive a mutable `now` variable as `outbox-sender.test.ts:39` already does.

---

## Progress Tracker

### Phase 0 — Session titles (ships dark)

- [x] T0.1 Daemon: `title` column + storage plumbing — `3a595e1`, `f1938da`
- [x] T0.2 Daemon: `/session-start` accepts `title` (incl. don't-clobber semantics) — `7453e41`, `b7add26`
- [x] T0.3 Daemon: `displayName()` replaces **8** duplicated precedence expressions — `f5f68ed`, `c52ece9`
- [x] T0.4 Plugin: capture title from `session.get()` at registration — `3eeba51`
- [x] T0.5 Plugin: `session.updated` handler keeps the title fresh — `43ac380`, `2fd9a56`
- [x] T0.6 Plugin + daemon: `/stop` and `/question-asked` carry `title` — `83936bd`, `2f58b9e`
- [~] **Checkpoint 0** — test gate ✅ (daemon 610+1, plugin 275, worker 163; typecheck clean modulo the 2 known `lease-cas-concurrency` files). Merged to `main` + pushed ✅. **cloudbox daemon deployed + verified ✅** (see below). **Remaining: plugin side needs a serve-pool restart, then observe a real title in Telegram. devbox not yet deployed.**

### Phase 1 — Outbox correctness + Telegram client (ships dark)

- [ ] T1.0 Plugin: extract the 4× duplicated `registerSession` block *(added during Phase 0; see the trap note — the helper must NOT await)*
- [ ] T1.0b Daemon: fix `splitTelegramMessage`'s `maxBody <= 0` hole *(found by Phase 0 adversarial review)* — when header+footer overhead alone exceeds 4096, `split-message.ts:29-31` falls into the single-message branch and sends the oversized text anyway → Telegram 400 → worker 502 → outbox retries then `markFailed` → **notification permanently lost**. Phase 0 clamped titles to 200 chars, which removes the new trigger, but the underlying hole predates this work and belongs to this outbox-correctness phase.
- [ ] T1.0c Daemon: narrow the additive-migration `catch` *(found by Phase 0 adversarial review)* — `schema.ts:117-123` swallows **every** error from every additive statement, not just duplicate-column. A real `ALTER TABLE` failure (disk full, a `sqlite3` shell holding a write txn past the 5s busy timeout, corruption) starts the daemon cleanly and then fails every `/session-start` and most `/stop`s with the root cause already discarded. Rethrow unless the message matches `/duplicate column/i`. Touches nine pre-existing statements, so it needs its own test pass.
- [ ] T1.0d Daemon: expose `title` in the legacy `/sessions` JSON — absent from `toLegacySession` (`app.ts:30-67`); Phase 2 will want it.
- [ ] T1.1 Daemon: per-chunk idempotency keys in `OutboxSender`
- [ ] T1.2 Worker: `q:` notification-id parsing strips the chunk suffix
- [ ] T1.3 Worker: extract a central Telegram client module
- [ ] T1.4 Worker: map `rate_limited` to a 429 response
- [ ] T1.5 Daemon: global outbox pause on `retry_after` + `FallbackNotifier` skip
- [ ] T1.6 Daemon: convert `poller.sendNotification` to an options object
- [ ] **Checkpoint 1** — full test + typecheck, deploy, adversarial review of the Phase 0+1 diff

### Phase 2 — Topics

*Outbound:*

- [ ] T2.1 Worker: `topics` table (schema file + test schema array)
- [ ] T2.2 Worker: `TELEGRAM_TOPICS_ENABLED` flag **(built before anything reads it)**
- [ ] T2.3 Worker: `topics.ts` repo module + `topicName(dir, title)`
- [ ] T2.4 Worker: forum methods + topic manager with reservation protocol
- [ ] T2.5 Daemon + worker: `title`/`dir`/`threaded` end-to-end **through the outbox**
- [ ] T2.6 Worker: reopen-on-closed
- [ ] T2.7 Worker: stale-thread recovery
- [ ] T2.8 Worker: non-429 fallback to General, 429 propagates
- [ ] T2.9 Worker: media sends pass `message_thread_id`
- [ ] **Checkpoint 2a** — outbound complete; flag-off byte-equivalence; deploy dark

*Lifecycle + inbound:*

- [ ] T2.10 Worker: close topic on session unregister
- [ ] T2.11 Worker: cron reaps closed topics **and closes orphaned ones**
- [ ] T2.12 Daemon: `/current-state` cards send `threaded: false`
- [ ] T2.13 Worker: inbound topic-membership resolution + service-message guard
- [ ] T2.14 Worker + daemon: `message_thread_id` round-trip on commands
- [ ] **Checkpoint 2b** — inbound + round-trip verified across all command types

*Polish + migration:*

- [ ] T2.15 Worker: webhook confirmations echo `message_thread_id`
- [ ] T2.16 Worker: bare slash commands resolve via topic
- [ ] T2.17 Docs: migration runbook + skill updates
- [ ] **Checkpoint 2** — adversarial review, then execute the runbook (**DDL before deploy**)

---

## Phase 0 — Session titles

**Why first:** "can't tell which session a message came from" is the sharpest of the four reported pains, and this fixes it at ~5% of the cost of topics. It also produces the `title` that Phase 2 uses for topic names.

**Current state:** the human-readable name Pigeon shows is the directory basename, minted once at `packages/opencode-plugin/src/index.ts:209`. The real TUI title sits unused in a call the plugin already makes (`index.ts:228`, `.data.title` discarded).

**Exit criteria:** a stop notification header reads `🤖 **Stop**: Fix flaky auth test` instead of `🤖 **Stop**: pigeon`.

### Task T0.1: Daemon `title` column + storage plumbing

**Files:**
- Modify: `packages/daemon/src/storage/schema.ts:103-113` (additive migration list)
- Modify: `packages/daemon/src/storage/types.ts` (`SessionRecord`, `UpsertSessionInput`)
- Modify: `packages/daemon/src/storage/repos.ts` (`asSession` `:23-44`, upsert SQL `:83-125`)
- Test: `packages/daemon/test/storage.test.ts`

**Step 1: Write the failing test**

```typescript
it("persists and returns session title", () => {
  const storage = createStorage(":memory:");   // match the helper used at storage.test.ts:4
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
  const storage = createStorage(":memory:");
  storage.sessions.upsert({ sessionId: "ses_notitle", cwd: "/tmp", notify: true });
  expect(storage.sessions.get("ses_notitle")?.title).toBeNull();
});
```

**Step 2: Run test to verify it fails**

Run: `npm run --workspace @pigeon/daemon test -- storage`
Expected: FAIL — `title` is not a known property on `UpsertSessionInput`.

**Step 3: Implement**

`schema.ts` — append to the `additiveColumns` array:

```typescript
"ALTER TABLE sessions ADD COLUMN title TEXT DEFAULT NULL",
```

`storage/types.ts` — add `title: string | null;` to `SessionRecord` and `title?: string | null;` to `UpsertSessionInput`.

`storage/repos.ts` — add `title: row.title ?? null` to `asSession()`, add the column to the INSERT list, and add `title = excluded.title` to the ON CONFLICT clause.

> **[rev2-plan] Correction.** An earlier draft of this task said to "follow the existing COALESCE-style existing-value-fallback idiom for `label`" in `repos.ts`. **No such idiom exists there** — `repos.ts:94` is a bare `label = excluded.label`, and the don't-clobber logic lives caller-side at `app.ts:236`. Do the same for `title`: the repo overwrites unconditionally, and **T0.2 owns the don't-clobber semantics and its test.** Do not invent a COALESCE here; it would diverge this column from every other one.

**Step 4: Run test to verify it passes**

Run: `npm run --workspace @pigeon/daemon test -- storage`, then the full daemon suite — the upsert SQL is shared by many tests.

**Step 5: Commit**

```bash
git add packages/daemon/src/storage packages/daemon/test/storage.test.ts
git commit -m "feat(daemon): store opencode session title alongside label"
```

### Task T0.2: Daemon `/session-start` accepts `title`

**Files:**
- Modify: `packages/daemon/src/app.ts:218-262` (the `/session-start` handler; the upsert at `:229-255`)
- Test: `packages/daemon/test/app.test.ts`

**Step 1: Write the failing test** (note the real request idiom — `app(new Request(...))`, not supertest):

```typescript
it("stores title from /session-start", async () => {
  const res = await app(new Request("http://d/session-start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: "ses_t2", notify: true,
      cwd: "/home/dev/projects/pigeon", label: "pigeon",
      title: "Fix flaky auth test",
    }),
  }));
  expect(res.status).toBe(200);
  expect(storage.sessions.get("ses_t2")?.title).toBe("Fix flaky auth test");
});

it("does not clobber a stored title when /session-start omits it", async () => {
  // register with a title, then re-register without one (the real sequence:
  // session.updated sets a title, then a late re-registration omits it)
  // assert the title survives
});
```

The second test is the one that matters — it is the behavior T0.1 deliberately did not implement.

**Step 2: Run to verify it fails.** Expected: first test gives `null`; second gives `null` after re-registration.

**Step 3: Implement.** In the upsert, add `title` using the *same* expression shape as `label` at `app.ts:236`:

```typescript
title: (typeof body.title === "string" && body.title !== "" ? body.title : undefined) ?? existing?.title,
```

**Step 4: Run.** `npm run --workspace @pigeon/daemon test -- app`

**Step 5: Commit**

```bash
git commit -am "feat(daemon): accept title on /session-start without clobbering"
```

### Task T0.3: `displayName()` replaces 8 duplicated precedence expressions

**Files:**
- Modify: `packages/daemon/src/notification-service.ts` — add helper; widen `SessionLike` (`:18-22`); use at `:427`, `:473`, `:556`, `:625`
- Modify: `packages/daemon/src/app.ts` — use at `:377`, `:474`, `:491`
- Modify: `packages/daemon/src/worker/command-ingest.ts:184` — **the 8th site**
- Test: `packages/daemon/test/notification-service.test.ts`

**Why a helper:** the expression is currently duplicated **eight** times across three files. Adding a third input to eight copies is how bugs are born. DRY it first.

> **[rev2-plan] Two additions a prior draft missed.**
>
> 1. **`command-ingest.ts:184`** is `session.label || session.sessionId.slice(0, 8)` and it names the **wizard's subsequent steps**. Miss it and a multi-question wizard shows the title on step 1 and the directory basename on steps 2+.
> 2. **`SessionLike` (`notification-service.ts:18-22`) has no `title` field** — it is `{ sessionId, label, cwd }`. The four `notification-service.ts` replacements cannot receive a title until this type is widened, and every construction site of a `SessionLike` must then supply it. Because `title` will be optional, **the compiler will not catch a missed site** — it will silently keep showing basenames. Grep for every `SessionLike` construction and fix each.

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

Then replace all eight call sites. `app.ts:377` currently reads `label || session.label || sessionId.slice(0,8)`; it becomes `displayName({ title: session.title, label: label || session.label, sessionId })` — the request-supplied `label` still wins over the stored one.

**Step 4: Run the full daemon suite.** Formatter assertions will change — inspect each diff and confirm it is the intended title change, not an accident.

**Step 5: Commit**

```bash
git commit -am "refactor(daemon): extract displayName(), prefer session title in notifications"
```

### Task T0.4: Plugin captures title at registration

**Files:**
- Modify: `packages/opencode-plugin/src/index.ts:228-247` (`lateDiscoverSession`), `:313-353` (`session.created`)
- Modify: `packages/opencode-plugin/src/daemon-client.ts:113-130` (`registerSession` body)
- Test: `packages/opencode-plugin/test/daemon-client.test.ts`

**Step 1: Write the failing test** asserting `registerSession({ ..., title: "Fix auth" })` puts `title` in the POST body and omits the key entirely when undefined (mirror how `label` is handled).

**Step 2: Run to verify it fails.**

**Step 3: Implement.**
- `daemon-client.ts`: add `title?: string` to the options type and `...(title ? { title } : {})` to the body.
- `index.ts:228-231`: `session.get()` already runs — capture `session.data?.title` and pass it to the `registerSession` call at `:234`. The `catch` fallback at `:259-286` has no session object, so it passes no title.
- `index.ts:314-318` (`session.created`): `sessionInfo.title` is already declared in the local narrowing type but unused — pass it at `:329`.

**Caveat to encode as a code comment:** `session.created` fires *before* opencode generates the title, so this value is usually a placeholder. T0.5 is what makes it correct. Do not delete T0.5 as redundant.

**Step 4: Run.** `npm run --workspace @pigeon/opencode-plugin test`

**Step 5: Commit**

```bash
git commit -am "feat(plugin): send opencode session title on registration"
```

### Task T0.5: Plugin `session.updated` handler

**Files:**
- Modify: `packages/opencode-plugin/src/index.ts` (event dispatcher, `:307-627`)
- Modify: `packages/opencode-plugin/src/session-state.ts` (hold the title — see below)
- Test: new `packages/opencode-plugin/test/session-title.test.ts`

**Verified prerequisite:** `EventSessionUpdated` is a member of the SDK `Event` union (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:499-504`, union at `:602`) and the plugin `event` hook receives the full union (`node_modules/@opencode-ai/plugin/dist/index.d.ts:109-110`). These events do reach plugins.

> **[rev2-plan] Where the title lives matters.** T0.6 needs to read the *current* title at notify time, from a different handler. Do **not** keep it in a `Map` private to this handler's closure — store it on `sessionManager` (`session-state.ts`) with `setTitle(sessionID, title)` / `getTitle(sessionID)`. T0.6 depends on this.

**Step 1: Write the failing test.** Assert that dispatching `session.updated` with a title different from the last-seen one triggers exactly one `registerSession` call, and dispatching the *same* title again triggers none. The debounce is required: opencode emits `session.updated` frequently for reasons unrelated to the title.

> **[T0.4 carry-over] Two items this task should absorb.**
>
> 1. **The `index.ts` registration wiring is untested.** T0.4's tests cover
>    `daemon-client.registerSession` in isolation, and the plugin has **no `index.ts`-level
>    test harness at all** — so nothing verifies that the three `registerSession` call sites
>    actually pass a title. Wiring that read the wrong property would still be green. Both
>    reviewers judged `session-title.test.ts` (this task's new file) the right home: it needs
>    an event-dispatch harness anyway, so extend it to also cover `session.created` and the
>    `lateDiscoverSession` try/catch paths.
> 2. **Rephrase the T0.4 caveat comment** at `packages/opencode-plugin/src/index.ts:331`.
>    It currently says "Task T0.5 handles updating/refreshing titles" — a plan-task ID that
>    means nothing to a future reader once this plan is history. Describe the lifecycle
>    instead: the title is refreshed on subsequent `session.updated` events.

**Step 2: Run to verify it fails.**

**Step 3: Implement.** A handler that:
- reads `props.info` as `{ id?: string; title?: string; parentID?: string }`
- ignores child sessions (`parentID` set) and sessions `sessionManager` does not know
- returns early if `sessionManager.getTitle(id) === title`
- otherwise `setTitle` and call the existing `registerSession` (the daemon upsert is idempotent, so no new endpoint is needed)

**Step 4: Run.** New test plus the full plugin suite.

**Step 5: Commit**

```bash
git commit -m "feat(plugin): refresh session title on session.updated"
```

### Task T0.6: `/stop` and `/question-asked` carry `title`

**Files:**
- Modify: `packages/opencode-plugin/src/daemon-client.ts:158-169` (`notifyStop`), `:195-205` (`notifyQuestionAsked`), `:257-267` (`sendQuestionAsked`)
- Modify: `packages/opencode-plugin/src/index.ts` — **every** notify call site: `:396-405` (session.idle), `:490-498` (session.error), `:561-568` (stop-flush before a question), `:597-606` (retry), plus the question paths around `:541-546`
- Modify: `packages/daemon/src/app.ts:326-404` (`/stop`), `:406-519` (`/question-asked`)
- Test: `packages/opencode-plugin/test/daemon-client.test.ts`, `packages/daemon/test/app.test.ts`

**Why:** registration-time title is stale — a session registers once but notifies many times. Carrying `title` per notification is what makes the header, and later the topic name, track the live title.

> **[rev2-plan] The mechanism must be named, not implied.** Those call sites currently pass the module-scope `label` closure from `index.ts:209`. They must additionally pass `sessionManager.getTitle(sessionID)` (from T0.5). A prior draft listed only `daemon-client.ts` and `app.ts` and would have shipped a `title` field that was always `undefined` on the notification path.

> **[T0.3 carry-over] Fix the `/stop` log line while you are in this handler.** `app.ts:403` logs
> `` label=${label || session.label} `` — a 2-tier expression with no session-id fallback, so T0.3
> correctly left it out of the eight display sites. But it now *disagrees* with what the user sees:
> the log records the directory basename while Telegram renders the title. That makes
> "why did this notification say X" harder to debug, and Phase 2 will make it worse (topic
> names derive from the same title). Switch it to `displayName(...)` so logs match display.

**Steps:** standard TDD shape. Plugin sends `title` alongside the existing `label`. The daemon handlers feed it to `displayName()` with request-supplied values winning over stored ones, **and persist it back to the `sessions` row** so `/current-state` and Phase 2 topic naming see it too.

**Commit:**

```bash
git commit -am "feat: carry session title on stop and question notifications"
```

### Checkpoint 0

```bash
npm run test && npm run typecheck
```

Green (modulo the two pre-existing daemon typecheck files). Deploy per the `cross-device-deployment` skill.

> **⚠️ VERIFY WITH A NEWLY LAUNCHED SESSION, NOT AN EXISTING ONE.** An adversarial review caught
> this: **the plugin is loaded into each opencode process at startup**, so restarting the *daemon*
> does not reload it. Every already-running session keeps the old in-memory plugin — no
> `session.updated` handler, no `title` in its `/stop` bodies — and its `sessions` row stays
> `title = NULL` forever. Checking an existing session therefore shows the directory basename
> indefinitely, **which looks exactly like the feature being broken**. Verify with a session
> started *after* the restart (`/launch cloudbox pigeon "..."` or a fresh TUI session).
> Existing sessions pick the feature up only as their opencode processes restart (the nightly
> workspace reset finishes the job).
>
> **And "fresh session" is not sufficient on its own — the serve process must be new too.**
> The plugin is a Node module, loaded once per *process*. On cloudbox `opencode-serve` is a
> **pool** (`opencode-serve@4096..4099.service`) behind `opencode-frontdoor` on port 4700, and
> those are long-lived. A brand-new session that lands on an unrestarted pool instance still
> executes the **old** plugin module and still sends no title. So end-to-end verification needs
> the pool instance hosting the new session to have been restarted after the merge — not just
> the daemon.
>
> Restarting the whole pool disrupts every live session on the machine (including whichever one
> is driving the deploy), so the zero-risk alternative is to let the **nightly workspace reset**
> restart everything and verify the next morning.

Then confirm in Telegram that stop notifications show real session titles, **on the second or
later notification of that fresh session** (that is what proves T0.5+T0.6, not just T0.4).

**Also check the migration actually applied** — `schema.ts`'s additive loop swallows *every*
error, not just "duplicate column", so a genuinely failed `ALTER TABLE` would start cleanly and
then fail every `/session-start` with `no such column: title`:

```bash
sqlite3 <daemon-db-path> "PRAGMA table_info(sessions);" | grep title
```

**Deploy-sequence cautions:**

- **`git status` the live checkout before merging.** Other sessions share that worktree; merging
  over a dirty tree is how the previous data-loss incident started.
- **Restart while your own session is idle.** A failed `notifyStop` during the restart opens the
  plugin's circuit breaker for 30s (`daemon-client.ts:66-101`) and `notifyStop` has no retry
  queue, so stop notifications in the restart window +30s are silently dropped. Question
  notifications are safe (2-minute retry queue).
- **devbox stays on the old daemon/plugin** until deployed separately. That skew is safe — an old
  daemon simply never reads the `title` field — but expect basename-style names from devbox
  sessions in the same chat until then.

**Do not proceed to Phase 1 until you have seen a real title in a real notification** — Phase 2's topic names depend entirely on this.

#### Deploy log — cloudbox daemon, 2026-07-25 11:51 EDT ✅

`sudo systemctl restart pigeon-daemon.service` on `main` @ `cd8c93b`. Verified:

- Clean start: ingress router (serves=4), swarm arbiter, delivery watchdog, listening on 4731.
  No migration errors, no `no such column`. (`status=143` on stop is just SIGTERM.)
- **Migration applied:** `title` present as cid 19, `TEXT`, nullable, default `NULL`.
  331 pre-existing session rows, all `title` NULL — correct, since no new plugin has run yet.
- `/sessions` and `/swarm/send` both respond normally, exercising `asSession()` over all
  331 real rows.
- **The old-plugin → new-daemon skew case is confirmed live:** running sessions have no stored
  title, so `displayName` falls through to the directory basename and notifications are
  byte-identical to before. Phase 0 is genuinely dark on the daemon alone.
- Incidentally confirmed **T1.0d**: `title` is absent from the legacy `/sessions` JSON.

**Still outstanding for Checkpoint 0:** every opencode process still holds the *old* plugin, so
nothing writes a title yet. Needs a serve-pool restart (or the nightly workspace reset), then a
fresh session, then confirm a real title on its **second or later** notification. devbox is still
on the old daemon+plugin — safe skew, just basename-style names from there meanwhile.

---

## Phase 1 — Outbox correctness + Telegram client

**Why before topics:** T1.1 fixes a bug that a 20 msg/min supergroup ceiling would promote from rare to routine, and T1.3/T1.6 are the refactors that make threading expressible. All ship dark.

> **[rev2-plan] Ordering changed.** The Telegram client extraction (T1.3) now comes **before** the 429 handling (T1.4). The reverse order has you hand-roll 429 classification inline in `notifications.ts`, then immediately subsume it into the extracted client's classifier — guaranteed churn.

### Task T1.0 *(added during Phase 0)*: Extract the plugin's `registerSession` block

**Files:** `packages/opencode-plugin/src/index.ts`

By the end of Phase 0 there are **four** near-identical ~25-line `registerSession(...)`
invocations in `index.ts`: `lateDiscoverSession` try (`~:235`), `lateDiscoverSession` catch
(`~:265`), `session.created` (`~:335`), and `session.updated` (`~:387`, added by T0.5). Each
builds the same 12-field option set, chains the same `.then(onRegistered)`/`.catch(log)`, and
calls `setRegistrationPromise`. Three copies predate Phase 0; T0.5 added the fourth. This is
the same argument that justified extracting `displayName()` in T0.3.

**Deferred out of Phase 0 deliberately.** Checkpoint 0 has to validate the registration path
in production, and churning that path immediately beforehand defeats the checkpoint. Phase 1
is the refactor phase.

> **Trap — the obvious extraction is wrong.** A code reviewer proposed a helper ending in
> `await regPromise`, called as `await doRegisterSession(...)`. **Do not do that.** None of the
> four sites currently awaits `regPromise`; they fire-and-forget and hand the promise to
> `sessionManager.setRegistrationPromise` so that *later* handlers can
> `await sessionManager.awaitRegistration(sessionID)` (`index.ts:427`, `:528`, `:588`, `:645`).
> Awaiting inside the helper would block the event dispatcher on a daemon round-trip at every
> registration. The helper must stay fire-and-forget and return `void`.

Also note the four blocks are *not* byte-identical: the `lateDiscoverSession` catch path
passes no `title` (it has no session object), so the helper needs an optional `title`
parameter. The four integration tests added by T0.5 in
`packages/opencode-plugin/test/session-title.test.ts` drive all four paths and are the safety
net for this refactor.

### Task T1.1: Per-chunk idempotency keys

**Files:**
- Modify: `packages/daemon/src/worker/outbox-sender.ts:136-173`
- Test: `packages/daemon/test/outbox-sender.test.ts`

**The verified bug:** `OutboxSender` sends chunks in a loop; on any chunk failing it `break`s and marks the *whole entry* for retry (`:152-163`). On retry the loop restarts at `i=0`. Only the last chunk carries `notificationId` (`:148`), and worker dedup keys on it (`packages/worker/src/notifications.ts:197-205`). So chunks before the failure are re-sent with no idempotency key → duplicate Telegram messages → more traffic into an already-throttled chat.

**Step 1: Write the failing test** — name it `"gives every chunk a stable idempotency key so the worker can dedup retries"`. (The daemon *does* re-send on retry; the fix is that the worker can now suppress it. Do not name the test as though the daemon stops re-sending.)

```typescript
it("gives every chunk a stable idempotency key so the worker can dedup retries", async () => {
  const ids: Array<string | undefined> = [];
  let failChunk2 = true;
  const sendNotification = vi.fn(async (input) => {
    ids.push(input.notificationId);
    if (failChunk2 && input.text === "chunk-2") { failChunk2 = false; return { ok: false }; }
    return { ok: true };
  });
  // enqueue a 3-chunk entry; processOnce(); advance `now` past the backoff; processOnce()
  expect(ids.every(id => id !== undefined)).toBe(true);
  // chunk 0's id is identical on both attempts
  expect(ids[0]).toBe(ids[2]);
});
```

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

**Why `#` and not `:`:** notification ids are `:`-delimited (`q:{sessionId}:{requestId}`) and *both* worker parsers split on `:` — `webhook.ts:336-339` and `resolveCallbackSession` at `:374`. A `#` suffix cannot be mistaken for a delimiter.

**Step 4: Run.** `npm run --workspace @pigeon/daemon test -- outbox`

**Step 5: Commit**

```bash
git commit -am "fix(daemon): per-chunk idempotency keys so outbox retries can be deduped"
```

### Task T1.2: Worker `q:` parsing strips the chunk suffix

**Files:**
- Modify: `packages/worker/src/webhook.ts:334-340`
- Test: `packages/worker/test/worker.test.ts`

**The bug this prevents:** line 338 is `parts.slice(2).join(":")`. For a chunk id `q:ses_x:req123#c0` that yields `req123#c0` — a request id matching nothing, so the swipe-reply silently fails to answer the question.

> **[rev2-plan] This is prophylaxis, not a live bug.** Question notifications are currently enqueued as a single message (`app.ts:498` does not split), so no `q:…#c0` id exists in production today. Ship it anyway — T2.x makes question bodies longer, and a latent silent-failure in the question path is not worth leaving armed.

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

**Step 3: Implement**

```typescript
result.questionRequestId = parts.slice(2).join(":").replace(/#c\d+$/, "");
```

**Step 4: Run.** `npm run --workspace @pigeon/worker test`

**Step 5: Commit**

```bash
git commit -am "fix(worker): strip chunk suffix when parsing question notification ids"
```

### Task T1.3: Extract a central Telegram client in the worker

**Files:**
- Create: `packages/worker/src/telegram.ts`
- Modify: `packages/worker/src/notifications.ts` (4 call sites: `:135`, `:154`, `:229`, `:341`)
- Modify: `packages/worker/src/webhook.ts` (`sendTelegramMessage` `:282-292`, `answerCallbackQuery` `:297-307`, `getFile` `:240-247`, file download `:258-259`)
- Test: `packages/worker/test/worker.test.ts`

**Why:** six inline `fetch` calls against a template-literal URL, with three duplicate `sendMessage` implementations. Phase 2 adds five forum methods and a `message_thread_id` parameter to most sends. That is not expressible until this is one module.

**Design of the module.** Every method returns a discriminated result so callers can distinguish rate limits from permanent failures — Phase 2's fallback rule (T2.8) depends on this:

```typescript
export type TgResult<T> =
  | { ok: true; result: T }
  | { ok: false; kind: "rate_limited"; retryAfter: number }
  | { ok: false; kind: "thread_not_found" }
  | { ok: false; kind: "error"; errorCode?: number; description?: string };
```

`thread_not_found` is classified by matching Telegram's description for a missing `message_thread_id`. **The exact string is unverified** — leave the branch in place but treat an unmatched 400 as `kind: "error"`, and pin the real string empirically in T2.7.

**Step 1: Write the failing tests** for the classifier — a 429 with `parameters.retry_after`, a plain 400, and a success — driving `sendMessage` through `fetchMock`.

**Step 2: Run to verify they fail.** Expected: module does not exist.

**Step 3: Implement** `telegram.ts` with `sendMessage`, `editMessageText`, `sendPhoto`, `sendDocument`, `answerCallbackQuery`, `getFile`. Forum methods come in T2.4. Then refactor every call site.

**This is a pure refactor.** The existing worker suite must pass **unchanged**. If an existing test needs editing, stop — you have changed behavior.

**Step 4: Run.** `npm run --workspace @pigeon/worker test && npm run --workspace @pigeon/worker typecheck`

**Step 5: Commit**

```bash
git commit -am "refactor(worker): extract a central Telegram client module"
```

### Task T1.4: Map `rate_limited` to a 429 response

**Files:**
- Modify: `packages/worker/src/notifications.ts:244-249`
- Test: `packages/worker/test/worker.test.ts`

Now trivial, because T1.3 already classifies. Where the generic 502 is returned:

```typescript
if (!res.ok && res.kind === "rate_limited") {
  return json({ error: "rate_limited", retryAfter: res.retryAfter }, 429);
}
```

**Test:** stub `sendMessage` via `fetchMock` to return `{ ok: false, error_code: 429, parameters: { retry_after: 17 } }`; assert **429** with `{ error: "rate_limited", retryAfter: 17 }`, not the current 502.

**Commit:** `feat(worker): surface Telegram rate limits as a 429 response`

### Task T1.5: Global outbox pause + `FallbackNotifier` skip

**Files:**
- Modify: `packages/daemon/src/worker/poller.ts:297-327` (`sendNotification` returns `retryAfter`)
- Modify: `packages/daemon/src/worker/outbox-sender.ts` (`SendNotificationFn` type, `processOnce`)
- Modify: `packages/daemon/src/notification-service.ts:645-680` (`FallbackNotifier`), `:61-70` (`WorkerNotificationSender`)
- Test: `packages/daemon/test/outbox-sender.test.ts`, `packages/daemon/test/poller.test.ts`, `packages/daemon/test/notification-service.test.ts`

**Two gaps, one task** (they share the `retryAfter` plumbing):

1. Today a `retry_after` reschedules one entry while the other four in the batch keep firing at the same throttled chat.
2. **[rev2-plan]** `FallbackNotifier` (`index.ts:334`, `notification-service.ts:651-657`) catches *any* worker-send failure and re-sends **directly to Telegram**. Once the worker starts returning 429, that is precisely the behavior the design forbids — burning another call on an exhausted budget, on the same chat. Volume here is low (watchdog, `/alert`), but it is the same rule.

**Step 1: Write the failing tests**

```typescript
it("pauses the whole outbox when a send reports retryAfter", async () => {
  // 3 queued entries; first send returns { ok: false, retryAfter: 30 }
  await sender.processOnce();
  expect(sendNotification).toHaveBeenCalledTimes(1); // not 3
  now += 29_000; await sender.processOnce();
  expect(sendNotification).toHaveBeenCalledTimes(1); // still paused
  now += 2_000;  await sender.processOnce();
  expect(sendNotification).toHaveBeenCalledTimes(2); // resumed
});

it("does not fall back to direct Telegram on a rate limit", async () => {
  // worker sender returns { ok: false, retryAfter: 30 }
  // assert the direct Telegram notifier was NOT called
});
```

No fake timers needed — `OutboxSender` takes an injected `nowFn` (`outbox-sender.ts:27,53`).

**Step 2: Run to verify they fail.** Expected: 3 calls on the first `processOnce`; fallback fires on the 429.

**Step 3: Implement.**
- `poller.sendNotification`: on 429, read `retryAfter` from the JSON body; return `{ ok: false, retryAfter }`.
- `SendNotificationFn` return type → `Promise<{ ok: boolean; retryAfter?: number }>`.
- `OutboxSender` gains `private pausedUntil = 0`; `processOnce` returns early if `now < pausedUntil`; on a `retryAfter` result set `pausedUntil = now + retryAfter * 1000`, mark the entry for retry, and `break`.
- `FallbackNotifier`: skip the direct-Telegram path when the worker result carries `retryAfter`.

**Step 4: Run.** Daemon suite.

**Step 5: Commit**

```bash
git commit -am "feat(daemon): pause the outbox on retry_after and never fall back on a rate limit"
```

### Task T1.6: `poller.sendNotification` takes an options object

**Files:**
- Modify: `packages/daemon/src/worker/poller.ts:297-327`
- Modify: `packages/daemon/src/worker/outbox-sender.ts` (`SendNotificationFn`, call at `:142-150`)
- Modify: `packages/daemon/src/notification-service.ts:61-70`
- Modify: `packages/daemon/src/index.ts:272-280` (the `sendNotification` closure) and `:254-260`
- Test: `packages/daemon/test/poller.test.ts` and any test constructing a `SendNotificationFn`

**Why:** the signature is already seven positional parameters, three optional. T2.5 adds `title`, `dir`, and `threaded`. Ten positional parameters with an `undefined, undefined` gap in the middle is how the wrong argument lands in the wrong slot.

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

> **[rev2-plan] Fix a pre-existing bug while you are here.** The closure at `index.ts:275-276` passes only **six** of the seven positional arguments, so `entities` is **silently dropped** on that path today. Do not faithfully preserve that. Converting to an options object fixes it structurally — add a test asserting `entities` survives, so the fix is pinned rather than incidental.

Otherwise a pure refactor: the rest of the suite must pass unchanged.

**Commit:** `refactor(daemon): sendNotification takes an options object (fixes dropped entities)`

### Checkpoint 1

```bash
npm run test && npm run typecheck
```

Deploy per `cross-device-deployment`. Then **dispatch an adversarial review of the cumulative Phase 0 + Phase 1 diff** before starting Phase 2:

```bash
git diff <sha-before-T0.1>..HEAD
```

Phase 2 is the largest and riskiest phase; a clean base matters.

---

## Phase 2 — Topics

> **Before executing any Phase 2 task:** re-read `docs/plans/2026-07-25-telegram-forum-topics-design.md` and the source files named below. Line numbers in this section predate Phases 0 and 1 and will have drifted.

**The supergroup does not need to exist yet.** All of Phase 2 is buildable and testable against `fetchMock`. Do the manual Telegram setup during Checkpoint 2, not now.

> **[rev2-plan] Two structural changes from the reviewed draft.**
>
> 1. **The feature flag moved from last to second (T2.2).** In the reviewed draft, live topic resolution landed at T2.4 with `threaded` defaulting true, three tasks before the General fallback existed and twelve before the kill switch. Commits land on shared history one task at a time over a multi-week phase; any out-of-band worker deploy in that window would point the production DM at `createForumTopic` — which fails on a non-forum chat — with *undefined* failure handling. Checkpoint discipline does not protect against deploys it did not schedule. The flag now exists before anything reads it, and flag-off equivalence tests accrue through the whole phase instead of being retrofitted.
> 2. **Two extra checkpoints (2a, 2b).** 17 tasks behind a single checkpoint concentrates too much unverified work, and T2.14 is the task most likely to blow up scope.

### Task T2.1: `topics` table

**Files:**
- Modify: `packages/worker/src/d1-schema.sql`
- Modify: `packages/worker/test/worker.test.ts:35-79` (the `d1SchemaStatements` array)

**Trap:** the worker test file **duplicates the schema** rather than reading the `.sql` file. Update both, or tests pass locally against a table production does not have.

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

`chat_id` is `TEXT` to match the existing `messages` table convention. The unique index is **partial** because the reservation protocol (T2.4) inserts rows with a NULL `message_thread_id`.

**Commit:** `feat(worker): add topics table`

### Task T2.2: `TELEGRAM_TOPICS_ENABLED` flag

**Files:**
- Modify: `packages/worker/src/types.ts` (`Env`)
- Modify: `packages/worker/wrangler.toml` (set to `"false"`)
- Test: `packages/worker/test/worker.test.ts`

Add the flag and a single exported predicate — `topicsEnabled(env): boolean` — with tests for `"true"`, `"false"`, and absent (absent ⇒ **false**). Nothing reads it yet; T2.5 onward gate on it. Building it now means every later task can add its flag-off equivalence test as it goes.

**Commit:** `feat(worker): add TELEGRAM_TOPICS_ENABLED flag (default off)`

### Task T2.3: `topics.ts` repo module + `topicName`

**Files:**
- Create: `packages/worker/src/topics.ts`
- Test: `packages/worker/test/worker.test.ts` (new describe block)

Pure D1 access, no Telegram calls (those are T2.4). Functions: `getBySession`, `getByThread`, `reserve` (returns whether this caller won), `finalize`, `rename`, `markClosed`, `markOpen`, `deleteBySession`, `listReapable`, `listOrphaned`.

Also here, tested independently:

```typescript
const MACHINE_ICON_COLORS: Record<string, number> = {
  devbox: 7322096,    // 0x6FB9F0 blue
  cloudbox: 9367192,  // 0x8EEE98 green
};
const DEFAULT_ICON_COLOR = 16766590; // 0xFFD67E yellow

/** `{dir} · {title}`, clamped to Telegram's 128-char topic-name limit. */
export function topicName(dir: string, title: string): string {
  const full = `${dir} · ${title}`;
  if (full.length <= 128) return full;
  return [...full].slice(0, 127).join("") + "…";
}
```

A **fixed map, not a hash** — with six allowed `icon_color` values a hash collides trivially between two machines. The `[...full]` spread is deliberate: `slice` on a raw string can split a surrogate pair in an emoji-bearing title.

> **[rev2-plan] `dir` and `title` are two separate inputs and both arrive per-notification.** Do not try to derive `dir` from the worker's `sessions.label` — that column is corrupted by `/current-state`, which overwrites it with titles (`current-state-ingest.ts:96` → `sessions.ts:76-79`). T2.5 supplies both fields explicitly. Without this, fifteen `mono` worktrees all render `Fix auth test · Fix auth test`.

**Commit:** `feat(worker): topics repo module and topic-name builder`

### Task T2.4: Forum methods + topic manager with reservation protocol

**Files:**
- Modify: `packages/worker/src/telegram.ts` (add `createForumTopic`, `editForumTopic`, `closeForumTopic`, `reopenForumTopic`, `deleteForumTopic`)
- Create: `packages/worker/src/topic-manager.ts`
- Test: `packages/worker/test/worker.test.ts`

**The race being defended against:** the Poller dispatch loop and the OutboxSender run on independent timers in the same daemon process, so two concurrent worker invocations for the same session can both miss the lookup and both call `createForumTopic`. `session_id` is the primary key, so the loser's write is dropped while its Telegram topic survives as an orphan with a notification stranded inside it.

**Test first** — and this test is *not* vacuous under miniflare: `Promise.all` of two `resolveTopic()` calls interleaves at `await` points, so both SELECTs miss before either INSERT commits and `INSERT OR IGNORE` picks the winner. That is the same mechanism production relies on across isolates.

```typescript
it("creates exactly one topic under concurrent resolution", async () => {
  const [a, b] = await Promise.all([
    resolveTopic(env.DB, env, { sessionId: "ses_race", dir: "pigeon", title: "T", machineId: "devbox" }),
    resolveTopic(env.DB, env, { sessionId: "ses_race", dir: "pigeon", title: "T", machineId: "devbox" }),
  ]);
  expect(createForumTopicCalls).toBe(1);
  expect(a.messageThreadId).toBe(b.messageThreadId);
});
```

Algorithm:

1. `INSERT OR IGNORE INTO topics (session_id, …, message_thread_id) VALUES (…, NULL)`.
2. Winner (insert changed a row) calls `createForumTopic`, then `finalize`s the row.
3. Loser re-reads; if `message_thread_id` is still NULL, poll briefly (**bounded** — 5 tries × 100ms) then give up and fall back to General rather than hanging the request.
4. If the winner's `createForumTopic` fails, it **must delete its reservation row** so the next notification retries instead of being permanently stuck on a NULL thread.

**Commit:** `feat(worker): topic manager with create-reservation protocol`

### Task T2.5: `title`/`dir`/`threaded` end-to-end through the outbox

**Files:**
- Modify: `packages/daemon/src/app.ts` — the outbox enqueue payloads at **`:385-390`** (stop) and **`:498-502`** (question)
- Modify: `packages/daemon/src/worker/outbox-sender.ts:113-121` (payload parse) and the send call at `:142-150`
- Modify: `packages/daemon/src/index.ts:272-280` (the closure) and `:254-260`
- Modify: `packages/daemon/src/worker/poller.ts` (`SendNotificationInput` from T1.6)
- Modify: `packages/worker/src/notifications.ts` (`SendNotificationBody`, `handleSendNotification`)
- Test: `packages/daemon/test/outbox-sender.test.ts`, `packages/daemon/test/app.test.ts`, `packages/worker/test/worker.test.ts`

> **[rev2-plan] This task exists because the reviewed draft could not deliver the feature.** That draft scoped the payload change to `notifications.ts` + `poller.ts` only. But stop and question notifications — *the* notifications that create topics — are enqueued as `{messages, replyMarkup, notificationId}` (`app.ts:385-390`, `:498-502`) and `OutboxSender` parses exactly those three keys (`outbox-sender.ts:113-121`). The worker would have received a `title`/`dir` that nothing ever populated on the primary path, and the phase exit criterion would have failed silently. **The outbox payload is the load-bearing hop. Do not skip it.**

`threaded` defaults to **`true`** when absent, so the outbox path needs no per-call-site change once the payload carries it; `/current-state` opts out explicitly in T2.12.

Wire topic resolution into `handleSendNotification` **behind `topicsEnabled(env)`** from its first commit. Add a flag-off test asserting the Telegram payload contains no `message_thread_id`.

**End-to-end test to include:** enqueue a stop notification with a title, run `processOnce`, and assert the worker received both `title` and `dir`. That is the assertion the reviewed draft lacked.

**Commit:** `feat: thread notifications into per-session topics`

### Task T2.6: Reopen-on-closed

Sessions resurrect via `/current-state` re-registration (`current-state-ingest.ts:96`), revive-on-reply (`docs/plans/2026-05-03-revive-on-reply-design.md`), and `opencode attach`. Without reopen, a revived session's notifications land in the collapsed "closed" section — invisible — or fail outright.

**Test:** resolving a `state='closed'` topic calls `reopenForumTopic` and flips `state` to `open` before sending.

**Also settle empirically here:** whether an admin bot can post into a closed topic at all. Record the answer in the design doc.

**Commit:** `feat(worker): reopen closed topics on send`

### Task T2.7: Stale-thread recovery

If a topic is deleted by hand in Telegram, the next send fails. Detect `kind: "thread_not_found"`, delete the `topics` row, recreate **once** (guard against recursion).

**Pin the classifier here:** T1.3 left `thread_not_found` matched against an unverified description string. Confirm the real string against live Telegram during Checkpoint 2 and tighten the match.

**Commit:** `fix(worker): recreate topics deleted out of band`

### Task T2.8: Fallback rules

- Non-429 topic failure (revoked rights, forum mode off) → send to General with today's format. **Never drop a notification.**
- 429 anywhere → return 429 with `retryAfter`. **Never** fall back to General: that burns another call against the same exhausted budget and misplaces the message.

Two tests, one per branch.

**Commit:** `feat(worker): topic failure falls back to General, except rate limits`

### Task T2.9: Media passes `message_thread_id`

Media already lands in the right topic via `reply_to_message_id` (`notifications.ts:272-273`), so this is belt-and-braces. Add the parameter to `sendPhoto`/`sendDocument`.

**Commit:** `feat(worker): pass message_thread_id on media sends`

### Checkpoint 2a — outbound complete

```bash
npm run test && npm run typecheck
```

Then, critically: **flag-off byte-equivalence.** With `TELEGRAM_TOPICS_ENABLED=false`, the Telegram payloads must be identical to Phase 1. Deploy dark and confirm no behavior change in the production DM before continuing.

### Task T2.10: Close topic on unregister

**Files:** `packages/worker/src/sessions.ts:87-100`

`:98-99` already deletes the `sessions` row and its `messages`. **Do not delete the `topics` row** — the reaper needs it for 30 days. Mark `state='closed'`, set `closed_at`, best-effort `closeForumTopic`. Mark closed in D1 **even if the Telegram call fails**, so the reaper still collects it.

**Commit:** `feat(worker): close a session's topic on unregister`

### Task T2.11: Cron reaps closed topics and closes orphaned ones

**Files:** `packages/worker/src/index.ts:67-71` (existing hourly cron, `wrangler.toml:15-16`)

Two jobs:

1. **Reap:** delete topics with `state='closed' AND closed_at < now - 30d`. On a `deleteForumTopic` "not found", drop the row anyway. Cap at **5 deletions per run** — the whole chat budget is 20/min, and a cron burst races live notifications.
2. **Close orphans.** **[rev2-plan]** Dead-session cleanup calls `storage.sessions.delete()` *without* unregistering from the worker (`command-ingest.ts:508`, `:555`; the only `unregisterSession` callers are `session-reaper.ts:34` and `index.ts:395`). Once the local row is gone the daemon reaper can never see that session, so its topic would never be closed and never reaped — the 30-day lifecycle and the ~400-topic cap silently fail for exactly the crash-prone sessions that generate the most topics. So: close `state='open'` topics whose `sessions` row is **absent**, or whose `sessions.updated_at` is older than the session TTL. Fixing this worker-side rather than daemon-side also covers a daemon crash, which no daemon-side fix can.

**Commit:** `feat(worker): reap old topics and close orphaned ones`

### Task T2.12: `/current-state` cards are unthreaded

**Files:** `packages/daemon/src/worker/current-state-ingest.ts:94-113`, `packages/daemon/src/index.ts:254-260`

**The blocker this fixes:** cards go through `poller.sendNotification(sid, …)` — the exact endpoint doing lazy topic creation — once per surveyed session, sequentially, uncapped. On a 15-session machine that is 1 index + 15 `createForumTopic` + 15 `sendMessage` ≈ 31 calls in one burst against a 20/min ceiling. It also creates topics for idle sessions that never notified, defeating lazy creation. Card failures are swallowed by `console.warn` at `:110-112` with no outbox and no retry, so anything past the limit is silently lost.

Send `threaded: false`.

**Test:** a `/current-state` run over 3 sessions produces **zero** `createForumTopic` calls.

**Follow-up worth raising with the user, not resolved here:** once the topic list exists it *is* the current-state view — sorted by activity, named, unread-badged. The per-session cards may be redundant and `/current-state` may collapse to the index alone.

**Commit:** `fix(daemon): /current-state cards do not create topics`

### Task T2.13: Inbound topic-membership resolution

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

**Tests:** (a) bare text in a topic resolves via `topics`; (b) a message whose `reply_to_message.message_id === message_thread_id` does **not** resolve via swipe-reply; (c) a genuine swipe-reply inside a topic still outranks topic membership; (d) flag-off: topic membership is not consulted.

**Known and accepted limitation to document in code:** topic membership carries no `notification_id`, so the metadata fallback at `packages/daemon/src/worker/command-ingest.ts:274-305` — which rescues question replies after the `pending_questions` row expires at 4h (`schema.ts:7`) — is unreachable for topic-routed messages. The common case still works because `command-ingest.ts:129` checks `pendingQuestions.getBySessionId` *before* consulting metadata. **For questions older than 4 hours, swipe-reply remains the only reliable answer path.**

**Commit:** `feat(worker): resolve inbound messages by forum topic membership`

### Task T2.14: `message_thread_id` round-trip on commands

**The problem:** `sendTelegramMessage` in the daemon (`index.ts:80-99`) is the **primary** reply path for `/kill`, `/interrupt`, `/compact`, `/mcp list`, `/model`, launch errors, and revive errors — not a break-glass fallback. Without this task, `/mcp list` typed in a topic sends the command from the topic and the result to General.

**The fix keeps the daemon ignorant of topics.** `ALTER TABLE commands ADD COLUMN message_thread_id INTEGER`; the worker populates it from the inbound message; it is returned on `GET /machines/:id/next`; the daemon's `sendTelegramReply` echoes it back. The daemon never reads the `topics` table.

> **[rev2-plan] This task's blast radius is ~3× what the reviewed draft listed.** Enumerate all of it, because `messageThreadId` will be optional everywhere and **typecheck will happily pass with the daemon half unimplemented** — leaving the advertised fix undelivered.

**Files:**
- Worker: `src/d1-schema.sql` + `test/worker.test.ts` schema array; `src/d1-ops.ts:60-80` (`queueCommand` INSERT) and `:119-131` (`pollNextCommand` SELECT); `src/poll.ts:30-73` (the per-command-type response branches); `src/webhook.ts` (populate from the inbound message)
- Daemon: `src/worker/poller.ts` (every command message type); `src/index.ts` (every `on*` handler, `:126-261`); and the input types + `sendTelegramReply(chatId, …)` calls of **seven ingest modules** — `kill-ingest`, `interrupt-ingest`, `compact-ingest`, `mcp-ingest` (3 functions), `model-ingest` (2 functions), `launch-ingest`, and `command-ingest` (`:511`, `:520`, `:529`)
- Tests: the eight corresponding daemon ingest test files

**Acceptance test per command type:** assert the reply function received the thread id. Do not rely on typecheck.

**Commit:** `feat: carry message_thread_id through commands so daemon replies stay in-topic`

### Checkpoint 2b — inbound + round-trip

```bash
npm run test && npm run typecheck
```

Manually exercise each command type (`/kill`, `/interrupt`, `/compact`, `/mcp list`, `/model`) and confirm both the command *and its reply* stay in one place. This is the checkpoint that catches a half-implemented T2.14.

### Task T2.15: Webhook confirmations echo the thread

**Files:** `packages/worker/src/webhook.ts` — ~22 `sendTelegramMessage` call sites (`:401, 413, 459, 480, 486, 496, 502, 555, 562, 574, 581, 595, 609, 623, 637, 653, 669, 699, 701, 715, 724, 739`)

Thread the inbound `message_thread_id` so "Killing session…" and "Could not find session for this message" land in the topic the user typed in. Mechanical, but **count the call sites** and verify none were missed.

**Commit:** `feat(worker): webhook confirmations reply in the originating topic`

### Task T2.16: Bare slash commands in a topic

**Files:** `packages/worker/src/webhook.ts:472-507` (`resolveReplySession`)

`/kill`, `/interrupt`, `/compact`, `/mcp *`, `/model *` currently hard-require a swipe-reply. In a topic, resolve from `message_thread_id` instead. Keep the `isMachineRecent` gate.

> **[rev2-plan] `resolveReplySession` needs the service-message guard too.** A bare `/kill` in a topic arrives with `reply_to_message` set to the `ForumTopicCreated` service message; without the guard, `lookupMessage` misses and the handler errors out **before** any topic fallback is reached. The guard is specified in T2.13 for `resolveMessageSession` — apply it here as well, ideally by extracting it as a shared helper.

`/launch` and `/current-state` stay global and answer in General.

**Commit:** `feat(worker): slash commands resolve via topic without a reply`

### Task T2.17: Migration runbook

**Files:** Create `docs/runbooks/telegram-forum-migration.md`; update `.opencode/skills/worker-deployment/SKILL.md` and `AGENTS.md`

Document the manual setup: create supergroup → enable Topics → add bot → promote to admin with `can_manage_topics` and `can_delete_messages`. Admin status also bypasses privacy mode, so no BotFather `/setprivacy` change is needed. **[rev2-plan]** `can_pin_messages` is *not* required — nothing in this design pins, and `unpinAllForumTopicMessages` is unused.

**The runbook's central invariant, stated first and in bold: additive D1 DDL is applied BEFORE any code deploy.** See Checkpoint 2 for why.

**Commit:** `docs: Telegram forum migration runbook`

### Checkpoint 2 — migration

1. `npm run test && npm run typecheck`
2. Adversarial review of the full Phase 2 diff.
3. Execute the runbook **in this order**:

   1. **Apply the additive D1 DDL to production first** (`topics` table, `commands.message_thread_id`).
      **[rev2-plan]** The reviewed draft had deploy-then-DDL. That bricks command ingestion: T2.14 makes `queueCommand`'s INSERT and `pollNextCommand`'s SELECT reference `commands.message_thread_id` **unconditionally** (`d1-ops.ts:73-81`, `:119-131`) — the feature flag gates *behavior*, not SQL text. Deploying first means the next webhook command from any machine dies with `no such column`. Additive DDL is backwards-compatible with the currently-deployed code, so DDL-first is safe in both directions.
   2. Deploy with `TELEGRAM_TOPICS_ENABLED` **off**; confirm no behavior change.
   3. Create the supergroup; add its id to `ALLOWED_CHAT_IDS` **alongside** `8248645256`, so in-flight notifications to the old DM do not start 403ing mid-flight.
   4. Flip the flag; update the `TELEGRAM_CHAT_ID` sops secret per machine; restart daemons.
   5. Burn in per `daemon-cutover-burnin`, **watching worker logs for 429 frequency**.
   6. After burn-in, drop the old chat id.

**Deferred item with an explicit trigger:** the design defers a chat-level `next_send_at` gate in D1. If 429s appear on more than a handful of days during burn-in, build it. Record the observed 429 rate in the design doc either way.

---

## Out of scope (YAGNI)

Slack; a proactive chat-level rate gate (deferred, trigger above); per-machine supergroups; any change to the swarm IPC path.
