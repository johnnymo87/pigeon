import type { OpencodeClient } from "../opencode-client";
import { TgMessageBuilder, type TgEntity } from "../telegram-message";

export interface CompactCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "getSessionMessagesPage" | "summarize">;
  sendTelegramReply: (chatId: string, text: string, entities?: TgEntity[]) => Promise<void>;
}

/** Shape returned by opencode GET /session/:id/message (MessageV2.WithParts) */
interface SessionMessage {
  info: {
    role: string;
    model?: { providerID?: string; modelID?: string };
    /** On assistant messages: the model that actually answered. */
    providerID?: string;
    modelID?: string;
  };
  parts: unknown[];
}

/** Pages read back for the last user message before giving up (pigeon-hfsj). */
const COMPACT_PAGE_LIMIT = 20;
const COMPACT_MAX_PAGES = 5;

/**
 * The session's current model: from the newest user message that names one,
 * read newest page first. The whole transcript of a large session is seconds
 * of serve work and hundreds of MB (pigeon-hfsj). A long autonomous turn can
 * push that user message past the pages read, so the newest assistant
 * message's model (the one that actually answered) is the fallback.
 */
async function findCurrentModel(
  client: Pick<OpencodeClient, "getSessionMessagesPage">,
  sessionId: string,
): Promise<{ providerID: string; modelID: string } | undefined> {
  let before: string | undefined;
  let fromAssistant: { providerID: string; modelID: string } | undefined;
  for (let page = 0; page < COMPACT_MAX_PAGES; page++) {
    const res = await client.getSessionMessagesPage(sessionId, {
      limit: COMPACT_PAGE_LIMIT,
      ...(before !== undefined ? { before } : {}),
    });
    for (const m of [...(res.messages as SessionMessage[])].reverse()) {
      const info = m?.info;
      if (!info) continue;
      if (info.role === "user" && info.model?.providerID && info.model?.modelID) {
        return { providerID: info.model.providerID, modelID: info.model.modelID };
      }
      if (!fromAssistant && info.role === "assistant" && info.providerID && info.modelID) {
        fromAssistant = { providerID: info.providerID, modelID: info.modelID };
      }
    }
    if (!res.nextCursor) break;
    before = res.nextCursor;
  }
  return fromAssistant;
}

export async function ingestCompactCommand(input: CompactCommandInput): Promise<void> {
  const { commandId, sessionId, chatId, machineId, opencodeClient, sendTelegramReply } = input;
  const machineLabel = machineId ? ` on ${machineId}` : "";

  try {
    // The last user message carries the session's current model.
    const model = await findCurrentModel(opencodeClient, sessionId);

    if (!model) {
      const msg = new TgMessageBuilder()
        .append("No user messages found. Cannot determine model for compaction.\n🆔 ")
        .appendCode(sessionId)
        .build();
      await sendTelegramReply(chatId, msg.text, msg.entities);
      return;
    }

    const { providerID, modelID } = model;
    await opencodeClient.summarize(sessionId, providerID, modelID);
    console.log(`[compact-ingest] session compacted commandId=${commandId} sessionId=${sessionId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(chatId, `Failed to compact session${machineLabel}: ${message}`);
  }
}
