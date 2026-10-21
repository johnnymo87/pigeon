/**
 * packages/worker/scripts/machine-key.mjs (pigeon-k0qn.8). Lives in the daemon suite because
 * the worker suite runs inside workerd, which cannot touch the filesystem or spawn git.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- plain .mjs, no declarations
import * as script from "../../worker/scripts/machine-key.mjs";
import * as fs from "node:fs";

const workerCredentials = fs.readFileSync(
  join(__dirname, "../../worker/src/credentials.ts"),
  "utf8",
);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "machine-key-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("machine-key.mjs", () => {
  it("uses the same key and machine-id patterns as the worker", () => {
    expect(workerCredentials).toContain(
      `export const MACHINE_KEY_PATTERN = ${String(script.MACHINE_KEY_PATTERN)};`,
    );
    expect(workerCredentials).toContain(
      `export const MACHINE_ID_PATTERN = ${String(script.MACHINE_ID_PATTERN)};`,
    );
  });

  it("mints a well-formed key into a new 0600 file and returns only its hash", () => {
    const out = join(dir, "k");
    const r = script.mint("cloudbox", out, { now: 1_700_000_000_000, host: "h" });
    const key = readFileSync(out, "utf8").trim();
    expect(script.MACHINE_KEY_PATTERN.test(key)).toBe(true);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(r.hash).toBe(script.sha256Hex(key));
    expect(JSON.stringify(r)).not.toContain(key);
    expect(r.command).toContain("--remote");
    expect(r.command).toContain(`'${r.hash}', 'cloudbox', 1700000000000`);
  });

  it("never overwrites an existing file", () => {
    const out = join(dir, "k");
    writeFileSync(out, "existing");
    expect(() => script.mint("cloudbox", out)).toThrow();
    expect(readFileSync(out, "utf8")).toBe("existing");
  });

  it("refuses to write inside a git work tree", () => {
    execFileSync("git", ["init", "-q", dir]);
    expect(() => script.mint("cloudbox", join(dir, "k"))).toThrow(/git work tree/);
  });

  it("refuses a machine id that could break the printed SQL", () => {
    expect(() => script.mint("cloud'box", join(dir, "k"))).toThrow(/machine id/);
    expect(() => script.mint("-x", join(dir, "k"))).toThrow(/machine id/);
  });

  it("hashes a key file, and refuses a file that is not a key", () => {
    const out = join(dir, "k");
    script.mint("devbox", out);
    expect(script.hashFile(out)).toBe(script.sha256Hex(readFileSync(out, "utf8").trim()));
    writeFileSync(join(dir, "bad"), "hello");
    expect(() => script.hashFile(join(dir, "bad"))).toThrow(/not a pigeon machine key/);
  });

  it("the CLI prints the hash but not the key", () => {
    const out = join(dir, "k");
    const stdout = execFileSync(
      process.execPath,
      [join(__dirname, "../../worker/scripts/machine-key.mjs"), "mint", "macbook", "--out", out],
    ).toString();
    const key = readFileSync(out, "utf8").trim();
    expect(stdout).not.toContain(key);
    expect(stdout).toContain(script.sha256Hex(key));
  });
});
