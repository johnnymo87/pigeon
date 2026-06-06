export interface AllowlistDeps {
  listMainPanePids: () => Promise<number[]>;
  childrenOf: (pid: number) => Promise<number[]>;
  readCmdline: (pid: number) => Promise<string>;
  readCwd: (pid: number) => Promise<string | null>;
  resolveSidByDir: (dir: string) => Promise<string | null>;
}

// Anchor matches to argv[0] to prevent false positives like "tail -f /tmp/opencode"
const SID_RE = /(?:^|\s)--session\s+(ses_[A-Za-z0-9_-]+)(?:\s|$)/;
const ATTACH_RE = /^(?:\S*\/)?opencode\s+attach(?:\s|$)/;

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
    if (/^(?:\S*\/)?opencode(?:\s|$)/.test(cmd) && !/^(?:\S*\/)?opencode\s+\S/.test(cmd)) {
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
