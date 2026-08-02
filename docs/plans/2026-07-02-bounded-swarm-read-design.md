# Bounded swarm_read (design)

Date: 2026-07-02
Bead: (none yet — file if promoted)
Scope:
- `packages/daemon/src/storage/swarm-repo.ts` (`getInbox`)
- `packages/daemon/src/app.ts` (`GET /swarm/inbox` handler)
- `packages/opencode-plugin/src/swarm-tool.ts` (tool schema, `swarmRead`, `formatInbox`)
- workstation: `swarm-messaging` skill doc (Replay section)

## Problem

`swarm_read` returns the **entire** delivered inbox for a session in one shot —
no `LIMIT`, no pagination, no size cap, full payloads. `getInbox`
(`swarm-repo.ts:148-170`) runs
`SELECT * ... WHERE to_session=? AND state='handed_off' ORDER BY msg_id ASC` with
no bound, the route (`app.ts:186-205`) maps every row to JSON, and `formatInbox`
(`swarm-tool.ts:74-87`) renders every payload untruncated.

Retention that would have bounded this is **wired in name only**: `cleanupOlderThan`
(`swarm-repo.ts:172-180`) and `SWARM_RETENTION_MS = 7 days` exist but are **never
called** — the hourly cleanup timer prunes only the outbox. So `swarm_messages`
rows accumulate indefinitely. The `swarm_read` docstring's claim of "default 7
days" retention is false.

The only narrowing is the optional `since` msg_id cursor — but a session that
compacted/resumed has **no memory of the last msg_id it saw**, so it calls
`swarm_read()` bare and gets everything.

Evidence (observed): a warm-standby coordinator resuming weeks after its first
activity called `swarm_read`, received **331,262 bytes** of mostly-stale June
history (truncated by the tool-output layer), and had to burn a turn delegating
to an `explore` subagent just to extract the recent tail. The firehose actively
degrades the resuming session.

## Decision: count-bounded read with a truncation breadcrumb

A bare `swarm_read()` returns the **N most recent** delivered messages (default
**25**) instead of all history. When the read is truncated, the output carries a
**breadcrumb** telling the agent how many messages exist, how many are shown, and
the cursor to resume from — so it can page deliberately (or skip the firehose
because it can see nothing is new) instead of guessing.

### Why count, not time

The failure mode is context **volume**. A time window (`last 24h`) does not bound
volume — an active track can produce hundreds of messages in a day. A count
(`limit=N`) hard-caps the item count regardless of how chatty the swarm was.
Count-only is the load-bearing guardrail; a time param was considered and
deliberately dropped (see Out of scope).

### Why the default lives in the daemon route (not the plugin)

Two consumers hit `/swarm/inbox`: the `swarm_read` tool and the `curl` example in
the skill. Applying `DEFAULT_INBOX_LIMIT = 25` **server-side in the route** means:

- Every HTTP caller is bounded, including raw `curl`.
- The context-bound benefit lands on **daemon restart alone** — even for the
  currently-deployed plugin that never sends a `limit` param. This matters because
  the plugin only reloads on a disruptive serve-pool restart (pool 4096–4099; see
  `2026-06-24-swarm-send-sender-retry-design.md` "Deploy caveat"). Old plugins get
  bounded `messages` immediately; they silently ignore the new `total` field, so
  they lose only the breadcrumb — strictly better than the firehose.

The `limit` **arg** on the tool and the **breadcrumb** rendering require the plugin
reload to take effect. Acceptable degradation in the interim.

## Contract changes

### 1. Storage — `getInbox`

Change signature from `getInbox(toSession, sinceMsgId)` returning an array to an
options object returning messages plus the total:

```ts
getInbox(
  toSession: string,
  opts: { since?: string | null; limit?: number | null } = {},
): { messages: SwarmMessageRecord[]; total: number }
```

- `messages`: `SELECT * ... WHERE to_session=? AND state='handed_off'
  [AND msg_id > @since] ORDER BY msg_id DESC LIMIT @limit`, then **reversed to ASC**
  in JS so the result is the *most recent N* but still presented chronologically
  (oldest→newest, matching today's ordering).
- `total`: `SELECT COUNT(*)` over the same `WHERE` (minus `LIMIT`). Indexed by
  `idx_swarm_inbox (to_session, state, msg_id)`, so it's cheap. Needed for the
  breadcrumb.
- `limit == null` → no `LIMIT` clause (full-history path; used only when a caller
  explicitly asks for everything).
- `since` semantics unchanged: exclusive `msg_id > since`. `since` + `limit`
  compose as "the N most recent messages that are newer than `since`".

`getInbox` has a single production caller (`app.ts:190`), so the return-shape
change is low blast radius. `swarm-repo.test.ts` cases that expect an array get
updated.

### 2. Route — `GET /swarm/inbox`

- Parse `?limit=`. Absent → `DEFAULT_INBOX_LIMIT` (25). Present → parse as a
  positive integer. Non-numeric or `<= 0` → `400 { error: "limit must be a
  positive integer" }`. No hard upper cap (a caller who wants everything passes
  `limit=<total>`, which the breadcrumb tells them).
- Call `getInbox(sessionId, { since, limit })`.
- Response gains `total` and `returned` alongside the unchanged `messages` array:

  ```json
  { "messages": [ ... ], "total": 340, "returned": 25, "limit": 25 }
  ```

  `messages` shape is unchanged, so existing readers keep working.

### 3. Tool — `swarm-tool.ts`

- Add optional `limit` arg to the schema next to `since`:
  `tool.schema.number().int().positive().optional()`, described as
  "Max number of most-recent messages to return (default 25). Pass the `total`
  from a truncation note to fetch everything."
- `swarmRead(opts, { since?, limit? })` forwards `limit` as a query param and
  parses the richer response body (`{ messages, total, returned, limit }`),
  returning it (not just `messages`) so `formatInbox` can render the breadcrumb.
- `formatInbox(messages, meta)` appends a breadcrumb **only when
  `meta.total > messages.length`**:

  ```
  [showing the 25 most recent of 340 delivered messages — 315 older hidden.
   Pass limit=340 to include them. Newest msg_id: msg_xxx — pass as since= next
   time to fetch only newer.]
  ```

  The "newest msg_id" doubles as the cursor a compacting session should persist in
  its resumption prompt. When not truncated, no breadcrumb (behavior identical to
  today apart from ordering being the recent tail).
- Fix the false "default 7 days" retention claims in the file header (lines 15-18)
  and the tool `description` (lines 96-99): describe the count default + breadcrumb
  instead.

## Error handling

- Missing `session` → `400` (unchanged).
- Malformed `limit` (non-numeric, zero, negative) → `400` with a clear message.
- `since` pointing at an unknown/old msg_id → returns whatever is `> since`
  lexicographically (unchanged, no error).

## Testing (TDD; extend existing suites)

- `packages/daemon/test/swarm-repo.test.ts`
  - returns the N most recent in chronological (ASC) order for `limit < total`
  - `total` reflects the full matching count, not the returned count
  - `since` + `limit` compose (N most recent that are newer than cursor)
  - `limit == null` returns full history (regression guard for the escape path)
- `packages/daemon/test/swarm-routes.test.ts`
  - absent `limit` → defaults to 25; response includes `total`/`returned`
  - explicit `limit=N` honored
  - malformed `limit` → 400
- `packages/opencode-plugin/test/swarm-tool.test.ts`
  - tool forwards `limit` as a query param
  - `formatInbox` renders the breadcrumb (with count + newest msg_id) when
    truncated, and omits it when `total == returned`

## Out of scope (deliberate)

- **Retention / cleanup (Option B).** Wiring `cleanupOlderThan` into the hourly
  timer is a separate, higher-risk change (it *deletes* history). Filed as a
  follow-up; this change bounds the *read* without touching the store.
- **Time-based `hours` / `since_time` param.** Count-only is sufficient for the
  volume problem; a time param can be added later if a real need shows up.
- **Cursor auto-persistence across compaction.** The breadcrumb *surfaces* the
  cursor; teaching the warm-standby protocol to persist it is a workstation
  skill-level follow-up, not a pigeon change.
- **Unbounded "all" sentinel.** No `limit=all`; the breadcrumb's `total` lets a
  caller pass `limit=<total>` to fetch everything. Avoids the "0 means all"
  foot-gun.

## Deploy notes

- Daemon changes (route default + `getInbox`) take effect on `pigeon-daemon`
  restart → immediate context-bound for all callers.
- Tool changes (`limit` arg, breadcrumb, docstring fix) require a serve-pool
  reload (pool 4096–4099) to load the updated plugin. Land together; the daemon
  half is safe to ship independently and degrades gracefully for old plugins.
