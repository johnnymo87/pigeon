/**
 * Slash-command parsing shared by every chat ingress (chat-transport phase 2, bead pigeon-4ogz.1;
 * spec §5 "Slash commands"). Telegram's webhook uses it today; the Slack ingress (pigeon-4ogz.4)
 * will use the same parser, so a command means the same thing wherever it is typed.
 *
 * Input is the command text AFTER transport-specific normalisation (Telegram's `@BotName` suffix
 * is stripped by `parseTelegramCommand` first). Output names the command; resolving which session
 * it is about, and replying, stay with the caller.
 *
 * `null` means "not one of our commands": the caller treats the text as an ordinary message,
 * exactly as before this module existed. A malformed /launch or /tag is NOT null (those answer
 * with usage, never fall through), which is unchanged too.
 */
import { parseLaunchMessage, type LaunchCommand } from "../launch-command";
import { parseTagArgs, type TagCommand } from "../tag-command";

/** Command types a session command queues (`commands.command_type`). */
export type SessionCommandType =
  | "kill"
  | "interrupt"
  | "compact"
  | "mcp_list"
  | "mcp_enable"
  | "mcp_disable"
  | "model_list"
  | "model_set";

export type ChatCommand =
  | { kind: "launch"; launch: LaunchCommand }
  /**
   * A command about one session. `arg` is the queued `command` column (an MCP server name, a
   * provider/model, or ""). `target`, when present, is the optional leading `<session-id>`: a full
   * id or a prefix, resolved by `resolveSessionRef`. Without it the session comes from context
   * (swipe-reply or topic on Telegram, the channel on Slack).
   */
  | { kind: "session"; type: SessionCommandType; arg: string; target?: string }
  | { kind: "rename"; title: string | undefined }
  | { kind: "tag"; args: TagCommand }
  /**
   * A session command whose arguments do not parse (`/kill now`, `/kill ses_e7128` with a
   * too-short id, `/mcp`). Answered with `SESSION_COMMAND_USAGE_TEXT`, never forwarded: the same
   * rule /launch and /tag carry, and the one that matters once `<session-id>` arguments are
   * invited, because a near-miss would otherwise be injected into the session as a prompt.
   */
  | { kind: "usage"; command: string };

export const SESSION_COMMAND_USAGE_TEXT = [
  "Usage (the session id is optional: a full ses_/gse_ id or at least 8 characters of one;",
  "without it, the session you replied to or whose topic this is):",
  "/kill [<session-id>]",
  "/interrupt [<session-id>]",
  "/compact [<session-id>]",
  "/mcp [<session-id>] list | enable <server> | disable <server>",
  "/model [<session-id>] [<provider/model>]",
].join("\n");

/** Command names whose malformed forms answer with usage (`/killall` is not one of them). */
const SESSION_COMMAND_NAME_RE = /^\/(kill|interrupt|compact|mcp)(?=$|\s)/;

/**
 * A session reference: an opencode (`ses_`) or goose (`gse_`) id, whole or cut short after at
 * least 8 characters, the same floor mention-links uses (coordinators write `ses_e71285de`).
 * The leading `ses_`/`gse_` keeps it from ever being mistaken for a server or model name, and from
 * looking like a flag.
 */
const REF = "((?:ses|gse)_[A-Za-z0-9_-]{8,})";
export const SESSION_REF_RE = new RegExp(`^${REF}$`);

const KILL_RE = new RegExp(`^\\/(kill|interrupt|compact)(?:\\s+${REF})?$`);
const MCP_LIST_RE = new RegExp(`^\\/mcp(?:\\s+${REF})?\\s+list$`);
const MCP_TOGGLE_RE = new RegExp(`^\\/mcp(?:\\s+${REF})?\\s+(enable|disable)\\s+(\\S+)$`);
const MODEL_RE = new RegExp(`^\\/model(?:\\s+${REF})?(?:\\s+(\\S+))?$`);
const RENAME_RE = /^\/rename(?:\s+([\s\S]*))?$/;
const TAG_RE = /^\/tag(?:\s+([\s\S]*))?$/;

function session(type: SessionCommandType, arg: string, target: string | undefined): ChatCommand {
  return target ? { kind: "session", type, arg, target } : { kind: "session", type, arg };
}

export function parseChatCommand(text: string): ChatCommand | null {
  if (typeof text !== "string" || !text.startsWith("/")) return null;

  const launch = parseLaunchMessage(text);
  if (launch) return { kind: "launch", launch };

  const kill = text.match(KILL_RE);
  if (kill) return session(kill[1] as SessionCommandType, "", kill[2]);

  const rename = text.match(RENAME_RE);
  if (rename) return { kind: "rename", title: rename[1]?.trim() || undefined };

  const mcpList = text.match(MCP_LIST_RE);
  if (mcpList) return session("mcp_list", "", mcpList[1]);

  const mcpToggle = text.match(MCP_TOGGLE_RE);
  if (mcpToggle) {
    return session(mcpToggle[2] === "enable" ? "mcp_enable" : "mcp_disable", mcpToggle[3]!, mcpToggle[1]);
  }

  const model = text.match(MODEL_RE);
  if (model) {
    const firstArg = model[2];
    // Unchanged rule: only an argument containing "/" sets a model; anything else lists.
    return firstArg && firstArg.includes("/")
      ? session("model_set", firstArg, model[1])
      : session("model_list", "", model[1]);
  }

  const tag = text.match(TAG_RE);
  if (tag) return { kind: "tag", args: parseTagArgs(tag[1]) };

  // /model always parses (any single argument without "/" lists), so it never reaches here.
  const named = text.match(SESSION_COMMAND_NAME_RE);
  if (named) return { kind: "usage", command: named[1]! };

  return null;
}

/** The ack posted once a session command is queued. One wording for every transport. */
export function sessionCommandAck(
  cmd: { type: SessionCommandType; arg: string },
  sessionId: string,
  machineId: string,
): string {
  const on = `session \`${sessionId}\` on ${machineId}...`;
  switch (cmd.type) {
    case "kill":
      return `Killing ${on}`;
    case "interrupt":
      return `Interrupting ${on}`;
    case "compact":
      return `Compacting ${on}`;
    case "mcp_list":
      return `Listing MCP servers for ${on}`;
    case "mcp_enable":
      return `Enabling MCP server \`${cmd.arg}\` for ${on}`;
    case "mcp_disable":
      return `Disabling MCP server \`${cmd.arg}\` for ${on}`;
    case "model_set":
      return `Setting model to \`${cmd.arg}\` for ${on}`;
    case "model_list":
      return `Listing models for ${on}`;
  }
}
