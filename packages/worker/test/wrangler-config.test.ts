import { describe, test, expect } from "vitest";
import wranglerToml from "../wrangler.toml?raw";

describe("wrangler.toml observability configuration", () => {
  test("observability block is present and enabled", () => {
    const sectionHeaderRegex = /^\s*\[observability\]\s*$/m;
    expect(wranglerToml).toMatch(sectionHeaderRegex);

    const match = sectionHeaderRegex.exec(wranglerToml);
    expect(match).not.toBeNull();

    const afterHeader = wranglerToml.slice(match!.index + match![0].length);
    const nextSectionMatch = /^\s*\[/m.exec(afterHeader);
    const blockContent = nextSectionMatch ? afterHeader.slice(0, nextSectionMatch.index) : afterHeader;

    expect(blockContent).toMatch(/^\s*enabled\s*=\s*true\b/m);
  });

  test("Telegram's vars are gone from [vars] (the deployed ones were removed by pigeon-4ogz.26)", () => {
    const code = wranglerToml
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    for (const name of [
      "ALLOWED_CHAT_IDS",
      "TELEGRAM_TOPICS_ENABLED",
      "TELEGRAM_RICH_MESSAGES",
      "TELEGRAM_BOT_TOKEN",
    ]) {
      expect(code).not.toContain(name);
    }
    // keep_vars must stay on: `wrangler deploy` with it off also drops the secrets.
    expect(code).toMatch(/^keep_vars\s*=\s*true\b/m);
  });
});
