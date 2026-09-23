import os from "os";
import { openSync } from "fs";
import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import type { OpencodeClient } from "../opencode-client";
import { TgMessageBuilder, type TgEntity } from "../telegram-message";
import { describeOcTagsFailure, type OcTagsRunner } from "./oc-tags";
import { isValidSessionId, isValidTag, truncate } from "./tag-ingest";
import { parseWhichLine } from "../tag-resolver";
import type { LaunchMessage } from "./poller";

/**
 * Budget for the `oc-tags which` behind tag inheritance. Same as the footer
 * resolver's: `which` never reads the message table, so a slow one means a
 * contended DB, and the launch confirmation should not wait 20s on it.
 */
export const INHERIT_WHICH_TIMEOUT_MS = 3_000;

/** Path of the log file shared with the home.base.nix shell wrapper. */
const AUTO_ATTACH_LOG_PATH = "/tmp/oc-auto-attach.log";

/** Treat a bare word (no slashes, no ~) as ~/projects/<word> (or ~/Code/<word> on macOS). */
export function expandShorthand(dir: string): string {
  if (!dir.includes("/") && !dir.startsWith("~")) {
    const isDarwin = os.platform() === "darwin";
    return isDarwin ? `~/Code/${dir}` : `~/projects/${dir}`;
  }
  return dir;
}

/** Resolve leading `~` or `~/` to the user's home directory. */
export function resolveHome(dir: string): string {
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
  /**
   * Resolve the client for the serve that OWNS a session (pigeon HRW placement).
   * The session is created on `opencodeClient` (serve-0) but its agent loop must
   * run on the serve pigeon assigns, so the prompt is sent via this owner. When
   * absent, or when it returns undefined (no healthy pool serve), the launch
   * degrades to sending on `opencodeClient` — the pre-pool single-serve behavior.
   */
  resolveOwnerClient?: (sessionId: string) => OpencodeClient | undefined;
  /**
   * Optional oc-tags tag from `/launch <machine> <dir> --tag <tag> <prompt>`.
   *
   * Absent on every ordinary launch. It is an OVERRIDE, not a creation: every
   * session already has exactly one tag, so this converts the new session off
   * the directory-derived "auto:" fallback that would otherwise say nothing
   * about what the session was launched to do.
   */
  tag?: string;
  /**
   * The session this /launch was sent in the context of (its forum topic or a
   * swipe-reply to its notification), set by the worker only when no `--tag`
   * was given and that session is on this machine. If oc-tags says its tag is
   * an explicit SESSION tag, the new session gets a copy. A directory-glob or
   * `auto:` tag is never inherited. Absent from an old worker.
   */
  inheritFromSessionId?: string;
  /** null (or absent) means oc-tags is not installed on this machine. */
  runOcTags?: OcTagsRunner | null;
  /**
   * Runner for the inheritance `oc-tags which`, with the short
   * INHERIT_WHICH_TIMEOUT_MS budget. Absent: falls back to runOcTags.
   */
  runOcTagsWhich?: OcTagsRunner | null;
  /**
   * Called once `--tag` has actually been applied, so a cached tag for this
   * session can be refetched. A throw is swallowed — the tag is written either
   * way, and this must not cost the confirmation message.
   */
  onTagged?: (sessionId: string) => void;
  sendTelegramReply: (chatId: string, text: string, entities?: TgEntity[]) => Promise<void>;
  /** Injected for tests; defaults to node child_process.spawn. */
  spawn?: (cmd: string, args: ReadonlyArray<string>, opts?: { stdio?: "ignore" | "inherit" | "pipe" | Array<"ignore" | "inherit" | "pipe" | number>; detached?: boolean }) => ChildProcess;
}

/**
 * Last non-empty line, which for a Python traceback is the only useful one.
 *
 * Truncated with tag-ingest's surrogate-safe helper rather than slice(): a lone
 * surrogate makes the JSON body invalid UTF-8 and Telegram rejects the WHOLE
 * message with a 400 — and on this path that message is the one carrying the
 * session id.
 */
function lastLine(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const lines = (candidate ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (lines.length > 0) return truncate(lines[lines.length - 1]!, 300);
  }
  return "";
}

/**
 * Tags the freshly launched session, and NEVER throws or rejects.
 *
 * Two invariants:
 *
 *  - **It cannot throw.** A throw would propagate out of ingestLaunchCommand to
 *    the poller, which skips the ack, and the redelivered launch is a DUPLICATE
 *    SESSION. Losing a launch — or doubling one — to a bookkeeping write is a
 *    strictly worse trade than losing the tag row.
 *  - **It always returns a line naming a reason.** Nobody reads stderr on a
 *    phone, so an unexplained failure here is simply invisible.
 *
 * The tag is validated here even though the worker validated it before queueing,
 * because this is the side that spawns a process: the value arrives from a D1
 * row via metadata_json, not from that function's return value. An invalid tag
 * skips the spawn but still launches — the daemon-side path is reachable only
 * through a tampered row (whoever holds the API key can already queue any launch
 * they like) or through drift between the two validator copies, where refusing
 * would reject a tag the worker had just accepted.
 */
async function applyTag(
  tag: string,
  sessionId: string,
  runOcTags: OcTagsRunner | null | undefined,
  machineLabel: string,
  onTagged?: (sessionId: string) => void,
): Promise<string> {
  if (!isValidTag(tag)) {
    return `Tag not applied: invalid tag ${truncate(String(tag), 64)}`;
  }
  if (!runOcTags) {
    return `Tag not applied: oc-tags is not installed${machineLabel}.`;
  }

  try {
    // argv, never a command string, and `set <tag> <session-id>` — tag FIRST.
    // Reversed, oc-tags tags a session literally named after the tag and reports
    // success.
    const result = await runOcTags(["set", tag, sessionId]);
    if (result.code !== 0) {
      return `Tag not applied: ${lastLine(result.stderr, result.stdout) || `oc-tags exited ${result.code}`}`;
    }
    // The session already registered, so a tag cache may hold the pre-tag
    // answer. Without this the confirmation below says `🏷 Tagged ...` and the
    // session's first notification arrives with no tag on it, which reads as
    // the tag not having taken.
    try {
      onTagged?.(sessionId);
    } catch (err) {
      console.warn(`[launch-ingest] onTagged threw session=${sessionId}:`, err);
    }
    // oc-tags' OWN confirmation line: it lowercases, so `--tag FBM` is charted
    // as `fbm`, and a line composed here would name a tag the chart never shows.
    return lastLine(result.stdout) || `Tagged ${sessionId} as ${tag}`;
  } catch (err) {
    return `Tag not applied: ${describeOcTagsFailure(err)}`;
  }
}

/**
 * Copies the context session's explicit tag onto the new session, and NEVER
 * throws or rejects — for the same duplicate-session reason as applyTag: the
 * runner rejects on timeout, and a throw here would skip the poller's ack and
 * redeliver the launch.
 *
 * Returns the line for the confirmation, or null when there was nothing to
 * report. The worker has already told the human "will inherit tag from X", so
 * every outcome that is not an inheritance says why.
 */
async function inheritTag(
  input: LaunchCommandInput,
  sessionId: string,
  machineLabel: string,
): Promise<string | null> {
  const parent = input.inheritFromSessionId;
  try {
    if (parent === undefined) return null;
    if (!isValidSessionId(parent)) {
      return `Tag not inherited: invalid session id ${truncate(String(parent), 64)}`;
    }
    const runWhich = input.runOcTagsWhich !== undefined ? input.runOcTagsWhich : input.runOcTags;
    if (!runWhich) {
      return `Tag not inherited: oc-tags is not installed${machineLabel}.`;
    }

    let result;
    try {
      result = await runWhich(["which", parent]);
    } catch (err) {
      return `Tag not inherited from ${parent}: ${describeOcTagsFailure(err, INHERIT_WHICH_TIMEOUT_MS)}`;
    }
    if (!result || result.code !== 0) {
      const reason = result ? lastLine(result.stderr, result.stdout) || `oc-tags exited ${result.code}` : "no result";
      return `Tag not inherited from ${parent}: ${reason}`;
    }

    const which = parseWhichLine(String(result.stdout ?? ""));
    if (!which) {
      return `Tag not inherited from ${parent}: could not read oc-tags which output`;
    }
    if (which.kind === undefined) {
      // A pre-column-4 oc-tags says `manual` for a session tag AND a directory
      // glob alike; guessing would copy a place onto a piece of work.
      return `Tag not inherited from ${parent}: oc-tags is too old to tell a session tag from a directory tag`;
    }
    if (which.kind !== "session") {
      return `No tag inherited: ${parent} has no session tag (${which.tag} comes from ${which.kind === "dir" ? "a directory glob" : "the auto: fallback"})`;
    }

    const line = await applyTag(which.tag, sessionId, input.runOcTags, machineLabel, input.onTagged);
    return line.startsWith("Tag not applied")
      ? `${line} (inheriting from ${parent})`
      : `${line} (inherited from ${parent})`;
  } catch (err) {
    console.warn(`[launch-ingest] tag inheritance failed session=${sessionId} parent=${String(parent)}:`, err);
    return `Tag not inherited: ${err instanceof Error ? err.message : String(err)}`;
  }
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
    // Route the prompt to the serve that owns the session (HRW placement);
    // fall back to the create serve when routing is unavailable.
    const owner = input.resolveOwnerClient?.(session.id) ?? opencodeClient;
    await owner.sendPrompt(session.id, directory, prompt);
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

    // Tagging happens LAST, after the session exists and the prompt is away.
    // That costs nothing, because oc-tags attribution is retroactive: report/top
    // join costs against tags.db at read time (aggregate() takes the tag maps as
    // arguments and session_tag.created_at is written but never read), so a tag
    // written a second late still covers every dollar this session ever spends.
    // There is no race to win by tagging earlier, only a launch to risk.
    //
    // An explicit --tag wins outright: the inheritance lookup is not even run.
    const tagLine = input.tag === undefined
      ? await inheritTag(input, session.id, machineLabel)
      : await applyTag(input.tag, session.id, input.runOcTags, machineLabel, input.onTagged);
    if (tagLine) {
      const what = input.tag === undefined ? `inherit=${input.inheritFromSessionId}` : `tag=${input.tag}`;
      console.log(`[launch-ingest] tag commandId=${input.commandId} session=${session.id} ${what}: ${tagLine}`);
    }

    const builder = new TgMessageBuilder()
      .append(`Session started${machineLabel}:\n🆔 `)
      .appendCode(session.id)
      .append("\n📂 ")
      .appendCode(directory);
    if (tagLine) {
      builder.append(`\n🏷 ${tagLine}`);
    }
    const msg = builder
      .append("\n\nThe pigeon plugin will notify you when the session stops or has questions.")
      .build();
    await sendTelegramReply(chatId, msg.text, msg.entities);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sendTelegramReply(chatId, `Failed to launch session${machineLabel}: ${message}`);
  }
}
