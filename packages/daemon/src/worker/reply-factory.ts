import type { ChatEntity } from "../chat-message";

export type SendChatMessageFn = (
  chatId: string,
  text: string,
  opts: { entities?: ChatEntity[]; messageThreadId: number | undefined },
) => Promise<void>;

/**
 * Creates a sendChatReply callback that automatically binds messageThreadId
 * from a polled command message.
 *
 * Binding at the wiring layer (index.ts) is what keeps ingest modules ignorant
 * of channel while ensuring command replies land in the correct topic.
 */
export function createChatReplySender(
  sendChatMessage: SendChatMessageFn,
  msg: { messageThreadId?: number | null },
): (chatId: string, text: string, entities?: ChatEntity[]) => Promise<void> {
  return (chatId: string, text: string, entities?: ChatEntity[]) =>
    sendChatMessage(chatId, text, {
      entities,
      messageThreadId: msg.messageThreadId ?? undefined,
    });
}
