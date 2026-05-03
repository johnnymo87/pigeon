import os from "os";
import { openSync } from "fs";
import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import type { OpencodeClient } from "../opencode-client";
import { TgMessageBuilder, type TgEntity } from "../telegram-message";
import type { LaunchMessage } from "./poller";

/** Path of the log file shared with the home.base.nix shell wrapper. */
const AUTO_ATTACH_LOG_PATH = "/tmp/oc-auto-attach.log";

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
  spawn?: (cmd: string, args: ReadonlyArray<string>, opts?: { stdio?: "ignore" | "inherit" | "pipe" | Array<"ignore" | "inherit" | "pipe" | number>; detached?: boolean }) => ChildProcess;
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
    //
    // OC_AUTO_ATTACH_BIN env var lets systemd-managed deployments pin an
    // absolute path to the binary. Required on hosts (e.g. cloudbox) where
    // the daemon's PATH is a locked-down nix-store list that does NOT
    // include ~/.nix-profile/bin — without it, spawn would silently ENOENT
    // and the auto-attach to nvim+tmux for telegram /launch would never run.
    //
    // We route the child's stdout AND stderr to /tmp/oc-auto-attach.log
    // (the same log file the home.base.nix shell wrapper uses). Without
    // this, daemon-spawned launches would discard the script's logs and
    // any internal failure (e.g. a missing tool in the script's PATH
    // under `set -o pipefail`) would be completely invisible. We hit
    // exactly that on cloudbox: oc-auto-attach silently failed for a
    // /launch into a project without an existing tmux window because
    // `awk` was missing from the script's hard-coded PATH.
    //
    // openSync failure (e.g. /tmp not writable) is swallowed — we'd
    // rather lose logs than crash the launcher.
    try {
      const spawnFn = input.spawn ?? nodeSpawn;
      const bin = process.env.OC_AUTO_ATTACH_BIN ?? "oc-auto-attach";
      let logFd: number | "ignore" = "ignore";
      try {
        logFd = openSync(AUTO_ATTACH_LOG_PATH, "a");
      } catch (logErr: unknown) {
        console.warn(`[launch-ingest] could not open ${AUTO_ATTACH_LOG_PATH}:`, logErr);
      }
      const child = spawnFn(bin, [session.id], {
        stdio: ["ignore", logFd, logFd],
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
