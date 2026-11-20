# Slack as pigeon's chat transport (chat-transport phase 2)

Status: design, 2026-11-20. Bead `pigeon-4ogz`. Decisions D1–D9 are Jonathan's (2026-11-20).
Phase 1: `docs/plans/2026-11-20-telegram-single-egress-design.md` (epic `pigeon-lenr`).

## Goal

Every human-facing surface pigeon has on Telegram moves to Slack, and Telegram is then deleted.
Each machine (devbox, cloudbox, macbook) gets its own personal Slack workspace. A session is a
channel. The worker stays the only ingress and the only normal egress; daemons keep polling D1.

## Decisions (Jonathan, 2026-11-20)

| # | Decision |
|---|---|
| D1 | Personal Slack, not the company workspace. No IT approvals involved. |
| D2 | **One workspace per machine**: devbox, cloudbox, macbook. Machine = workspace. |
| D3 | Full cutover. Telegram is removed at the end; no permanent Telegram fallback. The daemon's direct-fallback alarm posts directly to Slack. |
| D4 | Events API into the Cloudflare worker (HTTP). No Socket Mode. |
| D5 | Owner-only, as now. |
| D6 | **One channel per session.** Rename = channel rename; close = archive; plain messages in the channel go to the session; native slash commands work there. stall-watch named topics become named channels. |
| D7 | Notifications: Jonathan sets each workspace's preference to "All new messages"; pigeon additionally @-mentions him on questions and error-severity alerts. |
| D8 | Per-workspace `#alerts` (Telegram's General). `#em-alerts` in the devbox workspace for the eternal-machinery monitors, fed by a separate app/incoming webhook (no pigeon credential). healthchecks.io moves to its built-in Slack integration (Jonathan, in its UI). |
| D9 | Cutover per machine: the worker picks the transport per machine; devbox → cloudbox → macbook; Telegram code deleted after all three. A flipped machine's live sessions get a fresh channel on their next notification; no history migration. Three Slack apps generated from one manifest in the repo, one per workspace (no OAuth distribution). Slash commands keep their names (except `/rename`, a Slack built-in: `/title`, §2). |

## Design

### 1. Shape: the address decides the transport

`packages/worker/src/chat/` gets a `ChatTransport` interface with two implementations:
`telegram` (today's code moved behind it, no behaviour change) and `slack`.

- **Workspace config is a worker secret per machine.** `SLACK_WORKSPACE_<MACHINE>` (e.g.
  `SLACK_WORKSPACE_DEVBOX`) holds JSON `{teamId, appId, domain, botToken, userToken,
  signingSecret, ownerUserId}`. Present → that machine is on Slack; absent → Telegram.
- **Chat addresses carry the transport.** A Slack workspace's chat id is the string
  `slack:<teamId>`; Telegram chat ids stay numeric. Two rules decide where a call goes:
  - **A stored conversation goes where it lives.** An edit (by `notificationId`), a command reply
    (the command's `chatId` + thread/handle), a send to a handle the worker returned: routed by
    that address. So an edit, a button or a reply to a Telegram post made before the flip still
    goes to Telegram afterwards, and vice versa.
  - **Anything the worker resolves itself uses the machine's transport now** (is the secret
    present?), never the daemon's `chatId`: a session's topic/channel, a named-topic resolve or
    bind, and General-addressed sends (a numeric `chatId` with no thread → that machine's
    `#alerts`). The daemon's configured Telegram chat id is cached in several places
    (`outbox-sender.ts:307`, `index.ts:576,950,974,1326`, the poller), and a stale value must not
    be able to pull a session back to Telegram.
- **Slack conversations get integer handles,** so every existing contract field and D1 column that
  holds a Telegram thread id (`messageThreadId`, `commands.message_thread_id`,
  `topics.message_thread_id`, `named_topics.message_thread_id`) holds a Slack conversation without a
  type change. Side table `slack_conversations(handle INTEGER PK AUTOINCREMENT, team_id, channel_id,
  UNIQUE(team_id, channel_id))`. Likewise Slack posts get an integer `message_id`: side table
  `slack_posts(handle INTEGER PK AUTOINCREMENT, team_id, channel_id, ts, text, UNIQUE(team_id,
  channel_id, ts))`, with `text` (≤ 500) kept for reply context (§5), and a 30-day TTL in the
  hourly cron (rows not tied to a session are otherwise never deleted). Both sequences are seeded
  at 2^40 (`sqlite_sequence`), out of reach of Telegram ids, so any mix-up of a handle with a
  Telegram thread or message id misses instead of hitting another conversation.
- **Slack rows live in the existing tables** (`topics`, `named_topics`, `named_topic_bindings`,
  `messages`, `commands`) under `chat_id = 'slack:<team>'`. Every existing query, join, dedup
  (`notificationId`), CAS, the orphan closer and mention-links then work across both transports;
  only the calls to the provider differ. The final Telegram deletion removes Telegram rows, not
  tables.
- **Flip = put the secret; rollback = delete it** (plus the binding batch, §3). The daemon needs
  no chat id of its own for Slack: the worker resolves it. `GET /whoami` gains `transport`, which
  the daemon uses only for its alarm path, `rich.dialect` and `launchCapable` (§6); it re-reads it
  every 60 s and persists the last value in SQLite, and an unreadable `whoami` keeps the last value
  (never "assume Telegram").
- **Authorization of a `slack:` address.** Requires a machine principal (the shared key is refused
  for `slack:` addresses). Session-bound sends must be for a session whose conversation the worker
  resolves in the principal's current workspace. A `/messages/send` to a `slack:` address + handle
  from a principal of another machine is honoured only when a `commands` row from the last 24 h has
  that `(chat_id, message_thread_id)` and `machine_id` = the principal (a command reply goes where
  the command was typed, e.g. `/launch` typed in devbox's workspace targeting cloudbox). Handles are
  sequential, so without this any machine key could post into any channel. `ALLOWED_CHAT_IDS` keeps
  governing numeric ids.
- **The transport switch of a live session.** Today a `topics` row in a chat other than the
  requested one is `topic_in_other_chat` (`pigeon-533h`) and the notification goes unthreaded.
  New rule: when the requester is the session's **owning machine** and the row is in the other
  transport's chat, the row is **superseded toward the machine's current transport** (and only that
  direction): replaced by a fresh conversation, the old one closed best-effort. A foreign machine
  still gets `topic_in_other_chat`. This gives a flipped machine's live sessions a channel on their
  next notification (D9), and rollback is symmetric.
- **Every topic CAS is scoped to `chat_id`.** `finalize` today matches `session_id AND
  message_thread_id IS NULL` (`topics.ts:222-241`); `deleteBySession` and `stealReservation` are
  unscoped too. A Telegram create that finishes (57 s is possible, `pigeon-iqpd`) after a supersede
  would otherwise write its thread id into the Slack row. So `finalize`, `deleteBySession`,
  `steal`, the loser's cleanup and the supersede itself are CASes on the observed
  `(session_id, chat_id, message_thread_id)`.
- **Contract naming stays Telegram-shaped until Telegram is gone** (`text`+`entities`,
  `replyMarkup.inline_keyboard`, `urlButtons`). The worker translates those mechanically (§4). What
  the worker cannot translate is pre-rendered dialect, so three things are neutralized now: the
  address (above), the rich markdown and link URLs (§7).

### 2. Slack apps and workspaces

- One manifest template in the repo (`packages/worker/slack/manifest.template.json`) and a
  script that renders it per machine. Runbook `docs/runbooks/slack-workspace-setup.md`. Jonathan
  (or an agent with his explicit go-ahead) creates the workspace, creates `#alerts`, creates the
  app from the rendered manifest, installs it (choosing `#alerts` for the incoming webhook), and
  stores the credentials.
- **Bot scopes:** `chat:write`, `channels:manage`, `channels:read`, `channels:history`,
  `channels:join`, `commands`, `files:read`, `files:write`, `incoming-webhook`.
  **User scope:** `channels:write`, used only for `conversations.unarchive`, which bot tokens cannot
  call (Slack docs).
  **Events:** `message.channels`, with **Delayed Events** on (hourly retries for 24 h).
  **Interactivity:** on. **Slash commands:** `/launch /kill /interrupt /compact /title /mcp /model
  /tag`. `/rename` is a Slack built-in, so the rename command is **`/title`** on Slack (Telegram keeps
  `/rename`); this is the one exception to D9's "keep the names".
- **Request URLs, per machine:** `/slack/<machine>/events`, `/slack/<machine>/interactivity`,
  `/slack/<machine>/commands`. The path picks the workspace config; the signature is checked
  against that workspace's secret before parsing, then `team_id` and `api_app_id` must match it.
- Channels are **public** (single-member workspace). The bot creates them and invites the owner.
- Free plan: 90 days of visible history, 10 integrations per workspace (pigeon 1; devbox also
  em-alerts). Bots cannot delete channels.

### 3. Conversations

**Session channel.** Created lazily on the session's first notification, as topics are (same
reserve/finalize CAS, same `topic_unavailable` hold).
- **Name:** `<slug>-<sid8>`, `[a-z0-9-]`, ≤ 80; `slug` from the title, or the directory basename
  while provisional. `name_taken` (archived channels keep names; Jonathan may make channels; ids
  are time-prefixed) → retry with `-2`, `-3`, …. **Topic** (`setTopic`, 250): `title · ~/dir ·
  🆔 <session id>`.
- **Provisional title upgrade** (`pigeon-353p`), `/title` and `/topics/rename`:
  `conversations.rename` + `setTopic`.
- **Close = archive**, keeping today's orphan rule, 7-day idle and the daily 04:00 UTC tick
  (sessions vanish and come back routinely; the window is the grace). **Reopen = unarchive** with
  the user token, then post. Reap after 30 days: drop the row, no provider call.
- **Gone:** `channel_not_found` / `is_archived` on a send = Telegram's `thread not found`
  (unarchive or recreate once). `not_in_channel` → `conversations.join`, retry once.

**Named channels** (`/topics/named`, `/alert topic`): a `named_topics` row under `slack:<team>`
with a handle; channel name from the key (`stallwatch:chat-transport` →
`stallwatch-chat-transport`, `name_taken` → suffix), topic = the given `name`. Bindings stay in
`named_topic_bindings`; the existing joins work because both sides use the same chat id.
`/topics/named` and `/topics/named/bind` already return `messageThreadId`; they now also return
`chatId` (resolved from the machine's current transport, §1), and the daemon uses the returned one
for the send that follows. Keys with a leading `_` are reserved: caller paths (`/alert topic`,
binds) reject them.

**Flip and unflip move bindings explicitly.** `named_topic_bindings` is `UNIQUE(session_id)`, and a
coordinator's own notifications go through `getBindingForSession`, never through a key resolve, so
carry-over cannot be lazy. The flip runbook step is a D1 batch: for each binding whose session
belongs to the machine, ensure the Slack named channel exists (or create on first use) and
re-point the binding's `chat_id` to `slack:<team>`. Unflip is the inverse batch. Both are a script
in the repo (`scripts/slack-flip.ts <machine> on|off`) that also puts or deletes the secret, and
both directions are tested.

**`#alerts`**: a `named_topics` row with reserved key `_alerts`, found by name (the runbook creates
it, so the incoming webhook can target it). It takes everything that goes to General today: `/alert`
without a topic, relocations, quiet-session questions (`threaded: false`), remote-launch notices,
`topic_in_other_chat` posts.

### 4. Outbound rendering

| Daemon sends | Slack gets |
|---|---|
| `text` + `entities` (`bold|italic|code|pre`, `telegram-message.ts:11`) | `rich_text` block, 1:1; `text` as the notification fallback |
| `rich.markdown` with `rich.dialect: "slack"` (§7) | `markdown` block (≤ 12 000 chars, renders tables); over the limit or rejected → the `rich_text` path. Kill switch var `SLACK_MARKDOWN_BLOCKS=off`. A `rich` without `dialect` (Telegram dialect) is never sent as a markdown block on Slack: plain path. |
| `replyMarkup.inline_keyboard` callback buttons | `actions` blocks (≤ 25 elements each), `value` = callback data, label truncated to 75 chars |
| URL buttons (`/alert links`, mention-links, `urlButtons`) | `button` with `url`; its interaction payload is acked and ignored |
| `media[]` | `files.getUploadURLExternal` → upload → `files.completeUploadExternal` with `channel_id` + `thread_ts` of the text post |
| `/notifications/edit` | routed by the stored post's chat id: `chat.update` by `ts` for Slack |
| `notifyOwner` (§7) | `<@ownerUserId>` at the start of the fallback text and the first block |
| `/topics/unpin` on a Slack address | successful no-op (no auto-pin) |

Every Slack post is recorded in `slack_posts` (with its text), including `/messages/send` posts,
which on Telegram get no `messages` row; that is what lets a thread reply to a digest or an alert
carry `inReplyTo` (§5).

**Links:** `https://<domain>.slack.com/archives/<channel>` (`domain` from the workspace secret),
from both mention-links (their query covers Slack rows, but `topicUrl` accepts only `-100…` chats,
`mention-links.ts:59-63`, so it gets a per-transport URL builder) and `/topics/lookup`, which gains a `url` field the
daemon's `alert-links.ts` prefers over building `t.me` URLs. Works across workspaces. iOS
behaviour (opens the app, not a browser) is a devbox live check.

**Splitting:** the daemon keeps 4096; Slack accepts it.

**Slack error classification** (Slack answers HTTP 200 `ok:false` plus a string; HTTP 429 with
`Retry-After` for rate limits):

| Slack | Class (§7) | Worker does |
|---|---|---|
| `invalid_auth`, `token_revoked`, `account_inactive`, `missing_scope` | `upstream` | 502; never relocate. The daemon's alert path falls back direct, so a dead token is loud |
| `channel_not_found`, `is_archived` | `conversation_gone` | unarchive or recreate once, as `thread not found` |
| `not_in_channel` | — | join, retry once |
| `invalid_blocks`, `msg_too_long`, `invalid_attachments` | `rejected_format` | daemon resends plain (existing `strip_entities` rule) |
| 429 on `chat.postMessage` | `rate_limited` | `retryAfter` as today |
| 429 on `conversations.create` / `rename` / `unarchive` | — | transient topic failure → per-session `topic_unavailable` hold, **not** the outbox-wide `retryAfter` (the flip itself is a burst of creates) |
| `fatal_error`, `internal_error`, timeout | `upstream` | "may have posted": 502, like a Telegram 5xx |

### 5. Inbound

All three endpoints verify `X-Slack-Signature` (HMAC-SHA256 of `v0:<ts>:<body>`, ±5 min),
`team_id`/`api_app_id`, and the owner (`user == ownerUserId`, else dropped silently, on all three).

- **Events** (`message.channels`): `url_verification` answered. The D1 work is done **inline** (it
  takes milliseconds): one batch that inserts `slack_seen_events(event_id)` and the command. A
  conflict on `event_id` is a duplicate → 200; any other D1 failure returns 5xx so Slack retries; only media download runs in `ctx.waitUntil` (30 s cap).
  Ignore `bot_id`, our bot user, and subtypes other than none, `file_share` and `thread_broadcast`.
  - **Session resolution, in this order** (Telegram's swipe-reply also comes first,
    `webhook.ts:558`): (1) thread reply: `thread_ts` → `slack_posts` → `messages` → its session
    (and `questionRequestId` for a `q:` post); (2) channel → `topics` → session; (3) channel → bound
    named channel → session (plain messages only); (4) named channel → rate-limited hint.
  - **Reply context:** any thread reply whose parent is in `slack_posts` gets `inReplyTo` = the
    parent's text (≤ 500), whether or not the parent belongs to a session, as Telegram gives it for
    any bot message (`webhook.ts:941-951`). If the parent is not recorded, `conversations.replies`
    fetches it, bounded at ~1 s; past that `inReplyTo` is left out, so the 3 s ack holds. `inReplyToQuote` is always absent (Slack has no partial quote).
  - **Forwarded:** a shared-message attachment → `forwarded: true`.
  - **Files:** `files[]` → `url_private_download` with the bot token → R2, same `MediaRef`.
  - `senderId` = the Slack user id (see §6, allowlist).
- **Slash commands:** the command row is written inline and answered in the HTTP response
  (`in_channel`); on failure the response says so (commands are not retried). `channel_id`
  resolves the session as a topic does; `/tag <id> <tag>` and `/launch` work anywhere. Because
  commands do not work in threads, and `#alerts` and named channels have no session,
  `/kill /interrupt /compact /mcp /model` accept an optional leading `<session-id>` (also useful on
  Telegram): a full id or a unique prefix (coordinators write prefixes); an ambiguous prefix is
  refused with the candidates, since `/kill` is destructive. The parsers are extracted from `webhook.ts` and shared. Daemon replies arrive by
  `/messages/send` to the command's `chatId` + handle.
- **Interactivity** (`block_actions`): `value` parsed exactly as `callback_data` is today;
  answered with an empty ack; the wizard's `chat.update` is the feedback.

### 6. Daemon

- **Direct-fallback alarm:** `direct-slack-alarm.ts` posts to the workspace's incoming webhook for
  `#alerts` (`PIGEON_SLACK_ALARM_WEBHOOK_URL`). It can post to one channel only, which is narrower
  than the bot token the daemon holds today. Same worker-first ladder, suffix and throttled health
  alert as phase 1. The daemon picks the alarm for its current `whoami.transport`; before the first
  successful `whoami` it uses whichever direct path is configured (Slack first). Guard test:
  `hooks.slack.com` appears only in that file (and `api.telegram.org` only in the Telegram one,
  until deleted).
- **`launchCapable`**: worker credentials, an opencode client, and an alarm path for the current
  transport; `TELEGRAM_*` no longer required on a Slack machine. Computed per poll from the
  persisted `whoami.transport`, not once at startup (`index.ts:496`), so a flip needs no restart.
- **Owner allowlist:** `PIGEON_PULL_ALLOWED_USER_IDS` is compared against `senderId`
  (`goose/adapter.ts:82-88`, `adapters/goose-pull.ts:86`). Each workspace's Slack user id is added
  to its machine's list **before** that machine flips (workstation PR), keeping the Telegram id
  until the deletion. Without it every bound coordinator refuses replies after the flip. devbox's
  list is empty today, so it gets set for the first time.

### 7. Daemon↔worker contract: additive neutral fields

- **`whoami.transport`** (§1, §6); `/topics/named(/bind)` return `chatId`.
- **`/topics/lookup` returns `url`.**
- **`rich.dialect`**: the daemon's `rich-markdown.ts` produces Telegram dialect today (copy-text
  buttons as `<tg-button>`, `\$ \= \| \!` escapes, `&lt;`), which Slack would show literally. When its
  persisted `whoami.transport` is Slack, the daemon renders standard GFM instead (no `tg-button`;
  code spans for copyable ids; Slack's escapes only) and sends `dialect: "slack"`. Goose turns are
  always rich, so this is not optional. The outbox stores the payload at enqueue time, so a flip can
  put either dialect in front of either transport: the worker sends `rich` only when its dialect
  matches the target (absent = Telegram), and otherwise takes the plain path, which is always
  present.
- **`notifyOwner: true`** on questions and error-severity alerts (D7); ignored by Telegram.
- **`errorClass`** in worker error responses (§4 table). The daemon prefers it and falls back to
  today's `details.error_code` / description, so either deploy order is safe.

Pull-inbox rows keep `source: "telegram-reply"` (stall-watch, lanes, honk filter on it); renamed in
a coordinated cross-repo change after the deletion.

### 8. Outside pigeon

- **em-* monitors (`pigeon-lenr.4`, devbox):** incoming webhook to `#em-alerts` from a separate
  devbox-workspace app ("em-alerts"), sops `em_alerts_slack_webhook`. `tg_send` → `slack_send` (JSON
  `{text}`, same 4096 cap, same healthchecks.io failure contract; tests pinning the Telegram URL
  change with them). Workstation PR.
- **healthchecks.io:** switch its integrations to Slack (Jonathan, UI).
- **stall-watch / agent-wait / lanes (eng-agent-platform):** contract unchanged, nothing breaks at
  the flip. Follow-ups: "Telegram topic" wording in coordinator prompts and the `sw` skill; pacing
  and 4000-char parts can relax; `in_reply_to_quote` is now always empty. A bead in that repo.
- **honk:** "Telegram" wording and `honk telegram`. A bead in honk.
- **workstation:** per-machine daemon env and secrets (`PIGEON_SLACK_ALARM_WEBHOOK_URL`,
  `PIGEON_PULL_ALLOWED_USER_IDS`); skills that say "Telegram topic" / "swipe-reply"; at the end,
  removing Telegram secrets.

### 9. Rollout

The bead graph under `pigeon-4ogz` is authoritative.

1. **Worker seam refactor** (no behaviour change): `ChatTransport`, Telegram behind it, command
   parsers extracted, optional `<session-id>` on session commands.
2. **Manifest + setup runbook + flip script**, in parallel with 1.
3. **Worker Slack outbound** (§1, §3, §4) and **worker Slack inbound** (§5), on the seam; dark
   until a `SLACK_WORKSPACE_*` secret exists. `whoami` reports `transport: telegram` until then.
4. **Daemon** (§6, §7): `whoami.transport` re-read and persisted, named-topic `chatId` used, `rich.dialect`, `notifyOwner`, `errorClass`,
   `url` links, Slack alarm, `launchCapable`. Deploy worker before daemons (all additive). The
   Telegram suite must pass untouched throughout.
5. **devbox:** Jonathan's go-ahead → workspace + app per runbook → workstation PR (alarm webhook,
   allowlist) → `slack-flip devbox on`. Live checks: notification creates a channel; typed message
   injects; `/kill` in a channel and `/kill <id>` in `#alerts`; question button; wizard edit; photo
   each way; `/title`; archive + unarchive; goose turn renders markdown and a table; `/alert` with
   links (iOS link opens the app); a devbox coordinator channel receives and answers; direct alarm
   with the worker blocked. **Rollback:** `slack-flip devbox off`.
6. **em-alerts** (`pigeon-lenr.4`), after 5.
7. **cloudbox**, same as 5 (the main coordinator check: work programs live there); then
   **macbook** (needs a Mac session for Keychain items).
8. **Soak:** a week with all three on Slack.
9. **Delete Telegram:** client, webhook, Telegram rows, vars and secrets, daemon Telegram alarm and
   config, contract renames, docs and skills; then the cross-repo `telegram-reply` rename. **No
   rollback past this step.**

### Verification (per PR, besides the live checks)

- Worker: signature (bad, stale, other workspace's path, mismatched `team_id`/`api_app_id`); event
  dedup and inline-failure 5xx; filters; owner gate on all three endpoints; resolution order incl. a
  thread reply to a quiet question in `#alerts` and to a digest in a named channel; commands by
  channel and by `<session-id>`; button → token; each rendering row; markdown fallback and
  dialect-less `rich`; each error-class row; create 429 → hold, not `retryAfter`; `name_taken`
  suffix; unarchive on reopen; supersede rule both directions vs `topic_in_other_chat` for a
  foreign machine;
  CAS scoping (a late Telegram finalize after a supersede must not touch the Slack row); a stale
  daemon `chatId` cannot pull a flipped session back; `slack:` address auth (shared key refused;
  cross-machine `/messages/send` only with a matching recent command row); `_`-prefixed keys
  refused; `slack_posts` TTL; edit routed by stored chat; dedup across the flip; flip/unflip
  binding batches; Telegram behaviour unchanged with no Slack secret.
- Daemon: `whoami.transport` re-read and persisted (unreadable keeps the last value); per-poll
  `launchCapable`; named-topic `chatId` from the worker used; `rich.dialect` Slack rendering (no `tg-button`,
  no Telegram escapes); `errorClass` preferred, legacy honoured; `notifyOwner` only on questions
  and error alerts; Slack alarm ladder via the composed notifier; guard tests.

## Out of scope

Migrating Telegram history; Enterprise features; a distributed app; Socket Mode; message
shortcuts (a possible later "act on this message" path); the plugin's `stripMarkdown`; raising the
4096 split.

## Open items (not blocking)

- Channel slug details (emoji stripping, length budget) are an implementation choice.
- Whether `/launch` creates the new session's channel at once so the confirmation can link to it.

## Appendix: inventory of what depends on Telegram (HEAD 71f2050)

### Inside pigeon

- **Egress** is only `worker/src/telegram.ts` (14 methods) and daemon
  `direct-telegram-alarm.ts`, guard-tested. Methods used: sendMessage, sendRichMessage,
  editMessageText (question wizard), sendPhoto/sendDocument (reply-to + thread),
  answerCallbackQuery, getFile/downloadFile, create/edit/close/reopen/deleteForumTopic,
  unpinAllForumTopicMessages.
- **Ingress** `POST /webhook/telegram` (secret header, `seen_updates` dedup). Handles `message`
  and `callback_query`. Session resolution order: swipe-reply (`messages` by chat+message id) →
  topic (`topics` by thread) → bound named topic → `/cmd TOKEN` token. Slash commands
  `/launch /kill /interrupt /compact /rename /mcp /model /tag`, `@BotName` suffix rules. Owner
  checks: `ALLOWED_CHAT_IDS`, `ALLOWED_USER_IDS`, daemon `PIGEON_PULL_ALLOWED_USER_IDS`
  (Telegram user id). Forward detection, `quote.text`, `rich_message` reply context.
  Callback data `cmd:TOKEN:q{i}` / `cmd:TOKEN:v{ver}:q{i}`.
- **D1 columns holding Telegram ids**: `commands.chat_id/message_thread_id`,
  `messages(chat_id,message_id,…,intended/actual_thread_id)`, `seen_updates.update_id`,
  `topics(chat_id,message_thread_id,name,name_provisional,state,closed_at)`,
  `named_topics(chat_id,topic_key,message_thread_id,…)`, `named_topic_bindings.chat_id`.
  Daemon SQLite: `session_tokens.chat_id`, `pull_inbox.chat_id/sender_id/in_reply_to*`,
  `pull_sources` value `telegram-reply`, outbox payloads (entities, `replyMarkup`).
- **Topics**: one forum topic per session, per-machine icon colour, `title · ~/dir` names
  (128-char clamp), provisional-name upgrade, `/rename`, one-chat-per-topic rule, reserve/finalize
  CAS, reopen-on-use, stale-thread recreate, relocate-to-General + alert, `topic_unavailable`
  hold window (outbox), daily 04:00 UTC close window (closes post unread service messages), 30-day
  reap, auto-pin removal, named topics + bindings (stall-watch coordinators, pull sessions).
- **Formatting**: Telegram entities (UTF-16 offsets) built by daemon `telegram-message.ts`;
  4096 split (`split-message.ts`); rich markdown (Bot API 10.1) for tables and goose sessions,
  with Telegram-specific defanging; `strip_entities` on 400; plugin `stripMarkdown`.
- **Buttons**: question inline keyboards (3/row); wizard edit-in-place; URL buttons for
  `/alert links`, mention-links (`t.me/c/...`), `/messages/send urlButtons`.
- **Media**: inbound getFile → R2 (20 MB limit, 1568px photo pick) → daemon data URI;
  outbound `/media/upload` → sendPhoto/sendDocument as reply, reply-routable.
- **Delivery policy** keyed on Telegram error shapes: `retryAfter` (seconds) pauses outbox,
  `details.error_code` 400 → strip entities, `thread not found`, worker-health neutral classes.
- **Daemon↔worker contract** Telegram-shaped fields: `chatId`, `messageThreadId`, `entities`,
  `replyMarkup` (`inline_keyboard`/`callback_data`), `rich`, `retryAfter`, `details.error_code`,
  `/topics/*`, `/messages/send urlButtons`, poll metadata `senderId/forwarded/inReplyTo/
  inReplyToQuote`.
- **Config**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` on each daemon (launch-capable requires
  both); worker vars `ALLOWED_CHAT_IDS` (4 chats), `TELEGRAM_BOT_USERNAME`,
  `TELEGRAM_TOPICS_ENABLED`, `TELEGRAM_RICH_MESSAGES`, `TELEGRAM_WEBHOOK_SECRET`.
- **Docs**: ~14 skills, AGENTS.md sections, runbook `telegram-forum-migration.md`.

### Outside pigeon

- **Direct Bot API callers (devbox)**: `em-ci-monitor.sh`, `em-ci-failover.sh`,
  `em-stack-monitor.sh` (workstation `hosts/devbox/`), pigeon's token, General. Plus
  healthchecks.io's own Telegram integration for their dead-man checks (configured on
  healthchecks.io). = `pigeon-lenr.4`.
- **`/alert` to General**: `opencode-drift-alert` (~30 units across cloudbox/devbox/darwin:
  lgtm failure units, trunk-drift-detector, disk-watch, lane-deadman, …), lgtm `sendAlert`
  (merge notices fall back to one Telegram message, 3800-char cap).
- **stall-watch (eng-agent-platform)** — deepest consumer: named topics `stallwatch:<tag>`,
  link buttons (cap 8), `strict_topic`, coordinators bound via `/goose/sessions named_topic`,
  replies via `/pull/*` with `source == "telegram-reply"` + `in_reply_to(_quote)`, topic rename,
  Telegram limits hard-coded (4000-char parts, UTF-16, 3.5 s pacing). agent-wait reuses it.
- **deps lanes (eng-agent-platform)**: goose-pull sessions with `telegram-reply`; already
  dual-transport — Slack app "Deps Worker" in the company workspace reads thread replies into
  `/pull/drain`-shaped rows (`source:"slack-reply"`). Precedent.
- **honk/honkd**: registers goose sessions "so it gets a Telegram topic", announce `/stop`,
  turn hooks, `honk telegram` subcommand.
- **Skills** in workstation mention Telegram topics/swipe-reply (swarm-messaging,
  finding-program-coordinators, shepherding-pull-requests, opencode-launch, …).

### Slack today

- Only the company workspace (remarkable-foods.slack.com). Apps there need IT approval
  (ETSD tickets: lgtm2 ETSD-35832, Deps Worker ETSD-35716). Tokens only on cloudbox (sops)
  and the Mac (Keychain); **devbox has no Slack credential**.

### Slack facts that constrain the design

- App slash commands **cannot be invoked in threads** (Slack docs). Telegram's
  reply-to-a-notification `/kill` has no direct equivalent if sessions are threads.
- Interactivity (buttons) and Events API require a 3 s HTTP ack; Socket Mode needs a
  long-lived websocket.
- `markdown_text` / `markdown` block renders standard markdown including tables (12k chars);
  a `table` block also exists.
- Edit in place: `chat.update`. Files: `files.getUploadURLExternal` +
  `files.completeUploadExternal`; inbound `url_private` needs the bot token.
- `chat.postMessage` ~1 msg/s per channel; no auto-pin; threads cannot be closed.
- Bot tokens cannot unarchive a channel (`conversations.unarchive` docs); bots cannot delete
  channels without Enterprise admin APIs.
- No public API for a user's sidebar sections (only undocumented browser-session endpoints), which
  is why D2 separates machines by workspace.
