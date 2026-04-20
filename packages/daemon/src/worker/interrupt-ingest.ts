import type { OpencodeClient } from "../opencode-client";
import { TgMessageBuilder, type TgEntity } from "../telegram-message";

export interface InterruptCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  machineId?: string;
  opencodeClient: OpencodeClient;
  sendTelegramReply: (chatId: string, text: string, entities?: TgEntity[]) => Promise<void>;
}

export async function ingestInterruptCommand(input: InterruptCommandInput): Promise<void> {
  const { commandId, sessionId, chatId, machineId, opencodeClient, sendTelegramReply } = input;
  const machineLabel = machineId ? ` on ${machineId}` : "";

  try {
    await opencodeClient.abortSession(sessionId);
    console.log(`[interrupt-ingest] session interrupted sessionId=${sessionId}`);
    const msg = new TgMessageBuilder()
      .append(`Session interrupted${machineLabel}.\n🆔 `)
      .appendCode(sessionId)
      .build();
    await sendTelegramReply(chatId, msg.text, msg.entities);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[interrupt-ingest] failed to interrupt session sessionId=${sessionId}: ${message}`);
    await sendTelegramReply(chatId, `Failed to interrupt session${machineLabel}: ${message}`);
  }
}
