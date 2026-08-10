# Telegram Visibility (swarm + TUI prompts) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make a Telegram forum topic show *why* a session is working — post every swarm message into the receiver's topic (Phase 1), and mirror prompts typed in the TUI (Phase 2).

**Architecture:** Both features ride the existing durable outbox rail (`storage.outbox` → `OutboxSender` → worker `/notifications/send` → `resolveTopic`), so topic routing, retry, dedupe, splitting and swipe-reply binding come for free. Swarm posts are hooked at **insert**, not delivery, so the feed survives the on-hold quiet-swarm design. Phase 0 fixes two pre-existing scheduling flaws that this volume (65× current outbox traffic) would otherwise turn into question-notification starvation.

**Tech Stack:** TypeScript, Node, better-sqlite3, vitest. Packages: `@pigeon/daemon`, `@pigeon/opencode-plugin`.

**Design doc:** `docs/plans/2026-08-10-telegram-visibility-swarm-and-tui-design.md` (read it first; it carries the adversarial review's findings and the production volume numbers).

**Ordering constraint:** Phase 0 must land before Phase 1. Phase 1 is shippable alone. Phase 2 is gated on Task 10 (a spike).

**Test command shape used throughout:**
```bash
npm run --workspace @pigeon/daemon test -- <file-filter>
npm run --workspace @pigeon/daemon typecheck
```

---

## Phase 0 — scheduling fairness (no user-visible change)

### Task 1: Per-row kind ordering in `getReady` — DONE (`1c7753a`, corrected by `2337669`)

> **Correction, recorded after the fact.** The original spec below said "per-row
> kind CASE, full ladder". That was wrong: it reverts `pigeon-81p` (commit
> `816f0d7`), which deliberately made within-session order pure `created_at` so
> a question could not be sent ahead of the earlier stop explaining it. The
> implementer rewrote that regression test to make the change pass; an
> adversarial reviewer arbitrated. The shipped design is **A′**: the subquery
> keeps the full ladder, the **per-row** CASE is two-valued
> (`question`/`stop`/`card` → 1, everything else → 2), and within a tier order
> stays `created_at`. Otherwise a `mirror` enqueued before a `swarm` row would
> deliver after it — the same defect with new kinds. See the design doc's
> "Scheduling fairness" section. Swarm posts carry their event time (Task 4) so
> the permitted preemption is legible.


Today `getReady` ranks only by *per-session best kind*. A session with a queued
question promotes **its own swarm rows** to rank 1, and `created_at ASC` puts
older swarm rows ahead of the question. Adding swarm volume without this fix
delays live questions by minutes.

**Files:**
- Modify: `packages/daemon/src/storage/outbox-repo.ts:107-121`
- Test: `packages/daemon/test/outbox-repo.test.ts`

**Step 1: Write the failing test**

The arrangement matters — same session, swarm rows **older** than the question.
A cross-session or question-first arrangement passes even on the buggy SQL.

```ts
it("ranks a question ahead of same-session swarm rows enqueued earlier", () => {
  const s = "ses_same";
  repo.upsert({ notificationId: "w:1", sessionId: s, requestId: "r1", kind: "swarm", payload: "{}" }, 1_000);
  repo.upsert({ notificationId: "w:2", sessionId: s, requestId: "r2", kind: "swarm", payload: "{}" }, 2_000);
  repo.upsert({ notificationId: "q:1", sessionId: s, requestId: "r3", kind: "question", payload: "{}" }, 3_000);

  const ready = repo.getReady(10_000, 10);

  expect(ready[0]!.notificationId).toBe("q:1");
});

it("sorts an unknown kind below mirror", () => {
  repo.upsert({ notificationId: "x:1", sessionId: "ses_a", requestId: "r1", kind: "wat", payload: "{}" }, 1_000);
  repo.upsert({ notificationId: "m:1", sessionId: "ses_b", requestId: "r2", kind: "mirror", payload: "{}" }, 2_000);

  const ready = repo.getReady(10_000, 10);

  expect(ready.map((r) => r.notificationId)).toEqual(["m:1", "x:1"]);
});
```

**Step 2: Run and verify it fails**

```bash
npm run --workspace @pigeon/daemon test -- outbox-repo
```
Expected: first test FAILS (`ready[0]` is `w:1`).

**Step 3: Implement**

Apply the **same** ladder in both CASEs. Updating only the subquery leaves a
mirror-only session tied with a swarm-only session at group rank.

```ts
  getReady(now = Date.now(), limit = 100): OutboxRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox
         WHERE state = 'queued'
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY (SELECT MIN(CASE o2.kind WHEN 'question' THEN 1 WHEN 'stop' THEN 2 WHEN 'card' THEN 3 WHEN 'swarm' THEN 4 WHEN 'mirror' THEN 5 ELSE 6 END)
                   FROM outbox o2 WHERE o2.session_id = outbox.session_id AND o2.state = 'queued') ASC,
                  (CASE outbox.kind WHEN 'question' THEN 1 WHEN 'stop' THEN 2 WHEN 'card' THEN 3 WHEN 'swarm' THEN 4 WHEN 'mirror' THEN 5 ELSE 6 END) ASC,
                  created_at ASC,
                  rowid ASC
         LIMIT ?`,
      )
      .all(now, limit) as SqlRow[];
    return rows.map(asOutbox);
  }
```

Update the doc comment above it — it currently describes the old two-level order.

**Step 4: Run and verify pass**

```bash
npm run --workspace @pigeon/daemon test -- outbox-repo
npm run --workspace @pigeon/daemon typecheck
```

**Step 5: Commit**

```bash
git add packages/daemon/src/storage/outbox-repo.ts packages/daemon/test/outbox-repo.test.ts
git commit -m "fix(daemon): rank outbox rows by their own kind, not just their session's best"
```

---

### Task 2: Expiry for the new kinds

**Files:**
- Modify: `packages/daemon/src/worker/outbox-sender.ts:63-71`
- Test: `packages/daemon/test/outbox-sender.test.ts`

**Step 1: Failing test**

```ts
it("expires swarm after 24h and mirror after 6h", () => {
  expect(expiryForKind("swarm")).toBe(REPLY_TOKEN_TTL_MS);
  expect(expiryForKind("mirror")).toBe(6 * 60 * 60 * 1000);
});
```

**Step 2: Run, expect FAIL** (`mirror` returns the 24h default).

**Step 3: Implement**

```ts
const MIRROR_TTL_MS = 6 * 60 * 60 * 1000;

const EXPIRY_BY_KIND: Record<string, number> = {
  question: PENDING_QUESTION_TTL_MS,
  stop: REPLY_TOKEN_TTL_MS,
  card: REPLY_TOKEN_TTL_MS,
  swarm: REPLY_TOKEN_TTL_MS,
  mirror: MIRROR_TTL_MS,
};
```

A stale prompt mirror has no value; a stale swarm post still explains history.

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add packages/daemon/src/worker/outbox-sender.ts packages/daemon/test/outbox-sender.test.ts
git commit -m "feat(daemon): outbox expiry for swarm and mirror kinds"
```

---

### Task 3: Sub-budget so a swarm burst cannot saturate the governor

Peak observed traffic is **12 chunks in one minute — 100% of the window**. The
governor also checks per *entry*, before parse, so one 16.7K payload silently
burns five slots. And every threaded send can trigger `createForumTopic` inside
the worker, whose 429 pauses the **whole** outbox for up to 5 minutes.

**Files:**
- Modify: `packages/daemon/src/worker/outbox-sender.ts` (constant near `:88`, loop at `:232-300`)
- Test: `packages/daemon/test/outbox-sender.test.ts`

**Step 1: Failing tests**

```ts
it("never lets swarm entries take more than the sub-budget in one window", async () => {
  for (let i = 0; i < 12; i++) {
    enqueue({ notificationId: `w:${i}`, sessionId: "ses_a", kind: "swarm", chunks: 1 });
  }
  await sender.processOnce();
  await sender.processOnce();
  await sender.processOnce();

  expect(sent.length).toBeLessThanOrEqual(SWARM_SUB_BUDGET);
});

it("still delivers a question while a swarm burst is saturating the sub-budget", async () => {
  for (let i = 0; i < 12; i++) {
    enqueue({ notificationId: `w:${i}`, sessionId: "ses_a", kind: "swarm", chunks: 1 });
  }
  enqueue({ notificationId: "q:1", sessionId: "ses_b", kind: "question", chunks: 1 });

  await drainTicks(5);

  expect(sent.some((s) => s.notificationId === "q:1")).toBe(true);
});

it("counts chunks, not entries, against the sub-budget", async () => {
  enqueue({ notificationId: "w:big", sessionId: "ses_a", kind: "swarm", chunks: 5 });
  enqueue({ notificationId: "w:big2", sessionId: "ses_a", kind: "swarm", chunks: 5 });
  await drainTicks(3);

  expect(sent.length).toBeLessThanOrEqual(SWARM_SUB_BUDGET);
});
```

**Step 2: Run, expect FAIL** (swarm consumes all 12; the question waits).

**Step 3: Implement**

Add near `OUTBOX_RATE_LIMIT`:

```ts
/**
 * Of the OUTBOX_RATE_LIMIT sends per window, at most this many may be swarm/mirror
 * traffic. Swarm volume is ~65x the stop/question volume and its observed peak minute
 * already equals the full window, so without a carve-out a burst both delays questions
 * and multiplies the chance of a topic-creation 429 — which pauses the ENTIRE outbox
 * for up to MAX_PAUSE_MS.
 */
export const SWARM_SUB_BUDGET = 6;
const LOW_PRIORITY_KINDS = new Set(["swarm", "mirror"]);
```

Track a second timestamp window alongside `sendTimestamps`:

```ts
private lowPrioritySendTimestamps: number[] = [];
```

Prune it wherever `sendTimestamps` is pruned, and push to **both** wherever a
send timestamp is pushed (`outbox-sender.ts:305`) when the entry is low-priority.

Insert the sub-budget check **after** the payload parse and the
`messages.length === 0` guard, because chunk count does not exist before parse:

```ts
        // Sub-budget check for low-priority kinds. Placed post-parse because it is
        // chunk-aware, and `continue` rather than `break` because higher-priority
        // entries later in the batch are still eligible.
        if (LOW_PRIORITY_KINDS.has(entry.kind)) {
          if (this.lowPrioritySendTimestamps.length + messages.length > SWARM_SUB_BUDGET) {
            this.log("outbox sub-budget reached, deferring low-priority entry", {
              kind: entry.kind,
              notificationId: entry.notificationId,
              countInWindow: this.lowPrioritySendTimestamps.length,
              chunks: messages.length,
              budget: SWARM_SUB_BUDGET,
            });
            continue;
          }
        }
```

Do **not** change the existing global `break batchLoop` at `:243` — that one is
correct, since a full global window helps nobody.

**Step 4: Run, expect PASS**, plus the whole sender suite green (the existing
tests assert current behaviour for stop/question, which must not shift).

```bash
npm run --workspace @pigeon/daemon test -- outbox-sender
npm run --workspace @pigeon/daemon typecheck
```

**Step 5: Commit**

```bash
git add packages/daemon/src/worker/outbox-sender.ts packages/daemon/test/outbox-sender.test.ts
git commit -m "feat(daemon): reserve outbox governor headroom for question and stop traffic"
```

---

## Phase 1 — swarm messages in Telegram

### Task 4: `formatSwarmNotification`

**Files:**
- Modify: `packages/daemon/src/notification-service.ts`
- Test: `packages/daemon/test/notification-service.test.ts`

**Step 1: Failing tests**

```ts
it("renders sender, kind and priority in the header", () => {
  const n = formatSwarmNotification({
    kind: "task.assign", priority: "urgent",
    fromLabel: "coordinator", toSessionId: "ses_target",
    msgId: "msg_abc", payload: "do the thing",
  });
  expect(n.header.text).toContain("swarm");
  expect(n.header.text).toContain("task.assign");
  expect(n.header.text).toContain("urgent");
  expect(n.header.text).toContain("coordinator");
});

it("marks a scheduled message with its delivery time", () => {
  const n = formatSwarmNotification({ /* ...  */ deliverAt: 1_800_000_000_000 });
  expect(n.header.text).toContain("scheduled");
});

it("puts msg_id and session id in the footer", () => {
  const n = formatSwarmNotification({ /* ... */ msgId: "msg_abc", toSessionId: "ses_target" });
  expect(n.footer.text).toContain("msg_abc");
  expect(n.footer.text).toContain("ses_target");
});

it("renders a cancellation notice", () => {
  const n = formatSwarmCancelNotification({ msgId: "msg_abc", toSessionId: "ses_target" });
  expect(n.header.text).toContain("cancelled");
  expect(n.header.text).toContain("msg_abc");
});
```

**Step 2: Run, expect FAIL** (functions not exported).

**Step 3: Implement**

Build with `TgMessageBuilder` (`packages/daemon/src/telegram-message.ts:19`), the
same entity-based approach as `formatTelegramNotification` — **no `parse_mode`**,
because a payload is arbitrary agent text and must never be parsed as markup.

Return `{ header, body, footer }` (no `replyMarkup`: swipe-reply works via the
worker's `messages` row, so no token is needed).

- header: `📨 swarm · <kind> · <priority>` newline `from <fromLabel>`, then the
  message's **event time** (`createdAt`), plus `⏰ scheduled <ISO>` when
  `deliverAt` is in the future. The event time is required, not cosmetic — a
  conversational row may preempt a backlogged swarm post within the same
  session, so a post can land below the stop it caused. Always printing the
  event time makes that legible.
- body: payload verbatim
- footer: `🆔 <toSessionId>`, `msg_id`, standard swipe-reply hint

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add packages/daemon/src/notification-service.ts packages/daemon/test/notification-service.test.ts
git commit -m "feat(daemon): format swarm message and cancellation notifications"
```

---

### Task 5: `enqueueSwarmTelegramNotice` helper

**Files:**
- Create: `packages/daemon/src/swarm/telegram-notice.ts`
- Test: `packages/daemon/test/swarm-telegram-notice.test.ts`

**Step 1: Failing tests**

```ts
it("enqueues one outbox row addressed to the receiving session", () => {
  enqueueSwarmTelegramNotice(storage, row({ msgId: "msg_1", toSession: "ses_target" }), now);

  const entry = storage.outbox.getByNotificationId("w:msg_1")!;
  expect(entry.sessionId).toBe("ses_target");
  expect(entry.kind).toBe("swarm");
  expect(JSON.parse(entry.payload).threaded).toBe(true);
});

it("skips channel broadcasts, which have no topic", () => {
  enqueueSwarmTelegramNotice(storage, row({ toSession: null, channel: "general" }), now);
  expect(storage.outbox.getReady(now, 10)).toHaveLength(0);
});

it("never throws — a Telegram fault must not break swarm IPC", () => {
  const broken = { ...storage, outbox: { upsert() { throw new Error("boom"); } } };
  expect(() => enqueueSwarmTelegramNotice(broken as never, row({}), now)).not.toThrow();
});
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement**

```ts
export function enqueueSwarmTelegramNotice(storage: Storage, record: SwarmMessageRecord, now: number): void {
  try {
    if (!record.toSession) return; // channel broadcast: no topic to post into

    const target = storage.sessions.get(record.toSession);
    const sender = storage.sessions.get(record.fromSession);

    const notification = formatSwarmNotification({
      kind: record.kind,
      priority: record.priority,
      fromLabel: displayName({ title: sender?.title, label: sender?.label, sessionId: record.fromSession }),
      toSessionId: record.toSession,
      msgId: record.msgId,
      payload: record.payload,
      deliverAt: record.deliverAt,
    });

    const chunks = splitTelegramMessage(notification.header, notification.body, notification.footer);
    storage.outbox.upsert({
      notificationId: `w:${record.msgId}`,
      sessionId: record.toSession,
      requestId: `swarm-${record.msgId}`,
      kind: "swarm",
      payload: JSON.stringify({
        messages: chunks.map((c) => ({ text: c.text, entities: c.entities })),
        replyMarkup: undefined,
        notificationId: `w:${record.msgId}`,
        title: target?.title ?? undefined,
        dir: target?.cwd ?? undefined,
        threaded: true,
      }),
    }, now);
  } catch (err) {
    console.error("[pigeon-daemon] swarm telegram notice failed", record.msgId, err);
  }
}
```

The try/catch is load-bearing: `notifySenderOfFailure` and the watchdog call
their inserts inside `db.transaction` blocks, so a throw here would roll back a
swarm state transition.

Add `enqueueSwarmCancelNotice` in the same file, identical but with
`notificationId: "wc:" + msgId` — reusing `w:<msg_id>` would be deduped into
oblivion by the worker against the original post.

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add packages/daemon/src/swarm/telegram-notice.ts packages/daemon/test/swarm-telegram-notice.test.ts
git commit -m "feat(daemon): helper to post a swarm message into the receiver's topic"
```

---

### Task 6: Wire the two ingress routes

**Files:**
- Modify: `packages/daemon/src/app.ts:277` (`/swarm/send`), `:368` (`/swarm/schedule`)
- Test: `packages/daemon/test/swarm-routes.test.ts`

**Step 1: Failing tests**

```ts
it("posts an accepted swarm message to the receiver's topic", async () => {
  await post("/swarm/send", { from: "ses_a", to: "ses_b", payload: "hello" });
  const ready = storage.outbox.getReady(now, 10);
  expect(ready).toHaveLength(1);
  expect(ready[0]!.sessionId).toBe("ses_b");
});

it("does not re-post when the same caller msg_id is sent twice", async () => {
  await post("/swarm/send", { from: "ses_a", to: "ses_b", payload: "hi", msg_id: "msg_fixed" });
  await post("/swarm/send", { from: "ses_a", to: "ses_b", payload: "hi", msg_id: "msg_fixed" });
  expect(storage.outbox.getReady(now, 10)).toHaveLength(1);
});

it("still returns 202 when the notice enqueue fails", async () => {
  breakOutbox();
  const res = await post("/swarm/send", { from: "ses_a", to: "ses_b", payload: "hi" });
  expect(res.status).toBe(202);
});
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement**

`insert` returns `boolean` (`swarm-repo.ts:94`) — gate on it, so a duplicate
`msg_id` cannot re-post, and a previously *failed* outbox row cannot be revived
by the upsert's failed→queued reset (`outbox-repo.ts:81`).

```ts
        const inserted = storage.swarm.insert({ /* unchanged */ }, nowFn());
        if (inserted) {
          const record = storage.swarm.getByMsgId(msgId);
          if (record) enqueueSwarmTelegramNotice(storage, record, nowFn());
        }
```

`/swarm/schedule` at `:368` already captures `inserted`; add the same two lines.

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add packages/daemon/src/app.ts packages/daemon/test/swarm-routes.test.ts
git commit -m "feat(daemon): post swarm sends and schedules into the receiver's Telegram topic"
```

---

### Task 7: Wire pigeon's own two insert sites

The requirement is "everything shows", which includes pigeon-generated traffic:
`delivery.failed` notices and watchdog nudges.

**Files:**
- Modify: `packages/daemon/src/swarm/notify-sender.ts:106`, `packages/daemon/src/swarm/delivery-watchdog.ts:1443`
- Test: `packages/daemon/test/swarm-notify-sender.test.ts`, `packages/daemon/test/delivery-watchdog.test.ts`

**Step 1: Failing test**

```ts
it("posts a delivery-failure notice into the sender's topic", () => {
  notifySenderOfFailure(storage, row({ fromSession: "ses_a", toSession: "ses_b" }), "unreachable", now);
  const ready = storage.outbox.getReady(now, 10);
  expect(ready.some((e) => e.sessionId === "ses_a")).toBe(true);
});
```

Note the direction: a `delivery.failed` row's *receiver* is the original sender,
so the helper's `toSession` addressing already puts it in the right topic.

**Step 2: Run, expect FAIL.**

**Step 3: Implement** — same two lines as Task 6, gated on `insert`'s return.

**Step 4: Run, expect PASS.** Watch for existing watchdog tests that assert exact
outbox contents.

**Step 5: Commit**

```bash
git add packages/daemon/src/swarm/notify-sender.ts packages/daemon/src/swarm/delivery-watchdog.ts packages/daemon/test
git commit -m "feat(daemon): surface pigeon's own swarm notices in Telegram too"
```

---

### Task 8: Cancellation retraction

6% of production rows are cancelled and cancel-and-reschedule is the documented
pattern, so without this every retracted wake leaves a permanent false claim.

**Files:**
- Modify: `packages/daemon/src/app.ts:439-462` (`POST /swarm/scheduled/:msgId/cancel`)
- Test: `packages/daemon/test/swarm-schedule-routes.test.ts`

**Step 1: Failing test**

```ts
it("posts a retraction when a scheduled message is cancelled", async () => {
  await post("/swarm/schedule", { from: "ses_a", to: "ses_b", payload: "wake", after: "1h", msg_id: "msg_s" });
  await post("/swarm/scheduled/msg_s/cancel", { from: "ses_a" });

  const ids = storage.outbox.getReady(now, 10).map((e) => e.notificationId);
  expect(ids).toContain("w:msg_s");
  expect(ids).toContain("wc:msg_s");
});
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement** — inside the existing `if (cancelled)` branch, call
`enqueueSwarmCancelNotice(storage, record, nowFn())` before returning 200.

**Step 4: Run, expect PASS.**

**Step 5: Commit**

```bash
git add packages/daemon/src/app.ts packages/daemon/test/swarm-schedule-routes.test.ts
git commit -m "feat(daemon): post a retraction when a scheduled swarm message is cancelled"
```

---

### Task 9: Phase 1 verification and docs

**Step 1:** Full suites.

```bash
npm run --workspace @pigeon/daemon test
npm run --workspace @pigeon/daemon typecheck
```

**Step 2:** Update `.opencode/skills/swarm-architecture/SKILL.md` and
`.opencode/skills/swarm-operations/SKILL.md` — the ops skill needs the new
`w:` / `wc:` notification-id prefixes so a swarm post can be traced in the
outbox table, and the architecture skill needs the insert-time hook sites.

**Step 3:** Update the AGENTS.md "Swarm IPC" paragraph with one sentence on
Telegram visibility.

**Step 4: Commit**

```bash
git add AGENTS.md .opencode/skills
git commit -m "docs: swarm messages now appear in the receiver's Telegram topic"
```

**Step 5:** Deploy per `.opencode/skills/cross-device-deployment/SKILL.md` and
**watch the first hour** against the volume baseline in the design doc: expect
~15 posts/hr typical, ~133 at peak. If questions visibly lag, the sub-budget is
the dial.

---

## Phase 2 — mirror TUI-typed prompts

### Task 10: SPIKE — do Telegram question replies produce user messages?

**Blocking.** Answers travel via `POST /question/{id}/reply`
(`packages/opencode-plugin/src/index.ts:156-214`), not `prompt_async`, so they
sit outside every recorded injection path. If opencode materialises an answer as
a user-role message, **every button press mirrors back into the topic**.

**Method:** run a local session, trigger a question, answer it, and log every
`message.updated` / `message.part.updated` the plugin sees. Record the answer's
message shape (role, part types, any marker distinguishing it).

**Deliverable:** a written finding appended to the design doc, plus either
(a) "no user message — no action", or (b) a named record site / filter.

**Do not start Task 11 until this is answered.**

---

### Task 11: `injected_prompts` store (counted)

**Files:**
- Create: `packages/daemon/src/storage/injected-prompts-schema.ts`, `.../injected-prompts-repo.ts`
- Modify: `packages/daemon/src/storage/index.ts` (wire into `openStorageDb`), session reaper for the TTL sweep
- Test: `packages/daemon/test/injected-prompts-repo.test.ts`

Schema: `(session_id TEXT, text_hash TEXT, count INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, text_hash))`.

**Failing tests to write first:**

```ts
it("consumes one recording per identical injection", () => {
  repo.record("ses_a", hash("continue"), now);
  repo.record("ses_a", hash("continue"), now);

  expect(repo.consume("ses_a", hash("continue"))).toBe(true);
  expect(repo.consume("ses_a", hash("continue"))).toBe(true);
  expect(repo.consume("ses_a", hash("continue"))).toBe(false);
});

it("drops rows past the TTL", () => { /* ... */ });
```

The counted behaviour is the whole point: a plain PK row is consumed by the
first of two identical prompts, and the second echoes. "continue" twice inside
15 minutes is routine, and arbiter retry-after-timeout produces byte-identical
re-injections (`prompt_async` is non-idempotent; a 30s timeout may mean
*processed* — `worker/delivery-policy.ts:17`).

**Commit:** `feat(daemon): store recording injected prompts to suppress echoes`

---

### Task 12: Record at the two injection sites

**Files:**
- Modify: `packages/daemon/src/opencode-client.ts:322` (`sendPrompt`) — covers arbiter, `launch-ingest`, `revive-and-deliver`
- Modify: daemon direct-channel dispatch (where `ExecuteCommandEnvelope` is built) — covers Telegram-via-plugin
- Test: `packages/daemon/test/opencode-client.test.ts`, direct-channel adapter test

**Critical:** record **before** the HTTP call, not after the response. A prompt
that times out but was processed fires its events ~30s before a response-time
record would exist, and the mirror wins the race.

**Failing test:**

```ts
it("records the prompt before the request is issued", async () => {
  let recordedAtCallTime = false;
  fetchStub = async () => { recordedAtCallTime = repo.has(sessionId, hash(text)); throw new Error("timeout"); };

  await client.sendPrompt(sessionId, dir, text).catch(() => {});

  expect(recordedAtCallTime).toBe(true);
});
```

Add a guard test asserting `sendPrompt` is the only daemon-side `prompt_async`
caller, so a future injection path cannot silently bypass suppression:

```ts
it("has no prompt_async call sites outside opencode-client", () => {
  const hits = grepSync("prompt_async", "packages/daemon/src");
  expect(hits.map((h) => h.file)).toEqual(["packages/daemon/src/opencode-client.ts"]);
});
```

**Commit:** `feat(daemon): record every daemon-injected prompt before dispatch`

---

### Task 13: `POST /mirror`

**Files:**
- Modify: `packages/daemon/src/app.ts` (new route beside `POST /stop` at `:760`)
- Test: `packages/daemon/test/mirror-route.test.ts`

Route consults `injected_prompts.consume(sessionId, sha256(text))`; on a hit it
returns 200 with `{ mirrored: false }` and enqueues nothing. Otherwise it
enqueues `kind: "mirror"`, `notificationId: m:<sessionId>:<messageId>`,
`threaded: true`, header `🧑 <display name>`, no footer, no reply markup.

No quiet-policy gate, no reply token — unlike `/stop`.

**Tests:** one per injection path (inject → no mirror row); un-recorded prompt →
exactly one row; duplicate identical command → zero mirrors; retry-after-timeout
→ zero mirrors; after the count drains, the same text typed in the TUI mirrors;
plus whatever Task 10 requires for question replies.

**Commit:** `feat(daemon): mirror TUI-typed prompts into the session's topic`

---

### Task 14: Plugin-side capture

**Files:**
- Modify: `packages/opencode-plugin/src/message-tail.ts` (user branch), `packages/opencode-plugin/src/index.ts:463,492`
- Modify: `packages/opencode-plugin/src/daemon-client.ts` (add `postMirror`)
- Test: `packages/opencode-plugin/test/message-tail.test.ts`

Accumulate user-role parts keyed by `messageID`, flush after 500ms of quiescence,
POST to `/mirror`.

Two exclusions:
- Subagent sessions (those with a `parentID`).
- Parts marked `synthetic: true`. Phase 2 is **not** invariant to the on-hold
  quiet design: its §7 hook appends a synthetic part to incoming user messages,
  and folding that into the hash would mismatch on *every* injected prompt while
  unread > 0 — mirroring all of them and leaking the synthetic note to Telegram.

Fail open: if the daemon is unreachable, drop the mirror silently. Never let
this path throw into the event handler.

**Commit:** `feat(plugin): report user-typed prompts to the daemon for mirroring`

---

### Task 15: Phase 2 verification

```bash
npm run test
npm run typecheck
```

Then deploy and watch a real session: type a prompt in the TUI (expect exactly
one mirror), send one from Telegram (expect **zero**), trigger a swarm message
(expect the Phase 1 post and no mirror), and answer a question from Telegram
(expect whatever Task 10 established).

**Commit:** docs update for the mirror behaviour in AGENTS.md.

---

## Execution notes

- Phase 0 tasks are independent of each other; Phase 1 depends on all three.
- Task 10 gates Tasks 11-15 absolutely.
- Every task commits on green. No task should take more than ~30 minutes.
