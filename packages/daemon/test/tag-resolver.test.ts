import { describe, it, expect, vi } from "vitest";
import { SessionTagResolver, parseWhich, parseWhichLine } from "../src/tag-resolver";
import type { OcTagsResult } from "../src/worker/oc-tags";

function makeRunner(results: Array<OcTagsResult | Error>, calls: string[][] = []) {
  let i = 0;
  return async (args: string[]): Promise<OcTagsResult> => {
    calls.push(args);
    const r = results[Math.min(i, results.length - 1)]!;
    i += 1;
    if (r instanceof Error) throw r;
    return r;
  };
}

const ok = (stdout: string): OcTagsResult => ({ code: 0, stdout, stderr: "" });

describe("SessionTagResolver", () => {
  it("returns null on a cold miss and never awaits the spawn", () => {
    const resolver = new SessionTagResolver({ runner: makeRunner([ok("billing\tmanual\tses_a\n")]) });
    // The notification path is synchronous by construction: /question-asked is
    // awaited by the plugin under a 3s timeout, so a cold session renders
    // without the tag rather than paying for a subprocess inline.
    expect(resolver.get("ses_a")).toBeNull();
  });

  it("serves the tag from cache once a refresh has completed", async () => {
    const resolver = new SessionTagResolver({ runner: makeRunner([ok("billing\tmanual\tses_a\n")]) });
    await resolver.refresh("ses_a");
    expect(resolver.get("ses_a")).toBe("billing");
  });

  it("omits an auto: tag — the cwd line already carries that information", async () => {
    const resolver = new SessionTagResolver({ runner: makeRunner([ok("auto:pigeon\tauto\tses_a\n")]) });
    await resolver.refresh("ses_a");
    expect(resolver.get("ses_a")).toBeNull();
  });

  it("asks oc-tags for the session it was given", async () => {
    const calls: string[][] = [];
    const resolver = new SessionTagResolver({ runner: makeRunner([ok("x\tmanual\tses_a\n")], calls) });
    await resolver.refresh("ses_a");
    expect(calls).toEqual([["which", "ses_a"]]);
  });

  it("re-runs only after the TTL expires", async () => {
    const calls: string[][] = [];
    let now = 1000;
    const resolver = new SessionTagResolver({
      runner: makeRunner([ok("billing\tmanual\tses_a\n")], calls),
      nowFn: () => now,
      ttlMs: 10_000,
    });
    await resolver.refresh("ses_a");
    now += 9_000;
    resolver.get("ses_a");
    await resolver.drain();
    expect(calls.length).toBe(1);

    now += 2_000;
    resolver.get("ses_a");
    await resolver.drain();
    expect(calls.length).toBe(2);
  });

  it("keeps serving the stale tag while a refresh is in flight", async () => {
    let now = 1000;
    const resolver = new SessionTagResolver({
      runner: makeRunner([ok("billing\tmanual\tses_a\n")]),
      nowFn: () => now,
      ttlMs: 10_000,
    });
    await resolver.refresh("ses_a");
    now += 20_000;
    // A stale answer beats no answer: the tag of a session changes rarely, and
    // blanking the line during every refresh would make it flicker.
    expect(resolver.get("ses_a")).toBe("billing");
  });

  it("collapses concurrent refreshes for one session into a single spawn", async () => {
    const calls: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const resolver = new SessionTagResolver({
      runner: async (args: string[]) => {
        calls.push(args);
        await gate;
        return ok("billing\tmanual\tses_a\n");
      },
    });
    const a = resolver.refresh("ses_a");
    const b = resolver.refresh("ses_a");
    release();
    await Promise.all([a, b]);
    expect(calls.length).toBe(1);
  });

  it("caches a miss so a failing lookup is not retried on every notification", async () => {
    const calls: string[][] = [];
    let now = 1000;
    const resolver = new SessionTagResolver({
      runner: makeRunner([{ code: 1, stdout: "", stderr: "boom" }], calls),
      nowFn: () => now,
      negativeTtlMs: 5_000,
    });
    await resolver.refresh("ses_a");
    expect(resolver.get("ses_a")).toBeNull();
    await resolver.drain();
    expect(calls.length).toBe(1);

    now += 6_000;
    resolver.get("ses_a");
    await resolver.drain();
    expect(calls.length).toBe(2);
  });

  it("never throws when the runner rejects", async () => {
    const resolver = new SessionTagResolver({ runner: makeRunner([new Error("ENOENT")]) });
    await expect(resolver.refresh("ses_a")).resolves.toBeUndefined();
    expect(resolver.get("ses_a")).toBeNull();
  });

  it("is inert when oc-tags is not installed", async () => {
    const resolver = new SessionTagResolver({ runner: null });
    await resolver.refresh("ses_a");
    expect(resolver.get("ses_a")).toBeNull();
  });

  it("ignores output it cannot parse", async () => {
    for (const stdout of ["", "\n", "billing\n", "billing manual ses_a\n"]) {
      const resolver = new SessionTagResolver({ runner: makeRunner([ok(stdout)]) });
      await resolver.refresh("ses_a");
      expect(resolver.get("ses_a")).toBeNull();
    }
  });

  it("reads only the first line of output", async () => {
    // stderr is separate, but a future oc-tags that prints a second line must
    // not be able to turn one answer into a different one.
    const resolver = new SessionTagResolver({ runner: makeRunner([ok("billing\tmanual\tses_a\nnoise\tmanual\tses_b\n")]) });
    await resolver.refresh("ses_a");
    expect(resolver.get("ses_a")).toBe("billing");
  });

  it("bounds the cache so a long-lived daemon cannot grow without limit", async () => {
    const resolver = new SessionTagResolver({
      runner: async () => ok("billing\tmanual\tx\n"),
      maxEntries: 3,
    });
    for (const id of ["a", "b", "c", "d"]) {
      await resolver.refresh(id);
    }
    expect(resolver.size).toBeLessThanOrEqual(3);
    // The most recent survivors are the ones a notification is likely to want.
    expect(resolver.get("d")).toBe("billing");
  });

  it("drops a session from the cache on demand", async () => {
    const resolver = new SessionTagResolver({ runner: makeRunner([ok("billing\tmanual\tses_a\n")]) });
    await resolver.refresh("ses_a");
    resolver.forget("ses_a");
    expect(resolver.get("ses_a")).toBeNull();
  });

  it("refuses a session id oc-tags could read as an option", async () => {
    const calls: string[][] = [];
    const resolver = new SessionTagResolver({ runner: makeRunner([ok("billing\tmanual\tx\n")], calls) });
    await resolver.refresh("--tags-db");
    expect(calls).toEqual([]);
    expect(resolver.get("--tags-db")).toBeNull();
  });

  it("does not cache a miss found by warm()", async () => {
    // /launch --tag and opencode-launch both tag AFTER creating and prompting
    // the session, so the warm-up at session start races that window. Caching
    // its negative would hide the tag from the session's FIRST notification —
    // the one read right after Telegram said the tag was applied.
    const calls: string[][] = [];
    const resolver = new SessionTagResolver({
      runner: makeRunner([ok("auto:pigeon\tauto\tses_a\n"), ok("billing\tmanual\tses_a\n")], calls),
    });
    resolver.warm("ses_a");
    await resolver.drain();
    expect(resolver.get("ses_a")).toBeNull();
    await resolver.drain();
    expect(calls.length).toBe(2);
    expect(resolver.get("ses_a")).toBe("billing");
  });

  it("caches a positive found by warm()", async () => {
    const calls: string[][] = [];
    const resolver = new SessionTagResolver({
      runner: makeRunner([ok("billing\tmanual\tses_a\n")], calls),
    });
    resolver.warm("ses_a");
    await resolver.drain();
    expect(resolver.get("ses_a")).toBe("billing");
    await resolver.drain();
    expect(calls.length).toBe(1);
  });

  it("discards an in-flight answer that an invalidation has overtaken", async () => {
    // The lookup began before `oc-tags set` committed, so its answer predates
    // the tag it would overwrite. Landing it would put the old tag back for a
    // full TTL, right after the user was told the new one was applied.
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let first = true;
    const resolver = new SessionTagResolver({
      runner: async () => {
        if (first) {
          first = false;
          await gate;
          return ok("old\tmanual\tses_a\n");
        }
        return ok("new\tmanual\tses_a\n");
      },
    });
    const stale = resolver.refresh("ses_a");
    resolver.forget("ses_a");
    release();
    await stale;
    expect(resolver.get("ses_a")).toBeNull();
  });

  it("refreshNow drops the cached answer and fetches the new one", async () => {
    const resolver = new SessionTagResolver({
      runner: makeRunner([ok("old\tmanual\tses_a\n"), ok("new\tmanual\tses_a\n")]),
    });
    await resolver.refresh("ses_a");
    expect(resolver.get("ses_a")).toBe("old");
    resolver.refreshNow("ses_a");
    await resolver.drain();
    expect(resolver.get("ses_a")).toBe("new");
  });

  it("clear() also invalidates a refresh already in flight", async () => {
    // `/tag dir` is retroactive, so it can change the answer a running lookup
    // is about to return.
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const resolver = new SessionTagResolver({
      runner: async () => { await gate; return ok("old\tmanual\tses_a\n"); },
    });
    const stale = resolver.refresh("ses_a");
    resolver.clear();
    release();
    await stale;
    expect(resolver.get("ses_a")).toBeNull();
  });

  it("logs a failure at most once per session", async () => {
    const warn = vi.fn();
    let now = 1000;
    const resolver = new SessionTagResolver({
      runner: makeRunner([new Error("ENOENT")]),
      nowFn: () => now,
      negativeTtlMs: 1,
      log: warn,
    });
    await resolver.refresh("ses_a");
    now += 10;
    await resolver.refresh("ses_a");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("parseWhichLine / parseWhich", () => {
  it("reads column 4 (kind) when oc-tags prints it", () => {
    expect(parseWhichLine("billing\tmanual\tses_a\tsession\n")).toEqual({
      tag: "billing", source: "manual", rootSessionId: "ses_a", kind: "session",
    });
    expect(parseWhichLine("mono\tmanual\tses_a\tdir\n")?.kind).toBe("dir");
    expect(parseWhichLine("auto:pigeon\tauto\tses_a\tauto\n")?.kind).toBe("auto");
  });

  it("leaves kind undefined for an older, 3-column oc-tags", () => {
    const parsed = parseWhichLine("billing\tmanual\tses_a\n");
    expect(parsed).toEqual({ tag: "billing", source: "manual", rootSessionId: "ses_a" });
    expect(parsed && "kind" in parsed).toBe(false);
  });

  it("rejects empty output and lines with fewer than three columns", () => {
    expect(parseWhichLine("")).toBeNull();
    expect(parseWhichLine("billing\tmanual\n")).toBeNull();
  });

  it("parseWhich (the footer's view) is unchanged by column 4: manual renders, auto does not", () => {
    expect(parseWhich("billing\tmanual\tses_a\n")).toBe("billing");
    expect(parseWhich("billing\tmanual\tses_a\tsession\n")).toBe("billing");
    expect(parseWhich("mono\tmanual\tses_a\tdir\n")).toBe("mono");
    expect(parseWhich("auto:pigeon\tauto\tses_a\tauto\n")).toBeNull();
  });
});
