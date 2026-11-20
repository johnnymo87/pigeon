# Slack as pigeon's chat transport (chat-transport phase 2)

Status: DRAFT, inventory only, 2026-11-20. Bead `pigeon-4ogz`. Decisions pending Jonathan.
Phase 1: `docs/plans/2026-11-20-telegram-single-egress-design.md` (epic `pigeon-lenr`).

## Inventory: what depends on Telegram today

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

## Decisions

(pending)
