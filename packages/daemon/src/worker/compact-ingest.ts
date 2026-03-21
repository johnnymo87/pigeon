import type { OpencodeClient } from "../opencode-client.js";

export interface CompactCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "getSessionMessages" | "summarize">;
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
}

export async function ingestCompactCommand(input: CompactCommandInput): Promise<void> {
  const { sessionId, chatId, machineId, opencodeClient, sendTelegramReply } = input;
  const machineLabel = machineId ? ` on ${machineId}` : "";

  try {
    const messages = await opencodeClient.getSessionMessages(sessionId);

    // Find the last user message to extract the current model
    const lastUserMessage = [...messages]
      .reverse()
      .find((m: any) => m.role === "user" && m.model?.providerID && m.model?.modelID) as any;

    if (!lastUserMessage) {
      await sendTelegramReply(
        chatId,
        `No user messages found in session \`${sessionId}\`. Cannot determine model for compaction.`,
      );
      return;
    }

    const { providerID, modelID } = lastUserMessage.model;
    await opencodeClient.summarize(sessionId, providerID, modelID);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(chatId, `Failed to compact session${machineLabel}: ${message}`);
  }
}
