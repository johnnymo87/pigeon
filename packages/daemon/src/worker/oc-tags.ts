import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Locating and invoking the `oc-tags` binary.
 *
 * oc-tags owns tag precedence (explicit session tag > directory glob > "auto:"
 * fallback) and owns the sidecar DB at ~/.local/share/oc-tags/tags.db. Pigeon
 * shells out to it rather than reading either database, so there is exactly one
 * implementation of precedence. oc-tags opens opencode.db read-only; nothing
 * here writes to it.
 */

export interface OcTagsResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type OcTagsRunner = (args: string[]) => Promise<OcTagsResult>;

const BIN_NAME = "oc-tags";

/** 20s: `oc-tags top` scans opencode.db, which is large, but never for long. */
const RUN_TIMEOUT_MS = 20_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function defaultIsExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface ResolveOcTagsBinOptions {
  /** PIGEON_OC_TAGS_BIN, if set. */
  configured?: string;
  env?: Record<string, string | undefined>;
  isExecutable?: (p: string) => boolean;
}

/**
 * Resolves the oc-tags binary, or null if it is not installed.
 *
 * The daemon runs under systemd, whose PATH is minimal and typically contains
 * none of the profile directories a nix-installed oc-tags lives in. So a bare
 * "oc-tags" cannot be assumed to resolve, and PATH alone is not enough: the
 * well-known profile locations are probed too.
 *
 * Returning null (rather than throwing, or defaulting to the bare name and
 * letting spawn fail with ENOENT) is what lets the caller turn "not installed"
 * into one legible sentence rather than a stack trace or a silent no-op.
 */
export function resolveOcTagsBin(opts: ResolveOcTagsBinOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const isExecutable = opts.isExecutable ?? defaultIsExecutable;

  const configured = opts.configured?.trim();
  if (configured) {
    // No fallback: an operator who names a path meant that path, and quietly
    // running a different binary would be worse than failing.
    return isExecutable(configured) ? configured : null;
  }

  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, BIN_NAME);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  const home = env.HOME?.trim();
  const fallbacks = [
    ...(home ? [path.join(home, ".nix-profile/bin", BIN_NAME)] : []),
    `/run/current-system/sw/bin/${BIN_NAME}`,
    `/usr/local/bin/${BIN_NAME}`,
    `/opt/homebrew/bin/${BIN_NAME}`,
  ];
  for (const candidate of fallbacks) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Turns a runner REJECTION into a line that names a reason.
 *
 * This exists because the naked `err.message` does not. execFile reports its
 * timeout kill as `{code: null, killed: true, signal: "SIGTERM"}` with the
 * message `Command failed: <argv>` — the word "timeout" appears nowhere, so a
 * hung oc-tags reads as a generic failure. The CLI version of this feature
 * shipped with exactly that hole (workstation #491) and it had to be fixed after
 * review.
 *
 * `killed` is what separates OUR timeout from something else killing oc-tags (an
 * OOM, a stray pkill): execFile sets it only when execFile itself did the
 * killing. Reporting an external kill as a timeout would send an operator
 * looking at the wrong thing.
 */
export function describeOcTagsFailure(err: unknown, timeoutMs: number = RUN_TIMEOUT_MS): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
  if (e.killed) return `oc-tags timed out after ${Math.round(timeoutMs / 1000)}s`;
  // ENOENT/EACCES messages already name the path and the errno, so they stand
  // on their own; a signal without `killed` needs saying out loud.
  if (e.signal) return `oc-tags was killed (${e.signal})`;
  return err.message;
}

/**
 * Builds a runner that executes oc-tags with an argv ARRAY and no shell.
 *
 * Tag names and directory globs arrive from a chat message. Passing argv rather
 * than composing a command string means shell metacharacters in them are inert;
 * the remaining hazard is argument injection via a leading "-", which the input
 * validators reject.
 *
 * A non-zero exit resolves rather than rejects: oc-tags reports user errors as
 * exit 1 plus a line on stderr, and those belong in the Telegram reply. Only a
 * failure to run at all (ENOENT, timeout) rejects.
 *
 * `timeoutMs` defaults to the 20s a `/tag` command needs. A caller that only
 * runs `which` should pass something far shorter: `which` never reads the
 * message table, so a slow one means a contended DB, and the notification it
 * decorates should not wait 20s for a decoration.
 */
export function createOcTagsRunner(bin: string, timeoutMs: number = RUN_TIMEOUT_MS): OcTagsRunner {
  return (args: string[]) =>
    new Promise<OcTagsResult>((resolve, reject) => {
      execFile(
        bin,
        args,
        { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, encoding: "utf8", shell: false },
        (err, stdout, stderr) => {
          if (err) {
            const exitCode = (err as { code?: unknown }).code;
            if (typeof exitCode === "number") {
              // A real exit status: oc-tags ran and disagreed with us.
              resolve({ code: exitCode, stdout: stdout ?? "", stderr: stderr ?? "" });
              return;
            }
            // Everything else — ENOENT/EACCES (code is a string), and the
            // timeout/kill case where code is NULL and only `signal` is set.
            // That last one is why this is not a `typeof code === "string"`
            // check: null is not a number either, so a timed-out oc-tags would
            // otherwise resolve as exit 0 with empty stdout, and an oc-tags
            // hung on a locked opencode.db would render as "nothing to tag".
            reject(err);
            return;
          }
          resolve({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
    });
}
