# Telegram Entities Migration — Design

## Problem

Telegram notifications fail when the AI assistant's output summary contains unescaped Markdown characters (underscores in identifiers, unbalanced backticks, raw Markdown syntax). The Telegram Bot API rejects the entire message when `parse_mode: "Markdown"` is set and the text contains malformed Markdown.

Additionally, the outbox/worker delivery path omits `parse_mode` entirely, so those messages render as plain text with raw `*`, `` ` ``, and `_` visible.

## Solution

Replace `parse_mode: "Markdown"` with Telegram's `entities` array across all notification paths. The `entities` approach sends messages as plain text with explicit formatting metadata (offsets and lengths for bold, italic, code spans). The body text is never parsed, so arbitrary content cannot cause message rejection.

This was selected over two alternatives:
- **HTML `parse_mode`**: Simpler escaping (`<`, `>`, `&` only), but still requires escaping untrusted text. Entities require zero escaping.
- **MarkdownV2 `parse_mode`**: Broad, context-sensitive escaping rules. Brittle for arbitrary text.

## Architecture

### TgMessage type and builder

New file: `packages/daemon/src/telegram-message.ts`

```ts
interface TgEntity {
  offset: number;   // UTF-16 code unit offset
  length: number;   // UTF-16 code unit length
  type: "bold" | "italic" | "code" | "pre";
}

interface TgMessage {
  text: string;
  entities: TgEntity[];
}
```

A `TgMessageBuilder` class tracks offsets and produces `TgMessage` objects:

```ts
class TgMessageBuilder {
  append(s: string): this;           // plain text, no entity
  appendBold(s: string): this;       // bold entity
  appendItalic(s: string): this;     // italic entity
  appendCode(s: string): this;       // inline code entity
  newline(count?: number): this;     // convenience
  build(): TgMessage;
}
```

JavaScript `string.length` returns UTF-16 code units, which matches Telegram's entity offset/length requirements.

### Formatter changes

The three formatting functions in `notification-service.ts` change:

- `formatTelegramNotification` — returns `{ header: TgMessage, body: TgMessage, footer: TgMessage, replyMarkup }` for the splitter.
- `formatQuestionNotification` — returns `{ message: TgMessage, replyMarkup }`.
- `formatQuestionWizardStep` — returns `{ message: TgMessage, replyMarkup }`.

`escapeMarkdown()` is deleted. Body text is appended via plain `append()` with no formatting or escaping.

### Entity-aware message splitting

`splitTelegramMessage` signature changes to:

```ts
function splitTelegramMessage(
  header: TgMessage,
  body: TgMessage,
  footer: TgMessage,
  maxLen?: number,
): TgMessage[]
```

The splitter:
1. Calculates overhead from header + footer + join separators
2. Splits only the body text at natural boundaries (same priority: paragraph > line > sentence > hard cut)
3. For each body chunk, concatenates header + `\n\n` + chunk + `\n\n` + footer into a `TgMessage`, adjusting entity offsets for the concatenation
4. Header and footer entities are duplicated across all chunks with correct offsets

### Delivery pipeline

Entities travel through the full pipeline:

- **Outbox payload**: stores `messages: Array<{ text, entities }>` (stop) or `message: { text, entities }` (question) — clean break, no backward compat with old format.
- **OutboxSender**: passes entities alongside text for each chunk.
- **Poller.sendNotification / editNotification**: includes entities in JSON POST body to worker.
- **Worker handleSendNotification**: reads `entities` from request body, includes in Telegram `sendMessage` payload.
- **Worker handleEditNotification**: reads `entities` from request body, includes in `editMessageText` payload. `parseMode` field dropped.
- **TelegramNotificationService.sendTelegramMessage** (direct path): replaces `parse_mode: "Markdown"` with `entities`.
- **WorkerNotificationSender interface**: adds `entities?` parameter.
- **command-ingest.ts wizard edits**: passes entities through to editNotification.

### Non-notification messages

- **Daemon index.ts startup message**: drops `parse_mode: "Markdown"`. Plain text, no entities needed.
- **Worker webhook.ts**: already plain text, no change.

## Testing

- `telegram-message.ts`: builder basics, offset tracking, UTF-16 correctness with emoji
- `split-message.ts`: new signature, entity offset adjustment across chunks, header/footer entity duplication
- `notification-service.ts`: formatters return TgMessage with correct entities, services pass entities to Telegram API instead of parse_mode
