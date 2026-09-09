import os from "node:os";
import { TgMessageBuilder, type TgEntity } from "../telegram-message";
import type { OcTagsRunner } from "./oc-tags";

/**
 * /tag — session tagging from Telegram, backed by the oc-tags binary.
 *
 * oc-tags is the single source of truth for tag precedence (explicit session tag
 * > directory glob > directory-derived "auto:" fallback) and for the sidecar DB
 * at ~/.local/share/oc-tags/tags.db. This module never reads either database; it
 * only shells out and renders the result for a phone screen.
 *
 * Two things follow from the model and shape the UX here:
 *
 *  - Every session ALWAYS has a tag, so /tag never creates one from nothing — it
 *    converts a session from its "auto:" fallback to a manual tag. That is why
 *    the bare /tag form is a BACKLOG view rather than a prompt for a tag name.
 *  - A directory glob covers past and future sessions at once, so oc-tags' own
 *    prefix hints are the highest-leverage thing on the screen and are rendered
 *    even though they were not asked for.
 */

// ─── input validation ─────────────────────────────────────────────────────────
//
// Deliberately duplicated from packages/worker/src/tag-command.ts -- not for
// version skew (an old worker cannot emit tag_* at all), but because this side
// reads a D1 row rather than that function's return value. Anything holding the
// API key can write that row, and poll.ts turns corrupt metadata_json into {},
// so a field can arrive here undefined however careful the worker was. The side
// that spawns a process validates its own input.

const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
// Matches the shape used elsewhere in the daemon (app.ts); ids may carry - and _.
const SESSION_ID_RE = /^ses_[A-Za-z0-9_-]+$/;

// The typeof guards are load-bearing, not defensive noise. TypeScript types the
// poller message fields as strings, but they come off the wire from metadata_json
// and can be absent -- and TAG_RE.test(undefined) coerces to the STRING
// "undefined" and PASSES, which would tag a session "undefined". A throw here
// would be worse still: it skips the poller ack, so the command is redelivered
// every lease expiry for 24h.

export function isValidTag(tag: string): boolean {
  return typeof tag === "string" && TAG_RE.test(tag) && !tag.toLowerCase().startsWith("auto:");
}

/**
 * Patterns must be ABSOLUTE. "~" is rejected rather than expanded: oc-tags stores
 * the pattern verbatim and fnmatches it against an absolute directory without
 * calling expanduser, so a "~"-rooted pattern would be written to tags.db and
 * then silently match nothing.
 */
export function isValidDirPattern(pattern: string): boolean {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 256) return false;
  if (pattern[0] !== "/") return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(pattern);
}

export function isValidSessionId(sessionId: string): boolean {
  return typeof sessionId === "string" && SESSION_ID_RE.test(sessionId);
}

// ─── deps ─────────────────────────────────────────────────────────────────────

export interface TagCommandDeps {
  commandId: string;
  chatId: string;
  machineId?: string;
  /** Defaults to os.homedir(); injected so directory shortening is testable. */
  homeDir?: string;
  /** null means oc-tags is not installed on this machine. */
  runOcTags: OcTagsRunner | null;
  sendTelegramReply: (chatId: string, text: string, entities?: TgEntity[]) => Promise<void>;
}

export interface TagSetCommandDeps extends TagCommandDeps {
  targetSessionId: string;
  tag: string;
}

export interface TagSetDirCommandDeps extends TagCommandDeps {
  pattern: string;
  tag: string;
}

// ─── parsing oc-tags top ──────────────────────────────────────────────────────

export interface TopRow {
  dollars: number;
  sessionId: string;
  title: string;
  directory: string;
}

export interface TopHint {
  count: number;
  pattern: string;
}

/** Separator between fields in oc-tags' printf: {dollars:>10}  {id:<32}  {title:<40}  {dir} */
const FIELD_GAP = 2;

const ROW_PREFIX_RE = /^\s*\$([\d,]+\.\d{2})\s+(\S+)/;
const HINT_RE = /^Hint: (\d+) untagged roots share directory prefix '(.+)'\./;

/**
 * Reads the field widths off oc-tags' own header line.
 *
 * Taking the widths from the header rather than hardcoding 32/40 is what makes a
 * width change upstream LOUD. Hardcoded widths keep matching the row prefix, so
 * the session ids stay right while every title and directory silently shifts —
 * plausible output pointing at the wrong work. No header, no rows.
 */
function parseHeaderWidths(line: string): { idWidth: number; titleWidth: number } | null {
  const idStart = line.indexOf("session_id");
  const titleStart = line.indexOf("title");
  const dirStart = line.indexOf("directory");
  if (idStart < 0 || titleStart <= idStart || dirStart <= titleStart) return null;
  return {
    idWidth: titleStart - idStart - FIELD_GAP,
    titleWidth: dirStart - titleStart - FIELD_GAP,
  };
}

/**
 * Parses the fixed-width table `oc-tags top` prints.
 *
 * Two things here are load-bearing:
 *
 *  - **Columns are sliced by CODE POINT, not UTF-16 code unit.** Python pads with
 *    `{s:<40}`, which counts code points, so a title containing an astral
 *    character (an emoji) would otherwise be cut mid-surrogate — and a lone
 *    surrogate makes the JSON body invalid UTF-8, so Telegram rejects the whole
 *    backlog message with a 400 rather than mangling one line. Every column
 *    after it shifts too.
 *  - **Offsets are anchored on each row's own session id**, not on the header's
 *    absolute positions, because the dollars field overflows its width past
 *    $10,000,000 and the id field is a MINIMUM width, not a truncation.
 *
 * An unrecognised line is skipped and a missing header yields no rows at all, so
 * a format change upstream degrades to the raw-output fallback, never to
 * invented or misaligned rows.
 */
export function parseTopOutput(stdout: string): { rows: TopRow[]; hints: TopHint[] } {
  const rows: TopRow[] = [];
  const hints: TopHint[] = [];
  let widths: { idWidth: number; titleWidth: number } | null = null;

  for (const line of stdout.split("\n")) {
    const hint = line.match(HINT_RE);
    if (hint) {
      hints.push({ count: Number(hint[1]), pattern: hint[2]! });
      continue;
    }

    if (!widths) {
      widths = parseHeaderWidths(line);
      continue;
    }

    const m = line.match(ROW_PREFIX_RE);
    if (!m) continue;

    const dollars = Number(m[1]!.replace(/,/g, ""));
    if (!Number.isFinite(dollars)) continue;

    const sessionId = m[2]!;
    // The prefix (spaces, "$", digits, the id) is ASCII, so its UTF-16 length is
    // also its code-point length; everything past it must be counted in code points.
    const chars = Array.from(line);
    const idStart = m[0].length - sessionId.length;
    const titleStart = idStart + Math.max(widths.idWidth, sessionId.length) + FIELD_GAP;
    const dirStart = titleStart + widths.titleWidth + FIELD_GAP;

    rows.push({
      dollars,
      sessionId,
      title: chars.slice(titleStart, titleStart + widths.titleWidth).join("").trim(),
      directory: chars.slice(dirStart).join("").trim(),
    });
  }

  return { rows, hints };
}

// ─── rendering ────────────────────────────────────────────────────────────────

const MAX_ROWS = 8;
const MAX_HINTS = 3;
/** Telegram's hard limit is 4096; this path does not split messages. */
const MAX_TEXT = 3800;

/** Home and the projects root are noise on a phone screen. */
function shortenDirectory(directory: string, homeDir: string): string {
  const home = homeDir.replace(/\/+$/, "");
  if (home && directory.startsWith(`${home}/projects/`)) {
    return directory.slice(`${home}/projects/`.length);
  }
  if (home && directory === `${home}/projects`) {
    return "projects";
  }
  if (home && directory.startsWith(`${home}/`)) {
    return `~/${directory.slice(home.length + 1)}`;
  }
  return directory;
}

function formatDollars(dollars: number): string {
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Truncates without ever leaving an unpaired surrogate.
 *
 * A lone surrogate makes the JSON request body invalid UTF-8 and Telegram
 * rejects the WHOLE message with a 400 — so one emoji in a session title would
 * drop the entire backlog rather than mangle one line.
 */
function truncate(s: string, max: number): string {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  let end = max - 1;
  const lastCode = s.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return `${s.slice(0, end)}…`;
}

// ─── shared plumbing ──────────────────────────────────────────────────────────

function notInstalledMessage(machineId: string | undefined) {
  const where = machineId ? ` on ${machineId}` : "";
  return new TgMessageBuilder()
    .append(`oc-tags is not installed${where}.\n\nInstall it from workstation (`)
    .appendCode("pkgs/oc-tags")
    .append(") or point the daemon at it with ")
    .appendCode("PIGEON_OC_TAGS_BIN")
    .append(".")
    .build();
}

/**
 * Runs oc-tags and hands the caller the stdout, or replies and returns null.
 *
 * Every failure mode — not installed, spawn failure, non-zero exit — becomes a
 * Telegram message rather than a throw, so the command is always acked. A throw
 * would skip the ack and redeliver the same command every lease expiry for 24h,
 * which for a user-visible command means the same error posted repeatedly.
 */
async function runOrExplain(deps: TagCommandDeps, args: string[], what: string): Promise<string | null> {
  if (!deps.runOcTags) {
    const msg = notInstalledMessage(deps.machineId);
    await deps.sendTelegramReply(deps.chatId, msg.text, msg.entities);
    return null;
  }

  let result;
  try {
    result = await deps.runOcTags(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tag-ingest] oc-tags ${what} failed to run commandId=${deps.commandId}: ${message}`);
    await deps.sendTelegramReply(deps.chatId, `Failed to run oc-tags: ${message}`);
    return null;
  }

  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).slice(0, 500);
    await deps.sendTelegramReply(deps.chatId, `oc-tags ${what} failed: ${detail}`);
    return null;
  }

  return result.stdout;
}

// ─── /tag (backlog) ───────────────────────────────────────────────────────────

const TOP_DAYS = "14";

export async function ingestTagTopCommand(deps: TagCommandDeps): Promise<void> {
  const stdout = await runOrExplain(deps, ["top", "--days", TOP_DAYS], "top");
  if (stdout === null) return;

  const homeDir = deps.homeDir ?? os.homedir();
  const { rows, hints } = parseTopOutput(stdout);

  if (rows.length === 0) {
    // Includes oc-tags' own "No untagged root sessions found." and any output
    // shape this parser does not recognise. Showing it raw beats showing nothing.
    const raw = stdout.trim() || "No untagged root sessions found.";
    // pre, so an unrecognised fixed-width table still lines up on a phone.
    const msg = new TgMessageBuilder().appendPre(truncate(raw, MAX_TEXT)).build();
    await deps.sendTelegramReply(deps.chatId, msg.text, msg.entities);
    return;
  }

  const total = rows.reduce((sum, r) => sum + r.dollars, 0);
  const shown = rows.slice(0, MAX_ROWS);

  const b = new TgMessageBuilder()
    .append("💰 ")
    .appendBold(`Untagged — last ${TOP_DAYS} days`)
    .newline()
    .append(`${rows.length} sessions, ${formatDollars(total)}. Top ${shown.length}:`)
    .newline(2);

  for (const row of shown) {
    b.append(`${formatDollars(row.dollars)} · ${truncate(row.title || "(untitled)", 44)}`).newline();
    b.append(truncate(shortenDirectory(row.directory, homeDir), 60)).newline();
    // Tap the code span to copy the whole command, then paste and append a tag.
    b.appendCode(`/tag ${row.sessionId}`).newline(2);
  }

  if (hints.length > 0) {
    b.append("💡 ").appendBold("Cover many at once:").newline();
    for (const hint of hints.slice(0, MAX_HINTS)) {
      b.append(`${hint.count} roots share ${truncate(shortenDirectory(hint.pattern, homeDir), 60)}`).newline();
      b.appendCode(`/tag dir ${hint.pattern}`).newline(2);
    }
  }

  const msg = b.build();
  await deps.sendTelegramReply(deps.chatId, msg.text, msg.entities);
}

// ─── /tag list ────────────────────────────────────────────────────────────────

export async function ingestTagListCommand(deps: TagCommandDeps): Promise<void> {
  const stdout = await runOrExplain(deps, ["ls", "--counts"], "ls");
  if (stdout === null) return;

  const table = stdout.replace(/\s+$/, "");
  const msg = new TgMessageBuilder()
    .append("🏷 ")
    .appendBold("Tags")
    .newline(2)
    // Verbatim, in a pre block: oc-tags' own table is narrow enough for a phone,
    // and re-rendering it would be a second formatter to keep in step for nothing.
    .appendPre(truncate(table || "No tags defined.", MAX_TEXT))
    .build();
  await deps.sendTelegramReply(deps.chatId, msg.text, msg.entities);
}

// ─── /tag <session-id> <tag> ──────────────────────────────────────────────────

export async function ingestTagSetCommand(deps: TagSetCommandDeps): Promise<void> {
  const { tag, targetSessionId } = deps;

  if (!isValidSessionId(targetSessionId)) {
    await deps.sendTelegramReply(deps.chatId, `Invalid session id: ${truncate(targetSessionId, 64)}`);
    return;
  }
  if (!isValidTag(tag)) {
    await deps.sendTelegramReply(
      deps.chatId,
      `Invalid tag: ${truncate(tag, 64)}\nTags are one word of letters, digits, . _ - : / and may not start with "auto:".`,
    );
    return;
  }

  // Argv, not a command string: oc-tags set <tag> [session-id].
  const stdout = await runOrExplain(deps, ["set", tag, targetSessionId], "set");
  if (stdout === null) return;

  console.log(`[tag-ingest] set commandId=${deps.commandId} session=${targetSessionId} tag=${tag}`);
  await deps.sendTelegramReply(deps.chatId, `🏷 ${truncate(stdout.trim() || `Tagged ${targetSessionId} as ${tag}`, 500)}`);
}

// ─── /tag dir <glob> <tag> ────────────────────────────────────────────────────

export async function ingestTagSetDirCommand(deps: TagSetDirCommandDeps): Promise<void> {
  const { pattern, tag } = deps;

  if (!isValidDirPattern(pattern)) {
    await deps.sendTelegramReply(
      deps.chatId,
      `Invalid directory pattern: ${truncate(pattern, 128)}\nPatterns must be an absolute path starting with / (~ is not expanded).`,
    );
    return;
  }
  if (!isValidTag(tag)) {
    await deps.sendTelegramReply(
      deps.chatId,
      `Invalid tag: ${truncate(tag, 64)}\nTags are one word of letters, digits, . _ - : / and may not start with "auto:".`,
    );
    return;
  }

  const stdout = await runOrExplain(deps, ["set", "--dir", pattern, tag], "set --dir");
  if (stdout === null) return;

  console.log(`[tag-ingest] set --dir commandId=${deps.commandId} pattern=${pattern} tag=${tag}`);
  await deps.sendTelegramReply(
    deps.chatId,
    `🏷 ${truncate(stdout.trim() || `Tagged ${pattern} as ${tag}`, 500)}\n\nApplies to past and future sessions in that directory.`,
  );
}
