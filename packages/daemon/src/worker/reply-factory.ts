import type { TgEntity } from "../telegram-message";

export type SendTelegramMessageFn = (
  chatId: string,
  text: string,
  opts: { entities?: TgEntity[]; messageThreadId: number | undefined },
) => Promise<void>;

/**
 * Creates a sendTelegramReply callback that automatically binds messageThreadId
 * from a polled command message.
 *
 * Binding at the wiring layer (index.ts) is what keeps ingest modules ignorant
 * of Telegram forum topics while ensuring command replies land in the correct topic.
 */
export function createTelegramReplySender(
  sendTelegramMessage: SendTelegramMessageFn,
  msg: { messageThreadId?: number | null },
): (chatId: string, text: string, entities?: TgEntity[]) => Promise<void> {
  return (chatId: string, text: string, entities?: TgEntity[]) =>
    sendTelegramMessage(chatId, text, {
      entities,
      messageThreadId: msg.messageThreadId ?? undefined,
    });
}
