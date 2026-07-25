# Telegram forum topics: one topic per session (design)

Date: 2026-07-25
Scope: `packages/worker` (topic manager, inbound routing), `packages/daemon`
(session title storage, payload fields, outbox fixes),
`packages/opencode-plugin` (title capture)

Revision 2, after adversarial review. Findings that changed the design are noted
inline as **[rev2]**.

## Problem

Every Pigeon notification from every machine and every session lands in a single
Telegram chat (`ALLOWED_CHAT_IDS = 8248645256`, a positive id — a private DM with
the bot). At 5–15 concurrent sessions this is unusable. The reported pains:

- concurrent sessions interleave
- can't tell which session a message came from
- volume / scrollback churn
- no per-session mute or notification control

Notably *not* a pain: replying. Telegram swipe-reply works fine today. So the
problem is grouping and identification, not the reply mechanism.

A contributing factor to "can't tell which session": the human-readable name
Pigeon shows is the **directory basename**, not the opencode TUI session title.
`label` is minted once at `opencode-plugin/src/index.ts:209` as
`ctx.directory.split("/").filter(Boolean).pop()` and reused verbatim for
register, stop, and question payloads. So fifteen sessions in fifteen `mono`
worktrees all announce themselves as some variant of the same word.

## Measurements

From cloudbox's `~/.local/share/opencode/opencode.db`, root sessions
(`parent_id IS NULL`) with lifetime > 5 min — i.e. the ones Pigeon would notify
about — over the last 30 days:

| Grouping key | Distinct containers / 30d | New / week |
|---|---|---|
| session | 438 | ~100 |
| directory (worktree) | 203 | ~47 |
| repo | 23 (≈10 active) | ~5 |

Notification rate, over 14 days, counting **all** messages in those sessions:

- p50 **3**/min, p90 **9**/min, p99 **20**/min, max **42**/min
- **0.77%** of active minutes exceed 20/min; **zero** exceed 60/min

**[rev2] Read these numbers as a floor, not a ceiling.** Telegram meters API
calls, not notifications, and one notification can be several calls: each split
chunk is a separate send, each media attachment is a send, plus
`createForumTopic` / `editForumTopic` / `closeForumTopic`, plus webhook
confirmations, plus daemon-direct command results. Budget for roughly 1.5–2.5×
the message counts above.

## Decision: Telegram forum supergroup, one topic per session

Three approaches were considered.

**A. Telegram forum topics, topic per session (chosen).** Each session gets a
topic named from its TUI title. Fixes all four pains by construction: the topic
name *is* the session, and Telegram supports muting individual topics
([official feature](https://telegram.org/blog/topics-in-groups-collectible-usernames):
"Group members can mute notifications for individual topics"). Inbound messages
in a topic carry `message_thread_id`, so routing is free. Costs ~100 new topics
per week, which requires a close/delete lifecycle.

**B. Telegram forum topics, topic per directory.** Half the churn (~47/week),
stable across relaunches, and directory is already Pigeon's primary key
everywhere. Rejected because a swarm puts a coordinator and N workers in the
*same* directory — exactly the 5–15-concurrent scenario that hurts most — so
interleaving returns in the worst case, and per-session mute degrades to
per-task mute.

**C. Slack, channel per repo + thread per session.** Better rate limits (1/sec
*per channel*) and richer UI, but two disqualifiers on the free tier: messages
are hidden after 90 days and permanently deleted after 1 year
([usage limits](https://slack.com/help/articles/115002422943-Usage-limits-for-free-workspaces));
and thread replies do not generate mobile push notifications unless the user
follows the thread or is `@`-mentioned — which defeats the purpose of a
notification bot.

**Accepted cost of A:** mutes are per-topic, so a chronically noisy *task* must
be re-muted each time it gets a fresh session. Inherent to session-granularity.

### Lifecycle

`closeForumTopic` on session end; delete after 30 days. Deletion is destructive
— `deleteForumTopic` removes the topic *and all its messages* — so 30 days buys
a comfortable scrollback window while capping the visible list at ~400 topics.

Session end is already well covered: `DELETE /sessions/:id` fires on graceful
exit, and the hourly session reaper (`SESSION_TTL_MS` = 1 week,
`daemon/src/session-reaper.ts:18-49`) catches ungraceful deaths.

**[rev2] Reopen on resurrection.** Sessions come back from the dead by at least
three routes: `/current-state` re-registers every surveyed session
(`current-state-ingest.ts:96`), revive-on-reply exists specifically to
resurrect stale sessions (`docs/plans/2026-05-03-revive-on-reply-design.md`),
and a terminal `opencode attach` re-triggers plugin registration. If a send
resolves to a `state='closed'` topic, the worker calls `reopenForumTopic` and
sets `state='open'` before sending. Without this, a revived session's
notifications land in the collapsed "closed" section where they are invisible,
or fail outright. **Open question to settle empirically during implementation:**
whether an admin bot can post into a closed topic at all. Reopen makes the
answer moot, which is why it is mandatory rather than an optimization.

## Where the topic logic lives: the worker

The daemon is the natural home for formatting, but topic management goes in the
**worker**, because daemons run on both devbox and cloudbox pointed at the same
chat. Two independent topic managers writing one forum is a coordination problem
with no upside. The worker holds the D1 session and message mappings and sees
all inbound traffic.

This forces an overdue cleanup: the worker has no central Telegram client — six
inline `fetch` calls across `notifications.ts` and `webhook.ts`, plus two more
in the daemon, with three duplicate `sendMessage` implementations. Nothing can
be threaded coherently until that is one module.

### [rev2] Correction: the daemon's direct Telegram path is not break-glass

Revision 1 claimed the daemon's direct sends were only a worker-unreachable
fallback. That is wrong. `sendTelegramMessage` (`daemon/src/index.ts:80-99`) is
wired as `sendTelegramReply` for eleven primary command handlers
(`index.ts:126, 146, 161, 176, 191, 200, 210, 220, 228, 238, 261`): `/kill`,
`/interrupt`, `/compact` confirmations, `/mcp list` and `/model` list results,
launch errors, revive-on-reply errors, and the `/current-state` index. The
worker webhook has a further ~12 unthreaded `sendTelegramMessage` call sites for
confirmations and errors.

Left unaddressed, the advertised win — "`/mcp list` works bare in a topic" —
would send the command from the topic and the result to General.

**Fix: thread id travels with the command.** The worker already stores
`chat_id` per command in D1 (`commands.chat_id`, `d1-ops.ts:80`). Add
`message_thread_id` alongside it, populated from the inbound message, returned
on `GET /machines/:id/next`, and echoed by the daemon's `sendTelegramReply`.
The daemon never consults the `topics` table — it just reflects back what it was
given. Worker webhook confirmations likewise echo the inbound
`message_thread_id`. Only the genuine worker-unreachable fallback
(`TelegramNotificationService`) posts to General unthreaded.

### [rev2] Rate limiting

Telegram's group limit is **20 messages/minute per chat, not per topic**
([Bot FAQ](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)).
Moving from a private DM (~60/min) to a supergroup *lowers* the ceiling. Three
fixes, all small, all addressing verified bugs rather than speculative load:

1. **Per-chunk idempotency keys.** `OutboxSender` sends chunks in a loop and, on
   any chunk failing, marks the *whole entry* for retry
   (`outbox-sender.ts:139-163`). Only the last chunk carries `notificationId`
   (`:148`), and worker dedup keys on it (`notifications.ts:197-205`). So a
   failure on chunk 2 of 3 re-sends chunk 1, which has no idempotency key →
   duplicate message → more traffic into an already-throttled chat. Give every
   chunk an id, `{notificationId}:c{i}`. Note the inbound parser at
   `webhook.ts:334-340` splits `q:{sessionId}:{requestId}` and must tolerate the
   `:c{i}` suffix. This is a pre-existing bug that a 20/min ceiling promotes from
   rare to routine.
2. **429 never falls back to General.** Posting the message somewhere else burns
   another call against the same exhausted budget and misplaces it. A 429 on any
   Telegram call returns to the outbox for retry.
3. **Global pause on 429, not per-entry.** `OutboxSender` honors Telegram's
   `retry_after` across the *whole outbox*, not just the failing entry.
   Today a `retry_after` reschedules one entry while the other four in the batch
   keep firing.

**Deliberately deferred: a chat-level `next_send_at` gate in D1.** The reviewer
argued for it on the grounds that two daemons at 5 entries per 5s tick have a
combined design ceiling of 120/min. That is a ceiling, not observed load —
measured p99 is 20/min for *all* messages on the busier machine, and fix 3
makes each daemon self-throttle on feedback. Adding a D1 read-modify-write to
every send has real cost. **Trigger for revisiting:** if 429s appear in worker
logs on more than a handful of days during burn-in, add the gate.

### Failure rule

If a topic operation fails for a *non-rate-limit* reason — revoked admin
rights, forum mode turned off, thread not found — the notification falls back to
posting in General using today's format. Topic machinery must never drop a
notification. Rate-limit failures are the explicit exception (above): they
retry.

## Data model

### Phase 0: session title (independent value, ships first)

- **Plugin.** `ctx.client.session.get()` is already called at
  `opencode-plugin/src/index.ts:228` and `.data.title` is discarded — capture
  it. Add a `session.updated` handler (currently absent from the dispatcher at
  `index.ts:307-627`) so the title stays fresh as opencode re-summarizes it.
  `session.created` fires *before* the title is generated, so that event alone
  is insufficient. **Verified:** `EventSessionUpdated` is a member of the SDK
  `Event` union (`sdk/dist/gen/types.gen.d.ts:499-504, :602`) and the plugin
  `event` hook receives the full union (`plugin/dist/index.d.ts:109-110`), so
  these events do reach plugins.
- **Daemon.** `ALTER TABLE sessions ADD COLUMN title TEXT` via the existing
  additive-migration pattern (`daemon/src/storage/schema.ts:103-121`). Keep
  `label` as the directory basename; add `title` beside it. Formatters use
  `title ?? label ?? sessionId.slice(0,8)`, replacing three duplicated
  precedence expressions in `app.ts` (`:377`, `:474`, `:491`) and four in
  `notification-service.ts` (`:427`, `:473`, `:556`, `:625`).
- **Worker.** No schema change. The title rides in the `label` field newly added
  to the `POST /notifications/send` body.

**[rev2] Dropped claim.** Revision 1 asserted Phase 0 incidentally fixes the bug
where `/current-state` writes the real title into the worker's `sessions.label`
and the next `/session-start` clobbers it back to the basename. It does not:
plugin registration happens before a title exists, and nothing re-registers on
title change. The bug persists and is now harmless — topic names come from the
per-notification `label`, so the worker's `sessions.label` column is not
load-bearing for anything in this design.

### New D1 table

```sql
CREATE TABLE IF NOT EXISTS topics (
  session_id        TEXT PRIMARY KEY,
  machine_id        TEXT,
  chat_id           INTEGER NOT NULL,
  message_thread_id INTEGER,
  name              TEXT,
  state             TEXT NOT NULL DEFAULT 'open',  -- open | closed
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  closed_at         INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_thread ON topics(chat_id, message_thread_id);
CREATE INDEX IF NOT EXISTS idx_topics_reap ON topics(state, closed_at);
```

Added to `packages/worker/src/d1-schema.sql`, applied manually
(`npx wrangler d1 execute pigeon-router --remote --file=...`); there is no
migration tooling.

**[rev2] `machine_id` is stored** so that topic-membership routing can produce a
useful error (or drive a future revive) for the full 30-day topic lifetime, even
after unregister deletes the worker's `sessions` row (`sessions.ts:98`).

**[rev2] `message_thread_id` is nullable** to support the reservation protocol
below.

Topic name: `{dirBasename} · {title}`, truncated to Telegram's 128-char limit —
e.g. `pr-3917 · Fix flaky auth test`. `icon_color` comes from a **fixed
machine→color map**, not a hash: with only six allowed values a hash collides
trivially between two machines.

Topics are created **lazily on first notification**, not at register: most
registered sessions never notify, and by first-notification time a real title
exists.

### [rev2] Reservation protocol against duplicate topics

The Poller dispatch loop and the OutboxSender run on independent timers in the
same daemon process, so two concurrent worker invocations for the same session
can both miss the `topics` lookup and both call `createForumTopic`. The
`session_id` primary key means the loser's write is dropped while its Telegram
topic survives as an orphan with a notification stranded inside it. D1 offers no
transaction spanning the Telegram fetch, so:

1. `INSERT OR IGNORE INTO topics (session_id, ...) VALUES (..., NULL, ...)` —
   claim the row before calling Telegram.
2. Winner (insert affected a row) calls `createForumTopic` and writes back
   `message_thread_id`.
3. Loser re-reads, briefly polling if `message_thread_id` is still NULL, then
   reuses the winner's thread.
4. Any orphan topic from a lost race gets a best-effort `deleteForumTopic`.

Fixing the `/current-state` burst below removes the most likely trigger, but the
reservation is cheap insurance.

## Message routing

### Outbound

`POST /notifications/send` gains two fields: `label` (the session title) and
**[rev2]** `threaded: boolean`.

**[rev2] `/current-state` must not mint topics.** Revision 1 claimed
`/current-state` "stays global." It does not: its cards go through
`poller.sendNotification(sid, …)` (`daemon/src/index.ts:254-255`) — the exact
endpoint that lazily creates topics — once per surveyed session, sequentially,
uncapped (`current-state-ingest.ts:94-113`). On a 15-session machine that is 1
index + 15 `createForumTopic` + 15 `sendMessage` ≈ 31 calls in one burst against
a 20/min ceiling, *and* it creates topics for idle sessions that never notified,
defeating lazy creation. Card failures are swallowed by a `console.warn`
(`:110-112`) with no outbox and no retry, so anything past the limit is silently
lost. Cards therefore send `threaded: false` and go to General.

Worth flagging for a follow-up decision, not resolved here: once the topic list
exists, it *is* the current-state view — sorted by activity, named, with unread
badges. The per-session cards may be redundant, in which case `/current-state`
collapses to the index alone.

With `threaded: true`, the worker resolves a thread before sending:

1. Look up `topics` by `session_id`.
2. Miss → reservation protocol → `createForumTopic`.
3. `state='closed'` → `reopenForumTopic`, set `state='open'`.
4. Changed `label` → `editForumTopic` (best-effort; failure keeps the old name).
5. Pass `message_thread_id` on `sendMessage`, `sendPhoto`, `sendDocument`.

`editMessageText` takes no thread id — messages are addressed by `chat_id` +
`message_id` chat-wide — so the multi-question wizard's in-place editing
(`daemon/src/worker/command-ingest.ts:170-201`) is unaffected. Verified.

Media already works: `sendPhoto`/`sendDocument` use `reply_to_message_id`
pointing at the just-sent text (`notifications.ts:272-273`), and a reply to a
message in a topic lands in that topic. Passing `message_thread_id` explicitly
is belt-and-braces.

**Stale thread recovery.** If a topic is deleted by hand in Telegram, the next
send fails with thread-not-found. The worker drops the stale `topics` row and
recreates rather than wedging that session permanently.

### Inbound

Resolution precedence in `webhook.ts`, highest fidelity first:

1. **Callback query** (`cmd:TOKEN:...`) — unchanged (`resolveCallbackSession`,
   `webhook.ts:364-386`).
2. **Explicit swipe-reply** — unchanged (`messages` lookup, `webhook.ts:319-357`).
3. **Topic membership** *(new)* — `(chat_id, message_thread_id)` → `topics` →
   `session_id`.
4. **`/cmd TOKEN`** — unchanged.

`TelegramMessage` (`webhook.ts:122-134`) has neither `message_thread_id` nor
`is_topic_message` today; the type must grow both.

**Service-message guard.** Inside a topic, a plain message often arrives with
`reply_to_message` pointing at the topic's own `ForumTopicCreated` service
message, whose id equals the `message_thread_id`. Step 2 must require
`reply_to_message.message_id !== message_thread_id`, or every message in a topic
is misread as a swipe-reply.

**[rev2] Correction on why swipe-reply outranks topic membership.** Revision 1
implied `notification_id` is load-bearing for answering questions. It mostly is
not: `command-ingest.ts:129` checks `pendingQuestions.getBySessionId` *before*
consulting metadata, so bare text typed in a topic during a pending question is
correctly routed as the custom answer, wizard steps included (`:165-168`).

The genuine residual gap: the metadata fallback (`command-ingest.ts:274-305`),
which rescues question replies after the daemon's `pending_questions` row is
gone (4-hour TTL, `schema.ts:7`), is unreachable for topic-routed messages
because topic membership carries no `notification_id`. In that state a bare
topic message is injected as a normal prompt into a session blocked on a
question — silently misdelivered, question still pending. **For questions older
than 4 hours, swipe-reply remains the only reliable answer path.** Swipe-reply
keeps precedence because it strictly dominates on information, not because the
common case depends on it.

Also worth stating: bare-typing in a topic makes accidental question-capture
easier than today, since *any* text in the topic during a pending question
becomes the answer.

Two UX wins remain:

- Typing a bare message in a topic sends it to that session.
- `/kill`, `/interrupt`, `/compact`, `/mcp`, `/model` work bare in a topic. They
  currently hard-require a swipe-reply (`resolveReplySession`,
  `webhook.ts:472-507`).

`/launch` stays global and answers in General. A `/launch`ed session's topic
appears on its first notification.

## Migration and rollout

The bot cannot create a supergroup or enable forum mode, so there is a one-time
manual step:

1. Create a supergroup → Settings → enable **Topics**.
2. Add the bot, promote to admin with `can_manage_topics`,
   `can_delete_messages`, `can_pin_messages`. Admin status also bypasses privacy
   mode, so no BotFather `/setprivacy` change is required.
3. Note the new chat id (negative, `-100…`).

Rollout is decoupled from that setup by a worker flag `TELEGRAM_TOPICS_ENABLED`:

1. Deploy worker + daemon with the flag **off**. Behavior identical to today,
   except Phase 0 titles now appear in headers and the outbox chunk-duplication
   bug is fixed.
2. Add the new supergroup id to `ALLOWED_CHAT_IDS` (`wrangler.toml:19`)
   **alongside** the existing `8248645256`, so in-flight notifications to the old
   DM do not start 403ing mid-flight.
3. Flip `TELEGRAM_TOPICS_ENABLED` on; update the `TELEGRAM_CHAT_ID` sops secret
   per machine; restart daemons (see the `cross-device-deployment` skill).
4. After burn-in, drop the old chat id.

Rollback at any point is reverting `TELEGRAM_CHAT_ID` to the DM. The `topics`
rows go stale harmlessly.

## Testing

Unit coverage for:

- topic create / rename / reopen / close / reap against a fake Telegram
- the reservation protocol under a simulated concurrent create
- the four-way inbound precedence, including the service-message guard
- General-fallback on non-429 topic failures; retry (not fallback) on 429
- stale-thread detection and recreate
- per-chunk notification ids, including `q:`-prefix parsing with a `:c{i}` suffix
- global outbox pause on `retry_after`
- `threaded: false` on `/current-state` cards skips topic resolution entirely
- `message_thread_id` round-trip: inbound → `commands` row → daemon
  `sendTelegramReply`
- title precedence in the daemon formatters

Then manual burn-in per the `daemon-cutover-burnin` skill, watching worker logs
for 429 frequency (the trigger for adding the deferred D1 send gate).

## Out of scope (YAGNI)

Slack; a proactive chat-level rate gate (deferred with a defined trigger);
per-machine supergroups; any change to the swarm IPC path.
