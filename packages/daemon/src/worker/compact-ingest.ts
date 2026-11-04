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
  };
  parts: unknown[];
}

type UserWithModel = SessionMessage & {
  info: { role: "user"; model: { providerID: string; modelID: string } };
};

/** Pages read back for the last user message before giving up (pigeon-hfsj). */
const COMPACT_PAGE_LIMIT = 20;
const COMPACT_MAX_PAGES = 5;

/**
 * The newest user message that names a model, read newest page first. The
 * whole transcript of a large session is seconds of serve work and hundreds of
 * MB (pigeon-hfsj); the answer is almost always in the first page.
 */
async function findLastUserWithModel(
  client: Pick<OpencodeClient, "getSessionMessagesPage">,
  sessionId: string,
): Promise<UserWithModel | undefined> {
  let before: string | undefined;
  for (let page = 0; page < COMPACT_MAX_PAGES; page++) {
    const res = await client.getSessionMessagesPage(sessionId, {
      limit: COMPACT_PAGE_LIMIT,
      ...(before !== undefined ? { before } : {}),
    });
    const found = [...(res.messages as SessionMessage[])]
      .reverse()
      .find(
        (m): m is UserWithModel =>
          m?.info?.role === "user" && !!m.info.model?.providerID && !!m.info.model?.modelID,
      );
    if (found) return found;
    if (!res.nextCursor) return undefined;
    before = res.nextCursor;
  }
  return undefined;
}

export async function ingestCompactCommand(input: CompactCommandInput): Promise<void> {
  const { commandId, sessionId, chatId, machineId, opencodeClient, sendTelegramReply } = input;
  const machineLabel = machineId ? ` on ${machineId}` : "";

  try {
    // The last user message carries the session's current model.
    const lastUserMessage = await findLastUserWithModel(opencodeClient, sessionId);

    if (!lastUserMessage) {
      const msg = new TgMessageBuilder()
        .append("No user messages found. Cannot determine model for compaction.\n🆔 ")
        .appendCode(sessionId)
        .build();
      await sendTelegramReply(chatId, msg.text, msg.entities);
      return;
    }

    const { providerID, modelID } = lastUserMessage.info.model;
    await opencodeClient.summarize(sessionId, providerID, modelID);
    console.log(`[compact-ingest] session compacted commandId=${commandId} sessionId=${sessionId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(chatId, `Failed to compact session${machineLabel}: ${message}`);
  }
}
