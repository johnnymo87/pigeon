/**
 * The worker's chat-transport seam (chat-transport phase 2, bead pigeon-4ogz.1; spec
 * docs/plans/2026-11-20-slack-transport-design.md §1).
 *
 * Every OUTBOUND call the worker makes to a chat provider goes through a `ChatTransport`, and
 * which transport is decided by the ADDRESS (`transportForChat` in `./index.ts`): a numeric chat
 * id is Telegram, a `slack:<teamId>` id is Slack. A stored conversation therefore goes where it
 * lives, whichever transport its machine is on now.
 *
 * The method names, options and results are deliberately Telegram-shaped. The spec keeps the
 * daemon contract Telegram-shaped until Telegram is deleted (pigeon-4ogz.13), and the worker's
 * internals follow it: a Slack implementation translates `createForumTopic` to
 * `conversations.create`, a `thread not found` to `channel_not_found`, and so on, rather than
 * every call site learning a second vocabulary. It also means today's `TelegramClient` IS a
 * `ChatTransport` structurally, so every existing test that injects a fake Telegram client keeps
 * working unchanged.
 *
 * Inbound-only Telegram calls were deleted with the Telegram webhook, and Slack's ingress
 * has its own equivalents.
 *
 * `src/telegram.ts` remains the only file that knows Telegram's host (egress guard test).
 */
/** A provider call's outcome. Telegram's shape; other transports map their errors onto it. */
export type ChatResult<T> =
  | { ok: true; result: T }
  | { ok: false; kind: "rate_limited"; retryAfter: number; response?: unknown }
  | { ok: false; kind: "thread_not_found"; response?: unknown }
  | { ok: false; kind: "topic_not_modified"; response?: unknown }
  | { ok: false; kind: "error"; errorCode?: number; description?: string; response?: unknown };

export interface SendMessageOptions {
  chatId: string | number;
  text: string;
  entities?: unknown[];
  replyMarkup?: unknown;
  messageThreadId?: number;
  /** Aborts the call (the fetch rejects). Callers that bound a request use this. */
  signal?: AbortSignal;
  /** Slack only: flag the post for an owner mention (still gated by `SLACK_NOTIFY_OWNER`). Telegram ignores it. */
  notifyOwner?: boolean;
  /** Slack only: which `SLACK_NOTIFY_OWNER` category a flagged post is. Absent with `notifyOwner` means `errors`. */
  notifyCategory?: "questions" | "errors";
}

export interface SendRichMessageOptions {
  chatId: string | number;
  /** GFM plus Telegram's extensions; see https://core.telegram.org/bots/api/rich-messages.md */
  markdown: string;
  /** Slack only: the plain-text rendering, used as the notification text instead of the raw markdown. */
  text?: string;
  replyMarkup?: unknown;
  messageThreadId?: number;
  /** Slack only: flag the post for an owner mention (still gated by `SLACK_NOTIFY_OWNER`). Telegram ignores it. */
  notifyOwner?: boolean;
  /** Slack only: which `SLACK_NOTIFY_OWNER` category a flagged post is. Absent with `notifyOwner` means `errors`. */
  notifyCategory?: "questions" | "errors";
  /** Aborts the Slack calls of this operation. The Telegram client ignores it. */
  signal?: AbortSignal;
}

export interface EditMessageTextOptions {
  chatId: string | number;
  messageId: number;
  text: string;
  entities?: unknown[];
  replyMarkup?: unknown;
  /** Slack only: keep the owner mention on the edited message (gated by `SLACK_NOTIFY_OWNER`). Telegram ignores it. */
  notifyOwner?: boolean;
  /** Slack only: the category of that mention. Telegram ignores it. */
  notifyCategory?: "questions" | "errors";
  /** Aborts the Slack calls of this operation. The Telegram client ignores it. */
  signal?: AbortSignal;
}

export interface SendPhotoOptions {
  chatId: string | number;
  photo: Blob;
  filename: string;
  replyToMessageId?: number;
  messageThreadId?: number;
  /** Aborts the Slack calls of this operation. The Telegram client ignores it. */
  signal?: AbortSignal;
}

export interface SendDocumentOptions {
  chatId: string | number;
  document: Blob;
  filename: string;
  replyToMessageId?: number;
  messageThreadId?: number;
  /** Aborts the Slack calls of this operation. The Telegram client ignores it. */
  signal?: AbortSignal;
}

export interface ForumTopic {
  message_thread_id: number;
  name: string;
  icon_color: number;
  icon_custom_emoji_id?: string;
  is_name_implicit?: boolean;
}

export interface CreateForumTopicOptions {
  chatId: string | number;
  name: string;
  iconColor?: number;
  iconCustomEmojiId?: string;
  /** Slack only: the session this conversation is for (channel name suffix, topic line). */
  sessionId?: string;
  /** Slack only: a named topic's key, which becomes the channel name. */
  channelKey?: string;
  /** Slack only: the channel's topic line, replacing the one derived from `name`. */
  topic?: string;
}

export interface EditForumTopicOptions {
  chatId: string | number;
  messageThreadId: number;
  name?: string;
  iconCustomEmojiId?: string;
  /** Slack only: the session this conversation is for (channel name suffix, topic line). */
  sessionId?: string;
  /** Slack only: a named topic's key, which fixes the channel name. Without it or `sessionId`, the channel is not renamed. */
  channelKey?: string;
  /** Slack only: the channel's topic line, replacing the one derived from `name`. */
  topic?: string;
}

export interface CloseForumTopicOptions {
  chatId: string | number;
  messageThreadId: number;
}

export interface ReopenForumTopicOptions {
  chatId: string | number;
  messageThreadId: number;
}

export interface DeleteForumTopicOptions {
  chatId: string | number;
  messageThreadId: number;
}

export interface UnpinAllForumTopicMessagesOptions {
  chatId: string | number;
  messageThreadId: number;
  signal?: AbortSignal;
}

export interface ChatTransport {
  /** Post text (+ entities, + keyboard) into a chat, optionally into a topic/conversation. */
  sendMessage(options: SendMessageOptions): Promise<ChatResult<{ message_id: number }>>;
  /** Post one rich (markdown) message. */
  sendRichMessage(options: SendRichMessageOptions): Promise<ChatResult<{ message_id: number }>>;
  /** Edit a posted message in place (the question wizard). */
  editMessageText(options: EditMessageTextOptions): Promise<ChatResult<{ message_id?: number } | boolean>>;
  sendPhoto(options: SendPhotoOptions): Promise<ChatResult<{ message_id: number }>>;
  sendDocument(options: SendDocumentOptions): Promise<ChatResult<{ message_id: number }>>;
  /** Create a session's (or a named) conversation: a forum topic on Telegram. */
  createForumTopic(options: CreateForumTopicOptions): Promise<ChatResult<ForumTopic>>;
  editForumTopic(options: EditForumTopicOptions): Promise<ChatResult<boolean>>;
  closeForumTopic(options: CloseForumTopicOptions): Promise<ChatResult<boolean>>;
  reopenForumTopic(options: ReopenForumTopicOptions): Promise<ChatResult<boolean>>;
  deleteForumTopic(options: DeleteForumTopicOptions): Promise<ChatResult<boolean>>;
  unpinAllForumTopicMessages(options: UnpinAllForumTopicMessagesOptions): Promise<ChatResult<boolean>>;
}
