import { statSync } from "node:fs";

/**
 * Is the session's working directory provably absent on the DAEMON's filesystem?
 *
 * Used by the arbiter as a delivery preflight (pigeon-0ay7). It answers a
 * deliberately narrow question — "can I prove this path is not a usable
 * directory right now?" — and every ambiguous answer is NO.
 *
 * WHY THIS IS `statSync().isDirectory()` AND NOT `existsSync`:
 *   - a plain FILE at the path satisfies existsSync, but a serve cannot chdir
 *     into it, so existsSync would wave through a path that cannot work;
 *   - existsSync collapses EVERY stat error into `false`. That includes EACCES
 *     and EIO, which are not evidence of absence. Under a blocking preflight
 *     that collapse means a transient or permissions fault silently blocks a
 *     deliverable message — precisely the fail-closed-on-ambiguity this
 *     roadmap exists to remove.
 *
 * ENOENT/ENOTDIR are the only codes treated as "missing". ENOTDIR is included
 * because it is what you get when a PARENT component is a file, which is the
 * same class of "this path cannot be a working directory" fact as ENOENT.
 * Anything else — EACCES, EIO, ELOOP, an NFS blip — returns false and the
 * delivery proceeds. An unknown must never be laundered into a missing.
 *
 * ASSUMPTION, and it is load-bearing: the daemon and the serve share a
 * filesystem. True on this host (both are user systemd units on the same
 * machine) but NOT structural. If serves ever become remote, this predicate
 * silently starts answering a question about the wrong machine — see the
 * wiring note at the arbiter call site for the intended escape hatch.
 */
export function directoryMissing(dir: string): boolean {
  try {
    return !statSync(dir).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}
