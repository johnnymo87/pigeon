import { describe, expect, it } from "vitest";
import { createOcTagsRunner, describeOcTagsFailure, resolveOcTagsBin } from "../src/worker/oc-tags";

function executableSet(paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

describe("resolveOcTagsBin", () => {
  it("prefers an explicitly configured path", () => {
    expect(
      resolveOcTagsBin({
        configured: "/opt/oc-tags",
        env: { PATH: "/usr/bin", HOME: "/home/dev" },
        isExecutable: executableSet(["/opt/oc-tags", "/usr/bin/oc-tags"]),
      }),
    ).toBe("/opt/oc-tags");
  });

  it("returns null when a configured path is not executable, instead of falling back", () => {
    // Silently falling back would turn a typo in PIGEON_OC_TAGS_BIN into a
    // different binary running than the operator asked for.
    expect(
      resolveOcTagsBin({
        configured: "/opt/typo",
        env: { PATH: "/usr/bin", HOME: "/home/dev" },
        isExecutable: executableSet(["/usr/bin/oc-tags"]),
      }),
    ).toBeNull();
  });

  it("searches PATH", () => {
    expect(
      resolveOcTagsBin({
        env: { PATH: "/nope:/usr/local/bin:/usr/bin", HOME: "/home/dev" },
        isExecutable: executableSet(["/usr/local/bin/oc-tags"]),
      }),
    ).toBe("/usr/local/bin/oc-tags");
  });

  it("finds the nix profile binary when PATH is the minimal one systemd gives us", () => {
    expect(
      resolveOcTagsBin({
        env: { PATH: "/usr/bin:/bin", HOME: "/home/dev" },
        isExecutable: executableSet(["/home/dev/.nix-profile/bin/oc-tags"]),
      }),
    ).toBe("/home/dev/.nix-profile/bin/oc-tags");
  });

  it("finds the system profile binary", () => {
    expect(
      resolveOcTagsBin({
        env: { PATH: "/usr/bin:/bin", HOME: "/home/dev" },
        isExecutable: executableSet(["/run/current-system/sw/bin/oc-tags"]),
      }),
    ).toBe("/run/current-system/sw/bin/oc-tags");
  });

  it("returns null when oc-tags is installed nowhere", () => {
    expect(
      resolveOcTagsBin({
        env: { PATH: "/usr/bin:/bin", HOME: "/home/dev" },
        isExecutable: executableSet([]),
      }),
    ).toBeNull();
  });

  it("tolerates an absent PATH and an absent HOME", () => {
    expect(resolveOcTagsBin({ env: {}, isExecutable: executableSet([]) })).toBeNull();
  });
});

describe("createOcTagsRunner", () => {
  it("captures stdout and a zero exit code", async () => {
    const run = createOcTagsRunner("/bin/sh");
    const result = await run(["-c", "printf 'hello\\n'"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  it("captures a non-zero exit code and stderr without throwing", async () => {
    // oc-tags reports user errors as exit 1 + stderr; those must reach the user
    // as a message, not as an unhandled rejection that skips the ack.
    const run = createOcTagsRunner("/bin/sh");
    const result = await run(["-c", "printf 'boom\\n' >&2; exit 3"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toBe("boom\n");
  });

  it("rejects a killed process instead of reporting a clean empty success", async () => {
    // execFile reports a timeout/kill as code=null + signal, which a naive
    // "is it a number?" check reads as exit 0 with empty stdout -- i.e. a hung
    // oc-tags would render as "no untagged sessions found".
    const run = createOcTagsRunner("/bin/sh");
    await expect(run(["-c", "kill -TERM $$; sleep 5"])).rejects.toThrow();
  });

  it("rejects when the binary does not exist", async () => {
    const run = createOcTagsRunner("/nonexistent/oc-tags");
    await expect(run(["ls"])).rejects.toThrow();
  });
});

describe("describeOcTagsFailure", () => {
  it("names a timeout, which execFile reports without that word anywhere in it", async () => {
    // execFile's timeout kill is {code: null, killed: true, signal: "SIGTERM"}
    // and its message is "Command failed: <argv>" -- so the naked message says
    // nothing about why, which is exactly the failure the CLI version of this
    // feature shipped with. Synthesized rather than provoked: the runner's
    // timeout is 20s and a test must not wait for it.
    const err = Object.assign(new Error("Command failed: /nix/store/x/bin/oc-tags set fbm ses_x"), {
      code: null,
      killed: true,
      signal: "SIGTERM",
    });
    expect(describeOcTagsFailure(err)).toMatch(/timed out after 20s/);
  });

  it("distinguishes an external kill from a timeout", async () => {
    // A signal WITHOUT killed=true is something else killing oc-tags (an OOM,
    // a stray pkill). Calling that a timeout would send an operator looking at
    // the wrong thing. Provoked for real, since it needs no waiting.
    const run = createOcTagsRunner("/bin/sh");
    const err = await run(["-c", "kill -TERM $$; sleep 5"]).then(
      () => { throw new Error("expected a rejection"); },
      (e: unknown) => e,
    );
    const described = describeOcTagsFailure(err);
    expect(described).toContain("SIGTERM");
    expect(described).not.toMatch(/timed out/);
  });

  it("passes an ENOENT message through, since it already names the path", async () => {
    const run = createOcTagsRunner("/nonexistent/oc-tags");
    const err = await run(["ls"]).then(
      () => { throw new Error("expected a rejection"); },
      (e: unknown) => e,
    );
    expect(describeOcTagsFailure(err)).toContain("ENOENT");
  });

  it("falls back to a string for a non-Error rejection", () => {
    expect(describeOcTagsFailure("weird")).toBe("weird");
  });
});
