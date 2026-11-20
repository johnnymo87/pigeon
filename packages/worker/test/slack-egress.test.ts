/**
 * Egress guard for Slack (bead pigeon-4ogz.3): like `src/telegram.ts` for Telegram, `src/slack.ts`
 * is the only file that knows Slack's host. A new direct call belongs in that client, so it is
 * timed, logged and error-mapped like the rest. Sibling of egress-guard.test.ts.
 */
import { describe, test, expect } from "vitest";

const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

describe("slack egress guard", () => {
  test("the glob actually sees the client (a rotted pattern must not pass vacuously)", () => {
    expect(Object.keys(sources)).toContain("../src/slack.ts");
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });

  test("slack.com appears only in src/slack.ts", () => {
    const offenders = Object.entries(sources)
      .filter(([path, text]) => path !== "../src/slack.ts" && text.includes("slack.com"))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  test("src/slack.ts really does hold the host", () => {
    expect(sources["../src/slack.ts"]).toContain("https://slack.com/api/");
  });
});
