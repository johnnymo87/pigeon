import type { OpencodeClient } from "../opencode-client";
import type { KillMessage } from "./poller";

export interface KillCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  machineId?: string;
  opencodeClient: OpencodeClient;
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
}

export async function ingestKillCommand(input: KillCommandInput): Promise<void> {
  const { commandId, sessionId, chatId, machineId, opencodeClient, sendTelegramReply } = input;
  const machineLabel = machineId ? ` on ${machineId}` : "";

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
