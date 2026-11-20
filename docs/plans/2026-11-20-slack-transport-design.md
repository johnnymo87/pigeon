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
| D9 | Cutover per machine: the worker picks the transport per machine; devbox → cloudbox → macbook; Telegram code deleted after all three. A flipped machine's live sessions get a fresh channel on their next notification; no history migration. Three Slack apps generated from one manifest in the repo, one per workspace (no OAuth distribution). Slash commands keep their names. |

## Design

### 1. Shape: a transport seam in the worker, selected per machine

`packages/worker/src/chat/` gets a `ChatTransport` interface with two implementations:
`telegram` (today's code moved behind it, no behaviour change) and `slack`. Every worker code path
that today calls `TelegramClient` asks `transportFor(machineId)` instead.

- **Selection is by worker secret.** `SLACK_WORKSPACE_<MACHINE>` (e.g. `SLACK_WORKSPACE_DEVBOX`)
  holds JSON `{teamId, botToken, signingSecret, ownerUserId}`. Present → that machine is on
  Slack; absent → Telegram. Flip and rollback are `wrangler secret put` / `delete`, no deploy.
  Telegram tables and the bot stay untouched until the final deletion, so rollback is real until
  then.
- **Which machine?** Session-bound sends (`/notifications/send`, `/notifications/edit`,
  `/topics/*` for a session, mention-link resolution) use the **session's owning machine**
  (`sessions.machine_id`). Session-free sends (`/messages/send`, `/topics/named`, `/alert`
  relays) use the **authenticated principal's machine**. All three machines are on per-machine
  keys, so the principal is known. A session-bound send whose principal differs from the owner
  (the `pigeon-533h` case) posts to the principal's `#alerts`, never into another workspace.
- **The daemon contract stays as it is during migration.** The worker translates the
  Telegram-shaped payload (`text`+`entities`, `replyMarkup.inline_keyboard`, `rich.markdown`,
  `urlButtons`) into Slack. For a Slack machine, `chatId` from the daemon is ignored and
  `ALLOWED_CHAT_IDS` does not apply. Renaming the contract to neutral names happens once, in the
  Telegram-deletion step (§9), when there is one provider. Three neutral additions are needed
  earlier and are additive (§7).

### 2. Slack apps and workspaces

- One manifest template in the repo (`packages/worker/slack/manifest.template.json`) and a
  script that renders it per machine (request URLs carry the machine). Jonathan creates the
  workspace and the app from the rendered manifest at api.slack.com, installs it, and puts the bot
  token, signing secret, team id and his user id into the worker secret. The runbook
  (`docs/runbooks/slack-workspace-setup.md`) is part of the first child bead.
- **Bot scopes:** `chat:write`, `channels:manage`, `channels:read`, `channels:history`,
  `channels:join`, `commands`, `files:read`, `files:write`, `incoming-webhook`.
  **Events:** `message.channels`. **Interactivity:** on. **Slash commands:** `/launch /kill
  /interrupt /compact /rename /mcp /model /tag`.
- **Request URLs, per machine:** `/slack/<machine>/events`, `/slack/<machine>/interactivity`,
  `/slack/<machine>/commands`. The path picks the workspace config, so the signature is checked
  against that workspace's secret before the body is parsed.
- Channels are **public** (single-member workspace; simpler URLs and scopes). The bot creates
  them and invites the owner.
- Free plan: 90 days of visible history, 10 integrations per workspace. pigeon needs 1; devbox
  also hosts the em-alerts app (D8). Bots cannot delete channels on a free plan.

### 3. Conversations: sessions, named channels, `#alerts`

New D1 tables, separate from the Telegram ones so the final drop is a `DROP TABLE` and rollback
never has to un-migrate data:

- `slack_channels(session_id PK, machine_id, team_id, channel_id, name, title, name_provisional,
  state open|archived|reserved, created_at, archived_at, reservation fields)` with
  `UNIQUE(team_id, channel_id)`. Same reserve/finalize CAS as `topics`.
- `slack_named_channels(team_id, topic_key, channel_id, ...)`, PK `(team_id, topic_key)`.
- `slack_posts(team_id, channel_id, ts, session_id, token, notification_id, ...)`, PK
  `(team_id, channel_id, ts)`: the `messages` equivalent (reply context, tokens, edits, dedup).
- `slack_seen_events(event_id PK, seen_at)`: Slack retries events it did not see acked in 3 s.

**Session channel.** Created lazily on the session's first notification, as topics are.
- **Name:** `<slug>-<sid8>`, `slug` from the title (or the directory basename while the title is
  provisional), lowercased, `[a-z0-9-]`, total ≤ 80. The session-id suffix guarantees uniqueness,
  including against archived channels, which keep their names. **Topic** (`conversations.setTopic`,
  250 chars): `title · ~/dir · 🆔 <session id>`.
- **Provisional title upgrade:** once, `conversations.rename` + `setTopic`, same rules as
  `pigeon-353p`. `/rename` and `/topics/rename`: the same calls.
- **Close = archive** (`conversations.archive`). Archiving posts no unread service message, so the
  04:00 UTC window (`pigeon-ln8z`) is not needed for Slack; the orphan closer archives every tick.
  Reaping (delete) is a no-op: archived channels stay, hidden.
- **Reopen:** bot tokens cannot unarchive (Slack docs, `conversations.unarchive`). A notification
  for a session whose channel is archived creates a **new** channel (`<slug>-<sid8>-2`, …) and
  puts the old channel's link in the new topic.
- **Gone/rejected:** `channel_not_found` / `is_archived` on a send = Telegram's `thread not found`
  (recreate once). Permanent 4xx-class failures relocate to `#alerts` with the existing alert;
  transient failures feed the existing `topic_unavailable` hold (`pigeon-iqpd`), unchanged.

**Named channels** (`/topics/named`, `/alert topic`): name from the key (`stallwatch:chat-transport`
→ `stallwatch-chat-transport`), topic = the given `name`. Bindings keep using
`named_topic_bindings`, with `chat_id = 'slack:<team_id>'`. **A flip carries bindings over**: on
a machine's first Slack resolve of a key that has a Telegram binding for a session of that
machine, the worker copies the binding to the Slack chat id. Without this every stall-watch
coordinator goes deaf at the flip (test required).

**`#alerts`**: created or found by name on first use, cached in `slack_named_channels` under the
reserved key `_alerts`. It is the target of everything that goes to General today: `/alert`
without a topic, relocations, unthreaded quiet-session questions, remote-launch notices.

### 4. Outbound rendering

| Daemon sends | Slack gets |
|---|---|
| `text` + `entities` | `rich_text` block (bold/italic/code/pre/text_link map 1:1); `text` as notification fallback |
| `rich.markdown` (tables, goose) | `markdown` block (≤ 12 000 chars, which also renders tables); over the limit or rejected → the `rich_text` path. Worker kill switch var `SLACK_MARKDOWN_BLOCKS=off`. |
| `replyMarkup.inline_keyboard` callback buttons | `actions` block, `button` per key, `value` = the callback data, `action_id` unique per button |
| URL buttons (`/alert links`, mention-links, `urlButtons`) | `button` with `url`; its interaction payload is acked and ignored |
| `media[]` | `files.getUploadURLExternal` → upload → `files.completeUploadExternal` with `channel_id` + `thread_ts` of the text post |
| edit (`/notifications/edit`) | `chat.update` by `ts` from `slack_posts` |
| owner mention (§7) | `<@ownerUserId>` prepended to the fallback text and the first block |

- **Mention-links:** `https://app.slack.com/client/<team>/<channel>`. It works across workspaces,
  so a coordinator's button to a worker on another machine opens that workspace.
- **Splitting:** the daemon keeps splitting at 4096; Slack accepts it. Raising the limit is a
  later optimisation, not part of this.
- **Unpin:** Slack does not auto-pin; `/topics/unpin` is a successful no-op.
- **Rate limits:** `chat.postMessage` is about 1/s per channel, and channels are per session, so
  the per-group 20/min ceiling that shaped Telegram pacing goes away. A Slack 429's
  `Retry-After` (seconds) maps onto the existing `retryAfter`.

### 5. Inbound

All three endpoints verify `X-Slack-Signature` (HMAC-SHA256 of `v0:<ts>:<body>`, ±5 min) with the
path's workspace secret, ack within 3 s, and do the work in `ctx.waitUntil`.

- **Events** (`message.channels`): `url_verification` answered. Dedup on `event_id`. Ignore
  `bot_id`, our own bot user, and subtypes other than none and `file_share`. Owner-only:
  `event.user == ownerUserId`, else dropped silently (`ALLOWED_USER_IDS` equivalent).
  - **Session resolution:** channel → `slack_channels` → session; otherwise channel → bound named
    channel → session (plain messages only, as today); otherwise named channel → rate-limited hint.
  - **Reply context:** a message in a **thread** under a pigeon post resolves `thread_ts` through
    `slack_posts`. That gives `inReplyTo` (the parent's text, ≤ 500), `questionRequestId` for a
    `q:` post, and the swipe-reply semantics. A top-level message has no `inReplyTo`. Slack has no
    partial quote, so `inReplyToQuote` is always absent.
  - **Forwarded:** a message carrying a shared-message attachment is `forwarded: true`.
  - **Files:** `files[]` → download `url_private_download` with the bot token → R2, same
    `MediaRef` and size limit as today.
  - `senderId` = the Slack user id (§7).
- **Slash commands:** the payload's `channel_id` resolves the session, as a Telegram topic does
  (the "reply to a notification" form is replaced by "typed in the session's channel"; `/tag <id>
  <tag>` and `/launch` work anywhere). The parsers are shared with the Telegram webhook (extract
  them first). The worker's immediate ack goes back in the HTTP response (`in_channel`); later
  daemon replies arrive by `/messages/send` addressed to that channel. `@BotName` handling does not
  apply.
- **Interactivity** (`block_actions`): `value` parsed exactly as `callback_data` is today
  (`cmd:TOKEN:q{i}`, `cmd:TOKEN:v{ver}:q{i}`); owner-only. Telegram's toast has no equivalent; the
  ack is empty and the wizard's `chat.update` is the feedback.

### 6. Daemon: the direct-fallback alarm moves to an incoming webhook

`direct-telegram-alarm.ts` is replaced by `direct-slack-alarm.ts`, which posts to the workspace's
**incoming webhook** for `#alerts` (`PIGEON_SLACK_ALARM_WEBHOOK_URL`, sops/Keychain). That URL can
only post to one channel, which is narrower than the bot token the daemon holds today. Same
worker-first ladder, same `· sent direct; worker: <reason>` suffix and throttled health alert
(`pigeon-lenr` §D). The guard test moves to `hooks.slack.com`. A machine with neither path logs
`UNAVAILABLE` as today. During the migration a daemon may hold both alarms: it uses the one for
its machine's current transport, read from `GET /whoami`, which gains `transport`.

`launchCapable` stops requiring `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` for a Slack machine. It
requires worker credentials, an opencode client, and an alarm path.

### 7. Daemon↔worker contract: three additive neutral fields

- **`notifyOwner: true`** on a notification or `/messages/send`: the worker @-mentions the owner
  on Slack and ignores it on Telegram. The daemon sets it on questions and on error-severity
  alerts (D7).
- **`errorClass`** in worker error responses: `rejected_format` (Slack `invalid_blocks` or a
  Telegram 400 entity error), `conversation_gone` (`thread not found` /
  `channel_not_found`/`is_archived`), `rate_limited`, `upstream`. The daemon's delivery policy
  prefers `errorClass` when present and falls back to today's Telegram-shaped fields
  (`details.error_code`, description text), so either deploy order is safe. `rejected_format` →
  the existing `strip_entities` rule, which for Slack resends as plain text.
- **`chatId` optional.** For a Slack machine the worker owns the address. The daemon still sends
  it until Telegram is gone.

Pull-inbox rows keep `source: "telegram-reply"` for compatibility with stall-watch, the lanes and
honk. The value is renamed to a neutral one in a coordinated cross-repo change after Telegram is
gone (§9).

### 8. Outside pigeon

- **em-* monitors (`pigeon-lenr.4`, devbox):** an incoming webhook to `#em-alerts` from a
  separate devbox-workspace app ("em-alerts"), in sops `em_alerts_slack_webhook`. The three
  `tg_send` functions become `slack_send` (JSON `{text}`, same 4096 cap, same healthchecks.io
  failure contract). The tests that pin the Telegram URL shape change with them. This is a
  workstation PR.
- **healthchecks.io:** switch its integrations to Slack (Jonathan, UI).
- **stall-watch / agent-wait / lanes (eng-agent-platform):** the contract is unchanged, so nothing
  breaks at the flip. Follow-ups: wording ("Telegram topic" in coordinator prompts and the
  `sw` skill), the 3.5 s pacing and 4000-char parts (can relax; optional), and the
  `in_reply_to_quote` expectation (now always empty). Filed as a bead in that repo by the
  devbox-flip child.
- **honk:** "Telegram" wording and the `honk telegram` subcommand (it opens a topic): a bead in
  honk.
- **workstation:** daemon env and secrets per machine (`PIGEON_SLACK_ALARM_WEBHOOK_URL`), skills
  that say "Telegram topic" / "swipe-reply" (swarm-messaging, finding-program-coordinators,
  shepherding-pull-requests, opencode-launch, scheduling-wakes, …), and at the end removing the
  Telegram secrets.

### 9. Rollout

Each step is one or more beads; the graph is authoritative (epic `pigeon-4ogz`).

1. **Worker seam refactor** (no behaviour change). Extract `ChatTransport`, move Telegram
   behind it, extract the command parsers from `webhook.ts`.
2. **Manifest + setup runbook**, in parallel with 1.
3. **Worker Slack outbound** (§3, §4, tables) and **worker Slack inbound** (§5): two PRs on the
   seam, both dark until a `SLACK_WORKSPACE_*` secret exists.
4. **Daemon**: `notifyOwner`, `errorClass`, the Slack alarm module, `whoami.transport`,
   `launchCapable` (§6, §7). Deploy order: worker before daemons (all additive).
5. **Jonathan: devbox workspace + app** (needs his explicit OK to create; D1 has it in principle,
   but the app and tokens are his action or his go-ahead). Then **flip devbox**: put the secret,
   then live checks: a session notification creates a channel; a typed message injects; `/kill` in
   a channel; a question button; a wizard edit; a photo each way; a stall-watch coordinator
   channel receives and answers; `/alert` lands in `#alerts`; the direct alarm with the worker
   blocked. **Rollback:** delete the secret.
6. **em-alerts** (`pigeon-lenr.4`), after 5.
7. **cloudbox** workspace + flip; then **macbook** (needs a Mac session for the daemon's
   Keychain item).
8. **Soak**: one week with all three on Slack.
9. **Delete Telegram**: worker client, webhook, Telegram tables, vars and secrets, the daemon's
   Telegram alarm and config, entity naming → neutral names in the contract, docs and skills.
   Then the cross-repo `telegram-reply` rename. **Past this step there is no rollback to
   Telegram.**

### Verification (per PR, in addition to the live checks)

- Worker: signature verification (bad sig, stale timestamp, wrong workspace's path); event dedup;
  bot/own/subtype filtering; owner gate; resolution order (channel, thread reply → reply context,
  bound named channel, hint); command → session by channel; button → token; rendering table above,
  one test per row; markdown-block fallback; `channel_not_found` → recreate once; archived →
  new `-2` channel; binding carry-over at flip; per-machine selection (owner machine for
  session-bound, principal for session-free, foreign principal → its `#alerts`); Telegram
  behaviour unchanged with no Slack secret (the existing suite passes untouched).
- Daemon: `errorClass` preferred over legacy fields, legacy still honoured; `notifyOwner` on
  questions and error alerts only; Slack alarm ladder through the composed notifier (as phase 1's
  tests); guard test.

## Out of scope

Migrating Telegram history; Slack Enterprise features; a public (distributed) app; Socket Mode;
the plugin's `stripMarkdown` (opencode stops could render markdown natively in Slack; a later
improvement); raising the 4096 split.

## Open items (not blocking the plan)

- Channel naming details (`slug` source, emoji stripping) are an implementation choice.
- Whether `/launch` should create the new session's channel immediately, so the confirmation can
  link to it, or keep lazy creation.

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
