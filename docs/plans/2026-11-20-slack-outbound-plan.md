# Worker Slack outbound: implementation plan (bead pigeon-4ogz.3)

Spec: `docs/plans/2026-11-20-slack-transport-design.md` (§1, §3, §4, §7 worker side). Decisions
D1–D10 there are Jonathan's. This plan only fixes implementation choices the spec leaves open.
Builds on the seam from pigeon-4ogz.1 (`packages/worker/src/chat/`).

Everything stays **dark** until a `SLACK_WORKSPACE_<MACHINE>` secret exists: with no such secret
every code path below must behave exactly as today. **The Telegram test suite must pass
untouched** (do not edit existing tests; add new test files).

## Fixed choices

### Config (`src/chat/slack-config.ts`)
- Secret `SLACK_WORKSPACE_<MACHINE>` where `<MACHINE>` = machine id upper-cased, `-` → `_`.
  JSON `{teamId, appId, domain, botToken, userToken, signingSecret, ownerUserId}`. A secret that
  does not parse or misses a field is treated as **absent** (Telegram) and `console.error`ed
  once per isolate — never a throw on the request path.
- `slackWorkspaceForMachine(env, machineId)`, `slackWorkspaceForTeam(env, teamId)` (scans the
  `SLACK_WORKSPACE_*` keys of env), `slackChatId(ws) = "slack:" + teamId`.
- Env is read as `Record<string, unknown>`; add `SLACK_MARKDOWN_BLOCKS?: string` to `Env`.

### Schema (`src/d1-schema.sql`, idempotent; the test harness splits on `;`, so no `;` in comments)
```sql
CREATE TABLE IF NOT EXISTS slack_conversations (
  handle     INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (team_id, channel_id)
);
INSERT OR IGNORE INTO slack_conversations (handle, team_id, channel_id, created_at)
  VALUES (1099511627775, '_seed', '_seed', 0);
CREATE TABLE IF NOT EXISTS slack_posts (
  handle     INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  ts         TEXT NOT NULL,
  text       TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (team_id, channel_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_slack_posts_created ON slack_posts(created_at);
INSERT OR IGNORE INTO slack_posts (handle, team_id, channel_id, ts, text, created_at)
  VALUES (1099511627775, '_seed', '_seed', '_seed', NULL, 0);
```
The seed rows (2^40 − 1) make AUTOINCREMENT hand out ≥ 2^40 without touching `sqlite_sequence`
(D1-safe). The `slack_posts` seed row has `created_at = 0`, so the TTL sweep must skip
`team_id = '_seed'`. `SLACK_HANDLE_MIN = 2 ** 40`.

### Slack API client (`src/slack.ts`, the ONLY file that may contain `slack.com`)
- `callSlack(token, method, args)` POSTs `application/x-www-form-urlencoded` to
  `https://slack.com/api/<method>` (objects/arrays JSON-stringified as one field). Timed and logged
  like `callTelegram` (method + elapsed + outcome; never the token). A thrown fetch propagates (same
  as Telegram: the handler boundary/`bounded()` deals with it).
- Upload host (`files.slack.com` upload_url) is fetched here too.
- Result mapping onto `TgResult` (the seam is Telegram-shaped). Every failure's `response` is
  `{ok:false, error:<slack error>, errorClass, error_code, description}` so
  `getTelegramErrorDetails` yields it as `details`, and legacy daemons that read
  `details.error_code` keep working:

| Slack | kind | errorCode | errorClass |
|---|---|---|---|
| HTTP 429 on `chat.postMessage`, `chat.update`, files, archive, others | `rate_limited`, `retryAfter` = `Retry-After` header (s, default 1) | 429 | `rate_limited` |
| HTTP 429 on `conversations.create`, `conversations.rename`, `conversations.unarchive` | `error` | 503 | `upstream` (transient topic failure → `topic_unavailable` hold, never outbox-wide `retryAfter`) |
| `channel_not_found`, `is_archived` | `thread_not_found` (description `thread not found: <error>`) | 400 | `conversation_gone` |
| `invalid_blocks`, `invalid_blocks_format`, `msg_too_long`, `invalid_attachments`, `no_text`, `too_many_attachments`, `markdown_text_conflict` | `error` | 400 | `rejected_format` |
| `invalid_auth`, `not_authed`, `token_revoked`, `token_expired`, `account_inactive`, `missing_scope`, `fatal_error`, `internal_error`, `service_unavailable`, `request_timeout`, any HTTP 5xx, unparseable body, **any unlisted error** | `error` | 502 | `upstream` |

  Method-specific benign answers are mapped by the transport, not here: `name_taken`,
  `not_in_channel`, `already_archived` (→ ok), `not_archived` (→ `topic_not_modified`),
  `already_in_channel` (→ ok).
- Export `slackErrorClass(result)` / `errorClassOf(details)` for handlers.

### Rendering (`src/chat/slack-render.ts`, pure)
- `entitiesToRichText(text, entities)`: Telegram entities (UTF-16 offsets; `bold|italic|code|pre`;
  others ignored) → one `rich_text` block: `rich_text_section`s with styled `text` elements and
  `rich_text_preformatted` for `pre`. Overlaps/nesting supported by boundary segmentation.
- `keyboardToBlocks(replyMarkup)`: each `inline_keyboard` row → one `actions` block (≤ 25
  elements; a longer row is split). Callback button → `{type:"button", action_id:"b<r>_<c>",
  text:{type:"plain_text", text:<label ≤ 75 chars, code points, "…" when cut>, emoji:true},
  value:<callback_data>}`. URL button → same with `url` instead of `value`. At most 50 blocks total.
- `markdownBlock(md)` → `{type:"markdown", text}`; `SLACK_MARKDOWN_MAX = 12000`.
- `notifyOwner` → `<@U…> ` prefix on the fallback `text` and a leading `{type:"user"}` element in
  the first rich_text section (or a preceding section block for the markdown path).
- Fallback `text` escapes `& < >` (Slack mrkdwn), capped at 40 000.

### SlackTransport (`src/chat/slack-transport.ts`)
`createSlackTransport({db, ws, fetchFn?})` implements `ChatTransport`. Handles map to channels via
`slack_conversations` (scoped by `team_id`); a handle that is unknown for this team →
`thread_not_found`.
- `sendMessage` / `sendRichMessage`: `messageThreadId` undefined → the workspace's `#alerts`
  (`resolveAlertsChannel`). `chat.postMessage` with `blocks` + fallback `text`; on
  `not_in_channel` → `conversations.join` and retry once; on `is_archived` →
  `conversations.unarchive` (user token) then join+retry once (a failure of that → the mapped
  error of the unarchive; a 429 there is transient 503). On success: insert `slack_posts`
  (text ≤ 500 code points) and return `message_id = post handle`. `notifyOwner` applies when the
  option is set **or** the channel is a named channel of this team (any `named_topics` row with
  that handle — includes `_alerts`).
- `editMessageText`: `slack_posts` handle → `chat.update` (`channel`, `ts`, blocks, text).
- `sendPhoto` / `sendDocument`: files v2: `files.getUploadURLExternal` → POST bytes to
  `upload_url` → `files.completeUploadExternal` with `channel_id` and `thread_ts` (= the
  `replyToMessageId` post's ts, when given). Record a `slack_posts` row with `ts = "file:<id>"`
  and return its handle.
- `createForumTopic({name, sessionId?, channelKey?, topic?})` (new optional fields on
  `CreateForumTopicOptions`, ignored by Telegram): channel name = `slugify(channelKey)` when
  given, else `<slug>-<sid8>` (slug from the title part of `name` = text before the last
  ` · `, or the basename of the dir part when there is no title; `sid8` = 8 chars after the
  `ses_`/`gse_` prefix, lower-cased), else `slugify(name)`. `[a-z0-9-]`, collapsed, trimmed,
  ≤ 80 total, empty → `session`. `name_taken` → retry `-2`, `-3` … up to `-9`, then
  `create_failed` (400, `rejected_format`). Then `conversations.invite` the owner (ignore
  `already_in_channel`; other failures warn only), `conversations.setTopic` (≤ 250 code points:
  `topic` when given else `name` + ` · 🆔 <sessionId>` when sessionId), insert
  `slack_conversations`, return `{message_thread_id: handle, name: channelName}`.
- `editForumTopic({messageThreadId, name, sessionId?})`: `conversations.info` → if the computed
  channel name differs, `conversations.rename` (name_taken suffix as above); then `setTopic`.
- `closeForumTopic` → `conversations.archive` (`already_archived` → ok).
- `reopenForumTopic` → `conversations.unarchive` with the **user token** (`not_archived` →
  `topic_not_modified`).
- `deleteForumTopic` → archive (bots cannot delete). Used only for a lost-race duplicate.
- `unpinAllForumTopicMessages` → `{ok:true, result:true}`, no call.
- `resolveAlertsChannel`: `named_topics` row `(slack:<team>, '_alerts')`; else
  `conversations.list` (public, exclude archived, ≤ 5 pages of 200) for name `alerts` → join;
  else create `alerts` + invite owner; insert the row (name `alerts`). Concurrent first use:
  INSERT OR IGNORE, re-read.

`transportForChat(chatId, botToken, telegram?)` becomes
`transportForChat(chatId, ctx: {botToken; env?: Env; db?: D1Database; telegram?; slackFetch?})`
— or an equivalent keeping one function; every caller passes env/db. A `slack:` address whose
team has no configured workspace (or no env/db given) keeps the existing `SLACK_UNAVAILABLE`
guard (transient, never Telegram).

### Address resolution and authorization (`src/chat/address.ts`)
Principal = `authenticate()`'s result.
- `machineTransport(env, principal)`: machine principal with a workspace → `slack:<team>`, else
  `null` (Telegram).
- **Worker-resolved sends** (`/notifications/send`, `/topics/named`, `/topics/named/bind`): if
  the principal's machine is on Slack, the target chat is its `slack:<team>` whatever `chatId`
  the daemon sent. Otherwise the daemon's `chatId`, which must pass `ALLOWED_CHAT_IDS` as today;
  a `slack:` chatId from a non-Slack principal is 403 `chat_not_allowed`.
- **`/messages/send`, `/topics/unpin`** (stored conversations go where they live):
  - `slack:<T>` address: shared principal → 403. Principal's own team → allowed. Another team →
    allowed only with a thread and a `commands` row with that `(chat_id, message_thread_id)` and
    `machine_id` = principal; else 403. A `slack:` team with no configured workspace → 403.
  - numeric address from a Slack-machine principal: no thread → its `#alerts`; thread ≥ 2^40 →
    its workspace with that handle (old daemons that drop the returned `chatId`). Else Telegram
    as today.
  - The 200/`{ok:false, telegram:{status...}}` contract is kept; Slack failures also carry
    `errorClass` at top level.
- `/notifications/edit`: routed by the stored row; a Slack row needs a machine principal of
  that team (403 otherwise).
- `whoami` gains `transport: "slack" | "telegram"`.

### `/notifications/send` changes
- Target chat per above. Validation of `chatId` presence unchanged.
- `rich`: Telegram target sends rich only when `rich.dialect` is absent; Slack target only when
  `rich.dialect === "slack"`, `SLACK_MARKDOWN_BLOCKS !== "off"` and ≤ 12 000 code points; else
  plain. `TELEGRAM_RICH_MESSAGES` governs Telegram only.
- Pass `notifyOwner: body.notifyOwner === true` to the send options (Telegram ignores).
- Error responses (502/429) add top-level `errorClass` when the result came from Slack.
- `alertRelocation`: for a Slack target, post it into the same workspace's `#alerts`
  (unthreaded via the same transport); Telegram unchanged.
- `resolveTopic` gets `supersede: true` when the principal is the session's owning machine.

### `resolveTopic` supersede (spec §1)
When the existing row is in the **other transport** (`isSlackChatId(row.chat_id) !==
isSlackChatId(opts.chatId)`) and `opts.supersede`: CAS-delete it
(`deleteTopicBySession(db, sid, row.chat_id, row.message_thread_id)`), best-effort close the old
conversation through its own transport (never awaited into the result; errors logged), then
continue as if no row existed (reserve/create). Lost CAS → re-read once. Same-transport other chat
and any non-owner → `topic_in_other_chat` exactly as today. Create/edit calls pass `sessionId`.

### Named topics
- Caller paths (`/topics/named`, `/topics/named/bind`) refuse keys starting with `_` (400).
- Chat per the worker-resolved rule; responses already carry `chatId` — make it the resolved one.
- Slack create passes `channelKey: key` and `topic: name`.

### Other call sites
- `topic-rename.ts` editTopicName passes `sessionId`; works for Slack rows.
- `topic-reaper.ts`: reap — Slack rows drop the D1 row with no provider call. Close — archive via
  transport (already generic).
- Hourly cron: delete `slack_posts` with `created_at < now − 30 d` (not `_seed`), capped (e.g.
  5000/tick).
- `mention-links.ts` and `/topics/lookup`: per-transport URL builder: Telegram `-100…` →
  `t.me/c/...` (unchanged); `slack:<T>` + handle → `https://<domain>.slack.com/archives/<channel>`
  (join `slack_conversations`, domain from that team's workspace). `/topics/lookup` adds `url`
  (null when not buildable) to each entry.
- `poll.ts` refusal send and `sessions.ts` immediate close: pass env/db to `transportForChat`.

### Not in this bead
- Real mute via `users.prefs.set`: the .7 test has not run. Filed as a follow-up bead blocked by
  .7.
- Inbound (.4), daemon (.5), flip script (.6).

## Tasks (SDD)
1. Config, schema, `slack.ts` client + error table, whoami.transport, egress guard for slack.com.
2. `slack-render.ts`.
3. `slack-transport.ts` + `transportForChat` signature change across call sites.
4. `address.ts` + handler changes (`/notifications/send|edit`, `/messages/send`, `/topics/unpin`,
   named topics, `_` keys).
5. Supersede, sessionId pass-through, reaper, slack_posts TTL, URL builder (`mention-links`,
   `/topics/lookup`).
6. Docs: AGENTS.md Slack paragraph + `worker-architecture` skill.

Each task: TDD in a new test file `test/slack-*.test.ts` (fetchMock on `https://slack.com`),
`npm run --workspace @pigeon/worker test` and `typecheck` green, commit.

## Plan review deltas (adversarial-reviewer-opus, 2026-11-20) — these override the text above

1. **Unedited Telegram tests are the constraint**, so additions are Slack-only:
   - `transportForChat` stays positional: `transportForChat(chatId, botToken, telegram?, slack?)`
     with `slack = {env, db, fetchFn?}`. (`chat-seam.test.ts` calls it positionally.)
   - `/topics/lookup` adds `url` **only on Slack rows** (exact `toEqual` in `worker.test.ts`).
   - `whoami` adds `transport: "slack"` **only when the machine is on Slack**; absent = telegram.
     The daemon bead (.5) must read "absent in a 200" as telegram (distinct from unreadable).
   - `/messages/send` returns `chatId` only on the Slack path.
   - `_`-prefixed named-topic keys are refused only when the target is Slack.
2. **Supersede close is awaited with a 3 s bound** (no `ExecutionContext` reaches handlers), errors
   logged, never affecting the result. The T2.7 recreate `resolveTopic` call passes `supersede` too.
3. **Rollback residual (accepted, spec-consistent):** deleting the secret makes stored `slack:`
   conversations unreachable (`SLACK_UNAVAILABLE`, transient) — in-flight wizard edits and command
   replies retry until the outbox TTL, the old channel's supersede-close fails (logged). Noted on
   .6 for the flip script to consider.
4. Error table: `msg_blocks_too_long` → `rejected_format`. If `#alerts` answers
   `channel_not_found`, the transport drops the `_alerts` row and re-resolves once.
5. The archive URL builder `slackArchiveUrl(domain, channelId)` lives in `slack.ts`; the egress
   guard asserts `slack.com` appears only there.
6. `handleSendNotification` rebinds the target chat **once** at the top and uses it everywhere.
   For a Slack principal: skip `isAllowedChatId`, and do not require `chatId` (same in
   `/topics/named` and bind).
7. Pass `signal` through every Slack sub-call of one transport operation (`/messages/send` has a
   4 s bound).
8. Rendering: never emit an empty `text` element; entity-less text renders as one plain section;
   `unfurl_links=false`, `unfurl_media=false` on posts. `editForumTopic` skips `setTopic` when
   `conversations.info` shows the same topic, and skips `rename` when the name is unchanged.

## D7 revision (2026-11-20, design PR #231) — overrides every `notifyOwner` statement above

Slack pushes are OFF by default. The owner mention is no longer "always in a named channel or
`#alerts`, and whenever `notifyOwner` is set".

- New worker var `SLACK_NOTIFY_OWNER` (`Env`, optional): comma list of `questions`, `errors`,
  `named`, `alerts`; case-insensitive, trimmed, unknown entries ignored. Empty or unset = no
  mention at all. Documented as a comment in `wrangler.toml`; nothing is added to `[vars]`
  (`keep_vars = true`, default empty).
- `src/chat/slack-notify.ts`: `parseNotifyCategories(raw)` → `Set`, `explicitCategory(id)`
  (`q:` → `questions`, else `errors`), `shouldMention({categories, notifyOwner, notifyCategory,
  notificationId, conversationKind})`. Categories: explicit `notifyOwner` on a `q:` send →
  `questions`, other explicit → `errors`, `_alerts` row → `alerts`, other named row → `named`,
  session channel with no flag → never. Mention iff any applicable category is enabled.
- Transport: `createSlackTransport` takes `notifyCategories` (built from env in `transportForChat`);
  `isNamedConversation` became `conversationKind` (reads `named_topics.topic_key`). Send/edit options
  gain `notifyCategory?: "questions" | "errors"`; the `notifyOwner` boolean still works and maps to
  `errors`. `notifications.ts` passes the category derived from `notificationId`. Edits follow the
  conversation rule only (no flag on `/notifications/edit`).
- Never a broadcast: `slack-render` neutralises `<!channel|here|everyone|subteam…>` and bare
  `@channel`/`@here`/`@everyone` with a zero-width joiner in the fallback text and markdown
  blocks; rich_text carries only `text` and `user` elements (tested).
- Tests: `test/slack-notify.test.ts` (parser, decision table, transport matrix, broadcast);
  the old always-mention assertions in `slack-transport` and `slack-routing` tests now run with the
  categories they need. `users.prefs.set` is still never called.

