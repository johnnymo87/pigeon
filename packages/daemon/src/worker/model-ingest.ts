import type { OpencodeClient } from "../opencode-client";

const ALLOWED_PROVIDERS = new Set(["anthropic", "openai", "google", "vertex"]);

export interface ModelListCommandInput {
  commandId: string;
  sessionId: string;
  chatId: string;
  machineId?: string;
  opencodeClient: Pick<OpencodeClient, "listProviders">;
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
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
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
}

export async function ingestModelListCommand(input: ModelListCommandInput): Promise<void> {
  const { sessionId, chatId, opencodeClient, sendTelegramReply } = input;

  try {
    const result = await opencodeClient.listProviders();

    const allowedProviders = result.all.filter((p) => ALLOWED_PROVIDERS.has(p.id));

    let body = `🤖 *Available models:*\n🆔 \`${sessionId}\`\n\n`;

    for (const provider of allowedProviders) {
      body += `*${provider.id}*\n`;
      for (const modelId of Object.keys(provider.models)) {
        body += `\`${provider.id}/${modelId}\`\n`;
      }
      body += "\n";
    }

    body += `Current: \`${result.default.code}\`\n\n`;
    body += `Reply: \`/model <code> ${sessionId}\``;

    await sendTelegramReply(chatId, body);
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
      await sendTelegramReply(
        chatId,
        `Model \`${model}\` not found. Use \`/model ${sessionId}\` to see available models.`,
      );
      return;
    }

    storage.sessions.setModelOverride(sessionId, model);
    await sendTelegramReply(chatId, `🤖 Model set to \`${model}\` for session \`${sessionId}\``);
    console.log(`[model-ingest] set commandId=${input.commandId} model=${model} session=${sessionId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendTelegramReply(chatId, `Failed to set model: ${message}`);
  }
}
