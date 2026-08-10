import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { directoryMissing } from "../src/swarm/directory-check";

describe("directoryMissing (pigeon-0ay7 preflight predicate)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pigeon-dircheck-"));
  });

  afterEach(() => {
    // Restore any mode we stripped so cleanup can recurse.
    try {
      chmodSync(join(root, "locked"), 0o700);
    } catch {
      /* not every test creates it */
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("returns false for a directory that exists", () => {
    expect(directoryMissing(root)).toBe(false);
  });

  it("returns true for a path that does not exist (ENOENT)", () => {
    expect(directoryMissing(join(root, "nope"))).toBe(true);
  });

  it("returns true when the path exists but is a FILE, not a directory", () => {
    // A plain file passes existsSync but the serve cannot chdir into it. This is
    // exactly why the predicate is statSync().isDirectory() and not existsSync.
    const f = join(root, "afile");
    writeFileSync(f, "x");
    expect(directoryMissing(f)).toBe(true);
  });

  it("returns true for a dangling symlink (stat follows, so ENOENT)", () => {
    const link = join(root, "dangling");
    symlinkSync(join(root, "does-not-exist"), link);
    expect(directoryMissing(link)).toBe(true);
  });

  it("returns false for a symlink pointing at a real directory", () => {
    const target = join(root, "real");
    mkdirSync(target);
    const link = join(root, "link");
    symlinkSync(target, link);
    expect(directoryMissing(link)).toBe(false);
  });

  it("FAILS OPEN (returns false) when stat fails for a reason other than ENOENT/ENOTDIR", () => {
    // EACCES is the motivating case: a permissions problem is NOT evidence that
    // the directory is gone, and treating it as "missing" would block a delivery
    // that would have succeeded. Unknown must not collapse into missing.
    const locked = join(root, "locked");
    mkdirSync(locked);
    const child = join(locked, "child");
    mkdirSync(child);
    chmodSync(locked, 0o000);

    let sawEacces = false;
    try {
      require("node:fs").statSync(child);
    } catch (e: any) {
      sawEacces = e?.code === "EACCES";
    }
    // Guard: if we are root (or the fs ignores the mode) the premise does not
    // hold and this assertion would be vacuous. Skip rather than pass falsely.
    if (!sawEacces) {
      chmodSync(locked, 0o700);
      return;
    }

    expect(directoryMissing(child)).toBe(false);
    chmodSync(locked, 0o700);
  });
});
