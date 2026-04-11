import type { OpencodeClient } from "../opencode-client";
import { TgMessageBuilder, type TgEntity } from "../telegram-message";

const ALLOWED_PROVIDERS = new Set(["anthropic", "openai", "google", "vertex"]);

export interface ModelListCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "listProviders">;
  sendTelegramReply: (chatId: string, text: string, entities?: TgEntity[]) => Promise<void>;
}

export interface ModelSetCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  model: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "listProviders">;
  storage: {
    sessions: {
      setModelOverride: (sessionId: string, model: string) => void;
    };
  };
  sendTelegramReply: (chatId: string, text: string, entities?: TgEntity[]) => Promise<void>;
}

export async function ingestModelListCommand(input: ModelListCommandInput): Promise<void> {
  const { sessionId, chatId, opencodeClient, sendTelegramReply } = input;

  try {
    const result = await opencodeClient.listProviders();

    const allowedProviders = result.all.filter((p) => ALLOWED_PROVIDERS.has(p.id));

    const b = new TgMessageBuilder()
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
    await sendTelegramReply(chatId, msg.text, msg.entities);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(chatId, `Failed to list models: ${message}`);
  }
}

export async function ingestModelSetCommand(input: ModelSetCommandInput): Promise<void> {
  const { sessionId, chatId, model, opencodeClient, storage, sendTelegramReply } = input;

  try {
    const result = await opencodeClient.listProviders();

    const slashIndex = model.indexOf("/");
    const providerID = model.slice(0, slashIndex);
    const modelID = model.slice(slashIndex + 1);

    const provider = result.all.find((p) => p.id === providerID);
    const modelExists = provider && modelID in provider.models;

    if (!modelExists) {
      const notFound = new TgMessageBuilder()
        .append("Model ")
        .appendCode(model)
        .append(" not found. Use ")
        .appendCode("/model")
        .append(" to see available models.\n🆔 ")
        .appendCode(sessionId)
        .build();
      await sendTelegramReply(chatId, notFound.text, notFound.entities);
      return;
    }

    storage.sessions.setModelOverride(sessionId, model);
    const confirmation = new TgMessageBuilder()
      .append("🤖 Model set to ")
      .appendCode(model)
      .append("\n🆔 ")
      .appendCode(sessionId)
      .build();
    await sendTelegramReply(chatId, confirmation.text, confirmation.entities);
    console.log(`[model-ingest] set commandId=${input.commandId} model=${model} session=${sessionId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(chatId, `Failed to set model: ${message}`);
  }
}
