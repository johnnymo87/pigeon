import type { OpencodeClient } from "../opencode-client";

export interface LaunchCommandInput {
  commandId: string;
  directory: string;
  prompt: string;
  chatId: string;
  opencodeClient: OpencodeClient;
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
  sendAck: (commandId: string) => void;
}

export async function ingestLaunchCommand(input: LaunchCommandInput): Promise<void> {
  const { commandId, directory, prompt, chatId, opencodeClient, sendTelegramReply, sendAck } = input;

  sendAck(commandId);

  const healthy = await opencodeClient.healthCheck();
  if (!healthy) {
    await sendTelegramReply(chatId, "opencode serve is not running on this machine.");
    return;
  }

  try {
    const session = await opencodeClient.createSession(directory);
    await opencodeClient.sendPrompt(session.id, directory, prompt);
    await sendTelegramReply(
      chatId,
      `Session started: \`${session.id}\`\nDirectory: \`${directory}\`\n\nThe pigeon plugin will notify you when the session stops or has questions.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sendTelegramReply(chatId, `Failed to launch session: ${message}`);
  }
}
