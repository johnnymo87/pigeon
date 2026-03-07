import os from "os";
import type { OpencodeClient } from "../opencode-client";

/** Resolve leading `~` or `~/` to the user's home directory. */
function resolveHome(dir: string): string {
  if (dir === "~") return os.homedir();
  if (dir.startsWith("~/")) return os.homedir() + dir.slice(1);
  return dir;
}

export interface LaunchCommandInput {
  commandId: string;
  directory: string;
  prompt: string;
  chatId: string;
  machineId?: string;
  opencodeClient: OpencodeClient;
  sendTelegramReply: (chatId: string, text: string) => Promise<void>;
  sendAck: (commandId: string) => void;
}

export async function ingestLaunchCommand(input: LaunchCommandInput): Promise<void> {
  const { commandId, prompt, chatId, machineId, opencodeClient, sendTelegramReply, sendAck } = input;
  const directory = resolveHome(input.directory);
  const machineLabel = machineId ? ` on ${machineId}` : "";

  sendAck(commandId);

  const healthy = await opencodeClient.healthCheck();
  if (!healthy) {
    await sendTelegramReply(chatId, `opencode serve is not running${machineLabel}.`);
    return;
  }

  try {
    const session = await opencodeClient.createSession(directory);
    await opencodeClient.sendPrompt(session.id, directory, prompt);
    console.log(`[launch-ingest] session started sessionId=${session.id} directory=${directory}`);
    await sendTelegramReply(
      chatId,
      `Session started${machineLabel}: \`${session.id}\`\nDirectory: \`${directory}\`\n\nThe pigeon plugin will notify you when the session stops or has questions.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sendTelegramReply(chatId, `Failed to launch session${machineLabel}: ${message}`);
  }
}
