import os from "os";
import type { OpencodeClient } from "../opencode-client";
import type { LaunchMessage } from "./poller";

/** Treat a bare word (no slashes, no ~) as ~/projects/<word>. */
function expandShorthand(dir: string): string {
  if (!dir.includes("/") && !dir.startsWith("~")) return `~/projects/${dir}`;
  return dir;
}

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
}

export async function ingestLaunchCommand(input: LaunchCommandInput): Promise<void> {
  const { commandId, prompt, chatId, machineId, opencodeClient, sendTelegramReply } = input;
  const directory = resolveHome(expandShorthand(input.directory));
  const machineLabel = machineId ? ` on ${machineId}` : "";

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
      `Session started${machineLabel}:\n🆔 \`${session.id}\`\n📂 \`${directory}\`\n\nThe pigeon plugin will notify you when the session stops or has questions.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sendTelegramReply(chatId, `Failed to launch session${machineLabel}: ${message}`);
  }
}
