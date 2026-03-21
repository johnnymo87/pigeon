import type { OpencodeClient } from "../opencode-client";

export interface CompactCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "getSessionMessages" | "summarize">;
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
}

interface MessageWithModel {
  role: string;
  model?: { providerID?: string; modelID?: string };
}

export async function ingestCompactCommand(input: CompactCommandInput): Promise<void> {
  const { commandId, sessionId, chatId, machineId, opencodeClient, sendTelegramReply } = input;
  const machineLabel = machineId ? ` on ${machineId}` : "";

  try {
    const messages = await opencodeClient.getSessionMessages(sessionId);

    // Find the last user message to extract the current model
    const lastUserMessage = [...messages]
      .reverse()
      .find((m): m is MessageWithModel => {
        const msg = m as MessageWithModel;
        return msg.role === "user" && !!msg.model?.providerID && !!msg.model?.modelID;
      });

    if (!lastUserMessage) {
      await sendTelegramReply(
        chatId,
        `No user messages found in session \`${sessionId}\`. Cannot determine model for compaction.`,
      );
      return;
    }

    const { providerID, modelID } = lastUserMessage.model!;
    await opencodeClient.summarize(sessionId, providerID!, modelID!);
    console.log(`[compact-ingest] session compacted commandId=${commandId} sessionId=${sessionId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(chatId, `Failed to compact session${machineLabel}: ${message}`);
  }
}
