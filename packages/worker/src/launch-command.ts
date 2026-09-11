/**
 * Parsing for the /launch command, including the optional `--tag`.
 *
 * `/launch <machine> <dir> [--tag <tag>] <prompt>`
 *
 * The prompt is free text and greedy, which is what makes an optional argument
 * here delicate rather than trivial: any sigil the flag uses is a sigil a real
 * prompt might legitimately start with, and eating it would silently shorten the
 * prompt. Three consequences shape this parser:
 *
 *  - `--tag` is recognised ONLY as the first token of the prompt tail. A `--tag`
 *    anywhere later is ordinary prose (`add --tag to the CLI`).
 *  - A `#tag` sigil was rejected outright: `#4231 is failing, fix it` is an
 *    ordinary prompt here and `4231` is a valid tag, so it would be eaten
 *    silently. `#` therefore means nothing to this parser.
 *  - Any first tail token that STARTS with a dash-like character but is not
 *    exactly `--tag` is answered with usage, never treated as prompt. That covers
 *    `-t`, `--tag=fbm`, `--Tag`, and the em dash iOS smart punctuation makes of
 *    `--`. A real prompt does not begin with a dash; a typo'd flag does.
 *
 * A malformed /launch returns { kind: "usage" } rather than null. Returning null
 * would let webhook.ts fall through to the plain-message path, where the typo
 * becomes a PROMPT injected into whatever session the message resolves to.
 */

import { isValidTag, looksLikeSessionId } from "./tag-command";

export type LaunchCommand =
  | { kind: "launch"; machineId: string; directory: string; tag?: string; prompt: string }
  | { kind: "usage" };

export const LAUNCH_USAGE_TEXT = [
  "Usage:",
  "/launch <machine> <dir> <prompt>",
  "/launch <machine> <dir> --tag <tag> <prompt>",
  "",
  "<dir> may be a bare project name (pigeon), a ~ path, or an absolute path.",
  "--tag records what the session is FOR, for oc-tags cost attribution;",
  "it must come immediately after <dir>, and is one word of letters, digits,",
  '. _ - : / that may not start with "auto:".',
  "The prompt itself may not start with a dash.",
].join("\n");

const TAG_FLAG = "--tag";

/**
 * Every Unicode dash punctuation (\p{Pd} — which covers hyphen-minus, the en and
 * em dashes iOS smart punctuation makes of `--`, and the fullwidth and small
 * forms), plus the minus sign and the soft hyphen, which are not in that
 * category. Enumerating a few by hand let U+FF0D and friends through as PROMPT,
 * which is the silent-eat this guard exists to prevent.
 *
 * It also matches CJK wave dashes, and it means a prompt that genuinely starts
 * with a dash (a markdown list, "-1 is returned by foo") is answered with usage.
 * That is loud and the usage text says so, which is the right side to err on.
 */
const DASH_LED_RE = /^[\p{Pd}\u2212\u00ad]/u;

export function parseLaunchMessage(text: string): LaunchCommand | null {
  if (typeof text !== "string") return null;

  // (?=$|\s) so /launchpad is not a /launch.
  const head = text.match(/^\/launch(?=$|\s)([\s\S]*)$/);
  if (!head) return null;

  const parts = (head[1] ?? "").match(/^\s+(\S+)\s+(\S+)\s+([\s\S]+)$/);
  if (!parts) return { kind: "usage" };

  const machineId = parts[1]!;
  const directory = parts[2]!;
  // The workstation CLI takes its flags first, so `/launch --tag fbm devbox ...`
  // is the likely mistake. Unguarded it reads as a machine named "--tag" ("--tag
  // is not recently seen") or a directory that expands to ~/projects/--tag.
  if (DASH_LED_RE.test(machineId) || DASH_LED_RE.test(directory)) {
    return { kind: "usage" };
  }

  // `\s+` above is greedy, so the tail carries no leading whitespace; a tail of
  // nothing but whitespace is a prompt that was never typed.
  const tail = parts[3]!;
  if (tail.trim() === "") return { kind: "usage" };

  const firstToken = tail.match(/^\S+/)![0];
  if (!DASH_LED_RE.test(firstToken)) {
    return { kind: "launch", machineId, directory, prompt: tail };
  }
  if (firstToken !== TAG_FLAG) {
    return { kind: "usage" };
  }

  const tagged = tail.slice(TAG_FLAG.length).match(/^\s+(\S+)\s+([\s\S]+)$/);
  if (!tagged) return { kind: "usage" };

  const tag = tagged[1]!;
  const prompt = tagged[2]!;
  // looksLikeSessionId mirrors /tag: a session id in the tag position is a
  // half-typed command, not a tag named "ses_...".
  if (!isValidTag(tag) || looksLikeSessionId(tag)) return { kind: "usage" };
  if (prompt.trim() === "") return { kind: "usage" };

  return { kind: "launch", machineId, directory, tag, prompt };
}
