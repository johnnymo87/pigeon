import type { OpencodeClient } from "../opencode-client";
import { ChatMessageBuilder, type ChatEntity } from "../chat-message";

export interface InterruptCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  machineId?: string;
  opencodeClient: OpencodeClient;
  sendChatReply: (chatId: string, text: string, entities?: ChatEntity[]) => Promise<void>;
}

export async function ingestInterruptCommand(input: InterruptCommandInput): Promise<void> {
  const { commandId, sessionId, chatId, machineId, opencodeClient, sendChatReply } = input;
  const machineLabel = machineId ? ` on ${machineId}` : "";

  try {
    await opencodeClient.abortSession(sessionId);
    console.log(`[interrupt-ingest] session interrupted sessionId=${sessionId}`);
    const msg = new ChatMessageBuilder()
      .append(`Session interrupted${machineLabel}.\n🆔 `)
      .appendCode(sessionId)
      .build();
    await sendChatReply(chatId, msg.text, msg.entities);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[interrupt-ingest] failed to interrupt session sessionId=${sessionId}: ${message}`);
    await sendChatReply(chatId, `Failed to interrupt session${machineLabel}: ${message}`);
  }
}
