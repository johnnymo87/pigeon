import type { OpencodeClient } from "../opencode-client";
import { ChatMessageBuilder, type ChatEntity } from "../chat-message";

const DEFAULT_ALLOWED_PROVIDERS = ["anthropic", "openai"];

export interface ModelListCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  machineId?: string;
  allowedProviders?: string[];
  opencodeClient: Pick<OpencodeClient, "listProviders">;
  sendChatReply: (chatId: string, text: string, entities?: ChatEntity[]) => Promise<void>;
}

export interface ModelSetCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  model: string;
  machineId?: string;
  allowedProviders?: string[];
  opencodeClient: Pick<OpencodeClient, "listProviders">;
  storage: {
    sessions: {
      setModelOverride: (sessionId: string, model: string) => void;
    };
  };
  sendChatReply: (chatId: string, text: string, entities?: ChatEntity[]) => Promise<void>;
}

export async function ingestModelListCommand(input: ModelListCommandInput): Promise<void> {
  const { sessionId, chatId, opencodeClient, sendChatReply } = input;

  try {
    const result = await opencodeClient.listProviders();

    const allowedSet = new Set(input.allowedProviders ?? DEFAULT_ALLOWED_PROVIDERS);
    const allowedProviders = result.all.filter((p) => allowedSet.has(p.id));

    const b = new ChatMessageBuilder()
      .append("🤖 ")
      .appendBold("Available models:")
      .append("\n🆔 ")
      .appendCode(sessionId)
      .newline(2);

    for (const provider of allowedProviders) {
      b.appendBold(provider.id).newline();
      for (const modelId of Object.keys(provider.models)) {
        b.appendCode(`${provider.id}/${modelId}`).newline();
      }
      b.newline();
    }

    b.append("Current: ").appendCode(result.default.code ?? "unknown").newline(2);
    b.append("Reply: ").appendCode("/model <code>");

    const msg = b.build();
    await sendChatReply(chatId, msg.text, msg.entities);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendChatReply(chatId, `Failed to list models: ${message}`);
  }
}

export async function ingestModelSetCommand(input: ModelSetCommandInput): Promise<void> {
  const { sessionId, chatId, model, opencodeClient, storage, sendChatReply } = input;

  try {
    const result = await opencodeClient.listProviders();

    const slashIndex = model.indexOf("/");
    const providerID = model.slice(0, slashIndex);
    const modelID = model.slice(slashIndex + 1);

    const provider = result.all.find((p) => p.id === providerID);
    const modelExists = provider && modelID in provider.models;

    if (!modelExists) {
      const notFound = new ChatMessageBuilder()
        .append("Model ")
        .appendCode(model)
        .append(" not found. Use ")
        .appendCode("/model")
        .append(" to see available models.\n🆔 ")
        .appendCode(sessionId)
        .build();
      await sendChatReply(chatId, notFound.text, notFound.entities);
      return;
    }

    storage.sessions.setModelOverride(sessionId, model);
    const confirmation = new ChatMessageBuilder()
      .append("🤖 Model set to ")
      .appendCode(model)
      .append("\n🆔 ")
      .appendCode(sessionId)
      .build();
    await sendChatReply(chatId, confirmation.text, confirmation.entities);
    console.log(`[model-ingest] set commandId=${input.commandId} model=${model} session=${sessionId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendChatReply(chatId, `Failed to set model: ${message}`);
  }
}
