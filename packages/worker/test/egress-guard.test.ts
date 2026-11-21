/**
 * Egress guard (chat-transport phase 1, bead pigeon-lenr.1): the worker reaches Telegram from
 * exactly one file, `src/telegram.ts`. That is the seam a future provider swap replaces, and
 * it only stays a seam if nothing grows a second door. A new direct call belongs in the client,
 * as a method, so it is timed and bounded like the rest.
 */
import { describe, test, expect } from "vitest";

const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

describe("telegram egress guard", () => {
  test("the glob actually sees the sources (a rotted pattern must not pass vacuously)", () => {
    expect(Object.keys(sources)).toContain("../src/telegram.ts");
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });

  test("api.telegram.org appears only in src/telegram.ts", () => {
    const offenders = Object.entries(sources)
      .filter(([path, text]) => path !== "../src/telegram.ts" && text.includes("api.telegram.org"))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
