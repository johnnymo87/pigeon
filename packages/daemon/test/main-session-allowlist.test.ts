import { describe, expect, it } from "vitest";
import {
  enumerateMainSessionSids,
  type AllowlistDeps,
  parsePids,
  collectMainSubtreeOpencodePids,
  resolveMainSessionSids,
  type RegistrySession,
} from "../src/main-session-allowlist";

interface MockDepsOptions {
  mainPanePids?: number[];
  children?: Record<number, number[]>;
  cmdlines?: Record<number, string>;
}

function makeDeps(opts: MockDepsOptions = {}): AllowlistDeps {
  return {
    listMainPanePids: async () => opts.mainPanePids ?? [],
    childrenOf: async (pid) => opts.children?.[pid] ?? [],
    readCmdline: async (pid) => opts.cmdlines?.[pid] ?? "",
  };
}

describe("enumerateMainSessionSids", () => {
  it("returns empty array if listMainPanePids returns empty", async () => {
    const deps = makeDeps({ mainPanePids: [] });
    const result = await enumerateMainSessionSids(deps);
    expect(result).toEqual([]);
  });

  it("yields ses_ABC from attach command line containing --session ses_ABC (argv branch)", async () => {
    const deps = makeDeps({
      mainPanePids: [1000],
      cmdlines: {
        1000: "/home/dev/.nix-profile/bin/opencode attach /home/dev/projects/pigeon --session ses_ABC",
      },
    });
    const result = await enumerateMainSessionSids(deps);
    expect(result).toEqual(["ses_ABC"]);
  });

  it("walks the process subtree (including grandchildren)", async () => {
    const deps = makeDeps({
      mainPanePids: [1000],
      children: {
        1000: [1001],
        1001: [1002],
      },
      cmdlines: {
        1000: "bash",
        1001: "nvim",
        1002: "/home/dev/.nix-profile/bin/opencode attach --session ses_ABC",
      },
    });
    const result = await enumerateMainSessionSids(deps);
    expect(result).toEqual(["ses_ABC"]);
  });

  it("does NOT resolve a bare opencode TUI (no --session) to any sid", async () => {
    const deps = makeDeps({
      mainPanePids: [1000],
      cmdlines: {
        1000: "/home/dev/.nix-profile/bin/opencode",
      },
    });
    const result = await enumerateMainSessionSids(deps);
    expect(result).toEqual([]);
  });

  it("deduplicates the same session ID discovered across different processes", async () => {
    const deps = makeDeps({
      mainPanePids: [1000, 2000],
      cmdlines: {
        1000: "/home/dev/.nix-profile/bin/opencode attach --session ses_ABC",
        2000: "/home/dev/.nix-profile/bin/opencode attach --session ses_ABC",
      },
    });
    const result = await enumerateMainSessionSids(deps);
    expect(result).toEqual(["ses_ABC"]);
  });

  it("skips non-opencode processes", async () => {
    const deps = makeDeps({
      mainPanePids: [1000],
      cmdlines: {
        1000: "/usr/bin/htop",
      },
    });
    const result = await enumerateMainSessionSids(deps);
    expect(result).toEqual([]);
  });

  it("skips processes with empty cmdline", async () => {
    const deps = makeDeps({
      mainPanePids: [1000],
      cmdlines: {
        1000: "",
      },
    });
    const result = await enumerateMainSessionSids(deps);
    expect(result).toEqual([]);
  });

  it("handles cyclical references safely without infinite looping", async () => {
    const deps = makeDeps({
      mainPanePids: [1000],
      children: {
        1000: [1001],
        1001: [1000],
      },
      cmdlines: {
        1000: "/home/dev/.nix-profile/bin/opencode attach --session ses_ABC",
        1001: "/home/dev/.nix-profile/bin/opencode attach --session ses_XYZ",
      },
    });
    const result = await enumerateMainSessionSids(deps);
    expect(result).toContain("ses_ABC");
    expect(result).toContain("ses_XYZ");
    expect(result).toHaveLength(2);
  });

  it("handles command lines with spaces in --session argument correctly", async () => {
    const deps = makeDeps({
      mainPanePids: [1000],
      cmdlines: {
        1000: "/home/dev/.nix-profile/bin/opencode attach --session     ses_ABC",
      },
    });
    const result = await enumerateMainSessionSids(deps);
    expect(result).toEqual(["ses_ABC"]);
  });

  it("captures session IDs containing dashes and underscores in the argv branch", async () => {
    // 1. Argv branch with mixed-case alnum, dashes, and underscores
    const depsArgv = makeDeps({
      mainPanePids: [1000],
      cmdlines: {
        1000: "/home/dev/.nix-profile/bin/opencode attach http://127.0.0.1:4096 --session ses_161f-68489_ffeIgIvfa --dir /home/dev/projects/foo",
      },
    });
    const resultArgv = await enumerateMainSessionSids(depsArgv);
    expect(resultArgv).toEqual(["ses_161f-68489_ffeIgIvfa"]);
  });

  it("does not falsely identify unrelated commands with 'opencode' as bare TUI", async () => {
    const deps = makeDeps({
      mainPanePids: [1000, 2000],
      cmdlines: {
        1000: "tail -f /tmp/opencode",
        2000: "vim /home/dev/opencode-notes",
      },
    });
    const result = await enumerateMainSessionSids(deps);
    expect(result).toEqual([]);
  });

  it("does not treat the real serve command line as a bare TUI", async () => {
    const deps = makeDeps({
      mainPanePids: [1000],
      cmdlines: {
        1000: "/home/dev/.nix-profile/bin/opencode serve --port 4096 --hostname 127.0.0.1",
      },
    });
    const result = await enumerateMainSessionSids(deps);
    expect(result).toEqual([]);
  });

  it("yields session from wrapped binary name in argv attach branch", async () => {
    const deps = makeDeps({
      mainPanePids: [1000],
      cmdlines: {
        1000: "/nix/store/xxx/bin/.opencode-wrapped attach http://127.0.0.1:4096 --session ses_ABC --dir /p",
      },
    });
    const result = await enumerateMainSessionSids(deps);
    expect(result).toEqual(["ses_ABC"]);
  });
});

describe("parsePids", () => {
  it("parses lines of numeric strings into an array of PIDs", () => {
    const input = "1000\n2000\n  \n3000  \nfoo\n4000\n";
    expect(parsePids(input)).toEqual([1000, 2000, 3000, 4000]);
  });

  it("returns empty array for empty or whitespace-only input", () => {
    expect(parsePids("")).toEqual([]);
    expect(parsePids("   \n  \n")).toEqual([]);
  });
});

describe("collectMainSubtreeOpencodePids", () => {
  it("collectMainSubtreeOpencodePids returns opencode pids in the main subtree", async () => {
    const deps = makeDeps({
      mainPanePids: [1000],
      children: { 1000: [1001, 1002] },
      cmdlines: {
        1000: "bash",                                   // not opencode -> excluded
        1001: "/home/dev/.nix-profile/bin/opencode",    // opencode -> included
        1002: "/home/dev/.nix-profile/bin/opencode attach --session ses_A", // included
      },
    });
    const pids = await collectMainSubtreeOpencodePids(deps);
    expect(pids.sort()).toEqual([1001, 1002]);
  });
});

describe("resolveMainSessionSids", () => {
  it("registry-newest: resolves to the newest registry row for a pid", async () => {
    const deps = makeDeps({
      mainPanePids: [1001],
      cmdlines: {
        1001: "/home/dev/.nix-profile/bin/opencode attach --session ses_OLD",
      },
    });
    const registry: RegistrySession[] = [
      { sessionId: "ses_OLD", pid: 1001, lastSeen: 100 },
      { sessionId: "ses_NEW", pid: 1001, lastSeen: 200 },
    ];
    const result = await resolveMainSessionSids(deps, () => registry);
    expect(result.sids).toEqual(["ses_NEW"]);
    expect(result.homeScreenCount).toBe(0);
  });

  it("argv fallback: resolves to argv if pid has no registry row", async () => {
    const deps = makeDeps({
      mainPanePids: [1002],
      cmdlines: {
        1002: "/home/dev/.nix-profile/bin/opencode attach --session ses_B",
      },
    });
    const result = await resolveMainSessionSids(deps, () => []);
    expect(result.sids).toEqual(["ses_B"]);
    expect(result.homeScreenCount).toBe(0);
  });

  it("precedence: registry row wins over argv when both exist for a pid", async () => {
    const deps = makeDeps({
      mainPanePids: [1003],
      cmdlines: {
        1003: "/home/dev/.nix-profile/bin/opencode attach --session ses_C",
      },
    });
    const registry: RegistrySession[] = [
      { sessionId: "ses_R", pid: 1003, lastSeen: 500 },
    ];
    const result = await resolveMainSessionSids(deps, () => registry);
    expect(result.sids).toEqual(["ses_R"]);
    expect(result.homeScreenCount).toBe(0);
  });

  it("dedup: deduplicates same session ID resolved from different pids in first-seen insertion order", async () => {
    const deps = makeDeps({
      mainPanePids: [1001, 1002, 1003],
      cmdlines: {
        1001: "/home/dev/.nix-profile/bin/opencode attach --session ses_X",
        1002: "/home/dev/.nix-profile/bin/opencode attach --session ses_Y",
        1003: "/home/dev/.nix-profile/bin/opencode attach --session ses_X",
      },
    });
    const result = await resolveMainSessionSids(deps, () => []);
    expect(result.sids).toEqual(["ses_X", "ses_Y"]);
    expect(result.homeScreenCount).toBe(0);
  });

  it("home-screen count: a bare opencode pid with no registry row and no session argv increment homeScreenCount", async () => {
    const deps = makeDeps({
      mainPanePids: [1001],
      cmdlines: {
        1001: "/home/dev/.nix-profile/bin/opencode",
      },
    });
    const result = await resolveMainSessionSids(deps, () => []);
    expect(result.sids).toEqual([]);
    expect(result.homeScreenCount).toBe(1);
  });

  it("non-opencode pids are excluded and do not contribute to sids or homeScreenCount", async () => {
    const deps = makeDeps({
      mainPanePids: [1001, 1002],
      cmdlines: {
        1001: "/usr/bin/htop",
        1002: "/home/dev/.nix-profile/bin/opencode attach --session ses_A",
      },
    });
    const result = await resolveMainSessionSids(deps, () => []);
    expect(result.sids).toEqual(["ses_A"]);
    expect(result.homeScreenCount).toBe(0);
  });

  it("handles registry sessions with null pid gracefully", async () => {
    const deps = makeDeps({
      mainPanePids: [1001],
      cmdlines: {
        1001: "/home/dev/.nix-profile/bin/opencode attach --session ses_A",
      },
    });
    const registry: RegistrySession[] = [
      { sessionId: "ses_null", pid: null, lastSeen: 1000 },
    ];
    const result = await resolveMainSessionSids(deps, () => registry);
    expect(result.sids).toEqual(["ses_A"]);
    expect(result.homeScreenCount).toBe(0);
  });
});
