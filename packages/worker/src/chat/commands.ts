/**
 * Slash-command parsing shared by every chat ingress (chat-transport phase 2, bead pigeon-4ogz.1;
 * spec §5 "Slash commands"). The Slack ingress (pigeon-4ogz.4) uses it, as the
 * Telegram webhook did before it was deleted (pigeon-4ogz.13).
 *
 * Input is the command text AFTER transport-specific normalisation. Output names the command; resolving which session
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

export type QuotePick =
  | { kind: "since" }
  | { kind: "prev" }
  | { kind: "last"; n: number };

export function quotePickLabel(pick: QuotePick, full: boolean): string {
  let text: string;
  switch (pick.kind) {
    case "since":
      text = "since your last message";
      break;
    case "prev":
      text = "since your previous message";
      break;
    case "last":
      text = `last ${pick.n}`;
      break;
  }
  return full ? `${text} (full)` : text;
}

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
  | { kind: "quote"; pick: QuotePick; full: boolean; target?: string }
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
  "/quote [<session-id>] [N|prev|full]",
].join("\n");

/** Command names whose malformed forms answer with usage (`/killall` is not one of them). */
const SESSION_COMMAND_NAME_RE = /^\/(kill|interrupt|compact|mcp|quote)(?=$|\s)/;

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

function parseQuoteCommand(text: string): ChatCommand | null {
  if (!/^\/quote(?=$|\s)/.test(text)) return null;
  const tokens = text.trim().split(/\s+/);
  const args = tokens.slice(1);
  let idx = 0;
  let target: string | undefined;

  if (idx < args.length && SESSION_REF_RE.test(args[idx]!)) {
    target = args[idx];
    idx++;
  }

  let full = false;
  if (idx < args.length && (args[idx] === "full" || args[idx] === "all")) {
    full = true;
    idx++;
  }

  let pick: QuotePick = { kind: "since" };
  if (idx < args.length) {
    const token = args[idx]!;
    if (token === "prev") {
      pick = { kind: "prev" };
      idx++;
    } else if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (Number.isInteger(n) && n >= 1 && n <= 1000) {
        pick = { kind: "last", n };
        idx++;
      } else {
        return null;
      }
    } else {
      return null;
    }
  }

  if (idx < args.length) {
    return null;
  }

  return target ? { kind: "quote", pick, full, target } : { kind: "quote", pick, full };
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

  const quote = parseQuoteCommand(text);
  if (quote) return quote;

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
