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
 * ENOENT/ENOTDIR are the only codes treated as "missing", and this set is
 * DELIBERATELY UNDER-INCLUSIVE rather than an attempt at completeness. They are
 * the two codes the measured failure (a deleted working directory / a file in a
 * parent position) actually produces. Everything else returns false and the
 * delivery proceeds.
 *
 * That under-inclusiveness is a choice, so do not "complete" it casually.
 * ELOOP and ENAMETOOLONG are arguably as deterministic as ENOENT and could
 * justifiably be added; EACCES, EIO and an NFS blip must NOT be, because they
 * are not evidence of absence. The cost of omitting a code is only the status
 * quo (we send, and the turn fails as it does today); the cost of wrongly
 * ADDING one is blocking a message that would have delivered. When in doubt,
 * leave it out. An unknown must never be laundered into a missing.
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
