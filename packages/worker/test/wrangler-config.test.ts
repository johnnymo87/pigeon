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
});
