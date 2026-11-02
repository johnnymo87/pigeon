# Rich tables in Telegram via `sendRichMessage` (pigeon-p909)

## Problem

Agent answers reach Telegram through plain `sendMessage` with no `parse_mode`. A GFM pipe
table therefore arrives as a raw wall of `|`. Bot API 10.1 added `sendRichMessage`, whose
`InputRichMessage.markdown` field renders GFM (tables included) natively.

Prior art: NousResearch/hermes-agent 9d225fbf ("auto-rich pipe tables and topic routing for
sendRichMessage"). Their Telegram adapter detects a pipe-table delimiter row, sends the raw
markdown through `sendRichMessage` (soft newlines converted to hard breaks outside code
fences and tables), and falls back to their legacy send on a 400.

## Facts that shape the design (Bot API docs, 2026-11-02)

- `sendRichMessage(chat_id, message_thread_id?, rich_message, reply_parameters?, reply_markup?, ...)`
  returns a `Message`. `reply_markup` accepts `InlineKeyboardMarkup`.
- `InputRichMessage` takes exactly one of `markdown`, `html`, `blocks`.
- Limits: 32768 UTF-8 characters, 500 blocks (table rows and list items each count),
  16 nesting levels, 20 table columns.
- The markdown dialect is GFM **plus Telegram extensions**: `$…$` inline math, `$$…$$`
  block math, `==marked==`, `||spoiler||`, and arbitrary HTML (unsupported tags are a
  parse error: `Bad Request: can't parse rich message`).
- `editMessageText` edits "text, rich and game messages" via a `rich_message` parameter.
- A sent rich message has `rich_message` (blocks of `RichText`) and **no `text`**, so a
  reply's `reply_to_message.text` is absent when the human swipe-replies to one.

## Answers to the open questions

**Editing.** Telegram supports it (`editMessageText` + `rich_message`), but pigeon does not
need it: the only edit path, `POST /notifications/edit`, is used by the multi-question wizard,
and questions are never sent rich. Rich is scoped to `stop` outbox entries (opencode stops and
goose turn ends, which share `handleStopBody`), which are never edited.

**Reply routing.** Unaffected: routing is `reply_to_message.message_id` → D1 `messages`
row, and the rich send records that row exactly as a plain send does. Link buttons
(`reply_markup`) work: `sendRichMessage` accepts an inline keyboard. One thing does break and
is fixed here: `inReplyTo` context (goose sessions) is read from `reply_to_message.text`,
which a rich message lacks. The webhook gains a plain-text extractor over
`reply_to_message.rich_message` and uses it when `text`/`caption` are absent.

**Pigeon's entity-built header and footer.** One message. The daemon converts its
`TgMessage` header/footer (text + `code`/`bold`/`italic`/`pre` entities) to markdown with a
generic converter: plain segments are backslash-escaped, `code` becomes a backtick span with
a fence longer than any backtick run inside it, and footer newlines become hard breaks. The
markdown is `header + "\n\n" + body + "\n\n" + footer`, the same layout as the plain chunk.

**Fallback.** On any rich-send rejection — a 4xx other than 429 and other than
"thread not found" — the worker immediately sends the plain text it was given (the same
`sendMessage` it would have sent before this change), once, with a `console.warn` carrying
Telegram's error. The response carries `rich: "fallback"` and the daemon logs it too. A 5xx,
an unparseable 200 or a 429 keeps today's semantics (502 / 429, the outbox retries), because
those say nothing about the markdown.

**Scope: tables only.** Rich-send is triggered only when the stop body contains a GFM pipe
table (header row with `|` followed by a delimiter row, outside fenced code). Reasons:

1. Every other message renders exactly as today. Turning on markdown for all messages
   changes how every answer reads, and the Telegram extensions make plain prose fragile:
   `$5 and $10` is inline math, `a || b` a spoiler, `Promise<void>` an unsupported HTML tag
   (a parse error, hence a fallback on many ordinary messages).
2. Tables are the acute pain, and the one construct with no plain-text rendering at all.
3. The cost is inconsistency: a message with a table also renders its `**bold**` and
   headings, a message without one shows them raw. Widening the trigger later is a one-line
   change to the predicate once the escaping has proven itself.

## Design

### Daemon (`packages/daemon`)

New module `rich-markdown.ts`:

- `hasPipeTable(body)`: a header line containing `|` immediately followed by a delimiter row
  (`^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$`, Hermes's regex), outside fenced code.
- `sanitizeBodyMarkdown(body)`: outside fenced code blocks (including fences under list items
  and in quotes) and inline code spans, escape the Telegram extensions GFM does not have and
  the constructs that would change meaning: `$`, `<`, `&` (entities stay literal), `![`
  (media blocks Telegram would fetch), `==`, and `||` on non-table lines. A `---` line next to
  prose gets blank lines so it is a rule, not a setext heading. Then convert lone `\n` to hard breaks (`"  \n"`) outside fenced
  code and table blocks, because plain text preserved every newline and markdown collapses
  soft breaks.
- `tgMessageToMarkdown(msg)`: the entity converter above. Returns null on overlapping
  entities (never produced today), in which case rich is skipped.
- `buildRichMarkdown(header, body, footer)`: null unless `hasPipeTable(body)`; null if any
  table exceeds 20 columns, the estimated block count (non-blank lines outside fences, plus
  one per fence) exceeds 500, or the result exceeds 32768 code points. Otherwise the markdown.

`handleStopBody` (app.ts) adds `rich: { markdown }` to the outbox payload when
`buildRichMarkdown` returns one. Stop entries carry no buttons, so the rich message needs no
reply markup of its own.

`OutboxSender`: for an entry with `rich`, chunk 0's request also carries `rich`. If the
worker answers `rich: "sent"`, the whole notification is delivered; remaining chunks are
skipped and the entry commits. Any other success (`rich: "fallback"`, or no field at all from
a worker that predates this) means chunk 0 went out plain, and the loop continues with
chunks 1..N-1 exactly as today.

### Worker (`packages/worker`)

- `telegram.ts`: `sendRichMessage(botToken, {chatId, markdown, replyMarkup?, messageThreadId?})`
  through `callTelegram`, so it is timed and classified like every other call.
- `notifications.ts`: accepts `rich?: {markdown: string}`. `sendText` tries
  `sendRichMessage` first while rich is still enabled for this request; on a rich rejection
  (above) it latches rich off for the rest of the request, warns, and sends plain. Topic
  recovery (thread not found → recreate → retry) and relocation reuse `sendText`, so they
  follow whichever mode is current. Mention-link buttons are resolved from the markdown for
  the rich attempt and from the plain text for the fallback. The response adds
  `rich: "sent" | "fallback"` when `rich` was requested.
- A `TELEGRAM_RICH_MESSAGES = "off"` var disables rich sends worker-wide (the request is
  treated as plain, response `rich: "fallback"`), as a kill switch that needs no daemon
  change.
- `webhook.ts`: `reply_to_message.rich_message` plain-text extraction for `inReplyTo`.

### Version skew

Either deploy order is safe. An old worker ignores `rich`, posts chunk 0 plain and answers
without a `rich` field, so a new daemon continues with the remaining chunks: today's
behaviour. An old daemon never sends `rich`.

### Known limits

- **Lost responses.** A rich send is recorded in D1 as `<notificationId>#rich`; the
  idempotency check looks up both ids and answers a retry with `rich: "sent"`, so a lost
  response does not make the daemon post the remaining chunks too. (Safe: nothing looks a stop
  row up by its exact id; only question ids are edited or parsed.)
- **Persistent upstream failure.** A Telegram 5xx is not a rejection, so the outbox retries
  rich. After two such failures the outbox removes `rich` from the stored payload and the
  entry goes plain, so a parser bug on Telegram's side cannot cost the notification.
- **Link keyboard.** A 4xx on a rich send that carried mention buttons is retried rich without
  them first, as `sendPlain` already does, before it counts as a markdown rejection.
- **Escape rendering is unverified until first deploy.** GFM honours backslash escapes and
  Telegram says it is GFM-compatible, but no probe was possible from this host (no bot
  token). Post-deploy check: one stop containing a table, `$5 and $10`, `a == b`,
  `Promise<void>`, `a || b`.
- Swarm notices, mirrors, questions and `/alert` stay plain.

## Testing

Unit tests for every function in `rich-markdown.ts`; `OutboxSender` tests for rich sent /
fallback / old-worker / single vs multi chunk; worker tests (mocked `fetch`) for rich success,
400 fallback, 5xx → 502, 429, thread-not-found recovery under rich, kill switch, response
field; webhook test for `inReplyTo` from `rich_message`.
