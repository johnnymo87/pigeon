# Daemon Slack support (pigeon-4ogz.5)

Spec: `2026-11-20-slack-transport-design.md` §6, §7 (and the bead notes on `pigeon-4ogz.5`, which
override it where they differ). Every change is additive: with the worker answering `whoami`
without `transport` (every machine today), the daemon's wire traffic and Telegram tests are
unchanged.

## Pieces

1. **Transport state** (`src/chat-transport-state.ts`). SQLite table `daemon_kv(key, value,
   updated_at)`, key `whoami.transport`, values `telegram|slack`. Loaded at construction, so a
   restart during a worker outage keeps the last answer. `observe(identity)`: a `machine` answer
   sets `identity.transport ?? "telegram"`; `shared` sets `telegram` (the shared key never reaches
   Slack); `rejected`/`unsupported`/`unknown` keep the last value. Refreshed every 60 s; a change is
   logged. `Poller.whoami` adds `transport: "slack"` to the machine identity only when the worker
   says so (Telegram identity objects are byte-identical).
2. **Direct alarm** (`src/direct-slack-alarm.ts`): POST `{text}` to `PIGEON_SLACK_ALARM_WEBHOOK_URL`
   (must be `https://hooks.slack.com/...`; empty = unset), same bounds as the Telegram one. Text is
   mrkdwn-escaped, broadcasts defused, link buttons become `<url|label>` lines, thread ignored.
   `<@PIGEON_SLACK_OWNER_USER_ID> ` prefix only when `PIGEON_SLACK_NOTIFY_OWNER=1`. Failures throw
   `SlackWebhookError` (never `TelegramSendError`, so the `/alert` ladder does not retry it).
   `selectDirectAlarm` per call: transport `slack` → Slack, else Telegram, falling back to whichever
   is configured; unknown transport (nothing persisted yet) → Telegram first (bead note from .15:
   devbox has the webhook before it flips). A Slack thread/handle is never handed to Telegram.
   Guard test: `hooks.slack.com` only in that file.
3. **Rich dialect** (`rich-markdown.ts`): `buildRichMarkdown(..., {dialect: "slack"})` renders
   standard GFM: no `<tg-button>` (code spans), no Telegram escapes/entities/spacers/sublist
   flattening, CommonMark backslash escapes in pigeon's own text, 12 000-char limit. The stop
   payload carries `rich: {markdown, dialect: "slack"}` when the persisted transport is Slack; the
   outbox passes `dialect` through.
4. **notifyOwner**: question payloads carry `notifyOwner: true` when the transport is Slack at
   enqueue; outbox → `/notifications/send`. Error-severity alerts set `notifyOwner: true` on the
   worker leg (`/messages/send`) when the transport is Slack; the worker's `/messages/send` gains
   `notifyOwner` → `notifyCategory: "errors"` (Slack addresses only). Worker still gates on
   `SLACK_NOTIFY_OWNER` (unset → nothing).
5. **errorClass**: delivery policy rule 6 prefers top-level `errorClass` (`rejected_format` →
   strip, any other class → no strip), legacy `details.error_code` otherwise. Worker-health:
   `rejected_format`/`conversation_gone` neutral. `WorkerMessageClient` carries `errorClass` on a
   rejection; `TelegramSendError.errorClass`; the `/alert` ladder treats `conversation_gone` as
   "thread not found".
6. **Links / named topics**: `TopicInfo.url` (string → used; `null` → no button; absent → `t.me`
   builder). `/topics/named(+bind)` `chatId` is returned to the caller; `/alert` sends to it
   (`PlainAlertOptions.chatId`), and drops it with the thread.
7. **launchCapable per poll**: computed from the persisted transport: Telegram needs bot token +
   chat id (as before); Slack needs the alarm webhook (+ chat id, still required by the outbox and
   notifier until `pigeon-4ogz.13`). The poll header and the receiver's `launchFrom` read it per
   call; a change is logged.

## Not done here (left for .13)

The outbox, the notifier and `/topics/named` still need `TELEGRAM_CHAT_ID` (the worker ignores it on
a Slack machine). Deleting Telegram has to drop that requirement.
