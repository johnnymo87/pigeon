/**
 * The worker's chat-transport seam (chat-transport phase 2, bead pigeon-4ogz.1; spec
 * docs/plans/2026-11-20-slack-transport-design.md §1).
 *
 * Every OUTBOUND call the worker makes to a chat provider goes through a `ChatTransport`, and
 * which transport is decided by the ADDRESS (`transportForChat` in `./index.ts`): a
 * `slack:<teamId>` id is Slack. Slack is the only transport; any other address (a numeric chat id
 * left over from the Telegram days) gets a guard that answers `no_transport` to every call.
 *
 * The method names, options and results are Telegram-shaped for historical reasons: the daemon
 * contract was written against Telegram, and the worker's internals followed it. A Slack
 * implementation translates `createForumTopic` to `conversations.create`, a `thread not found` to
 * `channel_not_found`, and so on, rather than every call site learning a second vocabulary. The
 * names are kept because the daemon still speaks that vocabulary on the wire.
 *
 * `src/slack.ts` is the only file that knows Slack's host (egress guard test).
 */
/**
 * A provider call's outcome. Telegram's shape, kept for the daemon contract; Slack's errors are
 * mapped onto it.
 *
 * `no_transport` is internal: the address has no transport at all (a numeric chat id). It is never
 * serialized into a response body. Each caller maps it to its own answer (a 403/404/503, a
 * deleted row, or a log line) because a synthetic 400 would read to an old daemon as "the chat
 * provider refused the payload".
 */
export type ChatResult<T> =
  | { ok: true; result: T }
  | { ok: false; kind: "rate_limited"; retryAfter: number; response?: unknown }
  | { ok: false; kind: "thread_not_found"; response?: unknown }
  | { ok: false; kind: "topic_not_modified"; response?: unknown }
  | { ok: false; kind: "no_transport"; response?: undefined }
  | { ok: false; kind: "error"; errorCode?: number; description?: string; response?: unknown };

export interface SendMessageOptions {
  chatId: string | number;
  text: string;
  entities?: unknown[];
  replyMarkup?: unknown;
  messageThreadId?: number;
  /** Aborts the call (the fetch rejects). Callers that bound a request use this. */
  signal?: AbortSignal;
  /** Flag the post for an owner mention (still gated by `SLACK_NOTIFY_OWNER`). */
  notifyOwner?: boolean;
  /** Which `SLACK_NOTIFY_OWNER` category a flagged post is. Absent with `notifyOwner` means `errors`. */
  notifyCategory?: "questions" | "errors";
}

export interface SendRichMessageOptions {
  chatId: string | number;
  /** GitHub-flavoured markdown (Slack's markdown block). */
  markdown: string;
  /** The plain-text rendering, used as the notification text instead of the raw markdown. */
  text?: string;
  replyMarkup?: unknown;
  messageThreadId?: number;
  /** Flag the post for an owner mention (still gated by `SLACK_NOTIFY_OWNER`). */
  notifyOwner?: boolean;
  /** Which `SLACK_NOTIFY_OWNER` category a flagged post is. Absent with `notifyOwner` means `errors`. */
  notifyCategory?: "questions" | "errors";
  /** Aborts the Slack calls of this operation. */
  signal?: AbortSignal;
}

export interface EditMessageTextOptions {
  chatId: string | number;
  messageId: number;
  text: string;
  entities?: unknown[];
  replyMarkup?: unknown;
  /** Keep the owner mention on the edited message (gated by `SLACK_NOTIFY_OWNER`). */
  notifyOwner?: boolean;
  /** The category of that mention. */
  notifyCategory?: "questions" | "errors";
  /** Aborts the Slack calls of this operation. */
  signal?: AbortSignal;
}

export interface SendPhotoOptions {
  chatId: string | number;
  photo: Blob;
  filename: string;
  replyToMessageId?: number;
  messageThreadId?: number;
  /** Aborts the Slack calls of this operation. */
  signal?: AbortSignal;
}

export interface SendDocumentOptions {
  chatId: string | number;
  document: Blob;
  filename: string;
  replyToMessageId?: number;
  messageThreadId?: number;
  /** Aborts the Slack calls of this operation. */
  signal?: AbortSignal;
}

export interface ForumTopic {
  message_thread_id: number;
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
  is_name_implicit?: boolean;
}

export interface CreateForumTopicOptions {
  chatId: string | number;
  name: string;
  /** the session this conversation is for (channel name suffix, topic line). */
  sessionId?: string;
  /** a named topic's key, which becomes the channel name. */
  channelKey?: string;
  /** the channel's topic line, replacing the one derived from `name`. */
  topic?: string;
}

export interface EditForumTopicOptions {
  chatId: string | number;
  messageThreadId: number;
  name?: string;
  /** the session this conversation is for (channel name suffix, topic line). */
  sessionId?: string;
  /** a named topic's key, which fixes the channel name. Without it or `sessionId`, the channel is not renamed. */
  channelKey?: string;
  /** the channel's topic line, replacing the one derived from `name`. */
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

export interface ChatTransport {
  /** Post text (+ entities, + keyboard) into a chat, optionally into a topic/conversation. */
  sendMessage(options: SendMessageOptions): Promise<ChatResult<{ message_id: number }>>;
  /** Post one rich (markdown) message. */
  sendRichMessage(options: SendRichMessageOptions): Promise<ChatResult<{ message_id: number }>>;
  /** Edit a posted message in place (the question wizard). */
  editMessageText(options: EditMessageTextOptions): Promise<ChatResult<{ message_id?: number } | boolean>>;
  sendPhoto(options: SendPhotoOptions): Promise<ChatResult<{ message_id: number }>>;
  sendDocument(options: SendDocumentOptions): Promise<ChatResult<{ message_id: number }>>;
  /** Create a session's (or a named) conversation: a channel on Slack. */
  createForumTopic(options: CreateForumTopicOptions): Promise<ChatResult<ForumTopic>>;
  editForumTopic(options: EditForumTopicOptions): Promise<ChatResult<boolean>>;
  closeForumTopic(options: CloseForumTopicOptions): Promise<ChatResult<boolean>>;
  reopenForumTopic(options: ReopenForumTopicOptions): Promise<ChatResult<boolean>>;
  deleteForumTopic(options: DeleteForumTopicOptions): Promise<ChatResult<boolean>>;
}
