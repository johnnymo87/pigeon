import os from "os";
import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import type { OpencodeClient } from "../opencode-client";
import { TgMessageBuilder, type TgEntity } from "../telegram-message";
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
  sendTelegramReply: (chatId: string, text: string, entities?: TgEntity[]) => Promise<void>;
  /** Injected for tests; defaults to node child_process.spawn. */
  spawn?: (cmd: string, args: ReadonlyArray<string>, opts?: { stdio?: "ignore" | "inherit" | "pipe"; detached?: boolean }) => ChildProcess;
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

    // Auto-attach: best-effort, fire-and-forget. If oc-auto-attach is not
    // installed (e.g. cloudbox), node spawn emits ENOENT asynchronously
    // on the child's 'error' event — we MUST listen for it or node crashes.
    // The synchronous try/catch handles rare cases like invalid arguments
    // that throw immediately.
    try {
      const spawnFn = input.spawn ?? nodeSpawn;
      const child = spawnFn("oc-auto-attach", [session.id], {
        stdio: "ignore",
        detached: true,
      });
      child.on?.("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") {
          console.warn(`[launch-ingest] auto-attach spawn failed (async):`, err);
        }
      });
      child.unref?.();
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn(`[launch-ingest] auto-attach spawn failed (sync):`, err);
      }
    }

    const msg = new TgMessageBuilder()
      .append(`Session started${machineLabel}:\n🆔 `)
      .appendCode(session.id)
      .append("\n📂 ")
      .appendCode(directory)
      .append("\n\nThe pigeon plugin will notify you when the session stops or has questions.")
      .build();
    await sendTelegramReply(chatId, msg.text, msg.entities);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sendTelegramReply(chatId, `Failed to launch session${machineLabel}: ${message}`);
  }
}
