import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * chat-transport phase 1 (pigeon-lenr): the worker is the only normal caller of the Telegram
 * Bot API. The daemon keeps exactly one narrow out-of-band alarm module for the alerts that
 * must get out while the worker is broken. Anything else that wants to talk to Telegram goes
 * through the worker (`WorkerMessageClient`), so that replacing Telegram means rewriting the
 * worker's client plus that one file.
 */
const ALLOWED = new Set(["direct-telegram-alarm.ts"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("Telegram egress guard", () => {
  it("api.telegram.org appears in no daemon src file but direct-telegram-alarm.ts", () => {
    const src = join(__dirname, "..", "src");
    const offenders = walk(src)
      .filter((p) => /\.[cm]?[jt]s$/.test(p))
      .filter((p) => readFileSync(p, "utf8").includes("api.telegram.org"))
      .map((p) => relative(src, p))
      .filter((p) => !ALLOWED.has(p));
    expect(offenders).toEqual([]);
  });

  it("the allowed file still exists (the guard is not vacuous)", () => {
    const src = join(__dirname, "..", "src");
    expect(readFileSync(join(src, "direct-telegram-alarm.ts"), "utf8")).toContain("api.telegram.org");
  });
});
