/**
 * Recognising text that goose would run as a command rather than read as a
 * prompt (eng-agent-platform-555.22).
 *
 * goose checks every prompt before the model sees it
 * (`crates/goose/src/agents/execute_commands.rs`, `parse_slash_command` and
 * `execute_command`): the exact phrases in COMPACT_TRIGGERS compact the session,
 * and text whose trimmed form starts with `/` is split at the first space and
 * dispatched by its first word. The built-ins include `/clear` (empties the
 * conversation), `/compact`, `/goal` and `/grind` (start a turn pursuing a
 * goal), `/prompt(s)`, `/skills`, `/doctor` and `/status`. Anything else is
 * tried as a recipe command, then as a skill command, so the set of live words
 * depends on what is installed in the session's working directory.
 *
 * The worker intercepts only `/kill`, `/interrupt`, `/compact`, `/mcp` and a few
 * others; everything else reaches the session as text. For a pinned session (a
 * stall-watch coordinator bound to its topic), one stray `/clear` typed in the
 * topic would wipe the coordinator's context. So pigeon refuses, for pinned
 * sessions, any message goose could treat as a command:
 *
 *   - a first word of `/` plus a single path segment (`/clear`, `/goal x`,
 *     `/sw`). A recipe or skill name is just as live as a built-in and cannot
 *     be listed from here, so the rule is on the shape, not a list.
 *   - goose's compact phrases, compared without case or trailing punctuation.
 *
 * A path such as `/tmp/x is full` is NOT refused: its first word has a second
 * `/`, which no goose command name has, and goose reads it as a prompt.
 */

/** goose's COMPACT_TRIGGERS, minus the slash forms the shape rule covers. */
const COMPACT_PHRASES = ["please compact this conversation"];

/** A first word that goose would dispatch as a command: `/name`, no further `/`. */
const SLASH_COMMAND_RE = /^\/([^\s/]+)(?:\s|$)/;

/**
 * Returns the command as goose would see it (`/clear`, or the compact phrase),
 * or null when the text is an ordinary prompt.
 */
export function gooseCommandIn(text: string): string | null {
  const trimmed = text.trim();
  const slash = SLASH_COMMAND_RE.exec(trimmed);
  if (slash) return `/${slash[1]}`;
  const normalized = trimmed.toLowerCase().replace(/[.!\s]+$/, "");
  if (COMPACT_PHRASES.includes(normalized)) return trimmed;
  return null;
}

/** The reply pigeon sends instead of delivering a goose command to a pinned session. */
export function pinnedCommandRefusal(command: string): string {
  return (
    `Not sent: goose would run "${command}" as a command instead of reading it, and this ` +
    "session is bound to its topic, where a stray /clear would wipe its conversation. " +
    "To send it as a message, start with something else (for example, quote it)."
  );
}
