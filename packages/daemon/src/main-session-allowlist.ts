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
 * procfs filesystem (/proc/<pid>/{exe,cmdline}). On non-Linux platforms
 * (e.g., macOS), the readers cleanly error-swallow, returning empty/null results,
 * and the AllowlistDeps interface can be swapped later with a macOS impl (using ps/lsof).
 */
export function makeLiveDeps(): AllowlistDeps {
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
  };
}

// Anchor matches to argv[0] to prevent false positives like "tail -f /tmp/opencode"
const SID_RE = /(?:^|\s)--session\s+(ses_[A-Za-z0-9_-]+)(?:\s|$)/;
const ATTACH_RE = /^(?:\S*\/)?\.?opencode(?:-wrapped)?\s+attach(?:\s|$)/;

export async function collectMainSubtreeOpencodePids(deps: AllowlistDeps): Promise<number[]> {
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

  const opencodePids: number[] = [];
  for (const pid of subtree) {
    const cmd = await deps.readCmdline(pid);
    if (cmd) {
      const firstWord = cmd.trim().split(/\s+/)[0] ?? "";
      const base = path.basename(firstWord);
      if (/^\.?opencode(-wrapped)?$/.test(base)) {
        opencodePids.push(pid);
      }
    }
  }
  return opencodePids;
}

export async function enumerateMainSessionSids(deps: AllowlistDeps): Promise<string[]> {
  const opencodePids = await collectMainSubtreeOpencodePids(deps);
  const sids = new Set<string>();
  for (const pid of opencodePids) {
    const cmd = await deps.readCmdline(pid);
    if (!cmd) continue;
    if (ATTACH_RE.test(cmd)) {
      const m = cmd.match(SID_RE);
      if (m) {
        sids.add(m[1]!);
        continue;
      }
    }
  }
  return [...sids];
}

export interface RegistrySession {
  sessionId: string;
  pid: number | null;
  lastSeen: number;
}

export async function resolveMainSessionSids(
  deps: AllowlistDeps,
  listActiveSessions: () => RegistrySession[],
): Promise<{ sids: string[]; homeScreenCount: number }> {
  const activeSessions = listActiveSessions();
  const byPidNewest = new Map<number, RegistrySession>();
  for (const session of activeSessions) {
    if (session.pid === null) continue;
    const existing = byPidNewest.get(session.pid);
    if (!existing || session.lastSeen > existing.lastSeen) {
      byPidNewest.set(session.pid, session);
    }
  }

  const opencodePids = await collectMainSubtreeOpencodePids(deps);
  const sidsSet = new Set<string>();
  let homeScreenCount = 0;

  for (const pid of opencodePids) {
    let resolvedSid: string | undefined;

    const registrySession = byPidNewest.get(pid);
    if (registrySession) {
      resolvedSid = registrySession.sessionId;
    } else {
      const cmd = await deps.readCmdline(pid);
      if (cmd && ATTACH_RE.test(cmd)) {
        const match = cmd.match(SID_RE);
        if (match) {
          resolvedSid = match[1];
        }
      }
    }

    if (resolvedSid) {
      sidsSet.add(resolvedSid);
    } else {
      homeScreenCount++;
    }
  }

  return { sids: Array.from(sidsSet), homeScreenCount };
}
