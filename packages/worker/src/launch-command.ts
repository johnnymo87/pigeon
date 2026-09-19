/**
 * Parsing for the /launch command, including the optional `--tag` and
 * `--backend`.
 *
 * `/launch <machine> <dir> [--tag <tag>] [--backend <backend>] <prompt>`
 *
 * The prompt is free text and greedy, which is what makes optional arguments
 * here delicate rather than trivial: any sigil a flag uses is a sigil a real
 * prompt might legitimately start with, and eating it would silently shorten the
 * prompt. Four consequences shape this parser:
 *
 *  - Flags are recognised ONLY while they are the LEADING tokens of the prompt
 *    tail, consumed one at a time until a non-flag token is reached. A `--tag`
 *    after the prompt has begun is ordinary prose (`add --tag to the CLI`).
 *  - A `#tag` sigil was rejected outright: `#4231 is failing, fix it` is an
 *    ordinary prompt here and `4231` is a valid tag, so it would be eaten
 *    silently. `#` therefore means nothing to this parser.
 *  - Any leading tail token that STARTS with a dash-like character but is not
 *    exactly a known flag is answered with usage, never treated as prompt. That
 *    covers `-t`, `--tag=fbm`, `--Tag`, `-b`, `--Backend`, and the em dash iOS
 *    smart punctuation makes of `--`. A real prompt does not begin with a dash;
 *    a typo'd flag does.
 *  - That rule now applies AFTER a flag too, which is a deliberate change: a
 *    prompt beginning with a dash was previously accepted in `--tag x -1 is
 *    returned` and is now usage. It matches what the no-flag form has always
 *    done, and the alternative -- a second flag position where dashes mean
 *    prose -- is the inconsistency that makes silent eating possible.
 *
 * A malformed /launch returns { kind: "usage" } rather than null. Returning null
 * would let webhook.ts fall through to the plain-message path, where the typo
 * becomes a PROMPT injected into whatever session the message resolves to.
 */

import { isValidTag, looksLikeSessionId } from "./tag-command";

export type LaunchCommand =
  | { kind: "launch"; machineId: string; directory: string; tag?: string; backend?: string; prompt: string }
  /**
   * `reason` names the specific thing that was wrong, when there is one worth
   * naming. Usage alone reads as "you mistyped it", which is misleading for a
   * combination that is spelled correctly and simply not allowed -- the human
   * retries it verbatim.
   */
  | { kind: "usage"; reason?: string };

export const LAUNCH_USAGE_TEXT = [
  "Usage:",
  "/launch <machine> <dir> <prompt>",
  "/launch <machine> <dir> [--tag <tag>] [--backend <backend>] <prompt>",
  "",
  "<dir> may be a bare project name (pigeon), a ~ path, or an absolute path.",
  "--tag records what the session is FOR, for oc-tags cost attribution;",
  "it is one word of letters, digits, . _ - : / that may not start with",
  '"auto:", and it is opencode-only.',
  "--backend picks the agent: opencode (default) or goose.",
  "Flags come after <dir> and before the prompt, in any order.",
  "The prompt itself may not start with a dash.",
].join("\n");

const TAG_FLAG = "--tag";
const BACKEND_FLAG = "--backend";

/**
 * The closed set of backends, refused HERE rather than at the daemon.
 *
 * The worker knows every backend that exists, so a typo costs a usage message
 * instead of a queued command that a poll refuses minutes later. This is not
 * the same check as the capability gate in poll.ts: that one asks whether a
 * PARTICULAR machine can serve a real backend, which this cannot know.
 */
const KNOWN_BACKENDS = new Set(["opencode", "goose"]);

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

  // Flags are consumed from the FRONT of the tail, one at a time, and the loop
  // stops at the first token that is not dash-led -- that token begins the
  // prompt. Every iteration consumes exactly a flag and its value, so a prompt
  // can never be partially eaten: either a leading token is a known flag with a
  // value, or parsing stops (or fails loudly).
  let rest = tail;
  let tag: string | undefined;
  let backend: string | undefined;

  for (;;) {
    const token = rest.match(/^\S+/)?.[0];
    if (token === undefined) return { kind: "usage" };
    // Not a flag: the prompt starts here, and `rest` is all of it.
    if (!DASH_LED_RE.test(token)) break;

    // Dash-led but not exactly a known flag. Answered with usage rather than
    // treated as prompt, which covers `-t`, `--tag=fbm`, `--Backend`, and the
    // em dash iOS smart punctuation makes of `--`. A real prompt does not begin
    // with a dash; a typo'd flag does.
    if (token !== TAG_FLAG && token !== BACKEND_FLAG) return { kind: "usage" };

    const after = rest.slice(token.length).match(/^\s+(\S+)(\s+[\s\S]+)?$/);
    // A flag with no value, or with a value but no prompt after it.
    if (!after || after[2] === undefined) return { kind: "usage" };
    const value = after[1]!;

    if (token === TAG_FLAG) {
      // Repeats are refused rather than last-wins: both spellings were typed on
      // purpose, so there is no way to tell which one was meant.
      if (tag !== undefined) return { kind: "usage", reason: `${TAG_FLAG} was given twice.` };
      // looksLikeSessionId mirrors /tag: a session id in the tag position is a
      // half-typed command, not a tag named "ses_...".
      if (!isValidTag(value) || looksLikeSessionId(value)) return { kind: "usage" };
      tag = value;
    } else {
      if (backend !== undefined) return { kind: "usage", reason: `${BACKEND_FLAG} was given twice.` };
      const normalised = value.toLowerCase();
      if (!KNOWN_BACKENDS.has(normalised)) {
        return { kind: "usage", reason: `Unknown backend "${value}".` };
      }
      backend = normalised;
    }

    rest = after[2].replace(/^\s+/, "");
  }

  const prompt = rest;
  if (prompt.trim() === "") return { kind: "usage" };

  // `--tag` drives oc-tags, which attributes opencode spend. Accepting it for a
  // goose launch and then ignoring it would report a tag that exists nowhere;
  // refusing it here is the only place that can say so before anything runs.
  if (tag !== undefined && backend === "goose") {
    return {
      kind: "usage",
      reason: `${TAG_FLAG} is opencode-only (it drives oc-tags), so it cannot be combined with ${BACKEND_FLAG} goose.`,
    };
  }

  return {
    kind: "launch",
    machineId,
    directory,
    ...(tag !== undefined ? { tag } : {}),
    // Omitted rather than defaulted, so a launch that did not ask for a backend
    // serialises exactly as it did before this flag existed.
    ...(backend !== undefined ? { backend } : {}),
    prompt,
  };
}
