import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readlink } from "node:fs/promises";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

const TMUX_BIN = process.env.TMUX_BIN ?? "tmux";
const PGREP_BIN = process.env.PGREP_BIN ?? "pgrep";

export interface AllowlistDeps {
  listMainPanePids: () => Promise<number[]>;
  childrenOf: (pid: number) => Promise<number[]>;
  readCmdline: (pid: number) => Promise<string>;
  readCwd: (pid: number) => Promise<string | null>;
  resolveSidByDir: (dir: string) => Promise<string | null>;
}

export function parsePids(stdout: string): number[] {
  return stdout
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => parseInt(line, 10))
    .filter(pid => !isNaN(pid));
}

/**
 * Builds the real/live dependencies for session allowlist resolution.
 * Note: This implementation is Linux-only because it relies on Linux's
 * procfs filesystem (/proc/<pid>/{exe,cmdline,cwd}). On non-Linux platforms
 * (e.g., macOS), the readers cleanly error-swallow, returning empty/null results,
 * and the AllowlistDeps interface can be swapped later with a macOS impl (using ps/lsof).
 */
export function makeLiveDeps(opencodeClient: {
  listSessionsByDirectory: (dir: string) => Promise<Array<{ id: string }>>;
}): AllowlistDeps {
  return {
    listMainPanePids: async () => {
      try {
        const { stdout } = await execFileAsync(TMUX_BIN, ["list-panes", "-s", "-t", "=main", "-F", "#{pane_pid}"]);
        return parsePids(stdout);
      } catch {
        return [];
      }
    },
    childrenOf: async (pid: number) => {
      try {
        const { stdout } = await execFileAsync(PGREP_BIN, ["-P", String(pid)]);
        return parsePids(stdout);
      } catch {
        return [];
      }
    },
    readCmdline: async (pid: number) => {
      try {
        const exeTarget = await readlink(`/proc/${pid}/exe`);
        const base = path.basename(exeTarget);
        if (!/^\.?opencode(-wrapped)?$/.test(base)) {
          return "";
        }

        const content = await readFile(`/proc/${pid}/cmdline`, "utf8");
        return content.replace(/\0/g, " ").trim();
      } catch {
        return "";
      }
    },
    readCwd: async (pid: number) => {
      try {
        return await readlink(`/proc/${pid}/cwd`);
      } catch {
        return null;
      }
    },
    resolveSidByDir: async (dir: string) => {
      try {
        const rows = await opencodeClient.listSessionsByDirectory(dir);
        return rows[0]?.id ?? null;
      } catch {
        return null;
      }
    },
  };
}

// Anchor matches to argv[0] to prevent false positives like "tail -f /tmp/opencode"
const SID_RE = /(?:^|\s)--session\s+(ses_[A-Za-z0-9_-]+)(?:\s|$)/;
const ATTACH_RE = /^(?:\S*\/)?\.?opencode(?:-wrapped)?\s+attach(?:\s|$)/;

export async function enumerateMainSessionSids(deps: AllowlistDeps): Promise<string[]> {
  const seen = new Set<number>();
  const stack = await deps.listMainPanePids();
  const subtree: number[] = [];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;   // cycle/dup safety
    seen.add(pid);
    subtree.push(pid);
    const children = await deps.childrenOf(pid);
    stack.push(...children);
  }
  const sids = new Set<string>();
  for (const pid of subtree) {
    const cmd = await deps.readCmdline(pid);
    if (!cmd) continue;
    if (ATTACH_RE.test(cmd)) {
      const m = cmd.match(SID_RE);
      if (m) {
        sids.add(m[1]!);
        continue;
      }
    }
    // bare-cwd branch: a `…/opencode` TUI with no subcommand/--session
    if (/^(?:\S*\/)?\.?opencode(?:-wrapped)?(?:\s|$)/.test(cmd) && !/^(?:\S*\/)?\.?opencode(?:-wrapped)?\s+\S/.test(cmd)) {
      const cwd = await deps.readCwd(pid);
      if (cwd) {
        const sid = await deps.resolveSidByDir(cwd);
        if (sid && /^ses_[A-Za-z0-9_-]+$/.test(sid)) {
          sids.add(sid);
        }
      }
    }
  }
  return [...sids];
}
