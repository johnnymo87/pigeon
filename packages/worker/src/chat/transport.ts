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
 * Inbound-only Telegram calls (`getFile`, `downloadFile`, `answerCallbackQuery`) are not here: they
 * belong to the Telegram webhook, and Slack's ingress has its own equivalents.
 *
 * `src/telegram.ts` remains the only file that knows Telegram's host (egress guard test).
 */
import type {
  CloseForumTopicOptions,
  CreateForumTopicOptions,
  DeleteForumTopicOptions,
  EditForumTopicOptions,
  EditMessageTextOptions,
  ForumTopic,
  ReopenForumTopicOptions,
  SendDocumentOptions,
  SendMessageOptions,
  SendPhotoOptions,
  SendRichMessageOptions,
  TgResult,
  UnpinAllForumTopicMessagesOptions,
} from "../telegram";

/** A provider call's outcome. Telegram's shape; other transports map their errors onto it. */
export type ChatResult<T> = TgResult<T>;

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
