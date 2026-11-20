/**
 * Picking a ChatTransport by address (spec §1, "A stored conversation goes where it lives").
 * See `./transport.ts` for the interface and why it is Telegram-shaped.
 */
import { createTelegramClient } from "../telegram";
import type { ChatResult, ChatTransport } from "./transport";

export type { ChatResult, ChatTransport } from "./transport";

/** Slack workspace chat ids are `slack:<teamId>`; Telegram chat ids are numeric. */
export const SLACK_CHAT_PREFIX = "slack:";

export function isSlackChatId(chatId: string | number): boolean {
  return typeof chatId === "string" && chatId.startsWith(SLACK_CHAT_PREFIX);
}

/**
 * The failure every call to a Slack address gets until the Slack transport exists
 * (pigeon-4ogz.3). No `slack:` row can exist before then, so this is a guard, not a path: it makes
 * sure a Slack address can never be handed to the Telegram Bot API. It is classified transient
 * (no 4xx code), so a caller holds and retries rather than relocating to General.
 */
function slackUnavailable<T>(method: string): Promise<ChatResult<T>> {
  console.warn("[worker] slack transport not available", { method });
  return Promise.resolve({ ok: false, kind: "error", description: "slack transport not available" });
}

const SLACK_UNAVAILABLE: ChatTransport = {
  sendMessage: () => slackUnavailable("sendMessage"),
  sendRichMessage: () => slackUnavailable("sendRichMessage"),
  editMessageText: () => slackUnavailable("editMessageText"),
  sendPhoto: () => slackUnavailable("sendPhoto"),
  sendDocument: () => slackUnavailable("sendDocument"),
  createForumTopic: () => slackUnavailable("createForumTopic"),
  editForumTopic: () => slackUnavailable("editForumTopic"),
  closeForumTopic: () => slackUnavailable("closeForumTopic"),
  reopenForumTopic: () => slackUnavailable("reopenForumTopic"),
  deleteForumTopic: () => slackUnavailable("deleteForumTopic"),
  unpinAllForumTopicMessages: () => slackUnavailable("unpinAllForumTopicMessages"),
};

/**
 * The transport for a chat address.
 *
 * `telegram` replaces the Telegram transport only (tests inject fakes this way, through the
 * existing `tgClient` options); a Slack address never reaches it.
 */
export function transportForChat(
  chatId: string | number,
  botToken: string,
  telegram?: ChatTransport,
): ChatTransport {
  if (isSlackChatId(chatId)) return SLACK_UNAVAILABLE;
  return telegram ?? createTelegramClient(botToken);
}
