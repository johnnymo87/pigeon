import { describe, expect, it, vi } from "vitest";
import { isQuietTitle } from "../src/quiet-title";

describe("isQuietTitle unit tests", () => {
  it("returns false for null, undefined, or empty string", () => {
    expect(isQuietTitle(null)).toBe(false);
    expect(isQuietTitle(undefined)).toBe(false);
    expect(isQuietTitle("")).toBe(false);
  });

  it("defaults to a production-tuned automation-title match", () => {
    // Caught: with and without the leading dot, and the prose variants.
    expect(isQuietTitle("Task .lgtm-prompt.md", {})).toBe(true);
    expect(isQuietTitle("Task .LGTM-prompt.md", {})).toBe(true);
    expect(isQuietTitle("Review PR with lgtm-review-prompt", {})).toBe(true);
    expect(isQuietTitle("Enrich context per .lgtm-gather-prompt.md", {})).toBe(true);
    expect(isQuietTitle("Review PR using LGTM prompt", {})).toBe(true);
    // NOT caught: real work ON the lgtm tool must still be delivered, because a
    // false positive silently hides real work.
    expect(isQuietTitle("Fix lgtm dispatcher timeout", {})).toBe(false);
    expect(isQuietTitle("Fix lgtm-run timer flake", {})).toBe(false);
    expect(isQuietTitle("LGTM auto-reviews on reviewer add", {})).toBe(false);
    expect(isQuietTitle("Feature work", {})).toBe(false);
  });

  it("uses custom regex pattern when PIGEON_QUIET_TITLE_PATTERN is set", () => {
    const env = { PIGEON_QUIET_TITLE_PATTERN: "quiet|silent" };
    expect(isQuietTitle("This is quiet", env)).toBe(true);
    expect(isQuietTitle("Silent runner", env)).toBe(true);
    expect(isQuietTitle("LGTM runner", env)).toBe(false);
  });

  it("falls back to the default pattern when PIGEON_QUIET_TITLE_PATTERN is invalid regex", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { PIGEON_QUIET_TITLE_PATTERN: "(unclosed" };

    expect(isQuietTitle("Task .lgtm-review-prompt.md", env)).toBe(true);
    expect(isQuietTitle("Normal runner", env)).toBe(false);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
