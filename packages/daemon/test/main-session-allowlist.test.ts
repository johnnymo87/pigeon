import { describe, expect, it } from "vitest";
import { enumerateMainSessionSids, type AllowlistDeps } from "../src/main-session-allowlist";

interface MockDepsOptions {
  mainPanePids?: number[];
  children?: Record<number, number[]>;
  cmdlines?: Record<number, string>;
  cwds?: Record<number, string | null>;
  sidsByDir?: Record<string, string | null>;
}

function makeDeps(opts: MockDepsOptions = {}): AllowlistDeps {
  return {
    listMainPanePids: async () => opts.mainPanePids ?? [],
    childrenOf: async (pid) => opts.children?.[pid] ?? [],
    readCmdline: async (pid) => opts.cmdlines?.[pid] ?? "",
    readCwd: async (pid) => opts.cwds?.[pid] ?? null,
    resolveSidByDir: async (dir) => opts.sidsByDir?.[dir] ?? null,
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

  it("resolves session ID by dir for bare opencode branches without subcommands/--session", async () => {
    const deps = makeDeps({
      mainPanePids: [1000],
      cmdlines: {
        1000: "/home/dev/.nix-profile/bin/opencode",
      },
      cwds: {
        1000: "/home/dev/projects/pigeon",
      },
      sidsByDir: {
        "/home/dev/projects/pigeon": "ses_XYZ",
      },
    });
    const result = await enumerateMainSessionSids(deps);
    expect(result).toEqual(["ses_XYZ"]);
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

  it("ignores session ID returned from resolveSidByDir if it does not follow ses_XXX format", async () => {
    const deps = makeDeps({
      mainPanePids: [1000],
      cmdlines: {
        1000: "/home/dev/.nix-profile/bin/opencode",
      },
      cwds: {
        1000: "/home/dev/projects/pigeon",
      },
      sidsByDir: {
        "/home/dev/projects/pigeon": "invalid_sid_format",
      },
    });
    const result = await enumerateMainSessionSids(deps);
    expect(result).toEqual([]);
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

  it("correctly captures session IDs containing dashes and underscores via both argv and bare/resolve branches", async () => {
    // 1. Argv branch with mixed-case alnum, dashes, and underscores
    const depsArgv = makeDeps({
      mainPanePids: [1000],
      cmdlines: {
        1000: "/home/dev/.nix-profile/bin/opencode attach http://127.0.0.1:4096 --session ses_161f-68489_ffeIgIvfa --dir /home/dev/projects/foo",
      },
    });
    const resultArgv = await enumerateMainSessionSids(depsArgv);
    expect(resultArgv).toEqual(["ses_161f-68489_ffeIgIvfa"]);

    // 2. Bare/resolve branch with mixed-case alnum, dashes, and underscores
    const depsBare = makeDeps({
      mainPanePids: [2000],
      cmdlines: {
        2000: "/home/dev/.nix-profile/bin/opencode",
      },
      cwds: {
        2000: "/home/dev/projects/foo",
      },
      sidsByDir: {
        "/home/dev/projects/foo": "ses_abc-12_DEF",
      },
    });
    const resultBare = await enumerateMainSessionSids(depsBare);
    expect(resultBare).toEqual(["ses_abc-12_DEF"]);
  });

  it("does not falsely identify unrelated commands with 'opencode' as bare TUI", async () => {
    const deps = makeDeps({
      mainPanePids: [1000, 2000],
      cmdlines: {
        1000: "tail -f /tmp/opencode",
        2000: "vim /home/dev/opencode-notes",
      },
      cwds: {
        1000: "/home/dev",
        2000: "/home/dev",
      },
      sidsByDir: {
        "/home/dev": "ses_NOT_EXPECTED",
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
      cwds: {
        1000: "/home/dev/projects/pigeon",
      },
      sidsByDir: {
        "/home/dev/projects/pigeon": "ses_XYZ",
      },
    });
    const result = await enumerateMainSessionSids(deps);
    expect(result).toEqual([]);
  });
});
