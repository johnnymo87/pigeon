/**
 * Parsing and validation for the /tag command.
 *
 * /tag shells out — on the daemon side — to the `oc-tags` binary, which owns tag
 * precedence (explicit session tag > directory glob > "auto:" fallback). Nothing
 * here reimplements any of that; this module only decides which oc-tags
 * invocation a chat message is asking for, and refuses input that has no business
 * being handed to a subprocess.
 *
 * The validators are deliberately duplicated in the daemon
 * (packages/daemon/src/worker/tag-ingest.ts), and NOT for the version-skew reason
 * that duplication usually carries here: an old worker cannot emit tag_* at all,
 * so the worker is always at least as new as the daemon for these types.
 *
 * The real reason is that the daemon reads a D1 row, not this function's return
 * value. Anything holding the API key can write that row, and poll.ts turns
 * corrupt metadata_json into {} — so a tag or pattern can arrive at the process
 * spawner as undefined however careful this side was. The side that spawns
 * validates its own input. What this copy buys is a good error message before the
 * command is ever queued.
 */

export type TagCommand =
  | { kind: "top" }
  | { kind: "list" }
  | { kind: "set"; targetSessionId?: string; tag: string }
  | { kind: "setDir"; pattern: string; tag: string }
  | { kind: "usage" };

export const TAG_USAGE_TEXT = [
  "Usage:",
  "/tag — untagged sessions ranked by dollars",
  "/tag list — tags defined so far",
  "/tag <tag> — tag this session",
  "/tag <session-id> <tag> — tag a specific session",
  "/tag dir <glob> <tag> — tag a directory pattern, absolute path (retroactive and prospective)",
].join("\n");

/**
 * A tag must survive being passed as a bare argv element to oc-tags. spawn is
 * called without a shell, so shell metacharacters are inert; the real hazards are
 * argument injection (a leading "-" that argparse reads as a flag) and the
 * "auto:" prefix, which oc-tags reserves for its directory-derived fallback and
 * rejects at write time anyway.
 */
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

export function isValidTag(tag: string): boolean {
  // The typeof guard is not defensive noise: TAG_RE.test(undefined) coerces to
  // the STRING "undefined" and passes, which would tag a session "undefined".
  if (typeof tag !== "string" || !TAG_RE.test(tag)) {
    return false;
  }
  return !tag.toLowerCase().startsWith("auto:");
}

/**
 * A directory pattern must be ABSOLUTE, which also rules out anything argparse
 * would read as a flag.
 *
 * "~" is rejected rather than expanded. oc-tags stores the pattern verbatim and
 * fnmatches it against an absolute directory without ever calling expanduser, so
 * a "~"-rooted pattern would be accepted, acknowledged, written to tags.db and
 * then match nothing — a silent no-op. Expanding it here instead would put a
 * second opinion about what "~" means into a system that is supposed to have
 * exactly one.
 */
export function isValidDirPattern(pattern: string): boolean {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 256) {
    return false;
  }
  if (pattern[0] !== "/") {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(pattern);
}

// Matches the shape pigeon uses elsewhere (daemon app.ts); opencode ids may
// carry "-" and "_". A leading "ses_" means this can never look like a flag.
const SESSION_ID_RE = /^ses_[A-Za-z0-9_-]+$/;

export function looksLikeSessionId(token: string): boolean {
  return typeof token === "string" && SESSION_ID_RE.test(token);
}

/**
 * Parses the argument tail of a /tag message.
 *
 * Returns { kind: "usage" } for anything malformed. The caller must respond with
 * TAG_USAGE_TEXT rather than falling through to the plain-message path — a
 * mistyped /tag becoming a prompt injected into a live session would be worse
 * than any parse error.
 */
export function parseTagArgs(rest: string | undefined): TagCommand {
  const trimmed = (rest ?? "").trim();
  if (trimmed === "") {
    return { kind: "top" };
  }

  const tokens = trimmed.split(/\s+/);

  if (tokens[0] === "list") {
    return tokens.length === 1 ? { kind: "list" } : { kind: "usage" };
  }

  // "top" is the oc-tags CLI's own name for this view, so someone who knows that
  // tool will type it. Without the alias it would quietly tag the session "top".
  if (tokens[0] === "top") {
    return tokens.length === 1 ? { kind: "top" } : { kind: "usage" };
  }

  if (tokens[0] === "dir") {
    if (tokens.length !== 3) {
      return { kind: "usage" };
    }
    const pattern = tokens[1]!;
    const tag = tokens[2]!;
    if (!isValidDirPattern(pattern) || !isValidTag(tag)) {
      return { kind: "usage" };
    }
    return { kind: "setDir", pattern, tag };
  }

  if (tokens.length === 1) {
    const tag = tokens[0]!;
    // A lone session id is a half-typed command, not a tag named "ses_...".
    if (looksLikeSessionId(tag) || !isValidTag(tag)) {
      return { kind: "usage" };
    }
    return { kind: "set", tag };
  }

  if (tokens.length === 2) {
    const targetSessionId = tokens[0]!;
    const tag = tokens[1]!;
    if (!looksLikeSessionId(targetSessionId) || !isValidTag(tag)) {
      return { kind: "usage" };
    }
    return { kind: "set", targetSessionId, tag };
  }

  return { kind: "usage" };
}
