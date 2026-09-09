import { describe, expect, it, vi } from "vitest";
import {
  ingestTagListCommand,
  ingestTagSetCommand,
  ingestTagSetDirCommand,
  ingestTagTopCommand,
  isValidDirPattern,
  isValidTag,
  parseTopOutput,
  type TagCommandDeps,
} from "../src/worker/tag-ingest";

// Captured verbatim from `oc-tags top --days 14` on cloudbox.
const TOP_OUTPUT = [
  "   dollars  session_id                        title                                     directory",
  "--------------------------------------------------------------------------------------------------------------",
  "   $524.08  ses_f966a4af3ffeIXwkQcs07oAfBL    COPS-6757 STEP 3 fulfiller dating         /home/dev/projects/culinary-operations-server/.worktrees/cops-6757-step3",
  "   $305.41  ses_fca8c2910ffelugfbyTBCqvDdN    Labor day                                 /home/dev/projects/salmon-of-knowledge",
  " $1,222.58  ses_fdde36346ffeVDd8gsL7G9f0UV    LGTM timer: NYC hours, early stop         /home/dev/projects/workstation",
  "    $46.57  ses_1b57e2661ffeFV8tcxhsxkTTjI                                              /home/dev/projects/mono",
  "",
  "Hint: 12 untagged roots share directory prefix '/home/dev/projects/mono/.worktrees/*'. Cover them with:",
  "  oc-tags set --dir '/home/dev/projects/mono/.worktrees/*' <tag>",
].join("\n");

function makeDeps(overrides: Partial<TagCommandDeps> = {}): TagCommandDeps {
  return {
    chatId: "12345",
    commandId: "cmd-1",
    machineId: "cloudbox",
    homeDir: "/home/dev",
    runOcTags: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
    sendTelegramReply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function sentText(deps: TagCommandDeps): string {
  const mock = deps.sendTelegramReply as ReturnType<typeof vi.fn>;
  expect(mock.mock.calls.length).toBeGreaterThan(0);
  return mock.mock.calls[0]![1] as string;
}

function sentEntities(deps: TagCommandDeps): Array<{ type: string; offset: number; length: number }> {
  const mock = deps.sendTelegramReply as ReturnType<typeof vi.fn>;
  return (mock.mock.calls[0]![2] ?? []) as Array<{ type: string; offset: number; length: number }>;
}

function ocTagsArgs(deps: TagCommandDeps): string[] {
  const mock = deps.runOcTags as ReturnType<typeof vi.fn>;
  expect(mock.mock.calls.length).toBe(1);
  return mock.mock.calls[0]![0] as string[];
}

describe("parseTopOutput", () => {
  it("parses the fixed-width table into rows", () => {
    const { rows } = parseTopOutput(TOP_OUTPUT);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      dollars: 524.08,
      sessionId: "ses_f966a4af3ffeIXwkQcs07oAfBL",
      title: "COPS-6757 STEP 3 fulfiller dating",
      directory: "/home/dev/projects/culinary-operations-server/.worktrees/cops-6757-step3",
    });
  });

  it("parses thousands separators", () => {
    const { rows } = parseTopOutput(TOP_OUTPUT);
    expect(rows[2]!.dollars).toBe(1222.58);
  });

  it("tolerates an empty title", () => {
    const { rows } = parseTopOutput(TOP_OUTPUT);
    expect(rows[3]).toEqual({
      dollars: 46.57,
      sessionId: "ses_1b57e2661ffeFV8tcxhsxkTTjI",
      title: "",
      directory: "/home/dev/projects/mono",
    });
  });

  it("extracts the directory-prefix hints", () => {
    const { hints } = parseTopOutput(TOP_OUTPUT);
    expect(hints).toEqual([{ count: 12, pattern: "/home/dev/projects/mono/.worktrees/*" }]);
  });

  it("returns nothing for unparseable output rather than inventing rows", () => {
    expect(parseTopOutput("something entirely different\n")).toEqual({ rows: [], hints: [] });
  });
});

describe("ingestTagTopCommand", () => {
  it("asks oc-tags for the untagged backlog", async () => {
    const deps = makeDeps({
      runOcTags: vi.fn().mockResolvedValue({ code: 0, stdout: TOP_OUTPUT, stderr: "" }),
    });
    await ingestTagTopCommand(deps);
    expect(ocTagsArgs(deps)).toEqual(["top", "--days", "14"]);
  });

  it("renders dollars, title, shortened directory and a copyable command per row", async () => {
    const deps = makeDeps({
      runOcTags: vi.fn().mockResolvedValue({ code: 0, stdout: TOP_OUTPUT, stderr: "" }),
    });
    await ingestTagTopCommand(deps);

    const text = sentText(deps);
    expect(text).toContain("$524.08");
    expect(text).toContain("COPS-6757 STEP 3 fulfiller dating");
    // Home and the projects root are noise on a phone.
    expect(text).toContain("culinary-operations-server/.worktrees/cops-6757-step3");
    expect(text).not.toContain("/home/dev/projects/culinary");
    // Tap-to-copy: the whole command prefix, ready to paste and append a tag.
    expect(text).toContain("/tag ses_f966a4af3ffeIXwkQcs07oAfBL");
    // Entities, never Markdown.
    expect(text).not.toContain("`");
  });

  it("marks each copyable command as a code entity", async () => {
    const deps = makeDeps({
      runOcTags: vi.fn().mockResolvedValue({ code: 0, stdout: TOP_OUTPUT, stderr: "" }),
    });
    await ingestTagTopCommand(deps);

    const text = sentText(deps);
    const codes = sentEntities(deps)
      .filter((e) => e.type === "code")
      .map((e) => text.slice(e.offset, e.offset + e.length));
    expect(codes).toContain("/tag ses_f966a4af3ffeIXwkQcs07oAfBL");
  });

  it("surfaces the directory-glob hint, which covers many sessions at once", async () => {
    const deps = makeDeps({
      runOcTags: vi.fn().mockResolvedValue({ code: 0, stdout: TOP_OUTPUT, stderr: "" }),
    });
    await ingestTagTopCommand(deps);

    const text = sentText(deps);
    expect(text).toContain("12");
    expect(text).toContain("/tag dir /home/dev/projects/mono/.worktrees/*");
  });

  it("caps the number of rows so the reply fits in one Telegram message", async () => {
    const header = TOP_OUTPUT.split("\n").slice(0, 2);
    // Mirrors oc-tags' printf: {dollars:>10}  {session_id:<32}  {title:<40}  {directory}
    const many = Array.from({ length: 40 }, (_, i) => {
      const dollars = `$${String(100 - i).padStart(3, "0")}.00`.padStart(10);
      const sid = `ses_aaaaaaaaaaaaaaaaaaaaaa${String(i).padStart(4, "0")}`.padEnd(32);
      const title = `title ${i}`.padEnd(40);
      return `${dollars}  ${sid}  ${title}  /home/dev/projects/mono/.worktrees/w${i}`;
    });
    const deps = makeDeps({
      runOcTags: vi.fn().mockResolvedValue({ code: 0, stdout: [...header, ...many].join("\n"), stderr: "" }),
    });
    await ingestTagTopCommand(deps);

    const text = sentText(deps);
    expect(text.length).toBeLessThan(4096);
    expect(text).toContain("40");
  });

  it("passes through oc-tags' own empty-backlog message", async () => {
    const deps = makeDeps({
      runOcTags: vi.fn().mockResolvedValue({ code: 0, stdout: "No untagged root sessions found.\n", stderr: "" }),
    });
    await ingestTagTopCommand(deps);
    expect(sentText(deps)).toContain("No untagged root sessions found.");
  });

  it("reports a non-zero exit", async () => {
    const deps = makeDeps({
      runOcTags: vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "Error: bad db\n" }),
    });
    await ingestTagTopCommand(deps);
    expect(sentText(deps)).toContain("bad db");
  });
});

describe("ingestTagListCommand", () => {
  it("shows oc-tags' own table verbatim in a pre block", async () => {
    const stdout = [
      "tag                                    sessions     dirs",
      "--------------------------------------------------------",
      "billing                                       3        1",
      "",
    ].join("\n");
    const deps = makeDeps({ runOcTags: vi.fn().mockResolvedValue({ code: 0, stdout, stderr: "" }) });
    await ingestTagListCommand(deps);

    expect(ocTagsArgs(deps)).toEqual(["ls", "--counts"]);
    const text = sentText(deps);
    expect(text).toContain("billing");
    expect(sentEntities(deps).some((e) => e.type === "pre")).toBe(true);
  });
});

describe("ingestTagSetCommand", () => {
  it("passes the tag and session id as separate argv elements", async () => {
    const deps = makeDeps({
      runOcTags: vi.fn().mockResolvedValue({ code: 0, stdout: "Tagged session 'ses_abcd1234' as 'billing'\n", stderr: "" }),
    });
    await ingestTagSetCommand({ ...deps, targetSessionId: "ses_abcd1234", tag: "billing" });

    expect(ocTagsArgs(deps)).toEqual(["set", "billing", "ses_abcd1234"]);
    expect(sentText(deps)).toContain("billing");
  });

  it("refuses a tag the validator rejects without spawning anything", async () => {
    const deps = makeDeps();
    await ingestTagSetCommand({ ...deps, targetSessionId: "ses_abcd1234", tag: "--dir" });

    expect((deps.runOcTags as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(sentText(deps)).toContain("Invalid tag");
  });

  it("refuses a bad session id without spawning anything", async () => {
    const deps = makeDeps();
    await ingestTagSetCommand({ ...deps, targetSessionId: "--db", tag: "billing" });

    expect((deps.runOcTags as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(sentText(deps)).toContain("session");
  });

  it("reports oc-tags' error text on a non-zero exit", async () => {
    const deps = makeDeps({
      runOcTags: vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "Error: tag must not start with 'auto:'\n" }),
    });
    await ingestTagSetCommand({ ...deps, targetSessionId: "ses_abcd1234", tag: "billing" });
    expect(sentText(deps)).toContain("auto:");
  });
});

describe("ingestTagSetDirCommand", () => {
  it("passes --dir, the pattern and the tag as separate argv elements", async () => {
    const deps = makeDeps({
      runOcTags: vi.fn().mockResolvedValue({ code: 0, stdout: "Tagged dir pattern '/a/*' as 'fbm'\n", stderr: "" }),
    });
    await ingestTagSetDirCommand({ ...deps, pattern: "/home/dev/projects/mono/.worktrees/*", tag: "fbm" });

    expect(ocTagsArgs(deps)).toEqual(["set", "--dir", "/home/dev/projects/mono/.worktrees/*", "fbm"]);
  });

  it("refuses an unrooted pattern without spawning anything", async () => {
    const deps = makeDeps();
    await ingestTagSetDirCommand({ ...deps, pattern: "mono/*", tag: "fbm" });

    expect((deps.runOcTags as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(sentText(deps)).toContain("Invalid directory pattern");
  });
});

describe("when oc-tags is not installed", () => {
  it("says so, naming the machine, for every form", async () => {
    for (const run of [
      (d: TagCommandDeps) => ingestTagTopCommand(d),
      (d: TagCommandDeps) => ingestTagListCommand(d),
      (d: TagCommandDeps) => ingestTagSetCommand({ ...d, targetSessionId: "ses_abcd1234", tag: "billing" }),
      (d: TagCommandDeps) => ingestTagSetDirCommand({ ...d, pattern: "/a/*", tag: "fbm" }),
    ]) {
      const deps = makeDeps({ runOcTags: null });
      await run(deps);
      const text = sentText(deps);
      expect(text).toContain("oc-tags");
      expect(text).toContain("cloudbox");
    }
  });
});

describe("when oc-tags cannot be executed", () => {
  it("reports the failure instead of throwing, so the command is still acked", async () => {
    const deps = makeDeps({ runOcTags: vi.fn().mockRejectedValue(new Error("spawn ENOENT")) });
    await expect(ingestTagTopCommand(deps)).resolves.toBeUndefined();
    expect(sentText(deps)).toContain("ENOENT");
  });
});

describe("malformed wire data", () => {
  // TypeScript says these are strings; the wire does not. A throw here would
  // skip the poller ack and redeliver the command every lease expiry for 24h.
  it("rejects an absent pattern without throwing", async () => {
    const deps = makeDeps();
    await expect(
      ingestTagSetDirCommand({ ...deps, pattern: undefined as unknown as string, tag: "fbm" }),
    ).resolves.toBeUndefined();
    expect((deps.runOcTags as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("rejects an absent tag rather than tagging a session \"undefined\"", async () => {
    const deps = makeDeps();
    await expect(
      ingestTagSetCommand({ ...deps, targetSessionId: "ses_abcd1234", tag: undefined as unknown as string }),
    ).resolves.toBeUndefined();
    expect((deps.runOcTags as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("rejects an absent target session without throwing", async () => {
    const deps = makeDeps();
    await expect(
      ingestTagSetCommand({ ...deps, targetSessionId: undefined as unknown as string, tag: "billing" }),
    ).resolves.toBeUndefined();
    expect((deps.runOcTags as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

describe("rendering safety", () => {
  it("does not split a surrogate pair when truncating a directory", async () => {
    // 80 UTF-16 code units of astral emoji, well past the 60-unit directory cap.
    const emoji = "\u{1F600}".repeat(40);
    const line = `   $10.00  ${"ses_aaaaaaaaaaaaaaaaaaaaaa0001".padEnd(32)}  ${"t".padEnd(40)}  /home/dev/projects/${emoji}`;
    const deps = makeDeps({
      runOcTags: vi.fn().mockResolvedValue({ code: 0, stdout: `x\n${line}`, stderr: "" }),
    });
    await ingestTagTopCommand(deps);

    const text = sentText(deps);
    // An unpaired surrogate makes the JSON body invalid UTF-8 and Telegram
    // rejects the whole message with a 400.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false);
  });

  it("shows an unrecognised top table as a pre block, so it stays readable", async () => {
    const deps = makeDeps({
      runOcTags: vi.fn().mockResolvedValue({ code: 0, stdout: "some  other  table\n", stderr: "" }),
    });
    await ingestTagTopCommand(deps);
    expect(sentEntities(deps).some((e) => e.type === "pre")).toBe(true);
  });
});

describe("daemon-side input validation", () => {
  it("mirrors the worker's rules", () => {
    expect(isValidTag("billing")).toBe(true);
    expect(isValidTag("auto:mono")).toBe(false);
    expect(isValidTag("--dir")).toBe(false);
    expect(isValidTag("")).toBe(false);
    expect(isValidDirPattern("/home/dev/projects/mono/*")).toBe(true);
    expect(isValidDirPattern("mono/*")).toBe(false);
    expect(isValidDirPattern("~/projects/mono")).toBe(false);
    expect(isValidTag(undefined as unknown as string)).toBe(false);
    expect(isValidDirPattern(undefined as unknown as string)).toBe(false);
  });
});
