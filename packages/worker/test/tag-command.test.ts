import { describe, expect, it } from "vitest";
import { isValidDirPattern, isValidTag, parseTagArgs, TAG_USAGE_TEXT } from "../src/tag-command";

describe("parseTagArgs", () => {
  it("treats a bare /tag as the backlog view", () => {
    expect(parseTagArgs("")).toEqual({ kind: "top" });
    expect(parseTagArgs("   ")).toEqual({ kind: "top" });
    expect(parseTagArgs(undefined)).toEqual({ kind: "top" });
  });

  it("recognizes the list subcommand", () => {
    expect(parseTagArgs("list")).toEqual({ kind: "list" });
    expect(parseTagArgs("  list  ")).toEqual({ kind: "list" });
  });

  it("treats a single token as a tag for the context session", () => {
    expect(parseTagArgs("billing")).toEqual({ kind: "set", tag: "billing" });
  });

  it("treats an explicit session id plus tag as a targeted set", () => {
    expect(parseTagArgs("ses_f966a4af3ffeIXwkQcs07oAfBL billing")).toEqual({
      kind: "set",
      targetSessionId: "ses_f966a4af3ffeIXwkQcs07oAfBL",
      tag: "billing",
    });
  });

  it("parses the dir form", () => {
    expect(parseTagArgs("dir /home/dev/projects/mono/.worktrees/* fbm")).toEqual({
      kind: "setDir",
      pattern: "/home/dev/projects/mono/.worktrees/*",
      tag: "fbm",
    });
  });

  it("rejects a session id with no tag rather than tagging it 'ses_...'", () => {
    const parsed = parseTagArgs("ses_f966a4af3ffeIXwkQcs07oAfBL");
    expect(parsed.kind).toBe("usage");
  });

  it("rejects an auto: tag, which oc-tags reserves for its directory fallback", () => {
    expect(parseTagArgs("auto:mono").kind).toBe("usage");
    expect(parseTagArgs("ses_f966a4af3ffeIXwkQcs07oAfBL auto:mono").kind).toBe("usage");
  });

  it("rejects a tag that could be read as a flag by the oc-tags CLI", () => {
    expect(parseTagArgs("--dir").kind).toBe("usage");
    expect(parseTagArgs("-x").kind).toBe("usage");
  });

  it("rejects a dir form with the wrong arity", () => {
    expect(parseTagArgs("dir").kind).toBe("usage");
    expect(parseTagArgs("dir /home/dev/projects/mono/*").kind).toBe("usage");
    expect(parseTagArgs("dir /a/* one two").kind).toBe("usage");
  });

  it("rejects a dir pattern that is not rooted", () => {
    expect(parseTagArgs("dir mono/* fbm").kind).toBe("usage");
    expect(parseTagArgs("dir --db fbm").kind).toBe("usage");
  });

  it("rejects a ~-rooted dir pattern, which oc-tags would store and never match", () => {
    // oc-tags fnmatches the stored pattern against an ABSOLUTE directory and
    // never expands ~, so accepting one would be a silent no-op.
    expect(parseTagArgs("dir ~/projects/mono/* fbm").kind).toBe("usage");
  });

  it("treats /tag top as the backlog view, matching the oc-tags CLI", () => {
    expect(parseTagArgs("top")).toEqual({ kind: "top" });
  });

  it("accepts a session id containing - and _", () => {
    expect(parseTagArgs("ses_a-b_c1234 billing")).toEqual({
      kind: "set",
      targetSessionId: "ses_a-b_c1234",
      tag: "billing",
    });
  });

  it("rejects extra tokens instead of silently falling through as a prompt", () => {
    expect(parseTagArgs("one two three four").kind).toBe("usage");
    expect(parseTagArgs("list extra").kind).toBe("usage");
  });

  it("exposes usage text naming every form", () => {
    expect(TAG_USAGE_TEXT).toContain("/tag list");
    expect(TAG_USAGE_TEXT).toContain("/tag dir");
  });
});

describe("isValidTag", () => {
  it("accepts ordinary tags", () => {
    for (const t of ["billing", "fbm", "cops-6757", "team:infra", "a", "v1.2"]) {
      expect(isValidTag(t)).toBe(true);
    }
  });

  it("rejects empty, auto-prefixed, flag-like, and control-character tags", () => {
    for (const t of ["", " ", "auto:mono", "AUTO:mono", "-x", "--dir", "a\nb", "a b", "a\u0000b"]) {
      expect(isValidTag(t)).toBe(false);
    }
  });

  it("rejects an over-long tag", () => {
    expect(isValidTag("a".repeat(65))).toBe(false);
  });

  it("rejects a non-string rather than coercing it to the tag \"undefined\"", () => {
    expect(isValidTag(undefined as unknown as string)).toBe(false);
    expect(isValidTag(null as unknown as string)).toBe(false);
  });
});

describe("isValidDirPattern", () => {
  it("accepts absolute globs", () => {
    expect(isValidDirPattern("/home/dev/projects/mono/.worktrees/*")).toBe(true);
  });

  it("rejects relative, ~-rooted, flag-like, empty, and control-character patterns", () => {
    for (const p of ["", "mono/*", "~/projects/mono", "--db", "-", "/a\nb"]) {
      expect(isValidDirPattern(p)).toBe(false);
    }
  });

  it("rejects a non-string, so corrupt wire data cannot be coerced into a pattern", () => {
    expect(isValidDirPattern(undefined as unknown as string)).toBe(false);
  });

  it("rejects an over-long pattern", () => {
    expect(isValidDirPattern("/" + "a".repeat(300))).toBe(false);
  });
});
