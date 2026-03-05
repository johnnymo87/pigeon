import type { OpencodeClient } from "../opencode-client";

export interface KillCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  machineId?: string;
  opencodeClient: OpencodeClient;
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
  sendAck: (commandId: string) => void;
}

export async function ingestKillCommand(input: KillCommandInput): Promise<void> {
  const { commandId, sessionId, chatId, machineId, opencodeClient, sendTelegramReply, sendAck } = input;
  const machineLabel = machineId ? ` on ${machineId}` : "";

  sendAck(commandId);

  try {
    await opencodeClient.deleteSession(sessionId);
    console.log(`[kill-ingest] session terminated sessionId=${sessionId}`);
    await sendTelegramReply(chatId, `Session \`${sessionId}\` terminated${machineLabel}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[kill-ingest] failed to terminate session sessionId=${sessionId}: ${message}`);
    await sendTelegramReply(chatId, `Failed to kill session${machineLabel}: ${message}`);
  }
}
